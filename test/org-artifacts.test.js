import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeOrgArtifactBundle } from '../src/lib/orgArtifacts.js';
import { createOrgReport } from '../src/lib/orgReport.js';

describe('organization artifact bundle', () => {
  let cwd;
  beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'deps-artifacts-')); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it('writes all report representations and a digest manifest in one scan output directory', async () => {
    const report = createOrgReport({
      organization: 'example',
      repositories: [{ name: 'service', checks: [{ id: 'x', status: 'pass' }] }],
    });
    const result = await writeOrgArtifactBundle(report, { cwd, directory: 'artifacts' });
    expect(result.manifest.files.map(item => item.name)).toEqual(['report.json', 'report.sarif', 'dashboard.html', 'summary.csv']);
    expect(JSON.parse(await readFile(join(cwd, 'artifacts/report.json'), 'utf8'))).toEqual(report);
    const manifest = JSON.parse(await readFile(join(cwd, 'artifacts/manifest.json'), 'utf8'));
    expect(manifest.status).toBe('OK');
    expect(manifest.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
