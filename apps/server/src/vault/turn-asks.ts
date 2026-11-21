/**
 * Hermes's own asks (docs/decisions/vault-simplify.md VLT-45, CT-1667): when the browser reaches a sign-in page with no
 * login for it, or a page asks for a one-time code, Whombat's plugin asks the runner, and the runner asks here.
 *
 * - `runner.loginAsk` (`loginAskFor`): only in a turn of the person's own (never an outsiders' turn or a Feedback
 *   assessment: `not_person`); a login's address must be one the Vault may keep (`not_allowed`) in a Vault with room
 *   (`full`). The `login` or `code` card is posted as the assistant in the turn's thread, with the turn on its message;
 *   asked again for the same kind and site in the turn, the same open card answers (or a code card whose code the turn
 *   hasn't taken yet: the one the agent asked for with `vault_ask`).
 * - `runner.loginAskWait` (`loginAskWaitFor`): a long poll of at most `waitMs` on that card: `saved` with the login (its
 *   password then comes from `runner.loginSecret`, as every login's), `code` (taken: once), `declined`, `timed_out`
 *   when its wait (`LOGIN_ASK_WAIT_MS` from the card) is over, else `pending`. The card stays after a timeout; an
 *   answer then wakes the agent in that thread (`turnTakes`).
 */
import {
  type GuideCard,
  type GuideVaultAsk,
  LOGIN_ASK_WAIT_MS,
  type LoginAskBody,
  type LoginAskReply,
  type LoginAskWaitReply,
  VAULT_ENTRIES_MAX,
  vaultAskCard,
} from '@whombat/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { browserContextFor, loginsOf } from '../browser/context';
import { messages } from '../db/schema/index';
import { postTurnCard } from '../guides/ask';
import { notFound } from '../lib/errors';
import { iso } from '../lib/time';
import { loadPrincipalRow, shortName } from '../read/principals';
import type { DispatchRow } from '../runtime/context';
import { dispatchPerson } from '../runtime/person';
import type { Services } from '../services';
import { vaultTurn } from './context';
import { cardAnswerOrTimeout, takeCode } from './login-asks';
import { destinationProblem } from './net';
import { entryCount } from './store';

type Body = z.output<typeof LoginAskBody>;

/** What Hermes hears when nobody was asked (plain, for Hermes and the agent). */
export const LOGIN_ASK_TEXT = {
  notPerson: 'This turn can’t ask the person for a sign-in.',
  full: 'The person’s Vault is full, so a new login can’t be saved.',
} as const;

/** The site of an https origin (`https://github.com` → github.com). */
function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin.replace(/^https:\/\//, '');
  }
}

/** When a card's wait ends: `LOGIN_ASK_WAIT_MS` after it was posted. */
function untilOf(row: { createdAt: Date }, kind: 'login' | 'code'): Date {
  return new Date(row.createdAt.getTime() + LOGIN_ASK_WAIT_MS[kind]);
}

/** This turn's card for the same kind and site that still answers: open, or a code it hasn't taken yet. */
async function sameCard(services: Services, dispatch: DispatchRow, kind: 'login' | 'code', origin: string) {
  const rows = await services.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.dispatchId, dispatch.id),
        sql`${messages.card}->>'guide' = 'secret'`,
        sql`${messages.card}->'vaultAsk'->>'kind' = ${kind}`,
      ),
    )
    .orderBy(asc(messages.createdAt));
  const host = hostOf(origin).toLowerCase();
  return (
    rows.find((r) => {
      const card = r.card as GuideCard;
      const ask = card.vaultAsk;
      if (!ask) return false;
      const same = kind === 'login' ? ask.url === origin : ask.name.toLowerCase() === host;
      if (!same) return false;
      return card.state === 'open' || (kind === 'code' && card.answer?.vaultOutcome === 'code_given');
    }) ?? null
  );
}

