/** Require an exact packageManager declaration at the repository root. */

import { join } from 'node:path';
import semver from 'semver';

export const id = 'package-manager-pinned';
export const severity = 'high';
export const description = '`packageManager` is missing or does not declare an exact supported version.';

const SUPPORTED_NAMES = new Set(['npm', 'pnpm', 'yarn', 'bun']);

export function appliesTo(ctx) {
  return ctx.pkg !== null;
}

export async function check(ctx) {
  const declared = ctx.pkg.raw?.packageManager;
  const parsed = parsePackageManager(declared);
  if (parsed) return [];
  return [{
    severity,
    file: join(ctx.cwd, 'package.json'),
    line: ctx.pkg.topLevelLines.get('packageManager') ?? 0,
    fields: {
      type: id,
      sev: severity,
      declared: typeof declared === 'string' ? declared : '',
      detected: ctx.pm.kind,
      version: ctx.pm.version ?? '',
    },
    explain: `add an exact package manager declaration such as "packageManager": "${packageManagerName(ctx.pm.kind)}@<exact-version>"`,
  }];
}

function parsePackageManager(declared) {
  if (typeof declared !== 'string') return null;
  const withoutHash = declared.split('+')[0];
  const separator = withoutHash.indexOf('@');
  if (separator <= 0) return null;
  const name = withoutHash.slice(0, separator);
  const version = withoutHash.slice(separator + 1);
  if (!SUPPORTED_NAMES.has(name) || semver.valid(version) === null) return null;
  return { name, version };
}

function packageManagerName(kind) {
  return kind.startsWith('yarn-') ? 'yarn' : kind;
}

export function explain() {
  return 'An exact packageManager field makes the package-manager implementation '
       + 'part of the reviewed build input. Lockfile format and security controls '
       + 'can change across package-manager versions.';
}
