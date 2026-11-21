/** A line from the agent to the person in their Chat about their Vault (a rotation, a server's changed host key). */
import { applyContext } from '../commit/pipeline';
import type { ApplyContext } from '../commit/types';
import { postMessage } from '../domain/messages';
import { ensurePersonalDm } from '../domain/personal-dm';
import { thePerson } from '../domain/the-person';
import { loadConversationRow } from '../read/conversations';
import { loadAgentRow, toActor } from '../read/principals';

/** A line to the person in their Chat, posted by the agent (none before there are both). */
export async function tellPerson(ctx: ApplyContext, text: string): Promise<void> {
  const agent = await loadAgentRow(ctx.tx, ctx.burrow.id);
  const person = await thePerson(ctx.tx, ctx.burrow.id);
  if (!agent || !person) return;
  const dm = await loadConversationRow(ctx.tx, await ensurePersonalDm(ctx, agent, person));
  if (!dm) return;
  const asAgent = applyContext(ctx, {
    burrow: ctx.burrow,
    actor: toActor(agent),
    now: ctx.now,
    at: ctx.at,
    decision: null,
    requirement: null,
    approvalId: null,
    onBehalfOf: {},
  });
  await postMessage(asAgent, {
    conversation: dm,
    text,
    mentions: [],
    dispatch: false,
  });
}
