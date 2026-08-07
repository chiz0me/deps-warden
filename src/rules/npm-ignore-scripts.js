/**
 * npm should run with `ignore-scripts=true` and rely on an explicit allowlist
 * tool (LavaMoat @lavamoat/allow-scripts) for the few dependencies that need
 * native builds.
 */

import { relative } from 'node:path';
import semver from 'semver';

export const id = 'npm-ignore-scripts';
export const severity = 'high';
export const description = '`ignore-scripts=true` is not set in npm config.';

export function appliesTo(ctx) {
  return ctx.pm.kind === 'npm';
}

export async function check(ctx) {
  const hit = await ctx.pm.adapter.getConfig(ctx, 'ignore-scripts');
  if (hit.value === true) return [];

  // npm 11.16 can make the allowScripts policy fail closed explicitly; npm
  // 12 does so by default. In either case, forcing ignore-scripts would erase
  // the project's reviewed per-package approvals and is no longer necessary.
  const strict = await ctx.pm.adapter.getConfig(ctx, 'strict-allow-scripts');
  const declaredNpm = ctx.pm.source === 'packageManager' && ctx.pm.version
    ? semver.coerce(ctx.pm.version)
    : null;
  if (strict.value === true || (declaredNpm && semver.gte(declaredNpm, '12.0.0'))) return [];
  const file = ctx.pm.adapter.getConfigFilePath(ctx, 'main');
  return [{
    severity,
    file: file ?? ctx.cwd,
    line: hit.source?.line ?? 0,
    fields: { type: id, sev: severity, current: String(hit.value ?? 'unset'), file: file ? relative(ctx.cwd, file) : '' },
    explain: 'add `ignore-scripts=true`, or on npm 11.16+ curate allowScripts and set `strict-allow-scripts=true`; npm v12 blocks unapproved scripts by default',
  }];
}

export async function fix(ctx) {
  const proposal = await ctx.pm.adapter.setConfig(ctx, 'ignore-scripts', true);
  return [proposal];
}

export function explain() {
  return 'On npm before v12, unreviewed dependency scripts still run unless '
       + 'ignore-scripts=true or strict-allow-scripts=true is set. npm v12 '
       + 'blocks unapproved dependency scripts by default. Prefer the native '
       + 'allowScripts review workflow when selected packages genuinely need '
       + 'build scripts; use ignore-scripts=true to block all dependency scripts.';
}
