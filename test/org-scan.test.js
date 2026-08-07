import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanGitHubOrganization } from '../src/commands/orgScan.js';

const PACKAGE_JSON = `${JSON.stringify({
  name: 'safe-service',
  version: '1.0.0',
  packageManager: 'npm@12.0.2',
  engines: { node: '>=24.15.0' },
  dependencies: {},
  devDependencies: {},
}, null, 2)}\n`;
const PACKAGE_LOCK = `${JSON.stringify({
  name: 'safe-service',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: { '': { name: 'safe-service', version: '1.0.0' } },
}, null, 2)}\n`;
const NPMRC = 'save-exact=true\nmin-release-age=7\nallow-git=none\nallow-remote=none\n';

describe('GitHub organization scan', () => {
  let cwd;
  beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'deps-org-scan-')); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it('scans relevant blobs, platform controls, and reuses code checks by tree SHA', async () => {
    const mock = githubMock({ files: {
      'package.json': PACKAGE_JSON,
      'package-lock.json': PACKAGE_LOCK,
      '.npmrc': NPMRC,
      'README.md': '# deliberately not downloaded\n',
    } });
    const first = await scanGitHubOrganization({ organization: 'example', cwd, client: mock.client });
    expect(first.status).toBe('OK');
    expect(first.policy).toBe('deps-warden-github-scan/v1/baseline');
    expect(first.scope).toMatchObject({ discovered: 1, selected: 1, cacheHits: 0 });
    expect(first.repositories[0]).toMatchObject({ name: 'safe-service', status: 'pass', evidence: 'complete' });
    expect(first.repositories[0].checks.find(item => item.id === 'deps/lockfile-committed').status).toBe('pass');
    expect(mock.blobPaths).not.toContain('README.md');
    const blobCount = mock.blobPaths.length;

    const second = await scanGitHubOrganization({ organization: 'example', cwd, client: mock.client });
    expect(second.scope.cacheHits).toBe(1);
    expect(mock.blobPaths).toHaveLength(blobCount);
  });

  it('falls back to a bounded non-recursive tree walk when GitHub truncates the recursive tree', async () => {
    const mock = githubMock({ files: {
      'package.json': PACKAGE_JSON,
      'package-lock.json': PACKAGE_LOCK,
      '.npmrc': NPMRC,
    }, truncated: true });
    const report = await scanGitHubOrganization({ organization: 'example', cwd, client: mock.client });
    const repository = report.repositories[0];
    expect(report.status).toBe('OK');
    expect(repository.status).toBe('pass');
    expect(repository.checks.find(item => item.id === 'github/evidence-complete')).toMatchObject({
      status: 'pass',
    });
    expect(mock.blobPaths).toHaveLength(3);
  });

  it('fails closed when the targeted tree walk exceeds its request bound', async () => {
    const mock = githubMock({ files: { 'services/api/package.json': PACKAGE_JSON }, truncated: true });
    const originalRequest = mock.client.request;
    mock.client.request = async path => {
      if (path.includes('/git/trees/') && !path.includes('?recursive=1')) {
        return { status: 200, data: { sha: 'root', truncated: false, tree: [
          { path: 'services', sha: 'services-tree', type: 'tree', mode: '040000' },
        ] } };
      }
      return originalRequest(path);
    };
    const report = await scanGitHubOrganization({ organization: 'example', cwd, client: mock.client, maxTreeRequests: 1 });
    expect(report.repositories[0].checks.find(item => item.id === 'github/evidence-complete')).toMatchObject({
      status: 'unknown',
      reason: 'targeted-tree-request-limit-exceeded',
    });
  });

  it('rejects unsafe tree paths before writing repository-controlled files', async () => {
    const mock = githubMock({ files: { '../package.json': PACKAGE_JSON } });
    const report = await scanGitHubOrganization({ organization: 'example', cwd, client: mock.client });
    expect(report.repositories[0].checks.find(item => item.id === 'github/evidence-complete')).toMatchObject({
      status: 'unknown',
      reason: 'unsafe-git-tree-path',
    });
    expect(mock.blobPaths).toHaveLength(0);
  });

  it('makes repository-owned suppressions visible and noncompliant', async () => {
    const mock = githubMock({ files: {
      'package.json': PACKAGE_JSON,
      'package-lock.json': PACKAGE_LOCK,
      '.npmrc': `${NPMRC}# deps-warden-ignore-file\n`,
    } });
    const report = await scanGitHubOrganization({ organization: 'example', cwd, client: mock.client });
    expect(report.repositories[0].checks.find(item => item.id === 'policy/suppressions-reviewed')).toMatchObject({
      status: 'fail',
      reason: 'suppression-governance-not-verifiable',
    });
  });

  it('fails the organization result when token-visible discovery is not the full inventory', async () => {
    const mock = githubMock({
      files: { 'package.json': PACKAGE_JSON, 'package-lock.json': PACKAGE_LOCK, '.npmrc': NPMRC },
      organizationRepositoryCount: 2,
    });
    const report = await scanGitHubOrganization({ organization: 'example', cwd, client: mock.client });
    expect(report.scope).toMatchObject({ discovered: 1, expected: 2, inventoryStatus: 'fail' });
    expect(report.status).toBe('FAIL');
  });

  it('gates organization-level Actions and reusable-workflow governance', async () => {
    const mock = githubMock({ files: { 'package.json': PACKAGE_JSON, 'package-lock.json': PACKAGE_LOCK, '.npmrc': NPMRC } });
    const originalRequest = mock.client.request;
    mock.client.request = async path => {
      if (path === '/orgs/example/actions/permissions') return { status: 200, data: { enabled_repositories: 'all', allowed_actions: 'all', sha_pinning_required: false } };
      if (path === '/orgs/example/actions/permissions/workflow') return { status: 200, data: { default_workflow_permissions: 'write', can_approve_pull_request_reviews: true } };
      return originalRequest(path);
    };
    const report = await scanGitHubOrganization({ organization: 'example', cwd, client: mock.client });
    expect(report.organizationStatus).toBe('fail');
    expect(report.organizationChecks.find(item => item.id === 'github-org/actions-sha-pinning-required')).toMatchObject({ status: 'fail', mandatory: true });
    expect(report.organizationChecks.find(item => item.id === 'github-org/reusable-workflows-governed')).toMatchObject({ status: 'fail' });
    expect(report.status).toBe('FAIL');
  });

  it('audits repositories whose Node projects exist only below the repository root', async () => {
    const mock = githubMock({ files: {
      'services/api/package.json': PACKAGE_JSON,
      'services/api/package-lock.json': PACKAGE_LOCK,
      'services/api/.npmrc': NPMRC,
    } });
    const report = await scanGitHubOrganization({ organization: 'example', cwd, client: mock.client });
    expect(report.status).toBe('OK');
    expect(report.repositories[0].checks.find(item => item.id === 'deps/ecosystem-supported')).toMatchObject({ status: 'pass' });
    expect(report.repositories[0].checks.find(item => item.id === 'deps/lockfile-committed')).toMatchObject({ status: 'pass' });
  });

  it('recognizes lockfile-enforcing dependency installs in GitHub Actions', async () => {
    const workflow = `name: CI\non: [push]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: env CI=1 npm --prefix services/api ci\n      - run: |\n          pnpm install \\\n            --frozen-lockfile\n      - run: yarn install --immutable\n      - run: bun install --frozen-lockfile\n`;
    const mock = githubMock({ files: {
      'package.json': PACKAGE_JSON,
      'package-lock.json': PACKAGE_LOCK,
      '.npmrc': NPMRC,
      '.github/workflows/ci.yml': workflow,
    } });
    const report = await scanGitHubOrganization({ organization: 'example', cwd, client: mock.client });
    expect(report.repositories[0].checks.find(item => item.id === 'github-actions/frozen-dependency-installs')).toMatchObject({ status: 'pass' });
  });

  it('reports mutable CI installs that can rewrite a lockfile', async () => {
    const workflow = `name: CI\non: [push]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm install\n`;
    const mock = githubMock({ files: {
      'package.json': PACKAGE_JSON,
      'package-lock.json': PACKAGE_LOCK,
      '.npmrc': NPMRC,
      '.github/workflows/ci.yml': workflow,
    } });
    const report = await scanGitHubOrganization({ organization: 'example', cwd, client: mock.client });
    expect(report.repositories[0].checks.find(item => item.id === 'github-actions/frozen-dependency-installs')).toMatchObject({
      status: 'fail',
      file: '.github/workflows/ci.yml',
      reason: '1-non-frozen-install',
    });
  });

  it('resumes completed repositories from a durable checkpoint after a partial scan', async () => {
    const mock = githubMock({ files: {
      'package.json': PACKAGE_JSON,
      'package-lock.json': PACKAGE_LOCK,
      '.npmrc': NPMRC,
    }, organizationRepositoryCount: 2 });
    const originalRequest = mock.client.request;
    mock.client.paginate = async () => [
      mock.repository,
      { ...mock.repository, name: 'incomplete-service', html_url: 'https://github.com/example/incomplete-service' },
    ];
    mock.client.request = async path => {
      if (path.includes('/incomplete-service/git/trees/')) {
        const tree = await originalRequest(path.replace('/incomplete-service/', '/safe-service/'));
        return path.includes('?recursive=1')
          ? { ...tree, data: { ...tree.data, truncated: true } }
          : { status: 409, data: null };
      }
      return originalRequest(path.replace('/incomplete-service/', '/safe-service/'));
    };

    const first = await scanGitHubOrganization({ organization: 'example', cwd, client: mock.client });
    expect(first.coverage.incomplete).toBe(1);
    const second = await scanGitHubOrganization({ organization: 'example', cwd, client: mock.client });
    expect(second.scope.checkpointHits).toBe(1);
    expect(second.coverage.incomplete).toBe(1);
  });
});

