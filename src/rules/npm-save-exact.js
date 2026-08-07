/**
 * `npm install foo` should write exact versions (`"foo": "1.2.3"`) not
 * floating ranges (`"^1.2.3"`).
 */

import { relative } from 'node:path';

export const id = 'npm-save-exact';
export const severity = 'medium';
export const description = '`save-exact=true` is not set in npm config.';

export function appliesTo(ctx) {
  return ctx.pm.kind === 'npm';
}

export async function check(ctx) {
  const hit = await ctx.pm.adapter.getConfig(ctx, 'save-exact');
  if (hit.value === true) return [];
  const file = ctx.pm.adapter.getConfigFilePath(ctx, 'main');
  return [{
    severity,
    file: file ?? ctx.cwd,
    line: hit.source?.line ?? 0,
    fields: { type: id, sev: severity, current: String(hit.value ?? 'unset'), file: file ? relative(ctx.cwd, file) : '' },
    explain: 'add `save-exact=true` to .npmrc so new deps are pinned to exact versions',
  }];
}

export async function fix(ctx) {
  return [await ctx.pm.adapter.setConfig(ctx, 'save-exact', true)];
}

export function explain() {
  return 'Floating semver ranges in package.json (`^1.2.3`) mean that, even '
       + 'with a lockfile, manual `npm install foo` followed by `npm install` '
       + 'will update foo to a newer minor. Combined with the new version '
       + 'shipping malware, this is the typical worm propagation path.';
}
