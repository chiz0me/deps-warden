import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { audit } from '../src/commands/audit.js';

const runCli = promisify(execFile);
const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.js');
const FIX = (name) => resolve(import.meta.dirname, 'fixtures', name);

async function run(args, { allowError = false } = {}) {
  try {
    const r = await runCli(process.execPath, [CLI, ...args]);
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    if (!allowError) throw err;
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('cli', () => {
  it('--help exits 0 with usage', async () => {
    const r = await run(['--help']);
    expect(r.stdout).toMatch(/Audit supply-chain misconfigurations/);
  });

  it('audit clean pnpm fixture returns exit 0 and STATUS: OK', async () => {
    const r = await run(['audit', '--cwd', FIX('pnpm')]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/STATUS: OK/);
  });

  it('audit pnpm-bad fixture returns exit 1 and STATUS: FAIL', async () => {
    const r = await run(['audit', '--cwd', FIX('pnpm-bad')], { allowError: true });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/STATUS: FAIL/);
    expect(r.stdout).toMatch(/FINDING:/);
  });

  it('rules subcommand lists RULE: records', async () => {
    const r = await run(['rules']);
    expect(r.stdout).toMatch(/RULE: id=lockfile-present/);
  });

  it('fix without --finding is a usage error (exit 2)', async () => {
    const r = await run(['fix', '--cwd', FIX('pnpm-bad')], { allowError: true });
    expect(r.code).toBe(2);
  });

  it('report subcommand emits PM + DEP records and STATUS', async () => {
    const r = await run(['report', '--cwd', FIX('pnpm')]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^PM:/m);
    expect(r.stdout).toMatch(/^STATUS: OK/m);
  });

  it('report exposes the same rule and threshold gate options as audit', async () => {
    const r = await run(['report', '--help']);
    expect(r.stdout).toMatch(/--report-level/);
    expect(r.stdout).toMatch(/--fail-level/);
    expect(r.stdout).toMatch(/--fail-on/);
    expect(r.stdout).toMatch(/--rule/);
  });

  it('infers file output when --output-path is provided', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dw-cli-output-'));
    try {
      await cp(FIX('pnpm'), dir, { recursive: true });
      const result = await run(['audit', '--cwd', dir, '--output-path', 'audit.json', '--format', 'json']);
      expect(result.stdout).toBe('');
      expect(JSON.parse(await readFile(join(dir, 'audit.json'), 'utf8')).status).toBe('OK');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects the removed --dry-run false mutation bypass', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dw-cli-write-'));
    await cp(FIX('pnpm-bad'), dir, { recursive: true });
    const config = join(dir, 'pnpm-workspace.yaml');
    const before = await readFile(config, 'utf8').catch(() => null);

    const r = await run([
      'init', '--cwd', dir, '--profile', 'strict', '--dry-run', 'false',
    ], { allowError: true });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/unknown option.*dry-run/i);
    await expect(readFile(config, 'utf8').catch(() => null)).resolves.toBe(before);
  });

  it('creates and applies a guarded remediation plan', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dw-cli-plan-'));
    await cp(FIX('pnpm-bad'), dir, { recursive: true });
    const scan = await audit({ cwd: dir });
    const finding = scan.findings.find(item => item.ruleId === 'pnpm-strict-dep-builds');
    const planPath = join(dir, 'plan.json');

    const planned = await run(['plan', '--cwd', dir, '--finding', finding.id, '--output', 'plan.json']);
    expect(planned.code).toBe(0);
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    expect(plan.kind).toBe('deps-warden-remediation-plan');

    const preview = await run(['apply', 'plan.json', '--cwd', dir]);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toMatch(/dryRun=true/);

    const applied = await run(['apply', 'plan.json', '--cwd', dir, '--write']);
    expect(applied.code).toBe(0);
    expect(applied.stdout).toMatch(/written=true/);
  });

  it('initializes and validates a versioned policy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dw-cli-policy-'));
    const initialized = await run(['policy', 'init', '--cwd', dir, '--write']);
    expect(initialized.code).toBe(0);
    const validated = await run(['policy', 'validate', '--cwd', dir]);
    expect(validated.code).toBe(0);
    expect(validated.stdout).toMatch(/POLICY: version=1/);
  });
});
