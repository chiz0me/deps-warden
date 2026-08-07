/**
 * Small read-only GitHub REST client for organization scans.
 *
 * It deliberately implements only GET requests, starts requests at a bounded
 * rate to avoid secondary throttles, honours Retry-After, and stops before the
 * primary rate limit is exhausted unless the caller explicitly opts to wait.
 */

const DEFAULT_API_VERSION = '2026-03-10';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class GitHubApiError extends Error {
  constructor(message, { status = 0, path = '', retryable = false } = {}) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.path = path;
    this.retryable = retryable;
  }
}

export class GitHubRateLimitError extends GitHubApiError {
  constructor(message, details = {}) {
    super(message, { ...details, status: details.status ?? 429, retryable: true });
    this.name = 'GitHubRateLimitError';
    this.resetAt = details.resetAt ?? null;
  }
}

/**
 * @param {object} options
 * @param {string} options.token
 * @param {() => Promise<string>} [options.tokenProvider]
 * @param {typeof globalThis.fetch} [options.fetchImpl]
 * @param {string} [options.baseUrl]
 * @param {string} [options.apiVersion]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.minIntervalMs]
 * @param {number} [options.maxRetries]
 * @param {number} [options.rateLimitReserve]
 * @param {boolean} [options.waitForRateLimit]
 * @param {(ms: number) => Promise<void>} [options.sleepImpl]
 */
export function createGitHubClient({
  token,
  tokenProvider,
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://api.github.com',
  apiVersion = DEFAULT_API_VERSION,
  timeoutMs = 20_000,
  minIntervalMs = 100,
  maxRetries = 3,
  rateLimitReserve = 50,
  waitForRateLimit = false,
  sleepImpl = sleep,
}) {
  if ((typeof token !== 'string' || token.trim() === '') && typeof tokenProvider !== 'function') {
    throw new Error('a GitHub token or token provider is required for organization scans');
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  const apiBase = validateBaseUrl(baseUrl);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(apiVersion)) throw new Error('GitHub API version must use YYYY-MM-DD');
  assertInteger(timeoutMs, 'timeoutMs', 1_000, 120_000);
  assertInteger(minIntervalMs, 'minIntervalMs', 0, 10_000);
  assertInteger(maxRetries, 'maxRetries', 0, 10);
  assertInteger(rateLimitReserve, 'rateLimitReserve', 0, 10_000);

  let nextStartAt = 0;
  let startGate = Promise.resolve();
  let rate = { limit: null, remaining: null, resetAt: null, used: null };
  let requests = 0;

  async function request(path, { allowStatuses = [] } = {}) {
    assertApiPath(path);
    const allowed = new Set(allowStatuses);
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      await reserveRateLimit(path);
      await scheduleStart();
      let response;
      try {
        const requestToken = tokenProvider ? await tokenProvider() : token;
        response = await fetchImpl(`${apiBase}${path}`, {
          method: 'GET',
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${requestToken}`,
            'user-agent': 'deps-warden-org-scanner',
            'x-github-api-version': apiVersion,
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        requests += 1;
      } catch (error) {
        if (attempt < maxRetries) {
          await sleepImpl(backoffMs(attempt));
          continue;
        }
        throw new GitHubApiError(`GitHub request failed for ${path}: ${safeMessage(error)}`, {
          path,
          retryable: true,
        });
      }

      updateRate(response.headers);
      const data = await readResponse(response, path);
      if (response.ok || allowed.has(response.status)) {
        return { status: response.status, data, headers: response.headers };
      }

      if (isRateLimited(response, data)) {
        const waitMs = rateLimitWaitMs(response, rate.resetAt);
        if (!waitForRateLimit || attempt === maxRetries) {
          throw new GitHubRateLimitError(`GitHub rate limit reached while requesting ${path}`, {
            path,
            status: response.status,
            resetAt: rate.resetAt,
          });
        }
        await sleepImpl(waitMs);
        continue;
      }

      if (response.status === 401 && tokenProvider && attempt < maxRetries) {
        tokenProvider.invalidate?.();
        continue;
      }

      if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        await sleepImpl(retryWaitMs(response, attempt));
        continue;
      }
      throw new GitHubApiError(`GitHub API ${response.status} for ${path}: ${apiMessage(data)}`, {
        status: response.status,
        path,
        retryable: RETRYABLE_STATUS.has(response.status),
      });
    }
    throw new GitHubApiError(`GitHub request retries exhausted for ${path}`, { path, retryable: true });
  }

  async function paginate(path) {
    const all = [];
    for (let page = 1; ; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const result = await request(`${path}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(result.data)) throw new GitHubApiError(`expected an array from ${path}`, { path });
      all.push(...result.data);
      if (result.data.length < 100) break;
    }
    return all;
  }

  async function reserveRateLimit(path) {
    if (rate.remaining === null || rate.remaining > rateLimitReserve) return;
    if (!waitForRateLimit) {
      throw new GitHubRateLimitError(`GitHub rate-limit reserve reached before ${path}`, {
        path,
        resetAt: rate.resetAt,
      });
    }
    const waitMs = Math.max(1_000, (rate.resetAt ?? Date.now() + 60_000) - Date.now() + 1_000);
    await sleepImpl(waitMs);
    rate = { ...rate, remaining: null };
  }

  async function scheduleStart() {
    const previous = startGate;
    let release;
    startGate = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const waitMs = Math.max(0, nextStartAt - Date.now());
      if (waitMs > 0) await sleepImpl(waitMs);
      nextStartAt = Date.now() + minIntervalMs;
    } finally {
      release();
    }
  }

  function updateRate(headers) {
    rate = {
      limit: headerInteger(headers, 'x-ratelimit-limit'),
      remaining: headerInteger(headers, 'x-ratelimit-remaining'),
      used: headerInteger(headers, 'x-ratelimit-used'),
      resetAt: epochHeaderMs(headers, 'x-ratelimit-reset'),
    };
  }

  return {
    request,
    paginate,
    stats: () => ({ requests, rate: { ...rate } }),
  };
}

function validateBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('GitHub API URL must use HTTPS');
  return url.toString().replace(/\/$/, '');
}

function assertApiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) {
    throw new Error('GitHub API path must be an absolute API path');
  }
}

function assertInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
}

async function readResponse(response, path) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > 12 * 1024 * 1024) {
    throw new GitHubApiError(`GitHub response too large for ${path}`, { path, status: response.status });
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > 12 * 1024 * 1024) {
    throw new GitHubApiError(`GitHub response too large for ${path}`, { path, status: response.status });
  }
  if (text === '') return null;
  try { return JSON.parse(text); }
  catch { throw new GitHubApiError(`GitHub returned invalid JSON for ${path}`, { path, status: response.status }); }
}

function isRateLimited(response, data) {
  if (response.status !== 403 && response.status !== 429) return false;
  if (response.headers.get('x-ratelimit-remaining') === '0') return true;
  return /rate limit|abuse detection/i.test(apiMessage(data));
}

function rateLimitWaitMs(response, resetAt) {
  const retryAfter = headerNumber(response.headers, 'retry-after');
  if (retryAfter !== null && retryAfter >= 0) return (retryAfter + 1) * 1_000;
  return Math.max(60_000, (resetAt ?? Date.now() + 60_000) - Date.now() + 1_000);
}

function retryWaitMs(response, attempt) {
  const retryAfter = headerNumber(response.headers, 'retry-after');
  return retryAfter !== null && retryAfter >= 0
    ? (retryAfter + 1) * 1_000
    : backoffMs(attempt);
}

function backoffMs(attempt) {
  return Math.min(30_000, 1_000 * (2 ** attempt));
}

function apiMessage(data) {
  return typeof data?.message === 'string' ? data.message.slice(0, 300) : 'request failed';
}

function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '<redacted>').slice(0, 300);
}

function headerInteger(headers, name) {
  const raw = headers.get(name);
  if (raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

function headerNumber(headers, name) {
  const raw = headers.get(name);
  if (raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function epochHeaderMs(headers, name) {
  const value = headerInteger(headers, name);
  return value === null ? null : value * 1_000;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
