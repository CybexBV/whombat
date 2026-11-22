/**
 * `change_setting` (docs/decisions/assistant-settings.md): the assistant asking to change one of the person's settings,
 * through the commit pipeline so the `settings.change` key decides. Go ahead runs it at once (the tool runs the op after
 * this commits); Ask me first, and every destructive change or one the settings map says always asks, puts a card in
 * the thread, and the person's yes runs it once, as them, and wakes the assistant there with the result; Just watch
 * refuses it. The card's words are the settings map's and the op's own input, never the assistant's.
 */
import type { Grant, Tier } from '@whombat/core';
import {
  assistantAccessFor,
  assistantSetting,
  createOperationAllowlist,
  pageWords,
  type SettingsPageId,
} from '@whombat/protocol/session';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { askAgainThread, askAgainTier, askedAgain, askedAgainError } from '../approvals/ask-again';
import { answerAfterApproval, grantedResult } from '../approvals/result';
import { approvalThread } from '../approvals/wake';
import { defineCommand, type KeyRequirement } from '../commit/types';
import { changedSince, heldChanged, signingOnlyAs } from '../connections/bound-targets';
import {
  ChangedWhileAskedError,
  ConnectionChangedError,
  changedJustNowText,
  changedSinceYesText,
} from '../connections/call-target';
import type { Db } from '../db/client';
import { accounts, approvals, principals } from '../db/schema/index';
import { type ApiError, conflict } from '../lib/errors';
import type { RequestAnswer } from '../managed/dispatcher';
import { sessionDispatcherOf } from '../managed/dispatcher-ref';
import { loadConversationRow } from '../read/conversations';
import { loadGrants } from '../read/principals';
import type { Services } from '../services';
import { askThingAction, namedTitle, type ThingActionAsk, thingActionConnectionId } from '../things/actions';

/** The key every settings change needs. */
export const SETTINGS_KEY = 'settings.change' as const;

/** Most lines the card shows of the change's input. */
const PREVIEW_LINES = 6;
const PREVIEW_VALUE = 60;

let allowlist: ReturnType<typeof createOperationAllowlist> | null = null;
const specOf = (op: string) => {
  allowlist ??= createOperationAllowlist();
  return allowlist.get(op);
};

/**
 * Whether this change asks the person every time, whatever the key says: destructive, the map says so, or the input
 * sets a part the map guards (a check's address, switching it off).
 */
export function alwaysAsks(op: string, input?: unknown): boolean {
  return assistantAccessFor(op, input) === 'ask' || specOf(op)?.destructive === true;
}

/** The tier that decides this change: none without the key (Just watch), at most Ask for one that always asks, else the key's own. */
export function changeTier(held: Tier | null, op: string, input?: unknown): Tier {
  if (!held || held === 'cannot') return 'cannot';
  if (alwaysAsks(op, input)) return 'ask';
  return held;
}

/**
 * The change's input as the card shows it: `key: value` lines of what it sets, leaving out the Whombat's own slug,
 * values cut short. Nothing secret reaches here (secret ops are never the assistant's).
 */
export function previewLines(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (out.length >= PREVIEW_LINES) return;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (path === 'params' && k === 'burrow') continue;
        walk(v, ['params', 'body', 'query'].includes(path) || path === '' ? k : `${path}.${k}`);
      }
      return;
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    out.push(`${path}: ${text.length > PREVIEW_VALUE ? `${text.slice(0, PREVIEW_VALUE - 1)}…` : text}`);
  };
  for (const part of ['params', 'query', 'body'] as const) if (part in input) walk(input[part], part);
  if (!('params' in input) && !('body' in input) && !('query' in input)) walk(input, '');
  return out;
}

const Input = z.object({
  op: z.string().min(3).max(80),
  input: z.record(z.string(), z.unknown()),
  conversationId: z.string().min(1).max(64).nullable(),
  /**
   * What the card shows instead of the input's lines, when the input is ids a person can't read: Whombat's own words for
   * them (the things a bring-back picks, by their titles in the backup), never the assistant's.
   */
  lines: z.array(z.string().max(120)).max(PREVIEW_LINES).optional(),
  /** The card's title in Whombat's words for this change (“Change a Plex setting”), in place of the map's. */
  title: z.string().min(1).max(160).optional(),
  /**
   * Where each connection the change signs as goes and as whom when it was asked for, by id (`callTarget`; a page
   * action's, `askThingAction`, from the same read as the card's words): the card is saved only while each still goes
   * there, the yes is bound to it, and the change runs only while each still goes there.
   */
  targets: z
    .record(z.string().min(1).max(64), z.string().regex(/^[0-9a-f]{64}$/))
    .refine((t) => Object.keys(t).length <= 8)
    .optional(),
  /** The earlier approval this card asks again for, saved before its yes was bound (`approvals/ask-again.ts`). */
  askAgainOf: z.string().min(1).max(64).optional(),
});

