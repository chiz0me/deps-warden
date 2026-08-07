/**
 * Deterministic remediation plan creation and preconditioned application.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { fix, renderFix } from './fix.js';
import { format, renderJson } from '../lib/formatter.js';

export const PLAN_SCHEMA_VERSION = 1;
export const PLAN_KIND = 'deps-warden-remediation-plan';
const TOOL_VERSION = '0.1.0';

export async function createPlan(options) {
  const cwd = resolve(options?.cwd ?? process.cwd());
  const result = await fix({
    cwd,
    pmOverride: options?.pmOverride,
    finding: options?.finding,
    dryRun: true,
  });
  if (result.status !== 'OK') {
    return { kind: PLAN_KIND, schemaVersion: PLAN_SCHEMA_VERSION, toolVersion: TOOL_VERSION, status: 'FAIL', error: result.error };
  }
  return {
    kind: PLAN_KIND,
    schemaVersion: PLAN_SCHEMA_VERSION,
    toolVersion: TOOL_VERSION,
    status: 'OK',
    finding: {
      id: result.finding.id,
      ruleId: result.finding.ruleId,
      severity: result.finding.severity,
    },
    changes: result.proposals.map(proposal => ({
      file: relative(cwd, proposal.file),
      summary: proposal.summary,
      beforeExists: proposal.beforeExists,
      beforeSha256: proposal.beforeSha256,
      afterSha256: proposal.afterSha256,
      beforeBytes: proposal.beforeBytes,
      afterBytes: proposal.afterBytes,
      diff: proposal.diff,
    })),
  };
}

export async function applyPlan(options) {
  const cwd = resolve(options?.cwd ?? process.cwd());
  let plan;
  try {
    plan = await readPlan(options?.plan, cwd);
    validatePlan(plan);
  } catch (err) {
    return { status: 'FAIL', plan: null, fix: null, error: err.message };
  }

  const expectedChanges = Object.fromEntries(plan.changes.map(change => [change.file, {
    exists: change.beforeExists,
    beforeSha256: change.beforeSha256,
    afterSha256: change.afterSha256,
  }]));
  const result = await fix({
    cwd,
    pmOverride: options?.pmOverride,
    finding: plan.finding.id,
    expectedRuleId: plan.finding.ruleId,
    dryRun: options?.write !== true,
    expectedChanges,
  });
  return {
    status: result.status,
    plan: { kind: plan.kind, schemaVersion: plan.schemaVersion, finding: plan.finding },
    fix: result,
    error: result.error,
  };
}

export function renderPlan(plan) {
  return renderJson(plan);
}

export function renderApply(result, options = {}) {
  if (options.format === 'json') return renderJson(result);
  if (!result.fix) {
    return format(options.format ?? 'toon', [{ label: 'ERROR', fields: { msg: result.error } }], {
      status: result.status,
      json: result,
    });
  }
  return renderFix(result.fix, {
    format: options.format ?? 'toon',
    cwd: options.cwd,
    dryRun: options.write !== true,
  });
}

async function readPlan(input, cwd) {
  if (!input) throw new Error('missing remediation plan path');
  if (typeof input === 'object') return input;
  const path = isAbsolute(input) ? input : resolve(cwd, input);
  let source;
  try { source = await readFile(path, 'utf8'); }
  catch (err) { throw new Error(`cannot read remediation plan ${path}: ${err.message}`, { cause: err }); }
  try { return JSON.parse(source); }
  catch (err) { throw new Error(`invalid remediation plan JSON: ${err.message}`, { cause: err }); }
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('remediation plan must be a JSON object');
  if (plan.kind !== PLAN_KIND) throw new Error(`invalid remediation plan kind: ${String(plan.kind)}`);
  if (plan.status !== 'OK') throw new Error('remediation plan is not applicable');
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new Error(`unsupported remediation plan schema ${String(plan.schemaVersion)}; expected ${PLAN_SCHEMA_VERSION}`);
  }
  if (!plan.finding || !/^[a-f0-9]{10}$/.test(plan.finding.id) || typeof plan.finding.ruleId !== 'string') {
    throw new Error('remediation plan finding is invalid');
  }
  if (!Array.isArray(plan.changes) || plan.changes.length === 0) throw new Error('remediation plan has no changes');
  const seen = new Set();
  for (const change of plan.changes) {
    if (!change || typeof change.file !== 'string' || isUnsafePlanPath(change.file)) {
      throw new Error('remediation plan contains an unsafe file path');
    }
    if (seen.has(change.file)) throw new Error(`remediation plan contains duplicate file: ${change.file}`);
    seen.add(change.file);
    if (typeof change.beforeExists !== 'boolean') throw new Error(`invalid beforeExists for ${change.file}`);
    if (change.beforeSha256 !== null && !isSha256(change.beforeSha256)) throw new Error(`invalid beforeSha256 for ${change.file}`);
    if (change.beforeExists !== (change.beforeSha256 !== null)) throw new Error(`inconsistent before state for ${change.file}`);
    if (!isSha256(change.afterSha256)) throw new Error(`invalid afterSha256 for ${change.file}`);
  }
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isUnsafePlanPath(path) {
  return path === ''
    || isAbsolute(path)
    || /^(?:[A-Za-z]:|[\\/])/.test(path)
    || path.split(/[\\/]/).includes('..');
}
