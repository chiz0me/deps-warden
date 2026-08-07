import { describe, it, expect } from 'vitest';
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { audit } from '../src/commands/audit.js';
import { fix } from '../src/commands/fix.js';

const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);

async function copyFixture(name) {
  const dst = await mkdtemp(join(tmpdir(), `dw-mra-${name}-`));
  await cp(FIX(name), dst, { recursive: true });
  return dst;
}

describe('min-release-age on npm (11.16+ min-release-age)', () => {
  it('fires when min-release-age is unset', async () => {
    const r = await audit({ cwd: FIX('npm-loose') });
    const f = r.findings.find(x => x.ruleId === 'min-release-age');
    expect(f).toBeTruthy();
    expect(f.fields.recommended).toBe(7);
  });

  it('does not fire when min-release-age is set in .npmrc', async () => {
    const dir = await copyFixture('npm');
    await writeFile(join(dir, '.npmrc'), 'ignore-scripts=true\nmin-release-age=7\n', 'utf8');
    const r = await audit({ cwd: dir });
    expect(r.findings.some(x => x.ruleId === 'min-release-age')).toBe(false);
  });

  it('fix writes the integer-days key npm expects, and clears the finding', async () => {
    const dir = await copyFixture('npm-loose');
    const a = await audit({ cwd: dir });
    const target = a.findings.find(x => x.ruleId === 'min-release-age');
    const r = await fix({ cwd: dir, finding: target.id, dryRun: false });
    expect(r.status).toBe('OK');

    const npmrc = await readFile(join(dir, '.npmrc'), 'utf8');
    expect(npmrc).toMatch(/^min-release-age=7$/m);
    expect(npmrc).not.toMatch(/min-release-age=7d/);

    const a2 = await audit({ cwd: dir });
    expect(a2.findings.map(x => x.ruleId)).not.toContain('min-release-age');
  });
});
