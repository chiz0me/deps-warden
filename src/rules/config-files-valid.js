/** Fail closed when a security-relevant project file cannot be parsed. */

import { join, relative } from 'node:path';
import YAML from 'yaml';

import { parseNpmrc } from '../lib/npmrcParser.js';

export const id = 'config-files-valid';
export const severity = 'critical';
export const description = 'A package-manager manifest, lockfile, or configuration file is malformed.';

export function appliesTo() { return true; }

export async function check(ctx) {
  const findings = [];
  await checkJson(ctx, join(ctx.cwd, 'package.json'), findings);

  if (ctx.pm.lockfile?.endsWith('package-lock.json') || ctx.pm.lockfile?.endsWith('npm-shrinkwrap.json')) {
    await checkJson(ctx, ctx.pm.lockfile, findings);
  } else if (ctx.pm.lockfile?.endsWith('pnpm-lock.yaml')) {
    await checkYaml(ctx, ctx.pm.lockfile, findings);
  }

  const main = ctx.pm.adapter.getConfigFilePath(ctx, 'main');
  if (main?.endsWith('.npmrc')) {
    const source = await ctx.readText(main);
    if (source !== null) {
      const ast = parseNpmrc(source);
      for (const error of ast.errors) addFinding(ctx, findings, main, error.line, error.message);
    }
  }

  const workspace = ctx.pm.adapter.getConfigFilePath(ctx, 'workspace');
  if (workspace) await checkYaml(ctx, workspace, findings);
  return findings;
}

async function checkJson(ctx, file, findings) {
  const source = await ctx.readText(file);
  if (source === null) return;
  try { JSON.parse(source); }
  catch (error) { addFinding(ctx, findings, file, jsonErrorLine(source, error), error.message); }
}

async function checkYaml(ctx, file, findings) {
  const source = await ctx.readText(file);
  if (source === null) return;
  const doc = YAML.parseDocument(source, { uniqueKeys: true });
  for (const error of doc.errors) {
    addFinding(ctx, findings, file, error.linePos?.[0]?.line ?? 0, error.message);
  }
}

function addFinding(ctx, findings, file, line, message) {
  findings.push({
    severity,
    file,
    line,
    fields: { type: id, sev: severity, file: relative(ctx.cwd, file), parse_error: message },
    explain: 'repair this file before relying on any other audit result; malformed security configuration is treated as incomplete evidence',
  });
}

function jsonErrorLine(source, error) {
  const match = /position\s+(\d+)/i.exec(error?.message ?? '');
  if (!match) return 0;
  return source.slice(0, Number(match[1])).split('\n').length;
}

export function explain() {
  return 'A parser failure can hide package-manager settings and dependency '
       + 'metadata from every downstream rule. deps-warden fails closed until '
       + 'the manifest, lockfile, or configuration is valid.';
}
