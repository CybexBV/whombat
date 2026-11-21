/**
 * The Whombat's one agent (docs/decisions/one-agent.md OA-01, OA-05, OA-08): made with the burrow (`createBurrow`, at
 * the claim), never hired, retired or removed. The person talks to it in their Chat (`ensurePersonalDm`) and changes
 * its name, face, model, keys and the rest in Settings → Agent.
 */
import {
  type AgentFace,
  agentDefaultGrants,
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_RUNTIME,
  topics,
} from '@whombat/core';
import { replaceGrants } from '../commands/agents';
import type { ApplyContext } from '../commit/types';
import { loadAgentRow, loadPrincipalRow, type PrincipalRow, toPrincipal } from '../read/principals';
import { insertAgent } from './members';
import { ensurePersonalDm } from './personal-dm';

/**
 * Makes the burrow's agent inside the burrow's creating commit (OA-01): its name and face (Dusty's unless setup chose
 * others), this Whombat's default provider, guarded, no working directory, each turn on the sign-in of the person it is
 * for (`requester`, OA-11), the default keys (OA-05) and the signed `agent.created` event. Idempotent: a burrow that has
 * its agent keeps it.
 */
export async function createTheAgent(
  ctx: ApplyContext,
  options: { name?: string; face?: AgentFace | null } = {},
): Promise<PrincipalRow> {
  const existing = await loadAgentRow(ctx.tx, ctx.burrow.id);
  if (existing) return existing;
  const name = options.name ?? DEFAULT_AGENT_NAME;
  const runtime = {
    ...DEFAULT_AGENT_RUNTIME,
    provider: ctx.services.runtime.setupStatus().defaultProvider,
  };
  const { id } = await insertAgent(ctx, {
    burrowId: ctx.burrow.id,
    name,
    face: options.face ?? null,
    status: 'idle',
    doing: '',
    job: '',
    runtime,
    createdAt: ctx.now,
  });
  const list = agentDefaultGrants(id);
  await replaceGrants(ctx, id, list);
  const event = await ctx.emit({
    type: 'agent.created',
    kind: 'Keys',
    text: `${name} joined`,
    where: `Agent · ${name}`,
    aboutId: id,
    ref: { type: 'agent' },
    payload: { agentId: id, grants: list.map((g) => ({ keyId: g.keyId, tier: g.tier })) },
  });
  const row = await loadPrincipalRow(ctx.tx, id);
  if (!row) throw new Error('agent row missing');
  ctx.publish(
    topics.burrow(ctx.burrow.id),
    { type: 'principal.created', principal: toPrincipal(row) },
    { eventId: event.id },
  );
  ctx.publish(
    topics.burrow(ctx.burrow.id),
    { type: 'grants.updated', agentId: id, grants: list },
    { eventId: event.id },
  );
  return row;
}

/**
 * The person's Chat with the agent (OA-04), and the guide's hello once it exists (assistant-guides.md AG-04). Inside
 * the caller's commit; a burrow without its agent yet (a test's bare burrow) gets none.
 */
export async function ensureChatWithAgent(ctx: ApplyContext, person: PrincipalRow): Promise<string | null> {
  if (person.kind !== 'person' || person.burrowId !== ctx.burrow.id) return null;
  const agent = await loadAgentRow(ctx.tx, ctx.burrow.id);
  if (!agent) return null;
  const chatId = await ensurePersonalDm(ctx, agent, person);
  const services = ctx.services;
  const burrowId = ctx.burrow.id;
  ctx.after(async () => {
    await services.guides.welcome(burrowId, person.id);
  });
  return chatId;
}
