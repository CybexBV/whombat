/**
 * Fencing on a managed appliance (docs/decisions/managed-sandbox.md MSB-10): the runner's lease — its runner id,
 * which carries the runner generation, and the claim's attempt — is a fencing token every write point must
 * carry. A stale generation (a runner that restarted, or one partitioned from the server) is refused at every
 * write point: progress, completion, git credentials (pushes, fetches) and attachment and pack-skill fetches.
 * A call without a token is refused too (self-hosted keeps accepting it from older runners).
 */
import { type DispatchContext, runnerApi } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { dispatches } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';

const t = useTestServer({ seed: true, app: true, env: { WHOMBAT_MODE: 'managed' } });
const AUTH = { authorization: 'Bearer dev-runner-token' };
/** Generation 7 of the appliance's runner, then generation 8 after a restart. */
const G7 = 'rnr_appliance_g7';
const G8 = 'rnr_appliance_g8';

beforeAll(() => {
  Object.assign(t.services.runtime.options, { retryBackoffMs: 40, pollMs: 20 });
});

const post = (url: string, payload: unknown) =>
  t.api.inject({ method: 'POST', url, headers: AUTH, payload: payload as object });
const url = (id: string, what: string) => `/internal/runner/dispatches/${id}/${what}`;

async function claim(runnerId: string): Promise<DispatchContext | null> {
  const res = await post('/internal/runner/claim', { runnerId, providers: ['claude'], waitMs: 500 });
  expect(res.statusCode).toBe(200);
  return runnerApi.claim.response.parse(res.json()).dispatch;
}

const row = async (id: string) => {
  const [r] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, id));
  if (!r) throw new Error('no dispatch');
  return r;
};

describe('managed fencing tokens', () => {
  it('refuses a stale generation at every write point, and a call without a token', async () => {
    const res = await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.incidents,
      text: '@Dusty did the backup run?',
    });
    expect(res.status).toBe('ok');
    // Generation 7 claims it with a short lease …
    Object.assign(t.services.runtime.options, { leaseMs: 30 });
    const first = await claim(G7);
    if (!first) throw new Error('no claim');
    const stale = { runnerId: G7, attempt: first.dispatch.attempts };
    expect(stale.attempt).toBe(1);

    // … and dies without a word; its lease expires and generation 8 claims the dispatch again.
    await new Promise((r) => setTimeout(r, 60));
    expect(await t.services.runtime.sweep()).toBe(1);
    Object.assign(t.services.runtime.options, { leaseMs: 60_000 });
    const second = await claim(G8);
    expect(second?.dispatch).toMatchObject({ id: first.dispatch.id, runnerId: G8, attempts: 2 });
    const current = { runnerId: G8, attempt: 2 };
    const before = await row(first.dispatch.id);

    // Every write point refuses generation 7 …
    const progress = await post(url(first.dispatch.id, 'progress'), { state: 'running', ...stale });
    expect(progress.json()).toEqual({ cancel: true, reason: 'cancelled' });
    for (const body of [
      { outcome: 'done', ...stale },
      { outcome: 'failed', error: 'claude exited', ...stale },
      { outcome: 'cancelled', ...stale },
    ])
      expect((await post(url(first.dispatch.id, 'complete'), body)).statusCode).toBe(409);
    for (const operation of ['push', 'fetch'])
      expect(
        (
          await post(url(first.dispatch.id, 'git-credentials'), {
            repo: 'whombat/billing',
            branch: 'feat/invoice-pdf',
            operation,
            ...stale,
          })
        ).statusCode,
      ).toBe(409);
    const attachment = await t.api.inject({
      method: 'GET',
      url: `/internal/runner/dispatches/${first.dispatch.id}/attachments/att_nope?runnerId=${G7}&attempt=1`,
      headers: AUTH,
    });
    expect(attachment.statusCode).toBe(409);

    // … and every call that carries no token (or half of one) — a stale writer can't just leave it out.
    expect((await post(url(first.dispatch.id, 'progress'), { state: 'running' })).json()).toEqual({
      cancel: true,
      reason: 'cancelled',
    });
    expect((await post(url(first.dispatch.id, 'complete'), { outcome: 'done' })).statusCode).toBe(409);
    expect(
      (await post(url(first.dispatch.id, 'complete'), { outcome: 'done', runnerId: G8 })).statusCode,
    ).toBe(409);
    expect(
      (
        await post(url(first.dispatch.id, 'git-credentials'), {
          repo: 'whombat/billing',
          branch: 'feat/invoice-pdf',
          operation: 'push',
        })
      ).statusCode,
    ).toBe(409);

    // Nothing moved: generation 8 still holds it, with its lease as it was.
    expect(await row(first.dispatch.id)).toMatchObject({
      state: 'claimed',
      runnerId: G8,
      attempts: 2,
      leaseExpiresAt: before.leaseExpiresAt,
    });

    // Generation 8 holds the lease: its beats and its completion count.
    expect((await post(url(first.dispatch.id, 'progress'), { state: 'running', ...current })).json()).toEqual(
      {
        cancel: false,
        reason: null,
      },
    );
    expect((await post(url(first.dispatch.id, 'complete'), { outcome: 'done', ...current })).statusCode).toBe(
      200,
    );
    expect(await row(first.dispatch.id)).toMatchObject({ state: 'done' });
  });
});
