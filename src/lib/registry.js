/**
 * Opt-in npm-registry client.
 *
 * This is the ONLY module in deps-warden that touches the network, and it is
 * reached solely when `--check-versions` is passed (audit/report set
 * `ctx.options.checkVersions`). Responses are cached on disk via cache.js and
 * trimmed to the fields the version rules need. Every failure mode — timeout,
 * offline, non-2xx, malformed body — resolves to `{ ok: false, error }` so the
 * caller can soft-fail instead of crashing the audit.
 */

import { readCache, writeCache } from './cache.js';
import { assessRegistryUrl } from './registryTrust.js';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_TIMEOUT_MS = 5000;
const PACKUMENT_TTL_MS = 6 * 3600 * 1000;

/**
 * @typedef {object} SlimPackument
 * @property {string} name
 * @property {string|null} latest                 dist-tags.latest
 * @property {Record<string, {deprecated: string|null}>} versions
 * @property {Record<string, string>} time        version -> ISO publish timestamp
 *
 * @typedef {{ok: true, packument: SlimPackument, fromCache: boolean}
 *          | {ok: false, error: string}} PackumentResult
 */

/**
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {string} [opts.registryUrl]
 * @param {typeof globalThis.fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.ttlMs]
 */
export function createRegistryClient(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = opts.ttlMs ?? PACKUMENT_TTL_MS;
  const registryUrl = String(opts.registryUrl ?? DEFAULT_REGISTRY).replace(/\/+$/, '');

  return {
    registryUrl,
    /**
     * @param {string} name
     * @returns {Promise<PackumentResult>}
     */
    async fetchPackument(name) {
      const url = `${registryUrl}/${encodePackageName(name)}`;
      const cached = await readCache({ key: url, ttlMs, cwd });
      if (cached !== undefined) return { ok: true, packument: /** @type {SlimPackument} */ (cached), fromCache: true };

      if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch is unavailable in this runtime' };

      let res;
      try {
        res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        return { ok: false, error: err?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : (err?.message ?? 'network error') };
      }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

      let body;
      try { body = await res.json(); } catch { return { ok: false, error: 'invalid JSON in registry response' }; }

      const packument = slimPackument(name, body);
      await writeCache({ key: url, value: packument, ttlMs, cwd });
      return { ok: true, packument, fromCache: false };
    },
  };
}

/**
 * Prefetch packuments for every direct dependency in the project so the
 * version rules can run without each issuing its own network calls.
 *
 * @param {import('./context.js').Ctx} ctx
 * @returns {Promise<{registryUrl: string, packuments: Map<string, SlimPackument>, errors: Array<{name: string, error: string}>}|null>}
 */
export async function collectRegistryData(ctx) {
  if (!ctx.options?.checkVersions) return null;

  const reg = await ctx.pm.adapter.getConfig(ctx, 'registry');
  const registryUrl = typeof reg.value === 'string' && reg.value.trim() !== '' ? reg.value : DEFAULT_REGISTRY;
  const trust = assessRegistryUrl(registryUrl, ctx.options.trustedRegistries ?? []);
  if (!trust.ok) {
    return {
      registryUrl,
      packuments: new Map(),
      errors: [{ name: '<registry>', error: `registry blocked before network access: ${trust.reason}` }],
      blocked: true,
    };
  }
  const client = createRegistryClient({
    cwd: ctx.cwd,
    registryUrl,
    fetchImpl: ctx.options.fetchImpl,
    timeoutMs: ctx.options.registryTimeoutMs,
  });

  const names = directDepNames(ctx);
  const packuments = new Map();
  const errors = [];
  for (const name of names) {
    const result = await client.fetchPackument(name);
    if (result.ok) packuments.set(name, result.packument);
    else errors.push({ name, error: result.error });
  }
  return { registryUrl: client.registryUrl, packuments, errors, blocked: false };
}

const DEP_SECTIONS = ['dependencies', 'optionalDependencies'];

/**
 * Unique direct-dependency names across the root and every workspace.
 * devDependencies are excluded: they are not shipped and version-checking them
 * adds noise to a supply-chain audit.
 *
 * @param {import('./context.js').Ctx} ctx
 * @returns {string[]}
 */
function directDepNames(ctx) {
  const names = new Set();
  const workspaces = ctx.workspaces ?? [{ pkg: ctx.pkg }];
  for (const ws of workspaces) {
    if (!ws.pkg || !ws.pkg.raw) continue;
    for (const section of DEP_SECTIONS) {
      const deps = ws.pkg.raw[section];
      if (!deps || typeof deps !== 'object') continue;
      for (const name of Object.keys(deps)) names.add(name);
    }
  }
  return [...names].toSorted();
}

/**
 * @param {string} name
 * @returns {string}
 */
export function encodePackageName(name) {
  // Scoped packages keep their leading `@` but the `/` must be encoded.
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

/**
 * Trim a full packument to the fields the version rules consume. Keeping the
 * cache small and stable also makes test fixtures readable.
 *
 * @param {string} name
 * @param {Record<string, unknown>} body
 * @returns {SlimPackument}
 */
function slimPackument(name, body) {
  const distTags = isObject(body['dist-tags']) ? body['dist-tags'] : {};
  const latest = typeof distTags.latest === 'string' ? distTags.latest : null;

  const versions = {};
  const rawVersions = isObject(body.versions) ? body.versions : {};
  for (const [version, meta] of Object.entries(rawVersions)) {
    const deprecated = isObject(meta) && typeof meta.deprecated === 'string' ? meta.deprecated : null;
    versions[version] = { deprecated };
  }

  const time = {};
  const rawTime = isObject(body.time) ? body.time : {};
  for (const [version, ts] of Object.entries(rawTime)) {
    if (typeof ts === 'string') time[version] = ts;
  }

  return { name: typeof body.name === 'string' ? body.name : name, latest, versions, time };
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}
