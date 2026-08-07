import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOrgReport } from '../src/lib/orgReport.js';
import { createScanJobManager } from '../src/lib/scanJobs.js';

describe('asynchronous scan jobs', () => {
  let cwd;
  beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'deps-scan-jobs-')); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it('starts immediately, records progress, persists the report, and pages it', async () => {
    const manager = createScanJobManager({
      cwd,
      runner: async (input, progress) => {
        await progress({ type: 'repository-complete', repository: 'service', completed: 1, total: 1 });
        return createOrgReport({
          organization: input.organization,
          repositories: [{ name: 'service', checks: [{ id: 'x', status: 'pass' }] }],
        });
      },
    });
    const started = await manager.start({ organization: 'example' });
    expect(started.status).toBe('queued');
    let job;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      job = await manager.get(started.id);
      if (job.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(job).toMatchObject({ status: 'completed', progress: { completed: 1, total: 1 } });
    const loaded = await manager.page(started.id, { limit: 1 });
    expect(loaded.report).toMatchObject({ total: 1, repositories: [{ name: 'service' }] });

    const replacement = createScanJobManager({ cwd, runner: async () => { throw new Error('not called'); } });
    expect(await replacement.get(started.id)).toMatchObject({ status: 'completed' });
  });

  it('redacts credentials from failed job errors', async () => {
    const manager = createScanJobManager({ cwd, runner: async () => { throw new Error('bad github_pat_secretvalue'); } });
    const started = await manager.start({ organization: 'example' });
    let job;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      job = await manager.get(started.id);
      if (job.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(job.error).toContain('<redacted>');
    expect(job.error).not.toContain('secretvalue');
  });

  it('delivers a fixed-destination HMAC-signed completion webhook', async () => {
    const deliveries = [];
    const manager = createScanJobManager({
      cwd,
      webhookUrl: 'https://security.example.test/deps-warden',
      webhookSecret: '0123456789abcdef0123456789abcdef',
      fetchImpl: async (url, init) => {
        deliveries.push({ url, init });
        return { ok: true, status: 204 };
      },
      runner: async input => createOrgReport({
        organization: input.organization,
        repositories: [{ name: 'service', checks: [{ id: 'x', status: 'pass' }] }],
      }),
    });
    const started = await manager.start({ organization: 'example' });
    for (let attempt = 0; attempt < 50 && deliveries.length === 0; attempt += 1) {
      await manager.get(started.id);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].url).toBe('https://security.example.test/deps-warden');
    expect(deliveries[0].init.headers['x-deps-warden-event']).toBe('scan.completed');
    expect(deliveries[0].init.headers['x-deps-warden-signature-256']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});
