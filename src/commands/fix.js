/**
 * `fix` — propose (and optionally apply) the change for a single finding.
 *
 * 1. Re-runs audit to locate the finding by id.
 * 2. Looks up the rule and calls rule.fix(ctx, finding).
 * 3. For each ProposedWrite, computes a unified diff against the current
 *    on-disk content and either records it (dry-run) or writes it.
 */

import { relative } from 'node:path';

import { audit } from './audit.js';
import { buildContext } from '../lib/context.js';
import { RULES } from '../rules/index.js';
import { writeFileGuarded } from '../lib/writer.js';
import { unifiedDiff } from '../lib/diff.js';
import { format } from '../lib/formatter.js';
import { sha256 } from '../lib/hash.js';

/**
 * @typedef {object} FixOptions
 * @property {string} [cwd]
 * @property {import('../lib/detect.js').PmKind} [pmOverride]
 * @property {string} finding             finding id to fix
 * @property {boolean} [dryRun]
 * @property {string} [expectedRuleId]
 * @property {Record<string, {exists: boolean, beforeSha256: string|null, afterSha256: string}>} [expectedChanges]
 *
 * @typedef {object} ProposalResult
 * @property {string} file
 * @property {string} summary
 * @property {number} beforeBytes
 * @property {number} afterBytes
 * @property {boolean} beforeExists
 * @property {string|null} beforeSha256
 * @property {string} afterSha256
 * @property {string} diff
 * @property {boolean} written
 *
 * @typedef {object} FixResult
 * @property {object|null} finding
 * @property {ProposalResult[]} proposals
 * @property {'OK'|'FAIL'} status
 * @property {string} [error]
 */

/**
 * @param {FixOptions} opts
 * @returns {Promise<FixResult>}
 */
export async function fix(opts) {
  if (!opts || !opts.finding) {
    return { finding: null, proposals: [], status: 'FAIL', error: 'missing required --finding=<id>' };
  }
  const ctx = await buildContext({ cwd: opts.cwd, pmOverride: opts.pmOverride });
  const auditResult = await audit({ cwd: opts.cwd, pmOverride: opts.pmOverride, explain: true });
  const finding = auditResult.findings.find(f => f.id === opts.finding);
  if (!finding) {
    const suppressed = (auditResult.ignored ?? []).find(i => i.id === opts.finding);
    if (suppressed) {
      const entry = suppressed.matchedBy === 'rule' ? suppressed.rule : suppressed.id;
      return {
        finding: null,
        proposals: [],
        status: 'FAIL',
        error: `finding ${opts.finding} is suppressed by .deps-warden-ignore; remove "${entry}" from that file to fix it`,
      };
    }
    return { finding: null, proposals: [], status: 'FAIL', error: `finding id not found: ${opts.finding}` };
  }
  if (opts.expectedRuleId && finding.ruleId !== opts.expectedRuleId) {
    return {
      finding,
      proposals: [],
      status: 'FAIL',
      error: `plan conflict: finding rule changed from ${opts.expectedRuleId} to ${finding.ruleId}`,
    };
  }
  const rule = RULES.find(r => r.id === finding.ruleId);
  if (!rule || typeof rule.fix !== 'function') {
    return {
      finding,
      proposals: [],
      status: 'FAIL',
      error: `no fix available for rule: ${finding.ruleId}`,
    };
  }

  const proposals = await rule.fix(ctx, finding);
  const prepared = [];
  for (const proposal of proposals) {
    const currentSource = await ctx.readText(proposal.file);
    const current = currentSource ?? '';
    const file = relative(ctx.cwd, proposal.file);
    const beforeExists = currentSource !== null;
    const beforeSha256 = beforeExists ? sha256(current) : null;
    const afterSha256 = sha256(proposal.content);
    const expected = opts.expectedChanges?.[file];
    if (opts.expectedChanges && !expected) {
      return { finding, proposals: [], status: 'FAIL', error: `plan conflict: unexpected proposed file ${file}` };
    }
    if (expected && (
      expected.exists !== beforeExists
      || expected.beforeSha256 !== beforeSha256
      || expected.afterSha256 !== afterSha256
    )) {
      return { finding, proposals: [], status: 'FAIL', error: `plan conflict: ${file} no longer matches the approved plan` };
    }
    const diff = unifiedDiff(current, proposal.content, file) ?? '';
    prepared.push({ proposal, file, current, beforeExists, beforeSha256, afterSha256, diff });
  }

  if (opts.expectedChanges) {
    const plannedFiles = Object.keys(opts.expectedChanges).toSorted();
    const proposedFiles = prepared.map(item => item.file).toSorted();
    if (stableList(plannedFiles) !== stableList(proposedFiles)) {
      return { finding, proposals: [], status: 'FAIL', error: 'plan conflict: proposed file set changed' };
    }
  }

  const out = [];
  for (const item of prepared) {
    const writeResult = await writeFileGuarded({
      path: item.proposal.file,
      content: item.proposal.content,
      dryRun: opts.dryRun !== false,
      cwd: ctx.cwd,
      expected: opts.expectedChanges ? {
        exists: item.beforeExists,
        sha256: item.beforeSha256,
      } : undefined,
    });
    out.push({
      file: item.proposal.file,
      summary: item.proposal.summary,
      beforeBytes: Buffer.byteLength(item.current, 'utf8'),
      afterBytes: writeResult.bytes,
      beforeExists: item.beforeExists,
      beforeSha256: item.beforeSha256,
      afterSha256: item.afterSha256,
      diff: item.diff,
      written: writeResult.written,
    });
  }
  return { finding, proposals: out, status: 'OK' };
}

/**
 * @param {FixResult} result
 * @param {{format?: 'toon'|'json'|'text', cwd?: string, dryRun?: boolean}} [opts]
 * @returns {string}
 */
export function renderFix(result, opts = {}) {
  const fmt = opts.format ?? 'toon';
  const cwd = opts.cwd ?? process.cwd();
  const records = [];
  if (result.error) {
    records.push({ label: 'ERROR', fields: { msg: result.error } });
    return format(fmt, records, { status: result.status, json: result });
  }
  records.push({ label: 'FIX', fields: {
    id: result.finding.id,
    rule: result.finding.ruleId,
    sev: result.finding.severity,
    proposals: result.proposals.length,
    dryRun: opts.dryRun !== false,
  } });
  for (const p of result.proposals) {
    records.push({ label: 'PROPOSAL', fields: {
      file: relative(cwd, p.file),
      summary: p.summary,
      before: p.beforeBytes,
      after: p.afterBytes,
      written: p.written,
    } });
    if (p.diff && fmt !== 'json') {
      records.push({ label: 'DIFF', fields: { file: relative(cwd, p.file), hunks: countHunks(p.diff) } });
    }
  }
  records.push({ label: 'SUMMARY', fields: {
    proposals: result.proposals.length,
    applied: result.proposals.filter(p => p.written).length,
  } });
  // For text/toon, append raw diff at the end for visibility.
  let payload = format(fmt, records, { status: result.status, json: result });
  if (fmt !== 'json') {
    for (const p of result.proposals) {
      if (p.diff) payload += '\n' + p.diff;
    }
  }
  return payload;
}

function countHunks(diff) {
  const m = diff.match(/^@@/gm);
  return m ? m.length : 0;
}

function stableList(values) {
  return JSON.stringify(values);
}
