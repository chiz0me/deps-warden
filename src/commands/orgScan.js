/**
 * Read-only, resumable GitHub organization scanner.
 *
 * Discovery is paginated, repository work is bounded, and code checks are
 * cached by Git tree SHA. Repository content is materialized only in a
 * temporary directory and is parsed as data; project code is never executed.
 */

import { audit as auditActions, listRules as listActionRules, parseWorkflowFile } from 'actions-warden';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { audit } from './audit.js';
import { createGitHubClient } from '../lib/githubClient.js';
import { createOrgCache } from '../lib/orgCache.js';
import { applyOrgPolicy } from '../lib/orgPolicy.js';
import { createOrgReport, renderOrgReport } from '../lib/orgReport.js';
import { createScanCheckpoint, createScanFingerprint } from '../lib/scanCheckpoint.js';
import { RULES } from '../rules/index.js';

const VERSION_RULES = new Set(['outdated-major-deps', 'deprecated-dep-version', 'dep-below-release-age']);
const INSTALLED_RULES = new Set(['direct-deps-with-scripts', 'unused-allowlist-entries']);
const OPTIONAL_RULES = new Set([...VERSION_RULES, ...INSTALLED_RULES, 'recommend-stricter-pm']);
const ACTION_RULES = listActionRules().filter(rule => rule.id !== 'unpinned-action');
const ROOT_EVIDENCE = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  '.npmrc', '.yarnrc', '.yarnrc.yml', 'pnpm-workspace.yaml', 'bunfig.toml',
  '.pnpmfile.cjs', 'pnpmfile.cjs', '.deps-warden-ignore',
]);
const MAX_REPOSITORIES = 100_000;

/**
 * @param {object} options
 * @param {string} options.organization
 * @param {string} [options.token]
 * @param {() => Promise<string>} [options.tokenProvider]
 * @param {string} [options.cwd]
 * @param {string} [options.apiUrl]
 * @param {string} [options.apiVersion]
 * @param {number} [options.concurrency]
 * @param {number} [options.maxRepositories]
 * @param {number} [options.expectedRepositories]
 * @param {boolean} [options.includeArchived]
 * @param {boolean} [options.includeForks]
 * @param {string[]} [options.repositories]
 * @param {boolean} [options.cache]
 * @param {boolean} [options.refresh]
 * @param {boolean} [options.resume]
 * @param {string} [options.cacheDirectory]
 * @param {string} [options.checkpointDirectory]
 * @param {number} [options.checkpointTtlMs]
 * @param {number} [options.maxEvidenceFiles]
 * @param {number} [options.maxEvidenceBytes]
 * @param {number} [options.maxFileBytes]
 * @param {number} [options.maxTreeRequests]
 * @param {number} [options.maxTreeEntries]
 * @param {boolean} [options.checkVersions]
 * @param {'baseline'|'strict'} [options.profile]
 * @param {Array<object>} [options.exceptions]
 * @param {boolean} [options.waitForRateLimit]
 * @param {number} [options.rateLimitReserve]
 * @param {number} [options.minIntervalMs]
 * @param {typeof globalThis.fetch} [options.fetchImpl]
 * @param {(event: object) => void|Promise<void>} [options.onProgress]
 */
