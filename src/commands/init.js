/**
 * `init` — bootstrap recommended config files for the detected PM and profile.
 *
 * Profiles:
 *   strict   — every defence on (ignore-scripts, allowBuilds:{}, strictDepBuilds,
 *              minimumReleaseAge: 10080 minutes, saveExact)
 *   balanced — most defences on, no minimum-release-age
 *   loose    — bare minimum (lockfile)
 */

import { relative } from 'node:path';

import { buildContext } from '../lib/context.js';
import { writeFileGuarded } from '../lib/writer.js';
import { unifiedDiff } from '../lib/diff.js';
import { format } from '../lib/formatter.js';

/**
 * @typedef {object} InitOptions
 * @property {string} [cwd]
 * @property {import('../lib/detect.js').PmKind} [pmOverride]
 * @property {'strict'|'balanced'|'loose'} [profile]
 * @property {boolean} [dryRun]
 *
 * @typedef {object} InitProposal
 * @property {string} file
 * @property {string} summary
 * @property {number} beforeBytes
 * @property {number} afterBytes
 * @property {string} diff
 * @property {boolean} written
 *
 * @typedef {object} InitResult
 * @property {object} pm
 * @property {'strict'|'balanced'|'loose'} profile
 * @property {InitProposal[]} proposals
 * @property {'OK'|'FAIL'} status
 * @property {string} [error]
 */

const VALID_PROFILES = new Set(['strict', 'balanced', 'loose']);

/**
 * @param {InitOptions} opts
 * @returns {Promise<InitResult>}
 */
export async function init(opts = {}) {
  const profile = opts.profile ?? 'balanced';
  if (!VALID_PROFILES.has(profile)) {
    return {
      pm: null, profile, proposals: [], status: 'FAIL',
      error: `unknown profile: ${profile} (expected strict|balanced|loose)`,
    };
  }

  const ctx = await buildContext({ cwd: opts.cwd, pmOverride: opts.pmOverride });

  if (typeof ctx.pm.adapter.initFiles !== 'function') {
    return {
      pm: { kind: ctx.pm.kind }, profile, proposals: [], status: 'FAIL',
      error: `init not implemented for package manager: ${ctx.pm.kind}`,
    };
  }

  const proposals = await ctx.pm.adapter.initFiles(ctx, profile);
  const dryRun = opts.dryRun !== false;
  const out = [];
  for (const proposal of proposals) {
    const current = (await ctx.readText(proposal.file)) ?? '';
    const diff = unifiedDiff(current, proposal.content, relative(ctx.cwd, proposal.file)) ?? '';
    const writeResult = await writeFileGuarded({
      path: proposal.file,
      content: proposal.content,
      dryRun,
      cwd: ctx.cwd,
    });
    out.push({
      file: proposal.file,
      summary: proposal.summary,
      beforeBytes: Buffer.byteLength(current, 'utf8'),
      afterBytes: writeResult.bytes,
      diff,
      written: writeResult.written,
    });
  }

  return {
    pm: { kind: ctx.pm.kind, version: ctx.pm.version, source: ctx.pm.source },
    profile,
    proposals: out,
    status: 'OK',
  };
}

/**
 * @param {InitResult} result
 * @param {{format?: 'toon'|'json'|'text', cwd?: string, dryRun?: boolean}} [opts]
 * @returns {string}
 */
export function renderInit(result, opts = {}) {
  const fmt = opts.format ?? 'toon';
  const cwd = opts.cwd ?? process.cwd();
  const records = [];
  if (result.error) {
    records.push({ label: 'ERROR', fields: { msg: result.error } });
    return format(fmt, records, { status: result.status, json: result });
  }
  records.push({ label: 'INIT', fields: {
    pm: result.pm.kind,
    profile: result.profile,
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
  }
  records.push({ label: 'SUMMARY', fields: {
    proposals: result.proposals.length,
    applied: result.proposals.filter(p => p.written).length,
  } });
  let payload = format(fmt, records, { status: result.status, json: result });
  if (fmt !== 'json') {
    for (const p of result.proposals) {
      if (p.diff) payload += '\n' + p.diff;
    }
  }
  return payload;
}
