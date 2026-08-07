/** Detect pnpm hook code that executes independently of dependency script policy. */

import { join } from 'node:path';

export const id = 'pnpmfile-execution';
export const severity = 'high';
export const description = '.pnpmfile.mjs executes package-manager hooks unless explicitly ignored.';

export function appliesTo(ctx) {
  return ctx.pm.kind === 'pnpm';
}

export async function check(ctx) {
  const file = join(ctx.cwd, '.pnpmfile.mjs');
  if (await ctx.readText(file) === null) return [];
  const ignored = await ctx.pm.adapter.getConfig(ctx, 'ignorePnpmfile');
  if (ignored.value === true) return [];
  return [{
    severity,
    file,
    line: 1,
    fields: { type: id, sev: severity, current: String(ignored.value ?? 'unset') },
    explain: 'review the hook as executable dependency-resolution code; remove it or set ignorePnpmfile=true when it is not essential',
  }];
}

export function explain() {
  return '.pnpmfile.mjs can execute even when dependency lifecycle scripts are '
       + 'disabled. Treat it as privileged build-system code and require direct '
       + 'review rather than assuming allowBuilds covers it.';
}
