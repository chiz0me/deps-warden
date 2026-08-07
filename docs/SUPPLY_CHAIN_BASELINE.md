# Mandatory supply-chain baseline

This document defines `deps-warden-baseline/v1`. A project must satisfy every
mandatory control below before it can claim the baseline. An audit with missing
evidence is incomplete, not clean.

## Mandatory controls

- [ ] Security-relevant manifests, lockfiles, and package-manager configuration
  parse successfully.
- [ ] Node.js and the package manager are explicitly declared, supported, and
  mutually compatible.
- [ ] Exactly one package manager and one matching, committed lockfile are used.
- [ ] CI and deployment use a frozen install (`npm ci` or the package-manager
  equivalent) and never rewrite the lockfile.
- [ ] Dependency install scripts are denied by default. Every approval is an
  explicit, reviewed trust decision; dangerous allow-all bypasses are forbidden.
- [ ] Git, remote URL, and exotic transitive dependency sources are denied by
  default. Exceptions are direct, narrow, and reviewed.
- [ ] Every default, scoped, and named registry uses HTTPS, keeps TLS validation
  enabled, and appears in project policy.
- [ ] No literal package-registry credentials are committed. Publishing uses
  short-lived OIDC trusted publishing where the registry supports it.
- [ ] A fail-closed minimum release-age policy applies to direct and transitive
  dependencies. Exceptions identify exact packages or versions.
- [ ] Pull requests that change dependencies pass a vulnerability and dependency
  review gate. Required registry or advisory data must not soft-pass when absent.
- [ ] CI actions and reusable workflows are pinned to immutable commit SHAs and
  run with least-privilege token permissions.
- [ ] Releases are built in protected CI, publish provenance, and retain an SPDX
  or CycloneDX SBOM.
- [ ] Every accepted-risk suppression has a narrow scope, owner, reason, and
  expiry date. Expired suppressions fail CI.

## Checklist coverage

Passing `deps-warden audit --require-complete` is necessary for this baseline,
but it does not by itself prove platform controls that are outside the working
tree. Use the following coverage map when recording compliance:

| Control | deps-warden coverage |
|---|---|
| Config parsing, exact package-manager declaration, exact direct dependency declarations, one lockfile | Enforced by audit rules; commit state requires a readable git index. Peer dependency compatibility ranges and repository-local protocols are intentionally excluded from the exact-version rule. |
| Install-script decisions and dangerous bypasses | Enforced for supported npm and pnpm versions. Every positive approval still requires human review. |
| Git, URL, exotic, registry, TLS, and credential controls | Enforced for supported project configuration; organization-level registry/proxy settings require separate review. |
| Minimum release age | Configuration is enforced locally. Registry metadata checks require explicit network mode and complete-evidence gating. |
| Frozen CI install and vulnerability/dependency review | `github-scan` parses workflow and composite-action run steps and requires `npm ci`, pnpm `--frozen-lockfile`, Yarn `--immutable`/`--frozen-lockfile`, or Bun `--frozen-lockfile`. Repository users must separately configure vulnerability/dependency review as a required check. |
| Immutable GitHub Actions references and workflow risks | `github-scan` downloads workflows from the Git tree and applies `github-actions-immutable` plus pinned `actions-warden` checks for broad permissions, broadly-scoped secrets, script injection, and unsafe `pull_request_target` checkout. Malformed YAML fails closed. |
| Default-branch protection, secret scanning, push protection, Dependabot security updates | `github-scan` checks current GitHub repository metadata. Missing API permission or unavailable status is incomplete evidence, never a pass. |
| Protected releases, OIDC, provenance, SBOM retention | Verify in repository, registry, and CI platform settings. |
| Suppression owner, reason, approval, and expiry | `github-scan --exceptions=<external file>` validates exact scope, ownership, approval, and expiry. Expired, malformed, duplicate, or unmatched records fail closed; repository-owned suppressions cannot self-approve. |

## deps-warden gate

Commit a project policy with `scan.requireComplete: true`, report all findings,
and fail at `high` or above:

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

Run the local gate with:

```sh
node src/cli.js audit --require-complete
```

Collect the GitHub portion of the baseline with a GitHub App installation token
and retain the canonical JSON report:

```sh
GITHUB_TOKEN=... node src/cli.js github-scan example-org \
  --wait-for-rate-limit \
  --format=json \
  --output-path=org-report.json
```

For 1,000+ repositories, first pilot with `--repo <name...>`, then scan the
whole organization with caching enabled. Review `scope`, `coverage`, `api`, and
all mandatory checks; any `unknown`, `skipped`, truncated tree, or permission
gap keeps the repository incomplete.

The report policy is `deps-warden-github-scan/v1/baseline` (or `/strict`). Even
an `OK` organization scan does not replace the external release, registry,
provenance, and SBOM evidence required by this broader
`deps-warden-baseline/v1` checklist.

`requireComplete` additionally fails when git-backed checks cannot establish
whether a lockfile or credential-bearing config is committed, or when explicitly
requested registry checks cannot complete. Network-free configuration checks
remain the default; vulnerability scanning is a separate mandatory CI step.

Do not label a project baseline-compliant solely because the CLI exits zero.
Record the platform checks above as review evidence as well.

## Platform controls

Some controls still cannot be established from Git content or the read-only
repository and organization metadata used by the scanner. Administrators must
separately verify required reviewer counts and status checks, npm trusted
publishing, protected release environments/tags, attestations, and SBOM
retention.
