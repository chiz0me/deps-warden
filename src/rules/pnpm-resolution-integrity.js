/** Detect pnpm settings that deliberately weaken dependency-resolution checks. */

export const id = 'pnpm-resolution-integrity';
export const severity = 'high';
export const description = 'pnpm lockfile or exotic-source verification is explicitly weakened.';

export function appliesTo(ctx) {
  return ctx.pm.kind === 'pnpm';
}

export async function check(ctx) {
  const findings = [];
  const trustLockfile = await ctx.pm.adapter.getConfig(ctx, 'trustLockfile');
  if (trustLockfile.value === true) {
    findings.push(makeFinding(ctx, trustLockfile, 'trustLockfile', 'true',
      'set trustLockfile=false so pnpm verifies lockfile package data instead of trusting it without validation'));
  }

  const exotic = await ctx.pm.adapter.getConfig(ctx, 'blockExoticSubdeps');
  if (exotic.value === false) {
    findings.push(makeFinding(ctx, exotic, 'blockExoticSubdeps', 'false',
      'set blockExoticSubdeps=true so transitive dependencies cannot introduce unreviewed Git, URL, or filesystem sources'));
  }
  return findings;
}

export async function fix(ctx, finding) {
  const control = finding?.fields?.control;
  if (control === 'trustLockfile') {
    return [await ctx.pm.adapter.setConfig(ctx, control, false)];
  }
  if (control === 'blockExoticSubdeps') {
    return [await ctx.pm.adapter.setConfig(ctx, control, true)];
  }
  throw new Error(`unsupported pnpm resolution control: ${String(control)}`);
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
  return 'trustLockfile=true skips lockfile package-data verification, while '
       + 'blockExoticSubdeps=false lets transitive packages select Git, URL, or '
       + 'filesystem sources. Keep both paths fail closed.';
}
