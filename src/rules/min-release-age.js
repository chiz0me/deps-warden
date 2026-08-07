/**
 * A minimum release-age should be configured to delay the install of freshly
 * published versions. PMs locate and encode this differently:
 *   - npm 11.16+: `min-release-age` in `.npmrc` — an integer number of days
 *   - pnpm: `minimumReleaseAge` in pnpm-workspace.yaml — integer minutes
 * yarn has no native support yet. The adapter maps the shared
 * `minimumReleaseAge` key to each PM's real config key.
 */

import { relative } from 'node:path';

export const id = 'min-release-age';
export const severity = 'high';
export const description = 'A minimum release-age is not configured.';

const DEFAULT_DAYS = 7;
const SUPPORTED = new Set(['npm', 'pnpm']);

function recommendedValue(kind) {
  return kind === 'npm' ? DEFAULT_DAYS : DEFAULT_DAYS * 24 * 60;
}

function configKeyName(kind) {
  return kind === 'npm' ? 'min-release-age' : 'minimumReleaseAge';
}

export function appliesTo(ctx) {
  return SUPPORTED.has(ctx.pm.kind);
}

export async function check(ctx) {
  const hit = await ctx.pm.adapter.getConfig(ctx, 'minimumReleaseAge');
  if (hit.value !== undefined && hit.value !== null && hit.value !== '' && hit.value !== 0) return [];
  const where = ctx.pm.adapter.getConfigFilePath(ctx, 'workspace')
             ?? ctx.pm.adapter.getConfigFilePath(ctx, 'main');
  const file = where ?? ctx.cwd;
  return [{
    severity,
    file,
    line: 0,
    fields: { type: id, sev: severity, recommended: recommendedValue(ctx.pm.kind), location: relative(ctx.cwd, file) },
    explain: `set ${configKeyName(ctx.pm.kind)} to ${DEFAULT_DAYS} days to block freshly-published (potentially malicious) versions`,
  }];
}

export async function fix(ctx) {
  const proposal = await ctx.pm.adapter.setConfig(ctx, 'minimumReleaseAge', recommendedValue(ctx.pm.kind));
  return [proposal];
}

export function explain() {
  return 'Compromised package versions typically get yanked within hours '
       + 'of disclosure. A minimumReleaseAge of several days ensures your '
       + 'installs lag behind, so a freshly-malicious patch never lands '
       + 'before the maintainer or registry can react.';
}
