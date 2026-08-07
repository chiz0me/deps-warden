/**
 * `report` — combined audit + scripts in one TOON stream.
 *
 * Runs `audit({explain: true})` and `scripts({})` (read-only) against the
 * same context and emits all records. Status: OK only if audit is OK.
 */

import { audit, renderAudit } from './audit.js';
import { scripts, renderScripts } from './scripts.js';
import { format } from '../lib/formatter.js';

/**
 * @typedef {object} ReportOptions
 * @property {string} [cwd]
 * @property {import('../lib/detect.js').PmKind} [pmOverride]
 * @property {string[]} [trustedRegistries]
 * @property {boolean} [checkVersions]
 * @property {string} [policyPath]
 * @property {'low'|'medium'|'high'|'critical'} [severity]
 * @property {'low'|'medium'|'high'|'critical'} [reportLevel]
 * @property {'low'|'medium'|'high'|'critical'} [failLevel]
 * @property {string[]} [rules]
 * @property {string[]} [failOn]
 * @property {boolean} [explain]
 * @property {'off'|'registry'} [networkMode]
 * @property {boolean} [requireComplete]
 *
 * @typedef {object} ReportResult
 * @property {import('./audit.js').AuditResult} audit
 * @property {import('./scripts.js').ScriptsResult} scripts
 * @property {'OK'|'FAIL'} status
 */

/**
 * @param {ReportOptions} opts
 * @returns {Promise<ReportResult>}
 */
export async function report(opts = {}) {
  const auditResult = await audit({
    cwd: opts.cwd,
    pmOverride: opts.pmOverride,
    severity: opts.severity,
    reportLevel: opts.reportLevel,
    failLevel: opts.failLevel,
    rules: opts.rules,
    failOn: opts.failOn,
    explain: opts.explain,
    trustedRegistries: opts.trustedRegistries,
    checkVersions: opts.checkVersions,
    policyPath: opts.policyPath,
    networkMode: opts.networkMode,
    requireComplete: opts.requireComplete,
  });
  const scriptsResult = await scripts({
    cwd: opts.cwd,
    pmOverride: opts.pmOverride,
  });
  return {
    audit: auditResult,
    scripts: scriptsResult,
    status: auditResult.status,
  };
}

/**
 * @param {ReportResult} result
 * @param {{format?: 'toon'|'json'|'text', cwd?: string, verbose?: boolean}} [opts]
 * @returns {string}
 */
export function renderReport(result, opts = {}) {
  const fmt = opts.format ?? 'toon';
  if (fmt === 'json') {
    return format('json', [], { status: result.status, json: result });
  }
  // For text/toon, concatenate the two sub-renders without the trailing
  // STATUS line on the first, and emit a single combined STATUS at the end.
  const auditOut = renderAudit(result.audit, { format: fmt, explain: true, cwd: opts.cwd, verbose: opts.verbose });
  const scriptsOut = renderScripts(result.scripts, { format: fmt, dryRun: true, cwd: opts.cwd });
  const stripStatus = (s) => s.replace(/STATUS:\s*(OK|FAIL)\s*\n?/g, '').replace(/==> (OK|FAIL)\s*\n?/g, '');
  const combined = stripStatus(auditOut) + stripStatus(scriptsOut);
  const statusLine = fmt === 'text' ? `==> ${result.status}\n` : `STATUS: ${result.status}\n`;
  return combined + statusLine;
}
