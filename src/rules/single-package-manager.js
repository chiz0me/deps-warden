/**
 * Only one package-manager lockfile should be present.
 *
 * Multiple lockfiles indicate inconsistent setup — different tools will
 * resolve different trees and one of them ships to production.
 */

import { relative } from 'node:path';

export const id = 'single-package-manager';
export const severity = 'high';
export const description = 'More than one package-manager lockfile is present.';

export function appliesTo(ctx) {
  return ctx.pm.multipleLockfiles.length > 0;
}

export async function check(ctx) {
  const extras = ctx.pm.multipleLockfiles.map(p => relative(ctx.cwd, p));
  return [{
    severity,
    file: ctx.cwd,
    line: 0,
    fields: { type: id, sev: severity, primary: ctx.pm.kind, extras: extras.join(',') },
    explain: `pick one PM for this project; remove ${extras.join(', ')}`,
  }];
}

export function explain() {
  return 'When package-lock.json, pnpm-lock.yaml, yarn.lock, or bun.lockb '
       + 'coexist, different contributors and CI jobs end up resolving '
       + 'different transitive trees. Pick one tool per project.';
}
