import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createScanCheckpoint, createScanFingerprint } from '../src/lib/scanCheckpoint.js';

describe('organization scan checkpoints', () => {
  let cwd;
  beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'deps-checkpoint-')); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it('persists derived repository results and reloads the same scan fingerprint', async () => {
    const fingerprint = createScanFingerprint({ organization: 'example', repositories: ['one'] });
    const first = createScanCheckpoint({ cwd, organization: 'example', fingerprint });
    await first.record({ name: 'one', checks: [{ id: 'x', status: 'pass' }] });

    const second = createScanCheckpoint({ cwd, organization: 'example', fingerprint });
    expect(await second.load()).toEqual(new Map([
      ['one', { name: 'one', checks: [{ id: 'x', status: 'pass' }] }],
    ]));
    await second.clear();
    expect(await second.load()).toEqual(new Map());
  });

  it('rejects expired checkpoints', async () => {
    let now = 1_800_000_000_000;
    const checkpoint = createScanCheckpoint({
      cwd,
      organization: 'example',
      fingerprint: 'fingerprint',
      ttlMs: 60_000,
      now: () => now,
    });
    await checkpoint.record({ name: 'one', checks: [] });
    now += 60_001;
    expect(await checkpoint.load()).toEqual(new Map());
  });
});
