/**
 * Versioned project policy loading and validation.
 */

import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import YAML from 'yaml';

import { RULES } from '../rules/index.js';
import { SEVERITY_ORDER } from './formatter.js';

export const POLICY_VERSION = 1;
export const POLICY_FILENAMES = ['.deps-warden.yml', '.deps-warden.yaml'];

export const DEFAULT_POLICY = Object.freeze({
  version: POLICY_VERSION,
  scan: Object.freeze({
    reportLevel: 'low',
    failLevel: 'low',
    rules: Object.freeze([]),
    failOn: Object.freeze([]),
    explain: true,
    requireComplete: false,
  }),
  network: Object.freeze({
    mode: 'off',
    trustedRegistries: Object.freeze([]),
  }),
});

/**
 * @param {{cwd?: string, path?: string, required?: boolean}} [options]
 */
export async function loadPolicy(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const path = options.path
    ? resolvePolicyPath(cwd, options.path)
    : await discoverPolicyPath(cwd);

  if (!path) {
    if (options.required) throw new Error(`policy file not found (expected ${POLICY_FILENAMES.join(' or ')})`);
    return { policy: cloneDefaultPolicy(), path: null, source: null };
  }

  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read policy ${path}: ${err.message}`, { cause: err });
  }
  const policy = parsePolicy(source, path);
  return { policy, path, source };
}

/**
 * @param {string} source
 * @param {string} [sourceName]
 */
export function parsePolicy(source, sourceName = '<policy>') {
  const doc = YAML.parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new Error(`invalid policy YAML in ${sourceName}: ${doc.errors[0].message}`);
  }
  let raw;
  try {
    raw = doc.toJS({ maxAliasCount: 20 });
  } catch (err) {
    throw new Error(`invalid policy YAML in ${sourceName}: ${err.message}`, { cause: err });
  }
  return validatePolicy(raw, sourceName);
}

/**
 * @param {unknown} raw
 * @param {string} [sourceName]
 */
export function validatePolicy(raw, sourceName = '<policy>') {
  assertObject(raw, sourceName);
  assertKnownKeys(raw, ['version', 'scan', 'network'], sourceName);
  if (raw.version !== POLICY_VERSION) {
    throw new Error(`${sourceName}: unsupported policy version ${String(raw.version)}; expected ${POLICY_VERSION}`);
  }

  const scan = raw.scan ?? {};
  assertObject(scan, `${sourceName}.scan`);
  assertKnownKeys(scan, ['reportLevel', 'failLevel', 'rules', 'failOn', 'explain', 'requireComplete'], `${sourceName}.scan`);

  const network = raw.network ?? {};
  assertObject(network, `${sourceName}.network`);
  assertKnownKeys(network, ['mode', 'trustedRegistries'], `${sourceName}.network`);

  const reportLevel = scan.reportLevel ?? DEFAULT_POLICY.scan.reportLevel;
  const failLevel = scan.failLevel ?? DEFAULT_POLICY.scan.failLevel;
  assertSeverity(reportLevel, `${sourceName}.scan.reportLevel`);
  assertSeverity(failLevel, `${sourceName}.scan.failLevel`);
  if (SEVERITY_ORDER.indexOf(reportLevel) > SEVERITY_ORDER.indexOf(failLevel)) {
    throw new Error(`${sourceName}: reportLevel must be equal to or lower than failLevel so every gating finding is visible`);
  }

  const rules = validateRuleList(scan.rules ?? [], `${sourceName}.scan.rules`);
  const failOn = validateRuleList(scan.failOn ?? [], `${sourceName}.scan.failOn`);
  if (scan.explain !== undefined && typeof scan.explain !== 'boolean') {
    throw new Error(`${sourceName}.scan.explain must be a boolean`);
  }
  if (scan.requireComplete !== undefined && typeof scan.requireComplete !== 'boolean') {
    throw new Error(`${sourceName}.scan.requireComplete must be a boolean`);
  }

  const mode = network.mode ?? DEFAULT_POLICY.network.mode;
  if (!['off', 'registry'].includes(mode)) {
    throw new Error(`${sourceName}.network.mode must be off or registry`);
  }
  const trustedRegistries = validateStringList(
    network.trustedRegistries ?? [],
    `${sourceName}.network.trustedRegistries`,
  );

  return {
    version: POLICY_VERSION,
    scan: {
      reportLevel,
      failLevel,
      rules,
      failOn,
      explain: scan.explain ?? DEFAULT_POLICY.scan.explain,
      requireComplete: scan.requireComplete ?? DEFAULT_POLICY.scan.requireComplete,
    },
    network: { mode, trustedRegistries },
  };
}

export function defaultPolicyYaml() {
  return YAML.stringify(cloneDefaultPolicy(), { lineWidth: 0 });
}

function cloneDefaultPolicy() {
  return {
    version: DEFAULT_POLICY.version,
    scan: {
      reportLevel: DEFAULT_POLICY.scan.reportLevel,
      failLevel: DEFAULT_POLICY.scan.failLevel,
      rules: [],
      failOn: [],
      explain: DEFAULT_POLICY.scan.explain,
      requireComplete: DEFAULT_POLICY.scan.requireComplete,
    },
    network: { mode: DEFAULT_POLICY.network.mode, trustedRegistries: [] },
  };
}

async function discoverPolicyPath(cwd) {
  const found = [];
  for (const filename of POLICY_FILENAMES) {
    const path = join(cwd, filename);
    try {
      await access(path);
      found.push(path);
    } catch { /* absent */ }
  }
  if (found.length > 1) {
    throw new Error(`multiple policy files found: ${found.join(', ')}`);
  }
  return found[0] ?? null;
}

function resolvePolicyPath(cwd, path) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function validateRuleList(value, path) {
  const rules = validateStringList(value, path);
  const known = new Set(RULES.map(rule => rule.id));
  const unknown = rules.filter(rule => !known.has(rule));
  if (unknown.length > 0) throw new Error(`${path} contains unknown rule id(s): ${unknown.join(', ')}`);
  return rules;
}

function validateStringList(value, path) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${path} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${path} must not contain duplicates`);
  return [...value];
}

function assertSeverity(value, path) {
  if (!SEVERITY_ORDER.includes(value)) {
    throw new Error(`${path} must be one of ${SEVERITY_ORDER.join(', ')}`);
  }
}

function assertObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be a mapping`);
  }
}

function assertKnownKeys(value, allowed, path) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${path} contains unknown key(s): ${unknown.join(', ')}`);
}
