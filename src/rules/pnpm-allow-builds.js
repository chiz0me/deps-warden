/**
 * pnpm should have `allowBuilds` (10.26+) or `onlyBuiltDependencies` set so
 * lifecycle scripts only fire for an explicit allowlist.
 */

import { relative } from 'node:path';

export const id = 'pnpm-allow-builds';
export const severity = 'high';
export const description = 'pnpm allowBuilds / onlyBuiltDependencies is not configured.';

export function appliesTo(ctx) {
  return ctx.pm.kind === 'pnpm';
}

export async function check(ctx) {
  const allow = await ctx.pm.adapter.getConfig(ctx, 'allowBuilds');
  if (isDecisionMap(allow.value)) return [];
  if (allow.source !== null) {
    return [{
      severity,
      file: allow.source.file,
      line: allow.source.line,
      fields: { type: id, sev: severity, current: Array.isArray(allow.value) ? 'array' : typeof allow.value },
      explain: 'replace allowBuilds with a matcher-to-boolean map, for example `allowBuilds: { esbuild: true }`; an empty map blocks every dependency build',
    }];
  }
  const legacy = await ctx.pm.adapter.getConfig(ctx, 'onlyBuiltDependencies');
  if (Array.isArray(legacy.value)) {
    return [{
      severity,
      file: legacy.source?.file ?? ctx.cwd,
      line: legacy.source?.line ?? 0,
      fields: { type: id, sev: severity, current: 'legacy-onlyBuiltDependencies' },
      explain: 'migrate onlyBuiltDependencies to the allowBuilds decision map before pnpm 11, which removed the legacy setting',
    }];
  }

  const wsFile = ctx.pm.adapter.getConfigFilePath(ctx, 'workspace');
  const file = wsFile ?? ctx.pm.adapter.getConfigFilePath(ctx, 'main') ?? ctx.cwd;
  return [{
    severity,
    file,
    line: 0,
    fields: { type: id, sev: severity, location: relative(ctx.cwd, file) },
    explain: 'set `allowBuilds: {}` in pnpm-workspace.yaml to record an explicit deny-by-default policy; set reviewed package matchers to true',
  }];
}

export async function fix(ctx) {
  // Strictest safe default: empty allowlist.
  const proposal = await ctx.pm.adapter.setConfig(ctx, 'allowBuilds', {});
  return [proposal];
}

export function explain() {
  return 'pnpm 10.26+ uses an allowBuilds matcher-to-boolean map. Packages '
       + 'not listed are denied and treated as unreviewed; explicit true '
       + 'entries grant install-time code execution. pnpm 11 removed the '
       + 'legacy onlyBuiltDependencies family of settings.';
}

function isDecisionMap(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every(decision => typeof decision === 'boolean');
}
