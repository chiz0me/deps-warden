import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

import { audit, renderAudit } from '../src/commands/audit.js';

const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);

describe('audit --rule selection', () => {
  it('runs only the chosen rule', async () => {
    const r = await audit({ cwd: FIX('npm-allow-scripts'), rules: ['npm-allow-scripts'] });
    expect(r.findings.length).toBeGreaterThan(0);
    expect([...new Set(r.findings.map(f => f.ruleId))]).toEqual(['npm-allow-scripts']);
    expect(r.filter).toEqual(['npm-allow-scripts']);
  });

  it('runs only the chosen rules and confirms others would otherwise fire', async () => {
    const all = await audit({ cwd: FIX('npm-allow-scripts') });
    const allIds = new Set(all.findings.map(f => f.ruleId));
    expect(allIds.has('recommend-stricter-pm')).toBe(true); // present without a filter

    const r = await audit({ cwd: FIX('npm-allow-scripts'), rules: ['npm-save-exact', 'min-release-age'] });
    const ids = new Set(r.findings.map(f => f.ruleId));
    expect([...ids].toSorted()).toEqual(['min-release-age', 'npm-save-exact']);
    expect(ids.has('recommend-stricter-pm')).toBe(false); // excluded by the filter
  });

  it('treats an empty/absent filter as "all rules"', async () => {
    const r = await audit({ cwd: FIX('npm-allow-scripts'), rules: [] });
    expect(r.filter).toBeNull();
    expect(new Set(r.findings.map(f => f.ruleId)).size).toBeGreaterThan(1);
  });

  it('fails fast on an unknown rule id', async () => {
    await expect(audit({ cwd: FIX('npm-allow-scripts'), rules: ['no-such-rule'] }))
      .rejects.toThrow(/unknown rule id/);
  });

  it('emits a FILTER record so the limited scope is visible', async () => {
    const r = await audit({ cwd: FIX('npm-allow-scripts'), rules: ['npm-allow-scripts'] });
    const out = renderAudit(r, { format: 'toon', cwd: FIX('npm-allow-scripts') });
    expect(out).toMatch(/^FILTER: rules=npm-allow-scripts$/m);
  });
});
