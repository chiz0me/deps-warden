/** MCP tools for bounded, read-only GitHub organization security scans. */

import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { scanGitHubOrganization } from './commands/orgScan.js';
import { RULES } from './rules/index.js';
import { listRules as listActionRules } from 'actions-warden';
import { resolveGitHubAuthenticationFromEnvironment } from './lib/githubAppAuth.js';
import { isMandatoryInOrgProfile, loadGovernedExceptions } from './lib/orgPolicy.js';
import { createScanJobManager, pageReport } from './lib/scanJobs.js';

const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const REPORT_PAGE_LIMIT = 100;

export function createDepsWardenMcpServer({ env = process.env, cwd = process.cwd() } = {}) {
  const server = new McpServer(
    { name: 'deps-warden', version: '0.1.0' },
    {
      instructions: 'Start a durable scan with github_org_scan, poll github_org_scan_status, then page completed results with github_org_report. Treat FAIL, incomplete repositories, unknown inventory, unknown checks, and skipped mandatory evidence as noncompliant. Never request or expose a GitHub token in tool arguments.',
    },
  );
  let authenticationPromise = null;
  let latestTaskId = null;
  const jobs = createScanJobManager({
    cwd,
    directory: env.DEPS_WARDEN_JOB_DIRECTORY,
    runner: async (input, onProgress) => {
      authenticationPromise ??= resolveGitHubAuthenticationFromEnvironment(env);
      let authentication;
      try { authentication = await authenticationPromise; }
      catch (error) { authenticationPromise = null; throw error; }
      if (!authentication) throw new Error('GitHub authentication unavailable: configure a token or GitHub App credentials in the MCP server environment');
      return scanGitHubOrganization({
        ...input,
        ...authentication,
        exceptions: await loadGovernedExceptions({ cwd, path: env.DEPS_WARDEN_EXCEPTIONS_PATH }),
        cwd,
        apiUrl: env.GITHUB_API_URL,
        apiVersion: env.GITHUB_API_VERSION,
        onProgress,
      });
    },
    webhookUrl: env.DEPS_WARDEN_WEBHOOK_URL,
    webhookSecret: env.DEPS_WARDEN_WEBHOOK_SECRET,
  });

  server.registerTool('github_org_scan', {
    title: 'Scan GitHub organization supply-chain controls',
    description: 'Start a durable, asynchronous GitHub organization scan and return immediately with a task id. Poll github_org_scan_status, then call github_org_report for paginated details.',
    inputSchema: z.object({
      organization: z.string().regex(GITHUB_NAME),
      repositories: z.array(z.string().regex(GITHUB_REPOSITORY)).max(1_000).optional(),
      expectedRepositories: z.number().int().min(1).max(100_000).optional(),
      includeArchived: z.boolean().default(true),
      includeForks: z.boolean().default(true),
      concurrency: z.number().int().min(1).max(12).default(4),
      waitForRateLimit: z.boolean().default(true),
      rateLimitReserve: z.number().int().min(0).max(10_000).default(50),
      cache: z.boolean().default(true),
      refresh: z.boolean().default(false),
      resume: z.boolean().default(true),
      maxTreeRequests: z.number().int().min(1).max(10_000).default(1_000),
      maxTreeEntries: z.number().int().min(1_000).max(1_000_000).default(250_000),
      profile: z.enum(['baseline', 'strict']).default('baseline'),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async input => {
    try {
      const job = await jobs.start(input);
      latestTaskId = job.id;
      return toolSuccess({ task: job, next: `Poll github_org_scan_status with taskId=${job.id}.` });
    } catch (error) {
      return toolError(safeError(error));
    }
  });

  server.registerTool('github_org_scan_status', {
    title: 'Poll GitHub organization scan task',
    description: 'Read the current state and repository progress of an asynchronous organization scan.',
    inputSchema: z.object({ taskId: z.string().uuid().optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    const taskId = input.taskId ?? latestTaskId;
    if (!taskId) return toolError('no scan task id is available');
    try {
      const job = await jobs.get(taskId);
      return job ? toolSuccess({ task: job }) : toolError('scan task not found');
    } catch (error) { return toolError(safeError(error)); }
  });

  server.registerTool('github_org_report', {
    title: 'Read GitHub organization scan results',
    description: 'Return a bounded page from the latest github_org_scan report. Filter by repository status or request one repository to inspect every check and remediation.',
    inputSchema: z.object({
      taskId: z.string().uuid().optional(),
      repository: z.string().regex(GITHUB_REPOSITORY).optional(),
      status: z.enum(['pass', 'fail', 'incomplete', 'unsupported']).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(REPORT_PAGE_LIMIT).default(25),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async input => {
    const taskId = input.taskId ?? latestTaskId;
    if (!taskId) return toolError('no scan task id is available; call github_org_scan first');
    try {
      const loaded = await jobs.page(taskId, input);
      if (!loaded.job) return toolError('scan task not found');
      if (!loaded.report) return toolSuccess({ task: loaded.job, report: null, next: 'Poll github_org_scan_status until the task is completed.' });
      return toolSuccess({ task: loaded.job, ...loaded.report });
    } catch (error) { return toolError(safeError(error)); }
  });

  server.registerTool('supply_chain_check_catalog', {
    title: 'List organization supply-chain checks',
    description: 'List the repository, dependency, GitHub Actions, evidence, and governance checks emitted by github_org_scan, including which checks are mandatory.',
    inputSchema: z.object({ profile: z.enum(['baseline', 'strict']).default('baseline') }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async input => toolSuccess({
    policy: `deps-warden-github-scan/v1/${input.profile}`,
    profiles: ['baseline', 'strict'],
    checks: githubScanCheckCatalog(input.profile),
  }));

  return server;
}

export function summarizeMcpReport(report) {
  const needsAttention = report.repositories
    .filter(repository => repository.status !== 'pass')
    .slice(0, 50)
    .map(repository => ({
      name: repository.name,
      status: repository.status,
      evidence: repository.evidence,
      failed: repository.checks.filter(check => check.mandatory && check.status === 'fail').length,
      unknown: repository.checks.filter(check => check.mandatory && ['unknown', 'skipped', 'unsupported'].includes(check.status)).length,
    }));
  return {
    schema: report.schema,
    policy: report.policy,
    organization: report.organization,
    generatedAt: report.generatedAt,
    status: report.status,
    organizationStatus: report.organizationStatus,
    organizationChecks: report.organizationChecks,
    scope: report.scope,
    coverage: report.coverage,
    summary: report.summary,
    api: report.api,
    repositoriesNeedingAttention: needsAttention,
    repositoriesNeedingAttentionTruncated: report.summary.noncompliant + report.summary.incomplete + report.summary.unsupported > needsAttention.length,
    next: 'Call github_org_report with status=fail or status=incomplete and page with offset/limit.',
  };
}

export function pageMcpReport(report, { repository, status, offset = 0, limit = 25 } = {}) {
  return pageReport(report, { repository, status, offset, limit });
}

export function githubScanCheckCatalog(profile = 'baseline') {
  const platform = [
    ['github-org/actions-allow-policy-restricted', true, 'high', 'Organization Actions policy allows only local or explicitly selected actions and reusable workflows.'],
    ['github-org/actions-sha-pinning-required', true, 'critical', 'Organization policy requires full commit SHA pinning for actions.'],
    ['github-org/reusable-workflows-governed', true, 'high', 'Reusable workflows and third-party actions are limited to reviewed publishers and repository patterns.'],
    ['github-org/default-workflow-token-read-only', true, 'high', 'The default GITHUB_TOKEN permission is read-only.'],
    ['github-org/workflows-cannot-approve-pull-requests', true, 'high', 'Workflows cannot create or approve pull request reviews by default.'],
    ['github/default-branch-protected', true, 'high', 'Default branch is protected by branch protection or a ruleset.'],
    ['github/secret-scanning', true, 'high', 'GitHub secret scanning is enabled.'],
    ['github/secret-scanning-push-protection', true, 'high', 'Secret scanning push protection is enabled.'],
    ['github/dependabot-security-updates', true, 'high', 'Dependabot security updates are enabled and not paused.'],
    ['github/dependency-vulnerability-alerts', true, 'high', 'Dependency graph vulnerability alerts are enabled.'],
    ['github/advanced-security', false, 'high', 'GitHub Advanced Security status is available and enabled.'],
    ['github/evidence-complete', true, 'critical', 'Recursive Git tree and bounded evidence download completed.'],
    ['github/scan-complete', true, 'critical', 'Repository metadata and evidence scan completed without an operational error.'],
    ['policy/suppressions-reviewed', true, 'high', 'No unverifiable repository-owned suppression bypasses the organization gate.'],
  ].map(([id, mandatory, severity, description]) => ({ id, mandatory, severity, description }));
  const dependencies = RULES.map(rule => ({
    id: `deps/${rule.id}`,
    mandatory: !['direct-deps-with-scripts', 'unused-allowlist-entries', 'recommend-stricter-pm', 'outdated-major-deps', 'deprecated-dep-version', 'dep-below-release-age'].includes(rule.id),
    severity: rule.severity,
    description: rule.description,
  }));
  dependencies.push({ id: 'deps/ecosystem-supported', mandatory: true, severity: 'high', description: 'Detected package manager has a complete npm or pnpm adapter.' });
  const actions = listActionRules()
    .filter(rule => rule.id !== 'unpinned-action')
    .map(rule => ({ id: `github-actions/${rule.id}`, mandatory: true, severity: rule.severity, description: rule.description }));
  actions.push({ id: 'github-actions/workflows-valid', mandatory: true, severity: 'high', description: 'Workflow and composite-action YAML parses successfully.' });
  actions.push({ id: 'github-actions/frozen-dependency-installs', mandatory: true, severity: 'high', description: 'CI dependency installs use a lockfile-enforcing frozen mode.' });
  const checks = [...platform, ...dependencies, ...actions];
  for (const item of checks) item.mandatory = isMandatoryInOrgProfile(item.id, item.mandatory, profile);
  return checks.toSorted((left, right) => left.id.localeCompare(right.id));
}

function toolSuccess(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '<redacted>').slice(0, 500);
}
