/**
 * The configured registry should be a known-trusted host.
 *
 * Default trust list: registry.npmjs.org, npm.pkg.github.com. Callers can
 * extend via ctx.options.trustedRegistries.
 */

import { relative } from 'node:path';
import { parseNpmrc } from '../lib/npmrcParser.js';
import { parseYaml, getYamlValue } from '../lib/yamlParser.js';
import { assessRegistryUrl, DEFAULT_TRUSTED_REGISTRIES } from '../lib/registryTrust.js';

export const id = 'trusted-registry';
export const severity = 'high';
export const description = 'Registry is not in the trusted-host list.';

export function appliesTo() { return true; }

export async function check(ctx) {
  const configured = await collectConfiguredRegistries(ctx);
  const findings = [];
  for (const item of configured) {
    const assessment = item.reason
      ? { ok: false, host: '', reason: item.reason }
      : assessRegistryUrl(item.value, ctx.options?.trustedRegistries ?? []);
    if (assessment.ok) continue;
    findings.push({
      severity,
      file: item.file,
      line: item.line,
      fields: {
        type: id,
        sev: severity,
        key: item.key,
        registry: item.value,
        host: assessment.host,
        reason: assessment.reason,
        file: relative(ctx.cwd, item.file),
      },
      explain: remediation(assessment.reason),
    });
  }
  return findings;
}

export function explain() {
  return 'A surprise registry override (sometimes pushed inadvertently via '
       + '.npmrc or .yarnrc.yml) silently redirects every install to a '
       + 'mirror or proxy — useful for attackers serving tampered tarballs '
       + 'or for accidental dependency confusion.';
}

async function collectConfiguredRegistries(ctx) {
  const out = [];
  const npmrcFile = ctx.pm.adapter.getConfigFilePath(ctx, 'main');
  const npmrcSource = npmrcFile ? await ctx.readText(npmrcFile) : null;
  if (npmrcFile && npmrcSource) {
    const ast = parseNpmrc(npmrcSource);
    for (const [key, entry] of ast.scalars) {
      if (key === 'registry' || key.endsWith(':registry')) {
        out.push({ key, value: entry.value, file: npmrcFile, line: entry.line });
      }
      if (key === 'strict-ssl' && entry.value === 'false') {
        out.push({ key, value: 'false', reason: 'tls-verification-disabled', file: npmrcFile, line: entry.line });
      }
    }
  }

  if (ctx.pm.kind === 'pnpm') {
    const yamlFile = ctx.pm.adapter.getConfigFilePath(ctx, 'workspace');
    const source = yamlFile ? await ctx.readText(yamlFile) : null;
    if (yamlFile && source) {
      const doc = parseYaml(source);
      for (const section of ['registries', 'namedRegistries']) {
        const hit = getYamlValue(doc, [section]);
        if (!hit || !isPlainObject(hit.value)) continue;
        for (const [name, value] of Object.entries(hit.value)) {
          if (typeof value === 'string') {
            out.push({ key: `${section}.${name}`, value, file: yamlFile, line: hit.line });
          }
        }
      }
    }
  }
  return out;
}

function remediation(reason) {
  if (reason === 'invalid-url') return 'replace the malformed registry with a complete HTTPS URL';
  if (reason === 'insecure-protocol') return 'use HTTPS and keep strict-ssl enabled for every registry';
  if (reason === 'embedded-credentials') return 'remove credentials from the registry URL and use environment-backed authentication';
  if (reason === 'tls-verification-disabled') return 'remove strict-ssl=false; registry TLS certificate verification must stay enabled';
  return `use one of the approved registries (${DEFAULT_TRUSTED_REGISTRIES.join(', ')}) or add this exact host to reviewed project policy`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
