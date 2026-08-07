/**
 * Package manager detection.
 *
 * Resolution order:
 *   1. `packageManager` field in package.json   (authoritative)
 *   2. Lockfile precedence:
 *        pnpm-lock.yaml > bun.lock|bun.lockb > yarn.lock > npm-shrinkwrap.json > package-lock.json
 *   3. yarn classic vs berry distinguished by `.yarnrc.yml` presence or
 *      `yarnPath:` in `.yarnrc`.
 *   4. Default: npm.
 *
 * `multipleLockfiles` always lists any *extra* lockfiles found beyond the
 * chosen one so the `single-package-manager` rule can fire.
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** @typedef {'npm'|'pnpm'|'yarn-classic'|'yarn-berry'|'bun'} PmKind */

/**
 * @typedef {object} DetectedPm
 * @property {PmKind} kind
 * @property {string|null} version
 * @property {string|null} lockfile           absolute path
 * @property {string[]} multipleLockfiles     absolute paths of extra lockfiles
 * @property {'packageManager'|'lockfile'|'override'|'default'} source
 */

const LOCKFILE_FILES = ['pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'yarn.lock', 'npm-shrinkwrap.json', 'package-lock.json'];

const LOCKFILE_KINDS = {
  'pnpm-lock.yaml': 'pnpm',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'yarn.lock': 'yarn-classic', // refined to berry if .yarnrc.yml present
  'npm-shrinkwrap.json': 'npm',
  'package-lock.json': 'npm',
};

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

/**
 * @param {string} cwd
 * @param {PmKind} [override]
 * @returns {Promise<DetectedPm>}
 */
export async function detectPm(cwd, override) {
  const presentLockfiles = [];
  for (const name of LOCKFILE_FILES) {
    if (await exists(join(cwd, name))) presentLockfiles.push(name);
  }
  const lockfileByKind = pickPrimaryLockfile(presentLockfiles);
  const extras = presentLockfiles
    .filter(n => n !== lockfileByKind?.name)
    .map(n => join(cwd, n));

  if (override) {
    return {
      kind: override,
      version: null,
      lockfile: lockfileByKind ? join(cwd, lockfileByKind.name) : null,
      multipleLockfiles: extras,
      source: 'override',
    };
  }

  // 1. packageManager field
  const pkg = await readPkgJson(cwd);
  if (pkg && typeof pkg.packageManager === 'string') {
    const parsed = parsePackageManager(pkg.packageManager);
    if (parsed) {
      const kind = await refineYarnKind(cwd, parsed.kind);
      return {
        kind,
        version: parsed.version,
        lockfile: lockfileByKind ? join(cwd, lockfileByKind.name) : null,
        multipleLockfiles: extras,
        source: 'packageManager',
      };
    }
  }

  // 2. Lockfile
  if (lockfileByKind) {
    const kind = await refineYarnKind(cwd, lockfileByKind.kind);
    return {
      kind,
      version: null,
      lockfile: join(cwd, lockfileByKind.name),
      multipleLockfiles: extras,
      source: 'lockfile',
    };
  }

  // 3. Default
  return {
    kind: 'npm',
    version: null,
    lockfile: null,
    multipleLockfiles: extras,
    source: 'default',
  };
}

function pickPrimaryLockfile(names) {
  for (const name of LOCKFILE_FILES) {
    if (names.includes(name)) return { name, kind: LOCKFILE_KINDS[name] };
  }
  return null;
}

async function readPkgJson(cwd) {
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {string} value
 * @returns {{kind: PmKind, version: string|null}|null}
 */
function parsePackageManager(value) {
  const stripped = value.split('+')[0]; // drop Corepack hash suffix
  const m = stripped.match(/^([a-z-]+)(?:@(.+))?$/);
  if (!m) return null;
  const name = m[1];
  const version = m[2] ?? null;
  switch (name) {
    case 'npm': return { kind: 'npm', version };
    case 'pnpm': return { kind: 'pnpm', version };
    case 'bun': return { kind: 'bun', version };
    case 'yarn': {
      // berry if major >= 2
      const major = version ? Number.parseInt(version.split('.')[0], 10) : NaN;
      if (Number.isFinite(major) && major >= 2) return { kind: 'yarn-berry', version };
      return { kind: 'yarn-classic', version };
    }
    default: return null;
  }
}

async function refineYarnKind(cwd, kind) {
  if (kind !== 'yarn-classic' && kind !== 'yarn-berry') return kind;
  if (await exists(join(cwd, '.yarnrc.yml'))) return 'yarn-berry';
  // yarnPath in .yarnrc → berry
  try {
    const txt = await readFile(join(cwd, '.yarnrc'), 'utf8');
    if (/^\s*yarnPath\s+/m.test(txt)) return 'yarn-berry';
  } catch { /* ignore */ }
  return kind;
}
