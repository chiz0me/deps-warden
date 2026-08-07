import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

import { audit, renderAudit } from '../src/commands/audit.js';

const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);

describe('audit --fail-on gate', () => {
  it('reports all rules but passes when no gating rule fired', async () => {
    const r = await audit({ cwd: FIX('npm-allow-scripts'), failOn: ['npm-package-lock'] });
    // npm-package-lock does not fire here, but other rules do.
    expect(r.findings.length).toBeGreaterThan(1);
    expect(r.findings.some(f => f.ruleId === 'recommend-stricter-pm')).toBe(true);
    expect(r.status).toBe('OK'); // gate passes despite non-gating findings
    expect(r.failOn).toEqual(['npm-package-lock']);
  });

  it('fails when a gating rule fired, keeping the full report', async () => {
    const r = await audit({ cwd: FIX('npm-allow-scripts'), failOn: ['npm-allow-scripts'] });
    expect(r.status).toBe('FAIL');
    // full report retained — non-gating findings still present
    expect(r.findings.some(f => f.ruleId === 'recommend-stricter-pm')).toBe(true);
    expect(r.findings.some(f => f.ruleId === 'npm-allow-scripts')).toBe(true);
  });

  it('respects severity/ignore filtering: a gating rule filtered out does not trip the gate', async () => {
    const r = await audit({ cwd: FIX('npm-allow-scripts'), failOn: ['recommend-stricter-pm'], severity: 'high' });
    // recommend-stricter-pm is low → filtered out by --severity=high → not a finding → gate passes
    expect(r.findings.some(f => f.ruleId === 'recommend-stricter-pm')).toBe(false);
    expect(r.status).toBe('OK');
  });

  it('emits a GATE record reflecting the outcome', async () => {
    const r = await audit({ cwd: FIX('npm-allow-scripts'), failOn: ['npm-allow-scripts'] });
    const out = renderAudit(r, { format: 'toon', cwd: FIX('npm-allow-scripts') });
    expect(out).toMatch(/^GATE: fail_on=npm-allow-scripts triggered_by=npm-allow-scripts result=fail$/m);
    expect(out).toMatch(/STATUS: FAIL/);
  });

  it('fails fast on an unknown fail-on id', async () => {
    await expect(audit({ cwd: FIX('npm-allow-scripts'), failOn: ['no-such-rule'] }))
      .rejects.toThrow(/unknown rule id.*--fail-on/);
  });
});
