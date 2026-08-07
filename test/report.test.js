import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { report, renderReport } from '../src/commands/report.js';

const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);

describe('report', () => {
  it('combines audit + scripts and inherits audit status', async () => {
    const r = await report({ cwd: FIX('pnpm-bad') });
    expect(r.status).toBe('FAIL');
    expect(r.audit.findings.length).toBeGreaterThan(0);
    expect(Array.isArray(r.scripts.deps)).toBe(true);
  });

  it('returns OK when both audit and scripts are clean', async () => {
    const r = await report({ cwd: FIX('pnpm') });
    expect(r.status).toBe('OK');
  });

  it('TOON render emits one trailing STATUS only', async () => {
    const r = await report({ cwd: FIX('pnpm-with-scripts') });
    const out = renderReport(r, { format: 'toon', cwd: FIX('pnpm-with-scripts') });
    const matches = out.match(/^STATUS:/gm) ?? [];
    expect(matches.length).toBe(1);
    expect(out).toMatch(/PM:/);
    expect(out).toMatch(/DEP:/);
  });

  it('JSON render carries both subtrees', async () => {
    const r = await report({ cwd: FIX('pnpm') });
    const out = renderReport(r, { format: 'json' });
    const parsed = JSON.parse(out);
    expect(parsed.audit).toBeDefined();
    expect(parsed.scripts).toBeDefined();
    expect(parsed.status).toBe('OK');
  });

  it('passes rule selection and fail gates through to the audit', async () => {
    const r = await report({
      cwd: FIX('pnpm-bad'),
      rules: ['pnpm-strict-dep-builds', 'pnpm-allow-builds'],
      failOn: ['pnpm-allow-builds'],
      reportLevel: 'low',
      failLevel: 'high',
    });
    expect(r.audit.filter).toEqual(['pnpm-allow-builds', 'pnpm-strict-dep-builds']);
    expect(r.audit.failOn).toEqual(['pnpm-allow-builds']);
    expect(r.status).toBe('FAIL');
  });
});
