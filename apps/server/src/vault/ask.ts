/**
 * `vault_ask` (connect-in-chat.md CIC-10…CIC-15, vault-simplify.md VLT-40…VLT-49): the assistant asks for any sign-in
 * with a card in the thread its work is in, never in a message. The card's form is write-only: what the person types
 * goes from `guides.act` (a secret op) straight into their Vault — or, for a one-time code, to the turn's sign-in, once —
 * never into a message, an event, a log or the model's context. The agent is woken with how it went and the entry's id
 * (the locked card's answer), never the value. The card and its words are core's (`vaultAskCard`, `VAULT_ASK_TEXT`).
 *
 * - **Asking** (`vaultAskTool`): only the person's own assistant in a turn for them, in any room of theirs (VLT-41);
 *   never an outsiders' turn. A new entry's address passes the Vault's destination rule now, so the person isn't asked
 *   for something that can't be saved; an `entry` is one of theirs of the same kind; a server is asked by
 *   `ask-server.ts`. What the card saves (`vaultAsk`) is written by the server and read back from the stored card when the
 *   form comes, so nothing a client sends can point it elsewhere.
 * - **Saving** (`saveVaultAsk`): as the person who typed it — a new entry by `vault.create` (signed by them, switched on
 *   for the assistant in the same commit, with a login's authenticator key), or a new secret by `vault.setSecret`. A
 *   refusal comes back on the card's field in the Vault's own words, without the value.
 * - **A code** (VLT-44): held in this process's memory for the turn that asked (`login-asks.ts`), for its Hermes to take
 *   once; when that turn is over it came too late, and the agent is woken to try the sign-in again.
 * - **Hermes's own asks** (VLT-45, `turn-asks.ts`) post the same cards with the turn on the message: an answer while
 *   that turn still waits goes to it and wakes nobody.
 */
