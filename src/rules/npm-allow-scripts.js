/**
 * npm install-script coverage against the native `allowScripts` policy
 * (npm 11.16+, RFC npm/rfcs#868).
 *
 * npm 11.16 reads a top-level `allowScripts` object from package.json. Keys are
 * package specs — a bare name (`"canvas"`, covers all versions), an exact pin
 * (`"canvas@1.2.3"`), or exact versions joined by `||`. Values are booleans:
 * `true` allows the install scripts, `false` denies them. A package with
 * install scripts is "not yet covered" only when NO entry matches it; both a
 * `true` and a `false` verdict count as reviewed.
 *
 * This rule flags packages that declare install scripts and have no matching
 * `allowScripts` entry — the same set npm warns about with
 * `npm approve-scripts --allow-scripts-pending`. It is the native-npm analog of
 * `pnpm-allow-builds`. It reads the lockfile's `packages` map (`hasInstallScript`
 * flags), which covers the full transitive tree and works with no node_modules
 * on disk; if the lockfile has no `packages` map it falls back to inspecting
 * installed direct deps.
 *
 * No fix: writing an allowScripts entry means trusting arbitrary install code,
 * a decision deps-warden must not make for you. The remediation is to review
 * with `npm approve-scripts` or to set `ignore-scripts=true`.
 */

import { join } from 'node:path';
import semver from 'semver';

import { enumerateDirectDepsWithScripts } from '../lib/lifecycleScripts.js';
import { parseLockfileInstallScripts } from '../lib/lockfileScripts.js';
import { detectNpmVersion } from './npm-version-supported.js';

export const id = 'npm-allow-scripts';
export const severity = 'medium';
export const description = 'Install-script dependencies lack an explicit allowScripts allow/deny decision.';

export function appliesTo(ctx) {
  return ctx.pm.kind === 'npm' && ctx.pkg !== null && ctx.pkg.raw !== null;
}

export async function check(ctx) {
  // If scripts are globally disabled, allowScripts coverage is moot — nothing
  // runs regardless. npm-ignore-scripts owns that recommendation.
  const ignore = await ctx.pm.adapter.getConfig(ctx, 'ignore-scripts');
  if (ignore.value === true || ignore.value === 'true') return [];

  const rawPolicy = ctx.pkg.raw.allowScripts;
  const invalid = invalidAllowScriptsEntries(rawPolicy);
  const findings = [];
  if (invalid.length > 0) {
    findings.push({
      severity: 'high',
      file: join(ctx.cwd, 'package.json'),
      line: 0,
      fields: {
        type: id,
        sev: 'high',
        invalid: invalid.join(','),
        enforcement: 'invalid-policy',
      },
      explain: 'allowScripts must be an object whose package-spec keys map only to true or false; correct the policy before relying on it for script enforcement',
    });
  }

  const policy = readAllowScripts(ctx.pkg.raw);
  const { packages, source } = await collectScriptPackages(ctx);
  if (packages.length === 0) return findings;

  const uncovered = packages.filter(p => !isCovered(policy, p.name, p.version));
  if (uncovered.length === 0) return findings;

  const strict = await ctx.pm.adapter.getConfig(ctx, 'strict-allow-scripts');
  const detected = detectNpmVersion(ctx);
  const blockedByDefault = strict.value === true
    || (detected && semver.gte(detected.version, '12.0.0'));
  const findingSeverity = blockedByDefault ? 'low' : severity;

  const labels = [...new Set(uncovered.map(p => (p.version ? `${p.name}@${p.version}` : p.name)))];
  findings.push({
    severity: findingSeverity,
    file: join(ctx.cwd, 'package.json'),
    line: 0,
    fields: {
      type: id,
      sev: findingSeverity,
      count: labels.length,
      transitive: uncovered.filter(p => p.transitive).length,
      source,
      packages: labels.join(','),
      enforcement: blockedByDefault ? 'blocked' : 'warning-only',
    },
    explain: blockedByDefault
      ? 'these scripts are blocked; review with `npm approve-scripts --allow-scripts-pending`, explicitly approve only trusted packages, deny the rest, and commit package.json'
      : 'these scripts still run after a warning; review with `npm approve-scripts --allow-scripts-pending`, approve/deny each package, and set strict-allow-scripts=true or ignore-scripts=true',
  });
  return findings;
}

/**
 * Prefer the lockfile (full transitive tree, no install needed); fall back to
 * inspecting installed direct deps when the lockfile has no `packages` map.
 *
 * @param {import('../lib/context.js').Ctx} ctx
 * @returns {Promise<{packages: Array<{name: string, version: string|null, transitive: boolean}>, source: 'lockfile'|'node_modules'}>}
 */
async function collectScriptPackages(ctx) {
  if (ctx.pm.lockfile) {
    const src = await ctx.readText(ctx.pm.lockfile);
    const fromLock = src ? parseLockfileInstallScripts(src) : null;
    if (fromLock) return { packages: fromLock, source: 'lockfile' };
  }
  const deps = await enumerateDirectDepsWithScripts(ctx);
  const packages = deps
    .filter(d => d.installed && d.hasScripts)
    .map(d => ({ name: d.name, version: d.version, transitive: false }));
  return { packages, source: 'node_modules' };
}

/**
 * @param {object|null} raw   parsed package.json
 * @returns {Record<string, boolean>|null}
 */
export function readAllowScripts(raw) {
  const value = raw?.allowScripts;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([, decision]) => typeof decision === 'boolean'));
}

function invalidAllowScriptsEntries(value) {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['allowScripts'];
  return Object.entries(value)
    .filter(([, decision]) => typeof decision !== 'boolean')
    .map(([key]) => key);
}

/**
 * Split an allowScripts key into its package name and the set of exact versions
 * it pins. A name-only key (bare name, or `name@*`) returns versions=null,
 * meaning it covers every version.
 *
 * @param {string} key
 * @returns {{name: string, versions: string[]|null}}
 */
export function splitSpec(key) {
  const at = key.lastIndexOf('@');
  // at <= 0 covers unscoped name-only (`pkg`, at=-1) and scoped name-only
  // (`@scope/pkg`, at=0).
  if (at <= 0) return { name: key, versions: null };
  const name = key.slice(0, at);
  const spec = key.slice(at + 1).trim();
  if (spec === '' || spec === '*') return { name, versions: null };
  return { name, versions: spec.split('||').map(s => s.trim()).filter(Boolean) };
}

/**
 * Whether a dep is covered (reviewed) by the policy — by a name-only entry, or
 * by a pin matching its installed version. Both true and false verdicts count
 * as reviewed, matching npm's "not yet covered" semantics.
 *
 * @param {Record<string, boolean>|null} policy
 * @param {string} name
 * @param {string|null} version
 * @returns {boolean}
 */
export function isCovered(policy, name, version) {
  if (!policy) return false;
  for (const key of Object.keys(policy)) {
    const spec = splitSpec(key);
    if (spec.name !== name) continue;
    if (spec.versions === null) return true;
    if (version && spec.versions.includes(version)) return true;
  }
  return false;
}

export function explain() {
  return 'npm 11.16 exposes unreviewed dependency scripts but remains warning-only '
       + 'unless strict-allow-scripts=true. npm v12 blocks those scripts by '
       + 'default. Curate and commit allowScripts with npm approve-scripts / '
       + 'npm deny-scripts; never auto-approve executable dependency code.';
}
