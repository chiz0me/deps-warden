/**
 * npm adapter.
 *
 * Reads/writes `.npmrc` for all configuration keys. npm has no native
 * allowlist for lifecycle scripts; the adapter's allowlist methods return
 * an empty entry set and throw on mutation so callers can suggest LavaMoat.
 */

import { parseNpmrc, setNpmrcKey } from '../lib/npmrcParser.js';

export const kind = 'npm';

const SCALAR_KEYS = new Set([
  'ignore-scripts',
  'strict-allow-scripts',
  'dangerously-allow-all-scripts',
  'allow-git',
  'allow-remote',
  'save-exact',
  'package-lock',
  'registry',
  'min-release-age',
]);

// Abstract config keys shared with other adapters (e.g. the cross-PM
// `min-release-age` rule passes `minimumReleaseAge`) map to npm's literal
// `.npmrc` key. Literal keys passed by npm-specific rules resolve to themselves.
const ABSTRACT_TO_NPMRC = {
  minimumReleaseAge: 'min-release-age',
};

function resolveNpmrcKey(key) {
  return ABSTRACT_TO_NPMRC[key] ?? key;
}

/**
 * @param {import('../lib/context.js').Ctx} ctx
 * @param {'main'|'workspace'|'auth'} kind_
 */
export function getConfigFilePath(ctx, kind_) {
  if (kind_ === 'workspace') return null;
  return ctx.pm.configFiles[kind_] ?? null;
}

/**
 * @param {import('../lib/context.js').Ctx} ctx
 * @param {string} key
 */
export async function getConfig(ctx, key) {
  const npmrcKey = resolveNpmrcKey(key);
  if (!SCALAR_KEYS.has(npmrcKey)) return { value: undefined, source: null };
  const file = getConfigFilePath(ctx, 'main');
  if (!file) return { value: undefined, source: null };
  const src = await ctx.readText(file);
  if (src === null) return { value: undefined, source: null };
  const ast = parseNpmrc(src);
  const entry = ast.scalars.get(npmrcKey);
  if (!entry) return { value: undefined, source: null };
  return { value: parseScalar(entry.value), source: { file, line: entry.line } };
}

/**
 * @param {import('../lib/context.js').Ctx} ctx
 * @param {string} key
 * @param {unknown} value
 * @returns {Promise<import('./index.js').ProposedWrite>}
 */
export async function setConfig(ctx, key, value) {
  const npmrcKey = resolveNpmrcKey(key);
  const file = getConfigFilePath(ctx, 'main');
  if (!file) throw new Error('no .npmrc location resolved for cwd');
  const src = (await ctx.readText(file)) ?? '';
  const content = setNpmrcKey(src, npmrcKey, value);
  return { file, content, summary: `set ${npmrcKey}=${value} in .npmrc` };
}

/**
 * npm has no native allowlist; return empty + null source.
 *
 * @returns {Promise<import('./index.js').AllowlistValue>}
 */
export async function getAllowlist() {
  return { entries: [], source: null };
}

export async function addToAllowlist() {
  throw new Error('npm has no native allowlist for lifecycle scripts; use LavaMoat @lavamoat/allow-scripts');
}

export async function removeFromAllowlist() {
  throw new Error('npm has no native allowlist for lifecycle scripts');
}

/**
 * Bootstrap recommended `.npmrc` for the given profile.
 *
 * @param {import('../lib/context.js').Ctx} ctx
 * @param {'strict'|'balanced'|'loose'} profile
 * @returns {Promise<import('./index.js').ProposedWrite[]>}
 */
export async function initFiles(ctx, profile) {
  const file = getConfigFilePath(ctx, 'main');
  if (!file) return [];
  const src = (await ctx.readText(file)) ?? '';
  const desired = NPM_PROFILES[profile] ?? NPM_PROFILES.balanced;

  let content = src;
  const applied = [];
  for (const [key, value] of Object.entries(desired)) {
    const ast = parseNpmrc(content);
    if (ast.scalars.get(key)?.value === String(value)) continue;
    content = setNpmrcKey(content, key, value);
    applied.push(`${key}=${value}`);
  }
  if (applied.length === 0) return [];
  return [{
    file,
    content,
    summary: `${profile} npm profile: ${applied.join(', ')}`,
  }];
}

const NPM_PROFILES = {
  strict: {
    'ignore-scripts': true,
    'allow-git': 'none',
    'allow-remote': 'none',
    'save-exact': true,
    'package-lock': true,
    'min-release-age': 7,
  },
  balanced: {
    'strict-allow-scripts': true,
    'allow-git': 'none',
    'allow-remote': 'none',
    'save-exact': true,
    'package-lock': true,
    'min-release-age': 3,
  },
  loose:    { 'package-lock': true },
};

function parseScalar(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  if (!Number.isNaN(n) && raw.trim() !== '') return n;
  return raw;
}
