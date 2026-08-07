/** Deterministic comparison of two canonical organization reports. */

import { ORG_REPORT_SCHEMA } from './orgReport.js';

export const ORG_REPORT_DIFF_SCHEMA = 'deps-warden-org-report-diff/v1';

export function diffOrgReports(previous, current) {
  validate(previous, 'previous');
  validate(current, 'current');
  if (previous.organization !== current.organization) throw new Error('organization reports must describe the same organization');
  const previousRepositories = new Map(previous.repositories.map(item => [item.name, item]));
  const currentRepositories = new Map(current.repositories.map(item => [item.name, item]));
  const repositoryAdded = [...currentRepositories.keys()].filter(name => !previousRepositories.has(name)).toSorted();
  const repositoryRemoved = [...previousRepositories.keys()].filter(name => !currentRepositories.has(name)).toSorted();
  const repositoryStatusChanged = [...currentRepositories.entries()]
    .filter(([name, repository]) => previousRepositories.has(name) && previousRepositories.get(name).status !== repository.status)
    .map(([repository, item]) => ({ repository, from: previousRepositories.get(repository).status, to: item.status }))
    .toSorted(compareScope);
  const previousChecks = checkMap(previous);
  const currentChecks = checkMap(current);
  const keys = [...new Set([...previousChecks.keys(), ...currentChecks.keys()])].toSorted();
  const checkStatusChanged = keys
    .filter(key => previousChecks.get(key)?.status !== currentChecks.get(key)?.status)
    .map(key => {
      const [scope, ...idParts] = key.split('\0');
      return { scope, check: idParts.join('\0'), from: previousChecks.get(key)?.status ?? 'missing', to: currentChecks.get(key)?.status ?? 'missing' };
    });
  const newFailures = checkStatusChanged.filter(item => item.to === 'fail' && item.from !== 'fail');
  const resolvedFailures = checkStatusChanged.filter(item => item.from === 'fail' && item.to !== 'fail');
  return {
    schema: ORG_REPORT_DIFF_SCHEMA,
    organization: current.organization,
    previousGeneratedAt: previous.generatedAt,
    currentGeneratedAt: current.generatedAt,
    summary: {
      repositoriesAdded: repositoryAdded.length,
      repositoriesRemoved: repositoryRemoved.length,
      repositoryStatusChanges: repositoryStatusChanged.length,
      changedChecks: checkStatusChanged.length,
      newFailures: newFailures.length,
      resolvedFailures: resolvedFailures.length,
    },
    repositoryAdded,
    repositoryRemoved,
    repositoryStatusChanged,
    checkStatusChanged,
    newFailures,
    resolvedFailures,
  };
}

function checkMap(report) {
  const entries = report.organizationChecks.map(item => [`@organization\0${item.id}`, item]);
  for (const repository of report.repositories) {
    for (const check of repository.checks) entries.push([`${repository.name}\0${check.id}`, check]);
  }
  return new Map(entries);
}

function validate(report, label) {
  if (!report || report.schema !== ORG_REPORT_SCHEMA || !Array.isArray(report.repositories) || !Array.isArray(report.organizationChecks)) {
    throw new Error(`${label} report must use schema ${ORG_REPORT_SCHEMA}`);
  }
}

function compareScope(left, right) {
  return left.repository.localeCompare(right.repository);
}
