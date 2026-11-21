import { QueryClient } from '@tanstack/query-core';
import { api } from '@whombat/core/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { NetworkError } from '../http/errors';
import { connectRealtimeToQueryClient } from '../query/connect';
import { queryKeys } from '../query/keys';
import type { ResyncSignal } from '../realtime/realtime';
import { canCheck, commandStatusText, createCommandTracker, phaseForError } from './commands';
import { createFakeAppliance, FAKE_PEER_ID } from './fake';
import { createSessionRealtime } from './realtime';
import { previewKind, readResource, resourceFromUrl } from './resources';
import { clearable, createScopeGuard, scopedStorage, scopeKey } from './scope';
import { createSecureSession } from './secure';
import {
  type ApplianceSession,
  NotDeliveredError,
  OutcomeRedactedError,
  OutcomeUnknownError,
  SessionClosedError,
} from './types';
import { FrameError, frameReader } from './wire';

const live: ApplianceSession[] = [];
afterEach(() => {
  for (const s of live.splice(0)) s.close();
});

function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() > end) return reject(new Error('timed out waiting'));
      setTimeout(tick, 2);
    };
    tick();
  });
}

function world(account = { id: 'acc_mara', name: 'Mara' }) {
  const appliance = createFakeAppliance({
    account,
    handle: async (op) =>
      op === 'health.get' ? { status: 200, body: { ok: true } } : { status: 200, body: {} },
  });
  const session = createSecureSession({
    connector: appliance.connector,
    backoff: { initialMs: 2, maxMs: 5 },
  });
  live.push(session);
  return { appliance, session };
}

const typing = (conversationId: string) => ({
  type: 'typing',
  conversationId,
  threadRootId: null,
  principalId: 'prn_dusty000000',
  active: true,
  expiresAt: '2026-09-23T09:22:30.000Z',
});

