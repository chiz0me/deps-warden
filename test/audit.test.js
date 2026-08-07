import { describe, it, expect } from 'vitest';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { audit, renderAudit } from '../src/commands/audit.js';

const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);

describe('audit', () => {
  it('returns OK for the clean pnpm fixture', async () => {
    const r = await audit({ cwd: FIX('pnpm') });
    expect(r.status).toBe('OK');
    expect(r.findings).toEqual([]);
    expect(r.pm.kind).toBe('pnpm');
  });

  it('returns FAIL with expected rule ids for pnpm-bad', async () => {
    const r = await audit({ cwd: FIX('pnpm-bad') });
    expect(r.status).toBe('FAIL');
    const ids = r.findings.map(f => f.ruleId);
    expect(ids).toContain('pnpm-allow-builds');
    expect(ids).toContain('pnpm-strict-dep-builds');
    expect(ids).toContain('min-release-age');
    expect(ids).toContain('node-engines-pinned');
  });

  it('finding ids are deterministic across runs', async () => {
    const a = await audit({ cwd: FIX('pnpm-bad') });
    const b = await audit({ cwd: FIX('pnpm-bad') });
    expect(a.findings.map(f => f.id)).toEqual(b.findings.map(f => f.id));
  });

  it('finding ids are stable across different checkout paths', async () => {
    const first = await mkdtemp(join(tmpdir(), 'dw-id-a-'));
    const second = await mkdtemp(join(tmpdir(), 'dw-id-b-'));
    await cp(FIX('pnpm-bad'), first, { recursive: true });
    await cp(FIX('pnpm-bad'), second, { recursive: true });

    const a = await audit({ cwd: first });
    const b = await audit({ cwd: second });
    expect(a.findings.map(f => f.id)).toEqual(b.findings.map(f => f.id));
  });

  it('filters by severity', async () => {
    const all = await audit({ cwd: FIX('pnpm-bad') });
    const high = await audit({ cwd: FIX('pnpm-bad'), severity: 'high' });
    expect(high.findings.length).toBeLessThan(all.findings.length);
    for (const f of high.findings) {
      expect(['high', 'critical']).toContain(f.severity);
    }
  });

  it('--explain attaches plain-English remediation', async () => {
    const r = await audit({ cwd: FIX('pnpm-bad'), explain: true });
    expect(r.findings[0].explain).toBeTruthy();
  });

  it('fails mandatory mode when git-backed evidence is unavailable', async () => {
    const r = await audit({ cwd: FIX('pnpm'), requireComplete: true });
    expect(r.status).toBe('FAIL');
    expect(r.incomplete).toEqual(expect.arrayContaining([
      { rule: 'lockfile-committed', reason: 'no-git-index' },
      { rule: 'no-committed-auth', reason: 'no-git-index' },
    ]));
  });
});

describe('renderAudit', () => {
  it('emits TOON records including PM, FINDING, SUMMARY, STATUS', async () => {
    const r = await audit({ cwd: FIX('pnpm-bad') });
    const out = renderAudit(r, { format: 'toon', cwd: FIX('pnpm-bad') });
    expect(out).toMatch(/^PM:/m);
    expect(out).toMatch(/^FINDING:/m);
    expect(out).toMatch(/^SUMMARY:/m);
    expect(out).toMatch(/STATUS: FAIL/);
  });

  it('emits JSON when format=json', async () => {
    const r = await audit({ cwd: FIX('pnpm') });
    const out = renderAudit(r, { format: 'json' });
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe('OK');
    expect(Array.isArray(parsed.findings)).toBe(true);
  });
});
