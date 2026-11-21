/**
 * Durable commands over a session (MA-09, MR-06): commit followed by a lost acknowledgement, duplicate requests,
 * the same id with a changed payload, cancellation and deadline races, `status`, and the allowlist.
 */

import { type ClientMessage, SESSION_PROTOCOL } from '@whombat/protocol/session';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { commandReceipts, messages } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { type RequestAnswer, RequestControl } from './dispatcher';
import { TestSessionClient } from './testing';
import type { SessionPrincipal } from './trust';

const m = useManagedRuntime({ seed: true });
let mara: Awaited<ReturnType<typeof m.enroll>>;

beforeAll(async () => {
  mara = await m.enroll(IDS.mara);
});

const send = (text: string) => ({
  params: { burrow: 'burrow-hq', conversationId: IDS.general },
  body: { text },
});

async function countMessages(text: string): Promise<number> {
  const rows = await m.t.services.db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, IDS.general), eq(messages.text, text)));
  return rows.length;
}

async function principalOf(identity: { peerId: string; publicKey: string }): Promise<SessionPrincipal> {
  return m.runtime.trust.identify(identity.peerId, identity.publicKey);
}

/** Runs one request through the dispatcher directly, with a control the test can flip. */
async function dispatch(
  principal: SessionPrincipal,
  request: { id: string; op: string; input: unknown },
  control = new RequestControl(null),
  onAccepted: () => void = () => {},
): Promise<{ answer: RequestAnswer; accepted: boolean }> {
  let answer: RequestAnswer | null = null;
  let accepted = false;
  await m.runtime.dispatcher.handle(
    principal,
    request,
    {
      accepted: () => {
        accepted = true;
        onAccepted();
      },
      result: (a) => {
        answer = a;
      },
    },
    control,
  );
  return { answer: answer as unknown as RequestAnswer, accepted };
}

async function closedWithin(c: TestSessionClient): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      c.closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('failed session stayed open')), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('session failure isolation', () => {
  it.each(['request', 'status', 'subscribe'] as const)(
    'closes only the affected session when checking permissions for a %s fails',
    async (kind) => {
      const c = await m.client(mara);
      const neighbor = await m.client(mara);
      const fault = vi
        .spyOn(m.runtime.trust, 'recheck')
        .mockRejectedValueOnce(new Error('database unavailable'));
      const msg: ClientMessage =
        kind === 'request'
          ? { t: 'request', id: c.newId(), op: 'endpoints.list', input: {}, deadlineMs: 30_000 }
          : kind === 'status'
            ? { t: 'status', id: c.newId() }
            : { t: 'subscribe', sub: 'permission-failure', topics: [`conv:${IDS.general}`] };
      try {
        c.send(msg);
        expect(await closedWithin(c)).toBe('closed');
        expect(await neighbor.request('endpoints.list', {})).toMatchObject({ t: 'result' });
      } finally {
        fault.mockRestore();
        c.close();
        neighbor.close();
        await Promise.allSettled([c.closed, neighbor.closed]);
      }
    },
  );

  it('preserves a committed command for recovery when its status lookup fails', async () => {
    const c = await m.client(mara);
    const id = c.newId();
    const input = send('committed before status failure');
    const result = await c.request('messages.send', input, { id });
    expect(result).toMatchObject({ t: 'result' });
    const fault = vi
      .spyOn(m.runtime.dispatcher, 'status')
      .mockRejectedValueOnce(new Error('database unavailable'));
    try {
      c.send({ t: 'status', id });
      expect(await closedWithin(c)).toBe('closed');
      const again = await m.client(mara);
      expect(await again.request('messages.send', input, { id })).toEqual(result);
      expect(await countMessages(input.body.text)).toBe(1);
    } finally {
      fault.mockRestore();
      c.close();
      await c.closed;
    }
  });

  it('settles the session lifecycle when admission cannot read the device identity', async () => {
    const fault = vi
      .spyOn(m.runtime.trust, 'identify')
      .mockRejectedValueOnce(new Error('database unavailable'));
    const c = new TestSessionClient(m.runtime, mara);
    try {
      const closed = expect(c.closed).resolves.toBe('closed');
      c.send({
        t: 'hello',
        versions: [SESSION_PROTOCOL],
        capabilities: [],
        client: { platform: 'web', build: 'test' },
      });
      await closed;
    } finally {
      fault.mockRestore();
      c.close();
      await Promise.allSettled([c.closed]);
    }
  });
});

