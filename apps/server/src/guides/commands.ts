/**
 * The guide commands (docs/decisions/assistant-guides.md AG-03, AG-07, AG-18), in the commit pipeline:
 *
 * - `guide_act` (the person): the `request_more` pattern — a guarded update locks the card with the answer,
 *   the signed event and `message.updated` go out, the guide's effects run and its next steps are posted as the
 *   agent with `dispatch: false`. Form values never reach this command: the route saves the Google
 *   client first and passes only what the locked card may say (`saved`).
 * - `start_guide` (the agent, from its MCP tools).
 */
import {
  AssistantPreferences,
  ConnectionId,
  ConversationId,
  DONT_ASK_MAX,
  GuideElementId,
  GuideVaultOutcome,
  GuideVaultRefusal,
  MessageId,
  StartableGuideTopic,
  VaultEntryId,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import { claimFoundTold, foundNowFor } from '../connections/found-scans';
import type { Db, Tx } from '../db/client';
import { accounts } from '../db/schema/index';
import { enqueueDispatches } from '../domain/dispatch';
import { turnPerson } from '../domain/turn-person';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow } from '../read/messages';
import { loadPrincipalRow } from '../read/principals';
import { type GuideEffect, GuideRefusal, type SuggestedTopic, startSteps, transition } from './flows';
import {
  assistantPrefsOf,
  guideError,
  loadFacts,
  lockCard,
  type PersonalPlace,
  personalPlace,
  postSteps,
} from './place';
import { welcomeSteps } from './welcome';

export const NOT_PERSONAL_GUIDE_TEXT = 'Guides run only in a turn for the person they are for.';

/** A guide refusal as the API error clients get (CT-81). */
export function refusalError(err: unknown): unknown {
  if (!(err instanceof GuideRefusal)) return err;
  if (err.code === 'bad_request') return badRequest(err.message);
  return guideError(err.code, err.message, err.fields);
}

/**
 * The guide card a person acts on, checked: theirs and still open. A guide card is in their own Chat, from their own
 * assistant; a Vault card (`secret`, vault-simplify.md VLT-41) may be in any room of theirs, posted by their assistant in
 * the thread its work is in.
 */
export async function guideTarget(tx: Db, burrowId: string, messageId: string, actorId: string) {
  const row = await loadMessageRow(tx, messageId);
  if (!row || row.burrowId !== burrowId) throw notFound('Message');
  const card = row.card;
  if (card?.kind !== 'guide') throw badRequest('That message has no guide card.');
  const conversation = await loadConversationRow(tx, row.conversationId);
  const place = await personalPlace(tx, burrowId, actorId);
  const yours = 'Only the person this conversation belongs to can answer it.';
  if (!conversation || !place || row.authorId !== place.agent.id) throw guideError('not_yours', yours);
  const inChat =
    conversation.kind === 'dm' && conversation.dmPersonId === actorId && place.dm.id === conversation.id;
  if (!inChat && card.guide !== 'secret') throw guideError('not_yours', yours);
  if (card.state !== 'open') throw guideError('guide_closed', 'This was answered already.');
  return { row, card, place };
}

