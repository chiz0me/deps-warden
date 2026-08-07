---
name: deps-warden
description: Audit and harden supply-chain configuration in Node.js projects and across large GitHub organizations using npm or pnpm. Use when the user asks to scan package-manager configuration or a GitHub org, assess lifecycle/install scripts, prepare for npm v12, restrict Git or remote URL dependencies, validate lockfiles, frozen CI installs, GitHub Actions or reusable workflows, organization Actions governance, branch protection, secret-scanning, or registry hygiene, review allowlists or governed exceptions, create policies, produce remediation plans or SARIF/HTML/CSV reports, investigate postinstall compromise risk, or prepare CI supply-chain gates. Detect Yarn and Bun projects but report them as unsupported until their adapters are implemented; never describe partial or unavailable evidence as clean.
---

# deps-warden

`deps-warden` audits npm and pnpm projects. Mutating CLI commands cannot write
unless `--write` is present. Prefer canonical JSON for agent decisions; use
TOON only when compact presentation is useful.

## How to invoke

Prefer a repository-local, lockfile-pinned binary:

```sh
./node_modules/.bin/deps-warden audit --format=json
```

If no local binary exists, obtain approval before downloading or executing a
package, then use an exact version such as
`npx --yes deps-warden@0.1.0 audit --format=json`. Never use an unpinned npm
dist-tag for a supply-chain audit.

Useful global flags: `--cwd <dir>`, `--pm npm|pnpm`,
`--format toon|json|text`, `--output stdout|file`, `--output-path <path>`,
`--policy <path>`, `--report-level <severity>`, `--fail-level <severity>`,
`--network off|registry`,
`--trusted-registry <host>` (repeatable, extends the trusted-host list),
`--rule <id...>` (audit: run only the named rule(s); repeatable or
comma-separated; unknown ids error out — see `rules` for valid ids),
`--fail-on <id...>` (audit: exit non-zero only when one of these rules has a
finding — the report stays full; for CI gating),
`--require-complete` (audit/report: fail when git-backed checks or explicitly
requested registry checks cannot obtain their required evidence),
`--verbose` (audit/report: also emit the `SKIP:` records for rules that did
not apply, suppressed by default).

Exit codes: `0` on success/no findings, `1` on findings or errors during fix,
`2` on usage error.

## What to do when invoked

1. **Identify the project.** Default is the current working directory. If the
   user named a path, pass it via `--cwd`. The CLI auto-detects the package
   manager from `packageManager` field, lockfile presence, and yarn-classic /
   berry markers. If Yarn or Bun is detected, stop and report that the current
   version cannot complete the audit; do not override it to npm or pnpm.

2. **Pick the right command.**
   - "audit / scan / check / review" → `audit`
   - "plan this fix" → `plan --finding=<id> --output=deps-warden-plan.json`
   - "validate this plan" → `apply deps-warden-plan.json`
   - "apply this reviewed plan" → `apply deps-warden-plan.json --write`
   - "create / validate policy" → `policy init` / `policy validate`
   - "what rules do you check?" → `rules`
   - "scan this GitHub organization" → `github-scan <org> --format=json`

   If a deps-warden MCP server is available, call `github_org_scan` to start a
   durable task, poll `github_org_scan_status`, and page the completed result
   with `github_org_report`; use `supply_chain_check_catalog` when the user asks
   what is mandatory. Never pass a token in tool arguments—the server reads it
   from its process environment.

