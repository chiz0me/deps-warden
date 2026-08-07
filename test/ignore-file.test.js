import { describe, it, expect } from 'vitest';
import { mkdtemp, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { audit, renderAudit } from '../src/commands/audit.js';
import { parseIgnoreFile } from '../src/lib/ignoreFile.js';

const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);

async function copyFixture(name) {
  const dst = await mkdtemp(join(tmpdir(), `dw-ignore-${name}-`));
  await cp(FIX(name), dst, { recursive: true });
  return dst;
}

describe('parseIgnoreFile', () => {
  it('reads one entry per line, ignoring blanks and full-line comments', () => {
    const entries = parseIgnoreFile('# header\n\nrecommend-stricter-pm\n\n# trailing\nnode-engines-pinned\n');
    expect([...entries]).toEqual(['recommend-stricter-pm', 'node-engines-pinned']);
  });

  it('strips inline comments and splits comma/space separated tokens', () => {
    const entries = parseIgnoreFile('fff769fa22  # accept legacy\nnpm-save-exact, npm-package-lock\n');
    expect(entries.has('fff769fa22')).toBe(true);
    expect(entries.has('npm-save-exact')).toBe(true);
    expect(entries.has('npm-package-lock')).toBe(true);
    expect(entries.has('#')).toBe(false);
  });
});

describe('audit honours .deps-warden-ignore', () => {
  it('suppresses a whole rule by id and reports it as IGNORED', async () => {
    const r = await audit({ cwd: FIX('npm-ignorefile') });

    expect(r.findings.some(f => f.ruleId === 'recommend-stricter-pm')).toBe(false);
    const ig = r.ignored.find(i => i.rule === 'recommend-stricter-pm');
    expect(ig).toBeTruthy();
    expect(ig.matchedBy).toBe('rule');
    expect(r.summary.ignored).toBe(1);

    const out = renderAudit(r, { format: 'toon', cwd: FIX('npm-ignorefile') });
    expect(out).toMatch(/^IGNORED: rule=recommend-stricter-pm/m);
    expect(out).toMatch(/ignored=1/);
  });

  it('does not affect findings the file does not list', async () => {
    const r = await audit({ cwd: FIX('npm-ignorefile') });
    expect(r.findings.some(f => f.ruleId === 'node-engines-pinned')).toBe(true);
  });

  it('suppresses a single finding by its id, leaving the rule active elsewhere', async () => {
    const dir = await copyFixture('npm-ignorefile');
    const baseline = await audit({ cwd: dir });
    const target = baseline.findings.find(f => f.ruleId === 'node-engines-pinned');
    expect(target).toBeTruthy();

    await writeFile(join(dir, '.deps-warden-ignore'), `recommend-stricter-pm\n${target.id}\n`, 'utf8');
    const after = await audit({ cwd: dir });

    expect(after.findings.some(f => f.id === target.id)).toBe(false);
    const ig = after.ignored.find(i => i.id === target.id);
    expect(ig.matchedBy).toBe('id');
  });
});