/** `runner.loginAsk` for a live dispatch (the route checked the runner and its lease). */
export async function loginAskFor(
  services: Services,
  dispatch: DispatchRow,
  body: Body,
): Promise<LoginAskReply> {
  if (!(await vaultTurn(services.db, dispatch)))
    return { status: 'refused', reason: 'not_person', message: LOGIN_ASK_TEXT.notPerson };
  const agent = await loadPrincipalRow(services.db, dispatch.agentId);
  if (agent?.kind !== 'agent')
    return { status: 'refused', reason: 'not_person', message: LOGIN_ASK_TEXT.notPerson };
  const same = await sameCard(services, dispatch, body.kind, body.origin);
  if (same) return { status: 'asked', messageId: same.id, until: iso(untilOf(same, body.kind)) };
  const host = hostOf(body.origin);
  let ask: GuideVaultAsk;
  if (body.kind === 'login') {
    const problem = await destinationProblem(services, body.origin, 'save');
    if (problem) return { status: 'refused', reason: 'not_allowed', message: problem.message.slice(0, 500) };
    const person = await dispatchPerson(services.db, dispatch);
    if (person && (await entryCount(services.db, dispatch.burrowId, person.id)) >= VAULT_ENTRIES_MAX)
      return { status: 'refused', reason: 'full', message: LOGIN_ASK_TEXT.full };
    ask = {
      kind: 'login',
      name: host,
      url: body.origin,
      username: body.username?.trim() ? body.username.trim().slice(0, 320) : null,
      description: '',
      entryId: null,
    };
  } else {
    ask = { kind: 'code', name: host, url: null, username: null, description: '', entryId: null };
  }
  const messageId = await postTurnCard(services, dispatch, vaultAskCard(shortName(agent), ask, null), {
    turn: true,
  });
  const [row] = await services.db.select().from(messages).where(eq(messages.id, messageId));
  return {
    status: 'asked',
    messageId,
    until: iso(untilOf(row ?? { createdAt: services.clock() }, body.kind)),
  };
}

/** How the card answers the turn now, or null while it is open. */
async function answerOf(
  services: Services,
  dispatch: DispatchRow,
  row: typeof messages.$inferSelect,
): Promise<LoginAskWaitReply | null> {
  const card = row.card as GuideCard;
  if (card.state === 'open') return null;
  const outcome = card.answer?.vaultOutcome;
  if (outcome === 'saved' && card.answer?.vaultEntryId) {
    // One of the turn's logins now (switched on as the person saved it), as `DispatchContext.logins` lists them.
    const agent = await loadPrincipalRow(services.db, dispatch.agentId);
    const browser = agent ? await browserContextFor(services, agent, dispatch) : null;
    const login = browser
      ? (await loginsOf(services.db, dispatch.agentId)).find((l) => l.entryId === card.answer?.vaultEntryId)
      : undefined;
    return login ? { status: 'saved', login } : { status: 'declined' };
  }
  if (outcome === 'code_given') {
    const code = takeCode(services, row.id, dispatch.id);
    return code ? { status: 'code', code } : { status: 'declined' };
  }
  return { status: 'declined' };
}

/** `runner.loginAskWait`: the card's answer, or `pending` after at most `waitMs`, or `timed_out` past its wait. */
export async function loginAskWaitFor(
  services: Services,
  dispatch: DispatchRow,
  messageId: string,
  waitMs: number,
  signal?: AbortSignal,
): Promise<LoginAskWaitReply> {
  const load = async () => {
    const [row] = await services.db.select().from(messages).where(eq(messages.id, messageId));
    if (!row || row.dispatchId !== dispatch.id || row.card?.kind !== 'guide') throw notFound('Card');
    return row;
  };
  const deadline = Date.now() + waitMs;
  for (;;) {
    const row = await load();
    const answer = await answerOf(services, dispatch, row);
    if (answer) return answer;
    const kind = (row.card as GuideCard).vaultAsk?.kind === 'code' ? 'code' : 'login';
    const until = untilOf(row, kind).getTime();
    if (services.clock().getTime() >= until) return { status: 'timed_out' };
    const left = Math.min(deadline - Date.now(), until - services.clock().getTime());
    if (left <= 0 || signal?.aborted) return { status: 'pending' };
    // Woken by the answer itself (`cardAnswered`); a look every second besides.
    await cardAnswerOrTimeout(services, messageId, Math.min(1000, left), signal);
  }
}
