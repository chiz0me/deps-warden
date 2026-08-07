/** Shared, side-effect-free registry trust validation. */

export const DEFAULT_TRUSTED_REGISTRIES = Object.freeze([
  'registry.npmjs.org',
  'npm.pkg.github.com',
]);

/**
 * Registry trust is an exact host decision and never overrides transport
 * security: even an approved host must use HTTPS and must not embed credentials.
 */
export function assessRegistryUrl(raw, extraTrusted = []) {
  const value = String(raw ?? '').trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, value, host: '', reason: 'invalid-url' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, value, host: url.host, reason: 'insecure-protocol' };
  }
  if (url.username || url.password) {
    return { ok: false, value, host: url.host, reason: 'embedded-credentials' };
  }

  const trusted = new Set([
    ...DEFAULT_TRUSTED_REGISTRIES,
    ...extraTrusted.map(normalizeTrustedHost).filter(Boolean),
  ]);
  if (!trusted.has(url.host.toLowerCase())) {
    return { ok: false, value, host: url.host, reason: 'untrusted-host' };
  }
  return { ok: true, value, host: url.host, reason: null };
}

function normalizeTrustedHost(value) {
  const raw = String(value).trim().toLowerCase();
  if (!raw) return '';
  try { return new URL(raw).host.toLowerCase(); } catch { return raw; }
}
