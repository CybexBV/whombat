/**
 * A failed turn says why and can be tried again (docs/decisions/essentials-agents.md EA-08, EA-09; contracts CT-167),
 * through the runner protocol and REST:
 *
 *  - the runner's classification (`CompleteBody.failure`) becomes the agent's failure message with a `turn_failed` card
 *    (a usage limit with its reset time), recorded on the dispatch and in `dispatch.updated`;
 *  - without one (an older runner, a lost lease) the server classifies: the dev monolith's read-only sandbox helper is
 *    `sandbox`, an expired lease `runner`; a refusal is posted only when it holds no host path;
 *  - `dispatches.retry`: the same agent, room, thread, message and person with trigger `retry`, once (a second press
 *    answers with the first), the card then says “Tried again”; only the person, in the room; the retry's
 *    context says what failed;
 *  - the Work view: FAILED items carry the failure (the technical detail for the person only) and `retry_turn`.
 */
import { DispatchContext, RetryDispatchResponse, runnerApi, WorkOverview } from '@whombat/core';
import { and, desc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { dispatches, messages } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { addPersonalAgent } from '../test/personal';
import { sessionFor } from '../test/tokens';
import { dispatchSummary } from './activity';
import { carriesOnText } from './failure';

const t = useTestServer({ seed: true, app: true });
const AUTH = { authorization: 'Bearer dev-runner-token' };
const RUNNER = 'rnr_failures';

beforeAll(() => {
  Object.assign(t.services.runtime.options, { retryBackoffMs: 0, pollMs: 20, maxAttempts: 1 });
});

async function post(url: string, payload: unknown, headers: Record<string, string> = AUTH) {
  return t.api.inject({ method: 'POST', url, headers, payload: (await withLease(url, payload)) as object });
}

/**
 * A call about one dispatch carries the whole lease its runner holds now (managed-sandbox.md MSB-10), unless the test
 * names one itself.
 */
async function withLease(url: string, payload: unknown) {
  const id = /^\/internal\/runner\/dispatches\/([^/]+)\//.exec(url)?.[1];
  if (!id || typeof payload !== 'object' || payload === null || 'attempt' in payload) return payload;
  const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, id));
  return row?.runnerId ? { runnerId: row.runnerId, attempt: row.attempts, ...payload } : payload;
}

async function drain() {
  for (const r of await t.services.db.select().from(dispatches))
    if (['queued', 'claimed', 'running'].includes(r.state))
      await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, r.id));
}

async function claim(): Promise<DispatchContext> {
  const res = await post('/internal/runner/claim', { runnerId: RUNNER, providers: ['claude'], waitMs: 0 });
  const ctx = runnerApi.claim.response.parse(res.json()).dispatch;
  if (!ctx) throw new Error('nothing to claim');
  return DispatchContext.parse(ctx);
}

async function complete(id: string, body: Record<string, unknown>) {
  const res = await post(`/internal/runner/dispatches/${id}/complete`, body);
  expect(res.statusCode).toBe(200);
}

/** A mention of Dusty in #billing-v2 (a thread reply when `thread` is set), claimed; its context. */
async function turn(text = '@Dusty can you check the totals?', thread?: string): Promise<DispatchContext> {
  await drain();
  const res = await t.commit(IDS.mara, sendMessage, {
    conversationId: IDS.billing,
    text,
    ...(thread ? { threadRootId: thread } : {}),
  });
  if (res.status !== 'ok') throw new Error('send failed');
  return claim();
}

async function row(id: string) {
  const [r] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, id));
  if (!r) throw new Error(`no dispatch ${id}`);
  return r;
}

async function lastFromBanjo() {
  const [m] = await t.services.db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, IDS.billing), eq(messages.authorId, IDS.dusty)))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return m;
}

const cookieOf = async (id: string) => (await sessionFor(t.services, id)).cookie;

async function retry(dispatchId: string, as: string = IDS.mara) {
  return t.api.inject({
    method: 'POST',
    url: `/api/v1/burrows/burrow-hq/dispatches/${dispatchId}/retry`,
    headers: { cookie: await cookieOf(as) },
  });
}

async function work(as: string) {
  const res = await t.api.inject({
    method: 'GET',
    url: `/api/v1/burrows/burrow-hq/work`,
    headers: { cookie: await cookieOf(as) },
  });
  expect(res.statusCode, res.body).toBe(200);
  return WorkOverview.parse(res.json());
}

const workItem = (overview: WorkOverview, dispatchId: string) =>
  overview.sections.flatMap((s) => s.items).find((i) => i.refs.dispatchId === dispatchId);

