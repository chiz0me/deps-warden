/** Flag npm's explicit escape hatch that bypasses every allowScripts verdict. */

export const id = 'npm-dangerous-script-bypass';
export const severity = 'critical';
export const description = 'dangerously-allow-all-scripts bypasses the npm install-script policy.';

export function appliesTo(ctx) {
  return ctx.pm.kind === 'npm';
}

export async function check(ctx) {
  const hit = await ctx.pm.adapter.getConfig(ctx, 'dangerously-allow-all-scripts');
  if (hit.value !== true) return [];
  const file = ctx.pm.adapter.getConfigFilePath(ctx, 'main') ?? ctx.cwd;
  return [{
    severity,
    file,
    line: hit.source?.line ?? 0,
    fields: { type: id, sev: severity, current: 'true' },
    explain: 'remove this migration escape hatch; the safe fix sets dangerously-allow-all-scripts=false, then review packages with npm approve-scripts / npm deny-scripts',
  }];
}

export async function fix(ctx) {
  return [await ctx.pm.adapter.setConfig(ctx, 'dangerously-allow-all-scripts', false)];
}

export function explain() {
  return 'dangerously-allow-all-scripts=true overrides explicit approvals and '
       + 'denials and runs every dependency install script. npm documents it as '
       + 'a migration-only escape hatch and strongly discourages its use.';
}
