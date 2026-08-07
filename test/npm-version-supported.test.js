import { describe, it, expect } from 'vitest';
import { mkdtemp, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { audit } from '../src/commands/audit.js';
import { fix } from '../src/commands/fix.js';
import { userAgentNpmVersion } from '../src/rules/npm-version-supported.js';

const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);
const UA = (v) => `npm/${v} node/v20.20.1 linux x64 workspaces/false`;

async function copyFixture(name) {
  const dst = await mkdtemp(join(tmpdir(), `dw-npmver-${name}-`));
  await cp(FIX(name), dst, { recursive: true });
  return dst;
}

describe('userAgentNpmVersion', () => {
  it('parses the npm version out of a user-agent string', () => {
    expect(userAgentNpmVersion(UA('11.16.0'))).toBe('11.16.0');
    expect(userAgentNpmVersion(UA('10.9.2'))).toBe('10.9.2');
  });
  it('returns null for missing or non-matching agents', () => {
    expect(userAgentNpmVersion(undefined)).toBeNull();
    expect(userAgentNpmVersion('yarn/1.22.0 node/v20')).toBeNull();
  });
});

describe('npm-version-supported rule', () => {
  it('fires when a corepack packageManager pin is below 11.16.0', async () => {
    const r = await audit({ cwd: FIX('npm-old-npm') });
    const f = r.findings.find(x => x.ruleId === 'npm-version-supported');
    expect(f).toBeTruthy();
    expect(f.fields.detected).toBe('10.5.0');
    expect(f.fields.via).toBe('packageManager');
    expect(f.fields.required).toBe('>=11.16.0');
  });

  it('fires via the npm user-agent when no pin is present', async () => {
    const r = await audit({ cwd: FIX('npm'), npmUserAgent: UA('10.0.0') });
    const f = r.findings.find(x => x.ruleId === 'npm-version-supported');
    expect(f).toBeTruthy();
    expect(f.fields.via).toBe('user-agent');
    expect(f.fields.detected).toBe('10.0.0');
  });

  it('reports only controls that the detected npm still lacks', async () => {
    const r = await audit({ cwd: FIX('npm'), npmUserAgent: UA('11.12.0') });
    const f = r.findings.find(x => x.ruleId === 'npm-version-supported');
    expect(f.fields.affects).toBe('allow-remote,allowScripts');
  });

  it('reports npm 11.16 as a transitional migration version', async () => {
    const r = await audit({ cwd: FIX('npm'), npmUserAgent: UA('11.16.0') });
    const finding = r.findings.find(x => x.ruleId === 'npm-version-supported');
    expect(finding.fields.state).toBe('transitional');
    expect(finding.severity).toBe('medium');
  });

  it('fails closed when the version is undeterminable', async () => {
    const r = await audit({ cwd: FIX('npm'), npmUserAgent: '' });
    const finding = r.findings.find(x => x.ruleId === 'npm-version-supported');
    expect(finding.fields.detected).toBe('unknown');
    expect(finding.severity).toBe('high');
  });

  it('does not fire for npm 12', async () => {
    const r = await audit({ cwd: FIX('npm'), npmUserAgent: UA('12.0.2') });
    expect(r.findings.some(x => x.ruleId === 'npm-version-supported')).toBe(false);
  });

  it('fix records engines.npm and enforces devEngines.packageManager', async () => {
    const dir = await copyFixture('npm-old-npm');
    const a = await audit({ cwd: dir });
    const target = a.findings.find(x => x.ruleId === 'npm-version-supported');
    const r = await fix({ cwd: dir, finding: target.id, dryRun: false });
    expect(r.status).toBe('OK');
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(pkg.engines.npm).toBe('>=11.16.0');
    expect(pkg.engines.node).toBe('>=20'); // preserves existing engines
    expect(pkg.devEngines.packageManager).toEqual({
      name: 'npm',
      version: '>=11.16.0',
      onFail: 'error',
    });
  });

  it('does not apply to non-npm projects', async () => {
    const r = await audit({ cwd: FIX('pnpm') });
    expect(r.skipped.find(s => s.rule === 'npm-version-supported')?.reason).toBe('pm-not-npm');
  });
});
