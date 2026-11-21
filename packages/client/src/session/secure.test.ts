import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { type AnyEndpoint, api } from '@whombat/core/contracts';
import { decodeClientMessage, requestDigest, SESSION_PROTOCOL } from '@whombat/protocol/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../http/client';
import { phaseForError } from './commands';
import { createFakeAppliance, type FakeApplianceOptions } from './fake';
import { createSecureSession, defaultIsDestructive, retryPolicy, type SecureSessionOptions } from './secure';
import {
  type ApplianceSession,
  ConnectionLostError,
  type ConnectionState,
  type ConnectionTie,
  NotDeliveredError,
  OutcomeRedactedError,
  OutcomeUnknownError,
  SessionClosedError,
  type SessionNotice,
  wentThrough,
} from './types';
import { type Frame, type SessionConnector, STREAM_RESET, type WireConnection } from './wire';

const EMPTY = { params: {}, query: {}, body: undefined };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Observe cleanup without importing Node APIs into the browser package. */
function abortListeners(signal: AbortSignal): Set<EventListenerOrEventListenerObject | null> {
  const listeners = new Set<EventListenerOrEventListenerObject | null>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  vi.spyOn(signal, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'abort') listeners.add(listener);
    add(type, listener, options);
  });
  vi.spyOn(signal, 'removeEventListener').mockImplementation((type, listener, options) => {
    if (type === 'abort') listeners.delete(listener);
    remove(type, listener, options);
  });
  return listeners;
}

function setup(fake: Partial<FakeApplianceOptions> = {}, session: Partial<SecureSessionOptions> = {}) {
  const calls: { op: string; input: unknown }[] = [];
  const appliance = createFakeAppliance({
    handle: async (op, input) => {
      calls.push({ op, input });
      if (op === 'health.get') return { status: 200, body: { ok: true } };
      return { status: 200, body: { op, echo: (input as { body?: unknown }).body ?? null } };
    },
    ...fake,
  });
  const s = createSecureSession({
    connector: appliance.connector,
    backoff: { initialMs: 2, maxMs: 10 },
    statusPollMs: 5,
    ...session,
  });
  const states: ConnectionState[] = [];
  s.onState((st) => states.push(st));
  const notices: SessionNotice[] = [];
  s.onNotice((n) => notices.push(n));
  return { appliance, session: s, states, notices, calls };
}

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

const opened = (s: ApplianceSession) => until(() => s.state().status === 'open');

let live: ApplianceSession[] = [];
afterEach(() => {
  for (const s of live) s.close();
  live = [];
  vi.useRealTimers();
});
function track<T extends { session: ApplianceSession }>(t: T): T {
  live.push(t.session);
  return t;
}

describe('secure session: connection', () => {
  it('negotiates the protocol and reports the account and authorization generation', async () => {
    const { session, appliance } = track(setup());
    session.connect();
    await opened(session);
    const state = session.state();
    expect(state.status).toBe('open');
    if (state.status !== 'open') return;
    expect(state.info.protocol.major).toBe(SESSION_PROTOCOL.major);
    expect(state.info.account?.id).toBe('acc_fake');
    expect(state.info.authzGeneration).toBe(1);
    expect(state.info.channel).toBe('app');
    expect(session.supports('stream.upload')).toBe(true);
    expect(appliance.stats().lastHello).toMatchObject({ t: 'hello', versions: [SESSION_PROTOCOL] });
    // The app channel's welcome says the box's direct ways in (none here), and no edition: a commercial box (AP-5400).
    expect(state.info.direct).toBeNull();
    expect(state.info.edition).toBe('commercial');
  });

  it('reads a community box from its welcome (AP-5400)', async () => {
    const { session } = track(setup({ edition: 'community' }));
    session.connect();
    await opened(session);
    const state = session.state();
    expect(state.status === 'open' && state.info.edition).toBe('community');
  });

  it('reconnects with a fresh handshake after the connection drops', async () => {
    const { session, appliance, states } = track(setup());
    session.connect();
    await opened(session);
    appliance.faults.dropAll('lost');
    await until(() => states.some((s) => s.status === 'reconnecting'));
    await opened(session);
    expect(appliance.stats().connects).toBe(2);
    const r = states.find((s) => s.status === 'reconnecting');
    expect(r).toMatchObject({ reason: 'lost' });
  });

  it('tells the appliance what it has cached on a reconnect: account and generation together (CT-47)', async () => {
    const { session, appliance, states } = track(setup());
    session.connect();
    await opened(session);
    const first = appliance.stats().lastHello as Record<string, unknown>;
    expect(first.cachedAccountId).toBeUndefined();
    expect(first.cachedAuthzGeneration).toBeUndefined();
    appliance.faults.dropAll('lost');
    await until(() => states.some((s) => s.status === 'reconnecting'));
    await opened(session);
    expect(appliance.stats().lastHello).toMatchObject({
      cachedAccountId: 'acc_fake',
      cachedAuthzGeneration: 1,
    });
  });

  it('a cache of another account is cleared at the welcome', async () => {
    const { session, notices } = track(
      setup({}, { cached: () => ({ accountId: 'acc_someone_else', authzGeneration: 1 }) }),
    );
    session.connect();
    await opened(session);
    const state = session.state();
    expect(state.status === 'open' && state.info.clearCache).toBe(true);
    expect(notices).toContainEqual({ kind: 'authz_changed', authzGeneration: 1, clearCache: true });
  });

  it('keeps retrying while the appliance is offline, with the distinct reason', async () => {
    const { session, appliance, states } = track(setup());
    appliance.faults.failConnects('appliance_offline', 3);
    session.connect();
    await opened(session);
    const reasons = states
      .filter((s) => s.status === 'reconnecting')
      .map((s) => s.status === 'reconnecting' && s.reason);
    expect(reasons).toEqual(['appliance_offline', 'appliance_offline', 'appliance_offline']);
  });

  it('honours the relay’s retry-after hint when busy', async () => {
    const { session, appliance, states } = track(setup());
    appliance.faults.failConnects('busy', 1, 40);
    const t0 = Date.now();
    session.connect();
    await opened(session);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(states.find((s) => s.status === 'reconnecting')).toMatchObject({ reason: 'busy' });
  });

  it('stops for good when this app is too old, or the appliance is: one major (HE-52)', async () => {
    const tooNew = track(setup({ majors: [SESSION_PROTOCOL.major + 1] }));
    tooNew.session.connect();
    await until(() => tooNew.session.state().status === 'closed');
    expect(tooNew.session.state()).toMatchObject({ status: 'closed', reason: 'client_too_old' });

    const tooOld = track(setup({ majors: [SESSION_PROTOCOL.major - 1] }));
    tooOld.session.connect();
    await until(() => tooOld.session.state().status === 'closed');
    expect(tooOld.session.state()).toMatchObject({ status: 'closed', reason: 'appliance_too_old' });
  });

  it('below the security floor it stops for good and says so; at the floor it connects (CT-53)', async () => {
    const below = track(
      setup(
        { clientFloor: { android: 140 } },
        { client: { build: 'a', platform: 'android', buildNumber: 139 } },
      ),
    );
    below.session.connect();
    await until(() => below.session.state().status === 'closed');
    expect(below.session.state()).toMatchObject({ status: 'closed', reason: 'client_below_floor' });
    expect(below.appliance.stats().lastHello).toMatchObject({
      client: { platform: 'android', buildNumber: 139 },
    });

    // No build number counts as 0: refused wherever a floor is set.
    const none = track(setup({ clientFloor: { web: 5 } }));
    none.session.connect();
    await until(() => none.session.state().status === 'closed');
    expect(none.session.state()).toMatchObject({ reason: 'client_below_floor' });

    const at = track(
      setup(
        { clientFloor: { android: 140, web: 99 } },
        { client: { build: 'a', platform: 'android', buildNumber: 140 } },
      ),
    );
    at.session.connect();
    await opened(at.session);
  });

  it('closes on revocation, rejects what is pending and refuses to reconnect', async () => {
    const { session, appliance, notices } = track(setup({}, { deadlineMs: 5000 }));
    appliance.faults.slowAccept(200);
    session.connect();
    await opened(session);
    const pending = session.call(api.messages.send, {
      params: { burrow: 'b', conversationId: 'c' },
      query: {},
      body: { text: 'hi' },
    });
    await new Promise((r) => setTimeout(r, 20));
    appliance.faults.revoke();
    // It was sent (and accepted): it may have been applied, so its outcome is unknown, not “never sent” (CT-194).
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect((error as Error).cause).toBeInstanceOf(SessionClosedError);
    expect((error as Error).cause).toMatchObject({ reason: 'revoked' });
    expect(session.state()).toMatchObject({ status: 'closed', reason: 'revoked' });
    expect(notices).toContainEqual({ kind: 'revoked', scope: 'endpoint' });
    session.connect();
    await new Promise((r) => setTimeout(r, 30));
    expect(session.state()).toMatchObject({ status: 'closed', reason: 'revoked' });
  });

  it('rekeys by reconnecting when the appliance says goaway(rekey), invisibly to calls', async () => {
    const { session, appliance, states } = track(setup());
    session.connect();
    await opened(session);
    appliance.faults.goaway('rekey');
    const calls = [];
    for (let i = 0; i < 4; i++) calls.push(session.call(api.health.get, EMPTY));
    for (const r of await Promise.all(calls)) expect(r.status).toBe(200);
    await until(() => appliance.stats().connects > 1);
    expect(states.some((s) => s.status === 'reconnecting' && s.reason === 'rekey')).toBe(true);
  });

  it('suspends while nothing is under way: idle, no connection, and back where it left off (AP-924)', async () => {
    const { session, appliance, states } = track(setup());
    session.connect();
    // A connection being opened is under way too.
    expect(session.suspend?.()).toBe(false);
    await opened(session);
    const seen: unknown[] = [];
    const ready: boolean[] = [];
    session.subscribe(['conv:c1'], {
      onEvent: (e) => seen.push(e.event),
      onSnapshotRequired: () => seen.push('snapshot'),
      onReady: ({ resumed }) => ready.push(resumed),
    });
    await until(() => ready.length === 1);
    // A request under way keeps the connection.
    appliance.faults.slowAccept(30);
    const call = session.call(api.messages.send, {
      params: { burrow: 'b', conversationId: 'c' },
      query: {},
      body: { text: 'hi' },
    });
    expect(session.suspend?.()).toBe(false);
    await call;
    expect(session.suspend?.()).toBe(true);
    expect(session.state()).toEqual({ status: 'idle' });
    await until(() => appliance.stats().open === 0);
    appliance.publish('conv:c1', { type: 'x', n: 1 });
    await new Promise((r) => setTimeout(r, 20));
    // Nothing dials while suspended; `connect()` does, and the subscription resumes from its cursor.
    expect(appliance.stats().connects).toBe(1);
    expect(states.some((s) => s.status === 'reconnecting')).toBe(false);
    session.connect();
    await opened(session);
    await until(() => seen.length === 1);
    expect(seen).toEqual([{ type: 'x', n: 1 }]);
    expect(ready).toEqual([false, true]);
    // A call made while suspended dials by itself.
    expect(session.suspend?.()).toBe(true);
    expect((await session.call(api.health.get, EMPTY)).status).toBe(200);
    expect(appliance.stats().connects).toBe(3);
    session.close();
    expect(session.suspend?.()).toBe(false);
  });

  it('an unenrolled endpoint gets the enrollment channel: an app session ends as not enrolled', async () => {
    const app = track(setup({ admit: () => 'not_enrolled' }));
    app.session.connect();
    await until(() => app.session.state().status === 'closed');
    expect(app.session.state()).toMatchObject({ status: 'closed', reason: 'not_enrolled' });

    const enroll = track(setup({ admit: () => 'not_enrolled' }, { expect: 'any' }));
    enroll.session.connect();
    await opened(enroll.session);
    const s = enroll.session.state();
    expect(s.status === 'open' && s.info.channel).toBe('enroll');
    expect(s.status === 'open' && s.info.account).toBeNull();
    // App operations are refused until enrolled.
    const r = await enroll.session.call(api.runs.get, {
      params: { burrow: 'b', number: 1 },
      query: {},
      body: undefined,
    });
    expect(r).toMatchObject({ status: 403, body: { error: { code: 'enrollment_required' } } });
  });
});

