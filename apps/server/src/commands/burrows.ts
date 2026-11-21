/** Burrows and onboarding: create, rename, repos on/off, "Open {burrow}". */
import {
  AgentProvider,
  agentsReachLanOn,
  BurrowName,
  GATEWAY_PROVIDERS,
  gatewayKeysText,
  isValidBurrowSlug,
  LIVE_PROVIDERS,
  LiveProvider,
  LocalModelCheck,
  localModelKeysText,
  localModelName,
  newId,
  ONBOARDING_PROVIDER_STEP,
  OnboardingStep,
  RepoId,
  SetAgentsReachLanBody,
  SetAiGatewayBody,
  SetLocalModelBody,
  slugify,
  TestLocalModelBody,
  toneFor,
  topics,
} from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { applyContext } from '../commit/pipeline';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import { managedAppOrigin } from '../config';
import { accounts, burrows, ONBOARDING_LAST_STEP, onboardingStepOf, repos } from '../db/schema/index';
import { insertPerson } from '../domain/members';
import { createTheAgent, ensureChatWithAgent } from '../domain/the-agent';
import { replaceAvatar } from '../files/avatars';
import { gatewayConnectionOf, gatewayName, isGatewayCatalogId, switchesOf } from '../gateway/store';
import { ApiError, conflict, notFound } from '../lib/errors';
import { iso } from '../lib/time';
import {
  KEY_ORIGIN_TEXT,
  keyFor,
  localModelChange,
  localModelKeyOf,
  sealLocalModelKey,
} from '../local-model/store';
import { agentRuntimeOf, loadPrincipalRow, toActor } from '../read/principals';
import { burrowView } from '../read/views';
import type { Services } from '../services';
import { updateAgent } from './agents';

/** A second burrow on an appliance (one-agent.md OA-01). */
export const ONE_BURROW_TEXT = 'This Whombat already has its burrow.';

/**
 * The base of links the server writes (parity G-10, MR-45): the hosted UI at this appliance
 * (`WHOMBAT_APP_URL/appliances/<device id>`) — never a relative path.
 */
export function webOrigin(services: Services): string {
  return services.links.managedBase ?? managedAppOrigin(services.config);
}

/** `app.whombat.com/{slug}`: where the burrow lives (“is taken”, the log's “where” for burrow events). */
export function burrowWhere(services: Services, slug: string): string {
  // The hosted UI's host and the appliance's path, without the scheme: `app.whombat.com/appliances/dev-1/burrow-hq`.
  return `${webOrigin(services).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')}/${slug}`;
}

/** The person an account becomes in a burrow: its name (else the email's name part) and title. */
export function personFromAccount(account: { name: string; title: string; email: string }, fallback: string) {
  return {
    name: account.name.trim() || account.email.split('@')[0] || fallback,
    title: account.title.trim() || null,
  };
}

/** `burrow.updated` with the burrow as clients see it, its AI gateway included (AIG-05). */
export async function publishBurrow(
  ctx: ApplyContext,
  row: typeof burrows.$inferSelect,
  eventId: string | null,
): Promise<void> {
  ctx.publish(
    topics.burrow(row.id),
    { type: 'burrow.updated', burrow: await burrowView(ctx.tx, row) },
    { eventId },
  );
}

/**
 * Onboarding step 1: a new burrow with the caller as its person, its one agent (one-agent.md OA-01) with the person's
 * Chat and the signed `burrow.created` event. Account-level: the person's principal is created in the same
 * transaction. An appliance holds one burrow: a second one is refused (OA-01).
 */
