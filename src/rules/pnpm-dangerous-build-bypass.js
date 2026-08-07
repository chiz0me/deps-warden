/** Flag pnpm's escape hatch that grants install-time code execution to all dependencies. */

export const id = 'pnpm-dangerous-build-bypass';
export const severity = 'critical';
export const description = 'dangerouslyAllowAllBuilds bypasses pnpm build-script decisions.';

export function appliesTo(ctx) {
  return ctx.pm.kind === 'pnpm';
}

export async function check(ctx) {
  const hit = await ctx.pm.adapter.getConfig(ctx, 'dangerouslyAllowAllBuilds');
  if (hit.value !== true) return [];
  const file = hit.source?.file
    ?? ctx.pm.adapter.getConfigFilePath(ctx, 'workspace')
    ?? ctx.cwd;
  return [{
    severity,
    file,
    line: hit.source?.line ?? 0,
    fields: { type: id, sev: severity, current: 'true' },
    explain: 'set dangerouslyAllowAllBuilds=false and record explicit true/false decisions in allowBuilds instead',
  }];
}

export async function fix(ctx) {
  return [await ctx.pm.adapter.setConfig(ctx, 'dangerouslyAllowAllBuilds', false)];
}

export function explain() {
  return 'dangerouslyAllowAllBuilds=true permits every current and future '
       + 'transitive dependency to execute install scripts. Keep it false and '
       + 'grant only reviewed package matchers through allowBuilds.';
}
