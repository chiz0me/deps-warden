/**
 * Lockfile must be tracked in git.
 *
 * Skips with no findings when `.git/index` is unreadable (rule has no signal).
 * The audit emits a SKIP record in that case, surfaced by `commands/audit.js`.
 */

import { relative } from 'node:path';

export const id = 'lockfile-committed';
export const severity = 'critical';
export const description = 'Lockfile is present but not tracked in git.';

export function appliesTo(ctx) {
  return ctx.gitTracked !== null && ctx.pm.lockfile !== null;
}

export async function check(ctx) {
  const rel = relative(ctx.cwd, ctx.pm.lockfile);
  if (ctx.gitTracked.has(rel)) return [];
  return [{
    severity,
    file: ctx.pm.lockfile,
    line: 0,
    fields: { type: id, sev: severity, lockfile: rel },
    explain: `git-add ${rel} so deployments install the exact resolved tree`,
  }];
}

export function explain() {
  return 'A lockfile only protects against drift if it travels with the '
       + 'codebase. If it is .gitignored or otherwise untracked, every '
       + 'machine resolves a fresh tree and the lockfile name is just '
       + 'theatre.';
}