describe('realtime over session subscriptions', () => {
  it('delivers typed events for held topics and derives burrow and principal from them', async () => {
    const { appliance, session } = world();
    const realtime = createSessionRealtime(session);
    const release = realtime.subscribe(['burrow:bur_hq', 'me:prn_mara', 'conv:cnv_billing']);
    realtime.connect();
    const got: string[] = [];
    realtime.on('typing', (e) => got.push(e.conversationId));
    await until(() => realtime.status() === 'open');
    await new Promise((r) => setTimeout(r, 5));
    appliance.publish('conv:cnv_billing', typing('cnv_billing'));
    await until(() => got.length === 1);
    expect(realtime.session()).toEqual({ burrowId: 'bur_hq', principalId: 'prn_mara' });
    release();
    expect(realtime.topics()).toEqual([]);
  });

  it('a resumed reconnect is not a resync; snapshot_required is, for its topics only', async () => {
    const { appliance, session } = world();
    const realtime = createSessionRealtime(session, { validate: false });
    const resyncs: ResyncSignal[] = [];
    realtime.onResync((s) => resyncs.push(s));
    const statuses: string[] = [];
    realtime.onStatus((s) => statuses.push(s));
    realtime.subscribe(['conv:a', 'conv:b']);
    realtime.connect();
    await until(() => realtime.status() === 'open');
    await new Promise((r) => setTimeout(r, 5));
    appliance.faults.dropAll();
    await until(() => statuses.filter((s) => s === 'open').length === 2);
    expect(statuses).toContain('reconnecting');
    await new Promise((r) => setTimeout(r, 10));
    expect(resyncs).toEqual([]);
    appliance.faults.bumpAuthz();
    await until(() => resyncs.length === 1);
    expect(resyncs[0]).toEqual({ reason: 'snapshot', topics: ['conv:a', 'conv:b'] });
  });

  it('after a runtime restart and after falling behind, events keep coming; each is one resync (AP-1097)', async () => {
    const { appliance, session } = world();
    const realtime = createSessionRealtime(session, { validate: false });
    const resyncs: ResyncSignal[] = [];
    realtime.onResync((s) => resyncs.push(s));
    const got: unknown[] = [];
    realtime.onEvent((e) => got.push((e as { n?: unknown }).n));
    realtime.subscribe(['conv:a']);
    realtime.connect();
    await until(() => realtime.status() === 'open');
    await new Promise((r) => setTimeout(r, 5));
    appliance.faults.restart();
    await until(() => resyncs.length === 1 && realtime.status() === 'open');
    await new Promise((r) => setTimeout(r, 10));
    appliance.publish('conv:a', { type: 'x', n: 1 });
    await until(() => got.length === 1);
    appliance.faults.overflow();
    await until(() => resyncs.length === 2);
    await new Promise((r) => setTimeout(r, 10));
    appliance.publish('conv:a', { type: 'x', n: 2 });
    await until(() => got.length === 2);
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual([1, 2]);
    expect(resyncs).toEqual([
      { reason: 'snapshot', topics: ['conv:a'] },
      { reason: 'snapshot', topics: ['conv:a'] },
    ]);
  });

  it('an event it can’t read is a resync of its topic: its change would be lost otherwise', async () => {
    const { appliance, session } = world();
    const realtime = createSessionRealtime(session);
    const resyncs: ResyncSignal[] = [];
    realtime.onResync((s) => resyncs.push(s));
    const errors: string[] = [];
    realtime.onError((e) => errors.push(e.kind));
    realtime.subscribe(['conv:a', 'conv:b']);
    realtime.connect();
    await until(() => realtime.status() === 'open');
    await new Promise((r) => setTimeout(r, 5));
    appliance.publish('conv:b', { type: 'message.created', message: { id: 42 } });
    await until(() => resyncs.length === 1);
    expect(resyncs[0]).toEqual({ reason: 'gap', topics: ['conv:b'] });
    expect(errors).toEqual(['bad_frame']);
  });

  it('feeds the query cache: a snapshot request invalidates what those topics show', async () => {
    const { appliance, session } = world();
    const realtime = createSessionRealtime(session, { validate: false });
    const qc = new QueryClient();
    connectRealtimeToQueryClient(realtime, qc);
    const key = queryKeys.messages.list({ params: { burrow: 'hq', conversationId: 'cnv_a' } });
    qc.setQueryData(key, { messages: [], before: null, hasMore: false } as never);
    realtime.subscribe('conv:cnv_a');
    realtime.connect();
    await until(() => realtime.status() === 'open');
    await new Promise((r) => setTimeout(r, 5));
    appliance.faults.bumpAuthz();
    await until(() => qc.getQueryState(key)?.isInvalidated === true);
  });
});

