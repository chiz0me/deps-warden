/**
 * pnpm adapter.
 *
 * pnpm-specific settings live in `pnpm-workspace.yaml`. Current pnpm only
 * reads authentication and registry settings from `.npmrc`, so security
 * controls must never be written there where pnpm would silently ignore them.
 *
 * Logical keys handled:
 *   - allowBuilds          (pnpm 10.26+, matcher -> boolean map)
 *   - onlyBuiltDependencies (legacy array; removed in pnpm 11)
 *   - strictDepBuilds      (boolean)
 *   - dangerouslyAllowAllBuilds (boolean)
 *   - minimumReleaseAge    (integer minutes)
 *   - minimumReleaseAgeStrict / minimumReleaseAgeIgnoreMissingTime
 *   - saveExact            (boolean)
 *   - registry             (.npmrc only)
 */

import { parseNpmrc, setNpmrcKey } from '../lib/npmrcParser.js';
import { parseYaml, getYamlValue, setYamlKey } from '../lib/yamlParser.js';

export const kind = 'pnpm';

/**
 * @typedef {object} KeyMap
 * @property {string[]} [yamlPath]
 * @property {string} [npmrcKey]
 * @property {'scalar'|'array'|'map'} type
 */

/** @type {Record<string, KeyMap>} */
const KEYS = {
  allowBuilds:               { yamlPath: ['allowBuilds'], type: 'map' },
  onlyBuiltDependencies:     { yamlPath: ['onlyBuiltDependencies'], type: 'array' },
  ignoredBuiltDependencies:  { yamlPath: ['ignoredBuiltDependencies'], type: 'array' },
  strictDepBuilds:           { yamlPath: ['strictDepBuilds'], type: 'scalar' },
  dangerouslyAllowAllBuilds: { yamlPath: ['dangerouslyAllowAllBuilds'], type: 'scalar' },
  minimumReleaseAge:         { yamlPath: ['minimumReleaseAge'], type: 'scalar' },
  minimumReleaseAgeStrict:   { yamlPath: ['minimumReleaseAgeStrict'], type: 'scalar' },
  minimumReleaseAgeIgnoreMissingTime: { yamlPath: ['minimumReleaseAgeIgnoreMissingTime'], type: 'scalar' },
  trustPolicy:               { yamlPath: ['trustPolicy'], type: 'scalar' },
  blockExoticSubdeps:        { yamlPath: ['blockExoticSubdeps'], type: 'scalar' },
  trustLockfile:             { yamlPath: ['trustLockfile'], type: 'scalar' },
  ignorePnpmfile:            { yamlPath: ['ignorePnpmfile'], type: 'scalar' },
  saveExact:                 { yamlPath: ['saveExact'], type: 'scalar' },
  'ignore-scripts':          { npmrcKey: 'ignore-scripts', type: 'scalar' },
  registry:                  { yamlPath: ['registries', 'default'], npmrcKey: 'registry', type: 'scalar' },
};

export function getConfigFilePath(ctx, kind_) {
  if (kind_ === 'main') return ctx.pm.configFiles.main ?? null;
  if (kind_ === 'workspace') return ctx.pm.configFiles.workspace ?? null;
  if (kind_ === 'auth') return ctx.pm.configFiles.auth ?? null;
  return null;
}

/**
 * @param {import('../lib/context.js').Ctx} ctx
 * @param {string} key
 */
export async function getConfig(ctx, key) {
  const map = KEYS[key];
  if (!map) return { value: undefined, source: null };

  if (map.yamlPath) {
    const wsPath = getConfigFilePath(ctx, 'workspace');
    if (wsPath) {
      const wsSrc = await ctx.readText(wsPath);
      if (wsSrc) {
        try {
          const doc = parseYaml(wsSrc);
          const hit = getYamlValue(doc, map.yamlPath);
          if (hit !== null) return { value: hit.value, source: { file: wsPath, line: hit.line } };
        } catch { /* ignore parse error */ }
      }
    }
  }

  const npmrcPath = getConfigFilePath(ctx, 'main');
  if (npmrcPath) {
    const src = await ctx.readText(npmrcPath);
    if (src) {
      const ast = parseNpmrc(src);
      if (map.type === 'scalar' && map.npmrcKey) {
        const entry = ast.scalars.get(map.npmrcKey);
        if (entry) return { value: parseScalar(entry.value), source: { file: npmrcPath, line: entry.line } };
      }
    }
  }

  return { value: undefined, source: null };
}

/**
 * @param {import('../lib/context.js').Ctx} ctx
 * @param {string} key
 * @param {unknown} value
 * @returns {Promise<import('./index.js').ProposedWrite>}
 */
export async function setConfig(ctx, key, value) {
  const map = KEYS[key];
  if (!map) throw new Error(`unknown pnpm config key: ${key}`);

  if (map.yamlPath) {
    const wsPath = getConfigFilePath(ctx, 'workspace');
    if (wsPath) {
      const wsSrc = (await ctx.readText(wsPath)) ?? '';
      const content = setYamlKey(wsSrc, map.yamlPath, value);
      return { file: wsPath, content, summary: `set ${key} in pnpm-workspace.yaml` };
    }
  }

  const npmrcPath = getConfigFilePath(ctx, 'main');
  if (!npmrcPath) throw new Error('no .npmrc location resolved for cwd');
  const src = (await ctx.readText(npmrcPath)) ?? '';
  if (map.npmrcKey) {
    return {
      file: npmrcPath,
      content: setNpmrcKey(src, map.npmrcKey, value),
      summary: `set ${map.npmrcKey}=${value} in .npmrc`,
    };
  }
  throw new Error(`no writable location for pnpm config key: ${key}`);
}

