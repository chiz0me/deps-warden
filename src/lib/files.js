/**
 * File reading helpers with memoisation via a per-context cache.
 */

import { readFile } from 'node:fs/promises';

/**
 * Read a UTF-8 file, returning null on any error (ENOENT, EACCES, etc.).
 * Memoised through the provided cache Map.
 *
 * @param {Map<string, string|null>} cache
 * @param {string} path
 * @returns {Promise<string|null>}
 */
export async function readTextCached(cache, path) {
  if (cache.has(path)) return cache.get(path);
  let value = null;
  try {
    value = await readFile(path, 'utf8');
  } catch {
    value = null;
  }
  cache.set(path, value);
  return value;
}
