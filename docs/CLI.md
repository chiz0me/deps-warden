# CLI reference

This guide describes the user-facing command contract. `node src/cli.js
<command> --help` is the source of truth for the installed revision.

## Run the current source revision

The npm package has not been published yet. Use a clean checkout and the exact
locked dependency tree:

```bash
git clone git@github.com:chiz0me/deps-warden.git
cd deps-warden
npm ci
node src/cli.js --help
```

After the first release, use `npx --yes deps-warden@<exact-version>` in place of
`node src/cli.js`. Pinning the package is part of the security boundary.

## Command map

| Command | Purpose | Network | Writes by default |
|---|---|---:|---:|
| `audit` | Evaluate project configuration and policy rules | No; registry only with `--check-versions` | No |
| `report` | Combine `audit` with installed lifecycle-script inventory | Same as `audit` | No |
| `rules` | List rule identifiers, severity, and descriptions | No | No |
| `scripts` | Inspect lifecycle scripts and propose allowlist edits | No | No; requires `--write` |
| `init` | Propose recommended package-manager configuration | No | No; requires `--write` |
| `fix` | Propose or apply one fixable finding | No | No; requires `--write` |
| `plan` | Create a hash-bound JSON remediation plan | No | Only the requested plan file |
| `apply` | Validate a plan and optionally apply it | No | No; requires `--write` |
| `policy` | Initialize, validate, or show project policy | No | `policy init` requires `--write` |
| `github-scan` | Scan GitHub organization repositories and settings | Yes, GitHub API | Reports, cache, checkpoints when requested |

## Audit

```bash
node src/cli.js audit [options]
```

Common controls:

| Option | Meaning |
|---|---|
| `--cwd=<dir>` | Project root to scan. Defaults to the current directory. |
| `--policy=<path>` | Explicit policy file; otherwise `.deps-warden.yml` or `.deps-warden.yaml`. |
| `--rule=<id...>` | Run only selected rule IDs. Values may be repeated or comma-separated. |
| `--report-level=<severity>` | Lowest severity included in the report. |
| `--fail-level=<severity>` | Lowest severity that fails the gate. Must not be below the reporting visibility. |
| `--fail-on=<id...>` | Only selected rules affect the exit code; the report remains complete. |
| `--require-complete` | Fail if required Git or requested registry evidence is unavailable. Use in mandatory CI. |
| `--check-versions` | Opt in to npm registry requests for freshness, deprecation, and major-version checks. |
| `--format=toon|json|text` | Select compact, structured, or human console output. |
| `--output-path=<path>` | Write the report to a project-relative file; file output is inferred automatically. |
| `--verbose` | Include rules skipped as unavailable or not applicable. |

Use separate display and gate thresholds during adoption:

```bash
node src/cli.js audit --report-level=low --fail-level=high
```

Use `--fail-on` when only a temporary subset can gate. It does not hide other
findings:

```bash
node src/cli.js audit \
  --fail-on=lockfile-present,direct-deps-exact \
  --require-complete
```

`--severity` is retained as a legacy shorthand that sets both thresholds.

## Output formats

- `toon` is the default compact line-oriented format for humans and assistants.
- `json` is the stable choice for automation and saved project reports.
- `text` is a conventional key/value console rendering.
- Organization scans additionally support `sarif`, `html`, and `csv`.

All formats pass through the redaction layer. A result ends in `OK` or `FAIL`;
`FAIL` may mean a gating finding or incomplete mandatory evidence.

```bash
node src/cli.js audit --format=json --output-path=deps-warden-report.json
```

## Safe remediation

Mutation is always explicit. Prefer the plan/apply flow for reviewable changes:

```bash
# 1. Find the stable finding id.
node src/cli.js audit --format=json --output-path=audit.json

# 2. Create a plan containing relative paths, hashes, redacted diffs, and no secrets.
node src/cli.js plan \
  --finding=<finding-id> \
  --output=deps-warden-plan.json

# 3. Revalidate without writing.
node src/cli.js apply deps-warden-plan.json

# 4. Apply only after review. Stale or modified targets are rejected.
node src/cli.js apply deps-warden-plan.json --write
```

`fix`, `init`, and allowlist changes made by `scripts` also require `--write`.
Never add `--write` merely to make a gate pass; review the proposed change and
the security tradeoff first.

## Project policy

```bash
node src/cli.js policy init --write
node src/cli.js policy validate
node src/cli.js policy show --format=json
```

Minimal policy:

```yaml
version: 1
scan:
  reportLevel: low
  failLevel: high
  rules: []
  failOn: []
  explain: true
  requireComplete: true
network:
  mode: off
  trustedRegistries: []
```

An empty `rules` or `failOn` list means the default full rule set or default
severity gate respectively. Unknown keys, rule IDs, or unsafe threshold
combinations are rejected.

## GitHub presentation flags

`audit` can render native GitHub output without changing the underlying result:

```bash
node src/cli.js audit \
  --github-summary \
  --github-annotations \
  --max-github-annotations=20
```

`--github-summary` requires the runner-provided `GITHUB_STEP_SUMMARY` path.
Annotations are bounded and emitted only with a file location when an exact line
is known. See [GitHub Actions](./GITHUB_ACTIONS.md).

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | Gate passed, or the requested non-audit operation completed successfully. |
| `1` | Gate failed, required evidence was incomplete, or a fix/init operation failed. |
| `2` | Invalid arguments or command usage. |

Do not infer compliance from exit code `0` unless the policy requires complete
evidence and the broader [mandatory baseline](./SUPPLY_CHAIN_BASELINE.md) is
also satisfied.

## Troubleshooting

- **`no-git-index`:** run inside a real Git checkout. Archive downloads and
  copied source directories cannot prove that lockfiles or credential files are
  tracked.
- **No lifecycle scripts detected:** install dependencies with the reviewed,
  frozen lockfile first; the command will report when `node_modules` evidence is
  unavailable.
- **Registry checks skipped:** pass `--check-versions` or set policy network mode
  to `registry`. Network access remains opt-in.
- **Unexpected package manager:** use `--pm=npm|pnpm` only when detection cannot
  be corrected in the project itself.
- **Need every option:** run `node src/cli.js <command> --help` for the exact
  revision in your checkout.
