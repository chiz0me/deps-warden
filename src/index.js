/**
 * Public programmatic API for deps-warden.
 */

export { audit, renderAudit } from './commands/audit.js';
export { fix, renderFix } from './commands/fix.js';
export { createPlan, applyPlan, renderPlan, renderApply, PLAN_SCHEMA_VERSION, PLAN_KIND } from './commands/plan.js';
export { initPolicy, validatePolicyFile, showPolicy, renderPolicy } from './commands/policy.js';
export { rules, renderRules } from './commands/rules.js';
export { listRules, RULES } from './rules/index.js';
export { buildContext } from './lib/context.js';
export { detectPm } from './lib/detect.js';
export { selectAdapter } from './adapters/index.js';
export { format, renderToon, renderJson, renderText, summarize, SEVERITY_ORDER } from './lib/formatter.js';
export { unifiedDiff } from './lib/diff.js';
export { redact } from './lib/redact.js';
export { parseIgnoreDirectives, isIgnored } from './lib/ignore.js';
export { loadIgnoreFile, parseIgnoreFile, ignoreFileMatch } from './lib/ignoreFile.js';
export { parseLockfileInstallScripts } from './lib/lockfileScripts.js';
export { createRegistryClient, collectRegistryData, encodePackageName } from './lib/registry.js';
export { enumerateDirectDeps } from './lib/directDeps.js';
export { loadPolicy, parsePolicy, validatePolicy, defaultPolicyYaml, POLICY_VERSION } from './lib/policy.js';
export { createOrgReport, renderOrgReport, ORG_REPORT_SCHEMA, ORG_CHECK_STATUSES } from './lib/orgReport.js';
export { renderOrgCsv, renderOrgHtml, renderOrgSarif } from './lib/orgReportFormats.js';
export { diffOrgReports, ORG_REPORT_DIFF_SCHEMA } from './lib/orgReportDiff.js';
export { writeOrgArtifactBundle, ORG_ARTIFACT_MANIFEST_SCHEMA } from './lib/orgArtifacts.js';
export { createGitHubClient, GitHubApiError, GitHubRateLimitError } from './lib/githubClient.js';
export { createGitHubAppTokenProvider, createAppJwt, resolveGitHubAuthenticationFromEnvironment } from './lib/githubAppAuth.js';
export { createOrgCache, ORG_CACHE_SCHEMA } from './lib/orgCache.js';
export { createScanCheckpoint, createScanFingerprint, SCAN_CHECKPOINT_SCHEMA } from './lib/scanCheckpoint.js';
export { applyOrgPolicy, isMandatoryInOrgProfile, loadGovernedExceptions, parseGovernedExceptions, validateGovernedExceptions, ORG_POLICY_PROFILES, ORG_EXCEPTIONS_VERSION } from './lib/orgPolicy.js';
export { createScanJobManager, pageReport, SCAN_JOB_SCHEMA, scanJobInputFingerprint } from './lib/scanJobs.js';
export { createScanHttpServer, listenScanHttpServer } from './lib/httpServer.js';
export { appendGitHubStepSummary, renderGitHubAnnotations, renderGitHubSummary } from './lib/githubActions.js';
export { scanGitHubOrganization, mapLimit } from './commands/orgScan.js';
export { createDepsWardenMcpServer, summarizeMcpReport, pageMcpReport, githubScanCheckCatalog } from './mcpServer.js';
