/**
 * Delegate GitHub Actions reference parsing to actions-warden.
 *
 * deps-warden owns baseline aggregation, suppressions, and finding identity;
 * actions-warden remains the source of truth for workflow discovery, YAML
 * parsing, and action-reference classification. This deliberately uses the
 * parser API rather than actions-warden's top-level audit so a suppression in
 * one product cannot become an invisible suppression in the other.
 */

import {
  collectUses,
  discoverWorkflows,
  parseWorkflowFile,
} from 'actions-warden';

export const id = 'github-actions-immutable';
export const severity = 'high';
export const description = 'External GitHub Action and reusable-workflow references are not pinned to immutable commit SHAs.';

const targetsByContext = new WeakMap();
const SHA_RE = /^[0-9a-f]{40}$/i;

export async function appliesTo(ctx) {
  const files = await discoverWorkflows({ cwd: ctx.cwd });
  targetsByContext.set(ctx, files);
  return files.length > 0;
}

export async function check(ctx) {
  const workflows = targetsByContext.get(ctx)
    ?? await discoverWorkflows({ cwd: ctx.cwd });
  const findings = [];
  for (const file of workflows) {
    let workflow;
    try {
      workflow = await parseWorkflowFile(file);
    } catch {
      findings.push(parseFailure(file));
      continue;
    }
    for (const { ref } of collectUses(workflow)) {
      if (ref.kind !== 'external' && ref.kind !== 'reusable-workflow') continue;
      if (ref.ref && SHA_RE.test(ref.ref)) continue;
      findings.push(mutableReference(file, ref));
    }
  }
  return findings;
}

function mutableReference(file, ref) {
  return {
    severity,
    file,
    line: ref.line,
    fields: {
      type: id,
      sev: severity,
      issue: 'unpinned-action',
      action: ref.raw,
      ref: ref.ref ?? '',
      classifier: ref.kind,
    },
    explain: `pin ${ref.owner}/${ref.repo} to a full 40-character commit SHA; use actions-warden pin to create a reviewable plan rather than resolving mutable refs inside the audit`,
  };
}

function parseFailure(file) {
  return {
    severity,
    file,
    line: 0,
    fields: {
      type: id,
      sev: severity,
      issue: 'parse-error',
      action: '',
      ref: '',
      classifier: '',
    },
    explain: 'repair this workflow before relying on its action-pin audit; malformed workflow evidence is treated as a high-severity baseline failure',
  };
}

export function explain() {
  return 'Mutable action tags and branches can be retargeted after review. This '
       + 'rule delegates discovery and parsing to the pinned actions-warden library and '
       + 'requires external workflow steps, reusable workflow jobs, and composite-action '
       + 'steps to use full '
       + '40-character commit SHAs.';
}