3. **Scan organizations without leaking credentials.** Prefer built-in GitHub
   App authentication via `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and
   `GITHUB_APP_PRIVATE_KEY_PATH`; a static `GITHUB_TOKEN`/`GH_TOKEN` takes
   precedence. Never print, persist, or place credentials in a report. Request
   repository Metadata, Contents, and Administration read plus organization
   Administration read for Actions policy. Obtaining the security settings
   block also requires an organization owner or security-manager role. For a
   large org, keep bounded concurrency, enable `--wait-for-rate-limit`, and
   rely on Git-tree caching and durable checkpoints. Treat a
   repository with `unknown`, `skipped`, truncated-tree, API-permission, or
   rate-limit evidence as incomplete—not compliant. If authenticated private
   repository counts are unavailable, require `--expected-repos=<count>` so a
   partially installed token cannot masquerade as full coverage. Use `--repo` for a small
   pilot before a first 1,000+ repository rollout. The scanner fetches bounded
   evidence files and targeted subtrees when needed; it does not clone or run
   repository code. Nested-only Node projects are valid monorepo evidence.

4. **Choose governance and outputs explicitly.** Use `--profile=baseline` by
   default and `--profile=strict` only when stricter optional evidence should
   gate. Supply accepted risks through an external `--exceptions=<path>` file;
   require an exact repository/check, owner, reason, approval, and RFC 3339 UTC
   expiry. Never invent or auto-approve an exception. `--output-path` implies
   file output. Use `--artifacts-dir` to stage canonical JSON, SARIF, HTML, CSV,
   and a digest manifest from one scan; use `--baseline-report` for a diff.

5. **Plan before applying.** Create a JSON plan for a fixable finding and
   inspect its relative paths, hashes, summaries, and redacted diffs. Run
   `apply <plan>` without `--write` to validate it. Never pass `--write` unless
   the user explicitly says apply / write / commit / mutate.

6. **Preserve trust decisions.** Never automatically approve a lifecycle
   script, add a trusted registry, or suppress a finding. Show the evidence and
   require the user to make that decision explicitly.

7. **Migrate npm without weakening v12 defaults.** If npm is older than 11.16,
   recommend moving to a supported Node.js release. Prefer a pinned reviewed npm
   12 release when the runtime is compatible; otherwise use 11.16+ only as a
   transitional client with explicit fail-closed settings. Use the
   `npm-version-supported` fix to record the migration floor; do not install npm
   on the user's behalf. Review `npm approve-scripts --allow-scripts-pending`.
   Never respond to npm 12
   breakage by setting `dangerously-allow-all-scripts=true`, `allow-git=all`, or
   `allow-remote=all`. Prefer replacing Git/URL sources with registry artifacts;
   use a manually reviewed `root` exception only when indispensable.

8. **Read the output.** Prefer JSON. Organization JSON uses
   `deps-warden-org-report/v1`; inspect `scope`, `coverage`, `api`, every
   repository `status`/`evidence`, and mandatory check statuses before making
   a compliance claim. When consuming project-audit TOON, each line is a record:
   - `PM: kind=<pm> version=<v> lockfile=<path> source=<packageManager|lockfile|override|default>`
   - `FILTER: rules=<csv>` — present only with `--rule`; the audit ran just these rules (so a clean result reflects limited scope)
   - `FINDING: id=<10-char-hex> type=<rule> sev=<critical|high|medium|low> fix=<auto|manual> line=<n> file=<path> ...`
   - `FIX: id=<finding-id> rule=<rule-id> sev=<sev> proposals=<n> dryRun=<bool>`
   - `PROPOSAL: file=<path> summary=<text> before=<bytes> after=<bytes> written=<bool>`
   - `DIFF: file=<path> hunks=<n>` (followed by the unified diff in text/toon modes)
   - `IGNORED: rule=<rule-id> id=<finding-id> matchedBy=<rule|id> source=ignore-file` — a finding suppressed by `.deps-warden-ignore`
   - `SKIP: rule=<rule-id> reason=<why>` — a rule that did not apply (e.g. `pm-not-pnpm`, `check-versions-off`); **shown only with `--verbose`**. The count is always in `SUMMARY`'s `skipped=<n>`.
   - `SUMMARY: findings=<n> critical=<n> high=<n> medium=<n> low=<n> ignored=<n> skipped=<n>`
   - `GATE: fail_on=<csv> triggered_by=<csv> result=<pass|fail>` — present only with `--fail-on`; `STATUS`/exit reflect this gate (non-gating findings are reported but don't fail the build)
   - `HINT: plan=<example command> validate=<command> auto_fixable=<n> manual=<n> ...` — only when there are findings; the next-step guide
   - `STATUS: OK` or `STATUS: FAIL` on the last line.

   Every `id` is stable — pass it to `plan --finding=<id>` to plan just that
   one change. `fix=auto` findings can be planned; `fix=manual`
   findings (e.g. `recommend-stricter-pm`, the version rules) need a hand edit —
   the `explain=` hint on each `FINDING:` record describes the remediation.

9. **Explain findings clearly.** Reference each finding by file and line. Each
   `FINDING:` record carries an `explain=` remediation hint by default; pass
   `--no-explain` to drop it for terser output.

10. **Re-audit after mutation.** After an authorized `apply --write`, run the
   same audit again and report remaining findings and any coverage limitations.

## Audit rules

| id | severity | applies to | catches |
|---|---|---|---|
| `lockfile-present` | critical | all | no lockfile in project root |
| `config-files-valid` | critical | all | malformed package manifest, lockfile, `.npmrc`, or pnpm workspace config |
| `github-actions-immutable` | high | repositories with workflows or composite actions | mutable workflow-step, reusable-workflow job, or composite-action refs; malformed YAML; delegates parsing/classification to pinned `actions-warden` |
| `lockfile-committed` | critical | all (when `.git/index` readable) | lockfile not tracked in git |
| `single-package-manager` | high | all (when >1 lockfile present) | multiple PM lockfiles coexist |
| `no-committed-auth` | critical | all (when `.git/index` readable) | literal auth token in tracked config |
| `trusted-registry` | high | all | registry not in known-good host list |
| `direct-deps-exact` | high | all workspaces | mutable registry ranges/tags in dependencies, devDependencies, or optionalDependencies |
| `package-manager-pinned` | high | all | missing, unsupported, or non-exact `packageManager` declaration |
| `node-engines-pinned` | medium | all (per workspace) | `engines.node` missing from package.json |
| `min-release-age` | high | npm, pnpm | release-age window unset (npm days / pnpm minutes) — allows freshly-published, possibly malicious versions |
| `npm-ignore-scripts` | high | npm before v12 | neither `ignore-scripts=true` nor a fail-closed native script policy is active |
| `npm-save-exact` | medium | npm | `save-exact=true` not set |
| `npm-package-lock` | high | npm | `package-lock=false` disables lockfile |
| `npm-allow-scripts` | medium (low when blocked) | npm (npm 11.16+) | install-script deps (whole tree, read from the lockfile) not covered by an explicit native `allowScripts` decision |
| `npm-version-supported` | high | npm | the detected npm lacks one or more controls introduced across npm 11.10–11.16; fix records `engines.npm` and enforced `devEngines.packageManager` |
| `npm-v12-source-controls` | high | npm | `allow-git` / `allow-remote` permit broad dependency fetching or will block a known source after the v12 migration |
| `npm-dangerous-script-bypass` | critical | npm | `dangerously-allow-all-scripts=true` bypasses every native script decision |
| `pnpm-version-supported` | high | pnpm | pnpm version unknown or older than the current `allowBuilds` schema |
| `pnpm-allow-builds` | high | pnpm | current `allowBuilds` decision map missing/invalid or legacy settings remain |
| `pnpm-strict-dep-builds` | high | pnpm | `strictDepBuilds: true` not set |
| `pnpm-dangerous-build-bypass` | critical | pnpm | `dangerouslyAllowAllBuilds=true` grants every dependency build execution |
| `pnpm-release-age-strict` | high | pnpm | release-age fallbacks or missing publish timestamps can bypass the age policy |
| `pnpm-resolution-integrity` | high | pnpm | lockfile verification or exotic transitive-source blocking is explicitly weakened |
| `pnpmfile-execution` | high | pnpm | `.pnpmfile.mjs` executes outside dependency lifecycle-script controls |
| `direct-deps-with-scripts` | low | npm, pnpm (per workspace, needs node_modules) | direct deps with lifecycle scripts |
| `unused-allowlist-entries` | medium | pnpm (needs node_modules) | allowlist entries with no current scripts (dormant trust) |
| `recommend-stricter-pm` | low | npm | a stricter install-script posture may be appropriate (no fix) |
| `outdated-major-deps` | low | npm, pnpm (needs `--check-versions` + node_modules) | direct dep ≥1 major behind registry `latest` |
| `deprecated-dep-version` | medium | npm, pnpm (needs `--check-versions` + node_modules) | installed version flagged deprecated/yanked on the registry |
| `dep-below-release-age` | high | npm, pnpm (needs `--check-versions` + node_modules) | installed version published inside the minimum-release-age window |

## Inline ignore directives

To silence a finding without changing the config, add a comment:

```ini
ignore-scripts=false  # deps-warden-ignore: npm-ignore-scripts
```

Other forms: `# deps-warden-ignore-file`, `# deps-warden-ignore-start`/`-end`,
`# deps-warden-ignore-next-line`. Bare directive silences all rules;
`# deps-warden-ignore: a,b,c` silences only the listed rule ids. Short form
`# dw-ignore` is accepted too.

