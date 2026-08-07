# deps-warden

Audit supply-chain misconfigurations in npm and pnpm projects.
Safe-by-default CLI with machine-readable JSON and compact TOON output.

Yarn and Bun detection exists so unsupported projects fail explicitly; their
full adapters are planned and are not presented as completed audits.

```
npx --yes deps-warden@0.1.0 audit
```

## What it does

`deps-warden` scans a Node.js project for supply-chain hygiene issues:

- **Lifecycle scripts**: are install scripts gated by an allowlist?
  (npm `ignore-scripts`, pnpm `allowBuilds` / `strictDepBuilds`)
- **npm v12 readiness**: are Git and remote URL dependencies denied by default,
  and are dangerous install-script escape hatches disabled?
- **Version pinning**: are dependencies pinned to exact versions?
  (npm `save-exact`)
- **Lockfile hygiene**: lockfile present and committed; only one lockfile.
- **Registry trust**: registry is a known-good host; no auth tokens committed.
- **Release age**: minimum-release-age threshold blocks freshly-published versions.
- **pnpm resolution integrity**: lockfile verification, exotic transitive
  sources, release-time metadata, and `.pnpmfile.mjs` hooks are checked.
- **Immutable GitHub Actions**: workflow action references are parsed by the
  pinned `actions-warden` library and must use full commit SHAs.
- **Pinned manifests**: the root `packageManager` and registry-backed direct,
  development, and optional dependencies must declare exact versions.
- **Version checks** (opt-in `--check-versions`, network): direct deps that are
  a major version behind, installed at a deprecated/yanked version, or published
  inside your release-age window.

The project also defines a versioned [mandatory supply-chain baseline](./docs/SUPPLY_CHAIN_BASELINE.md).
Use `--require-complete` in CI so unavailable git or requested registry evidence
cannot be presented as a clean result.

For each fixable finding, `deps-warden plan` creates a deterministic JSON plan
containing relative paths, content hashes, summaries, and redacted diffs. It
never stores full config contents. `deps-warden apply` revalidates the plan and
only mutates with an explicit `--write`.

## Quickstart

```bash
# Audit the current project (TOON output, default)
npx --yes deps-warden@0.1.0 audit

# JSON output
npx --yes deps-warden@0.1.0 audit --format=json

# Filter to high+ severity only
npx --yes deps-warden@0.1.0 audit --severity=high

# Also check the registry for outdated/deprecated/freshly-published deps (opt-in network)
npx --yes deps-warden@0.1.0 audit --check-versions

# List available rules
npx --yes deps-warden@0.1.0 rules

# Create and validate a remediation plan
npx --yes deps-warden@0.1.0 plan --finding=<id> --output=deps-warden-plan.json
npx --yes deps-warden@0.1.0 apply deps-warden-plan.json

# Apply the unchanged plan after review
npx --yes deps-warden@0.1.0 apply deps-warden-plan.json --write

# Create and validate a versioned project policy
npx --yes deps-warden@0.1.0 policy init --write
npx --yes deps-warden@0.1.0 policy validate

# Scan a GitHub organization (JSON is the canonical report format)
GITHUB_TOKEN=... npx --yes deps-warden@0.1.0 github-scan example-org --format=json --output-path=org-report.json
```

## GitHub organization scanning

`github-scan` is a read-only, fail-closed organization audit designed for
1,000+ repositories. It paginates all repositories, processes a bounded four
repositories at a time by default, and fetches only supply-chain evidence—it
does not clone or execute repository code. It caches derived code checks by Git
tree SHA and writes resumable per-repository checkpoints. GitHub repository
settings are always refreshed because they can change without a commit. When
GitHub truncates a recursive tree, the scanner performs a bounded targeted
subtree walk and fails closed if it cannot prove complete coverage.

Use a GitHub App installation token where possible. Large first-time scans can
exceed a user token's primary request budget; `--wait-for-rate-limit` pauses and
resumes, while the default preserves 50 requests and marks unfinished evidence
incomplete. Grant repository `Metadata: read`, `Contents: read`, and
`Administration: read`, plus organization `Administration: read` for Actions
governance; the organization owner/security-manager role is needed
for GitHub's `security_and_analysis` status block. Subsequent runs reuse
unchanged code checks. If GitHub omits the authenticated private-repository
count, provide `--expected-repos=<inventory count>`; otherwise inventory
coverage is `unknown` and the report fails closed. Useful controls:

```bash
deps-warden github-scan example-org \
  --concurrency=4 \
  --wait-for-rate-limit \
  --exclude-archived \
  --profile=baseline \
  --format=json \
  --output-path=org-report.json
```

Providing `--output-path` automatically selects file output. Use
`--artifacts-dir=deps-warden-artifacts` to stage canonical JSON, SARIF, a
self-contained HTML dashboard, a spreadsheet-safe CSV summary, and a SHA-256
manifest from the same scan. `--baseline-report=previous.json` embeds a
deterministic scan-to-scan diff.

