/**
 * Minimal `.npmrc` / `.yarnrc` (classic) parser with line tracking.
 *
 * Supported syntax:
 *   key = value
 *   key=value
 *   array[] = value          (repeatable; collects all occurrences)
 *   //host/:_authToken = …   (scoped keys)
 *   ; comment
 *   # comment
 *
 * Values are returned as raw strings (with surrounding quotes stripped).
 * `${VAR}` interpolation is left literal — callers decide whether to expand.
 */

/**
 * @typedef {object} ScalarEntry
 * @property {string} value
 * @property {number} line   1-based
 *
 * @typedef {object} ArrayEntry
 * @property {string[]} values
 * @property {number} firstLine
 * @property {number[]} lines
 *
 * @typedef {object} NpmrcAst
 * @property {Map<string, ScalarEntry>} scalars
 * @property {Map<string, ArrayEntry>} arrays
 * @property {Array<{line: number, message: string}>} errors
 * @property {string} source
 */

const LINE_RE = /^\s*([^#;=\s][^=]*?)\s*=\s*(.*?)\s*$/;

function stripQuotes(value) {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'")) {
    const q = value[0];
    if (value.endsWith(q)) return value.slice(1, -1);
  }
  return value;
}

/**
 * @param {string} source
 * @returns {NpmrcAst}
 */
export function parseNpmrc(source) {
  /** @type {NpmrcAst} */
  const ast = {
    scalars: new Map(),
    arrays: new Map(),
    errors: [],
    source,
  };
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const m = raw.match(LINE_RE);
    if (!m) {
      ast.errors.push({ line: i + 1, message: 'expected key=value syntax' });
      continue;
    }
    const key = m[1].trim();
    const value = stripQuotes(m[2]);
    const lineNo = i + 1;
    if (key.endsWith('[]')) {
      const baseKey = key.slice(0, -2).trim();
      const existing = ast.arrays.get(baseKey);
      if (existing) {
        existing.values.push(value);
        existing.lines.push(lineNo);
      } else {
        ast.arrays.set(baseKey, { values: [value], firstLine: lineNo, lines: [lineNo] });
      }
    } else {
      ast.scalars.set(key, { value, line: lineNo });
    }
  }
  return ast;
}

/**
 * Render a serialised value (preserving quoted form when needed).
 *
 * @param {unknown} value
 * @returns {string}
 */
function renderValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return String(value);
}

/**
 * Produce a new `.npmrc` source with `key=value` set.
 * Replaces an existing line; appends to end if not present.
 *
 * @param {string} source
 * @param {string} key
 * @param {unknown} value
 * @returns {string}
 */
export function setNpmrcKey(source, key, value) {
  const newLine = `${key}=${renderValue(value)}`;
  const ast = parseNpmrc(source);
  const existing = ast.scalars.get(key);
  const lines = source.split('\n');
  if (existing) {
    lines[existing.line - 1] = newLine;
    return lines.join('\n');
  }
  return appendLine(source, newLine);
}

/**
 * Replace an array's entries entirely with a new set of values, writing
 * `key[]=v` one per line. Removes any existing occurrences of `key[]=`.
 *
 * @param {string} source
 * @param {string} key
 * @param {string[]} values
 * @returns {string}
 */
export function setNpmrcArray(source, key, values) {
  const ast = parseNpmrc(source);
  const existing = ast.arrays.get(key);
  const lines = source.split('\n');
  const removedLines = new Set(existing ? existing.lines : []);
  const kept = [];
  let inserted = false;
  const newLines = values.map(v => `${key}[]=${renderValue(v)}`);
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    if (removedLines.has(lineNo)) {
      if (!inserted) {
        for (const ln of newLines) kept.push(ln);
        inserted = true;
      }
      continue;
    }
    kept.push(lines[i]);
  }
  if (!inserted && newLines.length > 0) {
    return appendLines(kept.join('\n'), newLines);
  }
  return kept.join('\n');
}

function appendLine(source, line) {
  if (source === '') return `${line}\n`;
  return source.endsWith('\n') ? `${source}${line}\n` : `${source}\n${line}\n`;
}

function appendLines(source, newLines) {
  let out = source;
  for (const ln of newLines) out = appendLine(out, ln);
  return out;
}
