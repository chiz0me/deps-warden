/**
 * Workspace discovery.
 *
 * For pnpm reads `pnpm-workspace.yaml`'s `packages:` field.
 * For npm/yarn-classic/yarn-berry/bun reads the root package.json
 * `workspaces` field (array, or `{packages: [...]}` object).
 *
 * Returns an array of WorkspaceInfo records starting with the root project,
 * then any sub-workspaces matched by patterns. Patterns are matched via
 * picomatch against directory paths found by a bounded readdir walk
 * (avoiding `node_modules`, dotted directories, and depth > 6).
 */

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import picomatch from 'picomatch';

import { parseYaml, getYamlValue } from './yamlParser.js';
import { parsePkgJson } from './pkgJsonParser.js';

/**
 * @typedef {object} WorkspaceInfo
 * @property {string} path                   absolute path
 * @property {string} relative               relative to ctx.cwd ('.' for root)
 * @property {object|null} pkg               parsed package.json (parsePkgJson shape) or null
 * @property {boolean} isRoot
 */

const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(['node_modules', '.git', '.deps-warden-cache', 'dist', 'coverage', 'build', '.next', '.cache']);

/**
 * @param {import('./context.js').Ctx} ctx
 * @returns {Promise<WorkspaceInfo[]>}
 */
export async function discoverWorkspaces(ctx) {
  const root = { path: ctx.cwd, relative: '.', pkg: ctx.pkg, isRoot: true };
  const patterns = await readWorkspacePatterns(ctx);
  if (patterns.length === 0) return [root];

  const matchers = patterns.map(p => picomatch(stripLeadingDot(p)));
  const candidates = await walkDirs(ctx.cwd, MAX_DEPTH);
  const subs = [];
  for (const dir of candidates) {
    const rel = relative(ctx.cwd, dir);
    if (rel === '') continue;
    if (!matchers.some(m => m(rel))) continue;
    const pkgSrc = await ctx.readText(join(dir, 'package.json'));
    if (!pkgSrc) continue;
    let pkg = null;
    try { pkg = parsePkgJson(pkgSrc); } catch { /* skip malformed */ }
    subs.push({ path: dir, relative: rel, pkg, isRoot: false });
  }
  return [root, ...subs];
}

async function readWorkspacePatterns(ctx) {
  if (ctx.pm.kind === 'pnpm') {
    const ws = ctx.pm.configFiles.workspace;
    if (!ws) return [];
    const src = await ctx.readText(ws);
    if (!src) return [];
    try {
      const doc = parseYaml(src);
      const hit = getYamlValue(doc, ['packages']);
      if (!hit || !Array.isArray(hit.value)) return [];
      return hit.value.filter(v => typeof v === 'string' && v !== '.');
    } catch { return []; }
  }
  // npm / yarn / bun: workspaces field in package.json
  if (!ctx.pkg || !ctx.pkg.raw) return [];
  const ws = ctx.pkg.raw.workspaces;
  if (!ws) return [];
  if (Array.isArray(ws)) return ws.filter(v => typeof v === 'string');
  if (typeof ws === 'object' && Array.isArray(ws.packages)) {
    return ws.packages.filter(v => typeof v === 'string');
  }
  return [];
}

function stripLeadingDot(pattern) {
  if (pattern.startsWith('./')) return pattern.slice(2);
  return pattern;
}

async function walkDirs(root, maxDepth) {
  const out = [];
  await walk(root, root, 0, maxDepth, out);
  return out;
}

async function walk(root, dir, depth, maxDepth, out) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (SKIP_DIRS.has(name)) continue;
    if (name.startsWith('.') && name !== '.') continue;
    const full = join(dir, name);
    out.push(full);
    await walk(root, full, depth + 1, maxDepth, out);
  }
}