export async function createBurrow(
  services: Services,
  accountId: string,
  name: string,
  options: {
    timeZone?: string;
    /** Tests of what reads several burrows only: one more beside the box's own (never from a request). */
    besideOwn?: boolean;
  } = {},
): Promise<{ burrowId: string; principalId: string }> {
  const parsedName = BurrowName.parse(name);
  const slug = slugify(parsedName);
  if (!isValidBurrowSlug(slug)) throw new ApiError('slug_taken', `${slug} can’t be used as an address.`);
  const [taken] = await services.db.select({ id: burrows.id }).from(burrows).where(eq(burrows.slug, slug));
  if (taken) throw new ApiError('slug_taken', `${burrowWhere(services, slug)} is taken.`);
  const [account] = await services.db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) throw notFound('Account');
  if (!options.besideOwn) {
    const [existing] = await services.db.select({ id: burrows.id }).from(burrows).limit(1);
    if (existing) throw conflict(ONE_BURROW_TEXT);
  }

  const burrowId = newId('burrow');
  const { result } = await services.pipeline.transact(burrowId, async (session) => {
    const now = services.clock();
    const [row] = await session.tx
      .insert(burrows)
      .values({
        id: burrowId,
        name: parsedName,
        slug,
        timeZone: options.timeZone ?? account.preferences.timeZone ?? 'Europe/Amsterdam',
        createdByAccountId: accountId,
        // “Set up your AI” comes right after naming the burrow (CT-68).
        onboarding: { step: ONBOARDING_PROVIDER_STEP, githubConnected: false, completedAt: null },
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new ApiError('slug_taken', `${burrowWhere(services, slug)} is taken.`);
    const principalId = await insertPerson(session, {
      burrowId,
      ...personFromAccount(account, 'Owner'),
      email: account.email,
      accountId,
      tone: toneFor(3),
      createdAt: now,
    });
    const actorRow = await loadPrincipalRow(session.tx, principalId);
    if (!actorRow) throw new Error('owner row missing');
    const ctx = applyContext(session, {
      burrow: row,
      actor: toActor(actorRow),
      now,
      at: iso(now),
      decision: null,
      requirement: null,
      approvalId: null,
      onBehalfOf: {},
    });
    // The account's photo, like its name (docs/decisions/person-avatars.md PVA-09).
    const photo = account.avatar ? await replaceAvatar(ctx, actorRow, account.avatar) : null;
    await ctx.emit({
      type: 'burrow.created',
      kind: 'System',
      text: `Created ${parsedName}`,
      where: burrowWhere(services, slug),
      payload: {
        burrowId,
        slug,
        ...(photo?.next ? { avatarAttachmentId: photo.next.id, avatarSha256: photo.next.sha256 ?? '' } : {}),
      },
    });
    // The Whombat's one agent, made with it (OA-01), and the person's Chat with it.
    await createTheAgent(ctx);
    await ensureChatWithAgent(ctx, actorRow);
    return { burrowId, principalId };
  });
  return result;
}

const renameOrZone = z.object({
  name: BurrowName.optional(),
  timeZone: z.string().min(1).optional(),
  /** Link previews under messages (CT-174; docs/decisions/essentials-conversations.md EC-21). */
  linkPreviews: z.boolean().optional(),
});

async function rename(ctx: ApplyContext, input: z.output<typeof renameOrZone>) {
  const set: Partial<typeof burrows.$inferInsert> = {};
  const texts: string[] = [];
  if (input.name && input.name !== ctx.burrow.name) {
    set.name = input.name;
    texts.push(`Renamed this Whombat to ${input.name}`);
  }
  if (input.timeZone && input.timeZone !== ctx.burrow.timeZone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.timeZone });
    } catch {
      throw new ApiError('validation_failed', 'Unknown time zone.', {
        fields: { timeZone: ['Unknown time zone'] },
      });
    }
    set.timeZone = input.timeZone;
    texts.push(`Set this Whombat’s time zone to ${input.timeZone}`);
  }
  if (input.linkPreviews !== undefined && input.linkPreviews !== (ctx.burrow.linkPreviews !== false)) {
    set.linkPreviews = input.linkPreviews;
    texts.push(input.linkPreviews ? 'Turned link previews on' : 'Turned link previews off');
  }
  if (texts.length === 0) return;
  const [row] = await ctx.tx.update(burrows).set(set).where(eq(burrows.id, ctx.burrow.id)).returning();
  const event = await ctx.emit({
    type: set.name ? 'burrow.renamed' : 'burrow.updated',
    kind: 'System',
    text: texts.join('. '),
    where: burrowWhere(ctx.services, ctx.burrow.slug),
    payload: {
      name: input.name ?? null,
      timeZone: input.timeZone ?? null,
      ...(set.linkPreviews !== undefined ? { linkPreviews: set.linkPreviews } : {}),
    },
  });
  if (row) {
    ctx.burrow = row;
    await publishBurrow(ctx, row, event.id);
  }
}

