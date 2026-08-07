# GitHub organization scan integrations

`github-scan` audits organization and repository controls without cloning or
executing repository code. It lists repositories, reads settings, and downloads
only bounded supply-chain evidence such as manifests, lockfiles, workflows, and
security configuration. Nested Node projects are treated as monorepos.

## Quickstart

```bash
export GITHUB_TOKEN='<read-only-token>'

node src/cli.js github-scan example-org \
  --profile=baseline \
  --concurrency=4 \
  --wait-for-rate-limit \
  --progress \
  --output-path=org-report.json
```

`--output-path` implies file output. Without it, the selected format is written
to stdout. JSON is the canonical contract for automation.

## How large scans operate

- Repository inventory is paginated and checked against any supplied
  `--expected-repos` assertion.
- Four repositories are processed concurrently by default. Increase this only
  after measuring GitHub API and abuse-rate behavior.
- Code-derived checks are cached by Git tree SHA; repository and organization
  settings are refreshed every scan.
- Completed repositories are checkpointed. An interrupted scan resumes unless
  `--no-resume` is used or the checkpoint is older than its TTL.
- A truncated recursive tree triggers bounded targeted subtree traversal. If
  complete evidence cannot be proven within the configured limits, mandatory
  checks become incomplete and the report fails closed.
- The default preserves 50 primary API requests. `--wait-for-rate-limit` waits
  for reset and continues instead of returning an incomplete scan.

For 1,000+ repositories, start with the defaults, enable progress on stderr,
retain cache/checkpoints on durable storage, and use a GitHub App installation
instead of a long-lived personal token.

## Report contents

Each canonical report includes:

- schema/profile identifiers and overall `OK` or `FAIL` status;
- requested and observed repository scope, exclusions, and inventory coverage;
- per-repository classification and mandatory/optional checks;
- `pass`, `fail`, `unknown`, `unsupported`, or `skipped` evidence status;
- exception decisions with owner, approval, reason, and expiry;
- API/rate-limit metadata, cache reuse, and incomplete evidence;
- an optional deterministic diff from `--baseline-report`.

Mandatory `fail`, `unknown`, `unsupported`, or `skipped` evidence prevents a
compliant organization result unless an actual failed check has an active,
valid governed exception. Missing evidence cannot be waived.

The abbreviated JSON shape is:

```json
{
  "schema": "deps-warden-org-report/v1",
  "organization": "example-org",
  "policy": "deps-warden-github-scan/v1/baseline",
  "organizationStatus": "pass",
  "scope": {
    "discovered": 1042,
    "selected": 1000,
    "inventoryStatus": "pass"
  },
  "coverage": {
    "repositoriesTotal": 1000,
    "scanned": 997,
    "incomplete": 2,
    "unsupported": 1
  },
  "repositories": [
    {
      "name": "service-api",
      "status": "fail",
      "evidence": "complete",
      "checks": [
        {
          "id": "deps/direct-deps-exact",
          "mandatory": true,
          "status": "fail",
          "severity": "high",
          "file": "package.json",
          "line": 14,
          "reason": "dependency-range",
          "remediation": "Pin the reviewed version recorded in the lockfile."
        }
      ]
    }
  ],
  "status": "FAIL"
}
```

The values are illustrative; consumers should key on `schema`, check `id`, and
status fields rather than display text. Repository status is `incomplete` when
mandatory evidence is `unknown` or `skipped`, and `unsupported` when a mandatory
ecosystem check cannot be evaluated.

## Output formats and destinations

| Format | Intended use |
|---|---|
| `json` | Canonical automation, baselines, diffs, and long-term storage |
| `sarif` | GitHub Code Scanning or another SARIF consumer |
| `html` | Self-contained human dashboard |
| `csv` | Spreadsheet-safe repository summary |
| `toon` | Compact assistant/console consumption |
| `text` | Conventional console output |

Use `--artifacts-dir=<dir>` to generate JSON, SARIF, HTML, CSV, and a SHA-256
manifest from the same result. The CLI itself supports stdout or file output;
artifact upload, webhooks, HTTP jobs, and MCP tasks are integration transports
around that report rather than values for `--output`.

## Choose an integration

| Integration | Best for | Execution model |
|---|---|---|
| CLI | One-off scans and CI jobs | The caller waits for one scan and receives/writes one report. |
| Artifact bundle | Audit retention and dashboards | CLI stages multiple formats; CI uploads immutable artifacts. |
| MCP | AI assistants | Start task, poll status, then page the completed report. |
| HTTP job API | Internal services and scheduled automation | Authenticated asynchronous jobs with paginated reports. |
| Webhook | Completion notification | Fixed HTTPS callback receives signed bounded metadata, not the report. |

Long MCP/HTTP scans are task-based so a client never has to hold one tool or
request open for a 1,000-repository scan.

## GitHub App authentication

