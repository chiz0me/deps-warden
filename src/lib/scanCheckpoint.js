/** Durable, derived-result checkpoints for interrupted organization scans. */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CHECKPOINT_SCHEMA = 'deps-warden-github-checkpoint/v2';

export function createScanFingerprint(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 24);
}

export function createScanCheckpoint({
  cwd,
  organization,
  fingerprint,
  directory = '.deps-warden-cache/github-org/checkpoints',
  enabled = true,
  ttlMs = 6 * 60 * 60 * 1_000,
  now = () => Date.now(),
}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 7 * 24 * 60 * 60 * 1_000) {
    throw new Error('checkpoint ttlMs must be between one minute and seven days');
  }
  const root = resolve(cwd, directory);
  const path = resolve(root, `${organization.toLowerCase()}-${fingerprint}.json`);
  let repositories = {};
  let writeGate = Promise.resolve();
  let createdAt = new Date(now()).toISOString();

  async function load() {
    if (!enabled) return new Map();
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (value?.schema !== CHECKPOINT_SCHEMA || value.fingerprint !== fingerprint) return new Map();
      if (!Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now()) {
        await rm(path, { force: true });
        return new Map();
      }
      if (!isPlainObject(value.repositories)) return new Map();
      repositories = value.repositories;
      createdAt = value.createdAt;
      return new Map(Object.entries(repositories));
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return new Map();
      throw error;
    }
  }

  async function record(repository) {
    if (!enabled) return;
    writeGate = writeGate.then(async () => {
      repositories = { ...repositories, [repository.name]: repository };
      await persist();
    });
    await writeGate;
  }

  async function clear() {
    if (!enabled) return;
    await writeGate;
    await rm(path, { force: true });
  }

  async function persist() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    const payload = {
      schema: CHECKPOINT_SCHEMA,
      fingerprint,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
      repositories,
    };
    try {
      await writeFile(temporary, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  return { load, record, clear, path };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).toSorted().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export { CHECKPOINT_SCHEMA as SCAN_CHECKPOINT_SCHEMA };