describe('durable commands', () => {
  it('sends accepted after commit, then the result', async () => {
    const c = await m.client(mara);
    const res = await c.request('messages.send', send('durable one'));
    expect(res.t).toBe('result');
    const acceptedAt = c.received.findIndex((x) => x.t === 'accepted');
    const resultAt = c.received.indexOf(res);
    expect(acceptedAt).toBeGreaterThanOrEqual(0);
    expect(acceptedAt).toBeLessThan(resultAt);
    expect(await countMessages('durable one')).toBe(1);
  });

  it('commit followed by a lost acknowledgement: the retry with the same id replays, no duplicate', async () => {
    const first = await m.client(mara);
    first.dropAccepted = true;
    const id = first.newId();
    const r1 = await first.request('messages.send', send('lost ack'), { id });
    // The client never saw `accepted` and loses the connection before trusting the result.
    first.close();
    await first.closed;
    const second = await m.client(mara);
    const r2 = await second.request('messages.send', send('lost ack'), { id });
    expect(r2.t).toBe('result');
    expect(r2).toEqual({ ...r1 });
    expect(await countMessages('lost ack')).toBe(1);
  });

  it('a process that died after commit, before storing the result: completed, its result not kept, never re-executed', async () => {
    const c = await m.client(mara);
    const id = c.newId();
    await c.request('messages.send', send('died after commit'), { id });
    // Simulate the crash window: the receipt committed as `accepted`, the outcome never written.
    await m.t.services.db
      .update(commandReceipts)
      .set({ state: 'accepted', outcome: null })
      .where(eq(commandReceipts.requestId, id));
    // Committed, the result gone with the process: done, not “accepted” for ever (CS-06, CT-195).
    c.send({ t: 'status', id });
    expect(await c.waitFor((x) => x.t === 'outcome' && x.id === id)).toEqual({
      t: 'outcome',
      id,
      state: 'completed',
      digest: expect.any(String),
      redacted: true,
    });
    const retry = await c.request('messages.send', send('died after commit'), { id });
    expect(retry).toEqual({ t: 'outcome', id, state: 'completed', redacted: true });
    expect(await countMessages('died after commit')).toBe(1);
    // It stays finished: the receipt is now `completed`, with nothing of the result.
    const [row] = await m.t.services.db
      .select()
      .from(commandReceipts)
      .where(eq(commandReceipts.requestId, id));
    expect(row).toMatchObject({ state: 'completed', outcome: { kind: 'result', redacted: true } });
  });

  it('a duplicate request while the first still runs joins it', async () => {
    const principal = await principalOf(mara);
    const request = { id: 'dup_request_000000001', op: 'messages.send', input: send('duplicate') };
    const [a, b] = await Promise.all([dispatch(principal, request), dispatch(principal, request)]);
    expect(a.answer.type).toBe('result');
    expect(b.answer.type).toBe('result');
    expect([a.answer, b.answer].filter((x) => (x as { replayed?: boolean }).replayed).length).toBe(1);
    expect(await countMessages('duplicate')).toBe(1);
  });

  it('the same id with a changed payload is refused (idempotency_mismatch)', async () => {
    const c = await m.client(mara);
    const id = c.newId();
    await c.request('messages.send', send('payload A'), { id });
    const changed = await c.request('messages.send', send('payload B'), { id });
    expect(changed).toMatchObject({ t: 'error', code: 'idempotency_mismatch' });
    expect(await countMessages('payload B')).toBe(0);
  });

  it('cancel before accept: nothing executed, and the same id may run later', async () => {
    const principal = await principalOf(mara);
    const control = new RequestControl(null);
    control.cancelled = true;
    const request = { id: 'cancel_before_000000001', op: 'messages.send', input: send('cancelled early') };
    const first = await dispatch(principal, request, control);
    expect(first.answer).toMatchObject({ type: 'error', code: 'cancelled' });
    expect(first.accepted).toBe(false);
    expect(await countMessages('cancelled early')).toBe(0);
    const [receipt] = await m.t.services.db
      .select()
      .from(commandReceipts)
      .where(eq(commandReceipts.requestId, request.id));
    expect(receipt?.state).toBe('not_executed');
    const again = await dispatch(principal, request);
    expect(again.answer.type).toBe('result');
    expect(await countMessages('cancelled early')).toBe(1);
  });

  it('cancel after accept: the result stands (best effort only)', async () => {
    const principal = await principalOf(mara);
    const control = new RequestControl(null);
    const request = { id: 'cancel_after_0000000001', op: 'messages.send', input: send('cancelled late') };
    const out = await dispatch(principal, request, control, () => {
      control.cancelled = true;
    });
    expect(out.accepted).toBe(true);
    expect(out.answer.type).toBe('result');
    expect(await countMessages('cancelled late')).toBe(1);
  });

  it('a deadline that passes before commit rolls the command back', async () => {
    const principal = await principalOf(mara);
    const services = m.t.services;
    const realClock = services.clock;
    const start = realClock();
    const control = new RequestControl(new Date(start.getTime() + 60_000));
    let calls = 0;
    // The first reads (the dispatcher's own check) see the present; commit time is past the deadline.
    services.clock = () => (++calls > 1 ? new Date(start.getTime() + 120_000) : start);
    try {
      const out = await dispatch(
        principal,
        { id: 'deadline_race_00000001', op: 'messages.send', input: send('too late') },
        control,
      );
      expect(out.answer).toMatchObject({ type: 'error', code: 'deadline_exceeded' });
      expect(out.accepted).toBe(false);
    } finally {
      services.clock = realClock;
    }
    expect(await countMessages('too late')).toBe(0);
  });

  it('a request whose deadline already passed is not executed', async () => {
    const c = await m.client(mara);
    const principal = await principalOf(mara);
    const out = await dispatch(
      principal,
      { id: c.newId(), op: 'messages.send', input: send('past deadline') },
      new RequestControl(new Date(Date.now() - 1000)),
    );
    expect(out.answer).toMatchObject({ type: 'error', code: 'deadline_exceeded' });
    expect(await countMessages('past deadline')).toBe(0);
  });

  it('status answers an ambiguous outcome', async () => {
    const c = await m.client(mara);
    const id = c.newId();
    await c.request('messages.send', send('status check'), { id });
    c.send({ t: 'status', id });
    const outcome = await c.waitFor((x) => x.t === 'outcome' && x.id === id);
    expect(outcome).toMatchObject({ t: 'outcome', state: 'completed', result: { kind: 'ok' } });
    const unknownId = c.newId();
    c.send({ t: 'status', id: unknownId });
    expect(await c.waitFor((x) => x.t === 'outcome' && x.id === unknownId)).toMatchObject({
      state: 'not_found',
    });
  });

  it('validation errors are final for the id; queries are not receipted', async () => {
    const c = await m.client(mara);
    const id = c.newId();
    const bad = await c.request(
      'messages.send',
      { params: { burrow: 'burrow-hq', conversationId: IDS.general }, body: { text: '' } },
      { id },
    );
    expect(bad).toMatchObject({ t: 'error', code: 'validation_failed' });
    const again = await c.request(
      'messages.send',
      { params: { burrow: 'burrow-hq', conversationId: IDS.general }, body: { text: '' } },
      { id },
    );
    expect(again).toEqual(bad);
    const q = await c.request('burrows.get', { params: { burrow: 'burrow-hq' } });
    expect(q).toMatchObject({ t: 'result', kind: 'ok' });
    const rows = await m.t.services.db
      .select()
      .from(commandReceipts)
      .where(eq(commandReceipts.op, 'burrows.get'));
    expect(rows).toHaveLength(0);
  });
});

