/**
 * pnpm 10.3+ supports `strictDepBuilds: true`, which fails the install if any
 * dependency tries to run an install script that isn't in the allowlist.
 */

import { relative } from 'node:path';

export const id = 'pnpm-strict-dep-builds';
export const severity = 'high';
export const description = 'An explicit `strictDepBuilds: true` policy is not set for pnpm.';

export function appliesTo(ctx) {
  return ctx.pm.kind === 'pnpm';
}

export async function check(ctx) {
  const hit = await ctx.pm.adapter.getConfig(ctx, 'strictDepBuilds');
  if (hit.value === true) return [];
  const wsFile = ctx.pm.adapter.getConfigFilePath(ctx, 'workspace');
  const file = wsFile ?? ctx.pm.adapter.getConfigFilePath(ctx, 'main') ?? ctx.cwd;
  return [{
    severity,
    file,
    line: hit.source?.line ?? 0,
    fields: { type: id, sev: severity, current: String(hit.value ?? 'unset'), location: relative(ctx.cwd, file) },
    explain: 'set `strictDepBuilds: true` so unapproved install scripts fail CI loudly',
  }];
}

export async function fix(ctx) {
  return [await ctx.pm.adapter.setConfig(ctx, 'strictDepBuilds', true)];
}

export function explain() {
  return 'Current pnpm defaults strictDepBuilds to true, but recording it '
       + 'explicitly keeps the policy stable across supported clients. It '
       + 'turns every unreviewed build attempt into a hard installation '
       + 'failure instead of a warning.';
}