/**
 * pnpm's current allowlist is the `allowBuilds` decision map. Only entries
 * explicitly set to true grant execution. The legacy array is still read so
 * old projects can be diagnosed and migrated, but new writes always use the
 * current map.
 *
 * @param {import('../lib/context.js').Ctx} ctx
 * @returns {Promise<import('./index.js').AllowlistValue>}
 */
export async function getAllowlist(ctx) {
  const current = await getConfig(ctx, 'allowBuilds');
  if (current.source !== null && isPlainObject(current.value)) {
    const entries = Object.entries(current.value)
      .filter(([, decision]) => decision === true)
      .map(([matcher]) => matcher);
    return { entries, source: { file: current.source.file, key: 'allowBuilds' } };
  }
  const legacy = await getConfig(ctx, 'onlyBuiltDependencies');
  if (legacy.source !== null && Array.isArray(legacy.value)) {
    return { entries: legacy.value.map(String), source: { file: legacy.source.file, key: 'onlyBuiltDependencies' } };
  }
  return { entries: [], source: null };
}

/**
 * @param {import('../lib/context.js').Ctx} ctx
 * @param {string[]} pkgs
 */
export async function addToAllowlist(ctx, pkgs) {
  const current = await getConfig(ctx, 'allowBuilds');
  const decisions = isPlainObject(current.value) ? { ...current.value } : {};
  for (const pkg of pkgs) decisions[pkg] = true;
  return setConfig(ctx, 'allowBuilds', decisions);
}

/**
 * @param {import('../lib/context.js').Ctx} ctx
 * @param {string[]} pkgs
 */
export async function removeFromAllowlist(ctx, pkgs) {
  const current = await getConfig(ctx, 'allowBuilds');
  const decisions = isPlainObject(current.value) ? { ...current.value } : {};
  for (const pkg of pkgs) delete decisions[pkg];
  return setConfig(ctx, 'allowBuilds', decisions);
}

/**
 * Bootstrap recommended pnpm-workspace.yaml + .npmrc for the given profile.
 *
 * @param {import('../lib/context.js').Ctx} ctx
 * @param {'strict'|'balanced'|'loose'} profile
 * @returns {Promise<import('./index.js').ProposedWrite[]>}
 */
export async function initFiles(ctx, profile) {
  const wsFile = getConfigFilePath(ctx, 'workspace');
  const npmrcFile = getConfigFilePath(ctx, 'main');
  const wsDesired = PNPM_WS_PROFILES[profile] ?? PNPM_WS_PROFILES.balanced;
  const npmrcDesired = PNPM_NPMRC_PROFILES[profile] ?? PNPM_NPMRC_PROFILES.balanced;

  const proposals = [];

  if (wsFile && Object.keys(wsDesired).length > 0) {
    const src = (await ctx.readText(wsFile)) ?? '';
    let content = src;
    const applied = [];
    for (const [key, value] of Object.entries(wsDesired)) {
      const next = setYamlKey(content, [key], value);
      if (next !== content) {
        content = next;
        applied.push(key);
      }
    }
    if (applied.length > 0) {
      proposals.push({
        file: wsFile,
        content,
        summary: `${profile} pnpm profile: ${applied.join(', ')}`,
      });
    }
  }

  if (npmrcFile && Object.keys(npmrcDesired).length > 0) {
    const src = (await ctx.readText(npmrcFile)) ?? '';
    let content = src;
    const applied = [];
    for (const [key, value] of Object.entries(npmrcDesired)) {
      const ast = parseNpmrc(content);
      if (ast.scalars.get(key)?.value === String(value)) continue;
      content = setNpmrcKey(content, key, value);
      applied.push(`${key}=${value}`);
    }
    if (applied.length > 0) {
      proposals.push({
        file: npmrcFile,
        content,
        summary: `${profile} pnpm .npmrc: ${applied.join(', ')}`,
      });
    }
  }

  return proposals;
}

const PNPM_WS_PROFILES = {
  strict: {
    allowBuilds: {},
    strictDepBuilds: true,
    dangerouslyAllowAllBuilds: false,
    minimumReleaseAge: 10080,
    minimumReleaseAgeStrict: true,
    minimumReleaseAgeIgnoreMissingTime: false,
    trustPolicy: 'no-downgrade',
    blockExoticSubdeps: true,
    trustLockfile: false,
    saveExact: true,
  },
  balanced: {
    allowBuilds: {},
    strictDepBuilds: true,
    dangerouslyAllowAllBuilds: false,
    trustLockfile: false,
    saveExact: true,
  },
  loose:    {},
};

const PNPM_NPMRC_PROFILES = {
  strict:   {},
  balanced: {},
  loose:    {},
};

function parseScalar(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  if (!Number.isNaN(n) && raw.trim() !== '') return n;
  return raw;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
