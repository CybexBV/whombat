/**
 * Who is on a canvas, read from awareness. Every state carries `user` (`CollabUser`, stamped by the server
 * from the authenticated connection), `writing` and the y-prosemirror `cursor`.
 */
import { type AgentFace, type CollabAwarenessState, CollabUser } from '@whombat/core';
import type { Awareness } from 'y-protocols/awareness';

/**
 * The identity a principal carries in awareness (same rule as the server's `collabUser`): the agent's colour is its
 * face's (OA-08), a person's their tone.
 */
export function collabUserOf(p: {
  id: string;
  name: string;
  kind: 'person' | 'agent';
  face?: AgentFace | undefined;
  tone?: string | undefined;
}): CollabUser {
  return {
    principalId: p.id,
    name: p.name,
    kind: p.kind,
    color: p.kind === 'agent' && p.face ? `var(--face-${p.face})` : (p.tone ?? 'var(--brand)'),
  };
}

/** The CSS color of a collaborator (caret, "is writing" tag): the face's accent for the agent, the tone for people. */
export function collabColor(user: Pick<CollabUser, 'color'> | null | undefined): string {
  return user?.color || 'var(--brand)';
}

export interface Collaborator {
  clientId: number;
  user: CollabUser;
  writing: boolean;
  cursor: CollabAwarenessState['cursor'];
}

/** Every awareness state with a valid `user`, in the awareness map's order (own state first). */
export function collaborators(awareness: Awareness): Collaborator[] {
  const out: Collaborator[] = [];
  for (const [clientId, raw] of awareness.getStates()) {
    const state = raw as Partial<CollabAwarenessState> & { collabUser?: unknown };
    // The caret plugin keeps the original identity here when it had to swap the color (see carets.ts).
    const user = CollabUser.safeParse(state.collabUser ?? state.user);
    if (!user.success) continue;
    const cursor = state.cursor && typeof state.cursor === 'object' ? state.cursor : null;
    out.push({ clientId, user: user.data, writing: state.writing === true, cursor });
  }
  return out;
}

/** Principal ids on the canvas ("2 here"), each once, in arrival order. */
export function presentPrincipalIds(list: readonly Collaborator[]): string[] {
  const ids: string[] = [];
  for (const c of list) if (!ids.includes(c.user.principalId)) ids.push(c.user.principalId);
  return ids;
}