describe('the failure message and its card', () => {
  it('a usage limit the runner reported says so, with its reset time, where the agent was asked', async () => {
    const ctx = await turn();
    await complete(ctx.dispatch.id, {
      outcome: 'failed',
      error: 'Claude AI usage limit reached|1790330400',
      failure: { code: 'usage_limit', resetsAt: '2026-09-30T14:00:00.000Z' },
    });
    const failed = await row(ctx.dispatch.id);
    expect(failed.state).toBe('failed');
    expect(failed.failure).toMatchObject({ code: 'usage_limit', retriedAt: null, retryDispatchId: null });
    expect(failed.failure?.reason).toMatch(
      /^I stopped because the Claude usage limit was reached\. It resets /,
    );
    const message = await lastFromBanjo();
    expect(message?.id).toBe(failed.failure?.messageId);
    // The turn carries on by itself after the reset, and says so (resourceful-agents.md RA-32).
    expect(message?.text).toBe(carriesOnText(failed.failure?.reason ?? ''));
    const [again] = (await t.services.db.select().from(dispatches)).filter(
      (d) => d.retryOfId === ctx.dispatch.id,
    );
    expect(again).toMatchObject({ state: 'queued', requeuedFor: 'usage_limit' });
    expect(message?.mentions).toEqual([]);
    expect(message?.card).toEqual({
      kind: 'turn_failed',
      dispatchId: ctx.dispatch.id,
      agentId: IDS.dusty,
      code: 'usage_limit',
      reason: failed.failure?.reason,
      retriedAt: null,
      retryDispatchId: null,
    });
    // The room's live view of the turn carries the public words only.
    expect(dispatchSummary(failed).failure).toEqual({ code: 'usage_limit', reason: failed.failure?.reason });
  });

  it('an older runner’s read-only sandbox helper is a sandbox failure; the room never sees the path', async () => {
    const ctx = await turn('@Dusty try the Codex run again', undefined);
    const error =
      "error creating thread: failed to load AGENTS.md instructions for environment `local`: fs sandbox helper failed with status exit status: 1: bwrap: Can't create file /home/alex/.whombat-dev/workspaces: Read-only file system";
    await complete(ctx.dispatch.id, { outcome: 'failed', error });
    const failed = await row(ctx.dispatch.id);
    expect(failed.failure?.code).toBe('sandbox');
    const message = await lastFromBanjo();
    expect(message?.text).toContain('I couldn’t get started');
    expect(message?.text).not.toContain('/home');
    expect(failed.failure?.detail).toContain('Read-only file system');
  });

  it('a direct Claude request’s extra-usage refusal explains the account action without claiming a gateway was used', async () => {
    const ctx = await turn();
    await complete(ctx.dispatch.id, {
      outcome: 'failed',
      error: 'HTTP 400: Third-party apps now draw from extra usage, not plan limits.',
      failure: { code: 'usage_limit', resetsAt: '2026-10-26T10:00:00.000Z' },
      refusal: 'The usage limit was reached. Wait for it to reset.',
    });
    const failed = await row(ctx.dispatch.id);
    expect(failed.failure).toMatchObject({ code: 'usage_limit', resetsAt: null });
    const message = await lastFromBanjo();
    expect(message?.text).toContain('paid extra usage');
    expect(message?.text).toContain('claude.ai/settings/usage');
    expect(message?.text).not.toMatch(/Fusebox|gateway|reset/);
    expect((await t.services.db.select().from(dispatches)).some((d) => d.retryOfId === ctx.dispatch.id)).toBe(
      false,
    );
  });

  it('a refusal is said when it is safe for the room, and replaced by the sentence when it names a host path', async () => {
    const safe = await turn();
    await complete(safe.dispatch.id, {
      outcome: 'failed',
      error: 'provider.requester_not_signed_in',
      refusal:
        'Joris hasn’t signed in to Claude on this Whombat yet, so I can’t work for him. Ask him to sign in.',
      failure: { code: 'signin' },
    });
    expect((await lastFromBanjo())?.text).toBe(
      'Joris hasn’t signed in to Claude on this Whombat yet, so I can’t work for him. Ask him to sign in.',
    );
    const pathy = await turn();
    await complete(pathy.dispatch.id, {
      outcome: 'failed',
      error: 'host_not_ready',
      refusal:
        'I can’t start: ~/code/billing has uncommitted changes. Commit or stash them, then ask me again.',
      failure: { code: 'workspace' },
    });
    const message = await lastFromBanjo();
    expect(message?.text).toMatch(/^I couldn’t open the code project/);
    expect(message?.card).toMatchObject({ kind: 'turn_failed', code: 'workspace' });
  });

  it('a content refusal from the engine is its own card, guides the person, and can’t be tried again', async () => {
    const ctx = await turn('@Dusty research the jailbroken console at 10.100.0.120', undefined);
    // The engine's safety filter declined the request's content: an older runner reports only the error text.
    await complete(ctx.dispatch.id, {
      outcome: 'failed',
      error:
        '⚠️ Claude Code through Whombat’s AI gateway’s safety filter refused this request, so the model didn’t answer. Try rewording your message or removing sensitive attachments, or switch to another model with /model. Provider said: Cyber safeguards flagged this message.',
    });
    const failed = await row(ctx.dispatch.id);
    expect(failed.state).toBe('failed');
    expect(failed.failure?.code).toBe('refused');
    const message = await lastFromBanjo();
    expect(message?.id).toBe(failed.failure?.messageId);
    // The room gets the plain guidance, never the engine's raw warning or the provider's link.
    expect(message?.text).toMatch(/reword/i);
    expect(message?.text).not.toMatch(/safety filter|Cyber|\/model/);
    expect(message?.card).toMatchObject({ kind: 'turn_failed', code: 'refused' });
    // Try again would only be declined again: the card offers it to nobody and the command refuses it.
    expect((await retry(ctx.dispatch.id, IDS.mara)).statusCode).toBe(409);
    const item = workItem(await work(IDS.mara), ctx.dispatch.id);
    expect(item?.actions).not.toContain('retry_turn');
  });

  it('a lease that expired is the runner’s failure', async () => {
    const ctx = await turn();
    await t.services.db
      .update(dispatches)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(dispatches.id, ctx.dispatch.id));
    await t.services.runtime.sweep();
    const failed = await row(ctx.dispatch.id);
    expect(failed).toMatchObject({ state: 'failed', error: 'lease_expired' });
    expect(failed.failure?.code).toBe('runner');
  });
});