import {
  CreateVaultEntryBody,
  type GuideCard,
  type GuideVaultAsk,
  LOGIN_ASK_CODE_MAX,
  LOGIN_ASK_WAIT_MS,
  VAULT_ASK_FIELDS,
  VAULT_ASK_TEXT,
  VAULT_ENTRIES_MAX,
  VAULT_LIMIT_MESSAGES,
  type VaultAskInput,
  type VaultAskOutput,
  vaultAskCard,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { dispatches } from '../db/schema/index';
import { postAskCard } from '../guides/ask';
import type { SavedVault } from '../guides/flows';
import { guideError, type PersonalPlace } from '../guides/place';
import { ApiError } from '../lib/errors';
import type { ToolContext } from '../mcp/tools';
import type { MessageRow } from '../read/messages';
import { shortName } from '../read/principals';
import type { Services } from '../services';
import { askServerCard, saveServerAsk } from './ask-server';
import { createVaultEntry, setVaultSecret } from './commands';
import { holdCode } from './login-asks';
import { destinationProblem } from './net';
import { personsEntry, sameKind, shapeOf } from './save';
import { blocked, ownTurn, SELF_SERVE_TEXT } from './self-serve';
import { entryCount } from './store';
import { setVaultTotp } from './totp';
import { failed } from './uses';

type Input = z.output<typeof VaultAskInput>;

/** What the tool answers the agent with when it can't ask (plain, to the agent). */
export const VAULT_ASK_TOOL_TEXT = {
  kind: (name: string) => `That isn’t one of ${name}’s entries of that kind.`,
} as const;

/** `vault_ask`. */
export async function vaultAskTool(ctx: ToolContext, input: Input): Promise<VaultAskOutput> {
  const { services } = ctx;
  // The person's own assistant in a turn for them (an outsiders' turn has no person, OP-17), in any room of theirs.
  const turn = await ownTurn(services.db, ctx);
  if (!turn) return blocked(ctx, 'vault_ask', SELF_SERVE_TEXT.notOwn);
  const assistant = shortName(turn.agent);
  if (input.kind === 'server') return askServerCard(ctx, turn, input);
  if (input.kind === 'code') {
    const ask: GuideVaultAsk = {
      kind: 'code',
      name: input.name ?? '',
      url: null,
      username: null,
      description: input.why ?? '',
      entryId: null,
      ...(input.hint ? { hint: input.hint } : {}),
    };
    // The turn is on the message: a code goes to this turn's sign-in only (VLT-44).
    const messageId = await postAskCard(ctx, vaultAskCard(assistant, ask, input.why ?? null), { turn: true });
    return { status: 'ok', messageId };
  }
  let ask: GuideVaultAsk;
  if (input.entry !== undefined) {
    const row = await personsEntry(services.db, ctx.burrowId, turn.person.id, input.entry);
    if (!row || !sameKind(row, input.kind))
      return failed('invalid_request', VAULT_ASK_TOOL_TEXT.kind(turn.name));
    const auth = row.auth as { username?: string } | null;
    ask = {
      kind: input.kind,
      name: row.name,
      url: row.url,
      username: auth?.username || null,
      description: '',
      entryId: row.id,
    };
  } else {
    const url = input.address ?? '';
    if ((await entryCount(services.db, ctx.burrowId, turn.person.id)) >= VAULT_ENTRIES_MAX)
      return failed('invalid_request', VAULT_LIMIT_MESSAGES.entries);
    // The address is checked now, as a save would check it, so the person isn't asked for something that can't be kept.
    const problem = await destinationProblem(services, url, 'save');
    if (problem) return failed('not_allowed', problem.message);
    ask = {
      kind: input.kind,
      name: input.name ?? '',
      url,
      username: input.username ?? null,
      description: input.why ?? '',
      entryId: null,
    };
  }
  const messageId = await postAskCard(ctx, vaultAskCard(assistant, ask, input.why ?? null));
  return { status: 'ok', messageId };
}

/** A refusal on the card: the field it is about, in the Vault's words, never the value. */
export function refusedOn(field: string, message: string) {
  return guideError('invalid_values', message, { [`values.${field}`]: [message] });
}

/**
 * Whether the turn that asked still takes the card's answer itself: the card carries its turn (a code card, or one
 * Hermes asked for), that turn is still going, and its wait isn't over (a login 10 minutes, a code 5, from the card).
 */
export async function turnTakes(services: Services, row: MessageRow, ask: GuideVaultAsk): Promise<boolean> {
  if (!row.dispatchId || (ask.kind !== 'login' && ask.kind !== 'code')) return false;
  if (services.clock().getTime() > row.createdAt.getTime() + LOGIN_ASK_WAIT_MS[ask.kind]) return false;
  const [d] = await services.db
    .select({ state: dispatches.state })
    .from(dispatches)
    .where(eq(dispatches.id, row.dispatchId));
  return d?.state === 'claimed' || d?.state === 'running';
}

/** Not now: the turn that waits hears it (no wake); else the agent is woken to carry on without it (CIC-14). */
export async function declineVaultAsk(
  services: Services,
  row: MessageRow,
  card: GuideCard,
): Promise<SavedVault> {
  const ask = card.vaultAsk as GuideVaultAsk;
  return { name: ask.name, outcome: 'declined', wake: !(await turnTakes(services, row, ask)) };
}

/** A code as the person typed it, without spaces or dashes; null when it isn't one. */
export function codeOf(text: string | undefined): string | null {
  const code = (text ?? '').replace(/[\s-]/g, '');
  return /^[A-Za-z0-9]+$/.test(code) && code.length <= LOGIN_ASK_CODE_MAX ? code : null;
}

/**
 * The card's form, answered as the person: a new entry or a new secret for theirs, a server signed in to, or a code
 * handed to the turn's sign-in. Refusals are `invalid_values` with the field they are about.
 */
export async function saveVaultAsk(
  services: Services,
  place: PersonalPlace,
  row: MessageRow,
  ask: GuideVaultAsk,
  values: Readonly<Record<string, string>>,
): Promise<SavedVault> {
  if (ask.kind === 'server') return saveServerAsk(services, place, row, ask, values);
  if (ask.kind === 'code') {
    const typed = values[VAULT_ASK_FIELDS.code] ?? '';
    if (!typed.trim()) throw refusedOn(VAULT_ASK_FIELDS.code, VAULT_ASK_TEXT.empty.code);
    const code = codeOf(typed);
    if (!code)
      throw refusedOn(VAULT_ASK_FIELDS.code, 'That isn’t a code: type the letters and digits it shows.');
    // Held for the turn that asked, which takes it once; when that turn is over, it came too late (VLT-44).
    if (row.dispatchId && (await turnTakes(services, row, ask))) {
      holdCode(services, row.id, { dispatchId: row.dispatchId, site: ask.name, code });
      return { name: ask.name, outcome: 'code_given', wake: false };
    }
    return { name: ask.name, outcome: 'too_late', wake: true };
  }
  const saved = await saveSecretAsk(services, place, ask, values);
  return { ...saved, outcome: 'saved', wake: !(await turnTakes(services, row, ask)) };
}

/** A `login`, `token` or `basic` card's secret into the person's Vault (CIC-13). */
async function saveSecretAsk(
  services: Services,
  place: PersonalPlace,
  ask: GuideVaultAsk,
  values: Readonly<Record<string, string>>,
): Promise<{ entryId: string; name: string }> {
  const secret = values[VAULT_ASK_FIELDS.secret] ?? '';
  if (!secret.trim())
    throw refusedOn(
      VAULT_ASK_FIELDS.secret,
      ask.kind === 'token' ? VAULT_ASK_TEXT.empty.token : VAULT_ASK_TEXT.empty.secret,
    );
  const typedUser = values[VAULT_ASK_FIELDS.username]?.trim() ?? '';
  const username = ask.username ?? (typedUser || null);
  // A website login's authenticator key, optional (VLT-46).
  const totp = ask.kind === 'login' ? values[VAULT_ASK_FIELDS.totp]?.trim() || undefined : undefined;
  const options = { burrowId: place.burrow.id, actorId: place.person.id };
  try {
    if (ask.entryId) {
      const res = await services.pipeline.commit(
        setVaultSecret,
        { entryId: ask.entryId, value: secret, ...(typedUser ? { username: typedUser } : {}) },
        options,
      );
      if (res.status !== 'ok') throw refusedOn(VAULT_ASK_FIELDS.secret, 'That can’t be saved now.');
      if (totp) await services.pipeline.commit(setVaultTotp, { entryId: ask.entryId, totp }, options);
      return { entryId: res.result.entryId, name: ask.name };
    }
    if (ask.kind !== 'token' && !username)
      throw refusedOn(VAULT_ASK_FIELDS.username, VAULT_ASK_TEXT.empty.username);
    const { kind, auth } = shapeOf({
      kind: ask.kind as 'login' | 'token' | 'basic',
      username: username ?? undefined,
    });
    const body = CreateVaultEntryBody.safeParse({
      name: ask.name,
      description: ask.description,
      kind,
      url: ask.url ?? '',
      auth,
      secret,
      ...(totp ? { totp } : {}),
    });
    if (!body.success) {
      const issue = body.error.issues[0];
      const field = issue?.path[0] === 'totp' ? VAULT_ASK_FIELDS.totp : VAULT_ASK_FIELDS.secret;
      throw refusedOn(field, issue?.message ?? 'That can’t be saved.');
    }
    const problem = await destinationProblem(services, ask.url ?? '', 'save');
    if (problem) throw refusedOn(VAULT_ASK_FIELDS.secret, problem.message);
    const res = await services.pipeline.commit(createVaultEntry, body.data, options);
    if (res.status !== 'ok') throw refusedOn(VAULT_ASK_FIELDS.secret, 'That can’t be saved now.');
    return { entryId: res.result.entryId, name: ask.name };
  } catch (err) {
    // The Vault's own refusal (a full Vault, a value a header can't carry): its words, never the value.
    if (err instanceof ApiError && err.status < 500 && !isGuideError(err)) {
      const fields = err.extra.fields ?? {};
      const field = fields.totp ? VAULT_ASK_FIELDS.totp : VAULT_ASK_FIELDS.secret;
      throw refusedOn(field, Object.values(fields).flat()[0] ?? err.message);
    }
    throw err;
  }
}

/** One of the card's own refusals (it carries `details.code`), passed on as it is. */
export function isGuideError(err: ApiError): boolean {
  const details = err.extra.details;
  return typeof details === 'object' && details !== null && 'code' in details;
}
