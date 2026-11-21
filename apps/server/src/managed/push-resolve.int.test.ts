/**
 * `push.resolve` (contracts 0.5.2 CT-49, MA-20; docs/decisions/managed-runtime.md MR-39): a notification tap maps the
 * content-free push's keyed ref back to the person's item it was for, and answers `not_found` for an
 * unknown ref and a message that is gone.
 */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { messages } from '../db/schema/index';
import { notify } from '../domain/notify';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';

const m = useManagedRuntime({ seed: true });
let mara: Awaited<ReturnType<typeof m.enroll>>;
let ref = '';
let messageId = '';

beforeAll(async () => {
  mara = await m.enroll(IDS.mara);
  const c = await m.client(mara);
  expect(await c.request('push.handles.set', { handle: 'push-handle-mara-000001' })).toMatchObject({
    t: 'result',
  });
  const [message] = await m.t.services.db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, IDS.billing))
    .limit(1);
  messageId = message?.id as string;
  const before = m.manager.pushes.length;
  await notify(m.t.services, [
    {
      burrowId: m.t.burrowId,
      burrowSlug: 'burrow-hq',
      principalId: IDS.mara,
      kind: 'mention',
      actorId: IDS.dusty,
      where: 'billing-v2',
      text: 'Can you look at this?',
      link: { type: 'message', in: { type: 'pr', number: 482 }, messageId },
      createdAt: new Date(),
    },
  ]);
  // Push goes out in the background (server-efficiency.md SV-02).
  await m.t.services.background.settle();
  const sent = m.manager.pushes.slice(before);
  expect(sent).toHaveLength(1);
  ref = sent[0]?.ref as string;
});

describe('push.resolve', () => {
  it('resolves the person’s own notification to its burrow and link', async () => {
    const c = await m.client(mara);
    expect(await c.request('push.resolve', { ref })).toMatchObject({
      t: 'result',
      output: {
        burrow: 'burrow-hq',
        link: { type: 'message', in: { type: 'pr', number: 482 }, messageId },
      },
    });
  });

  it('answers not_found for an unknown ref', async () => {
    const unknown = await (await m.client(mara)).request('push.resolve', { ref: 'A'.repeat(22) });
    expect(unknown).toMatchObject({ t: 'error', code: 'not_found' });
    // Unenrolled keys can't ask.
    expect(await (await m.client()).request('push.resolve', { ref })).toMatchObject({
      t: 'error',
      code: 'enrollment_required',
    });
  });

  it('not_found once the message is gone', async () => {
    await m.t.services.db.delete(messages).where(eq(messages.id, messageId));
    expect(await (await m.client(mara)).request('push.resolve', { ref })).toMatchObject({
      t: 'error',
      code: 'not_found',
    });
  });
});
