/**
 * Policy initialization, validation, and display commands.
 */

import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

import { format } from '../lib/formatter.js';
import { defaultPolicyYaml, loadPolicy, POLICY_VERSION } from '../lib/policy.js';
import { writeFileGuarded } from '../lib/writer.js';

export async function initPolicy(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const path = resolve(cwd, options.path ?? '.deps-warden.yml');
  try {
    await access(path);
    return { status: 'FAIL', version: POLICY_VERSION, path, written: false, error: `policy already exists: ${path}` };
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      return { status: 'FAIL', version: POLICY_VERSION, path, written: false, error: `cannot access policy path: ${err.message}` };
    }
  }

  const content = defaultPolicyYaml();
  const write = await writeFileGuarded({ path, content, dryRun: options.dryRun !== false, cwd });
  return { status: 'OK', version: POLICY_VERSION, path, written: write.written, content };
}

export async function validatePolicyFile(options = {}) {
  try {
    const loaded = await loadPolicy({ cwd: options.cwd, path: options.path, required: true });
    return { status: 'OK', version: loaded.policy.version, path: loaded.path, policy: loaded.policy };
  } catch (err) {
    return { status: 'FAIL', version: null, path: options.path ?? null, policy: null, error: err.message };
  }
}

export async function showPolicy(options = {}) {
  try {
    const loaded = await loadPolicy({ cwd: options.cwd, path: options.path, required: false });
    return { status: 'OK', version: loaded.policy.version, path: loaded.path, policy: loaded.policy };
  } catch (err) {
    return { status: 'FAIL', version: null, path: options.path ?? null, policy: null, error: err.message };
  }
}

export function renderPolicy(result, options = {}) {
  const records = [];
  if (result.error) records.push({ label: 'ERROR', fields: { msg: result.error } });
  else records.push({ label: 'POLICY', fields: {
    version: result.version,
    file: result.path ?? 'defaults',
    written: result.written,
  } });
  return format(options.format ?? 'toon', records, { status: result.status, json: result });
}
