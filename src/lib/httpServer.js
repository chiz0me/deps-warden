/** Authenticated asynchronous HTTP transport for organization scan jobs. */

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { scanGitHubOrganization } from '../commands/orgScan.js';
import { resolveGitHubAuthenticationFromEnvironment } from './githubAppAuth.js';
import { loadGovernedExceptions } from './orgPolicy.js';
import { createScanJobManager } from './scanJobs.js';

const INPUT_KEYS = new Set([
  'organization', 'repositories', 'expectedRepositories', 'includeArchived', 'includeForks',
  'concurrency', 'maxRepositories', 'cache', 'refresh', 'resume', 'checkVersions', 'profile',
  'waitForRateLimit', 'rateLimitReserve', 'minIntervalMs', 'maxEvidenceFiles', 'maxEvidenceBytes',
  'maxFileBytes', 'maxTreeRequests', 'maxTreeEntries',
]);

export async function createScanHttpServer({ env = process.env, cwd = process.cwd(), fetchImpl = globalThis.fetch, runner } = {}) {
  const serviceToken = env.DEPS_WARDEN_HTTP_TOKEN;
  if (typeof serviceToken !== 'string' || serviceToken.length < 32) {
    throw new Error('DEPS_WARDEN_HTTP_TOKEN must contain at least 32 characters');
  }
  const authentication = runner ? null : await resolveGitHubAuthenticationFromEnvironment(env, { fetchImpl });
  if (!runner && !authentication) throw new Error('GitHub authentication is not configured for the HTTP scanner');
  const exceptions = runner ? [] : await loadGovernedExceptions({ cwd, path: env.DEPS_WARDEN_EXCEPTIONS_PATH });
  const scanRunner = runner ?? ((input, onProgress) => scanGitHubOrganization({
    ...input,
    ...authentication,
    exceptions,
    cwd,
    apiUrl: env.GITHUB_API_URL,
    apiVersion: env.GITHUB_API_VERSION,
    onProgress,
  }));
  const jobs = createScanJobManager({
    cwd,
    directory: env.DEPS_WARDEN_JOB_DIRECTORY,
    concurrency: parseBoundedInteger(env.DEPS_WARDEN_JOB_CONCURRENCY, 1, 1, 12),
    runner: scanRunner,
    webhookUrl: env.DEPS_WARDEN_WEBHOOK_URL,
    webhookSecret: env.DEPS_WARDEN_WEBHOOK_SECRET,
    fetchImpl,
  });

  return createServer(async (request, response) => {
    applySecurityHeaders(response);
    try {
      if (request.method === 'GET' && request.url === '/health') return sendJson(response, 200, { status: 'ok' });
      if (!authorized(request.headers.authorization, serviceToken)) return sendJson(response, 401, { error: 'unauthorized' });
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'POST' && url.pathname === '/v1/scans') {
        const input = validateHttpScanInput(await readJsonBody(request));
        const job = await jobs.start(input);
        response.setHeader('location', `/v1/scans/${job.id}`);
        return sendJson(response, 202, { job });
      }
      const match = /^\/v1\/scans\/([0-9a-f-]+)(\/report)?$/.exec(url.pathname);
      if (request.method === 'GET' && match) {
        if (match[2]) {
          const loaded = await jobs.page(match[1], {
            repository: url.searchParams.get('repository') ?? undefined,
            status: url.searchParams.get('status') ?? undefined,
            offset: queryInteger(url, 'offset', 0),
            limit: queryInteger(url, 'limit', 25),
          });
          if (!loaded.job) return sendJson(response, 404, { error: 'scan job not found' });
          if (!loaded.report) return sendJson(response, 409, { error: 'scan report is not ready', job: loaded.job });
          return sendJson(response, 200, loaded);
        }
        const job = await jobs.get(match[1]);
        return job ? sendJson(response, 200, { job }) : sendJson(response, 404, { error: 'scan job not found' });
      }
      return sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      return sendJson(response, 400, { error: safeError(error) });
    }
  });
}

export async function listenScanHttpServer(options = {}) {
  const server = await createScanHttpServer(options);
  const host = options.host ?? options.env?.DEPS_WARDEN_HTTP_HOST ?? process.env.DEPS_WARDEN_HTTP_HOST ?? '127.0.0.1';
  const port = parseBoundedInteger(options.port ?? options.env?.DEPS_WARDEN_HTTP_PORT ?? process.env.DEPS_WARDEN_HTTP_PORT, 8790, 1, 65_535);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

function validateHttpScanInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body must be a JSON object');
  const unknown = Object.keys(value).filter(key => !INPUT_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`unknown scan option(s): ${unknown.join(', ')}`);
  if (typeof value.organization !== 'string') throw new Error('organization is required');
  return structuredClone(value);
}

async function readJsonBody(request) {
  const contentType = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error('content-type must be application/json');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error('request body exceeds 64 KiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('request body is not valid JSON'); }
}

function authorized(header, expected) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

function queryInteger(url, name, fallback) {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
}

function parseBoundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`integer must be between ${minimum} and ${maximum}`);
  return parsed;
}

function applySecurityHeaders(response) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-security-policy', "default-src 'none'");
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '<redacted>').slice(0, 500);
}
