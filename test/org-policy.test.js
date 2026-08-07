import { describe, expect, it } from 'vitest';

import { applyOrgPolicy, parseGovernedExceptions } from '../src/lib/orgPolicy.js';
import { createOrgReport } from '../src/lib/orgReport.js';

const repositories = [{
  name: 'service',
  checks: [
    { id: 'deps/direct-deps-exact', status: 'fail', severity: 'high', mandatory: true, evidence: { count: 1 } },
    { id: 'github/advanced-security', status: 'fail', severity: 'high', mandatory: false },
  ],
}];

describe('organization scan policy', () => {
  it('requires owner, reason, approval, and expiry for governed exceptions', () => {
    expect(() => parseGovernedExceptions(`version: 1\nexceptions:\n  - repository: service\n    check: deps/direct-deps-exact\n`)).toThrow(/owner/);
    expect(() => parseGovernedExceptions(`version: 1\nexceptions:\n  - repository: service\n    check: deps/direct-deps-exact\n    owner: security\n    reason: migration\n    approval: SEC-1\n    expiresAt: 2026-09-01\n`)).toThrow(/RFC 3339/);
  });

  it('accepts only an active, exact-scope exception and retains its audit metadata', () => {
    const exceptions = parseGovernedExceptions(`version: 1\nexceptions:\n  - repository: service\n    check: deps/direct-deps-exact\n    owner: security-team\n    reason: migration window\n    approval: SEC-123\n    expiresAt: 2026-09-01T00:00:00Z\n`);
    const governed = applyOrgPolicy({
      organizationChecks: [],
      repositories,
      exceptions,
      now: new Date('2026-08-07T00:00:00Z'),
    });
    const check = governed.repositories[0].checks[0];
    expect(check).toMatchObject({ status: 'accepted', mandatory: true, reason: 'governed-exception' });
    expect(check.evidence.governedException).toMatchObject({ owner: 'security-team', approval: 'SEC-123', status: 'accepted' });
    expect(governed.exceptions).toMatchObject({ accepted: 1, expired: 0 });
    const report = createOrgReport({ organization: 'example', repositories: governed.repositories, exceptions: governed.exceptions });
    expect(report.repositories[0].status).toBe('pass');
  });

  it('does not waive expired exceptions or unavailable evidence', () => {
    const exceptions = [{
      repository: 'service', check: 'deps/direct-deps-exact', owner: 'security-team', reason: 'migration', approval: 'SEC-123', expiresAt: '2026-08-01T00:00:00.000Z',
    }];
    const governed = applyOrgPolicy({ organizationChecks: [], repositories, exceptions, now: new Date('2026-08-07T00:00:00Z') });
    expect(governed.repositories[0].checks[0].status).toBe('fail');
    expect(governed.exceptions.expired).toBe(1);
  });

  it('makes selected additional evidence mandatory in the strict profile', () => {
    const governed = applyOrgPolicy({ organizationChecks: [], repositories, profile: 'strict' });
    expect(governed.repositories[0].checks.find(item => item.id === 'github/advanced-security').mandatory).toBe(true);
  });

  it('rejects unknown repositories and check identifiers', () => {
    const exceptions = [{
      repository: 'typo', check: 'deps/direct-deps-exact', owner: 'security-team', reason: 'migration', approval: 'SEC-123', expiresAt: '2026-09-01T00:00:00.000Z',
    }];
    expect(() => applyOrgPolicy({ organizationChecks: [], repositories, exceptions })).toThrow(/unmatched/);
  });
});
