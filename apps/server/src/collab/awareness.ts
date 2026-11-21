/**
 * Awareness (presence, carets, "is writing") on canvas documents. Clients publish their own state through
 * the Hocuspocus provider; the server stamps who they are (`user`) from the authenticated connection. Agents
 * editing through `canvas_edit` have no socket: the server publishes their state for them under a stable
 * synthetic Yjs client id, renews it while they are around and removes it when they leave.
 */
import {
  type CollabAwarenessState,
  type CollabUser,
  CollabAwarenessState as StateSchema,
} from '@whombat/core';
import * as encoding from 'lib0/encoding';
import { type Awareness, applyAwarenessUpdate } from 'y-protocols/awareness';
import type { PrincipalRow } from '../read/principals';

/** The identity a principal carries in awareness. */
export function collabUser(row: Pick<PrincipalRow, 'id' | 'name' | 'kind' | 'tone'>): CollabUser {
  return {
    principalId: row.id,
    name: row.name,
    kind: row.kind === 'person' ? 'person' : 'agent',
    // People by their avatar tone; the agent (no roles, one-agent.md OA-05) by the brand.
    color: row.kind === 'person' ? (row.tone ?? 'var(--brand)') : 'var(--brand)',
  };
}

/** Awareness fields a client may set itself; everything else is stripped by `stampState`. */
const CLIENT_OWNED_FIELDS = new Set(['writing', 'cursor']);

/**
 * Rewrites a client's awareness state so its `user` is the connection's principal, whatever it claimed,
 * and `writing` is a boolean. Only the y-prosemirror `cursor` is otherwise kept: every other key a client
 * sent (including an unstamped `collabUser`, which `apps/web/.../canvas/collab/users.ts` would prefer
 * over the stamped `user`) is deleted, so a client can never smuggle a forged identity, color or other
 * field into what gets broadcast to peers under a name `collaborators()` doesn't already ignore.
 */
export function stampState(state: Record<string, unknown>, user: CollabUser): Record<string, unknown> {
  for (const key of Object.keys(state)) {
    if (key !== 'user' && !CLIENT_OWNED_FIELDS.has(key)) delete state[key];
  }
  state.user = user;
  state.writing = state.writing === true;
  return state;
}

/** Principal ids present on a document (from awareness `user.principalId`), in first-seen order. */
export function presentPrincipalIds(awareness: Awareness): string[] {
  const out: string[] = [];
  for (const state of awareness.getStates().values()) {
    const id = (state as { user?: { principalId?: unknown } })?.user?.principalId;
    if (typeof id === 'string' && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Stable synthetic Yjs client id for a server-driven participant (FNV-1a of the principal id, 31 bits). */
export function syntheticClientId(principalId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < principalId.length; i++) {
    h ^= principalId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // High bit set keeps these apart from most random client ids; never 0.
  return ((h >>> 1) | 0x40000000) >>> 0;
}

/** Encodes one client's awareness entry (`state` null removes it). */
export function encodeAwarenessEntry(clientId: number, clock: number, state: unknown): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint(encoder, clientId);
  encoding.writeVarUint(encoder, clock);
  encoding.writeVarString(encoder, JSON.stringify(state));
  return encoding.toUint8Array(encoder);
}

/** A server-published participant: an agent writing through `canvas_edit`. */
export class ServerParticipant {
  readonly clientId: number;
  private clock: number;
  state: CollabAwarenessState;

  constructor(user: CollabUser) {
    this.clientId = syntheticClientId(user.principalId);
    // Clocks only move forward per client id; starting from the time keeps a restarted server ahead of the
    // clock peers remember for the same id.
    this.clock = Math.floor(Date.now() / 1000);
    this.state = StateSchema.parse({ user });
  }

  publish(awareness: Awareness, patch: Partial<CollabAwarenessState>, origin: unknown): void {
    this.state = { ...this.state, ...patch };
    this.clock += 1;
    applyAwarenessUpdate(awareness, encodeAwarenessEntry(this.clientId, this.clock, this.state), origin);
  }

  remove(awareness: Awareness, origin: unknown): void {
    this.clock += 1;
    applyAwarenessUpdate(awareness, encodeAwarenessEntry(this.clientId, this.clock, null), origin);
  }
}
