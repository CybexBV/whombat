/**
 * The guide engine's server side (docs/decisions/assistant-guides.md AG-01…AG-13): the welcome (once),
 * the hooks other parts of the server call (Google connected or failed, the Google app saved, a connection that
 * needs reauth) and the hourly job (suggestions, expiry of old cards). Every post is a transaction of the commit pipeline holding the burrow's lock, signed by the agent.
 */
import {
  CONNECT_HERE_DECLINE,
  CONNECT_HERE_FORM,
  type ConnectErrorCode,
  type ConnectionConnectError,
  type ConnectorService,
  clientIdHint,
  connectHereLocked,
  type GuideActBody,
  type GuideCard,
  type ReauthReason,
  VAULT_ASK_DECLINE,
} from '@whombat/core';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { applyContext, loadBurrowRow } from '../commit/pipeline';
import type { ApplyContext } from '../commit/types';
import { answerConnectHere, declineConnectHere, hostOfAddress } from '../connections/ask';
import { claimFoundTold, foundNowFor, foundScansFor } from '../connections/found-scans';
import { saveGoogleApp } from '../connectors/app';
import { accounts, assistantStates, connections, messages, principals } from '../db/schema/index';
import { enqueueDispatches } from '../domain/dispatch';
import { postMessage } from '../domain/messages';
import { ApiError } from '../lib/errors';
import { iso } from '../lib/time';
import { loadConversationRow } from '../read/conversations';
import { loadPrincipalRow, toActor } from '../read/principals';
import type { Services } from '../services';
import { declineVaultAsk, saveVaultAsk } from '../vault/ask';
import { parseAppForm } from './app-form';
import { guideTarget, refusalError } from './commands';
import {
  followUps,
  type GuideFacts,
  repairStep,
  resultStep,
  retrySteps,
  type SavedApp,
  type SavedConnection,
  type SavedVault,
  type Step,
  suggestionStep,
} from './flows';
import {
  assistantPrefsOf,
  guideError,
  loadFacts,
  lockCard,
  type PersonalPlace,
  personalPlace,
  postSteps,
  recentPlaces,
  upsertAssistantState,
} from './place';
import { GUIDE_EXPIRY_MS, pickSuggestion, suggestionDue } from './suggestions';
import { welcomeSteps } from './welcome';

const HOUR_MS = 3_600_000;
const REPAIR_SPACING_MS = 24 * HOUR_MS;
const FIRST_HOURLY_MS = 5 * 60_000;

/** What `finishGoogle` tells the guides (AG-08). */
export interface GoogleOutcome {
  accountId: string;
  returnPath: string;
  requested: readonly ConnectorService[];
  outcome: { connectionId: string } | { error: ConnectErrorCode };
}

/** What `finishConnectionOAuth` tells the guides when a connect card started the sign-in. */
export interface ConnectionOAuthOutcome {
  accountId: string;
  burrowId: string;
  returnPath: string;
  catalogId: string;
  outcome: { connectionId: string; label: string; reconnected: boolean } | { error: ConnectionConnectError };
}

/** Where a connect card sent the person back: the burrow and the card's message (`?…&guide=<id>`), or null. */
export function parseGuideReturn(returnPath: string): { slug: string; messageId: string } | null {
  let url: URL;
  try {
    url = new URL(returnPath, 'http://whombat.invalid');
  } catch {
    return null;
  }
  const messageId = url.searchParams.get('guide');
  if (!messageId || !/^msg_[A-Za-z0-9_-]{1,64}$/.test(messageId)) return null;
  const withBurrow = /^\/([^/]+)\/(chat|feedback|chats\/[^/]+|pr\/\d+)$/.exec(url.pathname);
  if (withBurrow) {
    try {
      return { slug: decodeURIComponent(withBurrow[1] ?? ''), messageId };
    } catch {
      return null;
    }
  }
  const burrowParam = url.searchParams.get('burrow');
  if (burrowParam && /^\/(chat|feedback|chats\/[^/]+|pr\/\d+)$/.test(url.pathname))
    return { slug: burrowParam, messageId };
  return null;
}

