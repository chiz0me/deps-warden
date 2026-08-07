/**
 * Direct dependencies that are at least one major version behind the
 * registry's `latest` dist-tag.
 *
 * Network rule: only runs under `--check-versions`. A major-version lag is a
 * supply-chain signal — security patches land on current majors first, and a
 * long-stale dep is more likely to be unmaintained (and so a takeover target).
 */

import semver from 'semver';
import { join } from 'node:path';

import { enumerateDirectDeps } from '../lib/directDeps.js';

export const id = 'outdated-major-deps';
export const severity = 'low';
export const description = 'A direct dependency is one or more major versions behind the registry latest.';

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
      if (!packument || !packument.latest) continue;

      const current = semver.coerce(dep.installedVersion);
      const latest = semver.coerce(packument.latest);
      if (!current || !latest) continue;
      const behind = semver.major(latest) - semver.major(current);
      if (behind < 1) continue;

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
          latest: packument.latest,
          majorsBehind: behind,
        },
        explain: `upgrade ${dep.name} from ${dep.installedVersion} toward ${packument.latest} (${behind} major version(s) behind)`,
      });
    }
  }
  return findings;
}

export function explain() {
  return 'A dependency several majors behind latest no longer receives the '
       + 'newest security fixes and is more likely to be unmaintained — '
       + 'unmaintained packages are prime targets for account takeover and '
       + 'malicious republishing.';
}