The scanner checks organization Actions allowlists, SHA-pinning policy,
reusable-workflow governance, default workflow token permissions, and PR-review
approval policy; repository branch protection; secret scanning and push protection;
Dependabot vulnerability alerts and security updates; recursive-tree coverage; all applicable
deps-warden rules; and the `actions-warden` rules for permissions, secret
scope, script injection, and unsafe `pull_request_target` checkout. Exact
dependency versions, a committed lockfile, a pinned package manager, immutable
Actions, frozen CI installs, valid security configuration, and governed
exceptions are mandatory. Node projects found only in nested directories are
audited as monorepo projects rather than classified as non-Node repositories.
Checks requiring an
installed `node_modules` tree and registry version lookups are reported as
optional unavailable/not-applicable evidence rather than guessed.

The default `baseline` profile gates the mandatory catalog. `strict` also gates
Advanced Security and opt-in registry freshness/version evidence. Accepted
risk must come from an external YAML/JSON file passed with `--exceptions`; an
entry must exactly name a repository and check and include `owner`, `reason`,
`approval`, and `expiresAt`. Repository-controlled inline suppressions cannot
waive an organization gate. Use `repository: "@organization"` for an
organization-level check. Expired, malformed, duplicate, or unmatched entries
do not pass.

The token is read from `GITHUB_TOKEN` or `GH_TOKEN`; `--token` exists for
automation that cannot set an environment variable but may expose the token in
the local process list. The cache contains only derived checks—never source
files or credentials. A truncated Git tree, evidence limit, API permission
gap, or rate-limit stop produces `unknown`/`skipped` mandatory checks and a
failing organization report.

An `OK` result means every mandatory check in the selected
`deps-warden-github-scan/v1/<profile>` profile passed or has an active governed
exception;
it does not assert the broader `deps-warden-baseline/v1` controls that require
registry or release-system evidence, such as trusted publishing, provenance,
or retained SBOMs. Keep those manual/external checks in the baseline record.

### MCP server

AI assistants can use the same scanner over the official MCP stdio transport:

```json
{
  "mcpServers": {
    "deps-warden": {
      "command": "/absolute/path/to/node_modules/.bin/deps-warden-mcp"
    }
  }
}
```

Set `GITHUB_TOKEN` (and optionally `GITHUB_API_URL` plus
`GITHUB_API_VERSION` for GitHub Enterprise) in
the MCP server process environment using the host's secret-management
facility; never commit the token in MCP configuration. The server exposes:

- `github_org_scan` — start a durable scan task and return immediately.
- `github_org_scan_status` — poll task progress without holding a tool call open.
- `github_org_report` — page/filter a completed task report, at most 100
  repositories per call.
- `supply_chain_check_catalog` — list emitted checks and mandatory status.

The scan tool never accepts credentials as arguments, preventing tokens from
entering model-visible tool calls. Tasks and reports are persisted under the
configured job directory, and assistants page details instead of injecting a
1,000-repository report into one context window.

### Asynchronous HTTP, webhooks, and Actions artifacts

`deps-warden-http` exposes an authenticated job API. Configure a random
`DEPS_WARDEN_HTTP_TOKEN` of at least 32 characters and GitHub token/App
credentials, then use `POST /v1/scans`, `GET /v1/scans/{id}`, and paginated
`GET /v1/scans/{id}/report`. The service binds to `127.0.0.1:8790` by default.
Request bodies cannot override credentials, filesystem locations, API URLs, or
webhook destinations.

Set a fixed HTTPS `DEPS_WARDEN_WEBHOOK_URL` and a 32+ character
`DEPS_WARDEN_WEBHOOK_SECRET` to receive HMAC-SHA256 signed `scan.completed` or
`scan.failed` notifications. The callback contains bounded job metadata, not
the full report. See [GitHub organization scan integrations](./docs/GITHUB_ORG_SCAN.md)
for HTTP examples, GitHub App configuration, the exception schema, and an
immutable GitHub Actions artifact-upload workflow.

## npm 11 migration and npm 12

npm 12 makes dependency install scripts, Git dependencies, and remote URL
dependencies explicit opt-ins. `deps-warden` supports migration without granting
blanket exceptions:

```bash
# On npm 11.16+, surface the packages npm 12 would block
npm approve-scripts --allow-scripts-pending

# Audit project policy, including npm v12 source restrictions
npx --yes deps-warden@0.1.0 audit --rule npm-version-supported npm-allow-scripts npm-v12-source-controls npm-dangerous-script-bypass
```

For npm older than 11.16, first move to a supported Node.js release. When that
runtime supports npm 12, pin a reviewed npm 12 release. If the runtime migration
is temporarily blocked, pin npm 11.16+ as a transitional client and explicitly
enable the fail-closed controls above. Do not use a floating `latest` tag. The
`npm-version-supported` fix records the 11.16 migration floor; it deliberately
does not install npm or assume the project can already run npm 12.

Prefer replacing Git/URL tarball dependencies with registry-published,
integrity-locked artifacts. If a direct exception is indispensable, review it
and use `allow-git=root` or `allow-remote=root`; never switch either control to
`all` merely to make an upgrade pass.

## Project policy

`audit` automatically loads `.deps-warden.yml` or `.deps-warden.yaml`:

