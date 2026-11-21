/**
 * Telling clients that a part of Home changed (`home.changed {parts}` and `widget.updated {widgetId}` on `me`, contracts
 * CT-336): no content, the client refetches. A change reaches the person (one-person.md OP-S52). Chats with the assistant move with `working` (home-redesign.md HR-43): a plan or a turn in one
 * of the person's chats with it, an approval opened or decided.
 */
import { type Approval, type HomePart, topics } from '@whombat/core';
import type { TxSession } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { thePerson } from '../domain/the-person';

/** Whom a change of Home is for: the person (none while the burrow has none). */
export async function homeAudience(session: { tx: Db | Tx }, burrowId: string): Promise<string[]> {
  const person = await thePerson(session.tx, burrowId);
  return person ? [person.id] : [];
}

/** `home.changed` to each of `people`, in the caller's commit. */
export function publishHomeChanged(
  session: Pick<TxSession, 'publish'>,
  people: readonly string[],
  parts: HomePart[],
) {
  if (!parts.length) return;
  for (const id of new Set(people)) session.publish(topics.me(id), { type: 'home.changed', parts });
}

/** `widget.updated` to the person whose widget it is. */
export function publishWidgetUpdated(
  session: Pick<TxSession, 'publish'>,
  personId: string,
  widgetId: string,
) {
  session.publish(topics.me(personId), { type: 'widget.updated', widgetId });
}

/**
 * A person's chats with their assistant moved (HR-43): a plan in one of them changed. `home.changed {working}` to the
 * person of an agent DM (the default chat or a task chat); nothing for any other conversation.
 */
export function publishChatChanged(
  session: Pick<TxSession, 'publish'>,
  conversation: { kind: string; dmAgentId: string | null; dmPersonId: string | null },
) {
  if (conversation.kind !== 'dm' || !conversation.dmAgentId || !conversation.dmPersonId) return;
  publishHomeChanged(session, [conversation.dmPersonId], ['working']);
}

/**
 * An approval opened, moved or was decided (HR-43): Needs you and the chat it waits in, for the person (who decides
 * every approval, one-person.md OP-S62).
 */
export async function publishApprovalChanged(
  session: Pick<TxSession, 'tx' | 'publish'>,
  approval: Pick<Approval, 'burrowId' | 'conditions'>,
) {
  const people = await homeAudience(session, approval.burrowId);
  publishHomeChanged(session, people, ['needsYou', 'working']);
}
