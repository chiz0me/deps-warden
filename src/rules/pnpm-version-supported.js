/** Ensure the selected pnpm can enforce the current build-policy schema. */

import { join } from 'node:path';
import semver from 'semver';

export const id = 'pnpm-version-supported';
export const severity = 'high';
export const description = 'The pnpm version is unknown or lacks the current supply-chain controls.';

export const MIN_PNPM = '10.26.0';

export function appliesTo(ctx) {
  return ctx.pm.kind === 'pnpm';
}

export async function check(ctx) {
  const parsed = ctx.pm.version ? semver.coerce(ctx.pm.version) : null;
  if (parsed && semver.gte(parsed, MIN_PNPM)) return [];

  const current = parsed?.version ?? 'unknown';
  return [{
    severity,
    file: join(ctx.cwd, 'package.json'),
    line: ctx.pkg?.topLevelLines?.get('packageManager') ?? 0,
    fields: {
      type: id,
      sev: severity,
      detected: current,
      required: `>=${MIN_PNPM}`,
      evidence: ctx.pm.source,
    },
    explain: current === 'unknown'
      ? `declare an exact packageManager pnpm version at or above ${MIN_PNPM}; without it deps-warden cannot determine which security settings pnpm will honor`
      : `pnpm ${current} predates the allowBuilds decision map; migrate with pnpm's reviewed v10-to-v11 codemod and pin a supported version at or above ${MIN_PNPM}`,
  }];
}

export function explain() {
  return 'pnpm supply-chain settings are versioned: strictDepBuilds arrived '
       + 'in 10.3, dangerouslyAllowAllBuilds in 10.9, and the allowBuilds '
       + 'decision map in 10.26. An exact packageManager declaration makes '
       + 'the enforced schema reviewable in developer and CI environments.';
}
