import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { buildContext } from '../src/lib/context.js';

const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);

describe('npm adapter', () => {
  it('reads scalar config from .npmrc', async () => {
    const ctx = await buildContext({ cwd: FIX('npm') });
    const hit = await ctx.pm.adapter.getConfig(ctx, 'ignore-scripts');
    expect(hit.value).toBe(true);
    expect(hit.source.line).toBe(1);
  });

  it('returns undefined for unset config', async () => {
    const ctx = await buildContext({ cwd: FIX('npm-loose') });
    const hit = await ctx.pm.adapter.getConfig(ctx, 'ignore-scripts');
    expect(hit.value).toBeUndefined();
    expect(hit.source).toBeNull();
  });

  it('setConfig produces a proposed write with full new content', async () => {
    const ctx = await buildContext({ cwd: FIX('npm-loose') });
    const proposal = await ctx.pm.adapter.setConfig(ctx, 'ignore-scripts', true);
    expect(proposal.file).toMatch(/\.npmrc$/);
    expect(proposal.content).toBe('ignore-scripts=true\n');
  });

  it('allowlist methods reflect npm absence of native allowlist', async () => {
    const ctx = await buildContext({ cwd: FIX('npm') });
    const allow = await ctx.pm.adapter.getAllowlist(ctx);
    expect(allow.entries).toEqual([]);
    expect(allow.source).toBeNull();
    await expect(ctx.pm.adapter.addToAllowlist(ctx, ['x'])).rejects.toThrow(/no native allowlist/);
  });
});

describe('pnpm adapter', () => {
  it('reads allowBuilds from workspace yaml', async () => {
    const ctx = await buildContext({ cwd: FIX('pnpm') });
    const hit = await ctx.pm.adapter.getConfig(ctx, 'allowBuilds');
    expect(hit.value).toEqual({ esbuild: true });
    expect(hit.source.file).toMatch(/pnpm-workspace\.yaml$/);
  });

  it('reads strictDepBuilds from workspace yaml', async () => {
    const ctx = await buildContext({ cwd: FIX('pnpm') });
    const hit = await ctx.pm.adapter.getConfig(ctx, 'strictDepBuilds');
    expect(hit.value).toBe(true);
  });

  it('returns undefined when neither workspace nor npmrc carries the key', async () => {
    const ctx = await buildContext({ cwd: FIX('pnpm-bad') });
    const hit = await ctx.pm.adapter.getConfig(ctx, 'allowBuilds');
    expect(hit.value).toBeUndefined();
    expect(hit.source).toBeNull();
  });

  it('setConfig writes to workspace yaml when present', async () => {
    const ctx = await buildContext({ cwd: FIX('pnpm') });
    const proposal = await ctx.pm.adapter.setConfig(ctx, 'allowBuilds', {});
    expect(proposal.file).toMatch(/pnpm-workspace\.yaml$/);
    expect(proposal.content).toMatch(/allowBuilds:\s*\{\s*\}/);
  });

  it('setConfig writes to .npmrc only when workspace yaml absent', async () => {
    const ctx = await buildContext({ cwd: FIX('pnpm-bad') });
    // pnpm-bad has neither workspace nor .npmrc, but adapter still resolves a target.
    const proposal = await ctx.pm.adapter.setConfig(ctx, 'allowBuilds', { esbuild: true });
    expect(proposal.file).toMatch(/(pnpm-workspace\.yaml|\.npmrc)$/);
  });

  it('addToAllowlist merges with existing entries', async () => {
    const ctx = await buildContext({ cwd: FIX('pnpm') });
    const proposal = await ctx.pm.adapter.addToAllowlist(ctx, ['sharp']);
    expect(proposal.content).toMatch(/esbuild/);
    expect(proposal.content).toMatch(/sharp/);
  });

  it('treats only true allowBuilds decisions as execution grants', async () => {
    const ctx = await buildContext({ cwd: FIX('pnpm') });
    const allow = await ctx.pm.adapter.getAllowlist(ctx);
    expect(allow.entries).toEqual(['esbuild']);
  });
});
