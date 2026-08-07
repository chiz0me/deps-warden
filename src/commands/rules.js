/**
 * `rules` — list the rule registry.
 */

import { listRules } from '../rules/index.js';
import { format } from '../lib/formatter.js';

/**
 * @returns {Promise<{rules: Array<object>, status: 'OK'}>}
 */
export async function rules() {
  return { rules: listRules(), status: 'OK' };
}

/**
 * @param {{rules: Array<object>, status: 'OK'}} result
 * @param {{format?: 'toon'|'json'|'text'}} [opts]
 * @returns {string}
 */
export function renderRules(result, opts = {}) {
  const fmt = opts.format ?? 'toon';
  const records = result.rules.map(r => ({ label: 'RULE', fields: r }));
  return format(fmt, records, { status: result.status, json: result });
}
