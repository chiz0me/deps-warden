/**
 * Informational rule: a stricter package manager blocks install scripts by
 * default.
 *
 * Fires for npm and yarn-classic. pnpm (`allowBuilds`/`onlyBuiltDependencies`),
 * bun (`trustedDependencies`), and yarn-berry block dependency install scripts
 * by default and require an explicit allowlist to run them. npm 11.16 can make
 * its native allowScripts policy fail closed with strict-allow-scripts; npm 12
 * does so by default. yarn-classic is EOL upstream.
 *
 * For npm projects the more actionable check is `npm-allow-scripts`, which
 * flags install-script deps not covered by the native allowScripts policy.
 *
 * No fix — migrations are deliberately out of scope.
 */

import { join } from 'node:path';
import semver from 'semver';

export const id = 'recommend-stricter-pm';
export const severity = 'low';
export const description = 'Consider a fail-closed package manager when npm/yarn-classic install scripts remain permissive.';

const TRIGGER_PMS = new Set(['npm', 'yarn-classic']);

export function appliesTo(ctx) {
  return TRIGGER_PMS.has(ctx.pm.kind);
}

export async function check(ctx) {
  if (ctx.pm.kind === 'npm') {
    const ignore = await ctx.pm.adapter.getConfig(ctx, 'ignore-scripts');
    const strict = await ctx.pm.adapter.getConfig(ctx, 'strict-allow-scripts');
    const declared = ctx.pm.source === 'packageManager' && ctx.pm.version
      ? semver.coerce(ctx.pm.version)
      : null;
    if (ignore.value === true || strict.value === true
      || (declared && semver.gte(declared, '12.0.0'))) return [];
  }
  return [{
    severity,
    file: join(ctx.cwd, 'package.json'),
    line: 0,
    fields: {
      type: id,
      sev: severity,
      current: ctx.pm.kind,
      suggested: 'pnpm or bun',
    },
    explain: 'install scripts are not fail-closed; on npm 11.16+ curate allowScripts and set strict-allow-scripts=true, upgrade a reviewed project to npm v12, or consider pnpm/bun/yarn-berry',
  }];
}

export function explain() {
  return 'pnpm, bun, and yarn-berry block dependency install scripts by '
       + 'default and require an explicit allowlist to run them. npm 11.16 can '
       + 'make allowScripts fail closed with strict-allow-scripts=true, and npm '
       + 'v12 blocks unapproved scripts by default. For an existing npm project, '
       + 'prefer the native reviewed policy or ignore-scripts=true over switching '
       + 'managers; this suggestion is aimed '
       + 'at greenfield projects weighing supply-chain defaults. deps-warden '
       + 'does not migrate projects.';
}