export const changeSetting = defineCommand({
  name: 'change_setting',
  schema: Input,
  async requiredKey(input, { db, actor, approvalId }): Promise<KeyRequirement> {
    // Saved only while each connection it is bound to is still the one its card was made from (held until this
    // commits); an approved change is checked again when it runs (`runApprovedChange`).
    if (input.targets && !approvalId) {
      const changed = await heldChanged(db, input.targets);
      if (changed) throw new ChangedWhileAskedError(changed.id, changed.label);
    }
    const e = assistantSetting(input.op);
    const words = input.title ?? e.words ?? input.op;
    const where = pageWords((e.page ?? 'you.profile') as SettingsPageId, actor.shortName).where;
    const held = (await loadGrants(db, actor.id)).find((g) => g.keyId === SETTINGS_KEY)?.tier ?? null;
    const tier = changeTier(held, input.op, input.input);
    const grants: Grant[] = [
      { agentId: actor.id, keyId: SETTINGS_KEY, tier: input.askAgainOf ? askAgainTier(tier) : tier },
    ];
    const conversation = input.conversationId ? await loadConversationRow(db, input.conversationId) : null;
    const thread =
      input.askAgainOf && conversation ? await askAgainThread(db, input.askAgainOf, conversation.id) : {};
    const lower = words.charAt(0).toLowerCase() + words.slice(1);
    return {
      keyId: SETTINGS_KEY,
      grants,
      attempt: `change a setting (${lower})`,
      action: {
        type: 'custom',
        params: { name: 'settings_change', keyId: SETTINGS_KEY, data: { op: input.op, words, where } },
      },
      where: conversation ? 'Chat' : null,
      conversationId: conversation?.id ?? null,
      approval: {
        title: words.slice(0, 160),
        question: `${words}?`.slice(0, 160),
        target: where,
        whatHappens: [`In ${where}`, ...(input.lines ?? previewLines(input.input))],
        explainer: alwaysAsks(input.op, input.input)
          ? `${actor.shortName} always asks before this change. If you approve, it runs once, as you.`
          : `${actor.shortName} asks before changing your settings. If you approve, it runs once, as you.`,
        cardText: `I need your yes before I change this: ${lower}.`,
        ...thread,
      },
    };
  },
  async apply(_tx, ctx, input) {
    const access = assistantAccessFor(input.op, input.input);
    if (access !== 'change' && access !== 'ask') throw conflict(`${input.op} isn’t a setting to change.`);
    if (ctx.approvalId && !input.targets && thingActionConnectionId(input.op, input.input)) {
      // Said yes to on a card the previous release saved without binding it to its connection: nothing runs; a fresh
      // card asks again, and this approval ends saying so.
      const services = ctx.services;
      const again = {
        burrowId: ctx.burrow.id,
        agentId: ctx.actor.id,
        approvalId: ctx.approvalId,
        op: input.op,
        input: input.input,
        conversationId: input.conversationId,
        timeZone: ctx.burrow.timeZone,
      };
      ctx.complete(async () => {
        throw await askChangeAgain(services, again);
      });
      return { deferred: true };
    }
    await ctx.emit({
      type: 'setting.changed',
      kind: 'System',
      text: null,
      where: null,
      payload: { op: input.op, deferred: ctx.approvalId !== null },
    });
    if (ctx.approvalId) {
      // Approved after asking: the change runs once, as the person who said yes, after this commit; the assistant is
      // woken with the result in the card's thread to tell them.
      const services = ctx.services;
      const call = {
        burrowId: ctx.burrow.id,
        agentId: ctx.actor.id,
        approvalId: ctx.approvalId,
        op: input.op,
        input: input.input,
        conversationId: input.conversationId,
        ...(input.targets ? { targets: input.targets } : {}),
      };
      ctx.after(() => runApprovedChange(services, call));
    }
    return { deferred: ctx.approvalId !== null };
  },
});

async function approverAccount(db: Db, approvalId: string) {
  const [row] = await db
    .select({ account: accounts })
    .from(approvals)
    .innerJoin(principals, eq(principals.id, approvals.decidedById))
    .innerJoin(accounts, eq(accounts.id, principals.accountId))
    .where(eq(approvals.id, approvalId));
  return row?.account ?? null;
}