function oauthRetryText(code: ConnectionConnectError): string {
  switch (code) {
    case 'access_denied':
      return 'Sign-in was cancelled. Click Sign in on the card whenever you’re ready to try again.';
    case 'no_app':
      return 'That app isn’t set up on this Whombat yet. Open Settings → Connections to finish setting it up, then try again.';
    case 'limit_reached':
      return 'This Whombat already has as many connections as it can hold. Remove one in Settings → Connections, then try again.';
    case 'destination_refused':
      return 'Whombat isn’t allowed to reach that address yet. Allow the network in Settings, then try again.';
    default:
      return 'Sign-in didn’t finish. Click Sign in on the card to try again.';
  }
}

/** Catalog id and optional URL an `add_connection` card asks to connect. */
function connectCardTarget(card: GuideCard): { catalogId: string; url: string | null } | null {
  if (card.connectOAuth)
    return { catalogId: card.connectOAuth.catalogId, url: card.connectOAuth.url ?? null };
  if (card.connectAsk) return { catalogId: card.connectAsk.catalogId, url: card.connectAsk.url };
  for (const block of card.blocks) {
    if (block.type !== 'actions') continue;
    const action = block.actions.find((a) => a.id === 'connect' && a.href);
    if (!action?.href) continue;
    try {
      const parsed = new URL(action.href, 'http://whombat.invalid');
      const catalogId = parsed.searchParams.get('connection');
      if (catalogId) return { catalogId, url: parsed.searchParams.get('url') };
    } catch {
      // ignore malformed href
    }
  }
  return null;
}

/** Connection id an `allow_more` card asks permissions for. */
function allowMoreTargetId(card: GuideCard): string | null {
  if (card.connectOAuth?.connectionId) return card.connectOAuth.connectionId;
  for (const block of card.blocks) {
    if (block.type !== 'actions') continue;
    const action = block.actions.find((a) => a.id === 'allow' && a.href);
    if (!action?.href) continue;
    try {
      const parsed = new URL(action.href, 'http://whombat.invalid');
      const id = parsed.searchParams.get('id');
      if (id) return id;
    } catch {
      // ignore malformed href
    }
  }
  return null;
}

function sameAddressOrHost(cardUrl: string, savedBaseUrl: string): boolean {
  const norm = (u: string) => {
    try {
      const parsed = new URL(u);
      parsed.hash = '';
      return parsed.toString().replace(/\/+$/, '');
    } catch {
      return u.replace(/\/+$/, '');
    }
  };
  if (norm(cardUrl) === norm(savedBaseUrl)) return true;
  const a = hostOfAddress(cardUrl);
  const b = hostOfAddress(savedBaseUrl);
  return a !== null && a === b;
}

/** The steps to post: at the top of the Chat, or with the thread they go in. */
type Built = Step[] | { steps: Step[]; threadRootId: string | null } | null;

type Build = (ctx: ApplyContext, place: PersonalPlace, facts: GuideFacts) => Promise<Built> | Built;

export class GuideService {
  #pending = new Set<Promise<unknown>>();
  #hourly: ReturnType<typeof setInterval> | null = null;
  #firstHourly: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly services: Services) {}

