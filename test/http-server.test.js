import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createOrgReport } from '../src/lib/orgReport.js';
import { createScanHttpServer } from '../src/lib/httpServer.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const cleanups = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(item => item())); });

describe('scan HTTP transport', () => {
  it('authenticates, starts a job with 202, and returns its durable report', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'deps-http-'));
    const server = await createScanHttpServer({
      cwd,
      env: { DEPS_WARDEN_HTTP_TOKEN: TOKEN },
      runner: async input => createOrgReport({
        organization: input.organization,
        repositories: [{ name: 'service', checks: [{ id: 'x', status: 'pass' }] }],
      }),
    });
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    expect((await callServer(server, '/v1/scans')).status).toBe(401);
    const startedResponse = await callServer(server, '/v1/scans', { method: 'POST', token: TOKEN, body: { organization: 'example' } });
    expect(startedResponse.status).toBe(202);
    const started = startedResponse.body;
    let job;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await callServer(server, `/v1/scans/${started.job.id}`, { token: TOKEN });
      job = response.body.job;
      if (job.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(job.status).toBe('completed');
    const reportResponse = await callServer(server, `/v1/scans/${job.id}/report?limit=1`, { token: TOKEN });
    expect(reportResponse.status).toBe(200);
    expect(reportResponse.body).toMatchObject({ report: { total: 1, repositories: [{ name: 'service' }] } });
  }, 10_000);
});

async function callServer(server, path, { method = 'GET', token, body } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const request = Readable.from(payload === '' ? [] : [Buffer.from(payload)]);
  request.method = method;
  request.url = path;
  request.headers = {};
  if (token) request.headers.authorization = `Bearer ${token}`;
  if (payload !== '') request.headers['content-type'] = 'application/json';
  let responseBody = '';
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value = '') { responseBody = String(value); },
  };
  const handler = server.listeners('request')[0];
  await handler(request, response);
  return { status: response.statusCode, body: JSON.parse(responseBody) };
}
