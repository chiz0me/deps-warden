/**
 * Extract packages with install scripts from an npm lockfile.
 *
 * npm's package-lock.json / npm-shrinkwrap.json (lockfileVersion 2 and 3)
 * records `hasInstallScript: true` on every entry in the `packages` map whose
 * manifest declares preinstall/install/postinstall — npm sets it so it knows
 * what to run without re-reading each manifest. Walking that map yields the
 * full transitive set of install-script packages with no node_modules on disk.
 * lockfileVersion 1 has no `packages` map and returns null (caller falls back).
 */

const NM = 'node_modules/';

/**
 * @typedef {object} ScriptPackage
 * @property {string} name
 * @property {string|null} version
 * @property {string} path        the node_modules path key from the lockfile
 * @property {boolean} transitive false for a top-level dep, true if nested
 */

/**
 * @param {string} lockSource   raw package-lock.json / npm-shrinkwrap.json
 * @returns {ScriptPackage[]|null}   null when the lockfile has no `packages` map
 */
export function parseLockfileInstallScripts(lockSource) {
  let lock;
  try { lock = JSON.parse(lockSource); } catch { return null; }
  const packages = lock?.packages;
  if (!packages || typeof packages !== 'object') return null;

  const out = [];
  for (const [path, meta] of Object.entries(packages)) {
    if (path === '' || !meta || typeof meta !== 'object') continue; // root project
    if (meta.link) continue;                                        // workspace symlink
    if (!meta.hasInstallScript) continue;
    const name = typeof meta.name === 'string' ? meta.name : nameFromPath(path);
    if (!name) continue;
    out.push({
      name,
      version: typeof meta.version === 'string' ? meta.version : null,
      path,
      transitive: occurrences(path, NM) > 1,
    });
  }
  return out;
}

function nameFromPath(path) {
  const idx = path.lastIndexOf(NM);
  if (idx === -1) return null;
  return path.slice(idx + NM.length) || null;
}

function occurrences(haystack, needle) {
  let count = 0;
  let i = 0;
  for (;;) {
    const found = haystack.indexOf(needle, i);
    if (found === -1) break;
    count += 1;
    i = found + needle.length;
  }
  return count;
}
