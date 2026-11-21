/**
 * Attachments follow memory's budget (docs/decisions/buzz-parity.md, integration of A and B): a dispatch lists
 * only the files on messages its context actually delivers, and the runner can fetch exactly those.
 */
import { type DispatchContext, runnerApi } from '@whombat/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { WINDOW_SIZE } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { upload } from '../test/files';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });
const RUNNER = { authorization: 'Bearer dev-runner-token' };
let mara: Record<string, string> = {};

beforeAll(async () => {
  mara = { cookie: (await sessionFor(t.services, IDS.mara)).cookie };
});

async function claim(): Promise<DispatchContext> {
  const res = await t.api.inject({
    method: 'POST',
    url: '/internal/runner/claim',
    headers: RUNNER,
    payload: { runnerId: 'rnr_window', providers: ['claude'], waitMs: 2000 },
  });
  expect(res.statusCode).toBe(200);
  const dispatch = runnerApi.claim.response.parse(res.json()).dispatch;
  expect(dispatch).not.toBeNull();
  return dispatch as DispatchContext;
}

describe('attachments and the bounded context window', () => {
  it('lists only files on delivered messages, and each listed file is fetchable', async () => {
    const old = await upload(t.api, mara, IDS.billing, 'old.log', Buffer.from('old log line\n'));
    await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      text: 'An old log for later.',
      attachmentIds: [old.id],
    });
    // Enough newer chatter that the window cannot carry the old message.
    for (let i = 0; i < WINDOW_SIZE; i++) {
      await t.commit(IDS.mara, sendMessage, {
        conversationId: IDS.billing,
        text: `Status note ${i}: ${'the invoice run is still going and nothing has changed yet. '.repeat(3)}`,
      });
    }
    const fresh = await upload(t.api, mara, IDS.billing, 'fresh.log', Buffer.from('fresh log line\n'));
    await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      text: '@Dusty what does the fresh log say?',
      attachmentIds: [fresh.id],
    });

    const ctx = await claim();
    const delivered = new Set([
      ...(ctx.trigger ? [ctx.trigger.id] : []),
      ...ctx.window.map((m) => m.id),
      ...(ctx.thread ? [ctx.thread.root.id, ...ctx.thread.replies.map((m) => m.id)] : []),
    ]);
    expect(ctx.window.some((m) => m.text === 'An old log for later.')).toBe(false);
    const listed = ctx.attachments.map((a) => a.id);
    expect(listed).toContain(fresh.id);
    expect(listed).not.toContain(old.id);
    for (const a of ctx.attachments) expect(delivered.has(a.messageId)).toBe(true);

    const lease = `runnerId=rnr_window&attempt=${ctx.dispatch.attempts ?? 1}`;
    const got = await t.api.inject({
      method: 'GET',
      url: `/internal/runner/dispatches/${ctx.dispatch.id}/attachments/${fresh.id}?${lease}`,
      headers: RUNNER,
    });
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.toString()).toBe('fresh log line\n');
  });
});
