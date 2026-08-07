import { describe, it, expect } from 'vitest';
import { mkdtemp, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scripts } from '../src/commands/scripts.js';

const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);

async function copyFixture(name) {
  const dst = await mkdtemp(join(tmpdir(), `dw-scripts-${name}-`));
  await cp(FIX(name), dst, { recursive: true });
  return dst;
}

describe('scripts', () => {
  it('enumerates direct deps with their installed lifecycle scripts', async () => {
    const r = await scripts({ cwd: FIX('pnpm-with-scripts') });
    expect(r.status).toBe('OK');
    const byName = Object.fromEntries(r.deps.map(d => [d.name, d]));
    expect(byName.esbuild.installed).toBe(true);
    expect(byName.esbuild.scripts).toEqual(['postinstall']);
    expect(byName.sharp.scripts).toEqual(['install']);
    expect(byName.lodash.scripts).toEqual([]);
    expect(byName.lodash.hasScripts).toBe(false);
  });

  it('reports the current pnpm allowlist', async () => {
    const r = await scripts({ cwd: FIX('pnpm-with-scripts') });
    expect(r.allowlist.entries).toEqual(['esbuild', 'sharp', 'lodash']);
  });

  it('flags installed=false when node_modules entry is missing', async () => {
    const r = await scripts({ cwd: FIX('pnpm-bad') });
    expect(r.status).toBe('OK');
    expect(r.deps).toEqual([]);
  });

  it('--add-to-allowlist merges packages without dropping existing', async () => {
    const dir = await copyFixture('pnpm-with-scripts');
    const r = await scripts({ cwd: dir, add: ['newpkg'], dryRun: false });
    expect(r.status).toBe('OK');
    const ws = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8');
    expect(ws).toMatch(/newpkg/);
    expect(ws).toMatch(/esbuild/);
  });

  it('--remove-from-allowlist drops packages', async () => {
    const dir = await copyFixture('pnpm-with-scripts');
    const r = await scripts({ cwd: dir, remove: ['lodash'], dryRun: false });
    expect(r.status).toBe('OK');
    const ws = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8');
    expect(ws).not.toMatch(/lodash/);
    expect(ws).toMatch(/esbuild/);
  });

  it('dry-runs by default', async () => {
    const dir = await copyFixture('pnpm-with-scripts');
    const before = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8');
    await scripts({ cwd: dir, add: ['newpkg'] });
    const after = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8');
    expect(after).toBe(before);
  });

  it('rejects combined add and remove operations instead of overwriting one edit', async () => {
    const dir = await copyFixture('pnpm-with-scripts');
    const before = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8');
    const r = await scripts({
      cwd: dir,
      add: ['newpkg'],
      remove: ['lodash'],
      dryRun: false,
    });
    expect(r.status).toBe('FAIL');
    expect(r.error).toMatch(/cannot be combined/);
    await expect(readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')).resolves.toBe(before);
  });

  it('npm adapter throws on add since npm has no native allowlist', async () => {
    const r = await scripts({ cwd: FIX('npm'), add: ['foo'], dryRun: false });
    expect(r.status).toBe('FAIL');
    expect(r.error).toMatch(/LavaMoat|allowlist/);
  });
});