describe('the allowlist', () => {
  it('runs REST handlers as the session account, with burrow membership checked', async () => {
    const c = await m.client(mara);
    const welcome = c.received.find((x) => x.t === 'welcome');
    expect(welcome).toMatchObject({
      channel: 'app',
      principal: { accountId: mara.accountId, principals: [{ principalId: IDS.mara }] },
      appliance: m.appliance.peerId,
    });
    const res = await c.request('conversations.list', { params: { burrow: 'burrow-hq' } });
    expect(res.t).toBe('result');
    // Op names are `api.<area>.<action>` key paths.
    expect(m.runtime.dispatcher.allowlist.has('skills.library')).toBe(true);
    const other = await c.request('burrows.get', { params: { burrow: 'no-such-burrow' } });
    expect(other).toMatchObject({ t: 'error', code: 'not_found' });
  });

  it('never exposes the runner protocol, and explains what the appliance disables', async () => {
    const c = await m.client(mara);
    expect(await c.request('runner.claim', {})).toMatchObject({ t: 'error', code: 'unknown_op' });
    expect(await c.request('internal.runner', {})).toMatchObject({ t: 'error', code: 'unknown_op' });
    const webhook = await c.request('automations.webhook', {
      params: { burrow: 'burrow-hq', id: 'aut_x' },
      body: { enabled: true },
    });
    expect(webhook).toMatchObject({
      t: 'error',
      code: 'not_allowed',
      details: { reason: 'automationWebhooks' },
    });
  });

  // Automations' Delete and samples run over a session like over REST (automation-recipes.md, CT-322).
  it('deletes an automation and asks for samples over a session', async () => {
    const c = await m.client(mara);
    const b = { burrow: 'burrow-hq' };
    const created = await c.request('automations.create', {
      params: b,
      body: { name: 'By session', source: { kind: 'blank', conversationId: IDS.billing } },
    });
    expect(created).toMatchObject({ t: 'result', kind: 'ok' });
    const id = (created as unknown as { output: { automation: { id: string } } }).output.automation.id;
    expect(await c.request('automations.samples', { params: { ...b, id } })).toMatchObject({
      t: 'error',
      code: 'bad_request',
      message: 'This automation doesn’t start from GitHub.',
    });
    expect(await c.request('automations.delete', { params: { ...b, id } })).toMatchObject({
      t: 'result',
      kind: 'ok',
      output: { id, cancelledRuns: 0 },
    });
    expect(await c.request('automations.get', { params: { ...b, id } })).toMatchObject({
      t: 'error',
      code: 'not_found',
    });
  });

  it('refuses unenrolled endpoints everything but enrollment', async () => {
    const stranger = await m.client();
    const welcome = stranger.received.find((x) => x.t === 'welcome');
    expect(welcome).toMatchObject({ channel: 'enroll', principal: null, endpointId: null });
    const res = await stranger.request('burrows.get', { params: { burrow: 'burrow-hq' } });
    expect(res).toMatchObject({ t: 'error', code: 'enrollment_required' });
    const status = await stranger.request('enroll.pair.status', { pairingId: 'pair_unknown123' });
    expect(status).toMatchObject({ t: 'error', code: 'not_found' });
  });

  it('answers unavailable to commands while draining; reads still work', async () => {
    const c = await m.client(mara);
    const settle = m.t.services.maintenance.settleMs;
    m.t.services.maintenance.settleMs = 50;
    m.t.services.maintenance.drain('test', new Date());
    try {
      expect(await c.request('messages.send', send('while draining'))).toMatchObject({
        t: 'error',
        code: 'unavailable',
      });
      expect(await c.request('burrows.get', { params: { burrow: 'burrow-hq' } })).toMatchObject({
        t: 'result',
      });
    } finally {
      m.t.services.maintenance.resume();
      m.t.services.maintenance.settleMs = settle;
    }
    expect(await countMessages('while draining')).toBe(0);
  });
});
