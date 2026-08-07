/**
 * Direct dependencies whose installed version was published more recently than
 * the project's minimum-release-age window.
 *
 * Network rule: only runs under `--check-versions`. Where `min-release-age`
 * checks that the *policy* is configured, this rule verifies the *reality* —
 * it cross-references each installed version's registry publish time against
 * the configured window (or a 7-day default). A version younger than the
 * window is exactly what a freshly-malicious release looks like before the
 * registry or maintainer can react.
 */

import { join } from 'node:path';

import { enumerateDirectDeps } from '../lib/directDeps.js';

export const id = 'dep-below-release-age';
export const severity = 'high';
export const description = 'A direct dependency was published more recently than the minimum-release-age window.';

const DEFAULT_WINDOW_MS = 7 * 24 * 3600 * 1000;

export function appliesTo(ctx) {
  return Boolean(ctx.options?.checkVersions) && ctx.pkg !== null && ctx.pkg.raw !== null;
}

export async function check(ctx) {
  const packuments = ctx.registryData?.packuments;
  if (!packuments || packuments.size === 0) return [];

  const now = typeof ctx.options?.now === 'number' ? ctx.options.now : Date.now();
  const windowMs = await resolveWindowMs(ctx);

  const findings = [];
  for (const ws of ctx.workspaces ?? [{ path: ctx.cwd, pkg: ctx.pkg, relative: '.' }]) {
    const deps = await enumerateDirectDeps(ctx, ws);
    for (const dep of deps) {
      if (!dep.installed || dep.installedVersion === null) continue;
      const packument = packuments.get(dep.name);
      const publishedIso = packument?.time?.[dep.installedVersion];
      if (typeof publishedIso !== 'string') continue;
      const publishedAt = Date.parse(publishedIso);
      if (Number.isNaN(publishedAt)) continue;

      const ageMs = now - publishedAt;
      if (ageMs >= windowMs) continue;

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
          published: publishedIso,
          ageHours: Math.max(0, Math.floor(ageMs / 3600000)),
          windowDays: Math.round(windowMs / (24 * 3600000)),
        },
        explain: `${dep.name}@${dep.installedVersion} was published ${Math.max(0, Math.floor(ageMs / 3600000))}h ago, inside your ${Math.round(windowMs / (24 * 3600000))}-day release-age window`,
      });
    }
  }
  return findings;
}

/**
 * Resolve the release-age window from the PM's minimumReleaseAge config,
 * falling back to the 7-day default when it is unset or unparseable.
 *
 * @param {import('../lib/context.js').Ctx} ctx
 * @returns {Promise<number>}
 */
async function resolveWindowMs(ctx) {
  let configured;
  try {
    const hit = await ctx.pm.adapter.getConfig(ctx, 'minimumReleaseAge');
    configured = hit?.value;
  } catch {
    configured = undefined;
  }
  return parseDurationMs(configured, ctx.pm.kind) ?? DEFAULT_WINDOW_MS;
}

/**
 * Parse a release-age value into milliseconds. npm bare values are days;
 * pnpm bare values are minutes. Unit-suffixed strings remain accepted for
 * backwards-compatible diagnostics, but current pnpm configuration is numeric.
 *
 * @param {unknown} value
 * @param {'npm'|'pnpm'|string} [kind]
 * @returns {number|null}
 */
export function parseDurationMs(value, kind = 'pnpm') {
  if (value === undefined || value === null || value === '' || value === 0) return null;
  const bareUnitMs = kind === 'npm' ? 24 * 3600000 : 60 * 1000;
  if (typeof value === 'number') return Number.isFinite(value) ? value * bareUnitMs : null;

  const match = /^(\d+)\s*([dhms])?$/.exec(String(value).trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (!unit) return amount * bareUnitMs;
  const unitMs = { d: 24 * 3600000, h: 3600000, m: 60000, s: 1000 }[unit];
  return amount * unitMs;
}

export function explain() {
  return 'Compromised package versions are usually yanked within hours of '
       + 'disclosure. Installing a version younger than your minimum-release-'
       + 'age window means you may have pulled a release before the registry '
       + 'or maintainer had time to react to a malicious publish.';
}
