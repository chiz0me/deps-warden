/** Ensure pnpm's release-age policy fails closed when metadata is incomplete. */

export const id = 'pnpm-release-age-strict';
export const severity = 'high';
export const description = 'pnpm minimum-release-age enforcement can fall back or ignore missing publish times.';

export function appliesTo(ctx) {
  return ctx.pm.kind === 'pnpm';
}

export async function check(ctx) {
  const age = await ctx.pm.adapter.getConfig(ctx, 'minimumReleaseAge');
  if (age.value === undefined || age.value === null || age.value === 0) return [];

  const findings = [];
  const strict = await ctx.pm.adapter.getConfig(ctx, 'minimumReleaseAgeStrict');
  if (strict.value === false) {
    findings.push(makeFinding(ctx, strict, 'minimumReleaseAgeStrict', 'false',
      'set minimumReleaseAgeStrict=true so resolution fails when no mature version satisfies the requested range'));
  }

  const missingTime = await ctx.pm.adapter.getConfig(ctx, 'minimumReleaseAgeIgnoreMissingTime');
  if (missingTime.value !== false) {
    findings.push(makeFinding(ctx, missingTime, 'minimumReleaseAgeIgnoreMissingTime', String(missingTime.value ?? 'unset'),
      'set minimumReleaseAgeIgnoreMissingTime=false so registries that omit publish timestamps cannot bypass the age policy'));
  }
  return findings;
}

export async function fix(ctx, finding) {
  const key = finding?.fields?.control;
  if (key === 'minimumReleaseAgeStrict') {
    return [await ctx.pm.adapter.setConfig(ctx, key, true)];
  }
  if (key === 'minimumReleaseAgeIgnoreMissingTime') {
    return [await ctx.pm.adapter.setConfig(ctx, key, false)];
  }
  throw new Error(`unsupported pnpm release-age control: ${String(key)}`);
}

function makeFinding(ctx, hit, control, current, remediation) {
  return {
    severity,
    file: hit.source?.file ?? ctx.pm.adapter.getConfigFilePath(ctx, 'workspace') ?? ctx.cwd,
    line: hit.source?.line ?? 0,
    fields: { type: id, sev: severity, control, current },
    explain: remediation,
  };
}

export function explain() {
  return 'An age window is only fail-closed when pnpm refuses both an immature '
       + 'fallback and packages whose registry metadata has no publish time. '
       + 'Explicit settings make that behavior reviewable across CI environments.';
}
