/**
 * Prepare npm projects for v12's fail-closed Git and remote URL defaults.
 *
 * npm 11 still defaults both controls to `all`. We recommend an explicit
 * `none` so the policy is enforced before the upgrade and remains visible in
 * version control. A project that intentionally declares one of these sources
 * may choose `root` after review; deps-warden never grants that trust itself.
 */

import { join, relative } from 'node:path';
import semver from 'semver';

export const id = 'npm-v12-source-controls';
export const severity = 'high';
export const description = 'Git or remote URL dependency fetching is not explicitly restricted for npm v12 readiness.';

const CONTROLS = [
  { config: 'allow-git', type: 'git', since: '11.10.0' },
  { config: 'allow-remote', type: 'remote', since: '11.15.0' },
];

export function appliesTo(ctx) {
  return ctx.pm.kind === 'npm' && ctx.pkg !== null && ctx.pkg.raw !== null;
}

export async function check(ctx) {
  const sources = await collectDependencySources(ctx);
  const findings = [];
  const declaredNpm = ctx.pm.source === 'packageManager' && ctx.pm.version
    ? semver.coerce(ctx.pm.version)
    : null;
  const npmV12Defaults = declaredNpm && semver.gte(declaredNpm, '12.0.0');

  for (const control of CONTROLS) {
    const hit = await ctx.pm.adapter.getConfig(ctx, control.config);
    const matching = sources.filter(source => source.type === control.type);
    const transitive = matching.filter(source => source.transitive);

    if (hit.value === 'none') continue;
    if (hit.value === undefined && npmV12Defaults) continue;
    if (hit.value === 'root' && transitive.length === 0) continue;

    const current = String(hit.value ?? 'unset');
    const labels = [...new Set(matching.map(source => source.label))];
    const compatibilityOnly = hit.value === 'root' && transitive.length > 0;
    const findingSeverity = compatibilityOnly ? 'medium' : severity;
    const file = hit.source?.file ?? join(ctx.cwd, '.npmrc');

    findings.push({
      severity: findingSeverity,
      file,
      line: hit.source?.line ?? 0,
      fields: {
        type: id,
        sev: findingSeverity,
        control: control.config,
        current,
        available_since: control.since,
        dependency_count: labels.length,
        transitive: transitive.length,
        dependencies: labels.join(','),
        file: relative(ctx.cwd, file),
      },
      explain: sourceControlRemediation(control.config, current, labels, transitive.length),
    });
  }

  return findings;
}

export async function fix(ctx, finding) {
  const control = finding?.fields?.control;
  if (!CONTROLS.some(item => item.config === control)) {
    throw new Error(`unsupported npm source control: ${String(control)}`);
  }
  return [await ctx.pm.adapter.setConfig(ctx, control, 'none')];
}

function sourceControlRemediation(control, current, labels, transitiveCount) {
  if (current === 'root' && transitiveCount > 0) {
    return `${control}=root will block ${transitiveCount} transitive source(s) under npm v12; replace the upstream Git/URL dependency with a registry-published artifact before upgrading`;
  }
  if (labels.length > 0) {
    return `review ${labels.join(', ')} and prefer integrity-locked registry packages; the safe fix sets ${control}=none and may intentionally break those dependencies. If they are indispensable, set ${control}=root manually after review, never all`;
  }
  return `set ${control}=none now; npm v12 makes this the default, and an explicit project policy also protects installs still using npm 11`;
}

/**
 * Collect package.json dependency specs across workspaces plus Git resolutions
 * in package-lock.json. Remote lockfile URLs are deliberately not inferred:
 * registry tarballs are also HTTPS URLs, so doing so would create false alarms.
 */
export async function collectDependencySources(ctx) {
  const out = [];
  const directGitNames = new Set();
  for (const workspace of ctx.workspaces ?? []) {
    const raw = workspace.pkg?.raw;
    if (!raw) continue;
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = raw[section];
      if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
      for (const [name, spec] of Object.entries(deps)) {
        const type = dependencySourceType(spec);
        if (!type) continue;
        const prefix = workspace.relative === '.' ? '' : `${workspace.relative}:`;
        out.push({ type, label: `${prefix}${name}`, spec: String(spec), transitive: false });
        if (type === 'git') directGitNames.add(name);
      }
    }
  }

  if (ctx.pm.lockfile) {
    const source = await ctx.readText(ctx.pm.lockfile);
    for (const entry of parseLockfileGitSources(source, directGitNames)) out.push(entry);
  }
  return dedupeSources(out);
}

export function dependencySourceType(spec) {
  if (typeof spec !== 'string') return null;
  const value = spec.trim();
  if (/^(?:git(?:\+[a-z]+)?:|git@|ssh:|github:|gitlab:|bitbucket:)/i.test(value)) return 'git';
  if (/^https?:\/\/[^\s]+\.git(?:#.*)?$/i.test(value)) return 'git';
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(value)) return 'git';
  if (/^https?:\/\//i.test(value)) return 'remote';
  return null;
}

function parseLockfileGitSources(source, directGitNames) {
  if (!source) return [];
  let lock;
  try { lock = JSON.parse(source); } catch { return []; }
  if (!lock?.packages || typeof lock.packages !== 'object') return [];
  const out = [];
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (!path || !pkg || typeof pkg !== 'object' || pkg.link) continue;
    if (dependencySourceType(pkg.resolved) !== 'git') continue;
    const name = packageNameFromLockPath(path);
    out.push({
      type: 'git',
      label: name,
      spec: String(pkg.resolved),
      transitive: !directGitNames.has(name),
    });
  }
  return out;
}

function packageNameFromLockPath(path) {
  const parts = path.split('node_modules/').filter(Boolean);
  return parts.at(-1) ?? path;
}

function dedupeSources(sources) {
  const seen = new Set();
  return sources.filter(source => {
    const key = `${source.type}\0${source.label}\0${source.spec}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function explain() {
  return 'npm v12 changes allow-git and allow-remote from automatic fetching to '
       + 'explicit opt-in. Set both to none wherever possible. Replace Git and '
       + 'URL tarball dependencies with registry-published, integrity-locked '
       + 'artifacts; use root only for a reviewed direct exception and never '
       + 'grant all merely to make an upgrade pass.';
}
