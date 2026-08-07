import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

import { createAppJwt, createGitHubAppTokenProvider } from '../src/lib/githubAppAuth.js';

function privateKey() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' });
}

describe('GitHub App authentication', () => {
  it('creates a short-lived RS256 app JWT without embedding private-key material', () => {
    const jwt = createAppJwt({ appId: '123', privateKey: privateKey(), now: 1_800_000_000_000 });
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url'))).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payload, 'base64url'))).toMatchObject({ iss: '123' });
    expect(signature.length).toBeGreaterThan(100);
    expect(jwt).not.toContain('PRIVATE KEY');
  });

  it('caches installation tokens and refreshes before their one-hour expiry', async () => {
    let now = 1_800_000_000_000;
    let requests = 0;
    const provider = createGitHubAppTokenProvider({
      appId: '123',
      installationId: '456',
      privateKey: privateKey(),
      now: () => now,
      fetchImpl: async (_url, options) => {
        requests += 1;
        expect(options.method).toBe('POST');
        expect(options.headers.authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
        return new Response(JSON.stringify({
          token: `ghs_token_${requests}`,
          expires_at: new Date(now + 60 * 60 * 1_000).toISOString(),
        }), { status: 201 });
      },
    });

    await expect(provider()).resolves.toBe('ghs_token_1');
    await expect(provider()).resolves.toBe('ghs_token_1');
    expect(requests).toBe(1);
    now += 56 * 60 * 1_000;
    await expect(provider()).resolves.toBe('ghs_token_2');
    expect(requests).toBe(2);
  });
});