## Project ignore file (`.deps-warden-ignore`)

Inline directives only work in config files that allow comments, so they cannot
silence findings on `package.json` (JSON), such as `recommend-stricter-pm` or
`node-engines-pinned`. For those — and as one committed, auditable record of the
risks a project has consciously accepted — add a `.deps-warden-ignore` file at
the project root (gitignore-style):

```
# staying on npm by team decision, 2026-05
recommend-stricter-pm

fff769fa22            # accept one specific finding by its id
```

One entry per line; `#` starts a comment; blanks are skipped; entries may be
comma/space separated. An entry is either a **rule id** (suppresses every
finding of that rule) or a **10-char finding id** (suppresses that one finding,
leaving the rule active elsewhere). Suppressed findings are dropped from the
`SUMMARY` counts and do not affect the exit code, but each is still reported as
an `IGNORED:` record so the suppression stays visible. Commit this file so the
policy travels with the repo.

## Programmatic API (no subprocess)

When you want to consume results in JS without spawning the CLI:

```js
import { audit, fix, listRules } from 'deps-warden';

const result = await audit({ cwd: '/repo', explain: true });
// result.pm:       { kind, version, lockfile, source, multipleLockfiles }
// result.findings: [{ id, ruleId, severity, file, line, fields, explain }]
// result.summary:  { findings, critical, high, medium, low }
// result.status:   'OK' | 'FAIL'
```

