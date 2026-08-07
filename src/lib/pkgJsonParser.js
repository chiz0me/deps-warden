/**
 * `package.json` parser with targeted, minimal-diff writes.
 *
 * For reads: `JSON.parse` plus a regex-based line map for top-level keys.
 * For writes: balanced-brace walk to locate the `"key": value` span and
 * splice in the new serialised value while preserving surrounding whitespace
 * and trailing comma. New top-level keys are appended before the closing `}`
 * with an indent inferred from the file.
 */

/**
 * @typedef {object} PkgAst
 * @property {object} raw                          parsed object
 * @property {string} source                       original text
 * @property {Map<string, number>} topLevelLines   key -> 1-based line of the key
 * @property {string} indent                       inferred indent (default 2 spaces)
 */

/**
 * @param {string} source
 * @returns {PkgAst}
 */
export function parsePkgJson(source) {
  const raw = JSON.parse(source);
  const topLevelLines = new Map();
  const lines = source.split('\n');
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    if (depth === 1) {
      const m = text.match(/^\s*"([^"]+)"\s*:/);
      if (m) topLevelLines.set(m[1], i + 1);
    }
    for (const ch of text) {
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') depth -= 1;
    }
  }
  const indent = inferIndent(source);
  return { raw, source, topLevelLines, indent };
}

function inferIndent(source) {
  const m = source.match(/\n( +)"/);
  return m ? m[1] : '  ';
}

/**
 * Produce a new package.json source with a top-level key set to `value`.
 * If the key exists, replaces only that span; otherwise appends before `}`.
 *
 * @param {string} source
 * @param {string} key
 * @param {unknown} value
 * @returns {string}
 */
export function setTopLevelKey(source, key, value) {
  const ast = parsePkgJson(source);
  const serialised = JSON.stringify(value, null, ast.indent);
  // Re-indent multi-line serialised value so it sits at level 1.
  const reIndented = reindent(serialised, ast.indent);
  if (ast.topLevelLines.has(key)) {
    return spliceExistingKey(source, key, reIndented);
  }
  return appendTopLevelKey(source, key, reIndented, ast.indent);
}

/**
 * Set a nested path (e.g. ['engines', 'node']) to value. For simplicity we
 * round-trip via JSON for nested writes — exact-formatting preservation only
 * applies to top-level keys.
 *
 * @param {string} source
 * @param {string[]} path
 * @param {unknown} value
 * @returns {string}
 */
export function setNestedKey(source, path, value) {
  if (path.length === 0) throw new Error('path must be non-empty');
  if (path.length === 1) return setTopLevelKey(source, path[0], value);
  const ast = parsePkgJson(source);
  const next = { ...ast.raw };
  setIn(next, path, value);
  const serialised = `${JSON.stringify(next, null, ast.indent)}\n`;
  return serialised;
}

function setIn(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const k = path[i];
    if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[path[path.length - 1]] = value;
}

function reindent(serialised, indent) {
  const lines = serialised.split('\n');
  if (lines.length === 1) return serialised;
  return lines.map((line, i) => (i === 0 ? line : `${indent}${line}`)).join('\n');
}

function spliceExistingKey(source, key, replacement) {
  const span = findKeySpan(source, key);
  if (!span) return source;
  return source.slice(0, span.valueStart) + replacement + source.slice(span.valueEnd);
}

function findKeySpan(source, key) {
  let depth = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') {
      const end = findStringEnd(source, i);
      if (depth === 1) {
        const candidate = source.slice(i + 1, end);
        if (candidate === key) {
          let p = end + 1;
          while (p < source.length && /\s/.test(source[p])) p += 1;
          if (source[p] === ':') {
            p += 1;
            while (p < source.length && /\s/.test(source[p])) p += 1;
            const valueStart = p;
            const valueEnd = scanValueEnd(source, valueStart);
            return { valueStart, valueEnd };
          }
        }
      }
      i = end + 1;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    i += 1;
  }
  return null;
}

function findStringEnd(source, start) {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === '"') return i;
    i += 1;
  }
  return source.length;
}

function scanValueEnd(source, start) {
  let i = start;
  let depth = 0;
  let inString = false;
  let escape = false;
  while (i < source.length) {
    const ch = source[i];
    if (escape) { escape = false; i += 1; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      i += 1; continue;
    }
    if (ch === '"') { inString = true; i += 1; continue; }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      if (depth === 0) return i;
      depth -= 1;
    } else if (ch === ',' && depth === 0) return i;
    i += 1;
  }
  return i;
}

function appendTopLevelKey(source, key, replacement, indent) {
  const lastBrace = source.lastIndexOf('}');
  if (lastBrace === -1) return source;
  let i = lastBrace - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  if (i < 0) return source;
  const ch = source[i];
  const insertion = ch === '{'
    ? `\n${indent}"${key}": ${replacement}\n`
    : `,\n${indent}"${key}": ${replacement}\n`;
  return source.slice(0, i + 1) + insertion + source.slice(lastBrace);
}
