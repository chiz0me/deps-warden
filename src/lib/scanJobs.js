/** Durable asynchronous job facade shared by HTTP and MCP transports. */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const SCAN_JOB_SCHEMA = 'deps-warden-scan-job/v1';
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createScanJobManager({ cwd = process.cwd(), directory = '.deps-warden-cache/jobs', concurrency = 1, runner, webhookUrl, webhookSecret, fetchImpl = globalThis.fetch } = {}) {
  if (typeof runner !== 'function') throw new Error('scan job runner is required');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new Error('job concurrency must be between 1 and 12');
  const root = resolve(cwd, directory);
  const instanceId = randomUUID();
  const queue = [];
  const active = new Map();
  const configuredWebhook = validateWebhookUrl(webhookUrl);

  async function start(input) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const job = {
      schema: SCAN_JOB_SCHEMA,
      id,
      status: 'queued',
      organization: String(input.organization ?? ''),
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      progress: { completed: 0, total: 0, repository: '' },
      result: null,
      error: '',
      instanceId,
    };
    await persistJob(root, job);
    queue.push({ job, input: structuredClone(input) });
    queueMicrotask(drain);
    return publicJob(job);
  }

  async function drain() {
    while (active.size < concurrency && queue.length > 0) {
      const queued = queue.shift();
      const promise = execute(queued).finally(() => { active.delete(queued.job.id); queueMicrotask(drain); });
      active.set(queued.job.id, promise);
    }
  }

  async function execute({ job, input }) {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    await persistJob(root, job);
    try {
      const scanReport = await runner(input, async event => {
        if (event.type !== 'repository-complete') return;
        job.progress = { completed: event.completed, total: event.total, repository: event.repository };
        job.updatedAt = new Date().toISOString();
        await persistJob(root, job);
      });
      await persistReport(root, job.id, scanReport);
      job.status = 'completed';
      job.result = { status: scanReport.status, schema: scanReport.schema, summary: scanReport.summary, coverage: scanReport.coverage };
      job.error = '';
    } catch (error) {
      job.status = 'failed';
      job.error = safeError(error);
    }
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    await persistJob(root, job);
    await deliverWebhook({ url: configuredWebhook, secret: webhookSecret, job: publicJob(job), fetchImpl });
  }

  async function get(id) {
    validateJobId(id);
    const job = await readJson(jobPath(root, id));
    if (!job) return null;
    if (['queued', 'running'].includes(job.status) && job.instanceId !== instanceId) {
      return publicJob({ ...job, status: 'interrupted', error: 'server-restarted; start a replacement scan to resume from durable repository checkpoints' });
    }
    return publicJob(job);
  }

  async function report(id) {
    const job = await get(id);
    if (!job) return { job: null, report: null };
    if (job.status !== 'completed') return { job, report: null };
    return { job, report: await readJson(reportPath(root, id)) };
  }

  async function page(id, options = {}) {
    const loaded = await report(id);
    if (!loaded.report) return loaded;
    return { job: loaded.job, report: pageReport(loaded.report, options) };
  }

  return { start, get, report, page };
}

export function pageReport(report, { repository, status, offset = 0, limit = 25 } = {}) {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100');
  let repositories = report.repositories;
  if (repository) repositories = repositories.filter(item => item.name === repository);
  if (status) repositories = repositories.filter(item => item.status === status);
  const items = repositories.slice(offset, offset + limit);
  return {
    schema: report.schema,
    policy: report.policy,
    organization: report.organization,
    generatedAt: report.generatedAt,
    status: report.status,
    organizationStatus: report.organizationStatus,
    organizationChecks: report.organizationChecks,
    exceptions: report.exceptions,
    total: repositories.length,
    offset,
    limit,
    hasMore: offset + items.length < repositories.length,
    repositories: items,
  };
}

async function persistJob(root, job) {
  await atomicJson(jobPath(root, job.id), job);
}

async function persistReport(root, id, report) {
  await atomicJson(reportPath(root, id), report);
}

async function atomicJson(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function jobPath(root, id) {
  return join(root, `${id}.json`);
}

function reportPath(root, id) {
  return join(root, `${id}.report.json`);
}

function validateJobId(id) {
  if (typeof id !== 'string' || !JOB_ID.test(id)) throw new Error('invalid scan job id');
}

function publicJob(job) {
  const { instanceId: _instanceId, ...safe } = job;
  return safe;
}

function validateWebhookUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('webhook URL must use HTTPS');
  if (url.username || url.password) throw new Error('webhook URL must not contain credentials');
  return url.href;
}

async function deliverWebhook({ url, secret, job, fetchImpl }) {
  if (!url) return;
  if (typeof secret !== 'string' || secret.length < 32) return;
  const body = JSON.stringify({ event: `scan.${job.status}`, delivery: randomUUID(), job });
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  try {
    await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'deps-warden-webhook/1',
        'x-deps-warden-event': `scan.${job.status}`,
        'x-deps-warden-signature-256': `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* job completion must not depend on webhook availability */ }
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '<redacted>').slice(0, 500);
}

export function scanJobInputFingerprint(input) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