function githubMock({ files, truncated = false, organizationRepositoryCount = 1 }) {
  const encoded = Object.entries(files).map(([path, content], index) => ({
    path,
    content,
    sha: `blob-${index}`,
    size: Buffer.byteLength(content),
  }));
  const bySha = new Map(encoded.map(item => [item.sha, item]));
  const blobPaths = [];
  let requests = 0;
  const repository = {
    name: 'safe-service',
    html_url: 'https://github.com/example/safe-service',
    default_branch: 'main',
    visibility: 'private',
    archived: false,
    fork: false,
    size: 10,
    security_and_analysis: {
      secret_scanning: { status: 'enabled' },
      secret_scanning_push_protection: { status: 'enabled' },
      dependabot_security_updates: { status: 'enabled' },
      advanced_security: { status: 'enabled' },
    },
  };
  const client = {
    paginate: async () => [repository],
    request: async path => {
      requests += 1;
      if (path === '/orgs/example') return { status: 200, data: { public_repos: 0, total_private_repos: organizationRepositoryCount } };
      if (path === '/orgs/example/actions/permissions') return { status: 200, data: { enabled_repositories: 'all', allowed_actions: 'selected', sha_pinning_required: true } };
      if (path === '/orgs/example/actions/permissions/selected-actions') return { status: 200, data: { github_owned_allowed: true, verified_allowed: false, patterns_allowed: ['example/*@*'] } };
      if (path === '/orgs/example/actions/permissions/workflow') return { status: 200, data: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false } };
      if (path === '/repos/example/safe-service') return { status: 200, data: repository };
      if (path.includes('/branches/')) return { status: 200, data: { protected: true } };
      if (path.endsWith('/automated-security-fixes')) return { status: 200, data: { enabled: true, paused: false } };
      if (path.endsWith('/vulnerability-alerts')) return { status: 204, data: null };
      if (path.includes('/git/trees/')) {
        const recursive = path.includes('?recursive=1');
        return {
          status: 200,
          data: {
            sha: 'tree-unchanged',
            truncated: recursive && truncated,
            tree: encoded.map(item => ({ path: item.path, sha: item.sha, size: item.size, type: 'blob', mode: '100644' })),
          },
        };
      }
      const sha = decodeURIComponent(path.split('/').at(-1));
      const item = bySha.get(sha);
      if (!item) throw new Error(`unexpected GitHub mock request: ${path}`);
      blobPaths.push(item.path);
      return { status: 200, data: { encoding: 'base64', content: Buffer.from(item.content).toString('base64') } };
    },
    stats: () => ({ requests, rate: { limit: 5000, remaining: 4999, used: 1, resetAt: 1_800_000_000_000 } }),
  };
  return { client, blobPaths, repository };
}
