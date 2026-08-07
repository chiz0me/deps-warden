import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendGitHubStepSummary,
  renderGitHubAnnotations,
  renderGitHubSummary,
} from '../src/lib/githubActions.js';

function result(cwd, overrides = {}) {
  return {
    pm: { kind: 'npm', version: '12.0.2' },
    policy: { version: 1, path: join(cwd, '.deps-warden.yml') },
    levels: { report: 'low', fail: 'high' },
    requireComplete: true,
    failOn: null,
    status: 'FAIL',
    workspaces: ['.'],
    skipped: [],
    ignored: [],
    incomplete: [],
    findings: [{
      id: 'abc123def4',
      ruleId: 'direct-deps-exact',
      severity: 'high',
      file: join(cwd, 'package.json'),
      line: 8,
      fields: {},
      explain: 'Pin the dependency to an exact version.',
      fixable: false,
    }],
    summary: { findings: 1, critical: 0, high: 1, medium: 0, low: 0, ignored: 0 },
    ...overrides,
  };
}

describe('GitHub Actions presentation', () => {
  it('renders a scannable Markdown summary with gate and remediation context', () => {
    const cwd = '/workspace/project';
    const markdown = renderGitHubSummary(result(cwd), { cwd });
    expect(markdown).toMatch(/❌ \*\*Failed\*\*/);
    expect(markdown).toMatch(/\| Gate \| Severity \| Check \| Location \| Recommended action \|/);
    expect(markdown).toContain('`direct-deps-exact`');
    expect(markdown).toContain('package.json:8');
    expect(markdown).toContain('Pin the dependency to an exact version.');
  });

  it('emits escaped file-aware native annotations and respects the cap', () => {
    const cwd = '/workspace/project';
    const unsafe = result(cwd);
    unsafe.findings[0].explain = 'Pin 100% now\n::error injected';
    const annotations = renderGitHubAnnotations(unsafe, { cwd, maxAnnotations: 1 });
    expect(annotations.trim().split('\n')).toHaveLength(1);
    expect(annotations).toMatch(/^::error /);
    expect(annotations).toContain('file=package.json');
    expect(annotations).toContain('line=8');
    expect(annotations).toContain('100%25 now%0A::error injected');
  });

  it('uses repository-root paths when auditing a nested working directory', () => {
    const repositoryRoot = '/workspace/project';
    const cwd = join(repositoryRoot, 'packages', 'app');
    const annotations = renderGitHubAnnotations(result(cwd), {
      cwd,
      repositoryRoot,
      maxAnnotations: 1,
    });
    expect(annotations).toContain('file=packages/app/package.json');
  });

  it('bounds untrusted annotation and summary content', () => {
    const cwd = '/workspace/project';
    const large = result(cwd);
    large.findings[0].explain = `Review ${'x'.repeat(5000)}`;
    const annotations = renderGitHubAnnotations(large, { cwd });
    const markdown = renderGitHubSummary(large, { cwd });
    expect(annotations.length).toBeLessThan(1500);
    expect(markdown.length).toBeLessThan(5000);
    expect(annotations).toContain('…');
    expect(markdown).toContain('…');
  });

  it('annotates required evidence gaps even when there are no findings', () => {
    const cwd = '/workspace/project';
    const annotations = renderGitHubAnnotations(result(cwd, {
      findings: [],
      summary: { findings: 0, critical: 0, high: 0, medium: 0, low: 0, ignored: 0 },
      incomplete: [{ rule: 'lockfile-committed', reason: 'no-git-index' }],
    }), { cwd });
    expect(annotations).toContain('::error ');
    expect(annotations).toContain('evidence unavailable');
    expect(annotations).toContain('blocks the gate');
  });

  it('appends to a runner summary without following a symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dw-gh-summary-'));
    const summary = join(dir, 'summary.md');
    await appendGitHubStepSummary(summary, '## First');
    await appendGitHubStepSummary(summary, '## Second\n');
    expect(await readFile(summary, 'utf8')).toBe('## First\n## Second\n');

    const outside = join(dir, 'outside.md');
    const link = join(dir, 'linked-summary.md');
    await writeFile(outside, 'safe\n');
    await symlink(outside, link);
    await expect(appendGitHubStepSummary(link, 'unsafe')).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('safe\n');
  });
});