  /** Runs `work` in the background (a hook that must not hold up its caller), logging failures. */
  track(what: string, work: () => Promise<unknown>): void {
    const p = work()
      .catch((err) => this.services.log.warn({ err: String(err) }, `guides: ${what} failed`))
      .finally(() => this.#pending.delete(p));
    this.#pending.add(p);
  }

  /** Waits for background hooks (tests). */
  async settle(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  /**
   * Posts in the person's Chat as their agent, in a transaction holding the burrow's lock. `build` may write (inside
   * the same transaction) and returns the steps (and the thread they go in), or null to post nothing. Returns the
   * posted message ids.
   */
  async postTo(
    burrowId: string,
    personId: string,
    build: Build,
    options: { notify: boolean },
  ): Promise<string[]> {
    const { result } = await this.services.pipeline.transact(burrowId, async (session) => {
      const place = await personalPlace(session.tx, burrowId, personId);
      if (!place) return [];
      const now = this.services.clock();
      const ctx = applyContext(session, {
        burrow: place.burrow,
        actor: toActor(place.agent),
        now,
        at: iso(now),
        decision: null,
        requirement: null,
        approvalId: null,
        onBehalfOf: {},
      });
      const facts = await loadFacts(this.services, session.tx, place);
      const built = await build(ctx, place, facts);
      const { steps, threadRootId } = Array.isArray(built)
        ? { steps: built, threadRootId: null }
        : (built ?? {});
      if (!steps?.length) return [];
      return (await postSteps(ctx, place, steps, facts, { notify: options.notify, threadRootId })).map(
        (p) => p.id,
      );
    });
    return result;
  }

  /* Welcome (AG-04; built from what the box found, first-day.md) ---------------------------------------- */

  /**
   * The welcome in the person's Chat, once (an account in a burrow), as one thread: only while the Chat is empty;
   * a Chat with messages already counts as welcomed. It names what the network scan found when a scan finished (and
   * claims the telling, so the scan's own message doesn't come too), else says what the assistant can do; the burrow's
   * automatic scan is started at once rather than within the minute. True when it was posted.
   */
  async welcome(burrowId: string, personId: string): Promise<boolean> {
    const found = await foundNowFor(this.services, burrowId, personId);
    const ids = await this.postTo(
      burrowId,
      personId,
      async (ctx, place) => {
        const now = ctx.now;
        const [claimed] = await ctx.tx
          .insert(assistantStates)
          .values({ burrowId, personId, accountId: place.accountId, welcomedAt: now, createdAt: now })
          .onConflictDoUpdate({
            target: [assistantStates.burrowId, assistantStates.personId],
            set: { welcomedAt: now },
            setWhere: isNull(assistantStates.welcomedAt),
          })
          .returning({ personId: assistantStates.personId });
        if (!claimed) return null;
        const [any] = await ctx.tx
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.conversationId, place.dm.id))
          .limit(1);
        if (any) return null;
        // Named here, so not again when the scan finishes; told already (or put away): the welcome without them.
        const told = found.finds.length > 0 && (await claimFoundTold(ctx.tx, burrowId, now));
        return welcomeSteps(told ? found : { ...found, finds: [] });
      },
      // The DM's unread badge says it; a push right after signing up would be noise.
      { notify: false },
    );
    foundScansFor(this.services).kick();
    return ids.length > 0;
  }

  /* The app setup's form (AG-06 step 5), before the commit ---------------------------------------- */

