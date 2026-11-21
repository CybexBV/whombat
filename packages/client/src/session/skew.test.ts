import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '../http/client';
import { ApiError } from '../http/errors';
import { decodeControl, withFallbacks } from './control-decode';
import { createFakeAppliance, type FakeApplianceOptions, type FakeHandler } from './fake';
import { OperationError, sessionOps } from './managed-ops';
import { createSessionRealtime } from './realtime';
import { createSecureSession } from './secure';
import type { ApplianceSession } from './types';

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

function world(handle: FakeHandler, options: Partial<FakeApplianceOptions> = {}) {
  const appliance = createFakeAppliance({ account: { id: 'acc_mara', name: 'Mara' }, handle, ...options });
  const session = createSecureSession({
    connector: appliance.connector,
    backoff: { initialMs: 2, maxMs: 5 },
  });
  live.push(session);
  return { appliance, session };
}

const encode = (m: unknown) => new TextEncoder().encode(JSON.stringify(m));

describe('CONTROL messages from a newer runtime (AP-257)', () => {
  it('an error code this client doesn’t know is a generic error, its code kept in details', () => {
    const r = decodeControl(
      encode({
        t: 'error',
        id: 'req_0000000000000001',
        code: 'quota_exceeded',
        message: 'Out of room.',
        retryable: false,
      }),
    );
    expect(r).toEqual({
      ok: true,
      message: {
        t: 'error',
        id: 'req_0000000000000001',
        code: 'internal',
        message: 'Out of room.',
        retryable: false,
        details: { code: 'quota_exceeded' },
      },
    });
    // Details that name their own code keep it.
    expect(
      withFallbacks({
        t: 'error',
        code: 'quota_exceeded',
        message: 'x',
        retryable: false,
        details: { code: 'a' },
      }),
    ).toMatchObject({ code: 'internal', details: { code: 'a' } });
  });

  it('goaway, snapshot_required and revoked for reasons it doesn’t know take the safe meaning', () => {
    expect(decodeControl(encode({ t: 'goaway', reason: 'migrating', retryAfterMs: 0 }))).toMatchObject({
      ok: true,
      message: { t: 'goaway', reason: 'overload' },
    });
    expect(
      decodeControl(encode({ t: 'snapshot_required', sub: 'sub_1', reason: 'reindexed', cursor: '9' })),
    ).toMatchObject({ ok: true, message: { reason: 'overflow' } });
  });

  it('a new message type is skipped and a malformed one is still invalid', () => {
    expect(decodeControl(encode({ t: 'weather', sunny: true }))).toEqual({
      ok: false,
      kind: 'unknown_type',
      t: 'weather',
    });
    expect(decodeControl(encode({ t: 'error', code: 'internal' }))).toMatchObject({
      ok: false,
      kind: 'invalid',
    });
  });

  it('the session stays up: the request fails generically, the next one works', async () => {
    let n = 0;
    const { appliance, session } = world(
      async () =>
        n++ === 0
          ? { status: 500, body: { error: { message: 'Out of room.' } }, protocolCode: 'quota_exceeded' }
          : { status: 200, body: { ok: true } },
      { sendsNewer: true },
    );
    session.connect();
    await until(() => session.state().status === 'open');
    const first = await session.invoke('health.get', {});
    expect(first.status).toBe(500);
    expect(first.body).toMatchObject({ error: { code: 'quota_exceeded', message: 'Out of room.' } });
    const second = await session.invoke('health.get', {});
    expect(second.status).toBe(200);
    expect(appliance.stats().connects).toBe(1);
  });

  it('a session op answers an unknown code as an OperationError, and the typed client as a generic ApiError', async () => {
    const { session } = world(
      async () => ({
        status: 500,
        body: { error: { message: 'Out of room.' } },
        protocolCode: 'quota_exceeded',
      }),
      { sendsNewer: true },
    );
    session.connect();
    await until(() => session.state().status === 'open');
    const op = await sessionOps.backupStatus(session).catch((e: unknown) => e);
    expect(op).toBeInstanceOf(OperationError);
    expect((op as OperationError).code).toBe('quota_exceeded');
    const client = createClient({ session, validateResponses: false });
    const api = await client.conversations.list({ params: { burrow: 'hq' } }).catch((e: unknown) => e);
    expect(api).toBeInstanceOf(ApiError);
    expect((api as ApiError).status).toBe(500);
  });

  it('an event of a type only a newer runtime sends reaches no listener and raises no error', async () => {
    const { appliance, session } = world(async () => ({ status: 200, body: {} }));
    const realtime = createSessionRealtime(session);
    const errors: unknown[] = [];
    const seen: string[] = [];
    realtime.onError((e) => errors.push(e));
    realtime.onEvent((e) => seen.push(e.type));
    realtime.subscribe(['conv:cnv_billing']);
    realtime.connect();
    await until(() => realtime.status() === 'open');
    await new Promise((r) => setTimeout(r, 5));
    appliance.publish('conv:cnv_billing', { type: 'ledger.updated', entries: [] });
    appliance.publish('conv:cnv_billing', {
      type: 'typing',
      conversationId: 'cnv_billing',
      threadRootId: null,
      principalId: 'prn_dusty000000',
      active: true,
      expiresAt: '2026-09-23T09:22:30.000Z',
    });
    await until(() => seen.length === 1);
    expect(seen).toEqual(['typing']);
    expect(errors).toEqual([]);
  });
});
