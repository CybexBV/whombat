/** Test helpers for calling as people (the in-process caller, `test/api.ts`) and as agents (dispatch token). */
import { newId } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { issueDispatchToken } from '../auth/agent-tokens';
import { conversations, dispatches, principals } from '../db/schema/index';
import { thePersonAccountId } from '../domain/the-person';
import type { Services } from '../services';
import { TEST_ACCOUNT_BEARER, TEST_ACCOUNT_COOKIE } from './api';

/**
 * Who a test calls as: a seeded person's account, for `t.api.inject` (`cookie` or `bearer` header). People reach the
 * product only through enrolled devices' sessions; tests name the account the session dispatcher would run as.
 */
export async function sessionFor(services: Services, principalId: string) {
  const [person] = await services.db.select().from(principals).where(eq(principals.id, principalId));
  if (!person?.accountId) throw new Error(`${principalId} has no account`);
  const secret = `${TEST_ACCOUNT_BEARER}${person.accountId}`;
  return {
    accountId: person.accountId,
    secret,
    cookie: `${TEST_ACCOUNT_COOKIE}=${person.accountId}`,
    bearer: `Bearer ${secret}`,
  };
}

/** What a test dispatch is: its trigger, the person it is for (CT-69), a search answer's mode. */
export interface TestDispatchOptions {
  trigger?: typeof dispatches.$inferInsert.trigger;
  mode?: 'reply' | 'answer' | 'run';
  /**
   * The person the work is for (`dispatches.on_behalf_of_account_id`); null: an outsiders' turn (one-person.md OP-S41).
   * Default: the person whose own room with the agent the conversation is, else the person (as the product queues it).
   */
  onBehalfOfAccountId?: string | null;
  messageId?: string | null;
  threadRootId?: string | null;
  state?: 'queued' | 'claimed' | 'running';
  search?: typeof dispatches.$inferInsert.search;
  /** The run a `run` turn carries on. */
  runId?: string | null;
}

/** The account of the person whose own room with the agent a conversation is (their Chat, Feedback room), else the person's. */
async function roomPersonAccount(services: Services, conversationId: string): Promise<string | null> {
  const [room] = await services.db
    .select({ kind: conversations.kind, person: conversations.dmPersonId, burrowId: conversations.burrowId })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (!room) return null;
  if (room.kind !== 'dm' || !room.person) return thePersonAccountId(services.db, room.burrowId);
  const [person] = await services.db
    .select({ accountId: principals.accountId })
    .from(principals)
    .where(eq(principals.id, room.person));
  return person?.accountId ?? null;
}

/** A live dispatch for an agent with a fresh agent token (`Authorization: Bearer wat_…`). */
export async function agentTokenFor(
  services: Services,
  burrowId: string,
  agentId: string,
  conversationId: string,
  options: TestDispatchOptions = {},
) {
  const id = newId('dispatch');
  const onBehalfOfAccountId =
    options.onBehalfOfAccountId !== undefined
      ? options.onBehalfOfAccountId
      : await roomPersonAccount(services, conversationId);
  await services.db.insert(dispatches).values({
    id,
    burrowId,
    agentId,
    trigger: options.trigger ?? 'mention',
    mode: options.mode ?? 'reply',
    conversationId,
    state: options.state ?? 'running',
    onBehalfOfAccountId,
    messageId: options.messageId ?? null,
    threadRootId: options.threadRootId ?? null,
    search: options.search ?? null,
    runId: options.runId ?? null,
    createdAt: services.clock(),
  });
  return { dispatchId: id, ...(await tokenForDispatch(services, id)) };
}

/** A fresh agent token for an existing (live) dispatch. */
export async function tokenForDispatch(services: Services, dispatchId: string) {
  const { token } = await issueDispatchToken(services, dispatchId);
  return { token, bearer: `Bearer ${token}` };
}

/** The account of a person principal. */
export async function accountOf(services: Services, principalId: string): Promise<string> {
  const [row] = await services.db.select().from(principals).where(eq(principals.id, principalId));
  if (!row?.accountId) throw new Error(`${principalId} has no account`);
  return row.accountId;
}
