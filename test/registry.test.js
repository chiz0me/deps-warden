import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRegistryClient, encodePackageName } from '../src/lib/registry.js';

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

const PACKUMENT = {
  name: 'left-pad',
  'dist-tags': { latest: '2.0.0' },
  versions: {
    '1.0.0': {},
    '2.0.0': { deprecated: 'use String.prototype.padStart' },
  },
  time: { '1.0.0': '2016-01-01T00:00:00.000Z', '2.0.0': '2018-01-01T00:00:00.000Z' },
};

describe('encodePackageName', () => {
  it('leaves unscoped names URL-safe', () => {
    expect(encodePackageName('left-pad')).toBe('left-pad');
  });
  it('encodes the slash in scoped names but keeps the leading @', () => {
    expect(encodePackageName('@scope/pkg')).toBe('@scope%2Fpkg');
  });
});

describe('createRegistryClient.fetchPackument', () => {
  let cwd;
  beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'dw-reg-')); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it('fetches, slims, and caches a packument', async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return jsonResponse(PACKUMENT); };
    const client = createRegistryClient({ cwd, fetchImpl });

    const first = await client.fetchPackument('left-pad');
    expect(first.ok).toBe(true);
    expect(first.fromCache).toBe(false);
    expect(first.packument.latest).toBe('2.0.0');
    expect(first.packument.versions['2.0.0'].deprecated).toMatch(/padStart/);
    expect(first.packument.time['1.0.0']).toBe('2016-01-01T00:00:00.000Z');

    const second = await client.fetchPackument('left-pad');
    expect(second.ok).toBe(true);
    expect(second.fromCache).toBe(true);
    expect(calls.length).toBe(1); // network hit only once
  });

  it('soft-fails on a thrown network error', async () => {
    const fetchImpl = async () => { throw new Error('ENOTFOUND'); };
    const client = createRegistryClient({ cwd, fetchImpl });
    const r = await client.fetchPackument('left-pad');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ENOTFOUND/);
  });

  it('soft-fails on a timeout', async () => {
    const fetchImpl = async () => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    };
    const client = createRegistryClient({ cwd, fetchImpl, timeoutMs: 10 });
    const r = await client.fetchPackument('left-pad');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/);
  });

  it('soft-fails on a non-2xx response', async () => {
    const fetchImpl = async () => jsonResponse({}, false, 404);
    const client = createRegistryClient({ cwd, fetchImpl });
    const r = await client.fetchPackument('missing-pkg');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('HTTP 404');
  });

  it('soft-fails on a malformed body', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } });
    const client = createRegistryClient({ cwd, fetchImpl });
    const r = await client.fetchPackument('left-pad');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid JSON/);
  });
});
