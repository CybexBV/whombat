/**
 * The agent's settings (docs/decisions/one-agent.md OA-08, OA-09): its name, face, model and effort, and keys. One agent
 * per burrow, made with it (`createTheAgent`); the person changes it. Every change is a signed `Keys` event.
 */
import {
  AGENT_NAME_FORM_TEXT,
  AGENT_NAME_MAX,
  AGENT_NAME_PATTERN,
  AGENT_NAME_RESERVED_TEXT,
  AgentFace,
  type AgentModelRuntime,
  AgentModelRuntimeUpdate,
  type AgentRuntime,
  agentBackgroundModelChangeText,
  agentEffortChangeText,
  agentFastChangeText,
  agentModelChangeText,
  agentName,
  backgroundModelLabel,
  clampGrants,
  diffGrants,
  effortLabel,
  effortsFor,
  fastNoneText,
  type Grant,
  GrantInput,
  grantsWithRequestedKey,
  heldTier,
  isReservedAgentName,
  KEY_CATALOG,
  type KeyTierRow,
  keyRequestProblem,
  keyRowTier,
  keysEventFields,
  localProviderModels,
  MODEL_ID_MAX,
  modelFast,
  modelLabel,
  PROVIDER_LABELS,
  type ProviderModel,
  requestedTier,
  type Tier,
  topics,
  withKeyRowTier,
} from '@whombat/core';
import { and, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { toJsonObject } from '../commit/pipeline';
import type { ApplyContext, RequirementContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import { approvals, conversations, grants, principals, searchDocuments } from '../db/schema/index';
import { publishConversation } from '../domain/members';
import { postMessage } from '../domain/messages';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import { localModelView } from '../local-model/store';
import { loadConversationRow } from '../read/conversations';
import {
  agentRuntimeOf,
  faceOf,
  loadAgentRow,
  loadGrants,
  loadPrincipalRow,
  type PrincipalRow,
  toAgent,
} from '../read/principals';

/** Where the agent's events point: Settings → Agent. */
export function agentWhere(name: string): string {
  return `Agent · ${name}`;
}

/** The burrow's one agent (OA-01). */
async function theAgent(ctx: Pick<ApplyContext, 'tx' | 'burrow'>): Promise<PrincipalRow> {
  const row = await loadAgentRow(ctx.tx, ctx.burrow.id);
  if (!row) throw notFound('Agent');
  return row;
}

/** The person changes the agent (OA-09; one-person.md OP-S07). */
function personChanges(attempt: string, name = 'the agent') {
  return { keyId: 'burrow.manage' as const, attempt, where: agentWhere(name) };
}

/** The tools whose own efforts and fast replies an agent may pick. */
function takesModels(provider: AgentRuntime['provider']): provider is 'claude' | 'codex' {
  return provider === 'claude' || provider === 'codex';
}

/**
 * What the agent's model runtime becomes: main model, effort and fast replies only with Claude Code and ChatGPT;
 * background model for any provider.
 */
function modelRuntime(runtime: z.output<typeof AgentModelRuntime>): z.output<typeof AgentModelRuntime> {
  const tool = takesModels(runtime.provider);
  return {
    provider: runtime.provider,
    ...(tool && runtime.model ? { model: runtime.model } : {}),
    ...(runtime.backgroundModel ? { backgroundModel: runtime.backgroundModel } : {}),
    ...(tool && runtime.effort ? { effort: runtime.effort } : {}),
    ...(tool && runtime.fast !== undefined ? { fast: runtime.fast } : {}),
  };
}

/** The models this Whombat knows a provider has; null while none are known. */
function reportedModels(
  ctx: Pick<ApplyContext, 'services'> & {
    burrow?: Pick<ApplyContext['burrow'], 'localModel' | 'localModelKeyEnc'>;
  },
  provider: AgentRuntime['provider'],
): ProviderModel[] | null {
  if (provider === 'local') {
    const view = ctx.burrow ? localModelView(ctx.burrow) : null;
    return view ? localProviderModels(view) : null;
  }
  return ctx.services.runtime.setupStatus().providers.find((p) => p.provider === provider)?.models ?? null;
}

/**
 * Checks a changed main model, background model, effort and fast replies against what the provider offers. Only what
 * changes is checked (`before`): an agent whose stored model later left the list keeps it until changed.
 */
function assertModelChoice(
  ctx: Pick<ApplyContext, 'services'> & {
    burrow?: Pick<ApplyContext['burrow'], 'localModel' | 'localModelKeyEnc'>;
  },
  runtime: z.output<typeof AgentModelRuntime>,
  before?: Pick<AgentRuntime, 'provider' | 'model' | 'backgroundModel' | 'effort' | 'fast'>,
): z.output<typeof AgentModelRuntime> {
  const refuse = (text: string): never => {
    throw new ApiError('validation_failed', text, { fields: { runtime: [text] } });
  };
  const sameTool = before?.provider === runtime.provider;
  const modelChanged = !sameTool || before?.model !== runtime.model;
  const bgChanged = !sameTool || before?.backgroundModel !== runtime.backgroundModel;
  const effortChanged = modelChanged || before?.effort !== runtime.effort;
  if (modelChanged && runtime.model && runtime.model.length > MODEL_ID_MAX)
    refuse(`A model’s name has at most ${MODEL_ID_MAX} characters.`);
  if (bgChanged && runtime.backgroundModel && runtime.backgroundModel.length > MODEL_ID_MAX)
    refuse(`A model’s name has at most ${MODEL_ID_MAX} characters.`);
  const models = reportedModels(ctx, runtime.provider);
  if (models) {
    if (
      takesModels(runtime.provider) &&
      modelChanged &&
      runtime.model &&
      !models.some((m) => m.id === runtime.model)
    )
      refuse(`${PROVIDER_LABELS[runtime.provider]} has no model called “${runtime.model}” on this Whombat.`);
    if (bgChanged && runtime.backgroundModel && !models.some((m) => m.id === runtime.backgroundModel))
      refuse(
        `${PROVIDER_LABELS[runtime.provider]} has no model called “${runtime.backgroundModel}” on this Whombat.`,
      );
  }
  if (!models || !takesModels(runtime.provider)) return runtime;
  if (effortChanged && runtime.effort && !effortsFor(models, runtime.model).includes(runtime.effort))
    refuse(`${modelLabel(models, runtime.model)} doesn’t take ${effortLabel(runtime.effort)} effort.`);
  // Fast replies only where the model offers them: turning them on elsewhere is refused in Chat's words; “off” where
  // there is nothing to turn off is dropped.
  const fastChanged = modelChanged || before?.fast !== runtime.fast;
  if (runtime.fast !== undefined && !modelFast(models, runtime.model)) {
    if (runtime.fast && fastChanged) refuse(fastNoneText(models, runtime.model));
    if (!runtime.fast) {
      const { fast: _fast, ...rest } = runtime;
      return rest;
    }
  }
  return runtime;
}

/**
 * The model runtime this Whombat offers for one a backup file brings back: keeps what this box's provider lists,
 * dropping unsupported background model, fast replies, effort or main model in turn. Never throws.
 */
export function offeredModelRuntime(
  ctx: Pick<ApplyContext, 'services'> & {
    burrow?: Pick<ApplyContext['burrow'], 'localModel' | 'localModelKeyEnc'>;
  },
  runtime: z.output<typeof AgentModelRuntime>,
): z.output<typeof AgentModelRuntime> {
  const wanted = modelRuntime(runtime);
  const { backgroundModel: _bg, ...noBg } = wanted;
  const { fast: _fast, ...noFast } = wanted;
  const { backgroundModel: _bg2, ...noFastNoBg } = noFast;
  const { effort: _effort, ...noEffort } = noFast;
  const { backgroundModel: _bg3, ...noEffortNoBg } = noEffort;
  const { model: _model, ...bare } = noEffortNoBg;
  for (const candidate of [wanted, noBg, noFast, noFastNoBg, noEffort, noEffortNoBg]) {
    try {
      return assertModelChoice(ctx, candidate);
    } catch {
      // The next, with less.
    }
  }
  return bare;
}

/** The keys the agent may hold of `list` (backup-file.md BF-19, BF-S07): clamped to what an agent may hold. */
export function grantsThatFit(list: readonly Grant[]): Grant[] {
  return clampGrants(list).grants;
}

export async function replaceGrants(
  ctx: ApplyContext,
  agentId: string,
  next: readonly Grant[],
): Promise<void> {
  await ctx.tx.delete(grants).where(eq(grants.agentId, agentId));
  if (next.length === 0) return;
  await ctx.tx.insert(grants).values(
    next.map((g, i) => ({
      burrowId: ctx.burrow.id,
      agentId,
      keyId: g.keyId,
      tier: g.tier,
      scope: g.scope ?? null,
      position: i,
    })),
  );
}

function publishGrants(ctx: ApplyContext, agentId: string, list: Grant[], eventId: string | null) {
  ctx.publish(topics.burrow(ctx.burrow.id), { type: 'grants.updated', agentId, grants: list }, { eventId });
}

export async function publishAgent(ctx: ApplyContext, agentId: string, eventId: string | null) {
  const row = await loadPrincipalRow(ctx.tx, agentId);
  if (row?.kind === 'agent')
    ctx.publish(topics.burrow(ctx.burrow.id), { type: 'agent.updated', agent: toAgent(row) }, { eventId });
}

export const setAgentKeys = defineCommand({
  name: 'set_agent_keys',
  schema: z.object({ grants: z.array(GrantInput).max(60) }),
  requiredKey: () => personChanges('change the agent’s keys'),
  async apply(_tx, ctx, input) {
    const agent = await theAgent(ctx);
    const before = await loadGrants(ctx.tx, agent.id);
    const deduped = new Map<string, Grant>();
    for (const g of input.grants) {
      const grant: Grant = { agentId: agent.id, keyId: g.keyId, tier: g.tier };
      if (g.scope) grant.scope = g.scope;
      deduped.set(g.keyId, grant);
    }
    const after = clampGrants([...deduped.values()]).grants;
    return writeGrants(ctx, agent, before, after);
  },
});

/**
 * Saves the agent's new grant set with one signed `Keys` event per change, signed by the actor: Settings → Agent and a
 * key request someone approved (docs/decisions/key-requests.md).
 */
export async function writeGrants(
  ctx: ApplyContext,
  agent: PrincipalRow,
  before: Grant[],
  after: Grant[],
  extraPayload: Record<string, string> = {},
): Promise<{ grants: Grant[]; events: { id: string; text: string }[] }> {
  const changes = diffGrants(before, after).map((change) => {
    // A removed key is described as it was held ("Took Moth’s “Read #general” key away").
    const held = change.kind === 'removed' ? before.find((g) => g.keyId === change.keyId)?.scope : undefined;
    return held ? { ...change, scope: held } : change;
  });
  const events: { id: string; text: string }[] = [];
  if (changes.length === 0) return { grants: before, events };
  await replaceGrants(ctx, agent.id, after);
  for (const change of changes) {
    const fields = keysEventFields(agent.name, change);
    const event = await ctx.emit({
      ...fields,
      where: agentWhere(agent.name),
      aboutId: agent.id,
      ref: { type: 'agent' },
      payload: { agentId: agent.id, keyId: change.keyId, from: change.from, to: change.to, ...extraPayload },
    });
    events.push({ id: event.id, text: fields.text });
  }
  publishGrants(ctx, agent.id, after, events[events.length - 1]?.id ?? null);
  return { grants: after, events };
}

/**
 * Sets one of an agent's risk rows to `tier` (resourceful-agents.md RA-06's “Always allow”, and its undo; RA-DS33): the
 * row's keys through `withKeyRowTier`, saved with the same signed `Keys` events Configure writes, signed by the person
 * (`extraPayload` names the approval). Returns the row's tier before and the events.
 */
export async function setAgentKeyRow(
  ctx: ApplyContext,
  agent: PrincipalRow,
  row: KeyTierRow,
  tier: Tier,
  extraPayload: Record<string, string> = {},
): Promise<{ before: Tier; events: { id: string; text: string }[] }> {
  const before = await loadGrants(ctx.tx, agent.id);
  const was = keyRowTier(before, row);
  const after = clampGrants(
    withKeyRowTier(before, row, tier).map((g): Grant => ({ ...g, agentId: agent.id })),
  ).grants;
  const written = await writeGrants(ctx, agent, before, after, extraPayload);
  return { before: was, events: written.events };
}

/** The key request `approvalId` (a `grant_key` approval of this burrow), or null when it isn't one. */
async function keyRequestRow(db: RequirementContext['db'], burrowId: string, approvalId: string) {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (!row || row.burrowId !== burrowId || row.action.type !== 'grant_key') return null;
  return { row, keyId: row.action.params.keyId };
}

/**
 * Gives the agent the key it asked for, once the person approved the request (docs/decisions/key-requests.md;
 * one-person.md OP-S62): run by the approvals engine as the person who approved, under the
 * same rules as Settings → Agent, with the same signed `Keys` event. The key goes in at `can`, clamped to its
 * cap; every other grant stays. The agent is told under the card, which wakes it for the person the request was
 * made for (SUB-28).
 */
export const grantRequestedKey = defineCommand({
  name: 'grant_requested_key',
  schema: z.object({ approvalId: z.string() }),
  async requiredKey(input, { db, burrow }) {
    const found = await keyRequestRow(db, burrow.id, input.approvalId);
    const agent = found ? await loadPrincipalRow(db, found.row.requesterId) : undefined;
    const name = agent?.name ?? 'the agent';
    return {
      keyId: 'burrow.manage',
      attempt: found ? `give ${name} “${KEY_CATALOG[found.keyId].label}”` : `change ${name}’s keys`,
      where: agentWhere(name),
    };
  },
  async apply(tx, ctx, input) {
    const found = await keyRequestRow(tx, ctx.burrow.id, input.approvalId);
    // Only the approval that asked, approved by this person and running now, gives the key.
    if (
      found?.row.state !== 'approved' ||
      found.row.decidedById !== ctx.actor.id ||
      found.row.execution.state !== 'running'
    )
      throw forbidden('That approval does not cover this.');
    const { row, keyId } = found;
    const agent = await loadPrincipalRow(tx, row.requesterId);
    if (agent?.kind !== 'agent' || agent.burrowId !== ctx.burrow.id) throw notFound('Agent');
    const before = await loadGrants(tx, agent.id);
    const label = KEY_CATALOG[keyId].label;
    const held = heldTier(agent.id, before, keyId);
    let result: { grants: Grant[]; events: { id: string; text: string }[] } = { grants: before, events: [] };
    if (held !== 'can' && held !== requestedTier(keyId)) {
      const problem = keyRequestProblem({ id: agent.id, name: agent.name }, before, keyId);
      if (problem) throw badRequest(problem);
      result = await writeGrants(ctx, agent, before, grantsWithRequestedKey(agent.id, before, keyId), {
        approvalId: row.id,
      });
    }
    // Tell the agent where it asked, like a decline does: a reply under the card that wakes it.
    const conversation = await loadConversationRow(tx, row.conversationId);
    if (conversation) {
      const first = agent.name.split(/\s+/)[0] ?? agent.name;
      await postMessage(ctx, {
        conversation,
        text:
          result.events.length > 0
            ? `@${first}, I gave you “${label}”. Go ahead.`
            : `@${first}, you hold “${label}” already. Go ahead.`,
        threadRootId: row.messageId,
        mentions: [agent.id],
        // The agent goes on with the work it asked for, for the person it was doing it for — never on the approver's
        // behalf (SUB-28); a request made for nobody wakes it for nobody.
        onBehalfOfAccountId: row.onBehalfOfAccountId ?? null,
      });
    }
    return result;
  },
});

/**
 * Its DMs are titled with its name (mobile lists them by title; `where`s and search say it): they follow a rename
 * (IN-28), and so do the `where`s of those DMs' search documents (the DM title, “Plan · Hazel”, “Approval #3 · Hazel”;
 * five-agents.md FA-DS04, as migration 0062 does). Returns the DMs.
 */
export async function renameAgentDms(tx: ApplyContext['tx'], agentId: string, name: string) {
  const dms = await tx
    .select({ id: conversations.id, title: conversations.title })
    .from(conversations)
    .where(and(eq(conversations.kind, 'dm'), eq(conversations.dmAgentId, agentId)));
  for (const dm of dms) {
    const suffix = ` · ${dm.title}`;
    await tx
      .update(searchDocuments)
      .set({
        where: sql`case when ${searchDocuments.where} = ${dm.title} then ${name}
          else left(${searchDocuments.where}, length(${searchDocuments.where}) - length(${dm.title})) || ${name} end`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(searchDocuments.conversationId, dm.id),
          or(
            eq(searchDocuments.where, dm.title),
            sql`right(${searchDocuments.where}, ${suffix.length}) = ${suffix}`,
          ),
        ),
      );
  }
  if (dms.length)
    await tx
      .update(conversations)
      .set({ title: name })
      .where(and(eq(conversations.kind, 'dm'), eq(conversations.dmAgentId, agentId)));
  return dms;
}

const nameInvalid = (message: string) =>
  new ApiError('validation_failed', message, { fields: { name: [message] } });

/** A name the agent may take: one capitalised word, not “Whombat” (OA-08, AN-03); throws `validation_failed`. */
export function assertAgentName(name: string): void {
  if (isReservedAgentName(name)) throw nameInvalid(AGENT_NAME_RESERVED_TEXT);
  if (!AGENT_NAME_PATTERN.test(name)) throw nameInvalid(AGENT_NAME_FORM_TEXT);
}

/**
 * Settings → Agent (OA-08, OA-09): its name, its face and its model (provider, model, effort, fast replies). Owners only.
 */
export const updateAgent = defineCommand({
  name: 'update_agent',
  schema: z.object({
    /** One capitalised word, at most 24 letters; empty: Dusty. */
    name: z.string().trim().max(AGENT_NAME_MAX).optional(),
    face: AgentFace.optional(),
    runtime: AgentModelRuntimeUpdate.optional(),
  }),
  requiredKey: () => personChanges('change the agent'),
  async apply(tx, ctx, input) {
    const agent = await theAgent(ctx);
    const name = input.name === undefined ? undefined : agentName(input.name);
    const renamed = name !== undefined && name !== agent.name ? name : undefined;
    if (renamed !== undefined) assertAgentName(renamed);
    const face = faceOf(agent);
    const changedFace = input.face !== undefined && input.face !== face ? input.face : undefined;
    const texts: string[] = [];
    const set: Partial<typeof principals.$inferInsert> = {};
    if (renamed !== undefined) {
      set.name = renamed;
      texts.push(`Renamed ${agent.name} to ${renamed}`);
    }
    const shownName = renamed ?? agent.name;
    if (changedFace !== undefined) {
      set.agentFace = changedFace;
      texts.push(`Changed ${shownName}’s face`);
    }
    const current = agentRuntimeOf(agent.runtime);
    // The whole model runtime every time (model-effort.md ME-01): provider, model, effort. Omitting `backgroundModel`
    // on the same provider keeps the stored one so an older app never erases it; explicit `null` clears it back to
    // “Same as the main model”.
    const resolvedRuntime: z.output<typeof AgentModelRuntime> | null = input.runtime
      ? {
          ...input.runtime,
          backgroundModel:
            input.runtime.backgroundModel === undefined
              ? input.runtime.provider === current.provider
                ? current.backgroundModel
                : undefined
              : (input.runtime.backgroundModel ?? undefined),
        }
      : null;
    const sent = resolvedRuntime ? modelRuntime(resolvedRuntime) : null;
    if (
      sent &&
      (sent.provider !== current.provider ||
        sent.model !== current.model ||
        sent.backgroundModel !== current.backgroundModel ||
        sent.effort !== current.effort ||
        sent.fast !== current.fast)
    ) {
      const wanted = assertModelChoice(ctx, sent, current);
      // Replace the provider's model settings cleanly so switching provider clears stale ids.
      const { model: _model, backgroundModel: _bg, effort: _effort, fast: _fast, ...kept } = current;
      set.runtime = { ...kept, ...wanted } satisfies AgentRuntime;
      const models = reportedModels(ctx, wanted.provider);
      // One Keys line per part that changed; a new provider's cleared settings say nothing of their own.
      const toolMoved = wanted.provider !== current.provider;
      if (toolMoved) texts.push(`Moved ${shownName} to ${wanted.provider}`);
      const modelChanged = wanted.model !== current.model && !(toolMoved && !wanted.model);
      if (modelChanged) texts.push(agentModelChangeText(shownName, modelLabel(models, wanted.model)));
      const bgChanged =
        wanted.backgroundModel !== current.backgroundModel && !(toolMoved && !wanted.backgroundModel);
      if (bgChanged)
        texts.push(
          agentBackgroundModelChangeText(shownName, backgroundModelLabel(models, wanted.backgroundModel)),
        );
      if (wanted.effort !== current.effort && !(toolMoved && !wanted.effort))
        texts.push(agentEffortChangeText(shownName, wanted.effort));
      // Fast replies turned on or off; back to the model's own speed says what that is when it changes anything.
      const fastOn = (r: Pick<AgentRuntime, 'model' | 'fast'>) =>
        r.fast ?? modelFast(models, r.model) === 'on';
      if (
        wanted.fast !== current.fast &&
        (wanted.fast !== undefined || (!toolMoved && fastOn(wanted) !== fastOn(current)))
      )
        texts.push(agentFastChangeText(shownName, fastOn(wanted)));
      // The last turn's fallback was about the main model it had.
      if (toolMoved || wanted.model !== current.model) set.modelFallback = null;
    }
    if (texts.length === 0) return { agentId: agent.id };
    await tx.update(principals).set(set).where(eq(principals.id, agent.id));
    const dms = set.name ? await renameAgentDms(tx, agent.id, set.name) : [];
    const event = await ctx.emit({
      type: 'agent.updated',
      kind: 'Keys',
      text: texts.join('. '),
      where: agentWhere(shownName),
      aboutId: agent.id,
      ref: { type: 'agent' },
      payload: toJsonObject({
        agentId: agent.id,
        ...(renamed !== undefined ? { name: renamed } : {}),
        ...(changedFace !== undefined ? { face: changedFace } : {}),
        ...(input.runtime ? { runtime: input.runtime } : {}),
      }),
    });
    await publishAgent(ctx, agent.id, event.id);
    for (const dm of dms) await publishConversation(ctx, dm.id, event.id);
    return { agentId: agent.id };
  },
});
