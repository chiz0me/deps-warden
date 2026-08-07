/**
 * Informational rule: list direct deps that ship lifecycle scripts.
 *
 * For pnpm/bun the PM blocks these by default; the finding signals which
 * packages would need to be added to the allowlist to fire. For npm/yarn-
 * classic, every entry here ran (or will run) install code on a fresh
 * install — context for risk decisions.
 *
 * Only fires when node_modules is populated; otherwise we have no data.
 */

import { enumerateDirectDepsWithScripts } from '../lib/lifecycleScripts.js';
import { join } from 'node:path';

export const id = 'direct-deps-with-scripts';
export const severity = 'low';
export const description = 'Direct dependencies declare lifecycle scripts that run on install.';

export function appliesTo(ctx) {
  return ctx.pkg !== null && ctx.pkg.raw !== null;
}

export async function check(ctx) {
  const findings = [];
  for (const ws of ctx.workspaces ?? [{ path: ctx.cwd, pkg: ctx.pkg, relative: '.', isRoot: true }]) {
    const deps = await enumerateDirectDepsWithScripts(ctx, ws);
    const withScripts = deps.filter(d => d.installed && d.hasScripts);
    if (withScripts.length === 0) continue;
    findings.push({
      severity,
      file: join(ws.path, 'package.json'),
      line: 0,
      fields: {
        type: id,
        sev: severity,
        workspace: ws.relative,
        count: withScripts.length,
        packages: withScripts.map(d => d.name).join(','),
      },
      explain: 'review each package and add to your PM allowlist only if the lifecycle script is necessary',
    });
  }
  return findings;
}

export function explain() {
  return 'A direct dependency with preinstall / install / postinstall / '
       + 'prepare scripts runs arbitrary code at install time. For pnpm '
       + 'and bun, blocking is the default — adding a package to the '
       + 'allowlist is an explicit decision. For npm and yarn-classic, '
       + 'these scripts run on every fresh install unless ignore-scripts '
       + 'is set.';
}