const manage = (attempt: string) => ({ keyId: 'burrow.manage' as const, attempt, where: null });

export const updateBurrow = defineCommand({
  name: 'update_burrow',
  schema: renameOrZone,
  requiredKey: () => manage('change this Whombat’s settings'),
  async apply(_tx, ctx, input) {
    await rename(ctx, input);
    return { burrowId: ctx.burrow.id };
  },
});

/**
 * “Agents may reach your local network” (resourceful-agents.md RA-41, RA-DC17): the person (`burrow.manage`) opens or
 * closes the appliance's own networks to the agent's commands; its next command follows (`DispatchCommandsContext.lan`). One signed
 * `burrow.agents_lan_changed` (Keys); nothing changes and nothing is signed when it already is as asked.
 */
export const setAgentsReachLan = defineCommand({
  name: 'set_agents_reach_lan',
  schema: SetAgentsReachLanBody,
  requiredKey: () => manage('change whether agents reach this network'),
  async apply(tx, ctx, input) {
    if (input.agentsReachLan === agentsReachLanOn({ agentsReachLan: ctx.burrow.agentsReachLan ?? undefined }))
      return { burrowId: ctx.burrow.id, eventId: null };
    const [row] = await tx
      .update(burrows)
      .set({ agentsReachLan: input.agentsReachLan })
      .where(eq(burrows.id, ctx.burrow.id))
      .returning();
    const event = await ctx.emit({
      type: 'burrow.agents_lan_changed',
      kind: 'Keys',
      text: input.agentsReachLan
        ? 'Let agents reach the local network'
        : 'Closed the local network to agents (home networks only)',
      where: burrowWhere(ctx.services, ctx.burrow.slug),
      payload: { agentsReachLan: input.agentsReachLan },
    });
    if (row) {
      ctx.burrow = row;
      await publishBurrow(ctx, row, event.id);
    }
    return { burrowId: ctx.burrow.id, eventId: event.id };
  },
});

/**
 * The AI gateway's switches (docs/decisions/ai-gateway.md AIG-05, AIG-06): the person (`burrow.manage`) sends Claude Code
 * or Codex turns through the burrow's gateway connection, or stops. One signed `burrow.ai_gateway_changed` (Keys) per switch
 * that changes, in the words of `gatewayKeysText` (a Fusebox's says it overrides the provider's terms); nothing is
 * signed when it already is as asked. Turns that start afterwards follow it (AIG-07); the burrow is published, and the
 * pool (`usage.gateway_updated`) shows the switches. Without a gateway connection: `not_found`.
 */