  /**
   * Saves the Google client from the form in chat, when this act is that form: checks the card (theirs, open, the
   * form) and the mode, reads the values and saves through `saveGoogleApp` (account-level, CN-07). The
   * values go nowhere else. Returns what the locked card may say, or undefined for any other action.
   */
  async saveAppFromForm(
    burrowId: string,
    personId: string,
    messageId: string,
    body: z.output<typeof GuideActBody>,
  ): Promise<SavedApp | undefined> {
    const { card, place } = await guideTarget(this.services.db, burrowId, messageId, personId);
    const form = card.blocks.find((b) => b.type === 'form' && b.id === body.actionId);
    if (!form || card.guide !== 'google_app') return undefined;
    const audience = card.node.split('.')[1] === 'internal' ? 'internal' : 'external';
    const services = this.services;
    if (services.google.mode === 'off')
      throw guideError('google_unavailable', 'Google is turned off on this Whombat (WHOMBAT_GOOGLE=off).');
    const facts = await loadFacts(services, services.db, place);
    if (facts.google.appInConfig)
      throw guideError(
        'google_app_in_config',
        'Google is set in this Whombat’s config (WHOMBAT_GOOGLE_CLIENT_ID), so it can’t be changed here.',
      );
    let parsed: ReturnType<typeof parseAppForm>;
    try {
      parsed = parseAppForm(body.values ?? {}, facts.setup.redirectUri);
    } catch (err) {
      throw refusalError(err);
    }
    try {
      await saveGoogleApp(services, place.accountId, {
        clientId: parsed.clientId,
        clientSecret: parsed.clientSecret,
        userType: audience,
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation_failed')
        throw guideError('invalid_values', err.message, err.extra.fields);
      if (err instanceof ApiError && err.code === 'conflict')
        throw guideError('google_app_in_config', err.message);
      throw err;
    }
    return { clientIdHint: clientIdHint(parsed.clientId), redirectListed: parsed.redirectListed };
  }

  /* A Vault card's form (connect-in-chat.md), before the commit -------------------------------------- */

  /** The Vault cards being answered now: a second send of the same card waits for nothing and is refused. */
  readonly #saving = new Set<string>();

  /**
   * Answers a `secret` card (connect-in-chat.md, vault-simplify.md) when this act is its form or its Not now: checks
   * the card (theirs, open) and saves to their Vault as them, signs in to a server or hands a code to the turn that
   * asked (`saveVaultAsk`). The value goes nowhere else. Returns how it ended for the locked card, or undefined for any
   * other action.
   */
  async answerVaultCard(
    burrowId: string,
    personId: string,
    messageId: string,
    body: z.output<typeof GuideActBody>,
  ): Promise<SavedVault | undefined> {
    const { row, card, place } = await guideTarget(this.services.db, burrowId, messageId, personId);
    if (card.guide !== 'secret' || !card.vaultAsk) return undefined;
    const form = card.blocks.find((b) => b.type === 'form' && b.id === body.actionId);
    const decline = body.actionId === VAULT_ASK_DECLINE;
    if (!form && !decline) return undefined;
    // Two sends at once (a double tap, a second device) would make two entries: the first one counts.
    if (this.#saving.has(messageId)) throw guideError('guide_closed', 'This was answered already.');
    this.#saving.add(messageId);
    try {
      if (decline) return await declineVaultAsk(this.services, row, card);
      return await saveVaultAsk(this.services, place, row, card.vaultAsk, body.values ?? {});
    } finally {
      this.#saving.delete(messageId);
    }
  }

  /* A card that connects on the card (connect-by-talking.md), before the commit ----------------------- */

  /** The connect cards being answered now: a second send of the same card is refused, so one connection is made. */
  readonly #connecting = new Set<string>();

  /**
   * Answers an `add_connection` card that connects on the card when this act is its Connect or its Not now: checks the
   * card (theirs, open) and connects as them with what they typed (`answerConnectHere`). The key goes nowhere else.
   * Returns how it ended for the locked card, or undefined for any other card or action.
   */
  async answerConnectCard(
    burrowId: string,
    personId: string,
    messageId: string,
    body: z.output<typeof GuideActBody>,
  ): Promise<SavedConnection | undefined> {
    const { card, place } = await guideTarget(this.services.db, burrowId, messageId, personId);
    if (card.guide !== 'add_connection' || !card.connectAsk) return undefined;
    const decline = body.actionId === CONNECT_HERE_DECLINE;
    if (!decline && body.actionId !== CONNECT_HERE_FORM) return undefined;
    if (this.#connecting.has(messageId)) throw guideError('guide_closed', 'This was answered already.');
    this.#connecting.add(messageId);
    try {
      if (decline) return declineConnectHere(card.connectAsk);
      return await answerConnectHere(this.services, place, card.connectAsk, body.values ?? {});
    } finally {
      this.#connecting.delete(messageId);
    }
  }

  /* Coming back from Google (AG-08) --------------------------------------------------------------- */

  /**
   * After Google's redirect: when the return path is the person's Chat with a guide marker, the result
   * (or what went wrong and a new connect card) lands in the connect card's thread, and that card is locked.
   * Never throws: the redirect goes on whatever happens here.
   */
  async afterGoogle(args: GoogleOutcome): Promise<void> {
    try {
      const target = parseGuideReturn(args.returnPath);
      if (!target) return;
      const db = this.services.db;
      const [burrowRow] = await this.services.sql<
        { id: string }[]
      >`select id from burrows where slug = ${target.slug}`;
      if (!burrowRow) return;
      const [person] = await db
        .select()
        .from(principals)
        .where(
          and(
            eq(principals.burrowId, burrowRow.id),
            eq(principals.accountId, args.accountId),
            eq(principals.kind, 'person'),
          ),
        );
      if (!person) return;
      await this.postTo(
        burrowRow.id,
        person.id,
        async (ctx, place, facts) => {
          const [marker] = await ctx.tx
            .select()
            .from(messages)
            .where(and(eq(messages.id, target.messageId), eq(messages.conversationId, place.dm.id)));
          const card =
            marker?.card?.kind === 'guide' && marker.authorId === place.agent.id ? marker.card : null;
          const topic = card?.guide ?? null;
          // In the connect card's thread, where the person comes back to.
          const threadRootId = marker ? (marker.threadRootId ?? marker.id) : null;
          if ('error' in args.outcome)
            return { steps: retrySteps(topic, args.outcome.error, args.requested), threadRootId };
          if (marker && card?.state === 'open' && facts.connection) {
            await lockCard(ctx, marker, card, {
              actionId: 'connect',
              optionIds: null,
              label: `Connected as ${facts.connection.email}`.slice(0, 200),
              at: ctx.at,
            });
          }
          return {
            steps: [resultStep(topic, null), ...followUps(facts, facts.connection?.services ?? [])],
            threadRootId,
          };
        },
        { notify: false },
      );
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'guides: the Google result could not be posted');
    }
  }

  /* Coming back from a catalog connection OAuth sign-in ------------------------------------------ */

  /**
   * After a catalog connection's OAuth redirect when the return path carries a `guide=<messageId>` marker:
   * - on success, locks the open `add_connection` card with the new connection (or allowed permissions) and wakes the
   *   assistant in that card's thread so it continues automatically;
   * - on failure, keeps the card open and posts one short retry note in the card's thread.
   * Never throws: the redirect continues whatever happens here.
   */
  async afterConnectionOAuth(args: ConnectionOAuthOutcome): Promise<void> {
    try {
      const target = parseGuideReturn(args.returnPath);
      if (!target) return;
      const [person] = await this.services.db
        .select()
        .from(principals)
        .where(
          and(
            eq(principals.burrowId, args.burrowId),
            eq(principals.accountId, args.accountId),
            eq(principals.kind, 'person'),
          ),
        );
      if (!person) return;
      await this.services.pipeline.transact(args.burrowId, async (session) => {
        const place = await personalPlace(session.tx, args.burrowId, person.id);
        if (!place) return;
        const [marker] = await session.tx
          .select()
          .from(messages)
          .where(and(eq(messages.id, target.messageId), eq(messages.burrowId, args.burrowId)));
        const card =
          marker?.card?.kind === 'guide' &&
          marker.card.guide === 'add_connection' &&
          marker.authorId === place.agent.id
            ? marker.card
            : null;
        if (!marker || !card || card.state !== 'open') return;
        const now = this.services.clock();
        const ctx = applyContext(session, {
          burrow: place.burrow,
          actor: toActor(place.agent),
          now,
          at: iso(now),
          decision: null,
          requirement: null,
          approvalId: null,
          onBehalfOf: {},
        });
        if ('error' in args.outcome) {
          const conversation = await loadConversationRow(session.tx, marker.conversationId);
          if (!conversation) return;
          await postMessage(ctx, {
            conversation,
            threadRootId: marker.threadRootId ?? marker.id,
            text: oauthRetryText(args.outcome.error),
            dispatch: false,
            notifyDmPerson: false,
          });
          return;
        }
        const allowMore = card.node === 'allow_more';
        const locked = await lockCard(ctx, marker, card, {
          actionId: allowMore ? 'allow' : 'connect',
          optionIds: null,
          label: connectHereLocked(allowMore ? 'allowed' : 'connected', args.outcome.label),
          at: ctx.at,
          connectionId: args.outcome.connectionId,
        });
        if (!locked) return;
        this.#wakeForCard(ctx, place, marker);
      });
    } catch (err) {
      this.services.log.warn(
        { err: String(err) },
        'guides: the connection OAuth result could not be applied',
      );
    }
  }

  /**
   * When a connection is saved outside a card's direct OAuth return (e.g. through Settings), locks any matching open
   * `add_connection` card in the burrow and wakes the assistant in its thread so stale cards never stay waiting.
   */
  async closeMatchingConnectCards(args: {
    burrowId: string;
    personId: string;
    connectionId: string;
    catalogId: string;
    label: string;
    baseUrl: string;
  }): Promise<void> {
    try {
      await this.services.pipeline.transact(args.burrowId, async (session) => {
        const place = await personalPlace(session.tx, args.burrowId, args.personId);
        if (!place) return;
        const rows = await session.tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.burrowId, args.burrowId),
              eq(messages.authorId, place.agent.id),
              sql`${messages.card}->>'kind' = 'guide'`,
              sql`${messages.card}->>'guide' = 'add_connection'`,
              sql`${messages.card}->>'state' = 'open'`,
              sql`${messages.card}->>'node' <> 'allow_more'`,
            ),
          )
          .orderBy(desc(messages.createdAt))
          .limit(20);
        const matching = rows.filter((row) => {
          if (row.card?.kind !== 'guide') return false;
          const target = connectCardTarget(row.card);
          if (!target || target.catalogId !== args.catalogId) return false;
          return target.url ? sameAddressOrHost(target.url, args.baseUrl) : true;
        });
        if (!matching.length) return;
        const now = this.services.clock();
        const ctx = applyContext(session, {
          burrow: place.burrow,
          actor: toActor(place.agent),
          now,
          at: iso(now),
          decision: null,
          requirement: null,
          approvalId: null,
          onBehalfOf: {},
        });
        const wokenThreads = new Set<string>();
        for (const row of matching) {
          if (row.card?.kind !== 'guide') continue;
          const locked = await lockCard(ctx, row, row.card, {
            actionId: 'connect',
            optionIds: null,
            label: connectHereLocked('connected', args.label),
            at: ctx.at,
            connectionId: args.connectionId,
          });
          if (!locked) continue;
          const key = `${row.conversationId}:${row.threadRootId ?? ''}`;
          if (!wokenThreads.has(key)) {
            wokenThreads.add(key);
            this.#wakeForCard(ctx, place, row);
          }
        }
      });
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'guides: matching connect cards could not be closed');
    }
  }

  /** When a connection reconnects with newly granted scopes via Settings, closes matching open `allow_more` cards. */
  async closeMatchingAllowMoreCards(args: {
    burrowId: string;
    personId: string;
    connectionId: string;
    label: string;
  }): Promise<void> {
    try {
      await this.services.pipeline.transact(args.burrowId, async (session) => {
        const place = await personalPlace(session.tx, args.burrowId, args.personId);
        if (!place) return;
        const rows = await session.tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.burrowId, args.burrowId),
              eq(messages.authorId, place.agent.id),
              sql`${messages.card}->>'kind' = 'guide'`,
              sql`${messages.card}->>'guide' = 'add_connection'`,
              sql`${messages.card}->>'state' = 'open'`,
              sql`${messages.card}->>'node' = 'allow_more'`,
            ),
          )
          .orderBy(desc(messages.createdAt))
          .limit(20);
        const matching = rows.filter(
          (row) => row.card?.kind === 'guide' && allowMoreTargetId(row.card) === args.connectionId,
        );
        if (!matching.length) return;
        const now = this.services.clock();
        const ctx = applyContext(session, {
          burrow: place.burrow,
          actor: toActor(place.agent),
          now,
          at: iso(now),
          decision: null,
          requirement: null,
          approvalId: null,
          onBehalfOf: {},
        });
        const wokenThreads = new Set<string>();
        for (const row of matching) {
          if (row.card?.kind !== 'guide') continue;
          const locked = await lockCard(ctx, row, row.card, {
            actionId: 'allow',
            optionIds: null,
            label: connectHereLocked('allowed', args.label),
            at: ctx.at,
            connectionId: args.connectionId,
          });
          if (!locked) continue;
          const key = `${row.conversationId}:${row.threadRootId ?? ''}`;
          if (!wokenThreads.has(key)) {
            wokenThreads.add(key);
            this.#wakeForCard(ctx, place, row);
          }
        }
      });
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'guides: matching allow-more cards could not be closed');
    }
  }

  /** Queues the assistant in a locked connect card's thread unless the licence is lapsed. */
  #wakeForCard(
    ctx: ApplyContext,
    place: PersonalPlace,
    marker: { id: string; conversationId: string; threadRootId: string | null },
  ): void {
    try {
      this.services.licence.assertNotLapsed();
    } catch {
      return;
    }
    const inChat = marker.conversationId === place.dm.id;
    const services = this.services;
    const wakeArgs = {
      burrowId: place.burrow.id,
      causedById: place.person.id,
      conversationId: marker.conversationId,
      messageId: marker.id,
      threadRootId: marker.threadRootId,
      requests: [{ agentId: place.agent.id, trigger: inChat ? ('dm' as const) : ('mention' as const) }],
      at: ctx.now,
    };
    ctx.after(async () => {
      await enqueueDispatches(services, wakeArgs);
    });
  }

  /* Repair (AG-13) --------------------------------------------------------------------------------- */

  /** A connection needs reauth (a token refresh found it): the repair message, in the background. */
  needsReauth(connectionId: string): void {
    this.track('repair', () => this.repair([connectionId]));
  }

  /**
   * The repair message for each connection that needs reauth, in the person's Chat of the burrow they were
   * most recently active in; at most one per connection per 24 hours.
   */
  async repair(connectionIds: readonly string[]): Promise<number> {
    let posted = 0;
    for (const id of connectionIds) {
      const now = this.services.clock();
      const [claimed] = await this.services.pipeline.transactAccount((tx) =>
        tx
          .update(connections)
          .set({ repairNotifiedAt: now })
          .where(
            and(
              eq(connections.id, id),
              eq(connections.status, 'needs_reauth'),
              or(
                isNull(connections.repairNotifiedAt),
                lt(connections.repairNotifiedAt, new Date(now.getTime() - REPAIR_SPACING_MS)),
              ),
            ),
          )
          .returning(),
      );
      if (!claimed) continue;
      const [place] = await recentPlaces(this.services, claimed.accountId);
      if (!place) continue;
      const reason: ReauthReason = claimed.reauthReason ?? 'revoked';
      const ids = await this.postTo(
        place.burrowId,
        place.personId,
        () => [repairStep(reason, claimed.services, claimed.provider)],
        {
          notify: true,
        },
      );
      if (ids.length) posted++;
    }
    return posted;
  }

  /* The hourly job (AG-11) ------------------------------------------------------------------------ */

  async hourly(now = this.services.clock()): Promise<{ expired: number; suggested: number }> {
    const expired = await this.expireCards(now);
    const suggested = await this.suggest(now);
    return { expired, suggested };
  }

  /** Open guide cards older than 7 days become `expired` (locked; “This expired. Ask me any time.”). */
  async expireCards(now = this.services.clock()): Promise<number> {
    const old = await this.services.db
      .select({ id: messages.id, burrowId: messages.burrowId })
      .from(messages)
      .where(
        and(
          sql`${messages.card}->>'kind' = 'guide' and ${messages.card}->>'state' = 'open'`,
          // A standing card states a setting; it waits for nobody, so it never expires.
          sql`coalesce((${messages.card}->>'standing')::boolean, false) = false`,
          lt(messages.createdAt, new Date(now.getTime() - GUIDE_EXPIRY_MS)),
        ),
      )
      .limit(500);
    const byBurrow = new Map<string, string[]>();
    for (const m of old) byBurrow.set(m.burrowId, [...(byBurrow.get(m.burrowId) ?? []), m.id]);
    let n = 0;
    for (const [burrowId, ids] of byBurrow) {
      const { result } = await this.services.pipeline.transact(burrowId, async (session) => {
        const burrow = await loadBurrowRow(session.tx, burrowId);
        if (!burrow) return 0;
        let done = 0;
        const rows = await session.tx.select().from(messages).where(inArray(messages.id, ids));
        for (const row of rows) {
          const card = row.card;
          const author = await loadPrincipalRow(session.tx, row.authorId);
          if (card?.kind !== 'guide' || !author) continue;
          // Signed by the agent that posted the card: nobody acted.
          const ctx = applyContext(session, {
            burrow,
            actor: toActor(author),
            now,
            at: iso(now),
            decision: null,
            requirement: null,
            approvalId: null,
            onBehalfOf: {},
          });
          if (await lockCard(ctx, row, card, null, 'expired')) done++;
        }
        return done;
      });
      n += result;
    }
    return n;
  }

  /**
   * Occasional suggestions: per account at most one per 7 days, in the burrow they were most recently active in,
   * never within 3 days of the welcome there, only when active in the last 3 days, with no open guide card, and
   * only a topic that isn't set up or in `dontAsk` (and not with suggestions off).
   */
  async suggest(now = this.services.clock()): Promise<number> {
    const db = this.services.db;
    const owners = await this.services.sql<{ account_id: string }[]>`
      select distinct p.account_id from principals p
       where p.kind = 'person' and p.account_id is not null and p.system is null
         and exists (select 1 from principals a where a.burrow_id = p.burrow_id and a.kind = 'agent')`;
    let n = 0;
    for (const { account_id: accountId } of owners) {
      try {
        const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
        if (!account) continue;
        const prefs = assistantPrefsOf(account.preferences);
        const states = await db
          .select()
          .from(assistantStates)
          .where(eq(assistantStates.accountId, accountId));
        const last = states
          .map((s) => s.suggestedAt)
          .filter((d): d is Date => d !== null)
          .sort((a, b) => b.getTime() - a.getTime())[0];
        const [recent] = await recentPlaces(this.services, accountId);
        if (!recent) continue;
        const state = states.find((s) => s.burrowId === recent.burrowId && s.personId === recent.personId);
        const place = await personalPlace(db, recent.burrowId, recent.personId);
        if (!place) continue;
        const [open] = await db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, place.dm.id),
              sql`${messages.card}->>'kind' = 'guide' and ${messages.card}->>'state' = 'open'`,
              sql`coalesce((${messages.card}->>'standing')::boolean, false) = false`,
            ),
          )
          .limit(1);
        const due = suggestionDue({
          now,
          enabled: prefs.suggestions,
          lastSuggestedAt: last ?? null,
          welcomedAt: state?.welcomedAt ?? null,
          activeAt: recent.activeAt,
          openCard: !!open,
        });
        if (!due) continue;
        const ids = await this.postTo(
          place.burrow.id,
          place.person.id,
          async (ctx, p, facts) => {
            const topic = pickSuggestion(facts);
            if (!topic) return null;
            await upsertAssistantState(ctx.tx, p, { suggestedAt: now, suggestedTopic: topic });
            return [suggestionStep(topic)];
          },
          { notify: true },
        );
        if (ids.length) n++;
      } catch (err) {
        this.services.log.warn({ err: String(err), accountId }, 'guides: suggestion failed');
      }
    }
    return n;
  }

  /* Lifecycle ------------------------------------------------------------------------------------- */

  /** The hourly job (first run 5 minutes after start, so frequent restarts don't starve it), while the process runs. */
  start(): void {
    if (this.#hourly) return;
    const hourly = () => {
      if (this.services.maintenance.held) return;
      this.track('hourly job', () => this.hourly());
    };
    this.#hourly = setInterval(hourly, HOUR_MS);
    this.#firstHourly = setTimeout(hourly, FIRST_HOURLY_MS);
    this.#hourly.unref?.();
    this.#firstHourly.unref?.();
  }

  close(): void {
    if (this.#hourly) clearInterval(this.#hourly);
    if (this.#firstHourly) clearTimeout(this.#firstHourly);
    this.#firstHourly = null;
    this.#hourly = null;
  }
}
