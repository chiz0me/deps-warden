import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderJson, toonLine } from '../src/lib/formatter.js';
import { unifiedDiff } from '../src/lib/diff.js';
import { writeFileGuarded } from '../src/lib/writer.js';
import { audit } from '../src/commands/audit.js';
import { check as checkCommittedAuth } from '../src/rules/no-committed-auth.js';

describe('security regressions', () => {
  it('detects nested npm and Yarn credentials while allowing environment references', async () => {
    const files = new Map([
      ['packages/app/.npmrc', '//registry.npmjs.org/:_authToken=npm_literal\n'],
      ['packages/lib/.yarnrc.yml', 'npmAuthToken: "yarn_literal"\n'],
      ['.npmrc', '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n'],
    ]);
    const ctx = {
      cwd: '/project',
      gitTracked: new Set(files.keys()),
      readText: async file => files.get(file.replace('/project/', '')) ?? null,
    };
    const findings = await checkCommittedAuth(ctx);
    expect(findings).toHaveLength(2);
    expect(findings.map(finding => finding.fields.file).toSorted()).toEqual([
      'packages/app/.npmrc',
      'packages/lib/.yarnrc.yml',
    ]);
  });

  it('fails closed on a malformed package manifest', async () => {
    const project = await mkdtemp(join(tmpdir(), 'dw-invalid-config-'));
    await writeFile(join(project, 'package.json'), '{"name":', 'utf8');
    const result = await audit({ cwd: project });
    const finding = result.findings.find(item => item.ruleId === 'config-files-valid');
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('critical');
    expect(result.status).toBe('FAIL');
  });

  it('refuses writes through a symlink that escapes the working directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dw-writer-'));
    const project = join(base, 'project');
    const outside = join(base, 'outside.txt');
    const link = join(project, 'config.txt');
    await mkdir(project);
    await writeFile(outside, 'do not change', 'utf8');
    await symlink(outside, link);

    await expect(writeFileGuarded({
      path: link,
      content: 'compromised',
      dryRun: false,
      cwd: project,
    })).rejects.toThrow(/symbolic link|outside working directory/);
    await expect(readFile(outside, 'utf8')).resolves.toBe('do not change');
  });

  it('refuses writes through a symlinked parent directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dw-parent-'));
    const project = join(base, 'project');
    const outside = join(base, 'outside');
    await mkdir(project);
    await mkdir(outside);
    await symlink(outside, join(project, 'config'));

    await expect(writeFileGuarded({
      path: 'config/settings.json',
      content: '{}',
      dryRun: false,
      cwd: project,
    })).rejects.toThrow(/outside working directory/);
  });

  it('redacts nested structured secrets in JSON output', () => {
    const rendered = renderJson({
      config: {
        _authToken: 'plain-secret-value',
        password: 'another-secret',
      },
    });
    expect(rendered).not.toContain('plain-secret-value');
    expect(rendered).not.toContain('another-secret');
    expect(JSON.parse(rendered).config).toEqual({
      _authToken: '<redacted>',
      password: '<redacted>',
    });
  });

  it('redacts credentials from generated diffs', () => {
    const diff = unifiedDiff(
      '//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz123456\n',
      'ignore-scripts=true\n',
      '.npmrc',
    );
    expect(diff).toContain('<redacted>');
    expect(diff).not.toContain('npm_abcdefghijklmnopqrstuvwxyz123456');
  });

  it('escapes newlines so a TOON record cannot inject another record', () => {
    const line = toonLine('FINDING', { msg: 'first\nSTATUS: OK' });
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('first\\nSTATUS: OK');
  });
});
