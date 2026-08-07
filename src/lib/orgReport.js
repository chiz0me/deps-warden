/**
 * Canonical organization-report model shared by future GitHub transports and
 * MCP tools. Transport code supplies evidence; this module validates it,
 * derives fail-closed compliance, and renders deterministic output.
 */

import { format } from './formatter.js';
import { renderOrgCsv, renderOrgHtml, renderOrgSarif } from './orgReportFormats.js';

export const ORG_REPORT_SCHEMA = 'deps-warden-org-report/v1';
export const ORG_CHECK_STATUSES = Object.freeze([
  'pass',
  'fail',
  'unknown',
  'not_applicable',
  'unsupported',
  'skipped',
  'accepted',
]);

const REPOSITORY_STATUSES = ['pass', 'fail', 'incomplete', 'unsupported'];
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const GITHUB_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/**
 * @param {object} input
 * @param {string} input.organization
 * @param {string} [input.generatedAt]
 * @param {string} [input.policy]
 * @param {Array<object>} [input.repositories]
 * @param {Array<object>} [input.organizationChecks]
 * @param {object} [input.exceptions]
 * @param {object} [input.scope]
 * @param {object} [input.api]
 */
export function createOrgReport({
  organization,
  generatedAt = new Date().toISOString(),
  policy = 'deps-warden-baseline/v1',
  repositories = [],
  organizationChecks = [],
  exceptions = {},
  scope = {},
  api = {},
}) {
  assertName(organization, 'organization');
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error('generatedAt must be an ISO-compatible timestamp');
  if (!Array.isArray(repositories)) throw new Error('repositories must be an array');
  if (!Array.isArray(organizationChecks)) throw new Error('organizationChecks must be an array');

  const normalized = repositories
    .map(normalizeRepository)
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const normalizedOrganizationChecks = normalizeChecks('organization', organizationChecks);
  const organizationStatus = checkCollectionStatus(normalizedOrganizationChecks, 'pass');
  const coverage = {
    repositoriesTotal: normalized.length,
    scanned: normalized.filter(repo => repo.status === 'pass' || repo.status === 'fail').length,
    incomplete: normalized.filter(repo => repo.status === 'incomplete').length,
    unsupported: normalized.filter(repo => repo.status === 'unsupported').length,
  };
  const failedChecks = [
    ...normalizedOrganizationChecks.filter(check => check.status === 'fail'),
    ...normalized.flatMap(repo => repo.checks.filter(check => check.status === 'fail')),
  ];
  const summary = {
    compliant: normalized.filter(repo => repo.status === 'pass').length,
    noncompliant: normalized.filter(repo => repo.status === 'fail').length,
    incomplete: coverage.incomplete,
    unsupported: coverage.unsupported,
    critical: failedChecks.filter(check => check.severity === 'critical').length,
    high: failedChecks.filter(check => check.severity === 'high').length,
    medium: failedChecks.filter(check => check.severity === 'medium').length,
    low: failedChecks.filter(check => check.severity === 'low').length,
  };
  const normalizedScope = normalizeScope(scope, normalized.length);
  return {
    schema: ORG_REPORT_SCHEMA,
    organization,
    generatedAt: new Date(generatedAt).toISOString(),
    policy,
    organizationStatus,
    organizationChecks: normalizedOrganizationChecks,
    exceptions: normalizeExceptions(exceptions),
    scope: normalizedScope,
    api: normalizeApi(api),
    coverage,
    summary,
    repositories: normalized,
    status: normalized.length > 0
      && normalizedScope.inventoryStatus === 'pass'
      && organizationStatus === 'pass'
      && normalized.every(repo => repo.status === 'pass') ? 'OK' : 'FAIL',
  };
}

function normalizeRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new Error('repository must be an object');
  assertName(repository.name, 'repository name');
  if (!Array.isArray(repository.checks)) throw new Error(`${repository.name}.checks must be an array`);
  const checks = normalizeChecks(repository.name, repository.checks);
  return {
    name: repository.name,
    url: stringOrEmpty(repository.url),
    defaultBranch: stringOrEmpty(repository.defaultBranch),
    visibility: stringOrEmpty(repository.visibility),
    archived: Boolean(repository.archived),
    status: repositoryStatus(checks),
    evidence: repositoryEvidence(checks),
    checks,
  };
}

function normalizeChecks(owner, checks) {
  const normalized = checks
    .map(check => normalizeCheck(owner, check))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const duplicate = normalized.find((check, index) => index > 0 && normalized[index - 1].id === check.id);
  if (duplicate) throw new Error(`${owner} has duplicate check id: ${duplicate.id}`);
  return normalized;
}

function normalizeCheck(repositoryName, check) {
  if (!check || typeof check !== 'object') throw new Error(`${repositoryName} check must be an object`);
  if (typeof check.id !== 'string' || check.id.trim() === '') throw new Error(`${repositoryName} check id is required`);
  if (!ORG_CHECK_STATUSES.includes(check.status)) {
    throw new Error(`${repositoryName}.${check.id} has unknown status: ${check.status}`);
  }
  const severity = check.severity ?? 'high';
  if (!SEVERITIES.has(severity)) {
    throw new Error(`${repositoryName}.${check.id} has unknown severity: ${severity}`);
  }
  return {
    id: check.id,
    category: stringOrEmpty(check.category),
    mandatory: check.mandatory !== false,
    status: check.status,
    severity,
    source: stringOrEmpty(check.source),
    file: stringOrEmpty(check.file),
    line: positiveIntegerOrZero(check.line),
    reason: stringOrEmpty(check.reason),
    evidence: check.evidence ?? null,
    remediation: stringOrEmpty(check.remediation),
  };
}

function repositoryStatus(checks) {
  return checkCollectionStatus(checks, 'incomplete');
}

function checkCollectionStatus(checks, emptyStatus) {
  const mandatory = checks.filter(check => check.mandatory && check.status !== 'not_applicable');
  if (mandatory.some(check => check.status === 'fail')) return 'fail';
  if (mandatory.some(check => check.status === 'unknown' || check.status === 'skipped')) return 'incomplete';
  if (mandatory.some(check => check.status === 'unsupported')) return 'unsupported';
  return mandatory.length === 0 ? emptyStatus : 'pass';
}

function repositoryEvidence(checks) {
  return checks.some(check => check.mandatory
    && ['unknown', 'unsupported', 'skipped'].includes(check.status)) ? 'partial' : 'complete';
}

function normalizeExceptions(exceptions) {
  const records = Array.isArray(exceptions?.records) ? exceptions.records : [];
  return {
    total: nonnegativeInteger(exceptions?.total, records.length),
    accepted: nonnegativeInteger(exceptions?.accepted, 0),
    expired: nonnegativeInteger(exceptions?.expired, 0),
    notApplicable: nonnegativeInteger(exceptions?.notApplicable, 0),
    outsideScope: nonnegativeInteger(exceptions?.outsideScope, 0),
    records,
  };
}

/**
 * @param {ReturnType<typeof createOrgReport>} report
 * @param {{format?: 'toon'|'json'|'text'|'sarif'|'html'|'csv'}} [options]
 */
