/**
 * An agent's status is Whombat's (docs/decisions/agent-status.md AS-03): `working` while one of its turns is
 * claimed or running, `waiting` while a question it asked (a message with `asks`) has no answer from a person
 * in that place, `idle` otherwise. The agent only writes its RIGHT NOW line (`set_status`); the runtime and a
 * person's answer settle the status. Both are signed `agent.status` events by the agent.
 */
import { type AgentStatus, MCP_TOOLS, topics } from '@whombat/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { dispatches, principals } from '../db/schema/index';
import { publishHomeChanged } from '../home/notify';
import { forbidden } from '../lib/errors';
import { unansweredByPeople } from '../read/messages';
import { loadPrincipalRow, toAgent } from '../read/principals';

/**
 * Whether the agent asked something nobody answered yet: a person posted nothing after the question in its
 * place (the same thread, or top level) or in the question's own thread.
 */
export async function hasOpenQuestion(db: Db, agentId: string): Promise<boolean> {
  const q = {
    id: sql`q.id`,
    conversationId: sql`q.conversation_id`,
    threadRootId: sql`q.thread_root_id`,
    ord: sql`q.ord`,
  };
  const rows = await db.execute(sql`
    select 1 from messages q
    where q.author_id = ${agentId} and q.asks and ${unansweredByPeople(q)}
    limit 1`);
  return rows.length > 0;
}

export async function settledStatus(tx: Tx, agentId: string): Promise<AgentStatus> {
  const [live] = await tx
    .select({ id: dispatches.id })
    .from(dispatches)
    .where(and(eq(dispatches.agentId, agentId), inArray(dispatches.state, ['claimed', 'running'])))
    .limit(1);
  if (live) return 'working';
  return (await hasOpenQuestion(tx, agentId)) ? 'waiting' : 'idle';
}

/* set_status ------------------------------------------------------------------------------------- */

/** The agent's RIGHT NOW line; the status is settled, not taken from the agent. */
export const setAgentStatus = defineCommand({
  name: 'set_agent_status',
  schema: MCP_TOOLS.set_status.input,
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only agents have a status.');
    const self = await loadPrincipalRow(tx, ctx.actor.id);
    await writeAgentStatus(ctx, self, await settledStatus(tx, ctx.actor.id), input.doing);
    return {};
  },
});

/**
 * Settles the status after something that may change it: a turn was claimed or ended, or a person posted where
 * the agent asked something. Nothing is written when the status is already right; the line is kept. The person
 * hears of it either way (`home.changed {working}`, home-redesign.md HR-43): which of their chats it works
 * in moves with each turn, also while its status stays `working`.
 */
export const settleAgentStatus = defineCommand({
  name: 'settle_agent_status',
  schema: z.object({}),
  async apply(tx, ctx) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only agents have a status.');
    const self = await loadPrincipalRow(tx, ctx.actor.id);
    if (!self) return { changed: false };
    // Everyone's Home shows what the agent works on (one-agent.md OA-14): the person the turn is for hears it.
    if (ctx.onBehalfOf.principalId) publishHomeChanged(ctx, [ctx.onBehalfOf.principalId], ['working']);
    const status = await settledStatus(tx, self.id);
    if (status === self.status) return { changed: false };
    await writeAgentStatus(ctx, self, status, self.doing ?? '');
    return { changed: true };
  },
});

async function writeAgentStatus(
  ctx: ApplyContext,
  _self: Awaited<ReturnType<typeof loadPrincipalRow>>,
  status: AgentStatus,
  doingIn: string,
) {
  const { tx } = ctx;
  // The status is the agent's, the words are its own only when they are about the work (IN-17).
  const doing = doingIn;
  await tx.update(principals).set({ status, doing }).where(eq(principals.id, ctx.actor.id));
  const event = await ctx.emit({
    type: 'agent.status',
    kind: 'System',
    text: null,
    where: `Agent · ${ctx.actor.name}`,
    aboutId: ctx.actor.id,
    payload: { status, doing },
  });
  const row = await loadPrincipalRow(tx, ctx.actor.id);
  if (row)
    ctx.publish(
      topics.burrow(ctx.burrow.id),
      { type: 'agent.updated', agent: toAgent(row) },
      { eventId: event.id },
    );
}
