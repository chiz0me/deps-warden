/** Alternate deterministic renderers for canonical organization reports. */

export function renderOrgSarif(report) {
  const checks = allChecks(report);
  const ids = [...new Set(checks.map(item => item.check.id))].toSorted();
  const rules = ids.map(id => ({ id, name: id, shortDescription: { text: id } }));
  const results = checks
    .filter(item => reportableSarifStatus(item.check))
    .map(item => sarifResult(item));
  return `${JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'deps-warden', informationUri: 'https://github.com/chiz0me/deps-warden', rules } },
      automationDetails: { id: `github-org/${report.organization}/` },
      properties: { reportSchema: report.schema, policy: report.policy, generatedAt: report.generatedAt },
      results,
    }],
  }, null, 2)}\n`;
}

export function renderOrgCsv(report) {
  const columns = ['organization', 'repository', 'status', 'evidence', 'mandatory_failures', 'mandatory_incomplete', 'accepted_risks', 'critical', 'high', 'medium', 'low', 'url'];
  const rows = [[
    report.organization,
    '@organization',
    report.organizationStatus,
    organizationEvidence(report.organizationChecks),
    count(report.organizationChecks, item => item.mandatory && item.status === 'fail'),
    count(report.organizationChecks, item => item.mandatory && ['unknown', 'skipped', 'unsupported'].includes(item.status)),
    count(report.organizationChecks, item => item.status === 'accepted'),
    ...severityCounts(report.organizationChecks),
    '',
  ]];
  for (const repository of report.repositories) {
    rows.push([
      report.organization,
      repository.name,
      repository.status,
      repository.evidence,
      count(repository.checks, item => item.mandatory && item.status === 'fail'),
      count(repository.checks, item => item.mandatory && ['unknown', 'skipped', 'unsupported'].includes(item.status)),
      count(repository.checks, item => item.status === 'accepted'),
      ...severityCounts(repository.checks),
      repository.url,
    ]);
  }
  return `${[columns, ...rows].map(row => row.map(csvCell).join(',')).join('\n')}\n`;
}

export function renderOrgHtml(report) {
  const repositoryRows = report.repositories.map(repository => `<tr><td>${escapeHtml(repository.name)}</td><td class="${statusClass(repository.status)}">${escapeHtml(repository.status)}</td><td>${escapeHtml(repository.evidence)}</td><td>${count(repository.checks, item => item.mandatory && item.status === 'fail')}</td><td>${count(repository.checks, item => item.mandatory && ['unknown', 'skipped', 'unsupported'].includes(item.status))}</td><td>${count(repository.checks, item => item.status === 'accepted')}</td><td><a href="${escapeHtml(safeHref(repository.url))}">repository</a></td></tr>`).join('');
  const attentionRows = allChecks(report)
    .filter(item => item.check.status !== 'pass' && item.check.status !== 'not_applicable')
    .map(({ scope, check }) => `<tr><td>${escapeHtml(scope)}</td><td>${escapeHtml(check.id)}</td><td class="${statusClass(check.status)}">${escapeHtml(check.status)}</td><td>${escapeHtml(check.severity)}</td><td>${escapeHtml(check.file)}</td><td>${escapeHtml(check.reason)}</td><td>${escapeHtml(check.remediation)}</td></tr>`)
    .join('');
  const diff = report.diff ? `<section><h2>Change since baseline</h2><p>${report.diff.summary.changedChecks} check changes; ${report.diff.summary.newFailures} new failures; ${report.diff.summary.resolvedFailures} resolved failures.</p></section>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>deps-warden — ${escapeHtml(report.organization)}</title>
<style>body{font:14px system-ui,sans-serif;margin:2rem;color:#17202a}h1,h2{margin:.4em 0}.cards{display:flex;gap:1rem;flex-wrap:wrap}.card{border:1px solid #ccd1d1;border-radius:8px;padding:1rem;min-width:9rem}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid #d5d8dc;padding:.5rem;text-align:left;vertical-align:top}th{background:#f4f6f7}.bad{color:#a00;font-weight:700}.warn{color:#8a5200;font-weight:700}.good{color:#087830;font-weight:700}code{overflow-wrap:anywhere}</style></head>
<body><h1>deps-warden organization report</h1><p>${escapeHtml(report.organization)} · ${escapeHtml(report.generatedAt)} · <span class="${statusClass(report.status)}">${escapeHtml(report.status)}</span> · ${escapeHtml(report.policy)}</p>
<div class="cards"><div class="card"><strong>${report.coverage.repositoriesTotal}</strong><br>repositories</div><div class="card"><strong>${report.summary.compliant}</strong><br>compliant</div><div class="card"><strong>${report.summary.noncompliant}</strong><br>noncompliant</div><div class="card"><strong>${report.summary.incomplete}</strong><br>incomplete</div><div class="card"><strong>${report.exceptions.accepted}</strong><br>accepted risks</div></div>
${diff}<section><h2>Repository summary</h2><table><thead><tr><th>Repository</th><th>Status</th><th>Evidence</th><th>Failures</th><th>Incomplete</th><th>Accepted</th><th>Link</th></tr></thead><tbody>${repositoryRows}</tbody></table></section>
<section><h2>Checks needing attention</h2><table><thead><tr><th>Scope</th><th>Check</th><th>Status</th><th>Severity</th><th>File</th><th>Reason</th><th>Remediation</th></tr></thead><tbody>${attentionRows}</tbody></table></section></body></html>\n`;
}

