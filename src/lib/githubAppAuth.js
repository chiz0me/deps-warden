/** GitHub App JWT and refreshable installation-token authentication. */

import { sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const DEFAULT_API_VERSION = '2026-03-10';

export function createGitHubAppTokenProvider({
  appId,
  installationId,
  privateKey,
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://api.github.com',
  apiVersion = DEFAULT_API_VERSION,
  now = () => Date.now(),
  refreshBeforeMs = 5 * 60 * 1_000,
}) {
  const normalizedAppId = positiveIdentifier(appId, 'GitHub App id');
  const normalizedInstallationId = positiveIdentifier(installationId, 'GitHub App installation id');
  if (typeof privateKey !== 'string' || !privateKey.includes('PRIVATE KEY')) {
    throw new Error('GitHub App private key must be PEM encoded');
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  const apiBase = validateBaseUrl(baseUrl);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(apiVersion)) throw new Error('GitHub API version must use YYYY-MM-DD');
  if (!Number.isInteger(refreshBeforeMs) || refreshBeforeMs < 30_000 || refreshBeforeMs > 30 * 60 * 1_000) {
    throw new Error('refreshBeforeMs must be between 30 seconds and 30 minutes');
  }

  let cached = null;
  let refreshGate = null;

  async function tokenProvider() {
    if (cached && cached.expiresAt - now() > refreshBeforeMs) return cached.token;
    if (!refreshGate) {
      refreshGate = mintInstallationToken().finally(() => { refreshGate = null; });
    }
    cached = await refreshGate;
    return cached.token;
  }

  tokenProvider.invalidate = () => { cached = null; };
  tokenProvider.stats = () => ({ expiresAt: cached?.expiresAt ?? null });

  async function mintInstallationToken() {
    const jwt = createAppJwt({ appId: normalizedAppId, privateKey, now: now() });
    const response = await fetchImpl(`${apiBase}/app/installations/${normalizedInstallationId}/access_tokens`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'user-agent': 'deps-warden-org-scanner',
        'x-github-api-version': apiVersion,
      },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('GitHub App token response exceeded 1 MiB');
    let data;
    try { data = text === '' ? null : JSON.parse(text); }
    catch { throw new Error('GitHub App token endpoint returned invalid JSON'); }
    if (!response.ok) throw new Error(`GitHub App token request failed with HTTP ${response.status}: ${safeMessage(data?.message)}`);
    if (typeof data?.token !== 'string' || data.token === '') throw new Error('GitHub App token response did not contain a token');
    const expiresAt = Date.parse(data.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) throw new Error('GitHub App token response had an invalid expiry');
    return { token: data.token, expiresAt };
  }

  return tokenProvider;
}

export function createAppJwt({ appId, privateKey, now = Date.now() }) {
  const issuedAt = Math.floor(now / 1_000) - 60;
  const header = encodeJson({ alg: 'RS256', typ: 'JWT' });
  const payload = encodeJson({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: String(appId) });
  const unsigned = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}

export async function resolveGitHubAuthenticationFromEnvironment(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (token) return { token };
  const appId = env.GITHUB_APP_ID;
  const installationId = env.GITHUB_APP_INSTALLATION_ID;
  const keyPath = env.GITHUB_APP_PRIVATE_KEY_PATH;
  const keyFromEnvironment = env.GITHUB_APP_PRIVATE_KEY;
  const configured = [appId, installationId, keyPath ?? keyFromEnvironment].filter(Boolean).length;
  if (configured === 0) return null;
  if (!appId || !installationId || (!keyPath && !keyFromEnvironment)) {
    throw new Error('incomplete GitHub App configuration in server environment');
  }
  const privateKey = keyPath ? await readFile(keyPath, 'utf8') : keyFromEnvironment.replace(/\\n/g, '\n');
  return {
    tokenProvider: createGitHubAppTokenProvider({
      appId,
      installationId,
      privateKey,
      baseUrl: env.GITHUB_API_URL,
      apiVersion: env.GITHUB_API_VERSION,
      fetchImpl,
    }),
  };
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function positiveIdentifier(value, label) {
  const normalized = String(value ?? '');
  if (!/^\d+$/.test(normalized) || normalized === '0') throw new Error(`${label} must be a positive integer`);
  return normalized;
}

function validateBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('GitHub API URL must use HTTPS');
  return url.toString().replace(/\/$/, '');
}

function safeMessage(value) {
  return typeof value === 'string'
    ? value.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '<redacted>').slice(0, 300)
    : 'request failed';
}