export async function scanGitHubOrganization(options) {
  const organization = validateGitHubName(options?.organization, 'organization');
  const cwd = resolve(options.cwd ?? process.cwd());
  const concurrency = integerOption(options.concurrency ?? 4, 'concurrency', 1, 12);
  const maxRepositories = integerOption(options.maxRepositories ?? MAX_REPOSITORIES, 'maxRepositories', 1, MAX_REPOSITORIES);
  const explicitExpected = options.expectedRepositories === undefined
    ? null
    : integerOption(options.expectedRepositories, 'expectedRepositories', 1, MAX_REPOSITORIES);
  const maxEvidenceFiles = integerOption(options.maxEvidenceFiles ?? 1_000, 'maxEvidenceFiles', 1, 10_000);
  const maxEvidenceBytes = integerOption(options.maxEvidenceBytes ?? 25 * 1024 * 1024, 'maxEvidenceBytes', 1_024, 250 * 1024 * 1024);
  const maxFileBytes = integerOption(options.maxFileBytes ?? 2 * 1024 * 1024, 'maxFileBytes', 1_024, 25 * 1024 * 1024);
  const maxTreeRequests = integerOption(options.maxTreeRequests ?? 1_000, 'maxTreeRequests', 1, 10_000);
  const maxTreeEntries = integerOption(options.maxTreeEntries ?? 250_000, 'maxTreeEntries', 1_000, 1_000_000);
  const client = options.client ?? createGitHubClient({
    token: options.token,
    tokenProvider: options.tokenProvider,
    fetchImpl: options.fetchImpl,
    baseUrl: options.apiUrl,
    apiVersion: options.apiVersion,
    waitForRateLimit: options.waitForRateLimit,
    rateLimitReserve: options.rateLimitReserve,
    minIntervalMs: options.minIntervalMs,
  });
  const cache = createOrgCache({
    cwd,
    directory: options.cacheDirectory,
    enabled: options.cache !== false,
  });

  const orgPath = `/orgs/${encodeURIComponent(organization)}`;
  const organizationMetadata = (await client.request(orgPath)).data;
  const organizationChecks = await githubOrganizationChecks(client, orgPath);
  const discovered = await client.paginate(`${orgPath}/repos?type=all&sort=full_name&direction=asc`);
  const inferredExpected = inferRepositoryCount(organizationMetadata);
  const expectedRepositories = explicitExpected ?? inferredExpected;
  const inventoryStatus = expectedRepositories === null
    ? 'unknown'
    : expectedRepositories === discovered.length ? 'pass' : 'fail';
  const requested = new Map((options.repositories ?? []).map(name => {
    const validated = validateGitHubName(name, 'repository');
    return [validated.toLowerCase(), validated];
  }));
  const filtered = discovered
    .filter(repository => requested.size === 0 || requested.has(String(repository.name).toLowerCase()))
    .filter(repository => options.includeArchived !== false || !repository.archived)
    .filter(repository => options.includeForks !== false || !repository.fork)
    .toSorted((left, right) => String(left.name).localeCompare(String(right.name)));
  if (requested.size > 0) {
    const found = new Set(filtered.map(repository => String(repository.name).toLowerCase()));
    const missing = [...requested].filter(([name]) => !found.has(name)).map(([, original]) => original);
    if (missing.length > 0) throw new Error(`requested repositories not found in organization: ${missing.join(', ')}`);
  }
  if (filtered.length > maxRepositories) {
    throw new Error(`organization has ${filtered.length} selected repositories, above --max-repos=${maxRepositories}`);
  }
  if (filtered.length === 0) throw new Error('no repositories matched the requested organization scan scope');

  const checkpointFingerprint = createScanFingerprint({
    organization: organization.toLowerCase(),
    repositories: filtered.map(repository => ({
      name: repository.name,
      defaultBranch: repository.default_branch ?? '',
      pushedAt: repository.pushed_at ?? '',
      updatedAt: repository.updated_at ?? '',
      archived: Boolean(repository.archived),
    })),
    checkVersions: Boolean(options.checkVersions),
    maxEvidenceFiles,
    maxEvidenceBytes,
    maxFileBytes,
    maxTreeRequests,
    maxTreeEntries,
  });
  const checkpoint = createScanCheckpoint({
    cwd,
    organization,
    fingerprint: checkpointFingerprint,
    directory: options.checkpointDirectory,
    enabled: options.resume !== false,
    ttlMs: options.checkpointTtlMs,
  });
  let checkpointErrors = 0;
  let checkpointResults;
  try { checkpointResults = await checkpoint.load(); }
  catch { checkpointErrors += 1; checkpointResults = new Map(); }

  let completed = 0;
  let cacheHits = 0;
  let checkpointHits = 0;
  const repositories = await mapLimit(filtered, concurrency, async repository => {
    await options.onProgress?.({ type: 'repository-start', repository: repository.name, completed, total: filtered.length });
    const resumed = checkpointResults.get(repository.name);
    if (resumed) {
      checkpointHits += 1;
      completed += 1;
      let refreshed = resumed;
      try {
        const defaultBranch = typeof repository.default_branch === 'string' ? repository.default_branch : '';
        const prefix = `/repos/${encodeURIComponent(organization)}/${encodeURIComponent(repository.name)}`;
        const platformChecks = await githubPlatformChecks(client, prefix, repository, defaultBranch);
        refreshed = {
          ...repositoryMetadata(repository, resumed),
          checks: [...platformChecks, ...resumed.checks.filter(item => item.category !== 'repository-settings')],
        };
      } catch (error) {
        refreshed = failedRepository(repository, error).repository;
      }
      await options.onProgress?.({ type: 'repository-complete', repository: repository.name, completed, total: filtered.length, resumed: true });
      return refreshed;
    }
    let result;
    try {
      result = await scanRepository({
        organization,
        repository,
        client,
        cache,
        refresh: Boolean(options.refresh),
        maxEvidenceFiles,
        maxEvidenceBytes,
        maxFileBytes,
        maxTreeRequests,
        maxTreeEntries,
        checkVersions: Boolean(options.checkVersions),
      });
      if (result.cacheHit) cacheHits += 1;
    } catch (error) {
      result = failedRepository(repository, error);
    }
    if (checkpointable(result.repository)) {
      try { await checkpoint.record(result.repository); }
      catch { checkpointErrors += 1; }
    }
    completed += 1;
    await options.onProgress?.({ type: 'repository-complete', repository: repository.name, completed, total: filtered.length });
    return result.repository;
  });

  const profile = options.profile ?? 'baseline';
  const governed = applyOrgPolicy({
    organizationChecks,
    repositories,
    knownRepositories: discovered.map(repository => repository.name),
    profile,
    exceptions: options.exceptions ?? [],
  });
  const report = createOrgReport({
    organization,
    policy: `deps-warden-github-scan/v1/${profile}`,
    organizationChecks: governed.organizationChecks,
    repositories: governed.repositories,
    exceptions: governed.exceptions,
    scope: {
      discovered: discovered.length,
      selected: filtered.length,
      expected: expectedRepositories,
      inventoryStatus,
      includeArchived: options.includeArchived !== false,
      includeForks: options.includeForks !== false,
      cacheEnabled: options.cache !== false,
      cacheHits,
      resumeEnabled: options.resume !== false,
      checkpointHits,
      checkpointErrors,
      authentication: options.tokenProvider ? 'github-app' : 'token',
    },
    api: client.stats(),
  });
  if (report.coverage.incomplete === 0) {
    try { await checkpoint.clear(); }
    catch { /* checkpoint cleanup must not invalidate completed evidence */ }
  }
  return report;
}

