import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { audit } from '../src/commands/audit.js';

async function project(pkg) {
  const cwd = await mkdtemp(join(tmpdir(), 'dw-manifest-'));
  await writeFile(join(cwd, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  return cwd;
}

describe('direct-deps-exact', () => {
  it('flags mutable registry ranges and tags across install dependency sections', async () => {
    const cwd = await project({
      name: 'ranges',
      version: '1.0.0',
      dependencies: { alpha: '^1.2.3', exact: '2.0.0' },
      devDependencies: { beta: '~3.1.0' },
      optionalDependencies: { gamma: 'latest' },
      peerDependencies: { peer: '^4.0.0' },
    });
    const result = await audit({ cwd, rules: ['direct-deps-exact'] });
    expect(result.findings.map(finding => finding.fields.dependency).toSorted())
      .toEqual(['alpha', 'beta', 'gamma']);
    expect(result.findings.every(finding => finding.line > 0)).toBe(true);
  });

  it('accepts exact aliases and repository-local protocols', async () => {
    const cwd = await project({
      name: 'exact',
      version: '1.0.0',
      dependencies: {
        exact: '1.2.3-beta.1',
        alias: 'npm:@scope/pkg@2.3.4',
        workspace: 'workspace:^',
        local: 'file:../local',
        git: 'github:example/repo#0123456789abcdef',
      },
    });
    const result = await audit({ cwd, rules: ['direct-deps-exact'] });
    expect(result.findings).toEqual([]);
  });
});

describe('package-manager-pinned', () => {
  it('flags a missing or ranged packageManager declaration', async () => {
    const missing = await project({ name: 'missing', version: '1.0.0' });
    const ranged = await project({ name: 'ranged', version: '1.0.0', packageManager: 'npm@^12.0.0' });
    const missingResult = await audit({ cwd: missing, rules: ['package-manager-pinned'] });
    const rangedResult = await audit({ cwd: ranged, rules: ['package-manager-pinned'] });
    expect(missingResult.findings).toHaveLength(1);
    expect(rangedResult.findings).toHaveLength(1);
    expect(rangedResult.findings[0].fields.declared).toBe('npm@^12.0.0');
  });

  it('accepts an exact version with an optional Corepack integrity suffix', async () => {
    const cwd = await project({
      name: 'pinned',
      version: '1.0.0',
      packageManager: 'pnpm@11.0.0+sha512.abcdef',
    });
    const result = await audit({ cwd, rules: ['package-manager-pinned'] });
    expect(result.findings).toEqual([]);
  });
});
