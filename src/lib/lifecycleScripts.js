/**
 * Enumerate direct dependencies' lifecycle scripts.
 *
 * Reads each direct dep's `node_modules/<pkg>/package.json` and reports which
 * of the relevant lifecycle scripts (preinstall, install, postinstall, prepare)
 * it declares. Direct deps that are not yet installed produce a record with
 * `installed: false` so callers can flag the gap.
 */

import { join } from 'node:path';

const LIFECYCLE_KEYS = ['preinstall', 'install', 'postinstall', 'prepare'];
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/**
 * @typedef {object} DepScripts
 * @property {string} name
 * @property {string|null} version
 * @property {string} declaredIn          'dependencies' | 'devDependencies' | 'optionalDependencies'
 * @property {boolean} installed          whether node_modules/<pkg>/package.json was found
 * @property {string[]} scripts           lifecycle script names that fire on install
 * @property {boolean} hasScripts         scripts.length > 0
 */

/**
 * @param {import('./context.js').Ctx} ctx
 * @param {{path: string, pkg: object|null}} [workspace]   defaults to ctx root
 * @returns {Promise<DepScripts[]>}
 */
export async function enumerateDirectDepsWithScripts(ctx, workspace) {
  const ws = workspace ?? { path: ctx.cwd, pkg: ctx.pkg };
  if (!ws.pkg || !ws.pkg.raw) return [];
  const seen = new Set();
  /** @type {DepScripts[]} */
  const out = [];
  for (const section of DEP_SECTIONS) {
    const deps = ws.pkg.raw[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, declared] of Object.entries(deps)) {
      if (seen.has(name)) continue;
      seen.add(name);
      // Look up node_modules at workspace first, then root (hoist).
      const candidates = [
        join(ws.path, 'node_modules', name, 'package.json'),
        join(ctx.cwd, 'node_modules', name, 'package.json'),
      ];
      let src = null;
      for (const path of candidates) {
        src = await ctx.readText(path);
        if (src !== null) break;
      }
      if (src === null) {
        out.push({
          name,
          version: typeof declared === 'string' ? declared : null,
          declaredIn: section,
          installed: false,
          scripts: [],
          hasScripts: false,
        });
        continue;
      }
      let parsed;
      try { parsed = JSON.parse(src); } catch { continue; }
      const scripts = parsed.scripts && typeof parsed.scripts === 'object'
        ? LIFECYCLE_KEYS.filter(k => typeof parsed.scripts[k] === 'string' && parsed.scripts[k].trim() !== '')
        : [];
      out.push({
        name,
        version: typeof parsed.version === 'string' ? parsed.version : null,
        declaredIn: section,
        installed: true,
        scripts,
        hasScripts: scripts.length > 0,
      });
    }
  }
  return out;
}
