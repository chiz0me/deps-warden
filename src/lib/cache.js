/**
 * On-disk cache for registry responses.
 *
 * Keyed by sha1 of the request URL. TTL stored in the cache entry. Files live
 * in `.deps-warden-cache/` inside the working directory.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * @typedef {object} CacheEntry
 * @property {number} savedAt   - ms epoch
 * @property {number} ttlMs
 * @property {unknown} value
 */

export function cacheDir(cwd = process.cwd()) {
  return resolve(cwd, '.deps-warden-cache');
}

function digest(key) {
  return createHash('sha1').update(key).digest('hex');
}

/**
 * @param {object} opts
 * @param {string} opts.key
 * @param {number} [opts.ttlMs]     - default 1h
 * @param {string} [opts.cwd]
 * @returns {Promise<unknown|undefined>}
 */
export async function readCache({ key, ttlMs = 3600 * 1000, cwd = process.cwd() }) {
  const path = join(cacheDir(cwd), `${digest(key)}.json`);
  try {
    const raw = await readFile(path, 'utf8');
    /** @type {CacheEntry} */
    const entry = JSON.parse(raw);
    if (Date.now() - entry.savedAt > Math.min(entry.ttlMs, ttlMs)) return undefined;
    return entry.value;
  } catch {
    return undefined;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.key
 * @param {unknown} opts.value
 * @param {number} [opts.ttlMs]
 * @param {string} [opts.cwd]
 */
export async function writeCache({ key, value, ttlMs = 3600 * 1000, cwd = process.cwd() }) {
  const dir = cacheDir(cwd);
  await mkdir(dir, { recursive: true });
  /** @type {CacheEntry} */
  const entry = { savedAt: Date.now(), ttlMs, value };
  await writeFile(join(dir, `${digest(key)}.json`), JSON.stringify(entry), 'utf8');
}
