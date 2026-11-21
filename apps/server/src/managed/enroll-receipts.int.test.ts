/**
 * Enrollment requests keep their receipt (docs/decisions/command-safety.md CS-04): a device's request made before its
 * enrollment is receipted as `peer:<peerId>`; once enrolled, the same Noise peer still finds it by `status` and a
 * same-id retry replays it, and no other peer does.
 */
import type { ClientMessage } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { useManagedRuntime } from '../test/managed';
import { TEST_WAYS, type TestSessionClient, testIdentity } from './testing';

const m = useManagedRuntime();

/** Records what a client sends. */
function recorded(c: TestSessionClient): ClientMessage[] {
  const sent: ClientMessage[] = [];
  const send = c.send.bind(c);
  c.send = (msg) => {
    sent.push(msg);
    send(msg);
  };
  return sent;
}

async function statusOf(c: TestSessionClient, id: string) {
  c.send({ t: 'status', id });
  return c.waitFor((x) => x.t === 'outcome' && x.id === id);
}

describe('receipts across enrollment (CS-04)', () => {
  const olive = testIdentity();
  let claimRequest: Extract<ClientMessage, { t: 'request' }>;
  let claimAnswer: unknown;

  it('the device that claimed finds its claim after the answer was lost, and a retry replays it', async () => {
    const first = await m.client(olive);
    const sent = recorded(first);
    const { claim } = await m.claim(first, { deviceId: 'dev-receipts', name: 'Olive' });
    expect(claim).toMatchObject({ t: 'result' });
    claimAnswer = claim;
    const request = sent.find((x) => x.t === 'request' && x.op === 'enroll.claim');
    if (request?.t !== 'request') throw new Error('no claim request');
    claimRequest = request;
    first.close();
    await first.closed;

    // The answer was lost: the device comes back, enrolled now, and asks what happened.
    const again = await m.client(olive);
    expect(again.received.find((x) => x.t === 'welcome')).toMatchObject({ channel: 'app' });
    expect(await statusOf(again, request.id)).toMatchObject({
      t: 'outcome',
      state: 'completed',
      result: { kind: 'ok', output: (claim as { output: unknown }).output },
    });
    const retry = await again.request(request.op, request.input, { id: request.id });
    expect(retry).toEqual(claim);
  });

  it('another device never sees it', async () => {
    const stranger = await m.client();
    expect(await statusOf(stranger, claimRequest.id)).toMatchObject({ state: 'not_found' });
    expect(claimAnswer).toBeDefined();
  });

  it('a device link accepted before the answer was lost: the device learns it went through (its result isn’t kept)', async () => {
    // The box's way in for the link (one-person.md OP-S04: Olive's second device joins her account).
    m.runtime.trust.ways = () => TEST_WAYS;
    const owner = await m.client(olive);
    const link = await owner.request('enroll.link.create', {});
    const secret = (link as unknown as { output: { secret: string } }).output.secret;
    const laptop = testIdentity();
    const device = await m.client(laptop);
    const id = device.newId();
    const endpoint = { label: 'Olive’s laptop', platform: 'web' as const };
    const accepted = await device.request('enroll.link.accept', { secret, endpoint }, { id });
    expect(accepted).toMatchObject({ t: 'result' });
    device.close();
    await device.closed;
    const back = await m.client(laptop);
    // Secret op: known to be done, its result not kept (CT-44) — but never `not_found`.
    expect(await statusOf(back, id)).toMatchObject({ state: 'completed', redacted: true });
    const retry = await back.request('enroll.link.accept', { secret, endpoint }, { id });
    expect(retry).toMatchObject({ t: 'error', code: 'unknown_outcome' });
  });
});
