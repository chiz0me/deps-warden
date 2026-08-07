/** GitHub Actions-specific audit presentation and workflow annotations. */

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

import { redact } from './redact.js';
import { SEVERITY_ORDER } from './formatter.js';

const SEVERITY_LABELS = {
  critical: '🔴 Critical',
  high: '🟠 High',
  medium: '🟡 Medium',
  low: '🔵 Low',
};

const ANNOTATION_LEVELS = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'notice',
};

/**
 * Render a bounded, human-readable Markdown job summary.
 *
 * @param {import('../commands/audit.js').AuditResult} result
 * @param {{cwd?: string, maxFindings?: number}} [opts]
 * @returns {string}
 */
export function renderGitHubSummary(result, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const maxFindings = boundedCount(opts.maxFindings ?? 50, 0, 200, 'maxFindings');
  const shown = prioritizedFindings(result.findings).slice(0, maxFindings);
  const omitted = result.findings.length - shown.length;
  const passed = result.status === 'OK';
  const coverageComplete = (result.incomplete?.length ?? 0) === 0;
  const policyPath = result.policy?.path ? displayPath(result.policy.path, cwd) : 'built-in defaults';
  const pm = [result.pm.kind, result.pm.version].filter(Boolean).join(' ');

  const lines = [
    '## 🛡️ deps-warden audit',
    '',
    `> ${passed ? '✅ **Passed**' : '❌ **Failed**'} — ${findingSentence(result)}${coverageComplete ? '' : coverageSentence(result)}`,
    '',
    '| Result | Package manager | Policy | Evidence | Gate threshold |',
    '|---|---|---|---|---|',
    `| ${passed ? '✅ Pass' : '❌ Fail'} | ${md(pm || 'unknown')} | ${md(policyPath)} | ${coverageComplete ? '✅ Complete' : '⚠️ Incomplete'} | ${md(result.levels?.fail ?? 'low')} |`,
    '',
    '| Critical | High | Medium | Low | Ignored |',
    '|---:|---:|---:|---:|---:|',
    `| ${result.summary.critical} | ${result.summary.high} | ${result.summary.medium} | ${result.summary.low} | ${result.summary.ignored ?? 0} |`,
  ];

  if (shown.length > 0) {
    lines.push(
      '',
      '### Findings',
      '',
      '| Gate | Severity | Check | Location | Recommended action |',
      '|:---:|---|---|---|---|',
    );
    for (const finding of shown) {
      lines.push(`| ${isGatingFinding(finding, result) ? '⛔' : '—'} | ${SEVERITY_LABELS[finding.severity] ?? md(finding.severity)} | \`${md(finding.ruleId)}\` | ${md(findingLocation(finding, cwd))} | ${md(findingAction(finding))} |`);
    }
    if (omitted > 0) {
      lines.push('', `_${omitted} additional finding${omitted === 1 ? '' : 's'} omitted from this summary; inspect the step log or machine-readable report._`);
    }
  } else {
    lines.push('', '### Findings', '', 'No findings were reported at the configured reporting threshold.');
  }

  if (!coverageComplete) {
    lines.push('', '### Evidence gaps', '');
    for (const gap of result.incomplete) {
      lines.push(`- \`${md(gap.rule)}\`: ${md(humanize(gap.reason))}${result.requireComplete ? ' — **required; blocks the gate**' : ''}`);
    }
  }

  if (result.findings.length > 0) {
    const firstFixable = result.findings.find(finding => finding.fixable);
    lines.push('', '### Next steps', '');
    if (firstFixable) {
      lines.push(`1. Generate a reviewable plan: \`deps-warden plan --finding=${md(firstFixable.id)} --output=deps-warden-plan.json\``);
      lines.push('2. Validate it: `deps-warden apply deps-warden-plan.json`');
      lines.push('3. After review, apply it with `--write`, then rerun the audit.');
    } else {
      lines.push('1. Review each recommended action above.');
      lines.push('2. Run `deps-warden audit --explain` locally for remediation guidance.');
      lines.push('3. Rerun the audit after the configuration changes.');
    }
  }

  lines.push(
    '',
    '<details>',
    '<summary>Audit configuration</summary>',
    '',
    `- Reporting threshold: \`${md(result.levels?.report ?? 'low')}\``,
    `- Failing threshold: \`${md(result.levels?.fail ?? 'low')}\``,
    `- Required complete evidence: \`${Boolean(result.requireComplete)}\``,
    `- Rules skipped as not applicable: \`${result.skipped?.length ?? 0}\``,
    `- Workspaces scanned: \`${result.workspaces?.length ?? 0}\``,
    '',
    '</details>',
    '',
  );
  return lines.join('\n');
}

