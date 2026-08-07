/**
 * Safe file writer with dry-run guard.
 *
 * Every mutation flows through {@link writeFileGuarded}. When `dryRun` is true
 * (the default), no bytes are written - the change is recorded and reported.
 */

import { constants } from 'node:fs';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { sha256 } from './hash.js';

/**
 * @typedef {object} WriteResult
 * @property {string} path
 * @property {boolean} written
 * @property {boolean} dryRun
 * @property {number} bytes
 */

/**
 * @param {object} args
 * @param {string} args.path
 * @param {string} args.content
 * @param {boolean} [args.dryRun]
 * @param {string} [args.cwd]
 * @param {{exists: boolean, sha256: string|null}} [args.expected]
 * @returns {Promise<WriteResult>}
 */
export async function writeFileGuarded({ path, content, dryRun = true, cwd = process.cwd(), expected }) {
  const abs = assertSafePath(path, cwd);
  const realCwd = await realpath(resolve(cwd));

  let targetExists = true;
  try {
    const stat = await lstat(abs);
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to write through symbolic link: ${path}`);
    }
  } catch (err) {
    if (err?.code === 'ENOENT') targetExists = false;
    else throw err;
  }

  const realParent = await realpath(dirname(abs));
  assertContained(realParent, realCwd, path);
  if (targetExists) {
    const realTarget = await realpath(abs);
    assertContained(realTarget, realCwd, path);
  }

  if (expected) {
    if (expected.exists !== targetExists) {
      throw new Error(`write precondition failed for ${path}: file existence changed`);
    }
    if (targetExists) {
      const digest = sha256(await readFile(abs));
      if (digest !== expected.sha256) {
        throw new Error(`write precondition failed for ${path}: file content changed`);
      }
    }
  }

  const bytes = Buffer.byteLength(content, 'utf8');
  if (dryRun) {
    return { path: abs, written: false, dryRun: true, bytes };
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const flag = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow;
  await writeFile(abs, content, { encoding: 'utf8', flag });
  return { path: abs, written: true, dryRun: false, bytes };
}

/**
 * Throws on path traversal attempts.
 *
 * @param {string} path
 * @param {string} [cwd]
 * @returns {string} absolute path
 */
export function assertSafePath(path, cwd = process.cwd()) {
  if (typeof path !== 'string' || path.includes('\0')) {
    throw new Error('invalid path');
  }
  const root = resolve(cwd);
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`refusing to write outside working directory: ${path}`);
  }
  return abs;
}

function assertContained(candidate, root, originalPath) {
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`refusing to write outside working directory: ${originalPath}`);
  }
}
