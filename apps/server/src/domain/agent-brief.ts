/**
 * What Whombat tells an agent about a message it posts to wake it, without showing it in the chat
 * (docs/decisions/concise-replies.md). The conversation gets one plain line people understand (“The checks on
 * PR #1 failed (build).”); the details the agent needs (the commit, the counts, the tool to use) go to that agent only,
 * as a hidden signed event next to the message. Its turn reads the message as the line followed by the brief, wherever
 * that turn sees it, the way an automation's request reads.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ApplyContext } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { events, messages } from '../db/schema/index';

export const AGENT_BRIEF_EVENT = 'message.agent_brief';

/**
 * A brief is for the agent's next turn: short enough not to crowd its prompt, long enough for a person's saved prompt
 * (3000 characters) with what to do with it.
 */
export const BRIEF_MAX = 6000;

/** Records `brief` for `agentId` on the message just posted; never shown to people (no event text). */
export async function briefAgent(
  ctx: ApplyContext,
  p: { messageId: string; agentId: string; brief: string },
): Promise<void> {
  const brief = p.brief.trim().slice(0, BRIEF_MAX);
  if (!brief) return;
  await ctx.emit({
    type: AGENT_BRIEF_EVENT,
    kind: 'System',
    text: null,
    where: null,
    aboutId: p.agentId,
    payload: { messageId: p.messageId, agentId: p.agentId, brief },
  });
}

/**
 * The type as a literal, not a parameter: a prepared statement's generic plan could not match the partial index's
 * `type = 'message.agent_brief'` against a parameter.
 */
const isBriefEvent = () => sql`${events.type} = 'message.agent_brief'`;

/**
 * The brief Whombat gave `agentId` with `messageId`; null when there is none. Looked up by the message id
 * (`events_agent_brief_idx`), so it reads one row however long the agent's history is.
 */
export async function agentBriefOf(
  db: Pick<Db, 'select'>,
  burrowId: string,
  messageId: string,
  agentId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.burrowId, burrowId),
        isBriefEvent(),
        sql`(${events.payload}->>'messageId') = ${messageId}`,
        eq(events.aboutId, agentId),
      ),
    )
    .limit(1);
  const brief = (row?.payload as { brief?: unknown; agentId?: unknown } | undefined) ?? undefined;
  return brief?.agentId === agentId && typeof brief.brief === 'string' ? brief.brief : null;
}

/** Which of `messageIds` came with a brief for `agentId`. */
export async function briefedMessages(
  db: Db | Tx,
  burrowId: string,
  agentId: string,
  messageIds: readonly string[],
): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const rows = await db
    .select({
      messageId: sql<string>`${events.payload}->>'messageId'`,
      agentId: sql<string>`${events.payload}->>'agentId'`,
    })
    .from(events)
    .where(
      and(
        eq(events.burrowId, burrowId),
        isBriefEvent(),
        inArray(sql`(${events.payload}->>'messageId')`, [...messageIds]),
        eq(events.aboutId, agentId),
      ),
    );
  return new Set(rows.flatMap((r) => (r.agentId === agentId ? [r.messageId] : [])));
}

/**
 * The messages only a turn of their own reads in full: those Whombat posted with a brief for this agent, and a Feedback
 * handoff, whose report and assessment come with the turn it starts. Joined to a turn for another message they would
 * reach the agent as their one plain line.
 */
export async function ownTurnMessages(
  db: Db | Tx,
  burrowId: string,
  agentId: string,
  rows: readonly { id: string; provenance: string | null }[],
): Promise<Set<string>> {
  const briefed = await briefedMessages(
    db,
    burrowId,
    agentId,
    rows.map((r) => r.id),
  );
  return new Set(
    rows.flatMap((r) => (r.provenance === 'feedback_handoff' || briefed.has(r.id) ? [r.id] : [])),
  );
}

/** Whether `messageId` is one only a turn of its own reads in full (`ownTurnMessages`). */
export async function turnOfItsOwn(
  db: Db | Tx,
  burrowId: string,
  agentId: string,
  messageId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: messages.id, provenance: messages.provenance })
    .from(messages)
    .where(eq(messages.id, messageId));
  return (await ownTurnMessages(db, burrowId, agentId, rows)).has(messageId);
}

/** The message as the agent reads it: the visible line, then its brief. */
export function withBrief(text: string, brief: string): string {
  return `${text}\n\n${brief}`;
}
