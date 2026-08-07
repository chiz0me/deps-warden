/**
 * `audit` — scan a project for supply-chain misconfigurations.
 *
 * Flow:
 *   1. buildContext(cwd, pmOverride)
 *   2. filter RULES by appliesTo(ctx)
 *   3. run each rule.check(ctx) sequentially
 *   4. compute a stable 10-char id per finding
 *   5. drop findings silenced by inline ignore directives
 *   6. filter by --severity
 *
 * Returns a structured result the CLI renders via renderAudit().
 */

import { createHash } from 'node:crypto';
import { relative } from 'node:path';

import { buildContext } from '../lib/context.js';
import { RULES } from '../rules/index.js';
import { collectRegistryData } from '../lib/registry.js';
import { format, summarize, SEVERITY_ORDER } from '../lib/formatter.js';
import { parseIgnoreDirectives, isIgnored } from '../lib/ignore.js';
import { loadIgnoreFile, ignoreFileMatch } from '../lib/ignoreFile.js';
import { loadPolicy } from '../lib/policy.js';

const VERSION_RULES = new Set(['outdated-major-deps', 'deprecated-dep-version', 'dep-below-release-age']);

// Rules that expose a fix() can be applied with `deps-warden fix --finding=<id>`.
const FIXABLE_RULES = new Set(RULES.filter(r => typeof r.fix === 'function').map(r => r.id));

/**
 * @typedef {object} Finding
 * @property {string} id           10-char deterministic hash
 * @property {string} ruleId
 * @property {'low'|'medium'|'high'|'critical'} severity
 * @property {string} file         absolute path
 * @property {number} line         1-based; 0 if unknown
 * @property {Record<string, unknown>} fields
 * @property {string} [explain]
 * @property {boolean} [fixable]   whether `fix --finding=<id>` can apply it
 */

/**
 * @typedef {object} AuditOptions
 * @property {string} [cwd]
 * @property {import('../lib/detect.js').PmKind} [pmOverride]
 * @property {'low'|'medium'|'high'|'critical'} [severity]
 * @property {'low'|'medium'|'high'|'critical'} [reportLevel]
 * @property {'low'|'medium'|'high'|'critical'} [failLevel]
 * @property {boolean} [explain]
 * @property {boolean} [requireComplete]          fail when required audit evidence is unavailable
 * @property {string} [policyPath]
 * @property {string[]} [rules]                   run only these rule ids (default: all)
 * @property {string[]} [failOn]                  exit FAIL only when one of these rule ids has a finding (default: any finding fails)
 * @property {string[]} [trustedRegistries]
 * @property {boolean} [checkVersions]            opt-in registry version checks
 * @property {'off'|'registry'} [networkMode]
 * @property {typeof globalThis.fetch} [fetchImpl] override fetch (testing)
 * @property {number} [now]                       override current time ms (testing)
 * @property {number} [registryTimeoutMs]
 * @property {string} [npmUserAgent]              override npm_config_user_agent (testing)
 * @property {Set<string>} [gitTrackedOverride]   trusted tracked-path evidence from a remote Git tree
 */

/**
 * @typedef {object} AuditResult
 * @property {object} pm
 * @property {string[]} files
 * @property {Finding[]} findings
 * @property {Array<{rule: string, id: string, matchedBy: 'rule'|'id'}>} ignored  findings suppressed by .deps-warden-ignore
 * @property {Record<string, number>} summary
 * @property {'OK'|'FAIL'} status
 * @property {string[]} skipped     rule ids that didn't fire because appliesTo returned false but the rule is intended for this PM
 * @property {string[]|null} filter active `--rule` selection, or null when all rules ran
 * @property {string[]|null} failOn active `--fail-on` gate rules, or null; when set, status is FAIL only if one of these fired
 * @property {{url: string, errors: Array<{name: string, error: string}>}|null} registry  registry-check metadata when --check-versions is on
 */

/**
 * @param {AuditOptions} opts
 * @returns {Promise<AuditResult>}
 */