describe('durable command tracking', () => {
  it('maps failures: unknown outcome, not delivered, rejected', () => {
    expect(phaseForError(new OutcomeUnknownError('prs.merge', 'r'))).toBe('unknown');
    expect(
      phaseForError(new OutcomeUnknownError('prs.merge', 'r', { cause: new SessionClosedError('closed') })),
    ).toBe('unknown');
    expect(phaseForError(new NetworkError('prs.merge', null))).toBe('not_delivered');
    expect(phaseForError(new NotDeliveredError('prs.merge', 'r'))).toBe('not_delivered');
    expect(phaseForError(new SessionClosedError('closed'))).toBe('not_delivered');
    expect(phaseForError(new Error('nope'))).toBe('rejected');
  });

  it('a secret op whose answer is not kept is never offered to send again (CT-44)', async () => {
    const { isSecretOp } = await import('./secure');
    expect(isSecretOp('enroll.pair.request')).toBe(true);
    expect(isSecretOp('signins.loginSubmit')).toBe(true);
    expect(isSecretOp('recovery.kit.rotate')).toBe(true);
    expect(isSecretOp('messages.send')).toBe(false);
    expect(phaseForError(new OutcomeRedactedError('enroll.pair.request', 'r', 'completed'))).toBe(
      'completed',
    );
    expect(phaseForError(new OutcomeRedactedError('enroll.pair.request', 'r', null))).toBe('unknown');
  });

  it('checking an unknown command asks the appliance: never committed → not delivered', async () => {
    const { session, appliance } = world();
    const tracker = createCommandTracker(() => session);
    session.connect();
    await until(() => session.state().status === 'open');
    // Lost on the way in, and the appliance stays out of reach until the deadline: outcome unknown.
    appliance.faults.failConnects('appliance_offline', 10_000);
    appliance.faults.swallowRequests(1);
    const input = { params: { burrow: 'b', conversationId: 'c' }, query: {}, body: { text: 'hi' } };
    tracker.begin({ requestId: 'req_s_0123456789ab', endpoint: api.messages.send, input, label: 'Message' });
    const err = await session
      .call(api.messages.send, input, { requestId: 'req_s_0123456789ab', deadlineMs: 60 })
      .catch((e: unknown) => e);
    tracker.settle('req_s_0123456789ab', { ok: false, error: err });
    expect(err).toBeInstanceOf(OutcomeUnknownError);
    expect(tracker.get('req_s_0123456789ab')?.phase).toBe('unknown');
    appliance.faults.failConnects('appliance_offline', 0);
    session.reconnectNow();
    await until(() => session.state().status === 'open');
    // What the session itself would resend (a non-destructive `receipt` op), never acknowledged: “Not sent”.
    expect(await tracker.check('req_s_0123456789ab')).toBe('not_delivered');
    expect(appliance.stats().executed.get('messages.send')).toBeUndefined();
  });

  it('a destructive op stays unknown without a receipt: some act before their commit (AP-577)', async () => {
    const { session, appliance } = world();
    const tracker = createCommandTracker(() => session);
    session.connect();
    await until(() => session.state().status === 'open');
    const removals = [
      {
        id: 'req_d_0123456789ab',
        endpoint: api.messages.delete,
        input: { params: { burrow: 'b', messageId: 'msg_1' }, query: {}, body: undefined },
      },
      {
        // Revokes the Google grant before its commit.
        id: 'req_c_0123456789ab',
        endpoint: api.connections.remove,
        input: { params: { connectionId: 'con_01234567' }, query: {}, body: undefined },
      },
    ];
    for (const r of removals) {
      appliance.faults.swallowRequests(1);
      tracker.begin({ requestId: r.id, endpoint: r.endpoint, input: r.input, label: 'Remove' });
      const err = await session.call(r.endpoint, r.input, { requestId: r.id }).catch((e: unknown) => e);
      tracker.settle(r.id, { ok: false, error: err });
      expect(tracker.get(r.id)?.phase, r.endpoint.id).toBe('unknown');
      expect(await tracker.check(r.id), r.endpoint.id).toBe('unknown');
    }
    expect(appliance.stats().executed.size).toBe(0);
  });

  it('a command the appliance acknowledged stays unknown once its receipt expired (AP-574)', async () => {
    const { session, appliance } = world();
    const tracker = createCommandTracker(() => session);
    session.connect();
    await until(() => session.state().status === 'open');
    appliance.faults.failConnects('appliance_offline', 10_000);
    appliance.faults.loseResults(1);
    const input = { params: { burrow: 'b', conversationId: 'c' }, query: {}, body: { text: 'hi' } };
    tracker.begin({ requestId: 'req_a_0123456789ab', endpoint: api.messages.send, input, label: 'Message' });
    const call = session.call(api.messages.send, input, {
      requestId: 'req_a_0123456789ab',
      onProgress: (phase) => tracker.progress('req_a_0123456789ab', phase),
    });
    await until(() => tracker.get('req_a_0123456789ab')?.phase === 'accepted');
    expect(tracker.get('req_a_0123456789ab')).toMatchObject({ acknowledged: true });
    appliance.faults.expireReceipts();
    appliance.faults.failConnects('appliance_offline', 0);
    session.reconnectNow();
    const err = await call.catch((e: unknown) => e);
    tracker.settle('req_a_0123456789ab', { ok: false, error: err });
    expect(tracker.get('req_a_0123456789ab')?.phase).toBe('unknown');
    // It ran: “Send again” would post it twice.
    expect(await tracker.check('req_a_0123456789ab')).toBe('unknown');
    expect(appliance.stats().executed.get('messages.send')).toBe(1);
  });

  it('an op that acts outside its receipt stays unknown when the appliance has no receipt (CT-194)', async () => {
    const { session, appliance } = world();
    const tracker = createCommandTracker(() => session);
    session.connect();
    await until(() => session.state().status === 'open');
    // The merge happened on GitHub, but the commit that would have recorded it was cancelled with the session.
    appliance.faults.loseBeforeCommit(1);
    const input = { params: { burrow: 'b', number: 1 }, query: {}, body: {} };
    tracker.begin({ requestId: 'req_m_0123456789ab', endpoint: api.prs.merge, input, label: 'Merge' });
    const err = await session
      .call(api.prs.merge, input, { requestId: 'req_m_0123456789ab' })
      .catch((e: unknown) => e);
    tracker.settle('req_m_0123456789ab', { ok: false, error: err });
    expect(err).toBeInstanceOf(OutcomeUnknownError);
    // “Not sent” would be wrong: a person looks at the pull request instead.
    expect(await tracker.check('req_m_0123456789ab')).toBe('unknown');
    expect(tracker.get('req_m_0123456789ab')?.checking).toBe(false);
    expect(appliance.stats().executed.get('prs.merge')).toBe(1);
  });

  it('a command whose call is over is never stuck: accepted or running when checked, it can be checked again (AP-579)', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const appliance = createFakeAppliance({
      handle: async (op) => {
        if (op === 'messages.edit') await gate;
        return { status: 200, body: {} };
      },
    });
    const session = createSecureSession({
      connector: appliance.connector,
      backoff: { initialMs: 2, maxMs: 5 },
      statusPollMs: 5,
      acceptedWaitMs: 100,
    });
    live.push(session);
    const tracker = createCommandTracker(() => session);
    session.connect();
    await until(() => session.state().status === 'open');

    // Accepted for ever (a runtime before 0.29.1): the session gives up; a check still finds it accepted.
    appliance.faults.loseAfterCommit(1, 'accepted');
    const input = { params: { burrow: 'b', conversationId: 'c' }, query: {}, body: { text: 'hi' } };
    tracker.begin({ requestId: 'req_o_0123456789ab', endpoint: api.messages.send, input, label: 'Message' });
    const err = await session
      .call(api.messages.send, input, {
        requestId: 'req_o_0123456789ab',
        onProgress: (phase) => tracker.progress('req_o_0123456789ab', phase),
      })
      .catch((e: unknown) => e);
    tracker.settle('req_o_0123456789ab', { ok: false, error: err });
    expect(tracker.get('req_o_0123456789ab')).toMatchObject({
      phase: 'unknown',
      acknowledged: true,
      settled: true,
    });
    expect(await tracker.check('req_o_0123456789ab')).toBe('accepted');
    expect(canCheck(tracker.get('req_o_0123456789ab') as never)).toBe(true);

    // Running when checked (`executing`): Check again stays, and a later check finds it done.
    const edit = { params: { burrow: 'b', messageId: 'msg_1' }, query: {}, body: { text: 'x' } };
    tracker.begin({
      requestId: 'req_e_0123456789ab',
      endpoint: api.messages.edit,
      input: edit,
      label: 'Edit',
    });
    const running = session.call(api.messages.edit, edit, {
      requestId: 'req_e_0123456789ab',
      deadlineMs: 50,
    });
    const lost = await running.catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(OutcomeUnknownError);
    tracker.settle('req_e_0123456789ab', { ok: false, error: lost });
    expect(await tracker.check('req_e_0123456789ab')).toBe('executing');
    expect(canCheck(tracker.get('req_e_0123456789ab') as never)).toBe(true);
    // While the call is still going, `accepted` is just progress: nothing to check yet.
    expect(canCheck({ phase: 'accepted', settled: false })).toBe(false);
    release();
    await until(() => appliance.stats().executed.get('messages.edit') === 1);
    expect(await tracker.check('req_e_0123456789ab')).toBe('completed');
    expect(canCheck(tracker.get('req_e_0123456789ab') as never)).toBe(false);
  });

  it('`rejected` + `unknown_outcome` is “Not confirmed yet”, not “Didn’t go through” (CT-196)', async () => {
    const { session, appliance } = world();
    const tracker = createCommandTracker(() => session);
    session.connect();
    await until(() => session.state().status === 'open');
    appliance.faults.loseBeforeCommit(1, 'unknown_outcome');
    const input = { params: { burrow: 'b', conversationId: 'c' }, query: {}, body: { text: 'hi' } };
    tracker.begin({ requestId: 'req_u_0123456789ab', endpoint: api.messages.send, input, label: 'Message' });
    const err = await session
      .call(api.messages.send, input, { requestId: 'req_u_0123456789ab' })
      .catch((e: unknown) => e);
    tracker.settle('req_u_0123456789ab', { ok: false, error: err });
    expect(tracker.get('req_u_0123456789ab')).toMatchObject({ phase: 'unknown', acknowledged: true });
    expect(await tracker.check('req_u_0123456789ab')).toBe('unknown');
    expect(canCheck(tracker.get('req_u_0123456789ab') as never)).toBe(true);
    expect(commandStatusText('unknown')).toBe('Not confirmed yet');
  });

  it('an answer that isn’t kept (CT-195) is done, to the tracker too', async () => {
    const { session, appliance } = world();
    const tracker = createCommandTracker(() => session);
    session.connect();
    await until(() => session.state().status === 'open');
    appliance.faults.loseAfterCommit(1, 'redacted');
    const input = { params: { burrow: 'b', conversationId: 'c' }, query: {}, body: { text: 'hi' } };
    tracker.begin({ requestId: 'req_r_0123456789ab', endpoint: api.messages.send, input, label: 'Message' });
    const err = await session
      .call(api.messages.send, input, { requestId: 'req_r_0123456789ab' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutcomeRedactedError);
    tracker.settle('req_r_0123456789ab', { ok: false, error: err });
    expect(tracker.get('req_r_0123456789ab')?.phase).toBe('completed');
    expect(await tracker.check('req_r_0123456789ab')).toBe('completed');
    expect(appliance.stats().executed.get('messages.send')).toBe(1);
  });
});

