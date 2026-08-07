/**
 * Adapter registry. Each adapter exposes the same shape so rules never branch
 * on PM kind internally.
 *
 * @typedef {object} ProposedWrite
 * @property {string} file        absolute path
 * @property {string} content     full new file content
 * @property {string} summary
 *
 * @typedef {object} ConfigValue
 * @property {unknown} value
 * @property {{file: string, line: number}|null} source
 *
 * @typedef {object} AllowlistValue
 * @property {string[]} entries
 * @property {{file: string}|null} source
 *
 * @typedef {object} Adapter
 * @property {import('../lib/detect.js').PmKind} kind
 * @property {(ctx: import('../lib/context.js').Ctx, key: string) => Promise<ConfigValue>} getConfig
 * @property {(ctx: import('../lib/context.js').Ctx, key: string, value: unknown) => Promise<ProposedWrite>} setConfig
 * @property {(ctx: import('../lib/context.js').Ctx) => Promise<AllowlistValue>} getAllowlist
 * @property {(ctx: import('../lib/context.js').Ctx, pkgs: string[]) => Promise<ProposedWrite>} addToAllowlist
 * @property {(ctx: import('../lib/context.js').Ctx, pkgs: string[]) => Promise<ProposedWrite>} removeFromAllowlist
 * @property {(ctx: import('../lib/context.js').Ctx, kind: 'main'|'workspace'|'auth') => string|null} getConfigFilePath
 */

import * as npm from './npm.js';
import * as pnpm from './pnpm.js';

const ADAPTERS = {
  npm,
  pnpm,
};

/**
 * @param {import('../lib/detect.js').PmKind} kind
 * @returns {Adapter}
 */
export function selectAdapter(kind) {
  const adapter = ADAPTERS[kind];
  if (!adapter) {
    throw new Error(
      `package manager "${kind}" is detected but not yet supported; this version supports npm and pnpm`,
    );
  }
  return adapter;
}