export const setAiGateway = defineCommand({
  name: 'set_ai_gateway',
  schema: SetAiGatewayBody,
  requiredKey: () => manage('change where Claude Code and ChatGPT turns go'),
  async apply(tx, ctx, input) {
    const connection = await gatewayConnectionOf(tx, ctx.burrow.id);
    if (!connection || !isGatewayCatalogId(connection.catalogId)) throw notFound('AI gateway connection');
    const before = switchesOf(ctx.burrow.aiGateway, connection.id);
    const next = {
      claude: input.claude ?? before.claude,
      codex: input.codex ?? before.codex,
    };
    const changed = GATEWAY_PROVIDERS.filter((p) => before[p] !== next[p]);
    if (!changed.length) return { burrowId: ctx.burrow.id, eventId: null as string | null };
    const [row] = await tx
      .update(burrows)
      .set({ aiGateway: { connectionId: connection.id, ...next } })
      .where(eq(burrows.id, ctx.burrow.id))
      .returning();
    const name = gatewayName(connection);
    let eventId: string | null = null;
    for (const provider of changed) {
      const event = await ctx.emit({
        type: 'burrow.ai_gateway_changed',
        kind: 'Keys',
        text: gatewayKeysText({
          actor: ctx.actor.shortName,
          provider,
          on: next[provider],
          name,
          kind: connection.catalogId,
        }),
        where: 'Settings · Connections',
        payload: { connectionId: connection.id, provider, on: next[provider] },
      });
      eventId = event.id;
    }
    if (row) {
      ctx.burrow = row;
      await publishBurrow(ctx, row, eventId);
    }
    ctx.publish(
      topics.burrow(ctx.burrow.id),
      { type: 'usage.gateway_updated', connectionId: connection.id },
      { eventId },
    );
    return { burrowId: ctx.burrow.id, eventId };
  },
});

/** `validation_failed` on `apiKey`: a saved key would go to another server (CT-1171's same-origin rule). */
function keyOriginRefused(): never {
  throw new ApiError('validation_failed', KEY_ORIGIN_TEXT, { fields: { apiKey: [KEY_ORIGIN_TEXT] } });
}

/** The saved model on the network with its key opened, or null. */
function savedLocalModel(ctx: Pick<ApplyContext, 'burrow' | 'services'>) {
  const stored = ctx.burrow.localModel;
  return stored ? { ...stored, key: localModelKeyOf(ctx.services.custody, ctx.burrow) } : null;
}

/**
 * The model on the person's network (docs/decisions/hermes-engine.md HE-08, HE-32, HE-S90…; CT-1171): the person
 * (`burrow.manage`) saves its address, model, name and key. A key left out stays only while the address keeps its origin
 * (`keyFor`); the key is sealed (`burrows.local_model_key_enc`). A save forgets the last test (`check` null): the route
 * tests it at once and keeps the result (`recordLocalModelCheck`) unless it changed meanwhile (`updatedAt`). One signed
 * `burrow.local_model_changed` (Keys, `localModelKeysText`, never the key); nothing is signed when nothing changed.
 * Returns what the route tests.
 */
export const setLocalModel = defineCommand({
  name: 'set_local_model',
  schema: SetLocalModelBody,
  requiredKey: () => manage('set up the model on your network'),
  async apply(tx, ctx, input) {
    const saved = savedLocalModel(ctx);
    const key = keyFor(input.apiKey, saved, input.baseUrl);
    if (key === 'refused') keyOriginRefused();
    const next = { baseUrl: input.baseUrl, model: input.model, label: input.label ?? null, key: key.key };
    const target = { baseUrl: next.baseUrl, model: next.model, apiKey: next.key };
    const change = localModelChange(saved, next);
    if (!change && saved)
      return { burrowId: ctx.burrow.id, eventId: null as string | null, target, updatedAt: saved.updatedAt };
    const updatedAt = ctx.at;
    const [row] = await tx
      .update(burrows)
      .set({
        localModel: { baseUrl: next.baseUrl, model: next.model, label: next.label, check: null, updatedAt },
        localModelKeyEnc: next.key ? sealLocalModelKey(ctx.services.custody, ctx.burrow.id, next.key) : null,
      })
      .where(eq(burrows.id, ctx.burrow.id))
      .returning();
    const event = await ctx.emit({
      type: 'burrow.local_model_changed',
      kind: 'Keys',
      text: localModelKeysText({
        actor: ctx.actor.shortName,
        change: change ?? 'set',
        name: localModelName(next),
      }),
      where: 'Settings · AI',
      payload: { change: change ?? 'set' },
    });
    if (row) {
      ctx.burrow = row;
      await publishBurrow(ctx, row, event.id);
    }
    return { burrowId: ctx.burrow.id, eventId: event.id as string | null, target, updatedAt };
  },
});