describe('cache scoping', () => {
  const store = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      keys: () => [...map.keys()],
      map,
    };
  };

  it('keys every scope by org, appliance, account and authorization generation', () => {
    expect(scopeKey({ orgId: 'org_1', applianceId: 'apl_1', accountId: 'acc_1', authzGeneration: 3 })).toBe(
      'org_1/apl_1/acc_1/3',
    );
  });

  it('switching account clears the query cache; the next account never sees the last one’s data', async () => {
    const qc = new QueryClient();
    const kv = store();
    const guard = createScopeGuard([clearable(qc)]);
    const persisted = scopedStorage(kv, () => guard.scope());
    guard.enter({ orgId: 'o', applianceId: 'a', accountId: 'acc_mara', authzGeneration: 1 });
    qc.setQueryData(['whombat', 'messages.list', { conversationId: 'c' }], { messages: ['secret'] });
    persisted.set('draft:c', 'mara’s draft');
    guard.enter({ orgId: 'o', applianceId: 'a', accountId: 'acc_hugo', authzGeneration: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(qc.getQueryData(['whombat', 'messages.list', { conversationId: 'c' }])).toBeUndefined();
    // Persistence only reads its own scope.
    expect(persisted.get('draft:c')).toBeNull();
  });

  it('a revocation notice, and a refusal at the next connection, clear everything', async () => {
    const { appliance, session } = world();
    const qc = new QueryClient();
    const kv = store();
    const cleared: string[] = [];
    const guard = createScopeGuard([clearable(qc)]);
    const persisted = scopedStorage(kv, () => guard.scope());
    const guardAll = createScopeGuard([clearable(qc), persisted.cache]);
    guardAll.onClear((reason) => cleared.push(reason));
    guardAll.watch(session, 'org_1');
    guard.watch(session, 'org_1');
    session.connect();
    await until(() => session.state().status === 'open');
    expect(guardAll.scope()).toMatchObject({ accountId: 'acc_mara', applianceId: FAKE_PEER_ID });
    qc.setQueryData(['whombat', 'x'], 1);
    persisted.set('draft', 'x');
    expect(kv.map.size).toBe(1);
    appliance.faults.revoke();
    await until(() => cleared.includes('revoked'));
    expect(qc.getQueryData(['whombat', 'x'])).toBeUndefined();
    expect(kv.map.size).toBe(0);
    expect(guardAll.scope()).toBeNull();

    // Offline while revoked: the refusal at the next connection clears too.
    const again = createSecureSession({ connector: appliance.connector });
    live.push(again);
    const cleared2: string[] = [];
    const g2 = createScopeGuard([clearable(qc)]);
    g2.onClear((r) => cleared2.push(r));
    g2.enter({ orgId: 'org_1', applianceId: FAKE_PEER_ID, accountId: 'acc_mara', authzGeneration: 1 });
    g2.watch(again, 'org_1');
    qc.setQueryData(['whombat', 'y'], 1);
    again.connect();
    await until(() => cleared2.includes('revoked'));
    expect(qc.getQueryData(['whombat', 'y'])).toBeUndefined();
  });

  it('a permission change (authzGeneration) clears but keeps the account', async () => {
    const { appliance, session } = world();
    const qc = new QueryClient();
    const reasons: string[] = [];
    const guard = createScopeGuard([clearable(qc)]);
    guard.onClear((r) => reasons.push(r));
    guard.watch(session, 'org_1');
    session.connect();
    await until(() => session.state().status === 'open');
    qc.setQueryData(['whombat', 'x'], 1);
    appliance.faults.bumpAuthz();
    await until(() => reasons.includes('authz_changed'));
    expect(guard.scope()).toMatchObject({ accountId: 'acc_mara', authzGeneration: 2 });
    expect(qc.getQueryData(['whombat', 'x'])).toBeUndefined();
  });
});

