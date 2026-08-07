/**
 * Lockfile must exist. Without one, every install pulls the floating tip of
 * each transitive version range — a supply-chain accident waiting to happen.
 */

export const id = 'lockfile-present';
export const severity = 'critical';
export const description = 'No lockfile found in project root.';

export function appliesTo() { return true; }

export async function check(ctx) {
  if (ctx.pm.lockfile !== null) return [];
  return [{
    severity,
    file: ctx.cwd,
    line: 0,
    fields: { type: id, sev: severity, pm: ctx.pm.kind },
    explain: `commit a lockfile for ${ctx.pm.kind} (e.g. package-lock.json, npm-shrinkwrap.json, or pnpm-lock.yaml) to pin transitive versions`,
  }];
}

export function explain() {
  return 'A lockfile records the resolved tree of transitive dependencies. '
       + 'Without it, two installs of the same package.json on different days '
       + 'can resolve to different artifacts — defeating reproducibility and '
       + 'opening the door to upstream takeovers shipping new minor/patch '
       + 'versions during a CI run.';
}
