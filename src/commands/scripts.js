/**
 * `scripts` — list direct dependencies' lifecycle scripts and manage the
 * package manager's allowlist (pnpm allowBuilds / onlyBuiltDependencies, bun
 * trustedDependencies).
 *
 * Operations:
 *   - no flags: list deps with scripts and current allowlist (read-only)
 *   - --add-to-allowlist=<pkg,pkg>:    merge into allowlist
 *   - --remove-from-allowlist=<pkg,pkg>: drop from allowlist
 */

import { relative } from 'node:path';

import { buildContext } from '../lib/context.js';
import { enumerateDirectDepsWithScripts } from '../lib/lifecycleScripts.js';
import { writeFileGuarded } from '../lib/writer.js';
import { unifiedDiff } from '../lib/diff.js';
import { format } from '../lib/formatter.js';

/**
 * @typedef {object} ScriptsOptions
 * @property {string} [cwd]
 * @property {import('../lib/detect.js').PmKind} [pmOverride]
 * @property {string[]} [add]
 * @property {string[]} [remove]
 * @property {boolean} [dryRun]
 *
 * @typedef {object} ScriptsResult
 * @property {object} pm
 * @property {Array<object>} deps               from enumerateDirectDepsWithScripts
 * @property {{entries: string[], source: object|null}} allowlist
 * @property {Array<object>} changes
 * @property {'OK'|'FAIL'} status
 * @property {string} [error]
 */

/**
 * @param {ScriptsOptions} opts
 * @returns {Promise<ScriptsResult>}
 */
export async function scripts(opts = {}) {
  const ctx = await buildContext({ cwd: opts.cwd, pmOverride: opts.pmOverride });
  const dryRun = opts.dryRun !== false;

  const deps = await enumerateDirectDepsWithScripts(ctx);
  const allowlist = await ctx.pm.adapter.getAllowlist(ctx);

  const add = (opts.add ?? []).filter(Boolean);
  const remove = (opts.remove ?? []).filter(Boolean);
  const changes = [];

  if (add.length === 0 && remove.length === 0) {
    return {
      pm: { kind: ctx.pm.kind },
      deps, allowlist, changes,
      status: 'OK',
    };
  }

  if (add.length > 0 && remove.length > 0) {
    return {
      pm: { kind: ctx.pm.kind },
      deps, allowlist, changes,
      status: 'FAIL',
      error: 'add and remove cannot be combined safely in one invocation; run them separately',
    };
  }

  try {
    if (add.length > 0) {
      const proposal = await ctx.pm.adapter.addToAllowlist(ctx, add);
      const result = await applyProposal(ctx, proposal, dryRun);
      changes.push({ kind: 'add', pkgs: add, ...result });
    }
    if (remove.length > 0) {
      const proposal = await ctx.pm.adapter.removeFromAllowlist(ctx, remove);
      const result = await applyProposal(ctx, proposal, dryRun);
      changes.push({ kind: 'remove', pkgs: remove, ...result });
    }
  } catch (err) {
    return {
      pm: { kind: ctx.pm.kind },
      deps, allowlist, changes,
      status: 'FAIL',
      error: err.message,
    };
  }

  return {
    pm: { kind: ctx.pm.kind },
    deps, allowlist, changes,
    status: 'OK',
  };
}

async function applyProposal(ctx, proposal, dryRun) {
  const current = (await ctx.readText(proposal.file)) ?? '';
  const diff = unifiedDiff(current, proposal.content, relative(ctx.cwd, proposal.file)) ?? '';
  const writeResult = await writeFileGuarded({
    path: proposal.file,
    content: proposal.content,
    dryRun,
    cwd: ctx.cwd,
  });
  return {
    file: proposal.file,
    summary: proposal.summary,
    beforeBytes: Buffer.byteLength(current, 'utf8'),
    afterBytes: writeResult.bytes,
    diff,
    written: writeResult.written,
  };
}

/**
 * @param {ScriptsResult} result
 * @param {{format?: 'toon'|'json'|'text', cwd?: string, dryRun?: boolean}} [opts]
 * @returns {string}
 */
export function renderScripts(result, opts = {}) {
  const fmt = opts.format ?? 'toon';
  const cwd = opts.cwd ?? process.cwd();
  const records = [];
  if (result.error) {
    records.push({ label: 'ERROR', fields: { msg: result.error } });
  }

  const withScripts = result.deps.filter(d => d.hasScripts);
  const installedCount = result.deps.filter(d => d.installed).length;
  // Lifecycle scripts can only be read from installed packages. When deps are
  // declared but none are on disk, with_scripts=0 means "couldn't check", not
  // "none run scripts" — say so instead of emitting a wall of unknowns.
  if (result.deps.length > 0 && installedCount === 0) {
    records.push({ label: 'NOTE', fields: {
      scripts: 'undetermined',
      reason: 'node_modules not installed; run install, then re-run to detect lifecycle scripts',
    } });
  }
  // Only deps that actually declare install scripts are worth listing — that
  // is the command's purpose and what feeds the allowlist decision.
  for (const d of withScripts) {
    records.push({ label: 'DEP', fields: {
      name: d.name,
      ver: d.version ?? '',
      scripts: d.scripts.join(','),
    } });
  }
  records.push({ label: 'ALLOWLIST', fields: {
    file: result.allowlist.source ? relative(cwd, result.allowlist.source.file) : '',
    entries: result.allowlist.entries.length,
    list: result.allowlist.entries.join(',') || '',
  } });
  for (const c of result.changes) {
    records.push({ label: 'EDIT', fields: {
      kind: c.kind,
      pkgs: c.pkgs.join(','),
      file: relative(cwd, c.file),
      summary: c.summary,
      written: c.written,
    } });
  }
  records.push({ label: 'SCRIPTS', fields: {
    direct_deps: result.deps.length,
    with_scripts: withScripts.length,
    installed: installedCount,
    allowlist: result.allowlist.entries.length,
    edits: result.changes.length,
  } });
  let payload = format(fmt, records, { status: result.status, json: result });
  if (fmt !== 'json') {
    for (const c of result.changes) {
      if (c.diff) payload += '\n' + c.diff;
    }
  }
  return payload;
}
