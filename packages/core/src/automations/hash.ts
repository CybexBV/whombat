/**
 * Hashes that bind approvals and versions to exactly what they are about (BP-09, docs/decisions/bp-automations.md).
 *
 * `actionHash` = sha256(canonical JSON of {action, input, binding}): the approval's action, the deferred command's
 * input (or the automation step's proposal) and what it is bound to — the automation id and version, the step id,
 * and the commit sha when a branch is involved. The hash is stored on the approval and signed in its
 * `approval.requested` event; execution recomputes it from what would run and refuses on any difference, so an
 * approval cannot be carried over to a changed input, commit or version.
 */
import { canonicalJson } from '../audit/canonical.js';
import { sha256Hex } from '../audit/crypto.js';
import type { AutomationDefinition } from '../domain/automation.js';
import type { JsonObject, JsonValue } from '../domain/common.js';

export interface ActionBinding {
  automationId?: string;
  version?: number;
  stepId?: string;
  runId?: string;
  /** The commit the approval is about (a branch head when the step binds one). */
  commitSha?: string | null;
  /**
   * A Feedback handoff: whether `commitSha` is the commit the assessor's runner exported (true) or only the revision
   * the assessor wrote (false, unverified).
   */
  commitVerified?: boolean;
  /** A Whombat Feedback handoff (docs/decisions/feedback.md FB-24): the report, its repo and its assessment. */
  reportId?: string;
  repoId?: string | null;
  /** sha256 of the canonical assessment the handoff was asked for. */
  assessmentHash?: string;
}

export interface ActionHashInput {
  action: JsonValue;
  /** The deferred command's input, or the step's proposal. Null when the action runs an executor directly. */
  input: JsonValue | null;
  binding?: ActionBinding;
}

function clean(binding: ActionBinding | undefined): JsonObject {
  const out: JsonObject = {};
  if (!binding) return out;
  for (const [k, v] of Object.entries(binding)) if (v !== undefined) out[k] = v as JsonValue;
  return out;
}

/** sha256 hex of the canonical {action, input, binding}. */
export function actionHash(value: ActionHashInput): string {
  return sha256Hex(
    canonicalJson({ action: value.action, input: value.input ?? null, binding: clean(value.binding) }),
  );
}

/** sha256 hex of a definition's canonical JSON (a version's `definitionHash`). */
export function definitionHash(definition: AutomationDefinition): string {
  return sha256Hex(canonicalJson(definition));
}