function allChecks(report) {
  return [
    ...report.organizationChecks.map(check => ({ scope: '@organization', repository: null, check })),
    ...report.repositories.flatMap(repository => repository.checks.map(check => ({ scope: repository.name, repository, check }))),
  ];
}

function reportableSarifStatus(check) {
  return check.status === 'fail' || check.status === 'accepted'
    || (check.mandatory && ['unknown', 'skipped', 'unsupported'].includes(check.status));
}

function sarifResult({ scope, repository, check }) {
  const result = {
    ruleId: check.id,
    level: sarifLevel(check),
    message: { text: [check.reason || check.status, check.remediation].filter(Boolean).join('. ') },
    properties: { scope, status: check.status, mandatory: check.mandatory, severity: check.severity, source: check.source },
  };
  if (repository || check.file) {
    result.locations = [{ physicalLocation: {
      artifactLocation: { uri: `${encodeURIComponent(scope)}/${check.file || '.'}` },
      region: check.line > 0 ? { startLine: check.line } : undefined,
    } }];
  }
  if (check.status === 'accepted') {
    result.suppressions = [{ kind: 'external', justification: check.evidence?.governedException?.approval ?? 'governed exception' }];
  }
  return result;
}

function sarifLevel(check) {
  if (['critical', 'high'].includes(check.severity)) return 'error';
  if (check.severity === 'medium' || ['unknown', 'skipped', 'unsupported'].includes(check.status)) return 'warning';
  return 'note';
}

function severityCounts(checks) {
  return ['critical', 'high', 'medium', 'low'].map(severity => count(checks, item => item.status === 'fail' && item.severity === severity));
}

function organizationEvidence(checks) {
  return checks.some(item => item.mandatory && ['unknown', 'skipped', 'unsupported'].includes(item.status)) ? 'partial' : 'complete';
}

function count(items, predicate) {
  return items.filter(predicate).length;
}

function csvCell(value) {
  let text = String(value ?? '');
  if (['=', '+', '-', '@'].includes(text.trimStart()[0])) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function safeHref(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '#';
  } catch { return '#'; }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function statusClass(status) {
  if (['OK', 'pass', 'accepted'].includes(status)) return 'good';
  if (['unknown', 'incomplete', 'skipped', 'unsupported'].includes(status)) return 'warn';
  return 'bad';
}