Prefer a GitHub App installation with repository Metadata, Contents, and
Administration read permissions and organization Administration read
permission. Configure the server process, not a model-visible tool call:

```sh
export GITHUB_APP_ID=12345
export GITHUB_APP_INSTALLATION_ID=67890
export GITHUB_APP_PRIVATE_KEY_PATH=/run/secrets/deps-warden-app.pem
```

Installation tokens are minted and refreshed automatically. `GITHUB_TOKEN` or
`GH_TOKEN` takes precedence when present.

## MCP task workflow

For the current source checkout, configure the MCP host to launch Node directly:

```json
{
  "mcpServers": {
    "deps-warden": {
      "command": "node",
      "args": ["/absolute/path/to/deps-warden/src/mcp.js"]
    }
  }
}
```

Provide GitHub credentials to the server process through the host's secret
facility. Do not place a literal token in repository or model-visible
configuration. Optional shared settings include `GITHUB_API_URL`,
`GITHUB_API_VERSION`, `DEPS_WARDEN_JOB_DIRECTORY`, and
`DEPS_WARDEN_EXCEPTIONS_PATH`.

The server exposes:

| Tool | Purpose |
|---|---|
| `github_org_scan` | Start a durable scan and return a task ID immediately. |
| `github_org_scan_status` | Poll progress and terminal status. |
| `github_org_report` | Page/filter a completed report, at most 100 repositories per call. |
| `supply_chain_check_catalog` | List emitted checks and mandatory status. |

Credentials are environment-only and never accepted in tool arguments.

## Governed exceptions

Exceptions are external to scanned repositories and use strict versioned YAML
(JSON is also valid YAML):

```yaml
version: 1
exceptions:
  - repository: payments-api
    check: deps/direct-deps-exact
    owner: platform-security
    reason: Migration is tracked while the upstream SDK is replaced.
    approval: SEC-1842
    expiresAt: 2026-09-30T00:00:00Z
  - repository: "@organization"
    check: github-org/reusable-workflows-governed
    owner: security-architecture
    reason: Temporary verified-publisher policy migration.
    approval: ARB-91
    expiresAt: 2026-08-31T00:00:00Z
```

Run with `--exceptions=/run/policy/deps-warden-exceptions.yml`. A record only
accepts an actual failed check. It never turns missing or incomplete evidence
into a pass.

## GitHub Actions artifact bundle

One scan can stage JSON, SARIF, HTML, CSV, and a digest manifest. Upload that
directory with GitHub's official action pinned to a full commit SHA:

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0
    with:
      persist-credentials: false
  - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0
    with:
      node-version: '24.18.0'
      package-manager-cache: false
  - name: Install pinned npm
    working-directory: /tmp
    run: npm install --global npm@12.0.2 --ignore-scripts
  - run: npm ci
  - name: Scan organization
    env:
      GITHUB_TOKEN: ${{ secrets.DEPS_WARDEN_GITHUB_TOKEN }}
    run: >-
      node src/cli.js github-scan example-org
      --wait-for-rate-limit
      --artifacts-dir=deps-warden-artifacts
      --output-path=deps-warden-artifacts/report.console.json
  - name: Upload reports
    if: always()
    uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
    with:
      name: deps-warden-${{ github.run_id }}
      path: deps-warden-artifacts/
      if-no-files-found: error
      retention-days: 30
```

Use a unique artifact name per run. Do not upload the cache or checkpoint
directories; report bundles contain derived findings while caches may reveal
repository inventory and internal paths.

## Asynchronous HTTP jobs and webhooks

Start the service with fixed credentials and callback configuration:

```sh
export DEPS_WARDEN_HTTP_TOKEN='<at-least-32-random-characters>'
export GITHUB_TOKEN='...'
export DEPS_WARDEN_WEBHOOK_URL='https://security.example.com/hooks/deps-warden'
export DEPS_WARDEN_WEBHOOK_SECRET='<at-least-32-random-characters>'
node src/http.js
```

Start and poll a scan:

```sh
curl --fail-with-body -X POST http://127.0.0.1:8790/v1/scans \
  -H "Authorization: Bearer $DEPS_WARDEN_HTTP_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"organization":"example-org","profile":"baseline","waitForRateLimit":true}'

curl --fail-with-body http://127.0.0.1:8790/v1/scans/JOB_ID \
  -H "Authorization: Bearer $DEPS_WARDEN_HTTP_TOKEN"

curl --fail-with-body 'http://127.0.0.1:8790/v1/scans/JOB_ID/report?status=fail&limit=25' \
  -H "Authorization: Bearer $DEPS_WARDEN_HTTP_TOKEN"
```

Webhook receivers should verify
`X-Deps-Warden-Signature-256: sha256=<HMAC of the exact request body>` before
processing an event. The callback URL is server configuration and cannot be
set per request, which prevents callers from turning the scanner into an SSRF
primitive.
