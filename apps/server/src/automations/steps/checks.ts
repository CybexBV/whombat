import { stepRequiredRooms } from '@whombat/core';
import { eq } from 'drizzle-orm';
import type { Db, Tx } from '../../db/client';
import { automations, messages } from '../../db/schema/index';
import { type AuthorityCheck, conversationsCheck } from '../authority';
import type { AutomationRunRow } from '../store';

/**
 * The run's room and every room whose content may go into or come out of step `idx` (the room it acts in, and the
 * rooms of the trigger and earlier steps it reads) — and the room of the message that started the run, which is no
 * longer the run's own once it posts in its publisher's Chat (automations/rooms.ts; one-agent.md OA-S103) — are still
 * the burrow's. Also the approval guard's check (engine.ts).
 */
export async function stepRoomsCheck(
  db: Db,
  run: Pick<AutomationRunRow, 'definition' | 'conversationId' | 'trigger'>,
  idx: number,
  publisher: Parameters<typeof conversationsCheck>[1],
): Promise<AuthorityCheck> {
  const rooms = stepRequiredRooms(run.definition, run.conversationId, idx);
  const from = await triggerRoomOf(db, run);
  return conversationsCheck(db, publisher, from ? [...rooms, from] : rooms);
}

/** The room of the message that started the run (null: no message started it, or it is gone). */
export async function triggerRoomOf(db: Db, run: Pick<AutomationRunRow, 'trigger'>): Promise<string | null> {
  const messageId = run.trigger.messageId;
  if (!messageId) return null;
  const [row] = await db
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, messageId));
  return row?.conversationId ?? null;
}

export async function automationPrincipal(tx: Tx, run: AutomationRunRow): Promise<string | null> {
  const [row] = await tx
    .select({ principalId: automations.principalId })
    .from(automations)
    .where(eq(automations.id, run.automationId));
  return row?.principalId ?? null;
}
