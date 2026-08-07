/**
 * Inline ignore directives in config sources.
 *
 * Directives (accept either `deps-warden-` or `dw-` prefix):
 *
 *   # deps-warden-ignore-file                - silence the entire file
 *   # deps-warden-ignore-start               - start a block (until -end)
 *   # deps-warden-ignore-end                 - end the current block
 *   # deps-warden-ignore-next-line           - silence the next non-comment line
 *   # deps-warden-ignore                     - silence the same line (inline)
 *
 * Optional rule filter: append rule ids after a colon, e.g.
 *   # deps-warden-ignore: npm-save-exact,pnpm-allow-builds
 *
 * Without a filter the directive silences every rule.
 */

const PREFIX = '(?:deps-warden|dw)';
const TAIL = '(?::\\s*([\\w,\\s-]+))?\\s*$';
const RE_FILE = new RegExp(`#\\s*${PREFIX}-ignore-file${TAIL}`);
const RE_START = new RegExp(`#\\s*${PREFIX}-ignore-start${TAIL}`);
const RE_END = new RegExp(`#\\s*${PREFIX}-ignore-end\\s*$`);
const RE_NEXT = new RegExp(`#\\s*${PREFIX}-ignore-next-line${TAIL}`);
const RE_INLINE = new RegExp(`#\\s*${PREFIX}-ignore(?!-)${TAIL}`);

/**
 * @typedef {object} IgnoreScope
 * @property {boolean} wholeFile
 * @property {Set<string>|null} fileRules           - null means "all rules"
 * @property {Array<{start: number, end: number, rules: Set<string>|null}>} ranges
 * @property {Map<number, Set<string>|null>} lines  - line -> ignored rule set (or null = all)
 */

function parseRuleList(list) {
  if (!list) return null;
  const ids = list.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  if (ids.length === 0) return null;
  return new Set(ids);
}

/**
 * @param {string} source
 * @returns {IgnoreScope}
 */
export function parseIgnoreDirectives(source) {
  /** @type {IgnoreScope} */
  const scope = {
    wholeFile: false,
    fileRules: null,
    ranges: [],
    lines: new Map(),
  };
  const lines = source.split('\n');
  /** @type {{start: number, rules: Set<string>|null}|null} */
  let openBlock = null;

  lines.forEach((text, i) => {
    const lineNo = i + 1;
    const fileMatch = text.match(RE_FILE);
    if (fileMatch) {
      scope.wholeFile = true;
      scope.fileRules = parseRuleList(fileMatch[1]);
      return;
    }
    const startMatch = text.match(RE_START);
    if (startMatch) {
      openBlock = { start: lineNo, rules: parseRuleList(startMatch[1]) };
      return;
    }
    if (RE_END.test(text)) {
      if (openBlock) {
        scope.ranges.push({ start: openBlock.start, end: lineNo, rules: openBlock.rules });
        openBlock = null;
      }
      return;
    }
    const nextMatch = text.match(RE_NEXT);
    if (nextMatch) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j].trim();
        if (next === '' || next.startsWith('#')) continue;
        mergeLine(scope.lines, j + 1, parseRuleList(nextMatch[1]));
        break;
      }
      return;
    }
    const inlineMatch = text.match(RE_INLINE);
    if (inlineMatch) {
      mergeLine(scope.lines, lineNo, parseRuleList(inlineMatch[1]));
    }
  });

  if (openBlock) {
    scope.ranges.push({ start: openBlock.start, end: lines.length, rules: openBlock.rules });
  }
  return scope;
}

function mergeLine(map, line, rules) {
  const existing = map.get(line);
  if (existing === undefined) {
    map.set(line, rules);
    return;
  }
  if (existing === null || rules === null) {
    map.set(line, null);
    return;
  }
  for (const r of rules) existing.add(r);
}

/**
 * @param {IgnoreScope} scope
 * @param {number} line
 * @param {string} ruleId
 * @returns {boolean}
 */
export function isIgnored(scope, line, ruleId) {
  if (scope.wholeFile && matches(scope.fileRules, ruleId)) return true;
  for (const range of scope.ranges) {
    if (line >= range.start && line <= range.end && matches(range.rules, ruleId)) return true;
  }
  const lineRules = scope.lines.get(line);
  if (lineRules !== undefined && matches(lineRules, ruleId)) return true;
  return false;
}

function matches(rules, ruleId) {
  return rules === null ? true : rules.has(ruleId);
}
