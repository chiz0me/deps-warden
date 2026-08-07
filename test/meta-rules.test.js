import { describe, it, expect } from 'vitest';
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { audit } from '../src/commands/audit.js';
import { fix } from '../src/commands/fix.js';

const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);

async function copyFixture(name) {
  const dst = await mkdtemp(join(tmpdir(), `dw-meta-${name}-`));
  await cp(FIX(name), dst, { recursive: true });
  return dst;
}

describe('direct-deps-with-scripts', () => {
  it('reports a finding when installed deps have lifecycle scripts', async () => {
    const r = await audit({ cwd: FIX('pnpm-with-scripts') });
    const f = r.findings.find(x => x.ruleId === 'direct-deps-with-scripts');
    expect(f).toBeDefined();
    expect(f.fields.count).toBe(2);
    expect(f.fields.packages).toContain('esbuild');
    expect(f.fields.packages).toContain('sharp');
  });

  it('does not fire when no direct deps have scripts', async () => {
    const r = await audit({ cwd: FIX('npm') });
    const ids = r.findings.map(x => x.ruleId);
    expect(ids).not.toContain('direct-deps-with-scripts');
  });
});

describe('unused-allowlist-entries', () => {
  it('flags lodash as dormant (allowlisted but has no scripts)', async () => {
    const r = await audit({ cwd: FIX('pnpm-with-scripts') });
    const f = r.findings.find(x => x.ruleId === 'unused-allowlist-entries');
    expect(f).toBeDefined();
    expect(f.fields.dormant).toContain('lodash');
  });

  it('fix removes dormant entries from the allowlist', async () => {
    const dir = await copyFixture('pnpm-with-scripts');
    const a = await audit({ cwd: dir });
    const target = a.findings.find(x => x.ruleId === 'unused-allowlist-entries');
    expect(target).toBeDefined();
    const r = await fix({ cwd: dir, finding: target.id, dryRun: false });
    expect(r.status).toBe('OK');
    const ws = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8');
    expect(ws).not.toMatch(/^\s*lodash:\s*true\b/m);
    expect(ws).toMatch(/esbuild/);
  });

  it('does not fire when allowlist is empty', async () => {
    const r = await audit({ cwd: FIX('pnpm') });
    const ids = r.findings.map(x => x.ruleId);
    expect(ids).not.toContain('unused-allowlist-entries');
  });
});

describe('pnpm-dangerous-build-bypass', () => {
  it('flags and safely disables dangerouslyAllowAllBuilds', async () => {
    const dir = await copyFixture('pnpm');
    const file = join(dir, 'pnpm-workspace.yaml');
    const before = await readFile(file, 'utf8');
    await writeFile(file, before.replace('dangerouslyAllowAllBuilds: false', 'dangerouslyAllowAllBuilds: true'));

    const a = await audit({ cwd: dir });
    const target = a.findings.find(x => x.ruleId === 'pnpm-dangerous-build-bypass');
    expect(target).toBeDefined();
    expect(target.severity).toBe('critical');

    const result = await fix({ cwd: dir, finding: target.id, dryRun: false });
    expect(result.status).toBe('OK');
    await expect(readFile(file, 'utf8')).resolves.toMatch(/dangerouslyAllowAllBuilds:\s*false/);
  });
});

describe('pnpm release-age and resolution integrity', () => {
  it('requires fail-closed release-time metadata handling', async () => {
    const dir = await copyFixture('pnpm');
    const file = join(dir, 'pnpm-workspace.yaml');
    const before = await readFile(file, 'utf8');
    await writeFile(file, before
      .replace('minimumReleaseAgeStrict: true', 'minimumReleaseAgeStrict: false')
      .replace('minimumReleaseAgeIgnoreMissingTime: false', 'minimumReleaseAgeIgnoreMissingTime: true'));

    const result = await audit({ cwd: dir });
    const findings = result.findings.filter(x => x.ruleId === 'pnpm-release-age-strict');
    expect(findings.map(x => x.fields.control).toSorted()).toEqual([
      'minimumReleaseAgeIgnoreMissingTime',
      'minimumReleaseAgeStrict',
    ]);
  });

  it('flags lockfile trust and exotic transitive-source bypasses', async () => {
    const dir = await copyFixture('pnpm');
    const file = join(dir, 'pnpm-workspace.yaml');
    await writeFile(file, `${await readFile(file, 'utf8')}trustLockfile: true\nblockExoticSubdeps: false\n`);

    const result = await audit({ cwd: dir });
    const findings = result.findings.filter(x => x.ruleId === 'pnpm-resolution-integrity');
    expect(findings.map(x => x.fields.control).toSorted()).toEqual([
      'blockExoticSubdeps',
      'trustLockfile',
    ]);
  });
});

describe('pnpmfile-execution', () => {
  it('treats a pnpm hook file as privileged executable configuration', async () => {
    const dir = await copyFixture('pnpm');
    await writeFile(join(dir, '.pnpmfile.mjs'), 'export const hooks = {};\n');
    const result = await audit({ cwd: dir });
    expect(result.findings.find(x => x.ruleId === 'pnpmfile-execution')).toBeDefined();
  });

  it('accepts the hook only when pnpm is configured to ignore it', async () => {
    const dir = await copyFixture('pnpm');
    await writeFile(join(dir, '.pnpmfile.mjs'), 'export const hooks = {};\n');
    await writeFile(join(dir, 'pnpm-workspace.yaml'),
      `${await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')}ignorePnpmfile: true\n`);
    const result = await audit({ cwd: dir });
    expect(result.findings.some(x => x.ruleId === 'pnpmfile-execution')).toBe(false);
  });
});

describe('recommend-stricter-pm', () => {
  it('fires for npm projects', async () => {
    const r = await audit({ cwd: FIX('npm-loose') });
    const ids = r.findings.map(x => x.ruleId);
    expect(ids).toContain('recommend-stricter-pm');
  });

  it('does not fire for pnpm projects', async () => {
    const r = await audit({ cwd: FIX('pnpm') });
    const ids = r.findings.map(x => x.ruleId);
    expect(ids).not.toContain('recommend-stricter-pm');
  });

  it('has no fix (informational only)', async () => {
    const r = await audit({ cwd: FIX('npm-loose') });
    const target = r.findings.find(x => x.ruleId === 'recommend-stricter-pm');
    const fr = await fix({ cwd: FIX('npm-loose'), finding: target.id });
    expect(fr.status).toBe('FAIL');
    expect(fr.error).toMatch(/no fix available/);
  });
});