export const actOnGuide = defineCommand({
  name: 'guide_act',
  schema: z.object({
    messageId: MessageId,
    actionId: GuideElementId,
    optionIds: z.array(GuideElementId).min(1).max(8).optional(),
    /** The Google client the route saved for the app setup's form: what the locked card says, never a secret. */
    saved: z.object({ clientIdHint: z.string().min(1).max(40), redirectListed: z.boolean() }).optional(),
    /**
     * How the route answered a `secret` card (connect-in-chat.md, vault-simplify.md): the entry it went to, how it ended,
     * a server's name and whether to wake the agent. Never the value.
     */
    vault: z
      .object({
        entryId: VaultEntryId.optional(),
        name: z.string().min(1).max(200),
        outcome: GuideVaultOutcome,
        refusal: GuideVaultRefusal.optional(),
        server: z.string().min(1).max(40).optional(),
        wake: z.boolean(),
      })
      .optional(),
    /** How the route answered a card that connects on the card (connect-by-talking.md): never the key. */
    connect: z
      .object({
        connectionId: ConnectionId.optional(),
        name: z.string().min(1).max(200),
        outcome: z.enum(['connected', 'declined']),
        wake: z.boolean(),
      })
      .optional(),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw guideError('not_yours', 'Only people answer guide cards.');
    const { row, card, place } = await guideTarget(tx, ctx.burrow.id, input.messageId, ctx.actor.id);
    const facts = await loadFacts(ctx.services, tx, place);
    let t: ReturnType<typeof transition>;
    try {
      t = transition(card, input, facts, input.saved, input.vault, input.connect);
    } catch (err) {
      throw refusalError(err);
    }
    // “Ask Dusty” starts an agent turn (LC-10).
    if (t.effects.some((e) => e.kind === 'wake_agent')) ctx.services.licence.assertNotLapsed();
    const answer = {
      actionId: input.actionId,
      optionIds: input.optionIds ?? null,
      label: t.label,
      at: ctx.at,
      ...(t.vault?.entryId ? { vaultEntryId: t.vault.entryId } : {}),
      ...(t.vault ? { vaultOutcome: t.vault.outcome } : {}),
      ...(t.vault?.refusal ? { vaultRefusal: t.vault.refusal } : {}),
      ...(t.vault?.server ? { vaultServer: t.vault.server } : {}),
      ...(t.connect?.connectionId ? { connectionId: t.connect.connectionId } : {}),
    };
    if (!(await lockCard(ctx, row, card, answer)))
      throw guideError('guide_closed', 'This was answered already.');
    for (const effect of t.effects) await runEffect(ctx, place, effect, row);
    // The next steps go in the card's thread, or under the card when it is at the top of the Chat (a welcome, a
    // suggestion): the guide stays in one thread.
    await postSteps(ctx, place, t.next, facts, { notify: false, threadRootId: row.threadRootId ?? row.id });
    return { ok: true as const };
  },
});

async function runEffect(
  ctx: ApplyContext,
  place: PersonalPlace,
  effect: GuideEffect,
  message: { id: string; threadRootId: string | null; conversationId: string },
): Promise<void> {
  switch (effect.kind) {
    case 'save_google_app':
      return; // saved by the route before this commit (account-level, CN-07)
    case 'dont_ask':
      await addDontAsk(ctx.tx, place.accountId, effect.topic);
      return;
    case 'wake_agent': {
      // “I’m stuck → Ask Dusty” (AG-06): the person's own request, with the stuck card as the trigger; a Vault card's
      // answer wakes the turn in the card's own room and thread (connect-in-chat.md, vault-simplify.md VLT-41).
      const services = ctx.services;
      const inChat = message.conversationId === place.dm.id;
      const args = {
        burrowId: place.burrow.id,
        causedById: place.person.id,
        conversationId: message.conversationId,
        messageId: message.id,
        threadRootId: message.threadRootId,
        requests: [{ agentId: place.agent.id, trigger: inChat ? ('dm' as const) : ('mention' as const) }],
        at: ctx.now,
      };
      ctx.after(async () => {
        await enqueueDispatches(services, args);
      });
      return;
    }
  }
}

/** “Don’t ask again” (AG-11): the topic joins `Preferences.assistant.dontAsk`. */
export async function addDontAsk(tx: Tx, accountId: string, topic: SuggestedTopic | 'skills'): Promise<void> {
  const [row] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
  if (!row) return;
  const prefs = assistantPrefsOf(row.preferences);
  const assistant = AssistantPreferences.parse({
    suggestions: prefs.suggestions,
    dontAsk: [...new Set([...prefs.dontAsk, topic])].slice(-DONT_ASK_MAX),
  });
  await tx
    .update(accounts)
    .set({ preferences: { ...row.preferences, assistant } })
    .where(eq(accounts.id, accountId));
}

/** The agent acting, and the person's place (its MCP tools; none in an outsiders' turn, one-person.md OP-S41). */
async function ownPlace(tx: Tx, ctx: ApplyContext): Promise<PersonalPlace> {
  const agent = await loadPrincipalRow(tx, ctx.actor.id);
  if (agent?.kind !== 'agent') throw forbidden(NOT_PERSONAL_GUIDE_TEXT);
  const person = await turnPerson(tx, {
    burrowId: ctx.burrow.id,
    agentId: agent.id,
  });
  if (!person) throw forbidden(NOT_PERSONAL_GUIDE_TEXT);
  const place = await personalPlace(tx, ctx.burrow.id, person.id);
  if (!place || place.agent.id !== agent.id) throw notFound('Your Chat with the person');
  return place;
}

/**
 * `start_guide` (AG-01): the guide's first card(s) in the person's Chat, in the thread the turn works in when that is
 * in their Chat (else at the top of it); answers the first card's message id. The welcome names what the network scan
 * found, as the first one does (first-day.md).
 */
export const startGuide = defineCommand({
  name: 'start_guide',
  schema: z.object({
    topic: StartableGuideTopic,
    /** The turn's conversation and thread (the tool fills them in from its dispatch). */
    conversationId: ConversationId.optional(),
    threadRootId: MessageId.nullable().optional(),
  }),
  async apply(tx, ctx, input) {
    const place = await ownPlace(tx, ctx);
    const facts = await loadFacts(ctx.services, tx, place);
    const steps =
      input.topic === 'welcome'
        ? await welcomeAgain(tx, ctx, place.person.id)
        : startSteps(input.topic, facts);
    const threadRootId = input.conversationId === place.dm.id ? (input.threadRootId ?? null) : null;
    const posts = await postSteps(ctx, place, steps, facts, { notify: true, threadRootId });
    const first = posts.find((p) => p.card) ?? posts[0];
    if (!first) throw badRequest('There is no guide for that.');
    return { messageId: first.id };
  },
});

/** The welcome when the agent starts it again: the scan's finds named (and the telling claimed), else without them. */
async function welcomeAgain(tx: Tx, ctx: ApplyContext, personId: string) {
  const found = await foundNowFor(ctx.services, ctx.burrow.id, personId);
  const told = found.finds.length > 0 && (await claimFoundTold(tx, ctx.burrow.id, ctx.now));
  return welcomeSteps(told ? found : { ...found, finds: [] });
}

export const GUIDE_COMMANDS = [actOnGuide, startGuide];
