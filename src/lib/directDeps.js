/**
 * Enumerate a workspace's direct dependencies with their installed versions.
 *
 * Reads each direct dep's `node_modules/<pkg>/package.json` (workspace first,
 * then hoisted root) to recover the exact installed version. Deps that are not
 * installed produce a record with `installed: false` and a null version; the
 * version rules skip those because they cannot resolve a concrete version to
 * check against the registry.
 */

import { join } from 'node:path';

const DEP_SECTIONS = ['dependencies', 'optionalDependencies'];

/**
 * @typedef {object} DirectDep
 * @property {string} name
 * @property {string} declaredIn          dependency section
 * @property {string|null} range          the declared semver range
 * @property {boolean} installed
 * @property {string|null} installedVersion
 */

/**
 * @param {import('./context.js').Ctx} ctx
 * @param {{path: string, pkg: object|null}} [workspace]   defaults to ctx root
 * @returns {Promise<DirectDep[]>}
 */
export async function enumerateDirectDeps(ctx, workspace) {
  const ws = workspace ?? { path: ctx.cwd, pkg: ctx.pkg };
  if (!ws.pkg || !ws.pkg.raw) return [];

  const seen = new Set();
  /** @type {DirectDep[]} */
  const out = [];
  for (const section of DEP_SECTIONS) {
    const deps = ws.pkg.raw[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, declared] of Object.entries(deps)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const installedVersion = await readInstalledVersion(ctx, ws.path, name);
      out.push({
        name,
        declaredIn: section,
        range: typeof declared === 'string' ? declared : null,
        installed: installedVersion !== null,
        installedVersion,
      });
    }
  }
  return out;
}

/**
 * @param {import('./context.js').Ctx} ctx
 * @param {string} wsPath
 * @param {string} name
 * @returns {Promise<string|null>}
 */
async function readInstalledVersion(ctx, wsPath, name) {
  const candidates = [
    join(wsPath, 'node_modules', name, 'package.json'),
    join(ctx.cwd, 'node_modules', name, 'package.json'),
  ];
  for (const path of candidates) {
    const src = await ctx.readText(path);
    if (src === null) continue;
    try {
      const parsed = JSON.parse(src);
      if (typeof parsed.version === 'string') return parsed.version;
    } catch {
      continue;
    }
  }
  return null;
}
