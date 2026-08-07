import { describe, it, expect } from 'vitest';
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { audit } from '../src/commands/audit.js';
import { splitSpec, isCovered, readAllowScripts } from '../src/rules/npm-allow-scripts.js';
import { parseLockfileInstallScripts } from '../src/lib/lockfileScripts.js';

const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);

async function copyFixture(name) {
  const dst = await mkdtemp(join(tmpdir(), `dw-allowscripts-${name}-`));
  await cp(FIX(name), dst, { recursive: true });
  return dst;
}

describe('splitSpec', () => {
  it('treats a bare name as covering all versions', () => {
    expect(splitSpec('canvas')).toEqual({ name: 'canvas', versions: null });
  });
  it('treats name@* as name-only', () => {
    expect(splitSpec('canvas@*')).toEqual({ name: 'canvas', versions: null });
  });
  it('parses an exact pin', () => {
    expect(splitSpec('canvas@1.2.3')).toEqual({ name: 'canvas', versions: ['1.2.3'] });
  });
  it('parses a || disjunction of exact versions', () => {
    expect(splitSpec('canvas@1.2.3 || 1.2.4')).toEqual({ name: 'canvas', versions: ['1.2.3', '1.2.4'] });
  });
  it('handles scoped names with and without a pin', () => {
    expect(splitSpec('@scope/pkg')).toEqual({ name: '@scope/pkg', versions: null });
    expect(splitSpec('@scope/pkg@2.0.0')).toEqual({ name: '@scope/pkg', versions: ['2.0.0'] });
  });
});

describe('isCovered', () => {
  const policy = { alpha: true, 'gamma@3.0.0': false, '@scope/pkg@1.0.0': true };
  it('covers any version of a name-only entry (allow or deny)', () => {
    expect(isCovered(policy, 'alpha', '9.9.9')).toBe(true);
  });
  it('covers an exact-pin match but not a version mismatch', () => {
    expect(isCovered(policy, 'gamma', '3.0.0')).toBe(true);
    expect(isCovered(policy, 'gamma', '3.0.1')).toBe(false);
  });
  it('matches scoped pins', () => {
    expect(isCovered(policy, '@scope/pkg', '1.0.0')).toBe(true);
  });
  it('returns false for unlisted packages and a null policy', () => {
    expect(isCovered(policy, 'beta', '2.0.0')).toBe(false);
    expect(isCovered(null, 'alpha', '1.0.0')).toBe(false);
  });
});

describe('readAllowScripts', () => {
  it('returns the object or null for non-objects', () => {
    expect(readAllowScripts({ allowScripts: { a: true } })).toEqual({ a: true });
    expect(readAllowScripts({ allowScripts: ['a'] })).toBeNull();
    expect(readAllowScripts({})).toBeNull();
  });

  it('excludes non-boolean decisions from the effective policy', () => {
    expect(readAllowScripts({ allowScripts: { reviewed: true, ambiguous: 'yes' } }))
      .toEqual({ reviewed: true });
  });
});

describe('parseLockfileInstallScripts', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'root', version: '1.0.0' },
      'node_modules/alpha': { version: '1.0.0', hasInstallScript: true },
      'node_modules/quiet': { version: '1.0.0' },
      'node_modules/@scope/bar': { version: '2.0.0', hasInstallScript: true },
      'node_modules/beta/node_modules/delta': { version: '4.0.0', hasInstallScript: true },
      'node_modules/pkgs/app': { link: true, resolved: 'pkgs/app' },
    },
  });

  it('returns only hasInstallScript entries, skipping root, links, and quiet deps', () => {
    const out = parseLockfileInstallScripts(lock);
    const names = out.map(p => p.name).toSorted();
    expect(names).toEqual(['@scope/bar', 'alpha', 'delta']);
  });

  it('derives scoped names from the path and flags transitive entries', () => {
    const out = parseLockfileInstallScripts(lock);
    expect(out.find(p => p.name === '@scope/bar').transitive).toBe(false);
    expect(out.find(p => p.name === 'delta')).toMatchObject({ version: '4.0.0', transitive: true });
  });

  it('returns null for a lockfile with no packages map (v1) or invalid JSON', () => {
    expect(parseLockfileInstallScripts(JSON.stringify({ lockfileVersion: 1, dependencies: {} }))).toBeNull();
    expect(parseLockfileInstallScripts('not json')).toBeNull();
  });
});

describe('npm-allow-scripts rule', () => {
  it('reports malformed allowScripts decisions instead of treating them as reviewed', async () => {
    const dir = await copyFixture('npm-allow-scripts');
    const file = join(dir, 'package.json');
    const pkg = JSON.parse(await readFile(file, 'utf8'));
    pkg.allowScripts.beta = 'yes';
    await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
    const result = await audit({ cwd: dir });
    const invalid = result.findings.find(x => x.ruleId === 'npm-allow-scripts'
      && x.fields.enforcement === 'invalid-policy');
    expect(invalid).toBeDefined();
    expect(invalid.severity).toBe('high');
  });
  it('flags uncovered install-script packages across the whole tree from the lockfile', async () => {
    const r = await audit({ cwd: FIX('npm-allow-scripts') });
    const f = r.findings.find(x => x.ruleId === 'npm-allow-scripts');
    expect(f).toBeTruthy();
    expect(f.fields.source).toBe('lockfile');
    // alpha (name-only) and gamma@3.0.0 (pin) are covered; beta + transitive delta are not.
    expect(f.fields.packages.split(',').toSorted()).toEqual(['beta@2.0.0', 'delta@4.0.0']);
    expect(f.fields.count).toBe(2);
    expect(f.fields.transitive).toBe(1);
  });

  it('falls back to installed direct deps when the lockfile has no packages map', async () => {
    const dir = await copyFixture('npm-allow-scripts');
    await writeFile(join(dir, 'package-lock.json'),
      JSON.stringify({ name: 'x', version: '1.0.0', lockfileVersion: 1, dependencies: {} }), 'utf8');
    const r = await audit({ cwd: dir });
    const f = r.findings.find(x => x.ruleId === 'npm-allow-scripts');
    expect(f.fields.source).toBe('node_modules');
    // Direct-only: beta is flagged, the transitive delta is not visible.
    expect(f.fields.packages).toBe('beta@2.0.0');
  });

  it('is moot when ignore-scripts=true', async () => {
    const dir = await copyFixture('npm-allow-scripts');
    await writeFile(join(dir, '.npmrc'), 'ignore-scripts=true\n', 'utf8');
    const r = await audit({ cwd: dir });
    expect(r.findings.some(x => x.ruleId === 'npm-allow-scripts')).toBe(false);
  });

  it('does not apply to non-npm projects', async () => {
    const r = await audit({ cwd: FIX('pnpm-with-scripts') });
    expect(r.findings.some(x => x.ruleId === 'npm-allow-scripts')).toBe(false);
    expect(r.skipped.find(s => s.rule === 'npm-allow-scripts')?.reason).toBe('pm-not-npm');
  });
});