export async function audit(opts = {}) {
  const ctx = await buildContext({
    cwd: opts.cwd,
    pmOverride: opts.pmOverride,
    gitTrackedOverride: opts.gitTrackedOverride,
  });
  const loadedPolicy = await loadPolicy({ cwd: ctx.cwd, path: opts.policyPath });
  const policy = loadedPolicy.policy;
  const reportLevel = opts.reportLevel ?? opts.severity ?? policy.scan.reportLevel;
  const failLevel = opts.failLevel ?? opts.severity ?? policy.scan.failLevel;
  assertValidLevels(reportLevel, failLevel);
  const selectedRuleIds = opts.rules !== undefined ? opts.rules : policy.scan.rules;
  const failOnIds = opts.failOn !== undefined ? opts.failOn : policy.scan.failOn;
  const explain = opts.explain ?? policy.scan.explain;
  const requireComplete = opts.requireComplete ?? policy.scan.requireComplete;
  const networkMode = opts.networkMode
    ?? (opts.checkVersions !== undefined ? (opts.checkVersions ? 'registry' : 'off') : policy.network.mode);
  const trustedRegistries = [...new Set([
    ...policy.network.trustedRegistries,
    ...(opts.trustedRegistries ?? []),
  ])];
  ctx.options = {
    trustedRegistries,
    checkVersions: networkMode === 'registry',
    fetchImpl: opts.fetchImpl,
    now: opts.now,
    registryTimeoutMs: opts.registryTimeoutMs,
    npmUserAgent: opts.npmUserAgent,
  };
  ctx.registryData = await collectRegistryData(ctx);

  const ignoreFile = await loadIgnoreFile(ctx.cwd, ctx.readText);
  const selectedRules = selectRules(selectedRuleIds);
  if (failOnIds?.length) assertKnownRuleIds(failOnIds, '--fail-on');

  const filesTouched = new Set();
  const ignoreScopes = new Map();

  /** @type {Finding[]} */
  const findings = [];
  const ignored = [];
  const skipped = [];

  for (const rule of selectedRules) {
    let applies;
    try { applies = await rule.appliesTo(ctx); }
    catch (err) {
      findings.push(errorFinding(ctx, rule.id, `appliesTo threw: ${err.message}`));
      continue;
    }
    if (!applies) {
      skipped.push({ rule: rule.id, reason: skipReason(rule.id, ctx) });
      continue;
    }

    let raw;
    try { raw = await rule.check(ctx); }
    catch (err) {
      findings.push(errorFinding(ctx, rule.id, `check threw: ${err.message}`));
      continue;
    }

    for (const f of raw) {
      filesTouched.add(f.file);
      // Apply ignore directives keyed by file source.
      const fileSrc = await readForIgnore(ctx, f.file, ignoreScopes);
      if (fileSrc && isIgnored(fileSrc, f.line, rule.id)) continue;

      const id = makeId(rule.id, f.file, f.line, f.fields, ctx.cwd);
      const matchedBy = ignoreFileMatch(ignoreFile, rule.id, id);
      if (matchedBy) {
        ignored.push({ rule: rule.id, id, matchedBy });
        continue;
      }
      findings.push({
        id,
        ruleId: rule.id,
        severity: f.severity ?? rule.severity,
        file: f.file,
        line: f.line ?? 0,
        fields: { ...f.fields, file: relativeOrCwd(f.file, ctx.cwd) },
        explain: explain ? f.explain : undefined,
        fixable: FIXABLE_RULES.has(rule.id),
      });
    }
  }

  const filtered = filterBySeverity(findings, reportLevel);
  const gatingFindings = filterBySeverity(findings, failLevel);
  const incomplete = completenessGaps(skipped, ctx.registryData);
  const failOn = failOnIds?.length ? [...failOnIds] : null;
  const findingStatus = failOn
    ? (gatingFindings.some(f => failOn.includes(f.ruleId)) ? 'FAIL' : 'OK')
    : (gatingFindings.length === 0 ? 'OK' : 'FAIL');
  const status = requireComplete && incomplete.length > 0 ? 'FAIL' : findingStatus;
  return {
    pm: {
      kind: ctx.pm.kind,
      version: ctx.pm.version,
      lockfile: ctx.pm.lockfile,
      source: ctx.pm.source,
      multipleLockfiles: ctx.pm.multipleLockfiles,
    },
    workspaces: (ctx.workspaces ?? []).map(w => w.relative),
    files: [...filesTouched],
    findings: filtered,
    ignored,
    summary: { findings: filtered.length, ...summarize(filtered), ignored: ignored.length },
    status,
    skipped,
    filter: selectedRuleIds?.length ? selectedRules.map(r => r.id) : null,
    failOn,
    explain,
    requireComplete,
    incomplete,
    levels: { report: reportLevel, fail: failLevel },
    policy: { version: policy.version, path: loadedPolicy.path },
    registry: ctx.registryData
      ? { url: ctx.registryData.registryUrl, errors: ctx.registryData.errors, blocked: Boolean(ctx.registryData.blocked) }
      : null,
  };
}

/**
 * Resolve the rule set to run. With no filter, every rule runs. Unknown ids
 * fail fast so a typo never silently audits nothing. RULES order is preserved
 * for deterministic output.
 *
 * @param {string[]|undefined} ids
 * @returns {typeof RULES}
 */
