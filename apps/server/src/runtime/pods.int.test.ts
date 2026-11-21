/**
 * The person's Hermes through the server (hermes-native.md HN-W10, HN-W11; one-person.md OP-08): two of Mara's conversations, and two
 * threads of her Chat (HN-T01), run at once in her pod, neither waits for the other nor fails as “still busy”; her
 * Hermes-home steps still work, quiescing the pod. The scripted Hermes in the runner's stand-in sandbox (`startTestRunner`), so this needs Postgres for the turns'
 * claims, messages and Hermes-home steps.
 */
import { CANNED_REPLY } from '@whombat/agent-runtime/testing/hermes';
import { and, asc, eq, gt } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { messages } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { chatWith } from '../test/rooms';
import { startTestRunner, type TestRunner, waitFor } from '../test/runner';
import { SCRIPTED_ENV } from '../test/scripted';

const t = useTestServer({ seed: true, listen: true, env: { ...SCRIPTED_ENV } });
let runner: TestRunner;

beforeAll(async () => {
  // Slow enough that two turns overlap.
  runner = await startTestRunner(t.baseUrl, { thinkMs: 1500, tickMs: 50 });
});
afterAll(async () => {
  await runner?.stop();
});

async function say(conversationId: string, text: string): Promise<string> {
  const res = await t.commit(IDS.mara, sendMessage, { conversationId, text });
  if (res.status !== 'ok') throw new Error('send failed');
  return res.result.id;
}

/** The agent's first message in `conversationId` after `afterId` (in its thread or not). */
async function replyAfter(conversationId: string, afterId: string) {
  const [after] = await t.services.db.select().from(messages).where(eq(messages.id, afterId));
  if (!after) return null;
  const rows = await t.services.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.authorId, IDS.dusty),
        gt(messages.ord, after.ord),
      ),
    )
    .orderBy(asc(messages.ord));
  return rows[0] ?? null;
}

const replyTo = async (asked: string) =>
  (
    await t.services.db
      .select()
      .from(messages)
      .where(and(eq(messages.threadRootId, asked), eq(messages.authorId, IDS.dusty)))
  ).at(0);

describe('the person’s Hermes', () => {
  it('runs two of the person’s conversations at once in their pod', async () => {
    // Two conversations: the server runs one turn per thread at a time, the person's pod several of theirs.
    const chat = await chatWith(t.services, t.burrowId, IDS.dusty, IDS.mara);
    const first = await say(chat, '@Dusty can you look at the PDF cache?');
    const second = await say(IDS.billing, '@Dusty and what about the invoices?');
    // Both turns live in Mara's pod at the same time.
    await waitFor(() => runner.pods?.pods().some((p) => p.turns === 2), 15_000, 'two live turns in the pod');
    const a = await waitFor(() => replyTo(first), 20_000, 'the first reply');
    const b = await waitFor(() => replyAfter(IDS.billing, second), 20_000, 'the second reply');
    expect(a.text).toBe(CANNED_REPLY);
    expect(b.text).toBe(CANNED_REPLY);
    // One pod, with each turn's session bound while it ran.
    expect(runner.pods?.pods()).toHaveLength(1);
  });

  it('runs two threads of a person’s Chat at once in their pod', async () => {
    const chat = await chatWith(t.services, t.burrowId, IDS.dusty, IDS.mara);
    await waitFor(() => runner.pods?.pods().every((p) => p.turns === 0), 15_000, 'the pod idle');
    // Each top-level message in Chat opens its own thread (chat-channel.md CHT-02), and threads run side by side (HN-T01).
    const first = await say(chat, '@Dusty what is in the PDF cache?');
    const second = await say(chat, '@Dusty and how big is it?');
    await waitFor(() => runner.pods?.pods().some((p) => p.turns === 2), 15_000, 'two live turns in the pod');
    const a = await waitFor(() => replyTo(first), 20_000, 'the first thread’s reply');
    const b = await waitFor(() => replyTo(second), 20_000, 'the second thread’s reply');
    expect([a.text, b.text]).toEqual([CANNED_REPLY, CANNED_REPLY]);
  });

  it('quiesces the person’s pod for a Hermes-home step, and the next turn starts it again', async () => {
    const chat = await chatWith(t.services, t.burrowId, IDS.dusty, IDS.mara);
    await waitFor(() => runner.pods?.pods().every((p) => p.turns === 0), 15_000, 'the pod idle');
    // A step on Mara's home: her pod stops for it (nothing of hers runs now), and the step runs under her profile lock.
    const ran = await runner.hermesHome.ctx.withProfile(async () => true);
    expect(ran).toBe(true);
    expect(runner.pods?.pods()).toEqual([]);
    const asked = await say(chat, '@Dusty one more?');
    expect((await waitFor(() => replyTo(asked), 20_000, 'the reply after the step')).text).toBe(CANNED_REPLY);
  });
});