async function githubOrganizationChecks(client, orgPath) {
  const permissions = await client.request(`${orgPath}/actions/permissions`, { allowStatuses: [403, 404] });
  if (permissions.status !== 200 || !permissions.data) {
    const reason = permissions.status === 403 ? 'organization-administration-read-permission-required' : 'organization-actions-policy-unavailable';
    return [
      check('github-org/actions-allow-policy-restricted', 'organization-actions', 'unknown', 'high', true, 'github', reason),
      check('github-org/actions-sha-pinning-required', 'organization-actions', 'unknown', 'critical', true, 'github', reason),
      check('github-org/reusable-workflows-governed', 'organization-actions', 'unknown', 'high', true, 'github', reason),
      check('github-org/default-workflow-token-read-only', 'organization-actions', 'unknown', 'high', true, 'github', reason),
      check('github-org/workflows-cannot-approve-pull-requests', 'organization-actions', 'unknown', 'high', true, 'github', reason),
    ];
  }

  const allowedActions = permissions.data.allowed_actions;
  const checks = [check(
    'github-org/actions-allow-policy-restricted',
    'organization-actions',
    ['local_only', 'selected'].includes(allowedActions) ? 'pass' : 'fail',
    'high',
    true,
    'github',
    ['local_only', 'selected'].includes(allowedActions) ? '' : 'all-actions-and-reusable-workflows-allowed',
    '',
    'Set the organization Actions policy to local-only or an explicitly selected allowlist.',
    { allowedActions: typeof allowedActions === 'string' ? allowedActions : null },
  )];
  const shaPinning = permissions.data.sha_pinning_required;
  checks.push(check(
    'github-org/actions-sha-pinning-required',
    'organization-actions',
    shaPinning === true ? 'pass' : shaPinning === false ? 'fail' : 'unknown',
    'critical',
    true,
    'github',
    shaPinning === true ? '' : shaPinning === false ? 'organization-does-not-require-full-action-shas' : 'sha-pinning-policy-unavailable',
    '',
    'Require actions to be pinned to a full-length commit SHA in organization Actions settings.',
  ));

  if (allowedActions === 'selected') {
    const selected = await client.request(`${orgPath}/actions/permissions/selected-actions`, { allowStatuses: [403, 404] });
    if (selected.status !== 200 || !selected.data) {
      checks.push(check('github-org/reusable-workflows-governed', 'organization-actions', 'unknown', 'high', true, 'github', 'selected-actions-policy-unavailable'));
    } else {
      const patterns = Array.isArray(selected.data.patterns_allowed)
        ? selected.data.patterns_allowed.filter(pattern => typeof pattern === 'string')
        : [];
      const unrestricted = selected.data.verified_allowed === true || patterns.some(isUnrestrictedActionPattern);
      checks.push(check(
        'github-org/reusable-workflows-governed',
        'organization-actions',
        unrestricted ? 'fail' : 'pass',
        'high',
        true,
        'github',
        unrestricted ? 'selected-policy-allows-unbounded-third-party-publishers' : '',
        '',
        'Disable the blanket verified-publisher allowance and replace global wildcards with reviewed owner/repository patterns.',
        { githubOwnedAllowed: selected.data.github_owned_allowed === true, verifiedAllowed: selected.data.verified_allowed === true, patterns },
      ));
    }
  } else {
    checks.push(check(
      'github-org/reusable-workflows-governed',
      'organization-actions',
      allowedActions === 'local_only' ? 'pass' : 'fail',
      'high',
      true,
      'github',
      allowedActions === 'local_only' ? '' : 'actions-and-reusable-workflows-unrestricted',
      '',
      'Restrict reusable workflows to local code or a reviewed selected allowlist.',
    ));
  }

  const workflow = await client.request(`${orgPath}/actions/permissions/workflow`, { allowStatuses: [403, 404] });
  if (workflow.status !== 200 || !workflow.data) {
    const reason = workflow.status === 403 ? 'organization-administration-read-permission-required' : 'default-workflow-permissions-unavailable';
    checks.push(check('github-org/default-workflow-token-read-only', 'organization-actions', 'unknown', 'high', true, 'github', reason));
    checks.push(check('github-org/workflows-cannot-approve-pull-requests', 'organization-actions', 'unknown', 'high', true, 'github', reason));
  } else {
    const readOnly = workflow.data.default_workflow_permissions === 'read';
    checks.push(check('github-org/default-workflow-token-read-only', 'organization-actions', readOnly ? 'pass' : 'fail', 'high', true, 'github', readOnly ? '' : 'default-workflow-token-has-write-access', '', 'Set default GITHUB_TOKEN workflow permissions to read-only.'));
    const cannotApprove = workflow.data.can_approve_pull_request_reviews === false;
    checks.push(check('github-org/workflows-cannot-approve-pull-requests', 'organization-actions', cannotApprove ? 'pass' : 'fail', 'high', true, 'github', cannotApprove ? '' : 'workflows-can-approve-pull-requests', '', 'Disable permission for GitHub Actions to create or approve pull request reviews.'));
  }
  return checks;
}

function isUnrestrictedActionPattern(pattern) {
  return ['*', '*/*', '*/*@*'].includes(pattern.trim());
}

function checkpointable(repository) {
  return repository.checks.every(item => item.mandatory === false
    || !['unknown', 'skipped'].includes(item.status));
}

