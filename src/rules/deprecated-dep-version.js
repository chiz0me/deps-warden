/**
 * Direct dependencies whose installed version is marked deprecated (or yanked)
 * on the registry.
 *
 * Network rule: only runs under `--check-versions`. npm surfaces yanked /
 * withdrawn / "do not use" advisories through the per-version `deprecated`
 * string; a deprecation message is the registry's own signal that the exact
 * version you ship should be replaced.
 */

import { join } from 'node:path';

import { enumerateDirectDeps } from '../lib/directDeps.js';

export const id = 'deprecated-dep-version';
export const severity = 'medium';
export const description = 'A direct dependency is installed at a version flagged deprecated on the registry.';

export function appliesTo(ctx) {
  return Boolean(ctx.options?.checkVersions) && ctx.pkg !== null && ctx.pkg.raw !== null;
}

export async function check(ctx) {
  const packuments = ctx.registryData?.packuments;
  if (!packuments || packuments.size === 0) return [];

  const findings = [];
  for (const ws of ctx.workspaces ?? [{ path: ctx.cwd, pkg: ctx.pkg, relative: '.' }]) {
    const deps = await enumerateDirectDeps(ctx, ws);
    for (const dep of deps) {
      if (!dep.installed || dep.installedVersion === null) continue;
      const packument = packuments.get(dep.name);
      const message = packument?.versions?.[dep.installedVersion]?.deprecated;
      if (typeof message !== 'string' || message.trim() === '') continue;

      findings.push({
        severity,
        file: join(ws.path, 'package.json'),
        line: 0,
        fields: {
          type: id,
          sev: severity,
          workspace: ws.relative,
          package: dep.name,
          installed: dep.installedVersion,
          notice: message,
        },
        explain: `${dep.name}@${dep.installedVersion} is deprecated: ${message}`,
      });
    }
  }
  return findings;
}

export function explain() {
  return 'A deprecation notice on the exact installed version is the '
       + 'registry maintainer telling you to stop using it — frequently '
       + 'because of a security advisory, a yank, or a known-broken release. '
       + 'Move to a non-deprecated version.';
}
