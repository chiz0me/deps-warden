/**
 * Build a read-only context object for rule execution.
 *
 * The context carries the detected package manager, the parsed `package.json`,
 * the set of git-tracked paths, and a memoised file cache. Rules read from
 * the context; only commands invoke `writeFileGuarded`.
 */

import { join, resolve } from 'node:path';
import { detectPm } from './detect.js';
import { parseGitIndex } from './gitTracked.js';
import { readTextCached } from './files.js';
import { selectAdapter } from '../adapters/index.js';
import { parsePkgJson } from './pkgJsonParser.js';
import { discoverWorkspaces } from './workspaces.js';

/**
 * @typedef {object} ConfigFilePaths
 * @property {string|null} main           e.g. .npmrc | .yarnrc.yml | bunfig.toml
 * @property {string|null} workspace      pnpm-workspace.yaml when applicable
 * @property {string|null} auth           usually .npmrc
 *
 * @typedef {object} PmInfo
 * @property {import('./detect.js').PmKind} kind
 * @property {string|null} version
 * @property {string|null} lockfile
 * @property {string[]} multipleLockfiles
 * @property {'packageManager'|'lockfile'|'override'|'default'} source
 * @property {ConfigFilePaths} configFiles
 * @property {import('../adapters/index.js').Adapter} adapter
 *
 * @typedef {object} Ctx
 * @property {string} cwd
 * @property {PmInfo} pm
 * @property {object|null} pkg              {raw, source, lineMap, indent} or null
 * @property {Set<string>|null} gitTracked  null when .git/index absent
 * @property {Map<string, string|null>} fileCache
 * @property {(path: string) => Promise<string|null>} readText
 */

/**
 * @param {{cwd?: string, pmOverride?: import('./detect.js').PmKind, gitTrackedOverride?: Set<string>}} args
 * @returns {Promise<Ctx>}
 */
export async function buildContext({ cwd: cwdInput, pmOverride, gitTrackedOverride } = {}) {
  const cwd = resolve(cwdInput ?? process.cwd());
  const fileCache = new Map();
  const readText = (path) => readTextCached(fileCache, path);

  const detected = await detectPm(cwd, pmOverride);
  const configFiles = resolveConfigFilePaths(cwd, detected.kind);
  const adapter = selectAdapter(detected.kind);

  const pkgSrc = await readText(join(cwd, 'package.json'));
  const pkg = pkgSrc ? parsePkgJsonSafe(pkgSrc) : null;
  const gitTracked = gitTrackedOverride ?? await parseGitIndex(cwd);

  const ctx = {
    cwd,
    pm: {
      kind: detected.kind,
      version: detected.version,
      lockfile: detected.lockfile,
      multipleLockfiles: detected.multipleLockfiles,
      source: detected.source,
      configFiles,
      adapter,
    },
    pkg,
    gitTracked,
    fileCache,
    readText,
    workspaces: [{ path: cwd, relative: '.', pkg, isRoot: true }],
  };
  ctx.workspaces = await discoverWorkspaces(ctx);
  return ctx;
}

function parsePkgJsonSafe(src) {
  try { return parsePkgJson(src); } catch { return null; }
}

function resolveConfigFilePaths(cwd, kind) {
  switch (kind) {
    case 'npm':
      return { main: join(cwd, '.npmrc'), workspace: null, auth: join(cwd, '.npmrc') };
    case 'pnpm':
      return {
        main: join(cwd, '.npmrc'),
        workspace: join(cwd, 'pnpm-workspace.yaml'),
        auth: join(cwd, '.npmrc'),
      };
    case 'yarn-classic':
      return { main: join(cwd, '.yarnrc'), workspace: null, auth: join(cwd, '.npmrc') };
    case 'yarn-berry':
      return { main: join(cwd, '.yarnrc.yml'), workspace: null, auth: join(cwd, '.yarnrc.yml') };
    case 'bun':
      return { main: join(cwd, 'bunfig.toml'), workspace: null, auth: join(cwd, 'bunfig.toml') };
    default:
      return { main: null, workspace: null, auth: null };
  }
}
