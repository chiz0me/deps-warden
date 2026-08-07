# Security Policy

## Reporting a vulnerability

Please **do not** open public issues for security-sensitive reports. Send the
details to the maintainers via one of:

- GitHub Security Advisory: open a private advisory on this repository.
- Email: see the maintainer profile linked from `package.json`.

Please include:

- A clear description of the issue.
- A minimal reproduction (config files, command line, expected vs. actual).
- The version of `deps-warden` (`npx deps-warden --version`).
- Any disclosure constraints on your side.

We aim to acknowledge within **3 business days** and to ship a fix or a
documented mitigation within **30 days** of triage for high-severity issues.

## Scope

In scope:

- Path traversal or arbitrary file write in `fix`, `scripts`, or `init`.
- Bypasses of the `--dry-run` guard.
- Logging or persisting credentials anywhere (cache, output, stderr).
- Parser crashes on attacker-controlled config files (`.npmrc`, `package.json`,
  `pnpm-workspace.yaml`, `.yarnrc.yml`, `bunfig.toml`).
- Any network request sent without the user opting in via `--check-versions`.

Out of scope:

- Findings produced by audit rules themselves (those describe misconfigurations
  in users' projects, not in `deps-warden`).
- Outdated transitive dependencies of `deps-warden` that do not reach our code paths.

## Supply chain

The mandatory project baseline is maintained in
[`docs/SUPPLY_CHAIN_BASELINE.md`](./docs/SUPPLY_CHAIN_BASELINE.md).

GitHub workflow action-reference parsing is supplied by the exact
`actions-warden` dependency. deps-warden uses only its read-only programmatic
audit API; tag resolution and workflow mutation are not part of an audit.

- All runtime dependencies are pinned to exact versions (`save-exact=true`).
- `ignore-scripts=true` in `.npmrc` to disable arbitrary postinstall scripts.
- CI runs `npm audit --audit-level=high` on every PR.
- `publishConfig.provenance=true` requests npm provenance. A release must also
  use an npm trusted publisher/OIDC workflow before claiming the release
  controls in the mandatory baseline.
- `npm run release:verify` is the explicit pre-release verification command;
  it does not rely on lifecycle hooks disabled by `ignore-scripts=true`.
- Zero subprocess execution: `deps-warden` never spawns `npm`, `pnpm`, `yarn`, or `bun`.
- Zero network in default operation: only `--check-versions` (opt-in) reaches the registry.

## Responsible-disclosure timeline

| event | target |
|---|---|
| Acknowledgement | 3 business days |
| Triage + severity rating | 7 days |
| Fix or mitigation for critical/high | 30 days |
| Public disclosure | by mutual agreement, default 90 days |
