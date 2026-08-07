import { describe, expect, it } from 'vitest';

import {
  createOrgReport,
  ORG_REPORT_SCHEMA,
  renderOrgReport,
} from '../src/lib/orgReport.js';
import { diffOrgReports } from '../src/lib/orgReportDiff.js';

function repository(name, checks) {
  return {
    name,
    url: `https://github.com/example/${name}`,
    defaultBranch: 'main',
    visibility: 'private',
    checks,
  };
}

describe('organization report', () => {
  it('derives fail-closed repository, coverage, and organization status', () => {
    const report = createOrgReport({
      organization: 'example',
      generatedAt: '2026-08-07T00:00:00Z',
      repositories: [
        repository('passing', [{ id: 'lockfile-present', status: 'pass', severity: 'critical' }]),
        repository('failing', [{ id: 'direct-deps-exact', status: 'fail', severity: 'high' }]),
        repository('unknown', [{ id: 'branch-protection', status: 'unknown', severity: 'high' }]),
        repository('unsupported', [{ id: 'ecosystem-supported', status: 'unsupported', severity: 'high' }]),
      ],
    });
    expect(report.schema).toBe(ORG_REPORT_SCHEMA);
    expect(report.status).toBe('FAIL');
    expect(report.coverage).toEqual({
      repositoriesTotal: 4,
      scanned: 2,
      incomplete: 1,
      unsupported: 1,
    });
    expect(report.summary).toMatchObject({ compliant: 1, noncompliant: 1, high: 1 });
  });

  it('does not let an unavailable mandatory check pass compliance', () => {
    const report = createOrgReport({
      organization: 'example',
      repositories: [repository('service', [
        { id: 'lockfile-present', status: 'pass', severity: 'critical' },
        { id: 'github-settings', status: 'skipped', reason: 'permission-denied' },
      ])],
    });
    expect(report.repositories[0]).toMatchObject({ status: 'incomplete', evidence: 'partial' });
    expect(report.status).toBe('FAIL');
  });

  it('fails closed on unavailable organization-level policy evidence', () => {
    const report = createOrgReport({
      organization: 'example',
      organizationChecks: [{ id: 'github-org/actions-policy', status: 'unknown', severity: 'high' }],
      repositories: [repository('service', [{ id: 'lockfile-present', status: 'pass', severity: 'critical' }])],
    });
    expect(report.organizationStatus).toBe('incomplete');
    expect(report.status).toBe('FAIL');
  });

  it('renders canonical JSON and compact TOON deterministically', () => {
    const report = createOrgReport({
      organization: 'example',
      generatedAt: '2026-08-07T00:00:00Z',
      repositories: [repository('service', [
        { id: 'lockfile-present', status: 'pass', severity: 'critical', source: 'repository' },
      ])],
    });
    expect(JSON.parse(renderOrgReport(report))).toEqual(report);
    const toon = renderOrgReport(report, { format: 'toon' });
    expect(toon).toMatch(/^ORG:.*schema=deps-warden-org-report\/v1/m);
    expect(toon).toMatch(/^REPO: name=service status=pass evidence=complete/m);
    expect(toon).toMatch(/^CHECK: repo=service id=lockfile-present/m);
    expect(toon).toMatch(/^STATUS: OK$/m);
  });

  it('rejects unknown statuses instead of silently treating them as passing', () => {
    expect(() => createOrgReport({
      organization: 'example',
      repositories: [repository('service', [{ id: 'x', status: 'maybe' }])],
    })).toThrow(/unknown status/);
  });

  it('accepts GitHub special repository names that begin with a dot', () => {
    const report = createOrgReport({
      organization: 'example',
      repositories: [repository('.github', [{ id: 'x', status: 'pass' }])],
    });
    expect(report.repositories[0].name).toBe('.github');
  });

  it('renders SARIF, CSV, and a self-contained escaped HTML dashboard', () => {
    const report = createOrgReport({
      organization: 'example',
      organizationChecks: [{ id: 'github-org/actions-policy', status: 'pass', severity: 'high' }],
      repositories: [repository('service', [{ id: 'deps/exact', status: 'fail', severity: 'high', file: '=manifest.csv', line: 2, reason: '<unsafe>' }])],
    });
    const sarif = JSON.parse(renderOrgReport(report, { format: 'sarif' }));
    expect(sarif).toMatchObject({ version: '2.1.0', runs: [{ results: [{ ruleId: 'deps/exact', level: 'error' }] }] });
    const csv = renderOrgReport(report, { format: 'csv' });
    expect(csv).toMatch(/^"organization","repository","status"/);
    expect(csv).toContain('"service","fail"');
    const html = renderOrgReport(report, { format: 'html' });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('&lt;unsafe&gt;');
    expect(html).not.toContain('<unsafe>');
  });

  it('reports new and resolved failures between canonical scans', () => {
    const previous = createOrgReport({
      organization: 'example',
      generatedAt: '2026-08-06T00:00:00Z',
      repositories: [repository('service', [{ id: 'a', status: 'fail' }, { id: 'b', status: 'pass' }])],
    });
    const current = createOrgReport({
      organization: 'example',
      generatedAt: '2026-08-07T00:00:00Z',
      repositories: [repository('service', [{ id: 'a', status: 'pass' }, { id: 'b', status: 'fail' }])],
    });
    const diff = diffOrgReports(previous, current);
    expect(diff.summary).toMatchObject({ changedChecks: 2, newFailures: 1, resolvedFailures: 1 });
  });
});