/**
 * Before a test of the model on the person's network (CT-1171): the person only (`burrow.manage`), and what it tries — a
 * draft with its key (absent: the saved one under the same-origin rule), else the saved model (`not_found` without
 * one) with its `updatedAt`, so its result is kept only for it. Writes nothing: the route tests outside the transaction.
 */
export const prepareLocalModelTest = defineCommand({
  name: 'prepare_local_model_test',
  schema: TestLocalModelBody,
  requiredKey: () => manage('test the model on your network'),
  async apply(_tx, ctx, input) {
    const saved = savedLocalModel(ctx);
    if (input.draft) {
      const key = keyFor(input.draft.apiKey, saved, input.draft.baseUrl);
      if (key === 'refused') keyOriginRefused();
      return {
        target: { baseUrl: input.draft.baseUrl, model: input.draft.model, apiKey: key.key },
        updatedAt: null as string | null,
      };
    }
    if (!saved) throw notFound('Model on your network');
    return {
      target: { baseUrl: saved.baseUrl, model: saved.model, apiKey: saved.key },
      updatedAt: saved.updatedAt as string | null,
    };
  },
});

/**
 * A test's result kept on the saved model (`LocalModelView.check`) and the burrow published — only while the model is
 * the one tested (`updatedAt`): a save in between keeps its own. Not signed: nothing about the model changed.
 */
export const recordLocalModelCheck = defineCommand({
  name: 'record_local_model_check',
  schema: z.object({ updatedAt: z.string().min(1), check: LocalModelCheck }),
  requiredKey: () => manage('check the model on your network'),
  async apply(tx, ctx, input) {
    const [row] = await tx
      .update(burrows)
      .set({
        localModel: sql`jsonb_set(${burrows.localModel}, '{check}', ${JSON.stringify(input.check)}::jsonb)`,
      })
      .where(
        and(eq(burrows.id, ctx.burrow.id), sql`${burrows.localModel}->>'updatedAt' = ${input.updatedAt}`),
      )
      .returning();
    if (!row) return { kept: false };
    ctx.burrow = row;
    await publishBurrow(ctx, row, null);
    return { kept: true };
  },
});

/**
 * Removing the model on the person's network and its key (CT-1171): the person (`burrow.manage`). The agent and Chat threads
 * on `local` keep that choice and can't reply until one is set again. One signed `burrow.local_model_changed`
 * (`removed`); nothing when there was none.
 */
export const clearLocalModel = defineCommand({
  name: 'clear_local_model',
  schema: z.object({}),
  requiredKey: () => manage('remove the model on your network'),
  async apply(tx, ctx) {
    const saved = ctx.burrow.localModel;
    if (!saved && !ctx.burrow.localModelKeyEnc)
      return { burrowId: ctx.burrow.id, removed: false, eventId: null as string | null };
    const [row] = await tx
      .update(burrows)
      .set({ localModel: null, localModelKeyEnc: null })
      .where(eq(burrows.id, ctx.burrow.id))
      .returning();
    const event = await ctx.emit({
      type: 'burrow.local_model_changed',
      kind: 'Keys',
      text: localModelKeysText({
        actor: ctx.actor.shortName,
        change: 'removed',
        name: saved ? localModelName(saved) : '',
      }),
      where: 'Settings · AI',
      payload: { change: 'removed' },
    });
    if (row) {
      ctx.burrow = row;
      await publishBurrow(ctx, row, event.id);
    }
    return { burrowId: ctx.burrow.id, removed: true, eventId: event.id as string | null };
  },
});

