/**
 * Rule registry.
 *
 * Order is significant only for output stability: the audit command lists
 * findings in the same order as RULES.
 */

import * as lockfilePresent from './lockfile-present.js';
import * as configFilesValid from './config-files-valid.js';
import * as githubActionsImmutable from './github-actions-immutable.js';
import * as lockfileCommitted from './lockfile-committed.js';
import * as singlePackageManager from './single-package-manager.js';
import * as noCommittedAuth from './no-committed-auth.js';
import * as trustedRegistry from './trusted-registry.js';
import * as directDepsExact from './direct-deps-exact.js';
import * as packageManagerPinned from './package-manager-pinned.js';
import * as nodeEnginesPinned from './node-engines-pinned.js';
import * as minReleaseAge from './min-release-age.js';
import * as npmIgnoreScripts from './npm-ignore-scripts.js';
import * as npmSaveExact from './npm-save-exact.js';
import * as npmPackageLock from './npm-package-lock.js';
import * as npmAllowScripts from './npm-allow-scripts.js';
import * as npmVersionSupported from './npm-version-supported.js';
import * as npmV12SourceControls from './npm-v12-source-controls.js';
import * as npmDangerousScriptBypass from './npm-dangerous-script-bypass.js';
import * as pnpmAllowBuilds from './pnpm-allow-builds.js';
import * as pnpmStrictDepBuilds from './pnpm-strict-dep-builds.js';
import * as pnpmDangerousBuildBypass from './pnpm-dangerous-build-bypass.js';
import * as pnpmVersionSupported from './pnpm-version-supported.js';
import * as pnpmReleaseAgeStrict from './pnpm-release-age-strict.js';
import * as pnpmResolutionIntegrity from './pnpm-resolution-integrity.js';
import * as pnpmfileExecution from './pnpmfile-execution.js';
import * as directDepsWithScripts from './direct-deps-with-scripts.js';
import * as unusedAllowlistEntries from './unused-allowlist-entries.js';
import * as recommendStricterPm from './recommend-stricter-pm.js';
import * as outdatedMajorDeps from './outdated-major-deps.js';
import * as deprecatedDepVersion from './deprecated-dep-version.js';
import * as depBelowReleaseAge from './dep-below-release-age.js';

export const RULES = [
  lockfilePresent,
  configFilesValid,
  githubActionsImmutable,
  lockfileCommitted,
  singlePackageManager,
  noCommittedAuth,
  trustedRegistry,
  directDepsExact,
  packageManagerPinned,
  nodeEnginesPinned,
  minReleaseAge,
  npmIgnoreScripts,
  npmSaveExact,
  npmPackageLock,
  npmAllowScripts,
  npmVersionSupported,
  npmV12SourceControls,
  npmDangerousScriptBypass,
  pnpmVersionSupported,
  pnpmAllowBuilds,
  pnpmStrictDepBuilds,
  pnpmDangerousBuildBypass,
  pnpmReleaseAgeStrict,
  pnpmResolutionIntegrity,
  pnpmfileExecution,
  directDepsWithScripts,
  unusedAllowlistEntries,
  recommendStricterPm,
  outdatedMajorDeps,
  deprecatedDepVersion,
  depBelowReleaseAge,
];

export function listRules() {
  return RULES.map(r => ({
    id: r.id,
    severity: r.severity,
    description: r.description,
  }));
}
