/**
 * Auth tokens must not be committed in plain text.
 *
 * Detects literal npm and Yarn authentication fields in tracked config files,
 * including configs nested below the repository root. Values consisting
 * entirely of `${VAR}` or `$VAR` interpolations are allowed.
 */

import { basename, join, relative } from 'node:path';

export const id = 'no-committed-auth';
export const severity = 'critical';
export const description = 'Authentication token committed in a tracked config file.';

const CANDIDATE_NAMES = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml']);
const AUTH_KEY = '(?:_authToken|_auth|_password|username|npmAuthToken|npmAuthIdent)';
const AUTH_RE = new RegExp(`^\\s*(?:\\/\\/[^\\s:=]+(?::\\d+)?\\/[^\\s]*?:)?${AUTH_KEY}\\s*[:=]\\s*(.*?)\\s*$`, 'i');
const ENV_ONLY = /^\s*["']?\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-[^}]*)?\}["']?\s*$|^\s*["']?\$[A-Z_][A-Z0-9_]*["']?\s*$/;

export function appliesTo(ctx) {
  return ctx.gitTracked !== null;
}

export async function check(ctx) {
  const findings = [];
  const candidates = [...ctx.gitTracked].filter(path => CANDIDATE_NAMES.has(basename(path)));
  for (const name of candidates) {
    const file = join(ctx.cwd, name);
    const src = await ctx.readText(file);
    if (!src) continue;
    const lines = src.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const match = AUTH_RE.exec(lines[index]);
      if (!match) continue;
      const tokenValue = match[1].trim();
      if (tokenValue === '') continue;
      if (ENV_ONLY.test(tokenValue)) continue;
      findings.push({
        severity,
        file,
        line: index + 1,
        fields: { type: id, sev: severity, file: relative(ctx.cwd, file) },
        explain: 'remove and rotate the committed credential, then use an environment variable or short-lived OIDC identity',
      });
    }
  }
  return findings;
}

export function explain() {
  return 'A tracked package-manager config with a literal credential means the secret is in '
       + 'git history forever. Even rotating the token leaves the prior '
       + 'value retrievable from past commits. Use environment variable '
       + 'interpolation: `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`.';
}