async function scanRepository({ organization, repository: listed, client, cache, refresh, maxEvidenceFiles, maxEvidenceBytes, maxFileBytes, maxTreeRequests, maxTreeEntries, checkVersions }) {
  const owner = encodeURIComponent(organization);
  const name = validateGitHubName(listed.name, 'repository');
  const encodedName = encodeURIComponent(name);
  const prefix = `/repos/${owner}/${encodedName}`;
  const defaultBranch = typeof listed.default_branch === 'string' ? listed.default_branch : '';
  const platformChecks = await githubPlatformChecks(client, prefix, listed, defaultBranch);
  const metadata = repositoryMetadata(listed, listed);

  if (defaultBranch === '' || Number(listed.size) === 0) {
    return {
      cacheHit: false,
      repository: { ...metadata, checks: [...platformChecks, ...emptyCodeChecks()] },
    };
  }

  const treeResult = await fetchRepositoryTree({ client, prefix, defaultBranch, maxTreeRequests, maxTreeEntries });
  if (!treeResult.complete) {
    return {
      cacheHit: false,
      repository: { ...metadata, checks: [...platformChecks, ...unavailableCodeChecks(treeResult.reason)] },
    };
  }

  const treeSha = treeResult.sha;
  const cacheKey = treeSha === '' ? '' : `${treeSha}.${checkVersions ? 'registry' : 'offline'}`;
  if (!refresh && treeSha !== '') {
    const cached = await cache.read(organization, name, cacheKey);
    if (cached) return { cacheHit: true, repository: { ...metadata, checks: [...platformChecks, ...cached] } };
  }

  const selection = selectEvidence(treeResult.tree, { maxEvidenceFiles, maxEvidenceBytes, maxFileBytes });
  if (!selection.complete) {
    return {
      cacheHit: false,
      repository: { ...metadata, checks: [...platformChecks, ...unavailableCodeChecks(selection.reason)] },
    };
  }

  const temporary = await mkdtemp(join(tmpdir(), 'deps-warden-org-'));
  let codeChecks;
  try {
    await mapLimit(selection.files, 6, file => materializeBlob(client, prefix, temporary, file, maxFileBytes));
    codeChecks = await codeSecurityChecks({
      cwd: temporary,
      tracked: new Set(treeResult.tree.filter(item => item?.type === 'blob').map(item => item.path)),
      nodeProjectRoots: selection.nodeProjectRoots,
      checkVersions,
      evidencePaths: selection.files.map(file => file.path),
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  if (treeSha !== '') await cache.write(organization, name, cacheKey, codeChecks);
  return { cacheHit: false, repository: { ...metadata, checks: [...platformChecks, ...codeChecks] } };
}

async function fetchRepositoryTree({ client, prefix, defaultBranch, maxTreeRequests, maxTreeEntries }) {
  const recursive = await client.request(`${prefix}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`, { allowStatuses: [404, 409] });
  if (recursive.status !== 200 || !recursive.data || !Array.isArray(recursive.data.tree)) {
    return { complete: false, reason: 'git-tree-unavailable', tree: [], sha: '' };
  }
  if (!recursive.data.truncated) {
    return { complete: true, tree: recursive.data.tree, sha: String(recursive.data.sha ?? '') };
  }

  const rootReference = typeof recursive.data.sha === 'string' && recursive.data.sha !== '' ? recursive.data.sha : defaultBranch;
  const root = await client.request(`${prefix}/git/trees/${encodeURIComponent(rootReference)}`, { allowStatuses: [404, 409] });
  if (root.status !== 200 || !root.data || !Array.isArray(root.data.tree) || root.data.truncated) {
    return { complete: false, reason: 'truncated-tree-fallback-unavailable', tree: [], sha: '' };
  }
  const collected = [];
  const queue = [{ path: '', entries: root.data.tree }];
  let requests = 1;
  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    for (const entry of current.entries) {
      const path = current.path === '' ? entry.path : `${current.path}/${entry.path}`;
      if (!safeRepositoryPath(path)) return { complete: false, reason: 'unsafe-git-tree-path', tree: [], sha: '' };
      const normalized = { ...entry, path };
      collected.push(normalized);
      if (collected.length > maxTreeEntries) {
        return { complete: false, reason: 'targeted-tree-entry-limit-exceeded', tree: [], sha: '' };
      }
      if (entry.type !== 'tree' || skipTreeDirectory(entry.path)) continue;
      if (typeof entry.sha !== 'string' || entry.sha === '') {
        return { complete: false, reason: 'targeted-subtree-unavailable', tree: [], sha: '' };
      }
      if (requests >= maxTreeRequests) {
        return { complete: false, reason: 'targeted-tree-request-limit-exceeded', tree: [], sha: '' };
      }
      const subtree = await client.request(`${prefix}/git/trees/${encodeURIComponent(entry.sha)}`, { allowStatuses: [404, 409] });
      requests += 1;
      if (subtree.status !== 200 || !subtree.data || !Array.isArray(subtree.data.tree) || subtree.data.truncated) {
        return { complete: false, reason: 'targeted-subtree-unavailable', tree: [], sha: '' };
      }
      queue.push({ path, entries: subtree.data.tree });
    }
  }
  return { complete: true, tree: collected, sha: String(root.data.sha ?? recursive.data.sha ?? '') };
}

function skipTreeDirectory(name) {
  return ['node_modules', '.git', '.deps-warden-cache'].includes(name);
}

async function githubPlatformChecks(client, prefix, repository, defaultBranch) {
  const checks = [];
  if (defaultBranch === '') {
    checks.push(check('github/default-branch-protected', 'repository-settings', 'not_applicable', 'high', true, 'github', 'empty-repository'));
  } else {
    const branch = await client.request(`${prefix}/branches/${encodeURIComponent(defaultBranch)}`, { allowStatuses: [404] });
    checks.push(branch.status === 200
      ? check('github/default-branch-protected', 'repository-settings', branch.data?.protected ? 'pass' : 'fail', 'high', true, 'github', branch.data?.protected ? '' : 'default-branch-is-unprotected', '', 'Enable branch protection or a ruleset for the default branch.')
      : check('github/default-branch-protected', 'repository-settings', 'unknown', 'high', true, 'github', 'branch-protection-unavailable'));
  }

  const security = repository.security_and_analysis;
  checks.push(settingCheck(security, 'secret_scanning', 'github/secret-scanning', true));
  checks.push(settingCheck(security, 'secret_scanning_push_protection', 'github/secret-scanning-push-protection', true));
  checks.push(settingCheck(security, 'advanced_security', 'github/advanced-security', false));
  const dependabot = await client.request(`${prefix}/automated-security-fixes`, { allowStatuses: [403, 404] });
  if (dependabot.status === 200) {
    const enabled = dependabot.data?.enabled === true && dependabot.data?.paused !== true;
    checks.push(check('github/dependabot-security-updates', 'repository-settings', enabled ? 'pass' : 'fail', 'high', true, 'github', enabled ? '' : 'dependabot-security-updates-paused-or-disabled', '', 'Enable and unpause Dependabot security updates.'));
  } else if (dependabot.status === 404) {
    checks.push(check('github/dependabot-security-updates', 'repository-settings', 'fail', 'high', true, 'github', 'dependabot-security-updates-disabled', '', 'Enable Dependabot security updates.'));
  } else {
    checks.push(check('github/dependabot-security-updates', 'repository-settings', 'unknown', 'high', true, 'github', 'administration-read-permission-required'));
  }
  const alerts = await client.request(`${prefix}/vulnerability-alerts`, { allowStatuses: [403, 404] });
  checks.push(alerts.status === 204
    ? check('github/dependency-vulnerability-alerts', 'repository-settings', 'pass', 'high', true, 'github')
    : alerts.status === 404
      ? check('github/dependency-vulnerability-alerts', 'repository-settings', 'fail', 'high', true, 'github', 'dependency-vulnerability-alerts-disabled', '', 'Enable the dependency graph and Dependabot vulnerability alerts.')
      : check('github/dependency-vulnerability-alerts', 'repository-settings', 'unknown', 'high', true, 'github', 'administration-read-permission-required'));
  return checks;
}

function settingCheck(settings, field, id, mandatory) {
  const status = settings?.[field]?.status;
  if (status === 'enabled') return check(id, 'repository-settings', 'pass', 'high', mandatory, 'github');
  if (status === 'disabled') {
    return check(id, 'repository-settings', 'fail', 'high', mandatory, 'github', `${field}-disabled`, '', `Enable ${field.replaceAll('_', ' ')} in repository security settings.`);
  }
  return check(id, 'repository-settings', 'unknown', 'high', mandatory, 'github', `${field}-status-unavailable`);
}

async function codeSecurityChecks({ cwd, tracked, nodeProjectRoots, checkVersions, evidencePaths }) {
  const evidence = [check('github/evidence-complete', 'scan-coverage', 'pass', 'critical', true, 'github-tree')];
  const depsChecks = nodeProjectRoots.length > 0
    ? await dependencyChecks({ cwd, tracked, checkVersions, projectRoots: nodeProjectRoots })
    : [
        check('deps/ecosystem-supported', 'dependency-security', 'not_applicable', 'high', true, 'deps-warden', 'no-node-project'),
        ...RULES.map(rule => check(`deps/${rule.id}`, 'dependency-security', 'not_applicable', rule.severity, !OPTIONAL_RULES.has(rule.id), 'deps-warden', 'no-node-project')),
      ];
  const actionChecks = await githubActionChecks(cwd);
  const suppressions = await suppressionCheck(cwd, evidencePaths);
  return [...evidence, suppressions, ...depsChecks, ...actionChecks];
}

async function suppressionCheck(cwd, evidencePaths) {
  const hits = [];
  for (const path of evidencePaths) {
    const source = await readFile(join(cwd, path), 'utf8');
    if (path === '.deps-warden-ignore') {
      const entries = source.split('\n').filter(line => line.trim() !== '' && !line.trim().startsWith('#'));
      if (entries.length > 0) hits.push({ file: path, count: entries.length });
      continue;
    }
    const count = source.split('\n').filter(line => /(?:deps-warden|dw)-ignore(?:\b|[-:])/i.test(line)).length;
    if (count > 0) hits.push({ file: path, count });
  }
  if (hits.length === 0) return check('policy/suppressions-reviewed', 'policy-governance', 'pass', 'high', true, 'deps-warden');
  return check(
    'policy/suppressions-reviewed',
    'policy-governance',
    'fail',
    'high',
    true,
    'deps-warden',
    'suppression-governance-not-verifiable',
    hits[0].file,
    'Remove the suppression or record its owner, reason, approval, and expiry in an externally enforced exception system.',
    { files: hits.length, entries: hits.reduce((total, item) => total + item.count, 0) },
  );
}

async function dependencyChecks({ cwd, tracked, checkVersions, projectRoots }) {
  const projectChecks = await mapLimit(projectRoots, Math.min(4, projectRoots.length), projectRoot => dependencyChecksForProject({
    cwd: projectRoot === '.' ? cwd : join(cwd, projectRoot),
    tracked: trackedForProject(tracked, projectRoot),
    checkVersions,
    projectRoot,
  }));
  return mergeProjectChecks(projectChecks);
}

async function dependencyChecksForProject({ cwd, tracked, checkVersions, projectRoot }) {
  const result = await audit({
    cwd,
    reportLevel: 'low',
    failLevel: 'low',
    explain: true,
    requireComplete: false,
    networkMode: checkVersions ? 'registry' : 'off',
    gitTrackedOverride: tracked,
  });
  const skipped = new Map(result.skipped.map(item => [item.rule, item.reason]));
  const ecosystemSupported = ['npm', 'pnpm'].includes(result.pm.kind);
  const checks = [check(
    'deps/ecosystem-supported',
    'dependency-security',
    ecosystemSupported ? 'pass' : 'unsupported',
    'high',
    true,
    'deps-warden',
    ecosystemSupported ? '' : `${result.pm.kind}-adapter-not-implemented`,
  )];
  checks.push(...RULES.map(rule => {
    const mandatory = !OPTIONAL_RULES.has(rule.id);
    if (VERSION_RULES.has(rule.id) && !checkVersions) {
      return check(`deps/${rule.id}`, 'dependency-security', 'not_applicable', rule.severity, false, 'deps-warden', 'version-checks-disabled');
    }
    if (INSTALLED_RULES.has(rule.id)) {
      return check(`deps/${rule.id}`, 'dependency-security', 'unknown', rule.severity, false, 'deps-warden', 'installed-package-metadata-unavailable');
    }
    const ruleErrors = result.findings.filter(finding => finding.ruleId === 'rule-error' && finding.fields?.rule === rule.id);
    if (ruleErrors.length > 0) {
      return check(`deps/${rule.id}`, 'dependency-security', 'unknown', rule.severity, mandatory, 'deps-warden', 'rule-execution-error');
    }
    const findings = result.findings
      .filter(finding => finding.ruleId === rule.id)
      .map(finding => prefixProjectFinding(finding, projectRoot));
    if (findings.length > 0) return findingCheck(`deps/${rule.id}`, 'dependency-security', highestSeverity(findings, rule.severity), mandatory, 'deps-warden', findings);
    if (skipped.has(rule.id)) {
      return check(`deps/${rule.id}`, 'dependency-security', 'not_applicable', rule.severity, mandatory, 'deps-warden', skipped.get(rule.id));
    }
    return check(`deps/${rule.id}`, 'dependency-security', 'pass', rule.severity, mandatory, 'deps-warden');
  }));
  return checks;
}

function trackedForProject(tracked, projectRoot) {
  if (projectRoot === '.') return tracked;
  const prefix = `${projectRoot}/`;
  return new Set([...tracked]
    .filter(path => path.startsWith(prefix))
    .map(path => path.slice(prefix.length)));
}

function prefixProjectFinding(finding, projectRoot) {
  if (projectRoot === '.') return finding;
  const file = typeof finding.fields?.file === 'string' && finding.fields.file !== '.'
    ? `${projectRoot}/${finding.fields.file}`
    : projectRoot;
  return { ...finding, fields: { ...finding.fields, file } };
}

function mergeProjectChecks(projectChecks) {
  const byId = new Map();
  for (const checks of projectChecks) {
    for (const item of checks) {
      const group = byId.get(item.id) ?? [];
      group.push(item);
      byId.set(item.id, group);
    }
  }
  return [...byId.values()].map(group => {
    const selected = selectMergedCheck(group);
    const evidence = group.map(item => item.evidence).filter(Boolean);
    return {
      ...selected,
      reason: [...new Set(group.map(item => item.reason).filter(Boolean))].join(','),
      evidence: mergeCheckEvidence(evidence),
    };
  });
}

function selectMergedCheck(group) {
  const precedence = ['fail', 'unknown', 'skipped', 'unsupported', 'pass', 'not_applicable'];
  for (const status of precedence) {
    const match = group.find(item => item.status === status);
    if (match) return match;
  }
  return group[0];
}

function mergeCheckEvidence(evidence) {
  if (evidence.length === 0) return null;
  const findingIds = [...new Set(evidence.flatMap(item => Array.isArray(item.findingIds) ? item.findingIds : []))].slice(0, 20);
  return {
    projects: evidence.length,
    count: evidence.reduce((total, item) => total + (Number.isInteger(item.count) ? item.count : 0), 0),
    findingIds,
  };
}

function highestSeverity(findings, fallback) {
  const order = ['low', 'medium', 'high', 'critical'];
  return findings.reduce((highest, finding) => order.indexOf(finding.severity) > order.indexOf(highest) ? finding.severity : highest, fallback);
}

async function githubActionChecks(cwd) {
  const result = await auditActions({ cwd, severity: 'low', explain: true });
  if (result.files.length === 0) {
    return [
      ...ACTION_RULES.map(rule => check(`github-actions/${rule.id}`, 'github-actions', 'not_applicable', rule.severity, true, 'actions-warden', 'no-github-actions')),
      check('github-actions/frozen-dependency-installs', 'github-actions', 'not_applicable', 'high', true, 'deps-warden', 'no-github-actions'),
      check('github-actions/workflows-valid', 'github-actions', 'not_applicable', 'high', true, 'actions-warden', 'no-github-actions'),
    ];
  }
  const output = ACTION_RULES.map(rule => {
    const findings = result.findings.filter(finding => finding.ruleId === rule.id);
    return findings.length > 0
      ? findingCheck(`github-actions/${rule.id}`, 'github-actions', rule.severity, true, 'actions-warden', findings, cwd)
      : check(`github-actions/${rule.id}`, 'github-actions', 'pass', rule.severity, true, 'actions-warden');
  });
  const parseErrors = result.findings.filter(finding => finding.ruleId === 'parse-error');
  output.push(parseErrors.length > 0
    ? findingCheck('github-actions/workflows-valid', 'github-actions', 'high', true, 'actions-warden', parseErrors, cwd)
    : check('github-actions/workflows-valid', 'github-actions', 'pass', 'high', true, 'actions-warden'));
  output.push(await frozenDependencyInstallCheck(result.files, cwd));
  return output;
}

async function frozenDependencyInstallCheck(files, cwd) {
  const installs = [];
  for (const file of files) {
    let document;
    try { document = await parseWorkflowFile(file); }
    catch { continue; }
    const steps = [
      ...document.jobs.flatMap(job => job.steps),
      ...document.actionSteps,
    ];
    for (const step of steps) {
      if (typeof step.run !== 'string') continue;
      for (const command of shellCommandSegments(step.run)) {
        const install = classifyFrozenInstall(command);
        if (install) installs.push({ ...install, file: relative(cwd, file), line: step.line });
      }
    }
  }
  if (installs.length === 0) {
    return check('github-actions/frozen-dependency-installs', 'github-actions', 'not_applicable', 'high', true, 'deps-warden', 'no-dependency-install-command');
  }
  const unsafe = installs.filter(item => !item.frozen);
  if (unsafe.length === 0) {
    return check('github-actions/frozen-dependency-installs', 'github-actions', 'pass', 'high', true, 'deps-warden', '', '', '', {
      installs: installs.length,
      packageManagers: [...new Set(installs.map(item => item.packageManager))].toSorted(),
    });
  }
  return check(
    'github-actions/frozen-dependency-installs',
    'github-actions',
    'fail',
    'high',
    true,
    'deps-warden',
    `${unsafe.length}-non-frozen-install${unsafe.length === 1 ? '' : 's'}`,
    unsafe[0].file,
    'Use npm ci, pnpm install --frozen-lockfile, yarn install --immutable (or --frozen-lockfile for Yarn Classic), or bun install --frozen-lockfile.',
    { installs: installs.length, unsafe: unsafe.length, packageManagers: [...new Set(unsafe.map(item => item.packageManager))].toSorted() },
    unsafe[0].line,
  );
}

function shellCommandSegments(run) {
  return run.replace(/\\\r?\n/g, ' ')
    .split(/\r?\n|&&|\|\||;/)
    .map(command => command.trim())
    .filter(command => command !== '' && !command.startsWith('#'));
}

function classifyFrozenInstall(command) {
  let normalized = command.trim();
  normalized = normalized.replace(/^env\s+/, '');
  normalized = normalized.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, '');
  normalized = normalized.replace(/^command\s+/, '');
  normalized = normalized.replace(/^sudo(?:\s+-\S+)*\s+/, '');
  const npm = /^npm(?:\s+--(?:prefix|workspace|userconfig|cache)(?:=\S+|\s+\S+))*\s+(ci|install|i)(?:\s|$)/.exec(normalized);
  if (npm) return { packageManager: 'npm', frozen: npm[1] === 'ci' };
  if (/^(?:corepack\s+)?pnpm(?:\s+--(?:dir|filter)(?:=\S+|\s+\S+)|\s+--workspace-root)*\s+(?:install|i)(?:\s|$)/.test(normalized)) {
    return { packageManager: 'pnpm', frozen: /(?:^|\s)--frozen-lockfile(?:=true)?(?:\s|$)/.test(normalized) };
  }
  if (/^(?:corepack\s+)?yarn\s+install(?:\s|$)/.test(normalized)) {
    return { packageManager: 'yarn', frozen: /(?:^|\s)--(?:immutable|frozen-lockfile)(?:=true)?(?:\s|$)/.test(normalized) };
  }
  if (/^bun\s+install(?:\s|$)/.test(normalized)) {
    return { packageManager: 'bun', frozen: /(?:^|\s)--frozen-lockfile(?:=true)?(?:\s|$)/.test(normalized) };
  }
  return null;
}

function selectEvidence(tree, limits) {
  const selected = [];
  const seen = new Set();
  let bytes = 0;
  const packageJsonPaths = [];
  const nodeEvidenceRoots = new Set();
  for (const item of tree) {
    if (item?.type !== 'blob') continue;
    if (!safeRepositoryPath(item.path)) return { complete: false, reason: 'unsafe-git-tree-path', files: [] };
    if (item.mode === '120000') {
      if (isEvidencePath(item.path)) return { complete: false, reason: 'security-evidence-is-symlink', files: [] };
      continue;
    }
    if (!isEvidencePath(item.path)) continue;
    if (seen.has(item.path)) return { complete: false, reason: 'duplicate-git-tree-path', files: [] };
    seen.add(item.path);
    const size = Number(item.size);
    if (!Number.isSafeInteger(size) || size < 0) return { complete: false, reason: 'git-blob-size-unavailable', files: [] };
    if (size > limits.maxFileBytes) return { complete: false, reason: 'evidence-file-too-large', files: [] };
    bytes += size;
    if (bytes > limits.maxEvidenceBytes) return { complete: false, reason: 'evidence-byte-limit-exceeded', files: [] };
    selected.push({ path: item.path, sha: item.sha, size });
    if (item.path === 'package.json' || item.path.endsWith('/package.json')) packageJsonPaths.push(item.path);
    if (baseName(item.path) !== '.deps-warden-ignore' && ROOT_EVIDENCE.has(baseName(item.path))) {
      nodeEvidenceRoots.add(dirname(item.path));
    }
    if (selected.length > limits.maxEvidenceFiles) return { complete: false, reason: 'evidence-file-limit-exceeded', files: [] };
  }
  const nodeProjectRoots = packageJsonPaths.includes('package.json')
    ? ['.']
    : [...new Set([...packageJsonPaths.map(path => dirname(path)), ...nodeEvidenceRoots])].toSorted();
  return { complete: true, files: selected, nodeProjectRoots };
}

function isEvidencePath(path) {
  const parts = path.split('/');
  const base = parts.at(-1);
  if (parts.includes('node_modules') || parts.includes('.git')) return false;
  if (base === 'package.json' || base === '.npmrc' || base === '.yarnrc' || base === '.yarnrc.yml') return true;
  if (ROOT_EVIDENCE.has(base)) return true;
  if ((base === 'action.yml' || base === 'action.yaml')) return true;
  return parts.length === 3 && parts[0] === '.github' && parts[1] === 'workflows' && /\.ya?ml$/i.test(base);
}

function baseName(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

async function materializeBlob(client, prefix, temporary, file, maxFileBytes) {
  const result = await client.request(`${prefix}/git/blobs/${encodeURIComponent(file.sha)}`);
  if (result.data?.encoding !== 'base64' || typeof result.data.content !== 'string') {
    throw new Error(`unsupported Git blob encoding for ${file.path}`);
  }
  const content = Buffer.from(result.data.content.replace(/\s/g, ''), 'base64');
  if (content.byteLength > maxFileBytes || content.byteLength !== file.size) {
    throw new Error(`Git blob size mismatch for ${file.path}`);
  }
  const destination = join(temporary, file.path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, { mode: 0o600 });
}

function unavailableCodeChecks(reason) {
  return [
    check('github/evidence-complete', 'scan-coverage', 'unknown', 'critical', true, 'github-tree', reason),
    check('policy/suppressions-reviewed', 'policy-governance', 'skipped', 'high', true, 'deps-warden', reason),
    check('deps/ecosystem-supported', 'dependency-security', 'skipped', 'high', true, 'deps-warden', reason),
    ...RULES.map(rule => check(`deps/${rule.id}`, 'dependency-security', 'skipped', rule.severity, !OPTIONAL_RULES.has(rule.id), 'deps-warden', reason)),
    ...ACTION_RULES.map(rule => check(`github-actions/${rule.id}`, 'github-actions', 'skipped', rule.severity, true, 'actions-warden', reason)),
    check('github-actions/frozen-dependency-installs', 'github-actions', 'skipped', 'high', true, 'deps-warden', reason),
    check('github-actions/workflows-valid', 'github-actions', 'skipped', 'high', true, 'actions-warden', reason),
  ];
}

function emptyCodeChecks() {
  return [
    check('github/evidence-complete', 'scan-coverage', 'pass', 'critical', true, 'github-tree', 'empty-repository'),
    check('policy/suppressions-reviewed', 'policy-governance', 'not_applicable', 'high', true, 'deps-warden', 'empty-repository'),
    check('deps/ecosystem-supported', 'dependency-security', 'not_applicable', 'high', true, 'deps-warden', 'empty-repository'),
    ...RULES.map(rule => check(`deps/${rule.id}`, 'dependency-security', 'not_applicable', rule.severity, !OPTIONAL_RULES.has(rule.id), 'deps-warden', 'empty-repository')),
    ...ACTION_RULES.map(rule => check(`github-actions/${rule.id}`, 'github-actions', 'not_applicable', rule.severity, true, 'actions-warden', 'empty-repository')),
    check('github-actions/frozen-dependency-installs', 'github-actions', 'not_applicable', 'high', true, 'deps-warden', 'empty-repository'),
    check('github-actions/workflows-valid', 'github-actions', 'not_applicable', 'high', true, 'actions-warden', 'empty-repository'),
  ];
}

function findingCheck(id, category, severity, mandatory, source, findings, cwd = '') {
  const first = findings[0];
  const file = typeof first.fields?.file === 'string'
    ? first.fields.file
    : (cwd && typeof first.file === 'string' ? relative(cwd, first.file) : '');
  return check(id, category, 'fail', severity, mandatory, source, `${findings.length}-finding${findings.length === 1 ? '' : 's'}`, file, first.explain ?? '', {
    count: findings.length,
    findingIds: findings.slice(0, 20).map(finding => finding.id),
  }, first.line);
}

function check(id, category, status, severity, mandatory, source, reason = '', file = '', remediation = '', evidence = null, line = 0) {
  return { id, category, status, severity, mandatory, source, reason, file, remediation, evidence, line };
}

function failedRepository(repository, error) {
  const reason = safeError(error);
  return {
    cacheHit: false,
    repository: {
      ...repositoryMetadata(repository, repository),
      checks: [check('github/scan-complete', 'scan-coverage', 'unknown', 'critical', true, 'github', reason)],
    },
  };
}

function repositoryMetadata(repository, fallback) {
  return {
    name: String(repository.name ?? fallback.name),
    url: String(repository.html_url ?? fallback.html_url ?? ''),
    defaultBranch: String(repository.default_branch ?? fallback.default_branch ?? ''),
    visibility: String(repository.visibility ?? fallback.visibility ?? (repository.private ? 'private' : 'public')),
    archived: Boolean(repository.archived ?? fallback.archived),
  };
}

function safeRepositoryPath(path) {
  if (typeof path !== 'string' || path === '' || path.includes('\\') || path.includes('\0') || path.startsWith('/')) return false;
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '<redacted>').slice(0, 300);
}

function validateGitHubName(value, label) {
  const pattern = label === 'repository'
    ? /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/
    : /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is not a valid GitHub name`);
  }
  return value;
}

function inferRepositoryCount(organization) {
  const publicCount = organization?.public_repos;
  const privateCount = organization?.total_private_repos;
  if (!Number.isInteger(publicCount) || publicCount < 0) return null;
  if (!Number.isInteger(privateCount) || privateCount < 0) return null;
  return publicCount + privateCount;
}

function integerOption(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export async function mapLimit(items, concurrency, mapper) {
  const output = Array.from({ length: items.length });
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return output;
}

export { renderOrgReport };