function selectRules(ids) {
  if (!ids || ids.length === 0) return RULES;
  assertKnownRuleIds(ids, '--rule');
  const wanted = new Set(ids);
  return RULES.filter(r => wanted.has(r.id));
}

/**
 * Throw on any rule id that isn't in the registry, so a typo in `--rule` /
 * `--fail-on` fails fast instead of silently matching nothing.
 *
 * @param {string[]} ids
 * @param {string} flag   the flag name, for the error message
 */
function assertKnownRuleIds(ids, flag) {
  const known = new Set(RULES.map(r => r.id));
  const unknown = ids.filter(id => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`unknown rule id(s) for ${flag}: ${unknown.join(', ')}. Run \`deps-warden rules\` to list valid ids.`);
  }
}

function skipReason(ruleId, ctx) {
  if (ruleId === 'lockfile-committed' || ruleId === 'no-committed-auth') {
    if (ctx.gitTracked === null) return 'no-git-index';
  }
  if (ruleId === 'lockfile-committed' && ctx.pm.lockfile === null) return 'no-lockfile';
  if (ruleId === 'single-package-manager' && ctx.pm.multipleLockfiles.length === 0) return 'single-lockfile';
  if (ruleId === 'github-actions-immutable') return 'no-github-workflows';
  if (ruleId.startsWith('npm-') && ctx.pm.kind !== 'npm') return `pm-not-npm`;
  if (ruleId.startsWith('pnpm-') && ctx.pm.kind !== 'pnpm') return 'pm-not-pnpm';
  if (ruleId === 'min-release-age' && !['npm', 'pnpm'].includes(ctx.pm.kind)) return 'pm-unsupported';
  if (ruleId === 'unused-allowlist-entries' && !['pnpm', 'bun'].includes(ctx.pm.kind)) return 'pm-unsupported';
  if (ruleId === 'recommend-stricter-pm' && !['npm', 'yarn-classic'].includes(ctx.pm.kind)) return 'pm-already-strict';
  if (VERSION_RULES.has(ruleId) && !ctx.options?.checkVersions) return 'check-versions-off';
  return 'not-applicable';
}

function errorFinding(ctx, ruleId, message) {
  return {
    id: makeId(ruleId, ctx.cwd, 0, { error: message }, ctx.cwd),
    ruleId: 'rule-error',
    severity: 'high',
    file: ctx.cwd,
    line: 0,
    fields: { type: 'rule-error', sev: 'high', rule: ruleId, msg: message },
    explain: undefined,
  };
}

async function readForIgnore(ctx, path, cacheMap) {
  if (cacheMap.has(path)) return cacheMap.get(path);
  const src = await ctx.readText(path);
  const scope = src ? parseIgnoreDirectives(src) : null;
  cacheMap.set(path, scope);
  return scope;
}

function makeId(ruleId, file, line, fields, cwd) {
  const stableFile = relativeOrCwd(file, cwd);
  return createHash('sha1')
    .update(`${ruleId}:${stableFile}:${line}:${stableStringify(fields)}`)
    .digest('hex')
    .slice(0, 10);
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj).toSorted();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function filterBySeverity(findings, minSeverity) {
  if (!minSeverity) return findings;
  const minIdx = SEVERITY_ORDER.indexOf(minSeverity);
  if (minIdx === -1) return findings;
  return findings.filter(f => SEVERITY_ORDER.indexOf(f.severity) >= minIdx);
}

function assertValidLevels(reportLevel, failLevel) {
  const reportIdx = SEVERITY_ORDER.indexOf(reportLevel);
  const failIdx = SEVERITY_ORDER.indexOf(failLevel);
  if (reportIdx === -1) throw new Error(`unknown report level: ${reportLevel}`);
  if (failIdx === -1) throw new Error(`unknown fail level: ${failLevel}`);
  if (reportIdx > failIdx) {
    throw new Error('report level must be equal to or lower than fail level so every gating finding is visible');
  }
}

function relativeOrCwd(path, cwd) {
  if (path === cwd) return '.';
  const rel = relative(cwd, path);
  return rel === '' ? '.' : rel;
}

/**
 * Render an AuditResult into the requested format.
 *
 * @param {AuditResult} result
 * @param {{format?: 'toon'|'json'|'text', explain?: boolean, cwd?: string, verbose?: boolean}} [opts]
 * @returns {string}
 */
