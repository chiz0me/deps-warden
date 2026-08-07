import { describe, it, expect, beforeEach } from 'vitest';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { audit, renderAudit } from '../src/commands/audit.js';
import { parseDurationMs } from '../src/rules/dep-below-release-age.js';

const FIX = resolve(import.meta.dirname, 'fixtures', 'npm-versions');
const NOW = 1_700_000_000_000;
const oneHourAgoIso = new Date(NOW - 3600 * 1000).toISOString();

const PACKUMENTS = {
  oldmajor: {
    name: 'oldmajor',
    'dist-tags': { latest: '3.0.0' },
    versions: { '1.2.3': {}, '3.0.0': {} },
    time: { '1.2.3': '2019-01-01T00:00:00.000Z' },
  },
  gonebad: {
    name: 'gonebad',
    'dist-tags': { latest: '2.0.0' },
    versions: { '2.0.0': { deprecated: 'critical advisory: do not use' } },
    time: { '2.0.0': '2019-01-01T00:00:00.000Z' },
  },
  freshpkg: {
    name: 'freshpkg',
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': {} },
    time: { '1.0.0': oneHourAgoIso },
  },
  goodpkg: {
    name: 'goodpkg',
    'dist-tags': { latest: '2.0.1' },
    versions: { '2.0.0': {}, '2.0.1': {} },
    time: { '2.0.0': '2019-01-01T00:00:00.000Z' },
  },
};

function fakeFetch(packuments) {
  return async (url) => {
    const name = decodeURIComponent(String(url).split('/').pop());
    const body = packuments[name];
    if (!body) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
}

function byPackage(findings, ruleId) {
  return findings.filter(f => f.ruleId === ruleId).map(f => f.fields.package);
}

beforeEach(async () => {
  await rm(join(FIX, '.deps-warden-cache'), { recursive: true, force: true });
});

describe('version rules (--check-versions)', () => {
  it('interprets npm bare release age as days and pnpm as minutes', () => {
    expect(parseDurationMs(7, 'npm')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseDurationMs(10080, 'pnpm')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('flags outdated, deprecated, and freshly-published deps', async () => {
    const r = await audit({ cwd: FIX, checkVersions: true, fetchImpl: fakeFetch(PACKUMENTS), now: NOW });

    expect(byPackage(r.findings, 'outdated-major-deps')).toEqual(['oldmajor']);
    expect(byPackage(r.findings, 'deprecated-dep-version')).toEqual(['gonebad']);
    expect(byPackage(r.findings, 'dep-below-release-age')).toEqual(['freshpkg']);

    const outdated = r.findings.find(f => f.ruleId === 'outdated-major-deps');
    expect(outdated.fields.majorsBehind).toBe(2);
    expect(outdated.fields.latest).toBe('3.0.0');
  });

  it('does not flag a current, non-deprecated, well-aged dep', async () => {
    const r = await audit({ cwd: FIX, checkVersions: true, fetchImpl: fakeFetch(PACKUMENTS), now: NOW });
    const allVersionPkgs = [
      ...byPackage(r.findings, 'outdated-major-deps'),
      ...byPackage(r.findings, 'deprecated-dep-version'),
      ...byPackage(r.findings, 'dep-below-release-age'),
    ];
    expect(allVersionPkgs).not.toContain('goodpkg');
  });

  it('records the registry url and emits a REGISTRY record', async () => {
    const r = await audit({ cwd: FIX, checkVersions: true, fetchImpl: fakeFetch(PACKUMENTS), now: NOW });
    expect(r.registry.url).toBe('https://registry.npmjs.org');
    expect(r.registry.errors).toEqual([]);
    const out = renderAudit(r, { format: 'toon', cwd: FIX });
    expect(out).toMatch(/^REGISTRY:/m);
  });
});

describe('version rules are off by default', () => {
  it('skips the version rules without --check-versions', async () => {
    const r = await audit({ cwd: FIX });
    const versionIds = ['outdated-major-deps', 'deprecated-dep-version', 'dep-below-release-age'];
    expect(r.findings.some(f => versionIds.includes(f.ruleId))).toBe(false);
    expect(r.registry).toBeNull();
    for (const id of versionIds) {
      expect(r.skipped.find(s => s.rule === id)?.reason).toBe('check-versions-off');
    }
  });
});

describe('soft-fail on registry errors', () => {
  it('records per-package errors and produces no version findings, without crashing', async () => {
    const failing = async () => { throw new Error('offline'); };
    const r = await audit({ cwd: FIX, checkVersions: true, fetchImpl: failing, now: NOW });

    expect(r.registry.errors.length).toBe(4);
    for (const e of r.registry.errors) expect(e.error).toMatch(/offline/);

    const versionIds = new Set(['outdated-major-deps', 'deprecated-dep-version', 'dep-below-release-age']);
    expect(r.findings.some(f => versionIds.has(f.ruleId))).toBe(false);

    const out = renderAudit(r, { format: 'toon', cwd: FIX });
    expect(out).toMatch(/NOTE: registry=unreachable/);
  });
});

describe('registry trust boundary', () => {
  it('blocks a repository-supplied untrusted registry before fetch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dw-untrusted-registry-'));
    await cp(FIX, dir, { recursive: true });
    await writeFile(join(dir, '.npmrc'), 'registry=http://127.0.0.1:4873/\n', 'utf8');
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      throw new Error('must not be called');
    };

    const result = await audit({ cwd: dir, checkVersions: true, fetchImpl, now: NOW });
    expect(calls).toBe(0);
    expect(result.registry.blocked).toBe(true);
    const finding = result.findings.find(item => item.ruleId === 'trusted-registry');
    expect(finding.fields.reason).toBe('insecure-protocol');
  });
});
