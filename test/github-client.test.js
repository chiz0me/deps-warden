import { describe, expect, it } from 'vitest';

import { createGitHubClient, GitHubRateLimitError } from '../src/lib/githubClient.js';

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('GitHub REST client', () => {
  it('paginates at 100 items and does not invent missing rate-limit values', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      const page = Number(new URL(url).searchParams.get('page'));
      return response(Array.from({ length: page < 11 ? 100 : 1 }, (_, index) => ({ id: `${page}-${index}` })));
    };
    const client = createGitHubClient({ token: 'test-token', fetchImpl, minIntervalMs: 0 });
    const repositories = await client.paginate('/orgs/example/repos?type=all');

    expect(repositories).toHaveLength(1001);
    expect(calls).toHaveLength(11);
    expect(calls[0].options.headers.authorization).toBe('Bearer test-token');
    expect(calls[0].options.headers['x-github-api-version']).toBe('2026-03-10');
    expect(client.stats().rate).toEqual({ limit: null, remaining: null, resetAt: null, used: null });
  });

  it('stops before exhausting the configured primary-rate reserve', async () => {
    const fetchImpl = async () => response({}, {
      headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '50', 'x-ratelimit-used': '4950' },
    });
    const client = createGitHubClient({ token: 'test-token', fetchImpl, minIntervalMs: 0, rateLimitReserve: 50 });
    await client.request('/repos/example/one');
    await expect(client.request('/repos/example/two')).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it('invalidates and refreshes a token provider after HTTP 401', async () => {
    let token = 'ghs_first';
    let invalidations = 0;
    const provider = async () => token;
    provider.invalidate = () => { invalidations += 1; token = 'ghs_second'; };
    const authorizations = [];
    const client = createGitHubClient({
      tokenProvider: provider,
      minIntervalMs: 0,
      fetchImpl: async (_url, options) => {
        authorizations.push(options.headers.authorization);
        return authorizations.length === 1
          ? response({ message: 'Bad credentials' }, { status: 401 })
          : response({ ok: true });
      },
    });
    await expect(client.request('/repos/example/repo')).resolves.toMatchObject({ status: 200 });
    expect(invalidations).toBe(1);
    expect(authorizations).toEqual(['Bearer ghs_first', 'Bearer ghs_second']);
  });
});
