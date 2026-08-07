/**
 * Secret redaction utility.
 *
 * Replaces values that look like tokens, credentials, or high-entropy strings
 * with `<redacted>`. Conservative by design: prefers false positives over leaks.
 */

const TOKEN_PATTERNS = [
  /ghp_[A-Za-z0-9]{30,}/g,
  /ghs_[A-Za-z0-9]{30,}/g,
  /gho_[A-Za-z0-9]{30,}/g,
  /ghu_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{30,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /npm_[A-Za-z0-9]{30,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const KV_TOKEN_KEYS = /\b(token|secret|password|api[_-]?key|auth[_-]?token|access[_-]?key|private[_-]?key|_authtoken)\s*[:=]\s*["']?([^"'\s,]+)/gi;

const NPMRC_AUTH = /(\/\/[^/\s]+\/[^\s]*?:_authToken\s*=\s*)([^\s]+)/g;

/**
 * Redacts sensitive substrings from a value.
 *
 * @param {unknown} input
 * @returns {string}
 */
export function redact(input) {
  if (input == null) return '';
  let s = typeof input === 'string' ? input : String(input);
  s = s.replace(NPMRC_AUTH, (_, prefix) => `${prefix}<redacted>`);
  for (const re of TOKEN_PATTERNS) s = s.replace(re, '<redacted>');
  s = s.replace(KV_TOKEN_KEYS, (_, key) => `${key}=<redacted>`);
  return s;
}

/**
 * Wraps console.error/log so any string-coerced argument is redacted first.
 *
 * @param {(...args: unknown[]) => void} fn
 * @returns {(...args: unknown[]) => void}
 */
export function safeLogger(fn) {
  return (...args) => fn(...args.map(a => (typeof a === 'string' ? redact(a) : a)));
}
