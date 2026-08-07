import { describe, it, expect } from 'vitest';
import { mkdtemp, cp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { audit } from '../src/commands/audit.js';
import { fix } from '../src/commands/fix.js';
import { dependencySourceType } from '../src/rules/npm-v12-source-controls.js';

const FIX = name => resolve(import.meta.dirname, 'fixtures', name);

async function copyFixture(name = 'npm-loose') {
  const dst = await mkdtemp(join(tmpdir(), `dw-npm12-${name}-`));
  await cp(FIX(name), dst, { recursive: true });
  return dst;
}

describe('npm v12 dependency source classification', () => {
  it('separates Git and remote URL specs without flagging registry or local specs', () => {
    expect(dependencySourceType('git+https://github.com/acme/pkg.git#abc')).toBe('git');
    expect(dependencySourceType('github:acme/pkg#abc')).toBe('git');
    expect(dependencySourceType('acme/pkg#abc')).toBe('git');
    expect(dependencySourceType('https://example.test/pkg.tgz')).toBe('remote');
    expect(dependencySourceType('^1.2.3')).toBeNull();
    expect(dependencySourceType('file:../pkg')).toBeNull();
  });
});

describe('npm-v12-source-controls rule', () => {
  it('flags unset Git and remote controls and can safely deny one source type', async () => {
    const dir = await copyFixture();
    const result = await audit({ cwd: dir });
    const findings = result.findings.filter(f => f.ruleId === 'npm-v12-source-controls');
    expect(findings.map(f => f.fields.control).toSorted()).toEqual(['allow-git', 'allow-remote']);

    const target = findings.find(f => f.fields.control === 'allow-git');
    const applied = await fix({ cwd: dir, finding: target.id, dryRun: false });
    expect(applied.status).toBe('OK');
    expect(await readFile(join(dir, '.npmrc'), 'utf8')).toMatch(/allow-git=none/);
  });

  it('reports direct source dependencies and accepts reviewed root-only scope', async () => {
    const dir = await copyFixture();
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'source-fixture',
      version: '1.0.0',
      dependencies: {
        gitdep: 'git+https://github.com/acme/pkg.git#abc123',
        remotedep: 'https://example.test/pkg.tgz',
      },
    }, null, 2));
    await writeFile(join(dir, '.npmrc'), 'allow-git=root\nallow-remote=root\n');
    const result = await audit({ cwd: dir });
    expect(result.findings.some(f => f.ruleId === 'npm-v12-source-controls')).toBe(false);
  });

  it('accepts npm v12 secure defaults when v12 is committed as the project toolchain', async () => {
    const dir = await copyFixture();
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'npm-v12-fixture',
      version: '1.0.0',
      packageManager: 'npm@12.0.2',
    }, null, 2));
    const result = await audit({ cwd: dir });
    expect(result.findings.some(f => f.ruleId === 'npm-v12-source-controls')).toBe(false);
  });
});

describe('npm-dangerous-script-bypass rule', () => {
  it('flags and disables the policy-wide script escape hatch', async () => {
    const dir = await copyFixture();
    await writeFile(join(dir, '.npmrc'), 'dangerously-allow-all-scripts=true\n');
    const result = await audit({ cwd: dir });
    const finding = result.findings.find(f => f.ruleId === 'npm-dangerous-script-bypass');
    expect(finding?.severity).toBe('critical');

    const applied = await fix({ cwd: dir, finding: finding.id, dryRun: false });
    expect(applied.status).toBe('OK');
    expect(await readFile(join(dir, '.npmrc'), 'utf8')).toMatch(/dangerously-allow-all-scripts=false/);
  });
});