describe('secure session: requests and durable commands', () => {
  it('sends inputs as JSON: absent (undefined) query parameters are dropped, as over HTTP', async () => {
    const { session, calls } = track(setup());
    session.connect();
    const r = await session.call(api.messages.list, {
      params: { burrow: 'burrow-hq', conversationId: 'cnv_general' },
      query: { before: undefined, limit: 50 },
      body: undefined,
    });
    expect(r.status).toBe(200);
    expect(calls.at(-1)?.input).toEqual({
      params: { burrow: 'burrow-hq', conversationId: 'cnv_general' },
      query: { limit: 50 },
    });
  });

  it('answers reads and reports accepted → executing → result for mutations', async () => {
    const { session } = track(setup());
    session.connect();
    const read = await session.call(api.health.get, EMPTY);
    expect(read).toMatchObject({ status: 200, body: { ok: true } });
    const phases: string[] = [];
    const r = await session.call(
      api.messages.send,
      { params: { burrow: 'b', conversationId: 'c' }, query: {}, body: { text: 'hi' } },
      { onProgress: (p) => phases.push(p) },
    );
    expect(r.status).toBe(200);
    expect(phases).toEqual(['accepted']);
  });

  it('commit then lost answer: resolves through status, never executing twice', async () => {
    const { session, appliance } = track(setup());
    session.connect();
    await opened(session);
    appliance.faults.loseResults(1);
    const r = await session.call(api.messages.send, {
      params: { burrow: 'b', conversationId: 'c' },
      query: {},
      body: { text: 'once' },
    });
    expect(r.status).toBe(200);
    expect(appliance.stats().executed.get('messages.send')).toBe(1);
    expect(appliance.stats().connects).toBe(2);
  });

  it('lost on the way in: a safe mutation is resent with the same id; a destructive one asks', async () => {
    const { session, appliance } = track(setup());
    session.connect();
    await opened(session);
    appliance.faults.swallowRequests(1);
    const r = await session.call(
      api.messages.send,
      { params: { burrow: 'b', conversationId: 'c' }, query: {}, body: { text: 'again' } },
      { requestId: 'req_same_0123456789' },
    );
    expect(r.requestId).toBe('req_same_0123456789');
    expect(appliance.stats().requestsSeen).toEqual(['req_same_0123456789']);
    expect(appliance.stats().executed.get('messages.send')).toBe(1);

    appliance.faults.swallowRequests(1);
    const merge = session.call(
      api.prs.merge,
      { params: { burrow: 'b', number: 482 }, query: {}, body: {} },
      { requestId: 'req_merge_012345678' },
    );
    await expect(merge).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(appliance.stats().executed.get('prs.merge')).toBeUndefined();
    // Asking again says it was never committed.
    expect(await session.status('req_merge_012345678', api.prs.merge)).toEqual({ state: 'unknown' });
  });

  it('dedupes a retry with the same id and refuses the same id with another payload', async () => {
    const { session, appliance } = track(setup());
    session.connect();
    const input = { params: { burrow: 'b', conversationId: 'c' }, query: {}, body: { text: 'x' } };
    const a = await session.call(api.messages.send, input, { requestId: 'req_one_0123456789' });
    const b = await session.call(api.messages.send, input, { requestId: 'req_one_0123456789' });
    expect(b).toEqual(a);
    expect(appliance.stats().executed.get('messages.send')).toBe(1);
    await expect(
      session.call(api.messages.send, { ...input, body: { text: 'y' } }, { requestId: 'req_one_0123456789' }),
    ).resolves.toMatchObject({ status: 409, body: { error: { code: 'idempotency_mismatch' } } });
  });

  it('a request that can’t be delivered before its deadline fails as not delivered', async () => {
    const { session, appliance } = track(setup());
    appliance.faults.offline(true);
    session.connect();
    await expect(session.call(api.health.get, EMPTY, { deadlineMs: 30 })).rejects.toBeInstanceOf(
      NotDeliveredError,
    );
  });

  it('cancels a queued call without sending it', async () => {
    const { session, appliance } = track(setup());
    appliance.faults.offline(true);
    session.connect();
    const controller = new AbortController();
    const call = session.call(api.health.get, EMPTY, { signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    appliance.faults.offline(false);
    session.reconnectNow();
    await opened(session);
    expect(appliance.stats().requestsSeen).toEqual([]);
  });

  it('the typed client decodes session answers like HTTP ones', async () => {
    const appliance = createFakeAppliance({
      handle: async (op) =>
        op === 'prs.merge'
          ? {
              status: 202,
              body: { approvalRequired: true, approvalId: 'apr_1', approvalNumber: 7, eventId: 'evt_1' },
            }
          : { status: 404, body: { error: { code: 'not_found', message: 'No such run.' } } },
    });
    const session = createSecureSession({ connector: appliance.connector });
    live.push(session);
    const client = createClient({ session, validateResponses: false });
    const merged = await client.prs.merge({ params: { burrow: 'b', number: 1 } });
    expect(merged).toMatchObject({ status: 'pending_approval', approvalNumber: 7 });
    await expect(client.runs.get({ params: { burrow: 'b', number: 1 } })).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });
});

describe('secure session: retry safety from the contract (CT-194)', () => {
  const send = { params: { burrow: 'b', conversationId: 'c' }, query: {}, body: { text: 'once' } };
  const list = { params: { burrow: 'b', conversationId: 'c' }, query: {}, body: undefined };
  const removal = { params: { burrow: 'b', messageId: 'msg_1' }, query: {}, body: undefined };
  /** Operations a newer runtime has and this build doesn't know (`OPERATION_SAFETY` has no entry for them). */
  const newer = [
    { id: 'things.frob', method: 'POST' },
    { id: 'things.peek', method: 'GET' },
  ] as unknown as AnyEndpoint[];

  async function ready(
    fake: Partial<FakeApplianceOptions> = {},
    options: Partial<SecureSessionOptions> = {},
  ) {
    const t = track(setup(fake, options));
    t.session.connect();
    await opened(t.session);
    return t;
  }

  it('follows the contract’s classification, stricter only; an op it doesn’t know is never replayed', () => {
    expect(retryPolicy('messages.list', 'GET')).toEqual({
      retry: 'safe',
      destructive: false,
      reask: true,
      resend: false,
    });
    expect(retryPolicy('messages.send', 'POST')).toEqual({
      retry: 'receipt',
      destructive: false,
      reask: false,
      resend: true,
    });
    expect(retryPolicy('messages.delete', 'DELETE')).toMatchObject({ destructive: true, resend: false });
    expect(retryPolicy('repos.create', 'POST')).toMatchObject({ retry: 'never', resend: false });
    expect(retryPolicy('vault.setSecret', 'PUT')).toMatchObject({ retry: 'never', resend: false });
    expect(retryPolicy('things.frob', 'POST')).toMatchObject({ retry: 'never', reask: false, resend: false });
    expect(retryPolicy('things.peek', 'GET')).toMatchObject({ retry: 'never', reask: false, resend: false });
    // `isDestructive` adds; it never takes the contract's mark away.
    expect(retryPolicy('messages.send', 'POST', () => true)).toMatchObject({
      destructive: true,
      resend: false,
    });
    expect(retryPolicy('messages.delete', 'DELETE', () => false)).toMatchObject({ destructive: true });
    expect(defaultIsDestructive('services.stop', 'POST')).toBe(true);
    expect(defaultIsDestructive('things.gone', 'DELETE')).toBe(true);
    expect(defaultIsDestructive('things.frob', 'POST')).toBe(false);
  });

  it('a read lost in transit is asked again after the reconnect, as it is: same id, no status', async () => {
    const { session, appliance } = await ready();
    appliance.faults.swallowRequests(1);
    const r = await session.call(api.messages.list, list, { requestId: 'req_read_0123456789' });
    expect(r.status).toBe(200);
    const { attempts, statusAsked, connects } = appliance.stats();
    expect(attempts.map((a) => a.id)).toEqual(['req_read_0123456789', 'req_read_0123456789']);
    expect(statusAsked).toEqual([]);
    expect(connects).toBe(2);
  });

  it('a deduplicated mutation lost on the way in: status first, then the same request once more, run once', async () => {
    const { session, appliance } = await ready();
    appliance.faults.swallowRequests(1);
    const r = await session.call(api.messages.send, send, { requestId: 'req_send_0123456789' });
    expect(r).toMatchObject({ status: 200, requestId: 'req_send_0123456789' });
    const { attempts, statusAsked, executed } = appliance.stats();
    expect(statusAsked).toEqual(['req_send_0123456789']);
    // Stable retry identity: the same id and the same input digest on every attempt.
    const digest = requestDigest('messages.send', { params: send.params, query: {}, body: send.body });
    expect(attempts).toEqual([
      { id: 'req_send_0123456789', op: 'messages.send', digest },
      { id: 'req_send_0123456789', op: 'messages.send', digest },
    ]);
    expect(executed.get('messages.send')).toBe(1);
  });

  it('committed, then the answer lost: the stored outcome comes back from status; nothing is sent again', async () => {
    const { session, appliance } = await ready();
    appliance.faults.loseResults(1);
    const r = await session.call(api.messages.send, send, { requestId: 'req_kept_0123456789' });
    expect(r).toMatchObject({ status: 200, body: { op: 'messages.send', echo: { text: 'once' } } });
    const { attempts, statusAsked, executed } = appliance.stats();
    expect(attempts.map((a) => a.id)).toEqual(['req_kept_0123456789']);
    expect(statusAsked).toEqual(['req_kept_0123456789']);
    expect(executed.get('messages.send')).toBe(1);
  });

  it('an op that acts outside its receipt is never sent again by itself: `not_found` proves nothing', async () => {
    // `repos.create` makes the repository on disk before its commit. The old op-name heuristic didn't call it
    // destructive, so it was resent here and ran twice (the second run refused: the repository exists).
    const { session, appliance } = await ready();
    appliance.faults.loseBeforeCommit(1);
    const create = { params: { burrow: 'b' }, query: {}, body: { name: 'Whombat_Website' } };
    const error = await session
      .call(api.repos.create, create, { requestId: 'req_repo_0123456789' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    const { attempts, statusAsked, executed } = appliance.stats();
    expect(statusAsked).toEqual(['req_repo_0123456789']);
    expect(attempts.map((a) => a.id)).toEqual(['req_repo_0123456789']);
    expect(executed.get('repos.create')).toBe(1);
    // What the appliance says is still there to ask: no receipt.
    expect(await session.status('req_repo_0123456789', api.repos.create)).toEqual({ state: 'unknown' });
  });

  it('a destructive op is never resent by itself; a person may send it again with the same id', async () => {
    const { session, appliance } = await ready();
    appliance.faults.swallowRequests(1);
    await expect(
      session.call(api.messages.delete, removal, { requestId: 'req_del_01234567890' }),
    ).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(appliance.stats().executed.get('messages.delete')).toBeUndefined();
    expect(await session.status('req_del_01234567890', api.messages.delete)).toEqual({ state: 'unknown' });
    const again = await session.call(api.messages.delete, removal, { requestId: 'req_del_01234567890' });
    expect(again.status).toBe(200);
    expect(appliance.stats().executed.get('messages.delete')).toBe(1);
  });

  it('isDestructive makes the session stricter, never looser', async () => {
    const looser = await ready({}, { isDestructive: () => false });
    looser.appliance.faults.swallowRequests(1);
    await expect(looser.session.call(api.messages.delete, removal)).rejects.toBeInstanceOf(
      OutcomeUnknownError,
    );
    const stricter = await ready({}, { isDestructive: (op) => op === 'messages.send' });
    stricter.appliance.faults.swallowRequests(1);
    await expect(stricter.session.call(api.messages.send, send)).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(stricter.appliance.stats().executed.get('messages.send')).toBeUndefined();
  });

  it('an op this build doesn’t know (a newer runtime’s) is never asked or sent again, read or not', async () => {
    const { session, appliance } = await ready({ endpoints: newer });
    appliance.faults.swallowRequests(1);
    await expect(
      session.invoke('things.frob', { n: 1 }, { requestId: 'req_frob_0123456789' }),
    ).rejects.toBeInstanceOf(OutcomeUnknownError);
    appliance.faults.swallowRequests(1);
    await expect(
      session.invoke('things.peek', {}, { requestId: 'req_peek_0123456789', mutating: false }),
    ).rejects.toBeInstanceOf(OutcomeUnknownError);
    const { attempts, statusAsked, executed } = appliance.stats();
    expect(attempts.map((a) => a.id)).toEqual(['req_frob_0123456789', 'req_peek_0123456789']);
    expect(statusAsked).toEqual(['req_frob_0123456789', 'req_peek_0123456789']);
    expect(executed.get('things.frob')).toBeUndefined();
    // Answered normally when nothing is lost.
    await expect(session.invoke('things.frob', { n: 2 })).resolves.toMatchObject({ status: 200 });
  });

  it('a secret op keeps no answer: status says it went through, a same-id retry gets unknown_outcome (CT-44)', async () => {
    const { session, appliance } = await ready();
    const secret = {
      params: { burrow: 'b', entryId: 'vlt_01234567' },
      query: {},
      body: { value: 'sk-0123456789' },
    };
    appliance.faults.loseResults(1);
    const lost = await session
      .call(api.vault.setSecret, secret, { requestId: 'req_sec_01234567890' })
      .catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(OutcomeRedactedError);
    expect(lost).toMatchObject({ state: 'completed' });
    expect(appliance.stats().attempts.map((a) => a.id)).toEqual(['req_sec_01234567890']);
    expect(appliance.stats().executed.get('vault.setSecret')).toBe(1);
    // A runtime answering a same-id retry with `unknown_outcome`.
    const retried = await session
      .call(api.vault.setSecret, secret, { requestId: 'req_sec_01234567890' })
      .catch((e: unknown) => e);
    expect(retried).toBeInstanceOf(OutcomeRedactedError);
    expect(retried).toMatchObject({ state: null });
    expect(appliance.stats().executed.get('vault.setSecret')).toBe(1);
  });

  it('closing the session: a request never sent never happened; one already sent may have', async () => {
    const { session, appliance } = await ready({}, { deadlineMs: 5000 });
    appliance.faults.offline(true);
    const queued = session.call(api.messages.send, send);
    await new Promise((r) => setTimeout(r, 10));
    session.close();
    const error = await queued.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionClosedError);
    expect(error).not.toBeInstanceOf(OutcomeUnknownError);
    expect(appliance.stats().attempts).toEqual([]);
  });
});

describe('secure session: accepted work without its result, status callers, the fake’s receipts (AP-578…AP-581)', () => {
  const send = { params: { burrow: 'b', conversationId: 'c' }, query: {}, body: { text: 'once' } };

  async function ready(
    fake: Partial<FakeApplianceOptions> = {},
    options: Partial<SecureSessionOptions> = {},
  ) {
    const t = track(setup(fake, options));
    t.session.connect();
    await opened(t.session);
    return t;
  }

  it('accepted for ever (a runtime before 0.29.1): status backs off, then gives up, acknowledged, never resent', async () => {
    const { session, appliance } = await ready(
      {},
      { statusPollMs: 5, statusPollMaxMs: 40, acceptedWaitMs: 400 },
    );
    appliance.faults.loseAfterCommit(1, 'accepted');
    const t0 = Date.now();
    const error = await session
      .call(api.messages.send, send, { requestId: 'req_orph_0123456789' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect(error).toMatchObject({ acknowledged: true });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(390);
    const { statusAsked, attempts, executed } = appliance.stats();
    // 5, 10, 20, 40, 40 … ms apart, not every 5 ms (about 80 checks).
    expect(statusAsked.length).toBeGreaterThan(3);
    expect(statusAsked.length).toBeLessThan(20);
    expect(attempts.map((a) => a.id)).toEqual(['req_orph_0123456789']);
    expect(executed.get('messages.send')).toBe(1);
    // The appliance still says so; a person may keep checking.
    expect(await session.status('req_orph_0123456789', api.messages.send)).toEqual({ state: 'accepted' });
  });

  it('a runtime that keeps no result (0.29.1): `completed` + `redacted` is done, nothing is resent', async () => {
    const { session, appliance } = await ready();
    appliance.faults.loseAfterCommit(1, 'redacted');
    const error = await session
      .call(api.messages.send, send, { requestId: 'req_red_01234567890' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeRedactedError);
    expect(wentThrough(error)).toBe(true);
    expect(phaseForError(error)).toBe('completed');
    const { statusAsked, attempts, executed } = appliance.stats();
    expect(statusAsked).toEqual(['req_red_01234567890']);
    expect(attempts.map((a) => a.id)).toEqual(['req_red_01234567890']);
    expect(executed.get('messages.send')).toBe(1);
    expect(await session.status('req_red_01234567890', api.messages.send)).toEqual({
      state: 'completed',
      response: { status: 200, body: undefined, requestId: 'req_red_01234567890' },
      redacted: true,
    });
  });

  it('`rejected` + `unknown_outcome` (it acted before its answer was lost) is unknown, never resent (CT-196)', async () => {
    const { session, appliance } = await ready();
    appliance.faults.loseBeforeCommit(1, 'unknown_outcome');
    const create = { params: { burrow: 'b' }, query: {}, body: { name: 'Whombat_Website' } };
    const error = await session
      .call(api.repos.create, create, { requestId: 'req_uo_012345678901' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect(error).toMatchObject({ acknowledged: true });
    expect(await session.status('req_uo_012345678901', api.repos.create)).toEqual({
      state: 'unknown',
      acknowledged: true,
    });
    // Sent again with the same id (a person's choice): `error{unknown_outcome}` is still unknown, not a refusal.
    const again = await session
      .call(api.repos.create, create, { requestId: 'req_uo_012345678901' })
      .catch((e: unknown) => e);
    expect(again).toBeInstanceOf(OutcomeUnknownError);
    expect(again).toMatchObject({ acknowledged: true });
    expect(appliance.stats().executed.get('repos.create')).toBe(1);
    // Whatever the op's class: a `receipt` op answered so isn't resent either.
    appliance.faults.loseBeforeCommit(1, 'unknown_outcome');
    const sent = await session
      .call(api.messages.send, send, { requestId: 'req_uo_send_0123456' })
      .catch((e: unknown) => e);
    expect(sent).toBeInstanceOf(OutcomeUnknownError);
    expect(appliance.stats().attempts.filter((a) => a.id === 'req_uo_send_0123456')).toHaveLength(1);
    expect(appliance.stats().executed.get('messages.send')).toBe(1);
  });

  it('closing the session ends a pending status question at once, with the session-closed error', async () => {
    const { session } = await ready({}, { deadlineMs: 5000 });
    const asked = session.status('req_closed_0123456789', api.messages.send);
    session.close();
    const t0 = Date.now();
    const error = await asked.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionClosedError);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('two callers asking status about one id both get the answer', async () => {
    const { session } = await ready({}, { deadlineMs: 300 });
    await session.call(api.messages.send, send, { requestId: 'req_twice_012345678' });
    const [a, b] = await Promise.all([
      session.status('req_twice_012345678', api.messages.send),
      session.status('req_twice_012345678', api.messages.send),
    ]);
    expect(a).toMatchObject({ state: 'completed', response: { status: 200 } });
    expect(b).toEqual(a);
  });

  it('the fake keeps receipts as the runtime: per op, `accepted` only after a commit, a secret op’s error stripped', async () => {
    const { session, appliance } = await ready({
      handle: async (op) =>
        op === 'vault.setSecret' || op === 'messages.edit'
          ? {
              status: 400,
              body: {
                error: {
                  code: 'invalid_values',
                  message: 'Not a key.',
                  fields: { value: ['Not a key.'] },
                  details: { hint: 'sk-…' },
                },
              },
            }
          : { status: 200, body: { ok: true } },
    });
    // The receipt key has the op: one id used for two ops is two commands.
    await session.call(api.messages.send, send, { requestId: 'req_same_id_0123456' });
    const reacted = await session.call(
      api.messages.react,
      { params: { burrow: 'b', messageId: 'msg_1' }, query: {}, body: { value: '👍', on: true } },
      { requestId: 'req_same_id_0123456' },
    );
    expect(reacted.status).toBe(200);
    expect(appliance.stats().executed.get('messages.react')).toBe(1);
    // A refusal commits nothing: no `accepted`.
    const phases: string[] = [];
    const refused = await session.call(
      api.messages.edit,
      { params: { burrow: 'b', messageId: 'msg_1' }, query: {}, body: { text: 'x' } },
      { onProgress: (p) => phases.push(p) },
    );
    expect(refused.status).toBe(400);
    expect(phases).toEqual([]);
    // A secret op's refusal, asked again: only its code and message are kept.
    const secret = {
      params: { burrow: 'b', entryId: 'vlt_01234567' },
      query: {},
      body: { value: 'nope' },
    };
    const first = await session.call(api.vault.setSecret, secret, { requestId: 'req_sec_err_0123456' });
    expect(first.body).toMatchObject({
      error: { code: 'invalid_values', fields: { value: ['Not a key.'] } },
    });
    const again = await session.call(api.vault.setSecret, secret, { requestId: 'req_sec_err_0123456' });
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: { code: 'bad_request', message: 'Not a key.' } });
    expect(appliance.stats().executed.get('vault.setSecret')).toBe(1);
  });
});

describe('secure session: acknowledged, aborted and never-sent requests (AP-574…AP-576)', () => {
  const send = { params: { burrow: 'b', conversationId: 'c' }, query: {}, body: { text: 'once' } };
  const list = { params: { burrow: 'b', conversationId: 'c' }, query: {}, body: undefined };

  async function ready(
    fake: Partial<FakeApplianceOptions> = {},
    options: Partial<SecureSessionOptions> = {},
  ) {
    const t = track(setup(fake, options));
    t.session.connect();
    await opened(t.session);
    return t;
  }

  it('an acknowledged mutation is never resent, even when its receipt expired while the device was away', async () => {
    const { session, appliance } = await ready();
    // Committed and accepted, the answer lost with the connection; the device stays away.
    appliance.faults.failConnects('appliance_offline', 10_000);
    appliance.faults.loseResults(1);
    const phases: string[] = [];
    const call = session.call(api.messages.send, send, {
      requestId: 'req_ack_01234567890',
      onProgress: (p) => phases.push(p),
    });
    await until(() => appliance.stats().executed.get('messages.send') === 1 && phases.length === 1);
    expect(phases).toEqual(['accepted']);
    // Longer than the receipt retention (`WHOMBAT_COMMAND_RECEIPT_HOURS`): the finished receipt is swept.
    appliance.faults.expireReceipts();
    appliance.faults.failConnects('appliance_offline', 0);
    session.reconnectNow();
    const error = await call.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect(error).toMatchObject({ acknowledged: true });
    const { attempts, statusAsked, executed } = appliance.stats();
    expect(statusAsked).toEqual(['req_ack_01234567890']);
    expect(attempts.map((a) => a.id)).toEqual(['req_ack_01234567890']);
    expect(executed.get('messages.send')).toBe(1);
  });

  it('`executing` from status counts too, and is remembered across reconnects', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { session, appliance } = await ready({
      handle: async (op) => {
        if (op === 'messages.send') await gate;
        return { status: 200, body: { ok: true } };
      },
    });
    // No `accepted` frame: the connection drops while it runs, and `status` says `executing`.
    appliance.faults.loseBeforeCommit(1);
    const call = session.call(api.messages.send, send, { requestId: 'req_exe_01234567890' });
    await until(() => appliance.stats().attempts.length === 1);
    appliance.faults.dropAll('lost');
    await until(() => appliance.stats().statusAsked.length >= 1);
    // Away again; meanwhile it finishes and its receipt is gone.
    appliance.faults.offline(true);
    release();
    await until(() => appliance.stats().executed.get('messages.send') === 1);
    appliance.faults.offline(false);
    session.reconnectNow();
    await expect(call).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(appliance.stats().attempts.map((a) => a.id)).toEqual(['req_exe_01234567890']);
    expect(appliance.stats().executed.get('messages.send')).toBe(1);
  });

  it('aborting a mutation already sent: outcome unknown, the abort its cause; a queued one or a read just aborts', async () => {
    const { session, appliance } = await ready({
      handle: async (op) => {
        if (op === 'messages.list') await new Promise((r) => setTimeout(r, 50));
        return { status: 200, body: { ok: true } };
      },
    });
    appliance.faults.slowAccept(100);
    const sent = new AbortController();
    const mutation = session.call(api.messages.send, send, { signal: sent.signal });
    await until(() => appliance.stats().attempts.length === 1);
    sent.abort();
    const error = await mutation.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect((error as Error).cause).toMatchObject({ name: 'AbortError' });
    expect(phaseForError(error)).toBe('unknown');

    const reading = new AbortController();
    const read = session.call(api.messages.list, list, { signal: reading.signal });
    await until(() => appliance.stats().attempts.length === 2);
    reading.abort();
    const readError = await read.catch((e: unknown) => e);
    expect(readError).toMatchObject({ name: 'AbortError' });
    expect(readError).not.toBeInstanceOf(OutcomeUnknownError);

    appliance.faults.offline(true);
    const waiting = new AbortController();
    const queued = session.call(api.messages.send, send, { signal: waiting.signal });
    await new Promise((r) => setTimeout(r, 10));
    waiting.abort();
    const queuedError = await queued.catch((e: unknown) => e);
    expect(queuedError).toMatchObject({ name: 'AbortError' });
    expect(phaseForError(queuedError)).toBe('not_delivered');
    expect(appliance.stats().attempts).toHaveLength(2);
  });

  it('the appliance cancelling a request: a mutation’s outcome is unknown, a read just ends', async () => {
    const { session } = await ready({
      handle: async () => ({ status: 499, body: {}, protocolCode: 'cancelled' }),
    });
    const error = await session.call(api.messages.send, send).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect((error as Error).cause).toMatchObject({ name: 'AbortError' });
    const readError = await session.call(api.messages.list, list).catch((e: unknown) => e);
    expect(readError).toMatchObject({ name: 'AbortError' });
    expect(readError).not.toBeInstanceOf(OutcomeUnknownError);
  });

  it('a request queued before the connection opens is sent on it, an ephemeral one too; never sent is not delivered', async () => {
    const { session, appliance } = track(setup());
    const begun = await session.invoke(
      'enroll.claim.begin',
      { attempt: 1 },
      { requestId: 'req_begin_012345678' },
    );
    expect(begun.status).toBe(200);
    expect(appliance.stats().attempts.map((a) => a.id)).toEqual(['req_begin_012345678']);

    const offline = track(setup());
    offline.appliance.faults.offline(true);
    await expect(
      offline.session.invoke('enroll.claim.begin', { attempt: 2 }, { deadlineMs: 40 }),
    ).rejects.toBeInstanceOf(NotDeliveredError);
    expect(offline.appliance.stats().attempts).toEqual([]);
  });
});

describe('secure session: calls tied to one connection', () => {
  it('sends an exchange’s later calls only on the connection its first call went on', async () => {
    const { session, appliance, calls } = track(setup());
    session.connect();
    await opened(session);
    const tie: ConnectionTie = {};
    expect((await session.invoke('enroll.claim.local.start', {}, { tie })).status).toBe(200);
    expect(tie.connection).toBeDefined();
    expect((await session.invoke('enroll.claim.local.prove', { n: 1 }, { tie })).status).toBe(200);
    // The connection drops, and the session is open again on a new one.
    appliance.faults.dropAll('lost');
    await until(() => appliance.stats().connects === 2);
    await opened(session);
    // What follows in the exchange is refused unsent: the person's details never go on another connection.
    const error = await session
      .invoke('enroll.claim.local', { account: { name: 'Mara' } }, { tie })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionLostError);
    expect(error).toBeInstanceOf(NotDeliveredError);
    expect(calls.map((c) => c.op)).toEqual(['enroll.claim.local.start', 'enroll.claim.local.prove']);
    // A call without the tie goes out as ever, and a new exchange gets the new connection.
    const next: ConnectionTie = {};
    expect((await session.invoke('enroll.claim.local.start', {}, { tie: next })).status).toBe(200);
    expect(next.connection).not.toBe(tie.connection);
  });

  it('never keeps a tied call for the next connection while the session reconnects', async () => {
    const { session, appliance, calls } = track(setup());
    session.connect();
    await opened(session);
    const tie: ConnectionTie = {};
    await session.invoke('enroll.claim.local.prove', { n: 1 }, { tie });
    appliance.faults.offline(true);
    appliance.faults.dropAll('lost');
    await until(() => session.state().status !== 'open');
    // Not connected: an untied call would wait for the next connection; this one is refused at once.
    await expect(session.invoke('enroll.claim.local', {}, { tie, deadlineMs: 5_000 })).rejects.toBeInstanceOf(
      ConnectionLostError,
    );
    appliance.faults.offline(false);
    session.reconnectNow();
    await opened(session);
    expect(calls.map((c) => c.op)).toEqual(['enroll.claim.local.prove']);
  });

  it('names the connection by the first call, also when that one waited for the session to open', async () => {
    const { session, calls } = track(setup());
    const tie: ConnectionTie = {};
    // Asked before the session connected: sent on the first connection, which the tie then names.
    expect((await session.invoke('enroll.claim.local.start', {}, { tie })).status).toBe(200);
    expect(tie.connection).toBeDefined();
    expect((await session.invoke('enroll.claim.local.begin', {}, { tie })).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('shows the claim link in its hello when the page was opened with it, and never otherwise', async () => {
    const withLink = track(setup({}, { claimLink: 'kxmprt' }));
    withLink.session.connect();
    await opened(withLink.session);
    expect(withLink.appliance.stats().lastHello).toMatchObject({ claimLink: 'kxmprt' });
    const without = track(setup({}, { claimLink: null }));
    without.session.connect();
    await opened(without.session);
    expect(without.appliance.stats().lastHello).not.toHaveProperty('claimLink');
  });
});

describe('secure session: subscriptions', () => {
  it('resumes from the cursor after a reconnect: missed events arrive once, none twice', async () => {
    const { session, appliance } = track(setup());
    session.connect();
    await opened(session);
    const seen: unknown[] = [];
    const ready: boolean[] = [];
    session.subscribe(['conv:c1'], {
      onEvent: (e) => seen.push(e.event),
      onSnapshotRequired: () => seen.push('snapshot'),
      onReady: ({ resumed }) => ready.push(resumed),
    });
    await until(() => ready.length === 1);
    appliance.publish('conv:c1', { type: 'x', n: 1 });
    appliance.publish('conv:other', { type: 'x', n: 'x' });
    await until(() => seen.length === 1);
    appliance.faults.offline(true);
    appliance.publish('conv:c1', { type: 'x', n: 2 });
    appliance.faults.offline(false);
    session.reconnectNow();
    await until(() => seen.length === 2);
    appliance.publish('conv:c1', { type: 'x', n: 3 });
    await until(() => seen.length === 3);
    expect(seen).toEqual([
      { type: 'x', n: 1 },
      { type: 'x', n: 2 },
      { type: 'x', n: 3 },
    ]);
    expect(ready).toEqual([false, true]);
  });

  it('asks for a snapshot when the cursor is past retention or access changed', async () => {
    const { session, appliance, notices } = track(setup());
    session.connect();
    await opened(session);
    const snapshots: string[] = [];
    let ready = 0;
    session.subscribe(['conv:c1'], {
      onEvent: () => {},
      onSnapshotRequired: ({ reason }) => snapshots.push(reason),
      onReady: () => {
        ready += 1;
      },
    });
    await until(() => ready === 1);
    appliance.publish('conv:c1', { type: 'x', n: 1 });
    await new Promise((r) => setTimeout(r, 5));
    appliance.faults.offline(true);
    appliance.publish('conv:c1', { type: 'x', n: 2 });
    appliance.faults.expireEvents(0);
    appliance.faults.offline(false);
    session.reconnectNow();
    await until(() => snapshots.length === 1);
    expect(snapshots).toEqual(['cursor_expired']);
    appliance.faults.bumpAuthz();
    await until(() => snapshots.length === 2);
    expect(snapshots[1]).toBe('authz_changed');
    expect(notices).toContainEqual({ kind: 'authz_changed', authzGeneration: 2, clearCache: false });
  });

  /* The appliance drops a subscription it answers with `snapshot_required` (“nothing is subscribed meanwhile”): the
   * session subscribes again after the given cursor, so live events keep coming (AP-1097). */
  function watch(session: ApplianceSession, topics: string[]) {
    const seen: unknown[] = [];
    const snapshots: string[] = [];
    const ready: boolean[] = [];
    const handle = session.subscribe(topics, {
      onEvent: (e) => seen.push(e.event),
      onSnapshotRequired: ({ reason }) => snapshots.push(reason),
      onReady: ({ resumed }) => ready.push(resumed),
    });
    return { seen, snapshots, ready, handle };
  }
  const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

  it('after a runtime restart it subscribes again from the new cursor: later events arrive, one resync', async () => {
    const { session, appliance } = track(setup());
    session.connect();
    await opened(session);
    const w = watch(session, ['conv:c1']);
    await until(() => w.ready.length === 1);
    appliance.publish('conv:c1', { type: 'x', n: 1 });
    await until(() => w.seen.length === 1);
    appliance.faults.restart();
    await until(() => w.ready.length === 2);
    const [, resumeOld, again] = appliance.stats().subscribes;
    expect(resumeOld?.after).toBeTruthy();
    expect(again).toMatchObject({ sub: resumeOld?.sub, topics: ['conv:c1'] });
    expect(again?.after).not.toBe(resumeOld?.after);
    appliance.publish('conv:c1', { type: 'x', n: 2 });
    appliance.publish('conv:c1', { type: 'x', n: 3 });
    await until(() => w.seen.length === 3);
    await settle();
    expect(w.seen).toEqual([
      { type: 'x', n: 1 },
      { type: 'x', n: 2 },
      { type: 'x', n: 3 },
    ]);
    expect(w.snapshots).toEqual(['restart']);
    expect(w.ready).toEqual([false, true]);
    expect(appliance.stats().subscribes).toHaveLength(3);
  });

  it('after an expired cursor and a permission change live events still arrive', async () => {
    const { session, appliance } = track(setup());
    session.connect();
    await opened(session);
    const w = watch(session, ['conv:c1']);
    await until(() => w.ready.length === 1);
    appliance.faults.offline(true);
    appliance.publish('conv:c1', { type: 'x', n: 'missed' });
    appliance.faults.expireEvents(0);
    appliance.faults.offline(false);
    session.reconnectNow();
    await until(() => w.ready.length === 2);
    appliance.publish('conv:c1', { type: 'x', n: 1 });
    await until(() => w.seen.length === 1);
    appliance.faults.bumpAuthz();
    await until(() => w.ready.length === 3);
    appliance.publish('conv:c1', { type: 'x', n: 2 });
    await until(() => w.seen.length === 2);
    await settle();
    expect(w.seen).toEqual([
      { type: 'x', n: 1 },
      { type: 'x', n: 2 },
    ]);
    expect(w.snapshots).toEqual(['cursor_expired', 'authz_changed']);
    expect(w.ready).toEqual([false, true, true]);
  });

  it('after falling behind, and after an event too large to send, live events continue past it', async () => {
    const { session, appliance } = track(setup());
    session.connect();
    await opened(session);
    const w = watch(session, ['conv:c1']);
    await until(() => w.ready.length === 1);
    appliance.faults.overflow();
    await until(() => w.ready.length === 2);
    appliance.publish('conv:c1', { type: 'x', n: 1 });
    await until(() => w.seen.length === 1);
    // Too large for one CONTROL message: the appliance answers `snapshot_required{overflow}` at that event's cursor.
    appliance.publish('conv:c1', { type: 'x', n: 'big', body: 'x'.repeat(70_000) });
    await until(() => w.ready.length === 3);
    appliance.publish('conv:c1', { type: 'x', n: 2 });
    await until(() => w.seen.length === 2);
    await settle();
    expect(w.seen).toEqual([
      { type: 'x', n: 1 },
      { type: 'x', n: 2 },
    ]);
    expect(w.snapshots).toEqual(['overflow', 'overflow']);
  });

  it('a snapshot_required for a subscription closed meanwhile is ignored; closing in the handler stops it too', async () => {
    const { session, appliance } = track(setup());
    session.connect();
    await opened(session);
    const w = watch(session, ['conv:c1']);
    await until(() => w.ready.length === 1);
    appliance.faults.overflow();
    w.handle.close();
    await settle();
    expect(w.snapshots).toEqual([]);
    expect(appliance.stats().subscribes).toHaveLength(1);

    let inHandler: { close(): void } | null = null;
    const snapshots: string[] = [];
    let ready = 0;
    inHandler = session.subscribe(['conv:c2'], {
      onEvent: () => {},
      onSnapshotRequired: ({ reason }) => {
        snapshots.push(reason);
        inHandler?.close();
      },
      onReady: () => {
        ready += 1;
      },
    });
    await until(() => ready === 1);
    appliance.faults.overflow();
    await until(() => snapshots.length === 1);
    await settle();
    expect(appliance.stats().subscribes).toHaveLength(2);
  });

  it('a snapshot_required racing a topic change subscribes again with the newest topics', async () => {
    const { session, appliance } = track(setup());
    session.connect();
    await opened(session);
    const w = watch(session, ['conv:c1']);
    await until(() => w.ready.length === 1);
    appliance.faults.overflow();
    w.handle.setTopics(['conv:c1', 'conv:c2']);
    await until(() => w.ready.length >= 2 && w.snapshots.length === 1);
    await settle();
    const last = appliance.stats().subscribes.at(-1);
    expect(last?.topics).toEqual(['conv:c1', 'conv:c2']);
    appliance.publish('conv:c2', { type: 'x', n: 1 });
    await until(() => w.seen.length === 1);
    await settle();
    expect(w.seen).toEqual([{ type: 'x', n: 1 }]);
    expect(w.snapshots).toEqual(['overflow']);
  });

  it('an appliance that keeps answering snapshot_required is asked again with a growing wait, not in a loop', async () => {
    const { session, appliance } = track(
      setup({}, { snapshotBackoff: { initialMs: 40, maxMs: 80 }, random: () => 1 }),
    );
    session.connect();
    await opened(session);
    const w = watch(session, ['conv:c1']);
    await until(() => w.ready.length === 1);
    appliance.faults.repeatSnapshot(3);
    appliance.faults.overflow();
    await until(() => w.ready.length === 2, 3000);
    const at = appliance.stats().subscribes.map((s) => s.at);
    expect(at).toHaveLength(5);
    const gaps = at.slice(1).map((t, i) => t - (at[i] as number));
    // The first `snapshot_required` is followed at once; each repeat waits longer (40, 80, 80 ms).
    expect(gaps[0]).toBeLessThan(30);
    expect(gaps[1]).toBeGreaterThanOrEqual(35);
    expect(gaps[2]).toBeGreaterThanOrEqual(75);
    expect(gaps[3]).toBeGreaterThanOrEqual(75);
    expect(w.snapshots).toEqual(['overflow', 'overflow', 'overflow', 'overflow']);
    appliance.publish('conv:c1', { type: 'x', n: 1 });
    await until(() => w.seen.length === 1);
  });
});

describe('secure session: Settings → Skills’ large reads (contracts 2.0 CT-1418; AP-5521)', () => {
  it('reads them through an export stream from the start, and answers a refusal as the op’s own error', async () => {
    const seen: string[] = [];
    const { session } = track(
      setup({
        handle: async (op, _input, ctx) => {
          seen.push(`${op}:${ctx.requestId.startsWith('exp_') ? 'export' : 'request'}`);
          if (op === 'skills.hubSearch')
            return {
              status: 503,
              body: {
                error: {
                  code: 'unavailable',
                  message: 'Hermes’s hub didn’t answer.',
                  details: { code: 'skill_hub_unavailable' },
                },
              },
            };
          if (op === 'skills.library')
            return { status: 200, body: { agentName: 'Neo', items: [], categories: [], canAdd: true } };
          return { status: 200, body: { checkedAt: null, available: [], unreachable: [] } };
        },
      }),
    );
    session.connect();
    const params = { params: { burrow: 'b' }, query: {}, body: undefined };
    const library = await session.call(api.skills.library, params);
    expect(library).toMatchObject({ status: 200, body: { agentName: 'Neo', canAdd: true } });
    const search = await session.call(api.skills.hubSearch, { ...params, query: { q: 'pdf' } });
    expect(search.status).toBe(503);
    expect(search.body).toMatchObject({ error: { code: 'skill_hub_unavailable' } });
    // A read that answers one row or less stays a request.
    await session.call(api.skills.hubUpdates, params);
    expect(seen).toEqual(['skills.library:export', 'skills.hubSearch:export', 'skills.hubUpdates:request']);
  });
});

describe('secure session: streams', () => {
  const file = (size: number) => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 251;
    return bytes;
  };

  function recordingSession(fake: Partial<FakeApplianceOptions> = {}) {
    const appliance = createFakeAppliance({ handle: async () => ({ status: 200, body: null }), ...fake });
    const sent: Frame[] = [];
    const { session } = track({
      session: createSecureSession({
        maxBulkStreams: 1,
        connector: {
          async connect(request) {
            const wire = await appliance.connector.connect(request);
            return {
              ...wire,
              send(frame) {
                sent.push(frame);
                wire.send(frame);
              },
            };
          },
        },
      }),
    });
    session.connect();
    return { session, sent };
  }

  it('downloads a resource with credit flow control, and a range', async () => {
    const data = file(100_000);
    const { session } = track(
      setup({
        resources: async (ref) =>
          ref.kind === 'attachment' && ref.attachmentId === 'att_1'
            ? {
                meta: { contentType: 'image/png', size: data.byteLength, name: 'a.png', sha256: null },
                bytes: data,
              }
            : null,
      }),
    );
    session.connect();
    const s = await session.openResource({ kind: 'attachment', burrow: 'b', attachmentId: 'att_1' });
    expect(s.meta).toMatchObject({ contentType: 'image/png', size: 100_000, name: 'a.png' });
    const parts: Uint8Array[] = [];
    for await (const c of s.chunks) parts.push(c);
    const got = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) {
      got.set(p, at);
      at += p.byteLength;
    }
    expect(bytesToHex(sha256(got))).toBe(bytesToHex(sha256(data)));

    const r = await session.openResource(
      { kind: 'attachment', burrow: 'b', attachmentId: 'att_1' },
      { range: { start: 10, end: 20 } },
    );
    const rp: number[] = [];
    for await (const c of r.chunks) rp.push(...c);
    expect(rp).toEqual([...data.subarray(10, 20)]);

    await expect(
      session.openResource({ kind: 'attachment', burrow: 'b', attachmentId: 'att_nope' }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it.each(['download', 'export'] as const)('ends its half of a completed %s stream', async (kind) => {
    const bytes = file(40_000);
    const { session, sent } = recordingSession({
      resources: async () => ({
        meta: { contentType: 'application/octet-stream', size: bytes.length, name: null, sha256: null },
        bytes,
      }),
      exports: async () => ({ contentType: 'application/octet-stream', bytes }),
    });
    const resource = await session.openResource(
      kind === 'download'
        ? { kind: 'attachment', burrow: 'b', attachmentId: 'att_1' }
        : { kind: 'export', op: 'audit.export', input: {} },
    );
    let size = 0;
    for await (const chunk of resource.chunks) size += chunk.length;
    expect(size).toBe(bytes.length);
    // Both directions must end so a persistent bulk connection can admit more downloads.
    expect(sent.filter((frame) => frame.type === 'end')).toEqual([{ type: 'end', streamId: 1 }]);
  });

  it('downloads a thing page’s picture as a thing-image stream (contracts 0.121, CT-1000; AP-4537)', async () => {
    const png = file(2_000);
    const ref = 'fx-poster-dune.fixture';
    const { session } = track(
      setup({
        resources: async (r) =>
          r.kind === 'thing-image' && r.thing === 'connection:con_plex' && r.ref === ref
            ? {
                meta: { contentType: 'image/png', size: png.byteLength, name: null, sha256: null },
                bytes: png,
              }
            : null,
      }),
    );
    session.connect();
    const s = await session.openResource({
      kind: 'thing-image',
      burrow: 'b',
      thing: 'connection:con_plex',
      ref,
    });
    expect(s.meta.contentType).toBe('image/png');
    let n = 0;
    for await (const c of s.chunks) n += c.byteLength;
    expect(n).toBe(2_000);
    await expect(
      session.openResource({ kind: 'thing-image', burrow: 'b', thing: 'connection:con_other', ref }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('releases cancellation listeners after completed and refused downloads', async () => {
    const bytes = file(64_000);
    const { session } = track(
      setup({
        resources: async (ref) =>
          ref.kind === 'attachment' && ref.attachmentId === 'att_1'
            ? {
                meta: { contentType: 'image/png', size: bytes.byteLength, name: null, sha256: null },
                bytes,
              }
            : null,
      }),
    );
    const controller = new AbortController();
    const listeners = abortListeners(controller.signal);
    for (let i = 0; i < 12; i++) {
      const stream = await session.openResource(
        { kind: 'attachment', burrow: 'b', attachmentId: 'att_1' },
        { signal: controller.signal },
      );
      let size = 0;
      for await (const chunk of stream.chunks) size += chunk.byteLength;
      expect(size).toBe(bytes.byteLength);
    }
    expect(listeners.size).toBe(0);
    await expect(
      session.openResource(
        { kind: 'attachment', burrow: 'b', attachmentId: 'att_missing' },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(listeners.size).toBe(0);
  });

  it('releases the listener and slot when a download request cannot be encoded', async () => {
    const resources = vi.fn(async () => ({
      meta: { contentType: 'text/plain', size: 0, name: null, sha256: null },
      bytes: new Uint8Array(),
    }));
    const { session } = track(setup({ resources }, { maxBulkStreams: 1 }));
    const controller = new AbortController();
    const listeners = abortListeners(controller.signal);
    await expect(
      session.openResource(
        { kind: 'attachment', burrow: 'b', attachmentId: '' },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'SessionEncodeError' });
    expect(listeners.size).toBe(0);
    expect(resources).not.toHaveBeenCalled();
    const valid = await session.openResource({ kind: 'attachment', burrow: 'b', attachmentId: 'att_1' });
    for await (const _ of valid.chunks) {
      // A rejected request must leave the only bulk slot available.
    }
    expect(resources).toHaveBeenCalledTimes(1);
  });

  it.each(['abort', 'connection lost'] as const)(
    'settles a download before metadata when %s and releases its listener',
    async (ending) => {
      const requested = deferred<void>();
      const metadata = deferred<null>();
      const { session, appliance } = track(
        setup({
          resources: async () => {
            requested.resolve();
            return metadata.promise;
          },
        }),
      );
      const controller = new AbortController();
      const listeners = abortListeners(controller.signal);
      const opening = session.openResource(
        { kind: 'attachment', burrow: 'b', attachmentId: 'att_1' },
        { signal: controller.signal },
      );
      const rejected = expect(opening).rejects.toMatchObject(
        ending === 'abort' ? { name: 'AbortError' } : { code: 'lost' },
      );
      try {
        await requested.promise;
        if (ending === 'abort') controller.abort();
        else appliance.faults.dropAll('lost');
        await rejected;
        expect(listeners.size).toBe(0);
      } finally {
        metadata.resolve(null);
      }
    },
  );

  it('never sends an already cancelled download, including on a warm connection', async () => {
    const resources = vi.fn(async () => ({
      meta: { contentType: 'text/plain', size: 0, name: null, sha256: null },
      bytes: new Uint8Array(),
    }));
    const { session } = track(setup({ resources }));
    const ref = { kind: 'attachment', burrow: 'b', attachmentId: 'att_1' } as const;
    const controller = new AbortController();
    controller.abort();
    await expect(session.openResource(ref, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(resources).not.toHaveBeenCalled();
    const warmup = await session.openResource(ref);
    for await (const _ of warmup.chunks) {
      // Wait for END, leaving the shared bulk connection warm.
    }
    await expect(session.openResource(ref, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(resources).toHaveBeenCalledTimes(1);
  });

  it.each(['while queued', 'just after waking'] as const)(
    'cancels a bulk slot %s without delaying the next download',
    async (when) => {
      const bytes = file(2 * 1024 * 1024);
      const resources = vi.fn(async () => ({
        meta: { contentType: 'text/plain', size: bytes.byteLength, name: null, sha256: null },
        bytes,
      }));
      const { session } = track(setup({ resources }, { maxBulkStreams: 1 }));
      const ref = { kind: 'attachment', burrow: 'b', attachmentId: 'att_1' } as const;
      const active = await session.openResource(ref);
      const controller = new AbortController();
      const listeners = abortListeners(controller.signal);
      const cancelled = session.openResource(ref, { signal: controller.signal });
      const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
      const next = session.openResource(ref);
      if (when === 'just after waking') active.cancel();
      controller.abort();
      await rejected;
      expect(listeners.size).toBe(0);
      if (when === 'while queued') {
        expect(resources).toHaveBeenCalledTimes(1);
        active.cancel();
      }
      const stream = await next;
      let size = 0;
      for await (const chunk of stream.chunks) size += chunk.byteLength;
      expect(size).toBe(bytes.byteLength);
      expect(resources).toHaveBeenCalledTimes(2);
    },
  );

  it('explicitly cancels an open stream and releases its cancellation listener', async () => {
    const bytes = file(2 * 1024 * 1024);
    const { session } = track(
      setup({
        resources: async () => ({
          meta: { contentType: 'text/plain', size: bytes.byteLength, name: null, sha256: null },
          bytes,
        }),
      }),
    );
    const controller = new AbortController();
    const listeners = abortListeners(controller.signal);
    const stream = await session.openResource(
      { kind: 'attachment', burrow: 'b', attachmentId: 'att_1' },
      { signal: controller.signal },
    );
    stream.cancel();
    expect(listeners.size).toBe(0);
    const consume = async () => {
      for await (const _ of stream.chunks) {
        // Buffered bytes retain their ordering; consuming the cancelled stream still fails.
      }
    };
    await expect(consume()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each(['break', 'write failure'] as const)(
    'cancels a download when its consumer stops with %s',
    async (ending) => {
      const bytes = file(2 * 1024 * 1024);
      const { session, sent } = recordingSession({
        resources: async () => ({
          meta: { contentType: 'application/octet-stream', size: bytes.length, name: null, sha256: null },
          bytes,
        }),
      });
      const controller = new AbortController();
      const listeners = abortListeners(controller.signal);
      const ref = { kind: 'attachment', burrow: 'b', attachmentId: 'att_1' } as const;
      const stream = await session.openResource(ref, { signal: controller.signal });
      const writeError = new Error('Could not write the file.');
      const consume = async () => {
        for await (const _ of stream.chunks) {
          if (ending === 'write failure') throw writeError;
          break;
        }
      };
      if (ending === 'write failure') await expect(consume()).rejects.toBe(writeError);
      else await consume();
      expect(sent.filter((frame) => frame.type === 'reset')).toEqual([
        { type: 'reset', streamId: 1, code: STREAM_RESET.cancelled },
      ]);
      expect(listeners.size).toBe(0);
      const next = await session.openResource(ref);
      next.cancel();
    },
  );

  it.each(['interactive', 'bulk'] as const)(
    'cancels a download waiting for the shared %s dial without cancelling another download',
    async (waitingFor) => {
      const dial = deferred<void>();
      const entered = deferred<void>();
      const appliance = createFakeAppliance({
        handle: async () => ({ status: 200, body: {} }),
        resources: async () => ({
          meta: { contentType: 'text/plain', size: 0, name: null, sha256: null },
          bytes: new Uint8Array(),
        }),
      });
      const session = createSecureSession({
        connector: {
          async connect(request) {
            if (request.class === waitingFor) {
              entered.resolve();
              await dial.promise;
            }
            return appliance.connector.connect(request);
          },
        },
      });
      live.push(session);
      const ref = { kind: 'attachment', burrow: 'b', attachmentId: 'att_1' } as const;
      const controller = new AbortController();
      const listeners = abortListeners(controller.signal);
      const cancelled = session.openResource(ref, { signal: controller.signal });
      const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
      await entered.promise;
      const other = session.openResource(ref);
      controller.abort();
      try {
        await rejected;
        expect(listeners.size).toBe(0);
      } finally {
        dial.resolve();
      }
      const stream = await other;
      for await (const _ of stream.chunks) {
        // The other caller keeps using the session's shared dial.
      }
      expect(appliance.stats().connects).toBe(2);
    },
  );

  it('uploads in sha256-checked chunks, reading one chunk at a time, and resumes after a drop', async () => {
    const data = file(200_000);
    let completedWith: Uint8Array | null = null;
    const { session, appliance } = track(
      setup(
        {
          completeUpload: async ({ bytes }) => {
            completedWith = bytes;
            return { attachment: { id: 'att_up' } };
          },
        },
        { uploadChunkBytes: 64 * 1024 },
      ),
    );
    session.connect();
    await opened(session);
    let largestRead = 0;
    let bytesRead = 0;
    const source = {
      name: 'big.bin',
      type: 'application/octet-stream',
      size: data.byteLength,
      read: async (offset: number, length: number) => {
        largestRead = Math.max(largestRead, length);
        bytesRead += length;
        return data.slice(offset, offset + length);
      },
    };
    appliance.faults.dropUploadAfter(70_000);
    const progress: number[] = [];
    const done = await session.upload({ burrow: 'b', attachmentId: 'att_up' }, source, {
      onProgress: (p) => progress.push(p.sent),
    });
    expect(done).toEqual({ attachment: { id: 'att_up' } });
    expect(completedWith && bytesToHex(sha256(completedWith))).toBe(bytesToHex(sha256(data)));
    expect(largestRead).toBeLessThanOrEqual(64 * 1024);
    // The bulk connection dropped once (interactive + bulk + bulk again)…
    expect(appliance.stats().connects).toBe(3);
    // …and the upload resumed after the last acknowledged chunk, not from zero: one hashing pass plus one
    // sending pass, with at most the chunks in flight at the drop read twice.
    expect(bytesRead).toBeLessThanOrEqual(2 * data.byteLength + 2 * 64 * 1024);
    expect(progress).toContain(64 * 1024);
    expect(progress.at(-1)).toBe(data.byteLength);
  });

  it('reads a backup file once: a box at minor 7 takes it without the whole sha256 (CT-1695)', async () => {
    const data = file(200_000);
    const { session } = track(setup({ completeUpload: async () => ({ stagedBackupId: 'bku_1' }) }));
    session.connect();
    await opened(session);
    let bytesRead = 0;
    const source = {
      name: 'back.wbk',
      type: 'application/vnd.whombat.backup',
      size: data.byteLength,
      read: async (offset: number, length: number) => {
        bytesRead += length;
        return data.slice(offset, offset + length);
      },
    };
    const done = await session.upload({ type: 'backup-file', burrow: 'b', stagedBackupId: 'bku_1' }, source);
    expect(done).toEqual({ stagedBackupId: 'bku_1' });
    expect(bytesRead).toBe(data.byteLength);
  });

  it('refuses an upload whose bytes change underneath it', async () => {
    const data = file(40_000);
    const { session } = track(setup());
    session.connect();
    let reads = 0;
    const source = {
      name: 'f',
      type: '',
      size: data.byteLength,
      read: async (offset: number, length: number) => {
        reads += 1;
        // The second pass reads different bytes than the hashing pass.
        const out = data.slice(offset, offset + length);
        if (reads > 1) out[0] = (out[0] ?? 0) ^ 1;
        return out;
      },
    };
    await expect(session.upload({ burrow: 'b', attachmentId: 'att_x' }, source)).rejects.toMatchObject({
      code: 'integrity',
    });
  });

  it.each(['unreadable', 'shorter'] as const)(
    'cancels the peer’s upload when the local file becomes %s, so it can be retried',
    async (failure) => {
      const data = file(40_000);
      const { session, sent } = recordingSession();
      let reads = 0;
      const read = async (offset: number, length: number) => {
        if (++reads === 2) {
          if (failure === 'unreadable') throw new Error('File could not be read.');
          return data.slice(offset, offset + length - 1);
        }
        return data.slice(offset, offset + length);
      };
      const source = { name: 'file.bin', type: '', size: data.length, read };
      const target = { burrow: 'b', attachmentId: 'att_retry' };
      await expect(session.upload(target, source)).rejects.toThrow();
      expect(sent.filter((frame) => frame.type === 'reset')).toEqual([
        { type: 'reset', streamId: 1, code: STREAM_RESET.cancelled },
      ]);
      // The slot and partial upload remain usable without reopening the session.
      await expect(session.upload(target, source)).resolves.toEqual({ attachmentId: target.attachmentId });
    },
  );

  it('does not announce another chunk after cancellation while reading the local file', async () => {
    const data = file(40_000);
    const { session, sent } = recordingSession();
    const entered = deferred<void>();
    const resume = deferred<Uint8Array>();
    let reads = 0;
    const source = {
      name: 'file.bin',
      type: '',
      size: data.length,
      read: async () => {
        if (++reads === 2) {
          entered.resolve();
          return resume.promise;
        }
        return data;
      },
    };
    const controller = new AbortController();
    const uploading = session.upload({ burrow: 'b', attachmentId: 'att_cancel' }, source, {
      signal: controller.signal,
    });
    const rejected = expect(uploading).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    controller.abort();
    resume.resolve(data);
    await rejected;
    const chunks = sent.filter((frame) => {
      if (frame.type !== 'control') return false;
      const decoded = decodeClientMessage(frame.payload);
      return decoded.ok && decoded.message.t === 'chunk';
    });
    expect(chunks).toEqual([]);
    expect(sent.filter((frame) => frame.type === 'reset')).toHaveLength(1);
  });

  it('carries collaboration messages both ways and re-attaches after a drop', async () => {
    const received: number[][] = [];
    let echo: ((m: Uint8Array) => void) | null = null;
    let attached = 0;
    const { session, appliance } = track(
      setup({
        collab: (doc, send) => {
          if (doc.canvasId === 'cvs_secret') return null;
          attached += 1;
          echo = send;
          return { receive: (m) => received.push([...m]), close: () => {} };
        },
      }),
    );
    session.connect();
    await opened(session);
    const channel = session.openCollab({ burrow: 'b', canvasId: 'cvs_plan' });
    if (!channel) throw new Error('no channel');
    const statuses: string[] = [];
    channel.onStatus((s) => statuses.push(s));
    const inbound: number[][] = [];
    channel.onMessage((m) => inbound.push([...m]));
    await until(() => statuses.includes('open'));
    expect(channel.readOnly()).toBe(false);
    expect(channel.send(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(channel.send(new Uint8Array(12_000).fill(9))).toBe(true);
    // Messages larger than a frame span several ([u32 len][bytes] framing, contracts 0.4).
    expect(channel.send(new Uint8Array(40_000).fill(4))).toBe(true);
    expect(channel.send(new Uint8Array(17 * 1024 * 1024))).toBe(false);
    await until(() => received.length === 3);
    expect(received[0]).toEqual([1, 2, 3]);
    expect(received[1]?.length).toBe(12_000);
    expect(received[2]?.length).toBe(40_000);
    (echo as unknown as (m: Uint8Array) => void)(new Uint8Array([7]));
    (echo as unknown as (m: Uint8Array) => void)(new Uint8Array(50_000).fill(8));
    await until(() => inbound.length === 2);
    expect(inbound[1]?.length).toBe(50_000);
    appliance.faults.dropAll('lost');
    await until(() => statuses.filter((s) => s === 'open').length === 2);
    expect(attached).toBe(2);
    expect(statuses).toContain('closed');

    const denied = session.openCollab({ burrow: 'b', canvasId: 'cvs_secret' });
    const ds: string[] = [];
    denied?.onStatus((s) => ds.push(s));
    await until(() => ds.includes('denied'));
  });
});

/**
 * A connector whose next `times` connections of `cls` end right after delivering the welcome, in the same turn
 * (what a relay-replayed record right behind the welcome does, 0.5.1 integration report).
 */
function closingAfterWelcome(
  inner: SessionConnector,
  cls: 'interactive' | 'bulk',
  times: number,
): SessionConnector & { closed: () => number } {
  let left = times;
  let closed = 0;
  return {
    closed: () => closed,
    async connect(request) {
      const wire = await inner.connect(request);
      if (request.class !== cls || left <= 0) return wire;
      left -= 1;
      const frameListeners: ((f: Parameters<Parameters<WireConnection['onFrame']>[0]>[0]) => void)[] = [];
      const closeListeners: Parameters<WireConnection['onClose']>[0][] = [];
      let ended = false;
      const end = (info: { reason: 'lost'; detail?: string }) => {
        if (ended) return;
        ended = true;
        closed += 1;
        for (const l of closeListeners) l(info);
      };
      wire.onFrame((frame) => {
        for (const l of frameListeners) l(frame);
        if (!ended) {
          wire.close('lost');
          end({ reason: 'lost', detail: 'replayed record' });
        }
      });
      wire.onClose((info) => end({ reason: 'lost', detail: info.detail }));
      return {
        ...wire,
        send: (f) => wire.send(f),
        onFrame: (l) => void frameListeners.push(l),
        onClose: (l) => void closeListeners.push(l),
        close: (r) => wire.close(r),
        bytesSent: () => wire.bytesSent(),
        congested: () => wire.congested(),
        drained: () => wire.drained(),
      };
    },
  };
}

describe('a connection that ends right after its welcome (0.5.1 replayed-record report)', () => {
  it('interactive: is not installed; the session reconnects and requests go through', async () => {
    const appliance = createFakeAppliance({
      handle: async () => ({ status: 200, body: { ok: true } }),
    });
    const connector = closingAfterWelcome(appliance.connector, 'interactive', 1);
    const session = createSecureSession({ connector, backoff: { initialMs: 2, maxMs: 10 } });
    live.push(session);
    const states: string[] = [];
    session.onState((st) => states.push(st.status));
    const r = await Promise.race([
      session.call(api.health.get, EMPTY),
      new Promise<'hung'>((res) => setTimeout(() => res('hung'), 2000)),
    ]);
    expect(r).toMatchObject({ status: 200 });
    expect(connector.closed()).toBe(1);
    expect(states).toContain('reconnecting');
  });

  it('bulk: a closed bulk connection is not handed out; the next dial serves the download', async () => {
    const data = new Uint8Array(1000).fill(7);
    const appliance = createFakeAppliance({
      handle: async () => ({ status: 200, body: { ok: true } }),
      resources: async () => ({
        meta: { contentType: 'text/plain', size: data.byteLength, name: 'a.txt', sha256: null },
        bytes: data,
      }),
    });
    const connector = closingAfterWelcome(appliance.connector, 'bulk', 1);
    const session = createSecureSession({ connector, backoff: { initialMs: 2, maxMs: 10 } });
    live.push(session);
    session.connect();
    await opened(session);
    const s = await Promise.race([
      session.openResource({ kind: 'attachment', burrow: 'b', attachmentId: 'att_1' }),
      new Promise<'hung'>((res) => setTimeout(() => res('hung'), 2000)),
    ]);
    expect(s).not.toBe('hung');
    if (s === 'hung') return;
    let size = 0;
    for await (const c of s.chunks) size += c.byteLength;
    expect(size).toBe(1000);
    expect(connector.closed()).toBe(1);
  });
});
