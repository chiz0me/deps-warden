#!/usr/bin/env node
/**
 * Verify package.json dependencies are pinned to exact versions.
 * Fails with exit code 1 on any range specifier (^, ~, >=, *, latest).
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const pkgPath = resolve(process.cwd(), 'package.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));

const bad = [];
for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
  const deps = pkg[section] ?? {};
  for (const [name, version] of Object.entries(deps)) {
    if (typeof version !== 'string') continue;
    if (/^(?:\^|~|>=|<=|>|<|\*|latest)/.test(version) || version.includes(' ')) {
      bad.push(`${section}.${name} = ${version}`);
    }
  }
}

if (bad.length > 0) {
  process.stderr.write('unpinned dependencies:\n');
  for (const b of bad) process.stderr.write(`  ${b}\n`);
  process.exit(1);
}
process.stdout.write('all dependencies pinned to exact versions\n');