```yaml
version: 1
scan:
  reportLevel: low
  failLevel: low
  rules: []
  failOn: []
  explain: true
  requireComplete: false
network:
  mode: off
  trustedRegistries: []
```

`reportLevel` controls visibility; `failLevel` controls the exit gate. The
policy validator rejects a reporting threshold that would hide a gating
finding. `network.mode: registry` explicitly enables registry version checks.
Command-line options override policy values for one run. Set `requireComplete:
true` for the mandatory baseline.

## Design

- **Modular**: file-per-rule under `src/rules/`, file-per-command under `src/commands/`.
- **Adapter layer**: rules never branch on PM. They call `ctx.pm.adapter.{getConfig,setConfig,…}`.
- **Safe-by-default**: `fix`, `scripts`, and `init` cannot mutate unless `--write` is present.
- **Stable finding IDs**: every finding has a deterministic 10-character fingerprint.
- **Reviewable remediation**: plans contain hashes and redacted diffs; apply rejects stale or tampered plans.
- **Versioned policy**: strict validation rejects unknown keys, rule IDs, and unsafe threshold combinations.
- **Suppressible**: inline `# deps-warden-ignore` directives in config files, or a
  committed `.deps-warden-ignore` file listing rule ids / finding ids (the only
  way to silence `package.json` findings). Suppressed findings still show as `IGNORED:`.
- **Zero subprocess**: never spawns `npm`/`pnpm`/`yarn`/`bun`. Reads files (and
  one read-only env var, `npm_config_user_agent`, for npm-version detection).
- **Shared workflow scanner**: `github-actions-immutable` delegates workflow
  discovery, parsing, and reference classification to the exact
  `actions-warden` dependency. deps-warden retains its own suppression policy;
  audit covers workflow steps, reusable-workflow jobs, and composite-action
  dependencies, but never resolves tags or modifies files.
- **Explicit network**: project audits call the registry only with
  `--check-versions`; `github-scan` is the explicitly networked, read-only
  organization transport. Derived results are cached under
  `.deps-warden-cache/`.
- **TOON output**: compact escaped `LABEL: key=value key=value` records.

## Use in CI

`deps-warden` ships a GitHub Action. Prefer a committed project policy and
complete-evidence gating; `fail-on` remains available for gradual adoption:

```yaml
permissions:
  contents: read
jobs:
  supply-chain:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>      # pin to a release
        with:
          persist-credentials: false
      - uses: actions/setup-node@<sha>    # pin to a release
        with:
          node-version: '24'
      - uses: chiz0me/deps-warden@<sha>   # pin to a release
        with:
          report-level: low
          fail-level: high
          require-complete: true
          job-summary: true       # human-readable Markdown dashboard
          annotations: true       # native file/line annotations
          max-annotations: 20     # keep large audits usable
          # rules: ...           # optional: run only these rules
          # severity: high       # optional: minimum severity to report
          # check-versions: true # optional: query the registry (network)
          # version: 0.1.0       # pin the deps-warden version
```

Without `fail-on`, the step uses `fail-level` and also fails on incomplete
required evidence. When `fail-on` is configured, only those rule findings gate
the result, while `require-complete` remains independently fail-closed.

The action writes a Markdown dashboard containing the gate decision, severity
counts, evidence coverage, file locations, remediation guidance, and next
steps. It also emits native GitHub annotations: critical/high findings are
errors, medium findings are warnings, and low findings are notices. Annotations
are capped to avoid overwhelming pull requests; the job summary remains the
authoritative human view. Disable either channel with `job-summary: false` or
`annotations: false`.

The CLI equivalents are `--github-summary`, `--github-annotations`, and
`--max-github-annotations=<n>`. `--github-summary` requires GitHub's
`GITHUB_STEP_SUMMARY` environment variable. Workflow commands are escaped and
credentials remain subject to the normal output redaction layer.

## Exit codes

| code | meaning |
|---|---|
| 0 | OK — no findings, or no errors during fix |
| 1 | FAIL — findings reported, or errors during fix/init |
| 2 | invalid arguments |

## Programmatic API

```js
import {
  audit,
  createOrgReport,
  fix,
  listRules,
  renderOrgReport,
  scanGitHubOrganization,
} from 'deps-warden';

const result = await audit({ cwd: '/path/to/repo', explain: true });
for (const finding of result.findings) {
  console.log(finding.id, finding.ruleId, finding.severity);
}

const organizationReport = createOrgReport({
  organization: 'example-org',
  repositories: [{
    name: 'service',
    checks: [{ id: 'lockfile-present', status: 'pass', severity: 'critical' }],
  }],
});
console.log(renderOrgReport(organizationReport, { format: 'json' }));

const liveReport = await scanGitHubOrganization({
  organization: 'example-org',
  token: process.env.GITHUB_TOKEN,
  waitForRateLimit: true,
});
```

`deps-warden-org-report/v1` is the canonical organization-report contract.
Mandatory `fail`, `unknown`, `unsupported`, or `skipped` evidence prevents a
compliant result. `scope`, `coverage`, and `api` fields make repository
selection, cache reuse, and remaining API budget explicit.

## License

MIT — see [LICENSE](./LICENSE).