export function renderAudit(result, opts = {}) {
  const fmt = opts.format ?? 'toon';
  const records = [];
  records.push({ label: 'PM', fields: {
    kind: result.pm.kind,
    version: result.pm.version ?? '',
    lockfile: result.pm.lockfile ? relativeOrCwd(result.pm.lockfile, opts.cwd ?? process.cwd()) : '',
    source: result.pm.source,
  } });

  records.push({ label: 'POLICY', fields: {
    version: result.policy?.version ?? 1,
    file: result.policy?.path ? relativeOrCwd(result.policy.path, opts.cwd ?? process.cwd()) : 'defaults',
    report_level: result.levels?.report ?? 'low',
    fail_level: result.levels?.fail ?? 'low',
    require_complete: Boolean(result.requireComplete),
  } });

  if (result.filter) {
    records.push({ label: 'FILTER', fields: { rules: result.filter.join(',') } });
  }

  for (const ws of result.workspaces ?? []) {
    if (ws === '.') continue;
    records.push({ label: 'WORKSPACE', fields: { path: ws } });
  }

  for (const f of result.files) {
    records.push({ label: 'SCAN', fields: { file: relativeOrCwd(f, opts.cwd ?? process.cwd()) } });
  }

  if (opts.verbose) {
    for (const s of result.skipped ?? []) {
      records.push({ label: 'SKIP', fields: { rule: s.rule, reason: s.reason } });
    }
  }
  if (result.registry) {
    records.push({ label: 'REGISTRY', fields: { url: result.registry.url, checked: true, blocked: Boolean(result.registry.blocked) } });
    for (const e of result.registry.errors ?? []) {
      records.push({ label: 'NOTE', fields: { registry: 'unreachable', package: e.name, error: e.error } });
    }
  }
  if (result.incomplete?.length) {
    records.push({ label: 'COVERAGE', fields: {
      complete: false,
      required: Boolean(result.requireComplete),
      gaps: result.incomplete.map(gap => `${gap.rule}:${gap.reason}`).join(','),
    } });
  }
  for (const f of result.findings) {
    const fields = {
      id: f.id,
      type: f.ruleId,
      sev: f.severity,
      fix: f.fixable ? 'auto' : 'manual',
      line: f.line || '',
      ...f.fields,
    };
    if ((opts.explain ?? result.explain) && f.explain) fields.explain = f.explain;
    records.push({ label: 'FINDING', fields });
  }
  for (const ig of result.ignored ?? []) {
    records.push({ label: 'IGNORED', fields: { rule: ig.rule, id: ig.id, matchedBy: ig.matchedBy, source: 'ignore-file' } });
  }
  records.push({ label: 'SUMMARY', fields: {
    findings: result.summary.findings,
    critical: result.summary.critical,
    high: result.summary.high,
    medium: result.summary.medium,
    low: result.summary.low,
    ignored: result.summary.ignored ?? 0,
    skipped: result.skipped?.length ?? 0,
  } });

  if (result.failOn) {
    const triggered = [...new Set(result.findings.filter(f => result.failOn.includes(f.ruleId)).map(f => f.ruleId))];
    records.push({ label: 'GATE', fields: {
      fail_on: result.failOn.join(','),
      triggered_by: triggered.join(','),
      result: result.status === 'OK' ? 'pass' : 'fail',
    } });
  }

  for (const hint of nextSteps(result)) records.push(hint);

  return format(fmt, records, { status: result.status, json: result });
}

function completenessGaps(skipped, registryData) {
  const gaps = skipped
    .filter(item => item.reason === 'no-git-index')
    .map(item => ({ rule: item.rule, reason: item.reason }));
  if (registryData?.errors?.length) {
    gaps.push({ rule: 'registry-version-checks', reason: registryData.blocked ? 'blocked-registry' : 'network-errors' });
  }
  return gaps;
}

/**
 * End-of-run guidance so a human or LLM knows how to act on the findings.
 * Emitted only when there are findings. The `fix=auto` findings can be applied
 * with `fix --finding=<id>`; `fix=manual` ones need a hand edit (use --explain).
 *
 * @param {AuditResult} result
 * @returns {Array<{label: string, fields: Record<string, unknown>}>}
 */
function nextSteps(result) {
  if (result.findings.length === 0) return [];
  const autoFixable = result.findings.filter(f => f.fixable);
  const fields = {};
  if (autoFixable.length > 0) {
    fields.plan = `deps-warden plan --finding=${autoFixable[0].id} --output=deps-warden-plan.json`;
    fields.validate = 'deps-warden apply deps-warden-plan.json';
    fields.apply = 'add --write only after reviewing the plan';
  }
  fields.auto_fixable = autoFixable.length;
  fields.manual = result.findings.length - autoFixable.length;
  fields.explain = 'deps-warden audit --explain';
  fields.suppress = 'add a rule-id or finding-id to .deps-warden-ignore';
  return [{ label: 'HINT', fields }];
}
