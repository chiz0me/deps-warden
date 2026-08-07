/**
 * Registry dependencies in project manifests must use exact versions.
 *
 * Peer dependencies intentionally express compatibility ranges and are not
 * installation selections, so this rule covers dependencies,
 * devDependencies, and optionalDependencies only. Local/workspace protocols
 * are resolved from reviewed repository content rather than a registry.
 */

import { join } from 'node:path';
import semver from 'semver';

export const id = 'direct-deps-exact';
export const severity = 'high';
export const description = 'A direct registry dependency is declared with a mutable version range or tag.';

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const LOCAL_PROTOCOL_RE = /^(?:workspace|file|link|portal|catalog):/;
const NON_REGISTRY_RE = /^(?:git(?:\+[a-z]+)?:|git@|ssh:|https?:|github:|gitlab:|bitbucket:)/i;

export function appliesTo(ctx) {
  return (ctx.workspaces ?? []).some(workspace => workspace.pkg?.raw);
}

export async function check(ctx) {
  const findings = [];
  for (const workspace of ctx.workspaces ?? []) {
    if (!workspace.pkg?.raw) continue;
    for (const section of SECTIONS) {
      const declarations = workspace.pkg.raw[section];
      if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations)) continue;
      for (const [name, declared] of Object.entries(declarations)) {
        if (typeof declared !== 'string' || isExactOrNonRegistry(declared)) continue;
        findings.push({
          severity,
          file: join(workspace.path, 'package.json'),
          line: dependencyLine(workspace.pkg.source, name, declared)
            || workspace.pkg.topLevelLines.get(section)
            || 0,
          fields: {
            type: id,
            sev: severity,
            workspace: workspace.relative,
            section,
            dependency: name,
            declared,
          },
          explain: `replace ${name}@${declared} with the exact reviewed registry version recorded in the lockfile`,
        });
      }
    }
  }
  return findings;
}

function isExactOrNonRegistry(declared) {
  if (LOCAL_PROTOCOL_RE.test(declared) || NON_REGISTRY_RE.test(declared)) return true;
  if (semver.valid(declared) !== null) return true;
  if (!declared.startsWith('npm:')) return false;
  const separator = declared.lastIndexOf('@');
  return separator > 4 && semver.valid(declared.slice(separator + 1)) !== null;
}

function dependencyLine(source, name, declared) {
  const nameLiteral = JSON.stringify(name);
  const declaredLiteral = JSON.stringify(declared);
  const lines = source.split(/\r?\n/);
  const index = lines.findIndex(line => line.includes(nameLiteral) && line.includes(declaredLiteral));
  return index === -1 ? 0 : index + 1;
}

export function explain() {
  return 'save-exact controls future package-manager writes but does not repair '
       + 'existing ranges. Exact manifest versions make dependency changes explicit '
       + 'and reviewable; the lockfile still provides transitive integrity.';
}
