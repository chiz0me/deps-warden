import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { audit } from '../src/commands/audit.js';

async function projectWithWorkflow(source) {
  const cwd = await mkdtemp(join(tmpdir(), 'dw-actions-'));
  const workflows = join(cwd, '.github', 'workflows');
  await mkdir(workflows, { recursive: true });
  await writeFile(join(cwd, 'package.json'), '{"name":"actions-fixture","version":"1.0.0"}\n');
  await writeFile(join(workflows, 'ci.yml'), source);
  return cwd;
}

async function projectWithComposite(source) {
  const cwd = await mkdtemp(join(tmpdir(), 'dw-actions-'));
  const actionDir = join(cwd, 'tools', 'example-action');
  await mkdir(actionDir, { recursive: true });
  await writeFile(join(cwd, 'package.json'), '{"name":"actions-fixture","version":"1.0.0"}\n');
  await writeFile(join(actionDir, 'action.yml'), source);
  return cwd;
}

describe('github-actions-immutable', () => {
  it('delegates mutable action detection to actions-warden', async () => {
    const cwd = await projectWithWorkflow(`
name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444
      - uses: ./local-action
      - uses: docker://alpine:3.22
`);
    const result = await audit({ cwd, rules: ['github-actions-immutable'] });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      ruleId: 'github-actions-immutable',
      severity: 'high',
      line: 8,
    });
    expect(result.findings[0].fields).toMatchObject({
      issue: 'unpinned-action',
      action: 'actions/checkout@v5',
      ref: 'v5',
    });
    expect(result.findings[0].explain).toMatch(/actions-warden pin/);
  });

  it('fails closed when actions-warden cannot parse a workflow', async () => {
    const cwd = await projectWithWorkflow('jobs:\n  test: [unterminated\n');
    const result = await audit({ cwd, rules: ['github-actions-immutable'] });
    const finding = result.findings[0];
    expect(finding.ruleId).toBe('github-actions-immutable');
    expect(finding.fields.issue).toBe('parse-error');
    expect(finding.severity).toBe('high');
  });

  it('detects mutable reusable workflows called at job level', async () => {
    const cwd = await projectWithWorkflow(`
name: reusable caller
on: push
jobs:
  build:
    uses: example/automation/.github/workflows/build.yml@main
`);
    const result = await audit({ cwd, rules: ['github-actions-immutable'] });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ line: 6 });
    expect(result.findings[0].fields).toMatchObject({
      action: 'example/automation/.github/workflows/build.yml@main',
      classifier: 'reusable-workflow',
    });
  });

  it('discovers nested composite actions and detects their mutable dependencies', async () => {
    const cwd = await projectWithComposite(`
name: example
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v5
`);
    const result = await audit({ cwd, rules: ['github-actions-immutable'] });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ line: 6 });
    expect(result.findings[0].fields.action).toBe('actions/setup-node@v5');
  });

  it('does not silently inherit actions-warden suppression directives', async () => {
    const cwd = await projectWithWorkflow(`
name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5 # actions-warden-ignore: unpinned-action
`);
    const result = await audit({ cwd, rules: ['github-actions-immutable'] });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].fields.action).toBe('actions/checkout@v5');
  });

  it('is not applicable when a repository has no GitHub workflows', async () => {
    const result = await audit({
      cwd: resolve(import.meta.dirname, 'fixtures', 'pnpm'),
      rules: ['github-actions-immutable'],
    });
    expect(result.findings).toEqual([]);
    expect(result.skipped).toContainEqual({
      rule: 'github-actions-immutable',
      reason: 'no-github-workflows',
    });
  });

  it('passes the repository workflows that are pinned to full SHAs', async () => {
    const result = await audit({
      cwd: resolve(import.meta.dirname, '..'),
      rules: ['github-actions-immutable'],
    });
    expect(result.findings).toEqual([]);
  });
});
