# GitHub Actions integration

deps-warden supports two GitHub-native presentation channels:

- a Markdown job summary containing the gate decision, severity counts,
  evidence coverage, findings, remediation, and next steps;
- native check annotations attached to exact repository files and lines when a
  rule has precise line evidence.

Critical and high findings are errors, medium findings are warnings, and low
findings are notices. The process exit code—not the annotation level—decides
whether the step fails.

## Current release status

The composite action runs the npm package selected by its `version` input. The
package is not published yet, so use the source-checkout workflow below until an
exact package version is available. Do not configure `latest` or another
floating tag after release.

## Source-checkout gate

This form works today when testing deps-warden itself or when the tool source is
deliberately vendored into the audited repository. External repositories should
wait for the first npm release or invoke a separately reviewed checkout; the
composite action cannot install a package version that does not exist.

```yaml
name: supply-chain

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  audit:
    runs-on: ubuntu-latest
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
      - name: deps-warden gate
        run: >-
          node src/cli.js audit
          --require-complete
          --github-summary
          --github-annotations
          --max-github-annotations=20
```

The setup disables `setup-node` automatic package-manager caching because Node
24 currently bundles npm 11, while this project intentionally enforces npm 12
through `devEngines`.

## Composite action after npm publication

Pin both the action revision and the npm package version:

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
  - uses: chiz0me/deps-warden@<full-commit-sha>
    with:
      version: '<exact-published-version>'
      report-level: low
      fail-level: high
      require-complete: true
      job-summary: true
      annotations: true
      max-annotations: 20
```

## Action inputs

| Input | Default | Purpose |
|---|---|---|
| `working-directory` | `.` | Node project or monorepo root to audit. |
| `version` | `0.1.0` | Exact npm package version or explicitly chosen dist-tag. Exact versions are recommended. |
| `rules` | empty | Comma-separated rule IDs; empty runs the policy/default set. |
| `fail-on` | empty | Comma-separated rule IDs that affect the exit code; the report remains full. |
| `severity` | empty | Legacy shorthand for both report and fail thresholds. |
| `report-level` | policy/default | Lowest displayed severity. |
| `fail-level` | policy/default | Lowest severity that fails the gate. |
| `check-versions` | `false` | Opt in to npm registry requests. |
| `require-complete` | `false` | Fail when required evidence is unavailable. Production baselines should set `true`. |
| `format` | `toon` | Console output: `toon`, `json`, or `text`. |
| `job-summary` | `true` | Append the human-readable Markdown dashboard. |
| `annotations` | `true` | Emit native workflow annotations. |
| `max-annotations` | `20` | Bound native annotations; accepted range is 0–50. |

## What appears in GitHub

The job summary is the complete human view and includes up to 50 prioritized
findings. Native annotations are intentionally capped. Findings are ordered by
severity, then stable scan order.

An exact-line finding produces a workflow command equivalent to:

```text
::error title=deps-warden: direct-deps-exact (high),file=package.json,line=6::Replace the ranged dependency with the exact reviewed version. Finding id: abc123def4.
```

Values are escaped before they enter the workflow-command channel, secrets are
redacted, and long values are truncated. For nested projects, paths are resolved
relative to `GITHUB_WORKSPACE`, so an audit of `packages/app` annotates
`packages/app/package.json`, not the repository root manifest.

If a rule identifies a file but not a trustworthy line, deps-warden omits the
file property rather than allowing GitHub to misleadingly default to line 1.

## Live demonstration

Run the manual workflow from the Actions tab, or use:

```bash
gh workflow run annotation-demo.yml --repo chiz0me/deps-warden --ref main
```

The workflow audits four intentionally ranged dependencies in
`test/fixtures/npm-versions/package.json`. It emits annotations on lines 6–9,
writes the job summary, and verifies the expected audit failure while keeping
the demonstration job green. It never runs on normal pushes or pull requests.

Example run: [annotation demo 31171966240](https://github.com/chiz0me/deps-warden/actions/runs/31171966240).

## Adoption patterns

Start with visibility while preserving the full report:

```yaml
with:
  report-level: low
  fail-level: critical
  require-complete: true
```

Then lower `fail-level` as the backlog is remediated. Use `fail-on` only for a
time-bounded migration where specific controls must gate first; it should not
become a permanent replacement for a complete baseline.

## Troubleshooting

- **No annotations:** the result may be clean, annotations may be disabled, or
  findings may exceed the configured cap. Check the job summary first.
- **Annotation lacks a file:** the rule did not have exact line evidence. The
  job-summary location still identifies the affected file.
- **Summary missing:** ensure the command runs inside GitHub Actions and
  `GITHUB_STEP_SUMMARY` has not been overwritten by a later command in the same
  step.
- **`no-git-index`:** use `actions/checkout`; do not scan a source archive when
  `--require-complete` is enabled.
- **Generic `Process completed with exit code 1` annotation:** GitHub adds this
  when the security gate fails. It is separate from deps-warden findings.
- **Large finding set:** keep native annotations bounded and save JSON/SARIF as
  artifacts. For organization scans, use the artifact bundle documented in
  [GitHub organization scans](./GITHUB_ORG_SCAN.md).

## Security requirements

- Pin every third-party action and reusable workflow to a full commit SHA.
- Set `persist-credentials: false` unless a later step must push.
- Grant only `contents: read` for a project audit.
- Pin the deps-warden npm package version independently of the action commit.
- Treat `--check-versions` as an explicit network decision.
- Keep `require-complete: true` for mandatory gates.
