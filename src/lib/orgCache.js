/**
 * Small on-disk cache for organization scans.
 *
 * Only derived check results are cached. Repository contents and credentials
 * are never persisted. GitHub-side controls are intentionally not cached
 * because they can change without a Git commit.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CACHE_SCHEMA = 'deps-warden-github-code-cache/v2';

export function createOrgCache({ cwd, directory = '.deps-warden-cache/github-org', enabled = true }) {
  const root = resolve(cwd, directory);

  async function read(organization, repository, treeSha) {
    if (!enabled) return null;
    try {
      const value = JSON.parse(await readFile(cachePath(root, organization, repository), 'utf8'));
      if (value?.schema !== CACHE_SCHEMA || value.treeSha !== treeSha || !Array.isArray(value.checks)) return null;
      return value.checks;
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async function write(organization, repository, treeSha, checks) {
    if (!enabled) return;
    const destination = cachePath(root, organization, repository);
    await mkdir(resolve(root, organization), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    const value = {
      schema: CACHE_SCHEMA,
      treeSha,
      storedAt: new Date().toISOString(),
      checks,
    };
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  return { read, write, root };
}

function cachePath(root, organization, repository) {
  assertSegment(organization, 'organization');
  assertSegment(repository, 'repository');
  return resolve(root, organization, `${repository}.json`);
}

function assertSegment(value, label) {
  const pattern = label === 'organization'
    ? /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/
    : /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`invalid ${label} cache key`);
  }
}

export { CACHE_SCHEMA as ORG_CACHE_SCHEMA };
