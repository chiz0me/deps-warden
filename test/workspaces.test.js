import { describe, it, expect } from 'vitest';
import { mkdtemp, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { audit } from '../src/commands/audit.js';
import { fix } from '../src/commands/fix.js';
import { buildContext } from '../src/lib/context.js';

const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);

async function copyFixture(name) {
  const dst = await mkdtemp(join(tmpdir(), `dw-ws-${name}-`));
  await cp(FIX(name), dst, { recursive: true });
  return dst;
}

describe('workspace discovery', () => {
  it('discovers pnpm workspaces from pnpm-workspace.yaml packages:', async () => {
    const ctx = await buildContext({ cwd: FIX('pnpm-workspaces') });
    const rels = ctx.workspaces.map(w => w.relative).toSorted();
    expect(rels).toEqual(['.', 'packages/app-a', 'packages/app-b']);
  });

  it('returns just root for non-workspace projects', async () => {
    const ctx = await buildContext({ cwd: FIX('pnpm') });
    expect(ctx.workspaces.length).toBe(1);
    expect(ctx.workspaces[0].relative).toBe('.');
  });
});

describe('per-workspace rule expansion', () => {
  it('node-engines-pinned fires only for workspaces missing engines.node', async () => {
    const r = await audit({ cwd: FIX('pnpm-workspaces') });
    const engineHits = r.findings.filter(f => f.ruleId === 'node-engines-pinned');
    expect(engineHits.length).toBe(1);
    expect(engineHits[0].fields.workspace).toBe('packages/app-b');
  });

  it('node-engines-pinned fix targets the correct workspace package.json', async () => {
    const dir = await copyFixture('pnpm-workspaces');
    const a = await audit({ cwd: dir });
    const target = a.findings.find(f => f.ruleId === 'node-engines-pinned');
    const r = await fix({ cwd: dir, finding: target.id, dryRun: false });
    expect(r.status).toBe('OK');
    const written = await readFile(join(dir, 'packages/app-b/package.json'), 'utf8');
    expect(written).toMatch(/"engines"/);
    expect(written).toMatch(/"node"/);
  });

  it('audit emits WORKSPACE records for sub-workspaces', async () => {
    const r = await audit({ cwd: FIX('pnpm-workspaces') });
    expect(r.workspaces.toSorted()).toEqual(['.', 'packages/app-a', 'packages/app-b']);
  });
});
