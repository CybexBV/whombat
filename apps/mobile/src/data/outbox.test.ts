/** Messages written offline (AP-717): kept sealed, sent in order on reconnect, Retry and Delete when refused. */
import { defaultCrypto } from '@libp2p/noise/crypto';
import { describe, expect, it } from 'vitest';
import {
  createOutbox,
  MAX_ATTEMPTS,
  nextToSend,
  type OutboxMessage,
  outboxFor,
  outboxLabel,
  type SendOutcome,
  sendOutcome,
} from './outbox';
import { type BoxCrypto, createSecureBox, memoryBoxDeps } from './secureBox';

const box = () => createSecureBox(memoryBoxDeps(defaultCrypto as unknown as BoxCrypto));
const msg = (
  id: string,
  conversationId: string,
  state: OutboxMessage['state'] = 'waiting',
): OutboxMessage => ({
  id,
  burrow: 'burrow-hq',
  conversationId,
  threadRootId: null,
  text: id,
  createdAt: 0,
  state,
  attempts: 0,
});

describe('the outbox (AP-717)', () => {
  it('reads a send’s answer: taken, not now, or refused', () => {
    expect(sendOutcome({ result: { status: 'ok' } })).toEqual({ kind: 'sent' });
    expect(sendOutcome({ result: { status: 'pending_approval' } })).toEqual({ kind: 'sent' });
    expect(sendOutcome({ result: { status: 'blocked', message: 'Needs “Post”.' } })).toEqual({
      kind: 'failed',
      error: 'Needs “Post”.',
    });
    for (const name of ['NetworkError', 'NotDeliveredError', 'SessionClosedError', 'OutcomeUnknownError'])
      expect(sendOutcome({ error: Object.assign(new Error('x'), { name }) })).toEqual({ kind: 'later' });
    expect(sendOutcome({ error: { name: 'OutcomeRedactedError', state: 'completed' } })).toEqual({
      kind: 'sent',
    });
    expect(sendOutcome({ error: { name: 'ApiError', status: 503, message: 'busy' } })).toEqual({
      kind: 'later',
    });
    expect(sendOutcome({ error: { name: 'ApiError', status: 403, message: 'Not a member.' } })).toEqual({
      kind: 'failed',
      error: 'Not a member.',
    });
  });

  it('sends the oldest first, and nothing in a conversation behind one that wasn’t sent', () => {
    expect(nextToSend([msg('a', 'cv_1', 'failed'), msg('b', 'cv_1'), msg('c', 'cv_2')])?.id).toBe('c');
    expect(nextToSend([msg('a', 'cv_1', 'sending'), msg('b', 'cv_1')])).toBeNull();
    expect(nextToSend([msg('a', 'cv_1'), msg('b', 'cv_2')])?.id).toBe('a');
    // A thread is its own line.
    expect(nextToSend([msg('a', 'cv_1', 'failed'), { ...msg('b', 'cv_1'), threadRootId: 'msg_9' }])?.id).toBe(
      'b',
    );
  });

  it('labels each message and lists one conversation’s', () => {
    expect(outboxLabel({ state: 'waiting' })).toBe('Waiting to send');
    expect(outboxLabel({ state: 'failed', error: 'Not a member.' })).toBe('Not sent · Not a member.');
    expect(outboxFor([msg('a', 'cv_1'), msg('b', 'cv_2')], 'cv_2', null).map((m) => m.id)).toEqual(['b']);
  });

  it('keeps messages while offline, across a restart, and sends them in order on reconnect', async () => {
    const b = box();
    let online = false;
    const sent: string[] = [];
    const make = () =>
      createOutbox({
        box: b,
        scope: 'managed:org/dev',
        canSend: () => online,
        send: async (item) => {
          sent.push(item.text);
          return { kind: 'sent' };
        },
      });
    const first = make();
    first.add({ burrow: 'burrow-hq', conversationId: 'cv_1', threadRootId: null, text: 'one' });
    first.add({ burrow: 'burrow-hq', conversationId: 'cv_1', threadRootId: null, text: 'two' });
    await first.flush();
    expect(sent).toEqual([]);
    await new Promise((ok) => setTimeout(ok, 0));

    const second = make();
    await second.load();
    expect(second.items().map((i) => [i.text, i.state])).toEqual([
      ['one', 'waiting'],
      ['two', 'waiting'],
    ]);
    online = true;
    await second.flush();
    expect(sent).toEqual(['one', 'two']);
    expect(second.items()).toEqual([]);
    await new Promise((ok) => setTimeout(ok, 0));
    expect(await b.load('managed:org/dev', 'outbox')).toBeNull();
  });

  it('keeps a refused message with its reason; Retry sends it again, Delete drops it', async () => {
    let answer: SendOutcome = { kind: 'failed', error: 'Not a member.' };
    const ids: string[] = [];
    const outbox = createOutbox({
      box: box(),
      scope: 's',
      canSend: () => true,
      send: async (item) => {
        ids.push(item.id);
        return answer;
      },
    });
    const a = outbox.add({ burrow: 'b', conversationId: 'cv_1', threadRootId: null, text: 'a' });
    outbox.add({ burrow: 'b', conversationId: 'cv_1', threadRootId: null, text: 'b' });
    await outbox.flush();
    expect(outbox.items().map((i) => outboxLabel(i))).toEqual([
      'Not sent · Not a member.',
      'Waiting to send',
    ]);
    answer = { kind: 'sent' };
    outbox.retry(a.id);
    await outbox.flush();
    expect(outbox.items()).toEqual([]);
    // The same client id every time: the server's idempotency key.
    expect(ids[0]).toBe(a.id);
    expect(ids[1]).toBe(a.id);

    answer = { kind: 'failed', error: 'No.' };
    const c = outbox.add({ burrow: 'b', conversationId: 'cv_1', threadRootId: null, text: 'c' });
    await outbox.flush();
    outbox.remove(c.id);
    expect(outbox.items()).toEqual([]);
  });

  it('stops at a send without an answer, and says so after several while online', async () => {
    const outbox = createOutbox({
      box: box(),
      scope: 's',
      canSend: () => true,
      send: async () => {
        throw Object.assign(new Error('gone'), { name: 'NotDeliveredError' });
      },
    });
    outbox.add({ burrow: 'b', conversationId: 'cv_1', threadRootId: null, text: 'a' });
    outbox.add({ burrow: 'b', conversationId: 'cv_2', threadRootId: null, text: 'b' });
    await outbox.flush();
    expect(outbox.items().map((i) => [i.state, i.attempts])).toEqual([
      ['waiting', 1],
      ['waiting', 0],
    ]);
    for (let i = 1; i < MAX_ATTEMPTS; i++) await outbox.flush();
    expect(outbox.items()[0]).toMatchObject({ state: 'failed', error: 'Couldn’t reach your Whombat.' });
  });
});
