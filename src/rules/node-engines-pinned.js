/**
 * package.json should declare an `engines.node` range so consumers and CI
 * agree on a target Node version.
 */

import { setNestedKey } from '../lib/pkgJsonParser.js';
import { join } from 'node:path';

export const id = 'node-engines-pinned';
export const severity = 'medium';
export const description = '`engines.node` is not declared in package.json.';

export function appliesTo(ctx) { return ctx.pkg !== null; }

export async function check(ctx) {
  const findings = [];
  for (const ws of ctx.workspaces ?? [{ path: ctx.cwd, pkg: ctx.pkg, relative: '.', isRoot: true }]) {
    if (!ws.pkg || !ws.pkg.raw) continue;
    const raw = ws.pkg.raw;
    if (raw.engines && typeof raw.engines.node === 'string' && raw.engines.node.trim() !== '') continue;
    findings.push({
      severity,
      file: join(ws.path, 'package.json'),
      line: ws.pkg.topLevelLines.get('engines') ?? 0,
      fields: { type: id, sev: severity, workspace: ws.relative },
      explain: 'add `"engines": {"node": ">=20.0.0"}` (or the version your project supports) to package.json',
    });
  }
  return findings;
}

export async function fix(ctx, finding) {
  const wsPath = workspacePathFor(ctx, finding);
  const file = join(wsPath, 'package.json');
  const src = (await ctx.readText(file)) ?? '{}';
  const ws = (ctx.workspaces ?? []).find(w => w.path === wsPath);
  const current = ws?.pkg?.raw?.engines ?? {};
  const next = { ...current, node: current.node ?? '>=20.0.0' };
  const content = setNestedKey(src, ['engines'], next);
  return [{ file, content, summary: `add engines.node to ${ws?.relative ?? '.'}/package.json` }];
}

function workspacePathFor(ctx, finding) {
  const rel = finding?.fields?.workspace ?? '.';
  if (rel === '.') return ctx.cwd;
  const match = (ctx.workspaces ?? []).find(w => w.relative === rel);
  return match ? match.path : ctx.cwd;
}

export function explain() {
  return 'Without engines.node, contributors run whatever Node they have '
       + 'installed and CI runs whatever the image ships. Mismatched Node '
       + 'major versions are a steady source of "works on my machine".';
}