/**
 * Render GitHub workflow commands for file-aware annotations.
 *
 * @param {import('../commands/audit.js').AuditResult} result
 * @param {{cwd?: string, repositoryRoot?: string, maxAnnotations?: number}} [opts]
 * @returns {string}
 */
export function renderGitHubAnnotations(result, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const repositoryRoot = opts.repositoryRoot ?? cwd;
  const maxAnnotations = boundedCount(opts.maxAnnotations ?? 20, 0, 50, 'maxAnnotations');
  const candidates = [];

  for (const gap of result.incomplete ?? []) {
    candidates.push({
      level: result.requireComplete ? 'error' : 'warning',
      title: `deps-warden: evidence unavailable (${gap.rule})`,
      message: `${humanize(gap.reason)}. ${result.requireComplete ? 'Complete evidence is required and blocks the gate.' : 'The audit continued without this evidence.'}`,
    });
  }

  for (const finding of prioritizedFindings(result.findings)) {
    const line = Number.isSafeInteger(finding.line) && finding.line > 0 ? finding.line : undefined;
    // GitHub defaults an omitted line to line 1 when a file is present. Avoid
    // inventing that precision for rules that only identify a file.
    const file = line ? annotationPath(finding.file, repositoryRoot) : undefined;
    candidates.push({
      level: ANNOTATION_LEVELS[finding.severity] ?? 'warning',
      title: `deps-warden: ${finding.ruleId} (${finding.severity})`,
      message: `${findingAction(finding)} Finding id: ${finding.id}.`,
      file,
      line: file ? line : undefined,
    });
  }

  const selected = candidates.slice(0, maxAnnotations);
  const lines = selected.map(annotation => workflowCommand(annotation));
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/** Safely append Markdown to GitHub's runner-provided step-summary file. */
export async function appendGitHubStepSummary(path, markdown) {
  if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path)) {
    throw new Error('GITHUB_STEP_SUMMARY must be an absolute path');
  }
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, 0o600);
  try {
    await handle.writeFile(String(markdown).endsWith('\n') ? String(markdown) : `${markdown}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

function prioritizedFindings(findings) {
  return findings
    .map((finding, index) => ({ finding, index }))
    .toSorted((left, right) => {
      const severity = SEVERITY_ORDER.indexOf(right.finding.severity)
        - SEVERITY_ORDER.indexOf(left.finding.severity);
      return severity || left.index - right.index;
    })
    .map(item => item.finding);
}

function findingSentence(result) {
  const count = result.summary.findings;
  if (count === 0) return 'No findings were reported.';
  return `${count} finding${count === 1 ? '' : 's'} reported (${result.summary.critical} critical, ${result.summary.high} high, ${result.summary.medium} medium, ${result.summary.low} low).`;
}

function coverageSentence(result) {
  const count = result.incomplete?.length ?? 0;
  return ` ${count} evidence gap${count === 1 ? '' : 's'} detected${result.requireComplete ? ' and required evidence is fail-closed.' : '.'}`;
}

function isGatingFinding(finding, result) {
  const severity = SEVERITY_ORDER.indexOf(finding.severity);
  const threshold = SEVERITY_ORDER.indexOf(result.levels?.fail ?? 'low');
  if (severity < threshold) return false;
  return !result.failOn || result.failOn.includes(finding.ruleId);
}

function findingLocation(finding, cwd) {
  const path = displayPath(finding.file, cwd);
  return finding.line > 0 ? `${path}:${finding.line}` : path;
}

function findingAction(finding) {
  if (finding.explain) return finding.explain;
  const message = typeof finding.fields?.msg === 'string' ? finding.fields.msg : '';
  if (message) return message;
  return `${humanize(finding.ruleId)} requires review${finding.fixable ? '; an automated remediation plan is available' : ''}.`;
}

function displayPath(path, cwd) {
  if (!path) return '.';
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  if (rel === '') return '.';
  return rel.startsWith('..') || isAbsolute(rel) ? '.' : rel;
}

function annotationPath(path, cwd) {
  const displayed = displayPath(path, cwd);
  return displayed === '.' ? undefined : displayed;
}

function workflowCommand({ level, title, message, file, line }) {
  const properties = [`title=${commandProperty(title)}`];
  if (file) properties.push(`file=${commandProperty(file)}`);
  if (line) properties.push(`line=${line}`);
  return `::${level} ${properties.join(',')}::${commandMessage(message)}`;
}

function commandProperty(value) {
  return truncate(redact(String(value)), 256)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

function commandMessage(value) {
  return truncate(redact(String(value)), 1024)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function md(value) {
  return truncate(redact(String(value)), 512)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '&#124;')
    .replace(/`/g, '&#96;')
    .replace(/[\r\n]+/g, ' ');
}

function truncate(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function humanize(value) {
  const words = String(value).replace(/[-_]+/g, ' ').trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : 'Review required';
}

function boundedCount(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}