describe('resources', () => {
  it('an attachment path with a stray % names no resource, and never throws', () => {
    expect(resourceFromUrl('/api/v1/burrows/bur_hq/attachments/att_1?download=1')).toEqual({
      kind: 'attachment',
      burrow: 'bur_hq',
      attachmentId: 'att_1',
      download: true,
    });
    expect(resourceFromUrl('/api/v1/burrows/bur_hq/attachments/100%')).toBeNull();
    expect(resourceFromUrl('/api/v1/burrows/%E0%A4%A/attachments/att_1')).toBeNull();
  });

  it('previews only raster images and plain text; HTML and SVG are downloads', () => {
    expect(previewKind('image/png')).toBe('image');
    expect(previewKind('image/svg+xml')).toBe('download');
    expect(previewKind('text/html; charset=utf-8')).toBe('download');
    expect(previewKind('text/plain; charset=utf-8')).toBe('text');
    expect(previewKind('application/json')).toBe('text');
    expect(previewKind('application/pdf')).toBe('download');
  });

  it('reads a bounded prefix and refuses oversized whole reads', async () => {
    const data = new Uint8Array(50_000).fill(65);
    const appliance = createFakeAppliance({
      handle: async () => ({ status: 200, body: {} }),
      resources: async () => ({
        meta: { contentType: 'text/plain', size: data.byteLength, name: 'log.txt', sha256: null },
        bytes: data,
      }),
    });
    const session = createSecureSession({ connector: appliance.connector });
    live.push(session);
    const ref = { kind: 'attachment' as const, burrow: 'b', attachmentId: 'att_1' };
    const head = await readResource(session, ref, { maxBytes: 4096, range: { start: 0, end: 4096 } });
    expect(head.bytes.byteLength).toBe(4096);
    await expect(readResource(session, ref, { maxBytes: 1000 })).rejects.toMatchObject({ code: 'too_large' });
  });
});

describe('wire framing (@whombat/protocol, CT-05)', () => {
  it('refuses an announced length above the limit before buffering it', () => {
    const read = frameReader();
    const header = new Uint8Array([0x7f, 0xff, 0xff, 0xff, 2, 0, 0, 0, 1]);
    expect(() => read(header)).toThrow(FrameError);
  });
});
