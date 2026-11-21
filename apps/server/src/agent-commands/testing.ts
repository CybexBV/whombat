/**
 * Test kit for the agent's commands: a live dispatch held by a test runner (as a claim leaves it), the runner's endpoints
 * over the app, and the seeded people's accounts. Integration tests only.
 */
import { buildPath, newId, toQueryString } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { sendMessage } from '../commands/messages';
import { dispatches } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import type { TestServer } from '../test/harness';
import { accountOf } from '../test/tokens';

export const RUNNER = 'rnr_commands_test';
export const RUNNER_AUTH = { authorization: 'Bearer dev-runner-token' };

export interface LiveDispatchOptions {
  agentId?: string;
  conversationId?: string;
  /** The person the turn works for (Mara, the person); null: an outsiders' turn. */
  person?: string | null;
  threadRootId?: string | null;
  runId?: string | null;
  trigger?: 'mention' | 'dm' | 'search' | 'feedback' | 'approval_granted';
  state?: 'queued' | 'running';
}

/** A dispatch claimed by `RUNNER` (attempt 1) and running, for the agent (Dusty in #billing-v2 by default). */
export async function liveDispatch(t: TestServer, options: LiveDispatchOptions = {}) {
  const person = options.person === undefined ? IDS.mara : options.person;
  const [row] = await t.services.db
    .insert(dispatches)
    .values({
      id: newId('dispatch'),
      burrowId: t.burrowId,
      agentId: options.agentId ?? IDS.dusty,
      trigger: options.trigger ?? 'mention',
      conversationId: options.conversationId ?? IDS.billing,
      threadRootId: options.threadRootId ?? null,
      runId: options.runId ?? null,
      state: options.state ?? 'running',
      runnerId: RUNNER,
      attempts: 1,
      createdAt: t.services.clock(),
      claimedAt: t.services.clock(),
      leaseExpiresAt: new Date(t.services.clock().getTime() + 600_000),
      onBehalfOfAccountId: person ? await accountOf(t.services, person) : null,
    })
    .returning();
  if (!row) throw new Error('no dispatch');
  return row;
}

/** Holds an existing dispatch as `RUNNER` (a queued wake, say), running. */
export async function holdDispatch(t: TestServer, id: string) {
  const [row] = await t.services.db
    .update(dispatches)
    .set({ state: 'running', runnerId: RUNNER, attempts: 1, claimedAt: t.services.clock() })
    .where(eq(dispatches.id, id))
    .returning();
  if (!row) throw new Error('no dispatch');
  return row;
}

/** A top-level message by a person, to hang a turn's thread on. */
export async function threadRoot(t: TestServer, by: string, conversationId: string, text: string) {
  const res = await t.commit(by, sendMessage, { conversationId, text });
  if (res.status !== 'ok') throw new Error('no message');
  return (res.result as { id: string }).id;
}

/** A runner endpoint over the app. */
export async function runnerCall(
  t: TestServer,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string> = {},
  body?: unknown,
  query?: Record<string, unknown>,
) {
  const res = await t.api.inject({
    method,
    url: `/internal/runner${buildPath(path, params)}${toQueryString(query as never)}`,
    headers: RUNNER_AUTH,
    ...(body === undefined ? {} : { payload: body as object }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = res.json();
  } catch {
    json = {};
  }
  return { status: res.statusCode, body: json };
}
