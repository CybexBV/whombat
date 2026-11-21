/**
 * Where a guide happens and what it knows (docs/decisions/assistant-guides.md AG-01): a person's personal agent
 * and their DM with it in a burrow, the facts a guide's steps are built from, and posting the steps as the agent
 * inside a commit.
 */
import {
  AssistantPreferences,
  DEFAULT_ASSISTANT_PREFERENCES,
  GUIDE_ERROR_STATUS,
  type GuideAnswer,
  type GuideCard,
  type GuideErrorCode,
  newId,
  topics,
} from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import { applyContext, loadBurrowRow } from '../commit/pipeline';
import type { ApplyContext, BurrowRow } from '../commit/types';
import { googleAppStatus } from '../connectors/app';
import { connectionOfAccount } from '../connectors/lookup';
import { googleSetupFacts } from '../connectors/setup';
import type { Db } from '../db/client';
import { accounts, assistantStates, messages } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { personalDmId } from '../domain/personal-dm';
import { ApiError } from '../lib/errors';
import { type ConversationRow, loadConversationRow } from '../read/conversations';
import { loadMessages } from '../read/messages';
import { loadAgentRow, loadPrincipalRow, type PrincipalRow, shortName, toActor } from '../read/principals';
import type { Services } from '../services';
import { type GuideFacts, type GuidePost, materialize, type Step } from './flows';

/** The agent and the person's Chat with it, in one burrow. */
export interface PersonalPlace {
  burrow: BurrowRow;
  person: PrincipalRow;
  agent: PrincipalRow;
  dm: ConversationRow;
  accountId: string;
}

/** The person's place in a burrow, or null (no account, no personal agent, no DM). */
export async function personalPlace(
  db: Db,
  burrowId: string,
  personId: string,
): Promise<PersonalPlace | null> {
  const person = await loadPrincipalRow(db, personId);
  if (person?.kind !== 'person' || person.system || person.burrowId !== burrowId || !person.accountId)
    return null;
  const agent = await loadAgentRow(db, person.burrowId);
  if (!agent) return null;
  const dmId = await personalDmId(db, agent.id, person.id);
  const dm = dmId ? await loadConversationRow(db, dmId) : undefined;
  const burrow = await loadBurrowRow(db, burrowId);
  if (!dm || !burrow) return null;
  return { burrow, person, agent, dm, accountId: person.accountId };
}

/**
 * The account's places, the burrow it was most recently active in first (a read marker moved there): where the
 * agent speaks up for the account as a whole (a repair, a suggestion). A place is a burrow
 * where the person has their Chat with the agent (`personalPlace`), so a caller posting in the first one never finds
 * nowhere to post.
 */
export async function recentPlaces(
  services: Services,
  accountId: string,
): Promise<{ burrowId: string; personId: string; activeAt: Date | null }[]> {
  const rows = await services.sql<{ burrow_id: string; person_id: string; active_at: Date | null }[]>`
    select p.burrow_id, p.id as person_id,
      (select max(rs.updated_at) from read_states rs where rs.principal_id = p.id) as active_at
      from principals p
     where p.account_id = ${accountId} and p.kind = 'person' and p.system is null
       and exists (select 1 from conversations c join principals a on a.id = c.dm_agent_id
                    where c.burrow_id = p.burrow_id and c.kind = 'dm' and c.dm_person_id = p.id
                      and c.task_key is null and a.kind = 'agent')
     order by active_at desc nulls last, p.created_at asc`;
  return rows.map((r) => ({
    burrowId: r.burrow_id,
    personId: r.person_id,
    activeAt: r.active_at ? new Date(r.active_at) : null,
  }));
}

/** Inserts or updates the person's assistant state (inside the caller's transaction). */
export async function upsertAssistantState(
  tx: Db,
  place: Pick<PersonalPlace, 'burrow' | 'person' | 'accountId'>,
  set: Partial<Omit<typeof assistantStates.$inferInsert, 'burrowId' | 'personId' | 'accountId'>>,
): Promise<void> {
  await tx
    .insert(assistantStates)
    .values({ burrowId: place.burrow.id, personId: place.person.id, accountId: place.accountId, ...set })
    .onConflictDoUpdate({ target: [assistantStates.burrowId, assistantStates.personId], set });
}

/** `/{burrow}/chat`, the person's Chat in the apps (core `linkPath` of their DM). */
export function chatPathOf(place: Pick<PersonalPlace, 'burrow'>): string {
  return `/${place.burrow.slug}/chat`;
}