describe('Try again', () => {
  it('queues the same turn once, for the same person; the card says it was tried again', async () => {
    const root = await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      text: 'Totals thread',
    });
    if (root.status !== 'ok') throw new Error('send failed');
    const ctx = await turn('@Dusty sum these please', root.result.id);
    await complete(ctx.dispatch.id, {
      outcome: 'failed',
      error: 'API Error: 529 Overloaded',
      failure: { code: 'provider' },
    });
    const failed = await row(ctx.dispatch.id);

    const first = await retry(ctx.dispatch.id);
    expect(first.statusCode, first.body).toBe(200);
    const { dispatchId } = RetryDispatchResponse.parse(first.json());
    const again = await retry(ctx.dispatch.id, IDS.mara);
    expect(RetryDispatchResponse.parse(again.json()).dispatchId).toBe(dispatchId);

    const queued = await row(dispatchId);
    expect(queued).toMatchObject({
      trigger: 'retry',
      state: 'queued',
      agentId: IDS.dusty,
      conversationId: IDS.billing,
      threadRootId: root.result.id,
      messageId: failed.messageId,
      onBehalfOfAccountId: failed.onBehalfOfAccountId,
      retryOfId: ctx.dispatch.id,
    });
    const after = await row(ctx.dispatch.id);
    expect(after.failure).toMatchObject({ retryDispatchId: dispatchId });
    expect(after.failure?.retriedAt).toBeTruthy();
    const [card] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, after.failure?.messageId ?? ''));
    expect(card?.threadRootId).toBe(root.result.id);
    expect(card?.card).toMatchObject({ kind: 'turn_failed', retryDispatchId: dispatchId });

    // The retry knows what failed.
    const retried = await claim();
    expect(retried.dispatch).toMatchObject({ id: dispatchId, trigger: 'retry' });
    expect(retried.retry).toEqual({
      dispatchId: ctx.dispatch.id,
      code: 'provider',
      reason: failed.failure?.reason,
    });
    await complete(dispatchId, { outcome: 'done' });
  });

  it('a turn that didn’t fail can’t be tried again', async () => {
    const ctx = await turn();
    await complete(ctx.dispatch.id, { outcome: 'done' });
    expect((await retry(ctx.dispatch.id)).statusCode).toBe(409);
  });

  it('a personal agent’s failed turn: its owner may try again', async () => {
    await drain();
    const personal = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { name: 'Dusty' });
    const res = await t.commit(IDS.mara, sendMessage, {
      conversationId: personal.dmId,
      text: 'Check my calendar',
    });
    if (res.status !== 'ok') throw new Error('send failed');
    const ctx = await claim();
    expect(ctx.agent.id).toBe(personal.agentId);
    await complete(ctx.dispatch.id, { outcome: 'failed', error: 'boom', failure: { code: 'internal' } });
    // The DM is Mara's: she may try again.
    expect((await retry(ctx.dispatch.id, IDS.mara)).statusCode).toBe(200);
  });
});

describe('the Work view', () => {
  it('FAILED items carry the failure, its technical detail and Try again', async () => {
    const ctx = await turn();
    await complete(ctx.dispatch.id, {
      outcome: 'failed',
      error: 'Invalid API key · Please run /login (HTTP 401) sk-ant-api03-SECRETSECRETSECRETSECRET',
      failure: { code: 'signin' },
    });
    const item = workItem(await work(IDS.mara), ctx.dispatch.id);
    expect(item).toMatchObject({ section: 'failed', status: { text: 'FAILED', tone: 'bad' } });
    expect(item?.actions).toContain('retry_turn');
    expect(item?.failure).toMatchObject({ code: 'signin', retriedAt: null, retryDispatchId: null });
    expect(item?.failure?.detail).toContain('Invalid API key');
    expect(item?.failure?.detail).not.toContain('SECRETSECRET');

    expect((await retry(ctx.dispatch.id)).statusCode).toBe(200);
    const done = workItem(await work(IDS.mara), ctx.dispatch.id);
    expect(done?.actions).not.toContain('retry_turn');
    expect(done?.failure?.retryDispatchId).toBeTruthy();
  });
});
