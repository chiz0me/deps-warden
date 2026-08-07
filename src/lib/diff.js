/**
 * Minimal unified diff between two strings using line-level LCS.
 *
 * Suitable for config files (a few hundred lines). For larger inputs (>5000
 * lines) we degrade to a single replace-whole-file hunk.
 */

import { redact } from './redact.js';

const LARGE_FILE_LINES = 5000;

/**
 * @param {string} oldStr
 * @param {string} newStr
 * @param {string} path
 * @returns {string|null}   null if identical
 */
export function unifiedDiff(oldStr, newStr, path) {
  if (oldStr === newStr) return null;
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const header = `--- a/${path}\n+++ b/${path}\n`;
  if (oldLines.length > LARGE_FILE_LINES || newLines.length > LARGE_FILE_LINES) {
    return redact(`${header}@@ -1,${oldLines.length} +1,${newLines.length} @@\n`
         + oldLines.map(l => `-${l}`).join('\n') + '\n'
         + newLines.map(l => `+${l}`).join('\n') + '\n');
  }
  const ops = diffLines(oldLines, newLines);
  return redact(header + renderHunks(ops, 3));
}

/**
 * Compute LCS-based operations: array of { op: '=' | '-' | '+', line: string }.
 */
function diffLines(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 });
  for (let i = 0; i <= m; i += 1) dp[i] = new Uint32Array(n + 1);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { ops.push({ op: '=', line: a[i] }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: '-', line: a[i] }); i += 1; }
    else { ops.push({ op: '+', line: b[j] }); j += 1; }
  }
  while (i < m) { ops.push({ op: '-', line: a[i] }); i += 1; }
  while (j < n) { ops.push({ op: '+', line: b[j] }); j += 1; }
  return ops;
}

function renderHunks(ops, ctx) {
  const hunks = [];
  let i = 0;
  let oldLine = 1;
  let newLine = 1;
  while (i < ops.length) {
    // Skip leading equal runs.
    while (i < ops.length && ops[i].op === '=') {
      i += 1;
      oldLine += 1;
      newLine += 1;
    }
    if (i >= ops.length) break;
    // Found a change. Walk backward up to `ctx` for leading context.
    const hunkStart = Math.max(0, findHunkStart(ops, i, ctx));
    const hunk = collectHunk(ops, hunkStart, ctx);
    // Translate to oldLine/newLine at hunkStart.
    const offset = i - hunkStart;
    const hunkOldStart = oldLine - countOp(ops.slice(hunkStart, i), '=') - countOp(ops.slice(hunkStart, i), '-');
    const hunkNewStart = newLine - countOp(ops.slice(hunkStart, i), '=') - countOp(ops.slice(hunkStart, i), '+');
    void offset;
    hunks.push(renderHunk(hunk, Math.max(1, hunkOldStart), Math.max(1, hunkNewStart)));
    // Advance i past this hunk.
    const hunkLen = hunk.length;
    for (let k = i - 0; k < hunkStart + hunkLen; k += 1) {
      if (k < 0 || k >= ops.length) break;
      const o = ops[k];
      if (o.op === '=' || o.op === '-') oldLine += 1;
      if (o.op === '=' || o.op === '+') newLine += 1;
    }
    i = hunkStart + hunkLen;
  }
  return hunks.join('');
}

function findHunkStart(ops, changeIdx, ctx) {
  let start = changeIdx;
  let kept = 0;
  while (start > 0 && kept < ctx) {
    if (ops[start - 1].op === '=') { kept += 1; start -= 1; }
    else break;
  }
  return start;
}

function collectHunk(ops, start, ctx) {
  const result = [];
  let i = start;
  let trailing = 0;
  while (i < ops.length) {
    const o = ops[i];
    if (o.op === '=') {
      trailing += 1;
      result.push(o);
      if (trailing >= ctx && hasNoMoreChangesWithin(ops, i + 1, ctx)) {
        // Trim trailing extras
        while (result.length > 0 && result[result.length - 1].op === '=' && trailingEquals(result) > ctx) {
          result.pop();
        }
        return result;
      }
    } else {
      trailing = 0;
      result.push(o);
    }
    i += 1;
  }
  return result;
}

function trailingEquals(result) {
  let count = 0;
  for (let i = result.length - 1; i >= 0; i -= 1) {
    if (result[i].op === '=') count += 1;
    else break;
  }
  return count;
}

function hasNoMoreChangesWithin(ops, from, ctx) {
  for (let i = from; i < Math.min(ops.length, from + ctx); i += 1) {
    if (ops[i].op !== '=') return false;
  }
  return true;
}

function countOp(slice, op) {
  let n = 0;
  for (const o of slice) if (o.op === op) n += 1;
  return n;
}

function renderHunk(hunk, oldStart, newStart) {
  const oldLen = hunk.filter(o => o.op === '=' || o.op === '-').length;
  const newLen = hunk.filter(o => o.op === '=' || o.op === '+').length;
  const head = `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@\n`;
  const body = hunk.map(o => {
    if (o.op === '=') return ` ${o.line}`;
    if (o.op === '-') return `-${o.line}`;
    return `+${o.line}`;
  }).join('\n') + '\n';
  return head + body;
}