/** A change the person approved: run once as them, and the assistant woken with what happened. */
export async function runApprovedChange(
  services: Services,
  call: {
    burrowId: string;
    agentId: string;
    approvalId: string;
    op: string;
    input: Record<string, unknown>;
    conversationId: string | null;
    /** Where each connection it signs as went when it was asked for (`changeSetting`'s `targets`). */
    targets?: Readonly<Record<string, string>>;
  },
): Promise<void> {
  const account = await approverAccount(services.db, call.approvalId);
  const dispatcher = sessionDispatcherOf(services);
  // A page action is always bound (one asked before binding asks again instead, `changeSetting`); other settings sign
  // as no connection.
  const targets = call.targets ?? {};
  const answer =
    account && dispatcher
      ? await runBound(services, targets, changedSinceYesText, () =>
          dispatcher.runForAssistant(account, call.agentId, call.op, call.input),
        )
      : ({ type: 'error', message: 'This Whombat can’t run its settings now.' } as const);
  const result =
    answer.type === 'result'
      ? grantedResult('done', JSON.stringify(answer.output ?? null))
      : answer.type === 'redacted'
        ? grantedResult('done', 'Done.')
        : grantedResult('failed', answer.message);
  if (!call.conversationId) return;
  const threadRootId = await approvalThread(services.db, call.approvalId, call.conversationId).catch(
    () => null,
  );
  await answerAfterApproval(services, {
    burrowId: call.burrowId,
    agentId: call.agentId,
    approvalId: call.approvalId,
    postIn: call.conversationId,
    threadRootId,
    result,
  }).catch((err: unknown) =>
    services.log.warn(
      { err: err instanceof Error ? err.name : 'error', op: call.op },
      'could not answer an approved settings change',
    ),
  );
}

/**
 * Runs a settings op signing as each connection in `targets` only where, and as whom, it went when the change was asked
 * for: a connection given another address, account or token since answers `changed(label)` and nothing runs; one that
 * changes while the op runs sends nothing (`bound-targets.ts`).
 */
export async function runBound(
  services: Services,
  targets: Readonly<Record<string, string>>,
  changed: (label: string) => string,
  run: () => Promise<RequestAnswer>,
): Promise<RequestAnswer> {
  const refused = (message: string): RequestAnswer => ({
    type: 'error',
    code: 'conflict',
    message,
    retryable: false,
    replayed: false,
  });
  const label = await changedSince(services, targets);
  if (label) return refused(changed(label));
  try {
    return (await signingOnlyAs(targets, run)).value;
  } catch (err) {
    if (err instanceof ConnectionChangedError) return refused(err.message);
    throw err;
  }
}

/** A card's own words for a page action (`askThingAction`): the kind's, else the map's, naming its connection. */
export function thingCardWords(ask: ThingActionAsk, op: string): { title?: string; lines?: string[] } {
  if (ask.said) return { title: ask.said.title, lines: ask.said.lines.slice(0, PREVIEW_LINES) };
  if (!ask.label) return {};
  return { title: namedTitle(assistantSetting(op).words ?? op, ask.label) };
}

/**
 * A page action said yes to on a card saved before its yes was bound: a fresh card for it, bound to where its connection
 * goes now and worded from that same read, in the earlier card's thread (once). The error the earlier approval ends
 * with.
 */
async function askChangeAgain(
  services: Services,
  call: {
    burrowId: string;
    agentId: string;
    approvalId: string;
    op: string;
    input: Record<string, unknown>;
    conversationId: string | null;
    timeZone: string;
  },
): Promise<ApiError> {
  if (await askedAgain(services.db, call.burrowId, call.approvalId)) return askedAgainError();
  const ask = await askThingAction(services, call.burrowId, call.op, call.input, call.timeZone);
  if (!ask.label) return conflict('That connection isn’t here any more, so nothing was changed.');
  if (ask.changed) return conflict(changedJustNowText(ask.changed));
  try {
    const res = await services.pipeline.commit(
      changeSetting,
      {
        op: call.op,
        input: call.input,
        conversationId: call.conversationId,
        ...thingCardWords(ask, call.op),
        targets: ask.targets,
        askAgainOf: call.approvalId,
      },
      { burrowId: call.burrowId, actorId: call.agentId },
    );
    if (res.status === 'blocked') return conflict(res.message);
  } catch (err) {
    if (err instanceof ChangedWhileAskedError) return conflict(changedJustNowText(err.label));
    throw err;
  }
  return askedAgainError();
}

export const SETTINGS_COMMANDS = [changeSetting];
