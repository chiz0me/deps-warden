import { describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { audit } from '../src/commands/audit.js';
import { initPolicy, validatePolicyFile } from '../src/commands/policy.js';
import { parsePolicy } from '../src/lib/policy.js';

const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);

async function copyFixture(name) {
  const dst = await mkdtemp(join(tmpdir(), `dw-policy-${name}-`));
  await cp(FIX(name), dst, { recursive: true });
  return dst;
}

describe('versioned policy', () => {
  it('parses and fills defaults for a version 1 policy', () => {
    const policy = parsePolicy('version: 1\nscan:\n  failLevel: high\n');
    expect(policy.version).toBe(1);
    expect(policy.scan.reportLevel).toBe('low');
    expect(policy.scan.failLevel).toBe('high');
    expect(policy.network.mode).toBe('off');
  });

  it('rejects unknown keys and unknown rule ids', () => {
    expect(() => parsePolicy('version: 1\nscna: {}\n')).toThrow(/unknown key/);
    expect(() => parsePolicy('version: 1\nscan:\n  rules: [not-a-rule]\n')).toThrow(/unknown rule/);
  });

  it('rejects a report threshold that hides gating findings', () => {
    expect(() => parsePolicy([
      'version: 1',
      'scan:',
      '  reportLevel: critical',
      '  failLevel: high',
      '',
    ].join('\n'))).toThrow(/every gating finding is visible/);
  });

  it('applies policy report/fail levels during audit', async () => {
    const dir = await copyFixture('pnpm-bad');
    await writeFile(join(dir, '.deps-warden.yml'), [
      'version: 1',
      'scan:',
      '  reportLevel: high',
      '  failLevel: critical',
      'network:',
      '  mode: off',
      '',
    ].join('\n'), 'utf8');

    const result = await audit({ cwd: dir });
    expect(result.policy.path).toBe(join(dir, '.deps-warden.yml'));
    expect(result.levels).toEqual({ report: 'high', fail: 'critical' });
    expect(result.findings.every(finding => ['high', 'critical'].includes(finding.severity))).toBe(true);
    expect(result.status).toBe('OK');
  });

  it('initializes in dry-run mode, writes only when authorized, and validates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dw-policy-init-'));
    const path = join(dir, '.deps-warden.yml');
    const preview = await initPolicy({ cwd: dir });
    expect(preview.status).toBe('OK');
    expect(preview.written).toBe(false);
    await expect(readFile(path, 'utf8')).rejects.toThrow();

    const applied = await initPolicy({ cwd: dir, dryRun: false });
    expect(applied.written).toBe(true);
    const validation = await validatePolicyFile({ cwd: dir });
    expect(validation.status).toBe('OK');
    expect(validation.version).toBe(1);
  });

  it('extends built-in trusted registries instead of replacing them', async () => {
    const dir = await copyFixture('npm');
    const npmrcPath = join(dir, '.npmrc');
    const npmrc = await readFile(npmrcPath, 'utf8');
    await writeFile(npmrcPath, `${npmrc}registry=https://registry.npmjs.org/\n`, 'utf8');
    const result = await audit({ cwd: dir, trustedRegistries: ['registry.internal.example'] });
    expect(result.findings.map(finding => finding.ruleId)).not.toContain('trusted-registry');
  });
});
