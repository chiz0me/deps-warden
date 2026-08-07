/**
 * Allowlist entries (pnpm allowBuilds / onlyBuiltDependencies, bun
 * trustedDependencies) that point to packages with no current lifecycle
 * scripts are *dormant privilege*. If the package later re-adds a script —
 * for example via a compromised release — it runs without further review
 * because the package is already trusted.
 *
 * Fires only when node_modules is populated so we can compare against
 * actual installed scripts.
 */

import { relative } from 'node:path';
import { enumerateDirectDepsWithScripts } from '../lib/lifecycleScripts.js';

export const id = 'unused-allowlist-entries';
export const severity = 'medium';
export const description = 'Allowlist contains packages whose installed version has no lifecycle scripts.';

const SUPPORTED = new Set(['pnpm', 'bun']);

export function appliesTo(ctx) {
  return SUPPORTED.has(ctx.pm.kind);
}

export async function check(ctx) {
  const allow = await ctx.pm.adapter.getAllowlist(ctx);
  if (allow.entries.length === 0 || allow.source === null) return [];

  const deps = await enumerateDirectDepsWithScripts(ctx);
  if (deps.length === 0) return [];

  const depsByName = new Map(deps.map(d => [d.name, d]));
  const dormant = [];
  for (const entry of allow.entries) {
    const dep = depsByName.get(entry);
    if (!dep) continue; // not a direct dep at all (transitive); skip
    if (!dep.installed) continue;
    if (!dep.hasScripts) dormant.push(entry);
  }
  if (dormant.length === 0) return [];

  return [{
    severity,
    file: allow.source.file,
    line: 0,
    fields: {
      type: id,
      sev: severity,
      file: relative(ctx.cwd, allow.source.file),
      dormant: dormant.join(','),
      count: dormant.length,
    },
    explain: `remove dormant entries (${dormant.join(', ')}); their current version has no lifecycle scripts so the allowlist grant is unnecessary trust`,
  }];
}

export async function fix(ctx, _finding) {
  const allow = await ctx.pm.adapter.getAllowlist(ctx);
  const deps = await enumerateDirectDepsWithScripts(ctx);
  const depsByName = new Map(deps.map(d => [d.name, d]));
  const dormant = allow.entries.filter(e => {
    const dep = depsByName.get(e);
    return dep && dep.installed && !dep.hasScripts;
  });
  if (dormant.length === 0) return [];
  return [await ctx.pm.adapter.removeFromAllowlist(ctx, dormant)];
}

export function explain() {
  return 'A dormant allowlist entry is a standing grant of install-time '
       + 'code execution for a package that currently has no scripts. '
       + 'When the next version is published — possibly by an attacker who '
       + 'compromised the maintainer account — and re-introduces a '
       + 'postinstall, that script runs on first install without prompting '
       + 'the team for review.';
}