Other exports: `renderAudit`, `renderFix`, `renderRules`, `buildContext`,
`detectPm`, `selectAdapter`, `format`, `unifiedDiff`, `redact`,
`parseIgnoreDirectives`, `scanGitHubOrganization`, `renderOrgReport`,
`createGitHubClient`, `createGitHubAppTokenProvider`, `createScanJobManager`,
`createScanHttpServer`, `diffOrgReports`, and `writeOrgArtifactBundle`.

## Notes

- The CLI **never prompts interactively** — all decisions are flag-driven,
  safe to invoke without a TTY.
- **No subprocess execution.** deps-warden never spawns `npm`, `pnpm`, `yarn`,
  or `bun`. Input is files, plus a single read-only environment variable
  (`npm_config_user_agent`, used by `npm-version-supported` to read the npm
  version when run via `npx`/`npm`).
- **GitHub workflow parsing is delegated.** The `github-actions-immutable` rule
  invokes the exact `actions-warden` discovery/parser API in-process, retains
  deps-warden's own suppression semantics, covers workflow steps, reusable
  workflow jobs, and nested composite-action dependencies, and never invokes
  actions-warden's networked pin or upgrade operations.
- **No network in the default project audit.** Optional `--check-versions` is
  the only audit flag that reaches the registry. It enables the `outdated-major-deps`,
  `deprecated-dep-version`, and `dep-below-release-age` rules, which read each
  direct dependency's installed version and cross-reference the npm registry.
  Responses are cached under `.deps-warden-cache/`. Any network failure
  (offline, timeout, non-2xx) is reported as a `NOTE` and the rest of the audit
  still runs. It is non-gating by default, but fails the audit when
  `--require-complete` or `scan.requireComplete: true` is active.
- **GitHub org scans are explicitly networked and read-only.** `github-scan`
  paginates all selected repositories, bounds concurrency, preserves a primary
  rate-limit reserve, caches derived code checks by tree SHA, and checkpoints
  completed repositories for interrupted scans. It never executes repository
  code or caches source blobs. Repository and organization settings remain
  uncached. Use `--wait-for-rate-limit` for first scans.
- **MCP output is bounded.** `deps-warden-mcp` uses the official stdio server
  SDK. Starting a scan returns a task id immediately; poll status and page at
  most 100 repository records per follow-up call. Credentials are
  environment-only and never part of a tool schema.
- **HTTP jobs are bounded and authenticated.** `deps-warden-http` accepts a
  bearer token from server configuration. Scan requests cannot override
  credentials, filesystem paths, API URLs, or webhook destinations. Optional
  completion webhooks use a fixed HTTPS URL and HMAC-SHA256 signature.
- Output is **deterministic**: running twice on an unchanged project produces
  identical bytes. Finding IDs are stable across runs.
- Secrets in output are **redacted** through `<redacted>` substitution.
- **CI gating.** A GitHub Action ships at the repo root (`uses: chiz0me/deps-warden@<sha>`,
  inputs: `fail-on`, `rules`, `severity`, `report-level`, `fail-level`,
  `require-complete`, `check-versions`, `version`,
  `working-directory`). It runs `audit`, writes the report to the job summary,
  and fails the job only on `fail-on` rules. Equivalent to
  `npx deps-warden audit --fail-on <ids>`.

## Mandatory baseline

When the user asks for a mandatory or production gate, follow
`docs/SUPPLY_CHAIN_BASELINE.md`, use a committed policy with
`scan.requireComplete: true`, and do not describe missing evidence as clean.
The checklist also contains platform controls—branch/review policy, immutable
CI actions, vulnerability review, OIDC publishing, provenance, and SBOMs—that
cannot be proven by package-manager configuration alone. A zero-exit audit is
not, on its own, proof that the entire baseline is satisfied.

## Scope

This release covers npm and pnpm with the `audit`, `fix`, `scripts`, `init`,
`report`, `rules`, and `github-scan` commands. Workspace discovery (pnpm `packages:` field
and npm `workspaces` field) walks per-workspace package.json files for the
`node-engines-pinned`, `direct-deps-exact`, and `direct-deps-with-scripts`
rules. Registry-driven
rules (`outdated-major-deps`, `deprecated-dep-version`, `dep-below-release-age`)
run behind the opt-in `--check-versions` flag. yarn-classic / yarn-berry / bun
adapters are not yet implemented but are stubbed in the CLI.

## Source

- npm: https://www.npmjs.com/package/deps-warden
- repo: https://github.com/chiz0me/deps-warden
