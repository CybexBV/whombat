/**
 * Event field builders for the keys engine outcomes, so every command writes Blocked / Asks / Keys
 * events the same way. The commit pipeline adds id, burrow, actor, where, payload and time.
 */
import type { ApprovalAction } from '../domain/approval.js';
import type { AuditKeyRef, AuditKind, KnownEventType } from '../domain/audit.js';
import { describeAsk, describeBlocked } from '../keys/actions.js';
import { KEY_CATALOG, type KeyId } from '../keys/catalog.js';
import { type Decision, keyNoteFor } from '../keys/engine.js';
import { describeGrantChange, type GrantChange } from '../keys/grants.js';

export interface KeyEventFields {
  kind: AuditKind;
  type: KnownEventType;
  text: string;
  keyUsed?: AuditKeyRef;
  keyNote?: string;
}

/** `{id, label}` frozen into an event. */
export function keyRefOf(keyId: KeyId, label?: string): AuditKeyRef {
  return { id: keyId, label: label ?? KEY_CATALOG[keyId].label };
}

/** KEY USED fields for an allowed command (no note). */
export function keyUsedFields(decision: Decision): Pick<KeyEventFields, 'keyUsed'> {
  return { keyUsed: keyRefOf(decision.keyId) };
}

/**
 * A denied attempt: "Tried to merge PR #479 into main. Blocked." with KEY IT NEEDED
 * "Merge into main · not one of Banjo’s keys".
 */
export function blockedEventFields(decision: Decision, actorName: string, attempt: string): KeyEventFields {
  const fields: KeyEventFields = {
    kind: 'Blocked',
    type: 'action.blocked',
    text: describeBlocked(attempt),
    keyUsed: keyRefOf(decision.keyId),
  };
  const note = keyNoteFor(decision, actorName);
  if (note) fields.keyNote = note;
  return fields;
}

/** An ask: "Asked to deploy feat/invoice-pdf to staging" with KEY USED "Deploy to staging · asks a person first". */
export function askEventFields(
  decision: Decision,
  actorName: string,
  action: ApprovalAction,
): KeyEventFields {
  return {
    kind: 'Asks',
    type: 'approval.requested',
    text: describeAsk(action),
    keyUsed: keyRefOf(decision.keyId),
    keyNote: keyNoteFor(decision, actorName) ?? 'asks a person first',
  };
}

/** A grant change as a Keys event ("Gave Dusty a new key: Run tests"). */
export function keysEventFields(agentName: string, change: GrantChange): KeyEventFields {
  const type: KnownEventType =
    change.kind === 'added' ? 'keys.granted' : change.kind === 'removed' ? 'keys.revoked' : 'keys.changed';
  return { kind: 'Keys', type, text: describeGrantChange(agentName, change) };
}
