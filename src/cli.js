#!/usr/bin/env node
/**
 * deps-warden CLI entry point.
 *
 * Commands: audit, plan, apply, policy, fix, rules, init, scripts, report, github-scan
 *
 * Global flags: --format, --output, --output-path, --cwd, --pm
 * `audit`/`report` accept --check-versions, the only flag that reaches the
 * network (npm registry). `github-scan` is an explicitly networked read-only
 * GitHub transport. Mutating commands require --write; omitting it
 * always performs a dry-run.
 *
 * Exit codes:
 *   0  OK
 *   1  findings reported (audit FAIL) or errors during fix
 *   2  invalid arguments
 */

import { Command, Option } from 'commander';
import { writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { audit, renderAudit } from './commands/audit.js';
import { fix, renderFix } from './commands/fix.js';
import { rules, renderRules } from './commands/rules.js';
import { init, renderInit } from './commands/init.js';
import { scripts, renderScripts } from './commands/scripts.js';
import { report, renderReport } from './commands/report.js';
import { scanGitHubOrganization, renderOrgReport } from './commands/orgScan.js';
import { createPlan, applyPlan, renderApply, renderPlan } from './commands/plan.js';
import { initPolicy, renderPolicy, showPolicy, validatePolicyFile } from './commands/policy.js';
import { writeFileGuarded } from './lib/writer.js';
import { createGitHubAppTokenProvider } from './lib/githubAppAuth.js';
import { loadGovernedExceptions, ORG_POLICY_PROFILES } from './lib/orgPolicy.js';
import { diffOrgReports } from './lib/orgReportDiff.js';
import { writeOrgArtifactBundle } from './lib/orgArtifacts.js';
import {
  appendGitHubStepSummary,
  renderGitHubAnnotations,
  renderGitHubSummary,
} from './lib/githubActions.js';

const PM_KINDS = ['npm', 'pnpm'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

const program = new Command();
program
  .name('deps-warden')
  .description('Audit supply-chain misconfigurations in npm and pnpm projects.')
  .version('0.1.0')
  .configureOutput({
    writeOut: payload => writeFd(process.stdout.fd, payload),
    writeErr: payload => writeFd(process.stderr.fd, payload),
  })
  .exitOverride();

const formatOption = new Option('--format <fmt>', 'output format').choices(['toon', 'json', 'text']).default('toon');
const outputOption = new Option('--output <dest>', 'output destination').choices(['stdout', 'file']).default('stdout');
const pmOption = new Option('--pm <kind>', 'override package manager detection').choices(PM_KINDS);

function addCommonOptions(cmd) {
  return cmd
    .option('--cwd <dir>', 'working directory', process.cwd())
    .addOption(pmOption)
    .addOption(formatOption)
    .addOption(outputOption)
    .option('--output-path <path>', 'write output to this path (implies --output=file)');
}

program.command('github-scan')
  .alias('org-scan')
  .description('Audit supply-chain controls across every selected repository in a GitHub organization')
  .argument('<organization>', 'GitHub organization login')
  .option('--cwd <dir>', 'working directory for cache and output paths', process.cwd())
  .option('--token <token>', 'GitHub token (prefer GITHUB_TOKEN or GH_TOKEN)')
  .option('--github-app-id <id>', 'GitHub App id (or GITHUB_APP_ID)')
  .option('--github-app-installation-id <id>', 'GitHub App installation id (or GITHUB_APP_INSTALLATION_ID)')
  .option('--github-app-private-key-path <path>', 'GitHub App PEM private-key path (or GITHUB_APP_PRIVATE_KEY_PATH)')
  .option('--api-url <url>', 'GitHub REST API base URL', 'https://api.github.com')
  .option('--api-version <date>', 'GitHub REST API version header', '2026-03-10')
  .addOption(new Option('--format <fmt>', 'output format').choices(['toon', 'json', 'text', 'sarif', 'html', 'csv']).default('json'))
  .addOption(new Option('--output <dest>', 'output destination').choices(['stdout', 'file']).default('stdout'))
  .option('--output-path <path>', 'write output to this path (implies --output=file)')
  .option('--concurrency <n>', 'repositories scanned concurrently', parseInteger, 4)
  .option('--max-repos <n>', 'fail before scanning when the selected scope exceeds this limit', parseInteger, 100000)
  .option('--expected-repos <n>', 'assert the total repository inventory when GitHub cannot expose private counts', parseInteger)
  .option('--repo <name...>', 'scan only these repository names')
  .option('--exclude-archived', 'exclude archived repositories', false)
  .option('--exclude-forks', 'exclude fork repositories', false)
  .option('--cache-dir <path>', 'derived-result cache directory', '.deps-warden-cache/github-org')
  .option('--no-cache', 'disable the Git-tree-SHA result cache')
  .option('--refresh-cache', 'ignore cached code checks and replace them')
  .option('--no-resume', 'disable durable checkpoints for interrupted scans')
  .option('--checkpoint-dir <path>', 'interrupted-scan checkpoint directory', '.deps-warden-cache/github-org/checkpoints')
  .option('--checkpoint-ttl-hours <n>', 'maximum checkpoint age before repositories are rescanned', parseInteger, 6)
  .option('--wait-for-rate-limit', 'wait for GitHub rate-limit reset and resume', false)
  .option('--rate-limit-reserve <n>', 'stop with incomplete results before remaining requests fall below this reserve', parseInteger, 50)
  .option('--request-interval-ms <n>', 'minimum delay between GitHub request starts', parseInteger, 100)
  .option('--max-evidence-files <n>', 'maximum relevant files downloaded per repository', parseInteger, 1000)
  .option('--max-evidence-mib <n>', 'maximum total relevant content per repository', parseInteger, 25)
  .option('--max-file-mib <n>', 'maximum size of one relevant file', parseInteger, 2)
  .option('--max-tree-requests <n>', 'maximum targeted tree requests after GitHub truncates a recursive tree', parseInteger, 1000)
  .option('--max-tree-entries <n>', 'maximum entries visited by truncated-tree fallback', parseInteger, 250000)
  .addOption(new Option('--profile <name>', 'organization scan policy profile').choices(ORG_POLICY_PROFILES).default('baseline'))
  .option('--exceptions <path>', 'externally governed accepted-risk file')
  .option('--baseline-report <path>', 'previous canonical JSON report to compare against')
  .option('--artifacts-dir <path>', 'stage JSON, SARIF, HTML, CSV, and a digest manifest for GitHub Actions upload')
  .option('--progress', 'write repository progress to stderr without contaminating the report', false)
  .action(async (organization, opts) => {
    const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const tokenProvider = token ? undefined : await githubAppTokenProvider(opts);
    const exceptions = await loadGovernedExceptions({ cwd: opts.cwd, path: opts.exceptions });
    if (!token && !tokenProvider) {
      throw new Error('GitHub authentication required: set GITHUB_TOKEN/GH_TOKEN, or configure GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and a private key');
    }
    const result = await scanGitHubOrganization({
      organization,
      token,
      tokenProvider,
      profile: opts.profile,
      exceptions,
      cwd: opts.cwd,
      apiUrl: opts.apiUrl,
      apiVersion: opts.apiVersion,
      concurrency: opts.concurrency,
      maxRepositories: opts.maxRepos,
      expectedRepositories: opts.expectedRepos,
      repositories: opts.repo,
      includeArchived: !opts.excludeArchived,
      includeForks: !opts.excludeForks,
      cache: opts.cache,
      refresh: opts.refreshCache,
      cacheDirectory: opts.cacheDir,
      resume: opts.resume,
      checkpointDirectory: opts.checkpointDir,
      checkpointTtlMs: opts.checkpointTtlHours * 60 * 60 * 1000,
      waitForRateLimit: opts.waitForRateLimit,
      rateLimitReserve: opts.rateLimitReserve,
      minIntervalMs: opts.requestIntervalMs,
      maxEvidenceFiles: opts.maxEvidenceFiles,
      maxEvidenceBytes: opts.maxEvidenceMib * 1024 * 1024,
      maxFileBytes: opts.maxFileMib * 1024 * 1024,
      maxTreeRequests: opts.maxTreeRequests,
      maxTreeEntries: opts.maxTreeEntries,
      onProgress: opts.progress ? event => writeFd(process.stderr.fd,
        `scan ${event.completed}/${event.total} ${event.repository} ${event.type === 'repository-start' ? 'started' : 'complete'}\n`) : undefined,
    });
    if (opts.baselineReport) {
      const baselinePath = resolve(opts.cwd, opts.baselineReport);
      let previous;
      try { previous = JSON.parse(await readFile(baselinePath, 'utf8')); }
      catch (error) { throw new Error(`cannot read baseline report ${baselinePath}: ${error.message}`, { cause: error }); }
      result.diff = diffOrgReports(previous, result);
    }
    if (opts.artifactsDir) await writeOrgArtifactBundle(result, { cwd: opts.cwd, directory: opts.artifactsDir });
    await emit(renderOrgReport(result, { format: opts.format }), opts);
    process.exitCode = result.status === 'OK' ? 0 : 1;
  });

async function emit(payload, opts) {
  if (opts.output === 'file' || opts.outputPath) {
    const path = opts.outputPath ?? 'deps-warden-output.txt';
    await writeFileGuarded({
      path,
      content: payload,
      dryRun: false,
      cwd: opts.cwd ?? process.cwd(),
    });
    return;
  }
  await writeStream(process.stdout, payload);
}

addCommonOptions(program.command('audit'))
  .description('Scan repo for supply-chain misconfigurations')
  .option('--policy <path>', 'policy file (default: .deps-warden.yml or .deps-warden.yaml)')
  .addOption(new Option('--severity <lvl>', 'legacy shorthand for both report and fail levels').choices(SEVERITIES))
  .addOption(new Option('--report-level <lvl>', 'minimum severity to display').choices(SEVERITIES))
  .addOption(new Option('--fail-level <lvl>', 'minimum severity that fails the gate').choices(SEVERITIES))
  .option('--rule <id...>', 'run only the named rule(s); repeatable or comma-separated')
  .option('--fail-on <id...>', 'exit non-zero only when one of these rules fires (report stays full); repeatable or comma-separated')
  .option('--explain', 'include a remediation hint for each finding (default)')
  .option('--no-explain', 'omit the per-finding remediation hint')
  .option('--trusted-registry <host...>', 'extra trusted-registry host (repeatable)')
  .option('--check-versions', 'query the registry for outdated/deprecated/freshly-published deps (opt-in network)', false)
  .addOption(new Option('--network <mode>', 'network mode').choices(['off', 'registry']))
  .option('--verbose', 'include SKIP records explaining which rules did not apply and why', false)
  .option('--require-complete', 'fail when required evidence is unavailable', undefined)
  .option('--github-summary', 'append a human-readable report to GITHUB_STEP_SUMMARY', false)
  .option('--github-annotations', 'emit native GitHub workflow annotations for findings', false)
  .option('--max-github-annotations <n>', 'maximum native annotations to emit (0-50)', parseAnnotationLimit, 20)
  .action(async (opts) => {
    const selectedRules = splitList((opts.rule ?? []).join(','));
    const failOn = splitList((opts.failOn ?? []).join(','));
    const result = await audit({
      cwd: opts.cwd,
      pmOverride: opts.pm,
      severity: opts.severity,
      reportLevel: opts.reportLevel,
      failLevel: opts.failLevel,
      policyPath: opts.policy,
      rules: opts.rule !== undefined ? selectedRules : undefined,
      failOn: opts.failOn !== undefined ? failOn : undefined,
      explain: opts.explain,
      trustedRegistries: opts.trustedRegistry,
      checkVersions: opts.checkVersions ? true : undefined,
      networkMode: opts.network,
      requireComplete: opts.requireComplete,
    });
    const payload = renderAudit(result, { format: opts.format, cwd: opts.cwd, verbose: Boolean(opts.verbose) });
    await emit(payload, opts);
    if (opts.githubSummary) {
      const summaryPath = process.env.GITHUB_STEP_SUMMARY;
      if (!summaryPath) throw new Error('--github-summary requires GITHUB_STEP_SUMMARY');
      await appendGitHubStepSummary(summaryPath, renderGitHubSummary(result, { cwd: opts.cwd }));
    }
    if (opts.githubAnnotations) {
      await writeStream(process.stdout, renderGitHubAnnotations(result, {
        cwd: opts.cwd,
        maxAnnotations: opts.maxGithubAnnotations,
      }));
    }
    process.exitCode = result.status === 'OK' ? 0 : 1;
  });

addCommonOptions(program.command('fix'))
  .description('Propose (or apply with --write) the fix for a single finding')
  .requiredOption('--finding <id>', 'finding id from `audit` to fix')
  .option('--write', 'apply changes (disables dry-run)', false)
  .action(async (opts) => {
    const dryRun = !opts.write;
    const result = await fix({
      cwd: opts.cwd,
      pmOverride: opts.pm,
      finding: opts.finding,
      dryRun,
    });
    const payload = renderFix(result, { format: opts.format, dryRun, cwd: opts.cwd });
    await emit(payload, opts);
    process.exitCode = result.status === 'OK' ? 0 : 1;
  });

program.command('rules')
  .description('List available audit rules')
  .addOption(formatOption)
  .action(async (opts) => {
    const result = await rules();
    await writeStream(process.stdout, renderRules(result, { format: opts.format }));
  });

addCommonOptions(program.command('init'))
  .description('Bootstrap recommended config files for the detected PM and profile')
  .addOption(new Option('--profile <p>', 'strictness profile').choices(['strict', 'balanced', 'loose']).default('balanced'))
  .option('--write', 'apply changes (disables dry-run)', false)
  .action(async (opts) => {
    const dryRun = !opts.write;
    const result = await init({
      cwd: opts.cwd,
      pmOverride: opts.pm,
      profile: opts.profile,
      dryRun,
    });
    const payload = renderInit(result, { format: opts.format, dryRun, cwd: opts.cwd });
    await emit(payload, opts);
    process.exitCode = result.status === 'OK' ? 0 : 1;
  });

addCommonOptions(program.command('scripts'))
  .description('List direct deps with lifecycle scripts; manage the PM allowlist')
  .option('--add-to-allowlist <pkgs>', 'comma-separated package names to add')
  .option('--remove-from-allowlist <pkgs>', 'comma-separated package names to remove')
  .option('--write', 'apply changes (disables dry-run)', false)
  .action(async (opts) => {
    const dryRun = !opts.write;
    const result = await scripts({
      cwd: opts.cwd,
      pmOverride: opts.pm,
      add: splitList(opts.addToAllowlist),
      remove: splitList(opts.removeFromAllowlist),
      dryRun,
    });
    const payload = renderScripts(result, { format: opts.format, dryRun, cwd: opts.cwd });
    await emit(payload, opts);
    process.exitCode = result.status === 'OK' ? 0 : 1;
  });

addCommonOptions(program.command('report'))
  .description('Combined audit + scripts report')
  .option('--policy <path>', 'policy file (default: .deps-warden.yml or .deps-warden.yaml)')
  .addOption(new Option('--severity <lvl>', 'legacy shorthand for both report and fail levels').choices(['low', 'medium', 'high', 'critical']))
  .addOption(new Option('--report-level <lvl>', 'minimum severity to display').choices(['low', 'medium', 'high', 'critical']))
  .addOption(new Option('--fail-level <lvl>', 'minimum severity that fails the gate').choices(['low', 'medium', 'high', 'critical']))
  .option('--rule <id...>', 'run only the named rule(s); repeatable or comma-separated')
  .option('--fail-on <id...>', 'exit non-zero only when one of these rules fires (report stays full); repeatable or comma-separated')
  .option('--explain', 'include a remediation hint for each finding (default)')
  .option('--no-explain', 'omit the per-finding remediation hint')
  .option('--trusted-registry <host...>', 'extra trusted-registry host (repeatable)')
  .option('--check-versions', 'query the registry for outdated/deprecated/freshly-published deps (opt-in network)', false)
  .addOption(new Option('--network <mode>', 'network mode').choices(['off', 'registry']))
  .option('--verbose', 'include SKIP records explaining which rules did not apply and why', false)
  .option('--require-complete', 'fail when required evidence is unavailable', undefined)
  .action(async (opts) => {
    const selectedRules = splitList((opts.rule ?? []).join(','));
    const failOn = splitList((opts.failOn ?? []).join(','));
    const result = await report({
      cwd: opts.cwd,
      pmOverride: opts.pm,
      severity: opts.severity,
      reportLevel: opts.reportLevel,
      failLevel: opts.failLevel,
      rules: opts.rule !== undefined ? selectedRules : undefined,
      failOn: opts.failOn !== undefined ? failOn : undefined,
      explain: opts.explain,
      trustedRegistries: opts.trustedRegistry,
      checkVersions: opts.checkVersions ? true : undefined,
      policyPath: opts.policy,
      networkMode: opts.network,
      requireComplete: opts.requireComplete,
    });
    const payload = renderReport(result, { format: opts.format, cwd: opts.cwd, verbose: Boolean(opts.verbose) });
    await emit(payload, opts);
    process.exitCode = result.status === 'OK' ? 0 : 1;
  });

program.command('plan')
  .description('Create a deterministic remediation plan for one finding')
  .option('--cwd <dir>', 'working directory', process.cwd())
  .addOption(new Option('--pm <kind>', 'override package manager detection').choices(PM_KINDS))
  .requiredOption('--finding <id>', 'finding id from `audit`')
  .option('--output <path>', 'write the JSON plan to this project-relative path')
  .action(async (opts) => {
    const result = await createPlan({ cwd: opts.cwd, pmOverride: opts.pm, finding: opts.finding });
    const payload = renderPlan(result);
    if (opts.output) {
      await writeFileGuarded({ path: opts.output, content: payload, dryRun: false, cwd: opts.cwd });
    } else {
      await writeStream(process.stdout, payload);
    }
    process.exitCode = result.status === 'OK' ? 0 : 1;
  });

program.command('apply')
  .description('Validate (or apply with --write) a remediation plan')
  .argument('<plan>', 'JSON remediation plan path')
  .option('--cwd <dir>', 'working directory', process.cwd())
  .addOption(new Option('--pm <kind>', 'override package manager detection').choices(PM_KINDS))
  .addOption(new Option('--format <fmt>', 'output format').choices(['toon', 'json', 'text']).default('toon'))
  .option('--write', 'apply the validated plan', false)
  .action(async (planPath, opts) => {
    const result = await applyPlan({ cwd: opts.cwd, pmOverride: opts.pm, plan: planPath, write: opts.write });
    await writeStream(process.stdout, renderApply(result, {
      format: opts.format,
      cwd: opts.cwd,
      write: opts.write,
    }));
    process.exitCode = result.status === 'OK' ? 0 : 1;
  });

const policyCommand = program.command('policy').description('Manage the versioned project policy');

policyCommand.command('init')
  .description('Create a default .deps-warden.yml policy')
  .option('--cwd <dir>', 'working directory', process.cwd())
  .option('--path <path>', 'policy path relative to cwd')
  .addOption(new Option('--format <fmt>', 'output format').choices(['toon', 'json', 'text']).default('toon'))
  .option('--write', 'create the policy file', false)
  .action(async (opts) => {
    const result = await initPolicy({ cwd: opts.cwd, path: opts.path, dryRun: !opts.write });
    await writeStream(process.stdout, renderPolicy(result, { format: opts.format }));
    process.exitCode = result.status === 'OK' ? 0 : 1;
  });

policyCommand.command('validate')
  .description('Validate a project policy')
  .option('--cwd <dir>', 'working directory', process.cwd())
  .option('--path <path>', 'policy path relative to cwd')
  .addOption(new Option('--format <fmt>', 'output format').choices(['toon', 'json', 'text']).default('toon'))
  .action(async (opts) => {
    const result = await validatePolicyFile({ cwd: opts.cwd, path: opts.path });
    await writeStream(process.stdout, renderPolicy(result, { format: opts.format }));
    process.exitCode = result.status === 'OK' ? 0 : 1;
  });

policyCommand.command('show')
  .description('Show the effective project policy')
  .option('--cwd <dir>', 'working directory', process.cwd())
  .option('--path <path>', 'policy path relative to cwd')
  .addOption(new Option('--format <fmt>', 'output format').choices(['toon', 'json', 'text']).default('json'))
  .action(async (opts) => {
    const result = await showPolicy({ cwd: opts.cwd, path: opts.path });
    await writeStream(process.stdout, renderPolicy(result, { format: opts.format }));
    process.exitCode = result.status === 'OK' ? 0 : 1;
  });

function splitList(s) {
  if (!s) return [];
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

function parseInteger(value) {
  if (!/^\d+$/.test(value)) throw new Error(`expected a non-negative integer, got: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`integer is too large: ${value}`);
  return parsed;
}

function parseAnnotationLimit(value) {
  const parsed = parseInteger(value);
  if (parsed > 50) throw new Error(`maximum GitHub annotations is 50, got: ${value}`);
  return parsed;
}

async function githubAppTokenProvider(opts) {
  const appId = opts.githubAppId ?? process.env.GITHUB_APP_ID;
  const installationId = opts.githubAppInstallationId ?? process.env.GITHUB_APP_INSTALLATION_ID;
  const keyPath = opts.githubAppPrivateKeyPath ?? process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  const keyFromEnvironment = process.env.GITHUB_APP_PRIVATE_KEY;
  const configured = [appId, installationId, keyPath ?? keyFromEnvironment].filter(Boolean).length;
  if (configured === 0) return null;
  if (!appId || !installationId || (!keyPath && !keyFromEnvironment)) {
    throw new Error('incomplete GitHub App configuration: app id, installation id, and private key are all required');
  }
  const privateKey = keyPath ? await readFile(keyPath, 'utf8') : keyFromEnvironment.replace(/\\n/g, '\n');
  return createGitHubAppTokenProvider({
    appId,
    installationId,
    privateKey,
    baseUrl: opts.apiUrl,
    apiVersion: opts.apiVersion,
  });
}

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err?.code === 'commander.helpDisplayed' || err?.code === 'commander.version') {
    process.exitCode = 0;
  } else {
    if (!String(err?.code ?? '').startsWith('commander.')) {
      await writeStream(process.stderr, `error: ${err.message}\n`);
    }
    process.exitCode = 2;
  }
}

async function writeStream(stream, payload) {
  writeFd(stream.fd, payload);
}

function writeFd(fd, payload) {
  const buffer = Buffer.from(String(payload));
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}
