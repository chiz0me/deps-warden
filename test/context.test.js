import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { buildContext } from '../src/lib/context.js';

const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);

describe('buildContext', () => {
  it('builds an npm context with .npmrc resolved', async () => {
    const ctx = await buildContext({ cwd: FIX('npm') });
    expect(ctx.pm.kind).toBe('npm');
    expect(ctx.pm.configFiles.main).toMatch(/\.npmrc$/);
    expect(ctx.pm.adapter.kind).toBe('npm');
    expect(ctx.pkg).not.toBeNull();
    expect(ctx.pkg.raw.name).toBe('fixture-npm');
  });

  it('builds a pnpm context with workspace yaml resolved', async () => {
    const ctx = await buildContext({ cwd: FIX('pnpm') });
    expect(ctx.pm.kind).toBe('pnpm');
    expect(ctx.pm.configFiles.workspace).toMatch(/pnpm-workspace\.yaml$/);
    expect(ctx.pm.adapter.kind).toBe('pnpm');
  });

  it('memoises readText through fileCache', async () => {
    const ctx = await buildContext({ cwd: FIX('npm') });
    const path = ctx.pm.configFiles.main;
    await ctx.readText(path);
    expect(ctx.fileCache.has(path)).toBe(true);
    expect(typeof ctx.fileCache.get(path)).toBe('string');
  });

  it('returns null gitTracked when .git/index missing', async () => {
    const ctx = await buildContext({ cwd: FIX('npm') });
    expect(ctx.gitTracked).toBeNull();
  });
});
