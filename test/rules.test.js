import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { buildContext } from '../src/lib/context.js';
import { RULES, listRules } from '../src/rules/index.js';

const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);

async function runRules(ctx) {
  const out = [];
  for (const rule of RULES) {
    if (!(await rule.appliesTo(ctx))) continue;
    const findings = await rule.check(ctx);
    for (const f of findings) out.push({ rule: rule.id, ...f });
  }
  return out;
}

describe('rule registry', () => {
  it('listRules exposes id, severity, description', () => {
    const ls = listRules();
    expect(ls.length).toBeGreaterThan(5);
    for (const r of ls) {
      expect(typeof r.id).toBe('string');
      expect(['low', 'medium', 'high', 'critical']).toContain(r.severity);
      expect(typeof r.description).toBe('string');
    }
  });

  it('every rule has a unique id', () => {
    const ids = RULES.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('rules against pnpm clean fixture', () => {
  it('produces no findings on pnpm fixture (modulo lockfile-committed which skips without .git/index)', async () => {
    const ctx = await buildContext({ cwd: FIX('pnpm') });
    const findings = await runRules(ctx);
    // No findings expected — fixture is configured optimally.
    expect(findings.map(f => f.rule)).toEqual([]);
  });
});

describe('rules against pnpm-bad fixture', () => {
  it('flags unknown pnpm version, missing allowBuilds, strictDepBuilds, min-release-age, engines.node', async () => {
    const ctx = await buildContext({ cwd: FIX('pnpm-bad') });
    const findings = await runRules(ctx);
    const ids = findings.map(f => f.rule);
    expect(ids).toContain('pnpm-version-supported');
    expect(ids).toContain('pnpm-allow-builds');
    expect(ids).toContain('pnpm-strict-dep-builds');
    expect(ids).toContain('min-release-age');
    expect(ids).toContain('node-engines-pinned');
  });

  it('every flagged rule with a fix produces a non-empty ProposedWrite', async () => {
    const ctx = await buildContext({ cwd: FIX('pnpm-bad') });
    for (const rule of RULES) {
      if (typeof rule.fix !== 'function') continue;
      if (!(await rule.appliesTo(ctx))) continue;
      const findings = await rule.check(ctx);
      if (findings.length === 0) continue;
      const proposals = await rule.fix(ctx, { ...findings[0], ruleId: rule.id });
      expect(Array.isArray(proposals)).toBe(true);
      for (const p of proposals) {
        expect(typeof p.file).toBe('string');
        expect(typeof p.content).toBe('string');
        expect(p.content.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('rules against npm-loose fixture', () => {
  it('flags missing ignore-scripts, save-exact, engines.node, and min-release-age (npm 11.16+)', async () => {
    const ctx = await buildContext({ cwd: FIX('npm-loose') });
    const findings = await runRules(ctx);
    const ids = findings.map(f => f.rule);
    expect(ids).toContain('npm-ignore-scripts');
    expect(ids).toContain('npm-save-exact');
    expect(ids).toContain('node-engines-pinned');
    expect(ids).toContain('min-release-age');
  });
});

describe('rules against multi-pm fixture', () => {
  it('fires single-package-manager', async () => {
    const ctx = await buildContext({ cwd: FIX('multi-pm') });
    const findings = await runRules(ctx);
    expect(findings.map(f => f.rule)).toContain('single-package-manager');
  });
});
