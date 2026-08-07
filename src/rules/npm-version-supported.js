/**
 * npm's supply-chain controls arrived incrementally. This rule reports the
 * exact controls missing from the detected version; 11.16.0 is the migration
 * floor and npm 12 is the current fail-closed target.
 *
 * Detection is zero-subprocess (deps-warden never spawns a package manager):
 *   1. a committed `packageManager: "npm@x.y.z"` declaration; and
 *   2. `npm_config_user_agent` — the npm that launched deps-warden when it is
 *      run via `npx` / `npm` (overridable via ctx.options.npmUserAgent).
 * When both are known, the lower version wins so neither an outdated declared
 * toolchain nor an outdated active client is hidden by the other.
 * A committed enforced devEngines declaration is also evidence. When none is
 * available the rule reports unknown rather than claiming the project is safe.
 *
 * fix declares both advisory `engines.npm` compatibility and an enforced
 * `devEngines.packageManager` requirement. It never installs npm itself.
 */

import semver from 'semver';
import { join } from 'node:path';

import { setTopLevelKey } from '../lib/pkgJsonParser.js';

export const id = 'npm-version-supported';
export const severity = 'high';
export const description = 'The npm in use lacks one or more required supply-chain controls.';

export const MIN_NPM = '11.16.0';
export const TARGET_NPM = '12.0.0';
export const NPM_CAPABILITIES = Object.freeze([
  { name: 'allow-git', since: '11.10.0' },
  { name: 'min-release-age', since: '11.10.0' },
  { name: 'allow-remote', since: '11.15.0' },
  { name: 'allowScripts', since: '11.16.0' },
]);

export function appliesTo(ctx) {
  return ctx.pm.kind === 'npm' && ctx.pkg !== null && ctx.pkg.raw !== null;
}

export async function check(ctx) {
  const detected = detectNpmVersion(ctx);
  if (!detected) {
    return [{
      severity,
      file: join(ctx.cwd, 'package.json'),
      line: ctx.pkg.topLevelLines?.get('packageManager') ?? 0,
      fields: {
        type: id,
        sev: severity,
        detected: 'unknown',
        via: 'none',
        required: `>=${MIN_NPM}`,
        target: `>=${TARGET_NPM}`,
        affects: NPM_CAPABILITIES.map(capability => capability.name).join(','),
      },
      explain: 'declare an exact npm packageManager version or an enforced devEngines.packageManager range; deps-warden cannot prove which install controls an unknown client honors',
    }];
  }
  if (semver.gte(detected.version, TARGET_NPM)) return [];

  const belowMigrationFloor = semver.lt(detected.version, MIN_NPM);
  const missing = NPM_CAPABILITIES
    .filter(capability => semver.lt(detected.version, capability.since))
    .map(capability => capability.name);
  const findingSeverity = belowMigrationFloor ? severity : 'medium';
  return [{
    severity: findingSeverity,
    file: join(ctx.cwd, 'package.json'),
    line: ctx.pkg.topLevelLines?.get('engines') ?? 0,
    fields: {
      type: id,
      sev: findingSeverity,
      detected: detected.version,
      via: detected.source,
      required: `>=${MIN_NPM}`,
      target: `>=${TARGET_NPM}`,
      state: belowMigrationFloor ? 'unsupported' : 'transitional',
      affects: missing.join(','),
    },
    explain: belowMigrationFloor
      ? `npm ${detected.version} cannot enforce: ${missing.join(', ')}. Move to a supported Node.js release, install a reviewed npm >=${MIN_NPM}, then migrate to npm 12's fail-closed defaults. The fix records the migration floor; it does not install software.`
      : `npm ${detected.version} has the migration controls but remains transitional. Keep explicit fail-closed settings, move to a Node.js release supported by npm 12, and pin a reviewed npm 12 version.`,
  }];
}

export async function fix(ctx) {
  const file = join(ctx.cwd, 'package.json');
  const src = (await ctx.readText(file)) ?? '{}';
  const engines = { ...ctx.pkg?.raw?.engines, npm: `>=${MIN_NPM}` };
  const devEngines = {
    ...ctx.pkg?.raw?.devEngines,
    packageManager: { name: 'npm', version: `>=${MIN_NPM}`, onFail: 'error' },
  };
  let content = setTopLevelKey(src, 'engines', engines);
  content = setTopLevelKey(content, 'devEngines', devEngines);
  return [{
    file,
    content,
    summary: `require npm >=${MIN_NPM} with engines and enforced devEngines in package.json`,
  }];
}

/**
 * @param {import('../lib/context.js').Ctx} ctx
 * @returns {{version: string, source: 'packageManager'|'devEngines'|'user-agent'}|null}
 */
export function detectNpmVersion(ctx) {
  const candidates = [];
  if (ctx.pm.source === 'packageManager' && ctx.pm.version) {
    const pinned = semver.coerce(ctx.pm.version);
    if (pinned) candidates.push({ version: pinned.version, source: 'packageManager' });
  }
  const devPm = ctx.pkg?.raw?.devEngines?.packageManager;
  const declared = Array.isArray(devPm) ? devPm : [devPm];
  for (const item of declared) {
    if (!item || item.name !== 'npm' || typeof item.version !== 'string' || item.onFail !== 'error') continue;
    const minimum = semver.minVersion(item.version);
    if (minimum) candidates.push({ version: minimum.version, source: 'devEngines' });
  }
  const ua = userAgentNpmVersion(ctx.options?.npmUserAgent ?? process.env.npm_config_user_agent);
  if (ua) candidates.push({ version: ua, source: 'user-agent' });
  return candidates.toSorted((a, b) => semver.compare(a.version, b.version))[0] ?? null;
}

/**
 * @param {string|undefined|null} userAgent  e.g. "npm/11.16.0 node/v20 linux x64"
 * @returns {string|null}
 */
export function userAgentNpmVersion(userAgent) {
  if (!userAgent) return null;
  const match = /(?:^|\s)npm\/(\d+\.\d+\.\d+[\w.-]*)/.exec(userAgent);
  if (!match) return null;
  const coerced = semver.coerce(match[1]);
  return coerced ? coerced.version : null;
}

export function explain() {
  return 'npm added allow-git in 11.10, allow-remote in 11.15, and the complete '
       + 'allowScripts migration workflow in 11.16. npm 12 makes scripts and '
       + 'external sources fail closed by default. Treat 11.16 as a migration '
       + 'floor, pin a reviewed npm 12 release when Node.js is compatible, and '
       + 'never silently pass when the active toolchain is unknown.';
}
