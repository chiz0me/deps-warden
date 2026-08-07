import { describe, it, expect } from 'vitest';
import { mkdtemp, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { init } from '../src/commands/init.js';
import { audit } from '../src/commands/audit.js';

const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);

async function copyFixture(name) {
  const dst = await mkdtemp(join(tmpdir(), `dw-init-${name}-`));
  await cp(FIX(name), dst, { recursive: true });
  return dst;
}

describe('init', () => {
  it('rejects unknown profile', async () => {
    const r = await init({ cwd: FIX('pnpm-bad'), profile: 'banana' });
    expect(r.status).toBe('FAIL');
    expect(r.error).toMatch(/profile/);
  });

  it('dry-runs by default and proposes pnpm-workspace.yaml edits', async () => {
    const r = await init({ cwd: FIX('pnpm-bad'), profile: 'strict' });
    expect(r.status).toBe('OK');
    expect(r.proposals.length).toBeGreaterThan(0);
    for (const p of r.proposals) expect(p.written).toBe(false);
  });

  it('writes when dryRun=false and silences pnpm rules afterwards', async () => {
    const dir = await copyFixture('pnpm-bad');
    const r = await init({ cwd: dir, profile: 'strict', dryRun: false });
    expect(r.status).toBe('OK');
    expect(r.proposals.some(p => p.written)).toBe(true);
    const wsContent = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8');
    expect(wsContent).toMatch(/allowBuilds/);
    expect(wsContent).toMatch(/strictDepBuilds/);
    expect(wsContent).toMatch(/minimumReleaseAge/);

    const a = await audit({ cwd: dir });
    const ids = a.findings.map(f => f.ruleId);
    expect(ids).not.toContain('pnpm-allow-builds');
    expect(ids).not.toContain('pnpm-strict-dep-builds');
    expect(ids).not.toContain('min-release-age');
  });

  it('applies npm profile to .npmrc', async () => {
    const dir = await copyFixture('npm-loose');
    const r = await init({ cwd: dir, profile: 'strict', dryRun: false });
    expect(r.status).toBe('OK');
    const npmrc = await readFile(join(dir, '.npmrc'), 'utf8');
    expect(npmrc).toMatch(/ignore-scripts=true/);
    expect(npmrc).toMatch(/allow-git=none/);
    expect(npmrc).toMatch(/allow-remote=none/);
    expect(npmrc).toMatch(/save-exact=true/);
  });

  it('is idempotent: a second run produces no further proposals', async () => {
    const dir = await copyFixture('pnpm-bad');
    await init({ cwd: dir, profile: 'strict', dryRun: false });
    const r2 = await init({ cwd: dir, profile: 'strict', dryRun: false });
    expect(r2.proposals.length).toBe(0);
  });
});
