import { describe, expect, it } from 'vitest';

import { createOrgReport } from '../src/lib/orgReport.js';
import { githubScanCheckCatalog, pageMcpReport, summarizeMcpReport } from '../src/mcpServer.js';

const report = createOrgReport({
  organization: 'example',
  generatedAt: '2026-08-07T00:00:00Z',
  policy: 'deps-warden-github-scan/v1',
  scope: { discovered: 2, selected: 2, expected: 2, inventoryStatus: 'pass' },
  repositories: [
    { name: 'passing', checks: [{ id: 'x', status: 'pass', severity: 'high' }] },
    { name: 'failing', checks: [{ id: 'x', status: 'fail', severity: 'high', remediation: 'fix it' }] },
  ],
});

describe('MCP organization report helpers', () => {
  it('returns a compact scan summary without embedding every repository check', () => {
    const summary = summarizeMcpReport(report);
    expect(summary).toMatchObject({ organization: 'example', status: 'FAIL' });
    expect(summary.repositoriesNeedingAttention).toEqual([{
      name: 'failing', status: 'fail', evidence: 'complete', failed: 1, unknown: 0,
    }]);
    expect(summary.repositories).toBeUndefined();
  });

  it('pages and filters the canonical report', () => {
    expect(pageMcpReport(report, { status: 'fail', limit: 1 })).toMatchObject({
      total: 1,
      hasMore: false,
      repositories: [{ name: 'failing', status: 'fail' }],
    });
  });

  it('publishes the mandatory check catalog used by assistants', () => {
    const catalog = githubScanCheckCatalog();
    expect(catalog.find(check => check.id === 'deps/direct-deps-exact')).toMatchObject({ mandatory: true });
    expect(catalog.find(check => check.id === 'github-actions/script-injection')).toMatchObject({ mandatory: true });
    expect(catalog.find(check => check.id === 'github/dependabot-security-updates')).toMatchObject({ mandatory: true });
    expect(catalog.find(check => check.id === 'github-org/actions-sha-pinning-required')).toMatchObject({ mandatory: true, severity: 'critical' });
    expect(githubScanCheckCatalog('strict').find(check => check.id === 'github/advanced-security')).toMatchObject({ mandatory: true });
  });
});
