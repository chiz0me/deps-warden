/**
 * `package-lock=true` must not be disabled (npm's default is true, but some
 * projects flip it accidentally and break reproducibility).
 */

import { relative } from 'node:path';

export const id = 'npm-package-lock';
export const severity = 'high';
export const description = '`package-lock=false` disables the npm lockfile.';

export function appliesTo(ctx) {
  return ctx.pm.kind === 'npm';
}

export async function check(ctx) {
  const hit = await ctx.pm.adapter.getConfig(ctx, 'package-lock');
  if (hit.value !== false) return [];
  const file = ctx.pm.adapter.getConfigFilePath(ctx, 'main');
  return [{
    severity,
    file: file ?? ctx.cwd,
    line: hit.source?.line ?? 0,
    fields: { type: id, sev: severity, file: file ? relative(ctx.cwd, file) : '' },
    explain: 'remove `package-lock=false` from .npmrc; the lockfile is required for reproducible installs',
  }];
}

export async function fix(ctx) {
  return [await ctx.pm.adapter.setConfig(ctx, 'package-lock', true)];
}

export function explain() {
  return 'Setting package-lock=false tells npm to ignore the lockfile on '
       + 'install. Every developer and CI run resolves a fresh tree, '
       + 'defeating the entire purpose of having a lockfile in repo.';
}