export const updateOnboarding = defineCommand({
  name: 'update_onboarding',
  schema: z.object({
    step: OnboardingStep.optional(),
    burrowName: BurrowName.optional(),
    /** “Set up your AI”: the chosen clients (CT-68); the route asks to install them (`clients.install`). */
    clients: z.array(LiveProvider).max(LIVE_PROVIDERS.length).optional(),
    provider: AgentProvider.optional(),
    /** “Meet your agent” (one-agent.md OA-13, OA-08): its name and face, saved on the agent itself. */
    agentName: z.string().trim().max(24).optional(),
    agentFace: z.enum(['dusty', 'banjo', 'neo', 'skipper', 'hazel']).optional(),
  }),
  requiredKey: () => manage('set up this Whombat'),
  async apply(tx, ctx, input) {
    if (input.burrowName) await rename(ctx, { name: input.burrowName });
    if (input.agentName !== undefined || input.agentFace !== undefined) {
      await updateAgent.apply(tx, ctx, {
        ...(input.agentName !== undefined ? { name: input.agentName } : {}),
        ...(input.agentFace !== undefined ? { face: input.agentFace } : {}),
      });
    }
    const onboarding = { ...ctx.burrow.onboarding };
    if (input.step !== undefined) onboarding.step = onboardingStepOf({ step: input.step });
    if (input.clients) onboarding.clients = [...new Set(input.clients)];
    if (input.provider) onboarding.provider = input.provider;
    await tx.update(burrows).set({ onboarding }).where(eq(burrows.id, ctx.burrow.id));
    return { burrowId: ctx.burrow.id };
  },
});

export const setRepoEnabled = defineCommand({
  name: 'set_repo_enabled',
  schema: z.object({ repoId: RepoId, enabled: z.boolean() }),
  requiredKey: (input) => manage(`switch ${input.enabled ? 'on' : 'off'} a repo`),
  async apply(tx, ctx, input) {
    const [repo] = await tx
      .select()
      .from(repos)
      .where(and(eq(repos.id, input.repoId), eq(repos.burrowId, ctx.burrow.id)));
    if (!repo) throw notFound('Repository');
    if (repo.enabled === input.enabled) return { repoId: repo.id };
    await tx.update(repos).set({ enabled: input.enabled }).where(eq(repos.id, repo.id));
    await ctx.emit({
      type: input.enabled ? 'repo.enabled' : 'repo.disabled',
      kind: 'System',
      text: `Switched ${input.enabled ? 'on' : 'off'} ${repo.fullName}`,
      where: repo.fullName,
      payload: { repoId: repo.id, enabled: input.enabled },
    });
    return { repoId: repo.id };
  },
});

/**
 * "Open {burrow}" (one-agent.md OA-13; one-person.md OP-S03): the agent's provider if setup picked one, onboarding done.
 * The agent itself was made with the burrow; “Meet your agent” named it (`updateOnboarding`).
 */
export const completeOnboarding = defineCommand({
  name: 'complete_onboarding',
  schema: z.object({ provider: AgentProvider.optional() }),
  requiredKey: () => manage('finish setting up this Whombat'),
  async apply(tx, ctx, input) {
    // Step 2's pick (sent now, or saved with the progress); none = this Whombat's default, as the agent was made.
    const provider = input.provider ?? ctx.burrow.onboarding.provider ?? undefined;
    const agent = await createTheAgent(ctx);
    if (provider && agentRuntimeOf(agent.runtime).provider !== provider)
      await updateAgent.apply(tx, ctx, { runtime: { provider } });
    const owner = await loadPrincipalRow(tx, ctx.actor.id);
    if (owner) await ensureChatWithAgent(ctx, owner);
    const onboarding = { ...ctx.burrow.onboarding, step: ONBOARDING_LAST_STEP, completedAt: ctx.at };
    await tx.update(burrows).set({ onboarding }).where(eq(burrows.id, ctx.burrow.id));
    await ctx.emit({
      type: 'onboarding.completed',
      kind: 'System',
      text: null,
      where: burrowWhere(ctx.services, ctx.burrow.slug),
      payload: { agentId: agent.id },
    });
    return { agentId: agent.id, redirectTo: `/${ctx.burrow.slug}` };
  },
});
