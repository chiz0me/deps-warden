/**
 * Project-level ignore file: `.deps-warden-ignore`.
 *
 * Unlike the inline `# deps-warden-ignore` directives (which live inside config
 * sources and therefore cannot touch JSON files like package.json), this is a
 * single committed file where a project records the findings it has chosen to
 * accept. gitignore-style:
 *
 *   - one entry per line; `#` starts a comment to end of line; blanks ignored
 *   - an entry is either a rule id (suppresses every finding of that rule) or a
 *     10-char finding id (suppresses that one specific finding)
 *   - entries may also be comma/space separated on a single line
 *
 * Example:
 *   # staying on npm by team decision, 2026-05
 *   recommend-stricter-pm
 *   fff769fa22            # accept the legacy workspace's missing engines field
 */

import { join } from 'node:path';

export const IGNORE_FILE = '.deps-warden-ignore';

/**
 * @typedef {object} IgnoreFile
 * @property {Set<string>} entries   rule ids and/or finding ids to suppress
 * @property {string|null} path      absolute path if the file exists
 */

/**
 * @param {string} cwd
 * @param {(path: string) => Promise<string|null>} readText
 * @returns {Promise<IgnoreFile>}
 */
export async function loadIgnoreFile(cwd, readText) {
  const path = join(cwd, IGNORE_FILE);
  const src = await readText(path);
  if (src === null) return { entries: new Set(), path: null };
  return { entries: parseIgnoreFile(src), path };
}

/**
 * @param {string} source
 * @returns {Set<string>}
 */
export function parseIgnoreFile(source) {
  const entries = new Set();
  for (const line of source.split('\n')) {
    const hashIdx = line.indexOf('#');
    const body = (hashIdx === -1 ? line : line.slice(0, hashIdx)).trim();
    if (body === '') continue;
    for (const token of body.split(/[\s,]+/)) {
      if (token) entries.add(token);
    }
  }
  return entries;
}

/**
 * Whether a finding is suppressed by the ignore file, and by which kind of
 * entry. A rule-id match wins over a finding-id match for reporting.
 *
 * @param {IgnoreFile} ignoreFile
 * @param {string} ruleId
 * @param {string} findingId
 * @returns {'rule'|'id'|null}
 */
export function ignoreFileMatch(ignoreFile, ruleId, findingId) {
  if (ignoreFile.entries.has(ruleId)) return 'rule';
  if (ignoreFile.entries.has(findingId)) return 'id';
  return null;
}
