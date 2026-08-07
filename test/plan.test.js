import { describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { audit } from '../src/commands/audit.js';
import { applyPlan, createPlan, PLAN_KIND } from '../src/commands/plan.js';

const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);

async function copyFixture(name) {
  const dst = await mkdtemp(join(tmpdir(), `dw-plan-${name}-`));
  await cp(FIX(name), dst, { recursive: true });
  return dst;
}

async function planFor(dir, ruleId) {
  const scan = await audit({ cwd: dir });
  const finding = scan.findings.find(item => item.ruleId === ruleId);
  expect(finding).toBeDefined();
  return createPlan({ cwd: dir, finding: finding.id });
}

describe('remediation plans', () => {
  it('creates a deterministic, relative, content-free plan', async () => {
    const dir = await copyFixture('pnpm-bad');
    const first = await planFor(dir, 'pnpm-strict-dep-builds');
    const second = await planFor(dir, 'pnpm-strict-dep-builds');

    expect(first).toEqual(second);
    expect(first.kind).toBe(PLAN_KIND);
    expect(first.status).toBe('OK');
    expect(first.changes).toHaveLength(1);
    expect(first.changes[0].file).toBe('pnpm-workspace.yaml');
    expect(first.changes[0].beforeExists).toBe(false);
    expect(first.changes[0].beforeSha256).toBeNull();
    expect(first.changes[0].afterSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain(dir);
    expect(first.changes[0]).not.toHaveProperty('content');
  });

  it('validates without writing by default, then applies with explicit write', async () => {
    const dir = await copyFixture('pnpm-bad');
    const path = join(dir, 'pnpm-workspace.yaml');
    const plan = await planFor(dir, 'pnpm-strict-dep-builds');
    const before = await readFile(path, 'utf8').catch(() => '');

    const preview = await applyPlan({ cwd: dir, plan });
    expect(preview.status).toBe('OK');
    await expect(readFile(path, 'utf8').catch(() => '')).resolves.toBe(before);

    const applied = await applyPlan({ cwd: dir, plan, write: true });
    expect(applied.status).toBe('OK');
    expect(applied.fix.proposals[0].written).toBe(true);
    const rescanned = await audit({ cwd: dir });
    expect(rescanned.findings.map(finding => finding.ruleId)).not.toContain('pnpm-strict-dep-builds');
  });

  it('rejects a stale plan before writing', async () => {
    const dir = await copyFixture('pnpm-bad');
    const path = join(dir, 'pnpm-workspace.yaml');
    const plan = await planFor(dir, 'pnpm-strict-dep-builds');
    await writeFile(path, '# changed after approval\n', 'utf8');

    const result = await applyPlan({ cwd: dir, plan, write: true });
    expect(result.status).toBe('FAIL');
    expect(result.error).toMatch(/plan conflict|not found/);
    await expect(readFile(path, 'utf8')).resolves.toBe('# changed after approval\n');
  });

  it('rejects unsafe paths in a tampered plan', async () => {
    const dir = await copyFixture('pnpm-bad');
    const plan = await planFor(dir, 'pnpm-strict-dep-builds');
    plan.changes[0].file = '../outside';
    const result = await applyPlan({ cwd: dir, plan, write: true });
    expect(result.status).toBe('FAIL');
    expect(result.error).toMatch(/unsafe file path/);
  });

  it('binds the plan to the reviewed finding rule', async () => {
    const dir = await copyFixture('pnpm-bad');
    const plan = await planFor(dir, 'pnpm-strict-dep-builds');
    plan.finding.ruleId = 'pnpm-allow-builds';
    const result = await applyPlan({ cwd: dir, plan, write: true });
    expect(result.status).toBe('FAIL');
    expect(result.error).toMatch(/finding rule changed/);
  });

  it('does not expose existing npm credentials in plan diffs', async () => {
    const dir = await copyFixture('npm-loose');
    const token = 'npm_abcdefghijklmnopqrstuvwxyz1234567890';
    await writeFile(join(dir, '.npmrc'), `//registry.npmjs.org/:_authToken=${token}\n`, 'utf8');
    const plan = await planFor(dir, 'npm-ignore-scripts');
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain(token);
    expect(serialized).toContain('<redacted>');
  });
});