export function renderOrgReport(report, { format: outputFormat = 'json' } = {}) {
  validateReportShape(report);
  if (outputFormat === 'json') return format('json', [], { status: report.status, json: report });
  if (outputFormat === 'sarif') return renderOrgSarif(report);
  if (outputFormat === 'html') return renderOrgHtml(report);
  if (outputFormat === 'csv') return renderOrgCsv(report);
  const records = [{
    label: 'ORG',
    fields: {
      schema: report.schema,
      name: report.organization,
      policy: report.policy,
      generated_at: report.generatedAt,
      repositories: report.coverage.repositoriesTotal,
      discovered: report.scope.discovered,
      selected: report.scope.selected,
      expected: report.scope.expected ?? '',
      inventory: report.scope.inventoryStatus,
    },
  }];
  for (const check of report.organizationChecks) {
    records.push({ label: 'ORG_CHECK', fields: {
      id: check.id,
      category: check.category,
      status: check.status,
      mandatory: check.mandatory,
      sev: check.severity,
      source: check.source,
      reason: check.reason,
      remediation: check.remediation,
    } });
  }
  for (const repository of report.repositories) {
    records.push({ label: 'REPO', fields: {
      name: repository.name,
      status: repository.status,
      evidence: repository.evidence,
      default_branch: repository.defaultBranch,
      visibility: repository.visibility,
      archived: repository.archived,
      url: repository.url,
    } });
    for (const check of repository.checks) {
      records.push({ label: 'CHECK', fields: {
        repo: repository.name,
        id: check.id,
        category: check.category,
        status: check.status,
        mandatory: check.mandatory,
        sev: check.severity,
        source: check.source,
        file: check.file,
        line: check.line || '',
        reason: check.reason,
        remediation: check.remediation,
      } });
    }
  }
  records.push({ label: 'COVERAGE', fields: report.coverage });
  records.push({ label: 'API', fields: {
    requests: report.api.requests,
    rate_limit: report.api.rate.limit ?? '',
    rate_remaining: report.api.rate.remaining ?? '',
    rate_reset_at: report.api.rate.resetAt ?? '',
  } });
  records.push({ label: 'SUMMARY', fields: report.summary });
  return format(outputFormat, records, { status: report.status });
}

function validateReportShape(report) {
  if (!report || report.schema !== ORG_REPORT_SCHEMA) {
    throw new Error(`report schema must be ${ORG_REPORT_SCHEMA}`);
  }
  if (!REPOSITORY_STATUSES.every(status => Number.isInteger(report.summary[summaryKey(status)]))) {
    throw new Error('report summary is incomplete');
  }
}

function summaryKey(status) {
  if (status === 'pass') return 'compliant';
  if (status === 'fail') return 'noncompliant';
  return status;
}

function assertName(value, label) {
  const pattern = label === 'repository name' ? GITHUB_REPOSITORY_RE : GITHUB_NAME_RE;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is not a valid GitHub name`);
  }
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

function positiveIntegerOrZero(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function normalizeScope(scope, selectedFallback) {
  return {
    discovered: nonnegativeInteger(scope?.discovered, selectedFallback),
    selected: nonnegativeInteger(scope?.selected, selectedFallback),
    includeArchived: scope?.includeArchived !== false,
    includeForks: scope?.includeForks !== false,
    cacheEnabled: scope?.cacheEnabled !== false,
    cacheHits: nonnegativeInteger(scope?.cacheHits, 0),
    resumeEnabled: scope?.resumeEnabled !== false,
    checkpointHits: nonnegativeInteger(scope?.checkpointHits, 0),
    checkpointErrors: nonnegativeInteger(scope?.checkpointErrors, 0),
    authentication: ['token', 'github-app'].includes(scope?.authentication) ? scope.authentication : '',
    expected: nullableNonnegativeInteger(scope?.expected),
    inventoryStatus: ['pass', 'fail', 'unknown'].includes(scope?.inventoryStatus) ? scope.inventoryStatus : 'pass',
  };
}

function normalizeApi(api) {
  return {
    requests: nonnegativeInteger(api?.requests, 0),
    rate: {
      limit: nullableNonnegativeInteger(api?.rate?.limit),
      remaining: nullableNonnegativeInteger(api?.rate?.remaining),
      used: nullableNonnegativeInteger(api?.rate?.used),
      resetAt: nullableNonnegativeInteger(api?.rate?.resetAt),
    },
  };
}

function nonnegativeInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function nullableNonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}
