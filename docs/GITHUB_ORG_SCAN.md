# GitHub organization scan integrations

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
  - run: npm ci
  - name: Scan organization
    env:
      GITHUB_TOKEN: ${{ secrets.DEPS_WARDEN_GITHUB_TOKEN }}
    run: >-
      npx --yes deps-warden@0.1.0 github-scan example-org
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
deps-warden-http
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
