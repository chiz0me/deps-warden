/**
 * Thin wrapper around the `yaml` library that exposes line-aware lookups and
 * targeted edits for `pnpm-workspace.yaml` and `.yarnrc.yml`.
 *
 * We rely on the `Document` node `range` API for accurate line numbers and
 * on `toString()` to re-render preserving comments/formatting.
 */

import YAML from 'yaml';

/**
 * @typedef {object} YamlValueLookup
 * @property {unknown} value         parsed JS value (string|number|bool|array|object|null)
 * @property {number} line           1-based line of the key
 */

/**
 * Parse a YAML source. Throws on parse error.
 *
 * @param {string} source
 * @returns {YAML.Document}
 */
export function parseYaml(source) {
  return YAML.parseDocument(source, { keepSourceTokens: true });
}

/**
 * Look up a value at the given path. Returns null when absent.
 *
 * @param {YAML.Document} doc
 * @param {string[]} path
 * @returns {YamlValueLookup|null}
 */
export function getYamlValue(doc, path) {
  if (!doc.contents) return null;
  const node = doc.getIn(path, true);
  if (node === undefined || node === null) return null;

  // Find the key node range to derive a line number.
  const pair = findPair(doc, path);
  const line = pair ? offsetToLine(doc, getKeyOffset(pair)) : 1;

  let value;
  if (node && typeof node === 'object' && 'toJSON' in node && typeof node.toJSON === 'function') {
    value = node.toJSON();
  } else {
    value = node;
  }
  return { value, line };
}

/**
 * Produce a new YAML source with the value at `path` set to `value`.
 * Creates intermediate maps as needed.
 *
 * @param {string} source
 * @param {string[]} path
 * @param {unknown} value
 * @returns {string}
 */
export function setYamlKey(source, path, value) {
  if (source.trim() === '') {
    const seed = blockYamlFor(path, value);
    const doc = parseYaml(seed);
    let out = doc.toString();
    if (!out.endsWith('\n')) out += '\n';
    return out;
  }
  const doc = parseYaml(source);
  doc.setIn(path, value);
  let out = doc.toString();
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

function blockYamlFor(path, value) {
  if (path.length === 1) {
    if (Array.isArray(value)) {
      if (value.length === 0) return `${path[0]}: []\n`;
      return `${path[0]}:\n${value.map(v => `  - ${JSON.stringify(v)}`).join('\n')}\n`;
    }
    if (typeof value === 'string') return `${path[0]}: ${JSON.stringify(value)}\n`;
    if (typeof value === 'boolean' || typeof value === 'number') return `${path[0]}: ${value}\n`;
    return `${path[0]}: ${JSON.stringify(value)}\n`;
  }
  return `${path[0]}:\n${blockYamlFor(path.slice(1), value).replace(/^/gm, '  ')}`;
}

function findPair(doc, path) {
  if (path.length === 0) return null;
  let node = doc.contents;
  for (let i = 0; i < path.length; i += 1) {
    if (!node || !node.items) return null;
    const key = path[i];
    const pair = node.items.find(p => p.key && (p.key.value === key || p.key === key));
    if (!pair) return null;
    if (i === path.length - 1) return pair;
    node = pair.value;
  }
  return null;
}

function getKeyOffset(pair) {
  const key = pair.key;
  if (!key) return 0;
  if (Array.isArray(key.range)) return key.range[0];
  if (typeof key.offset === 'number') return key.offset;
  return 0;
}

function offsetToLine(doc, offset) {
  // `doc.lineCounter` is not exposed unless we use parseAllDocuments with lineCounter.
  // Reconstruct from the source by counting newlines up to offset.
  const src = doc.toString();
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i += 1) {
    if (src[i] === '\n') line += 1;
  }
  return line;
}
