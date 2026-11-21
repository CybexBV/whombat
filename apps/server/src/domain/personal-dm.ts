/**
 * The person's Chat with the agent (docs/decisions/one-agent.md OA-04: their DM with it; it exists from the start) and
 * the lookups the approvals and commands need. Kept apart from `the-agent.ts` (which makes the agent
 * through the commands) so the commit pipeline's approvals can use it without an import cycle.
 */
import { newId } from '@whombat/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { TxSession } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { conversations } from '../db/schema/index';
import type { PrincipalRow } from '../read/principals';
import { publishConversation } from './members';

/** A person's Chat with the agent (their DM with it), if it exists. */
export async function personalDmId(db: Db | Tx, agentId: string, ownerId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.kind, 'dm'),
        eq(conversations.dmAgentId, agentId),
        eq(conversations.dmPersonId, ownerId),
        // The default DM, not a task chat (one-whombat.md ONE-06): asks from rooms others read land here (CA-01).
        isNull(conversations.taskKey),
      ),
    );
  return row?.id ?? null;
}

/** A person's Chat with the agent (it exists from the start), created when missing. */
export async function ensurePersonalDm(
  ctx: TxSession & { burrow: { id: string }; now: Date },
  agent: PrincipalRow,
  person: PrincipalRow,
): Promise<string> {
  const existing = await personalDmId(ctx.tx, agent.id, person.id);
  if (existing) return existing;
  const id = newId('conversation');
  await ctx.tx.insert(conversations).values({
    id,
    burrowId: ctx.burrow.id,
    kind: 'dm',
    slug: `${agent.handle}--${person.handle}`,
    title: agent.name,
    topic: '',
    dmAgentId: agent.id,
    dmPersonId: person.id,
    createdAt: ctx.now,
  });
  await publishConversation(ctx, id, null);
  return id;
}