/** `Preferences.assistant` with its defaults. */
export function assistantPrefsOf(preferences: unknown): AssistantPreferences {
  const raw = (preferences as { assistant?: unknown } | null)?.assistant;
  const parsed = AssistantPreferences.safeParse(raw ?? DEFAULT_ASSISTANT_PREFERENCES);
  return parsed.success ? parsed.data : DEFAULT_ASSISTANT_PREFERENCES;
}

/** What a guide's steps are built from, for this person now. */
export async function loadFacts(services: Services, db: Db, place: PersonalPlace): Promise<GuideFacts> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, place.accountId));
  const app = await googleAppStatus(services);
  const connection = await connectionOfAccount(db, place.accountId, 'google');
  const prefs = (account?.preferences ?? {}) as { timeZone?: string | null };
  const mode = services.google.mode;
  return {
    personName: shortName(place.person),
    agentName: place.agent.name,
    google: {
      mode,
      enabled: mode !== 'off',
      appReady: app.configured || mode === 'fake',
      appInConfig: app.source === 'config',
    },
    connection: connection
      ? {
          email: connection.email,
          services: connection.services,
          status: connection.status,
          checks: connection.checks,
        }
      : null,
    setup: googleSetupFacts(services.config, account?.email ?? null),
    timeZone: prefs.timeZone || place.burrow.timeZone,
    chatPath: chatPathOf(place),
    threadRootId: null,
    dontAsk: assistantPrefsOf(account?.preferences).dontAsk,
  };
}

/** The same commit, acting as the agent (its messages and events are signed with its key). */
export function agentContext(ctx: ApplyContext, agent: PrincipalRow): ApplyContext {
  if (ctx.actor.id === agent.id) return ctx;
  return applyContext(ctx, {
    ...ctx,
    actor: toActor(agent),
    decision: null,
    requirement: null,
    onBehalfOf: {},
  });
}

/**
 * Posts a guide’s steps in the person’s Chat as their agent, inside the caller’s commit: in `threadRootId`’s thread,
 * so a guide stays in one thread instead of filling the Chat, or each at the top of the Chat without one. Never wakes
 * anyone (`dispatch: false`); `notify` tells the person (inbox, push) — not for the answer to their own click.
 */
export async function postSteps(
  ctx: ApplyContext,
  place: PersonalPlace,
  steps: readonly Step[],
  facts: GuideFacts,
  options: { notify: boolean; threadRootId?: string | null },
): Promise<GuidePost[]> {
  const threadRootId = options.threadRootId ?? null;
  const posts = materialize(steps, { ...facts, threadRootId }, () => newId('message'));
  const as = agentContext(ctx, place.agent);
  for (const post of posts) {
    await postMessage(as, {
      conversation: place.dm,
      id: post.id,
      threadRootId,
      text: post.text,
      card: post.card,
      dispatch: false,
      notifyDmPerson: options.notify,
    });
  }
  return posts;
}

/** Locks an open guide card with the person's answer, publishes it and signs the event. False: it was closed. */
export async function lockCard(
  ctx: ApplyContext,
  message: { id: string; conversationId: string; authorId: string },
  card: GuideCard,
  answer: GuideAnswer | null,
  state: 'done' | 'expired' = 'done',
): Promise<boolean> {
  const locked: GuideCard = { ...card, state, answer };
  const [taken] = await ctx.tx
    .update(messages)
    .set({ card: locked })
    .where(and(eq(messages.id, message.id), sql`${messages.card}->>'state' = 'open'`))
    .returning();
  if (!taken) return false;
  const event = await ctx.emit({
    type: state === 'done' ? 'message.guide_answered' : 'message.guide_expired',
    kind: 'Messages',
    text: null,
    where: null,
    aboutId: message.authorId,
    payload: {
      messageId: message.id,
      guide: card.guide,
      node: card.node,
      actionId: answer?.actionId ?? null,
    },
  });
  const [loaded] = await loadMessages(ctx.tx, [taken], null);
  if (loaded)
    ctx.publish(
      topics.conversation(message.conversationId),
      { type: 'message.updated', message: loaded },
      {
        eventId: event.id,
      },
    );
  return true;
}

/** A `guides.act` refusal: the generic code with `details.code` (CT-81). */
export function guideError(
  code: GuideErrorCode,
  message: string,
  fields?: Record<string, string[]>,
): ApiError {
  return new ApiError(GUIDE_ERROR_STATUS[code], message, {
    details: { code },
    ...(fields ? { fields } : {}),
  });
}
