/** Stage a complete report bundle for GitHub Actions artifact upload. */

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { renderOrgReport } from './orgReport.js';
import { assertSafePath, writeFileGuarded } from './writer.js';

export const ORG_ARTIFACT_MANIFEST_SCHEMA = 'deps-warden-org-artifacts/v1';

export async function writeOrgArtifactBundle(report, { cwd = process.cwd(), directory } = {}) {
  if (typeof directory !== 'string' || directory.trim() === '') throw new Error('artifact directory is required');
  const absoluteDirectory = assertSafePath(directory, cwd);
  await mkdir(absoluteDirectory, { recursive: true, mode: 0o700 });
  const formats = [
    ['report.json', 'json'],
    ['report.sarif', 'sarif'],
    ['dashboard.html', 'html'],
    ['summary.csv', 'csv'],
  ];
  const files = [];
  for (const [name, format] of formats) {
    const content = renderOrgReport(report, { format });
    const result = await writeFileGuarded({ cwd, path: join(absoluteDirectory, name), content, dryRun: false });
    files.push({ name, bytes: result.bytes, sha256: createHash('sha256').update(content).digest('hex') });
  }
  const manifest = {
    schema: ORG_ARTIFACT_MANIFEST_SCHEMA,
    organization: report.organization,
    generatedAt: report.generatedAt,
    reportSchema: report.schema,
    status: report.status,
    files,
  };
  await writeFileGuarded({ cwd, path: join(absoluteDirectory, 'manifest.json'), content: `${JSON.stringify(manifest, null, 2)}\n`, dryRun: false });
  return { directory: relative(resolve(cwd), absoluteDirectory) || '.', manifest };
}
