/** Organization scan profiles and externally governed accepted-risk records. */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import YAML from 'yaml';

export const ORG_POLICY_PROFILES = Object.freeze(['baseline', 'strict']);
export const ORG_EXCEPTIONS_VERSION = 1;

const STRICT_MANDATORY = new Set([
  'github/advanced-security',
  'deps/outdated-major-deps',
  'deps/deprecated-dep-version',
  'deps/dep-below-release-age',
]);

export function isMandatoryInOrgProfile(id, baselineMandatory, profile) {
  if (!ORG_POLICY_PROFILES.includes(profile)) throw new Error(`unknown organization policy profile: ${profile}`);
  return baselineMandatory || (profile === 'strict' && STRICT_MANDATORY.has(id));
}

export async function loadGovernedExceptions({ cwd = process.cwd(), path } = {}) {
  if (!path) return [];
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  let source;
  try { source = await readFile(absolute, 'utf8'); }
  catch (error) { throw new Error(`cannot read organization exception file ${absolute}: ${error.message}`, { cause: error }); }
  return parseGovernedExceptions(source, absolute);
}

export function parseGovernedExceptions(source, sourceName = '<organization-exceptions>') {
  const document = YAML.parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`invalid exception YAML in ${sourceName}: ${document.errors[0].message}`);
  let raw;
  try { raw = document.toJS({ maxAliasCount: 20 }); }
  catch (error) { throw new Error(`invalid exception YAML in ${sourceName}: ${error.message}`, { cause: error }); }
  return validateGovernedExceptions(raw, sourceName);
}

export function validateGovernedExceptions(raw, sourceName = '<organization-exceptions>') {
  assertMapping(raw, sourceName);
  assertKnownKeys(raw, ['version', 'exceptions'], sourceName);
  if (raw.version !== ORG_EXCEPTIONS_VERSION) {
    throw new Error(`${sourceName}: unsupported exception version ${String(raw.version)}; expected ${ORG_EXCEPTIONS_VERSION}`);
  }
  if (!Array.isArray(raw.exceptions)) throw new Error(`${sourceName}.exceptions must be an array`);
  const seen = new Set();
  return raw.exceptions.map((item, index) => {
    const path = `${sourceName}.exceptions[${index}]`;
    assertMapping(item, path);
    assertKnownKeys(item, ['repository', 'check', 'owner', 'reason', 'approval', 'expiresAt'], path);
    const exception = {
      repository: requiredString(item.repository, `${path}.repository`, 100),
      check: requiredString(item.check, `${path}.check`, 200),
      owner: requiredString(item.owner, `${path}.owner`, 200),
      reason: requiredString(item.reason, `${path}.reason`, 1_000),
      approval: requiredString(item.approval, `${path}.approval`, 500),
      expiresAt: requiredTimestamp(item.expiresAt, `${path}.expiresAt`),
    };
    const key = `${exception.repository}\0${exception.check}`;
    if (seen.has(key)) throw new Error(`${path} duplicates an exception for ${exception.repository}/${exception.check}`);
    seen.add(key);
    return exception;
  });
}

export function applyOrgPolicy({ organizationChecks, repositories, knownRepositories, profile = 'baseline', exceptions = [], now = new Date() }) {
  if (!ORG_POLICY_PROFILES.includes(profile)) throw new Error(`unknown organization policy profile: ${profile}`);
  const validatedExceptions = validateGovernedExceptions({ version: ORG_EXCEPTIONS_VERSION, exceptions });
  const indexed = new Map(validatedExceptions.map(item => [`${item.repository}\0${item.check}`, item]));
  const outcomes = [];
  const apply = (scope, item) => {
    const mandatory = isMandatoryInOrgProfile(item.id, item.mandatory !== false, profile);
    const normalized = { ...item, mandatory };
    const key = `${scope}\0${item.id}`;
    const exception = indexed.get(key);
    if (!exception) return normalized;
    indexed.delete(key);
    const expired = Date.parse(exception.expiresAt) <= now.getTime();
    const applicable = normalized.status === 'fail';
    outcomes.push({ ...exception, status: expired ? 'expired' : applicable ? 'accepted' : 'not_applicable' });
    const exceptionEvidence = {
      owner: exception.owner,
      reason: exception.reason,
      approval: exception.approval,
      expiresAt: exception.expiresAt,
      status: expired ? 'expired' : applicable ? 'accepted' : 'not_applicable',
    };
    return {
      ...normalized,
      status: !expired && applicable ? 'accepted' : normalized.status,
      reason: !expired && applicable ? 'governed-exception' : normalized.reason,
      evidence: mergeEvidence(normalized.evidence, { governedException: exceptionEvidence }),
    };
  };
  const transformedOrganizationChecks = organizationChecks.map(item => apply('@organization', item));
  const transformedRepositories = repositories.map(repository => ({
    ...repository,
    checks: repository.checks.map(item => apply(repository.name, item)),
  }));
  const known = new Set(knownRepositories ?? repositories.map(repository => repository.name));
  const outsideScope = [...indexed.values()].filter(item => item.repository !== '@organization' && known.has(item.repository));
  for (const item of outsideScope) {
    indexed.delete(`${item.repository}\0${item.check}`);
    outcomes.push({ ...item, status: 'outside_scope' });
  }
  if (indexed.size > 0) {
    const unmatched = [...indexed.values()].map(item => `${item.repository}/${item.check}`);
    throw new Error(`exception file contains unmatched scope/check entries: ${unmatched.join(', ')}`);
  }
  return {
    organizationChecks: transformedOrganizationChecks,
    repositories: transformedRepositories,
    exceptions: {
      total: outcomes.length,
      accepted: outcomes.filter(item => item.status === 'accepted').length,
      expired: outcomes.filter(item => item.status === 'expired').length,
      notApplicable: outcomes.filter(item => item.status === 'not_applicable').length,
      outsideScope: outcomes.filter(item => item.status === 'outside_scope').length,
      records: outcomes,
    },
  };
}

function mergeEvidence(evidence, extra) {
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) return { ...evidence, ...extra };
  return evidence === null || evidence === undefined ? extra : { original: evidence, ...extra };
}

function requiredString(value, path, maximum) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum || [...value].some(character => character.codePointAt(0) < 32)) {
    throw new Error(`${path} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value;
}

function requiredTimestamp(value, path) {
  const string = requiredString(value, path, 100);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(string)) {
    throw new Error(`${path} must be an RFC 3339 UTC timestamp`);
  }
  const timestamp = Date.parse(string);
  if (Number.isNaN(timestamp)) throw new Error(`${path} must be an RFC 3339 UTC timestamp`);
  return new Date(timestamp).toISOString();
}

function assertMapping(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be a mapping`);
}

function assertKnownKeys(value, allowed, path) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${path} contains unknown key(s): ${unknown.join(', ')}`);
}
