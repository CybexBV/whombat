import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { EndpointsListOutput } from '@whombat/protocol/session';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NeedsNewerAppError } from '../http/errors';
import { isStrictEndpoint, isStrictSessionOp, strictPartsOf } from '../strict';
import { inboxItem } from '../test/fixtures';
import { fakeClient } from '../test/session';
import { leftOut, unsupportedItems } from '../tolerant';
import { createFakeAppliance } from './fake';
import { sessionOps } from './managed-ops';
import { createSecureSession } from './secure';
import type { ApplianceSession } from './types';

const PEER = '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH';
const device = (id: string, platform: string) => ({
  endpointId: id,
  peerId: PEER,
  label: `Device ${id}`,
  platform,
  accountId: 'acc_mara',
  createdAt: '2026-09-28T10:00:00.000Z',
  lastSeenAt: null,
  current: id === 'end_one',
  revokedAt: null,
  revocation: 'none',
});

const live: ApplianceSession[] = [];
beforeEach(() => leftOut.reset());
afterEach(() => {
  for (const s of live.splice(0)) s.close();
  leftOut.reset();
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

async function applianceAnswering(answer: () => unknown) {
  const appliance = createFakeAppliance({
    account: { id: 'acc_mara', name: 'Mara' },
    handle: async () => ({ status: 200, body: answer() }),
  });
  const session = createSecureSession({
    connector: appliance.connector,
    backoff: { initialMs: 2, maxMs: 5 },
  });
  live.push(session);
  session.connect();
  await until(() => session.state().status === 'open');
  return session;
}

describe('security views are decoded strictly (AP-266)', () => {
  it('which ops and endpoints', () => {
    for (const op of [
      'endpoints.list',
      'enroll.pair.lookup',
      'recovery.kit.register',
      'backup.recoveryMaterial',
      'passkeys.list',
      'passkey.register',
      'enroll.passkey',
    ])
      expect(isStrictSessionOp(op)).toBe(true);
    expect(isStrictSessionOp('appliance.status')).toBe(false);
    for (const id of ['approvals.get', 'agent.setKeys', 'automations.setKeys', 'vault.giveKey'])
      expect(isStrictEndpoint(id)).toBe(true);
    expect(isStrictEndpoint('messages.list')).toBe(false);
    // The agent's page: only its keys (AP-707).
    expect(isStrictEndpoint('agent.get')).toBe(false);
    expect(strictPartsOf('agent.get')).toEqual(['grants']);
    expect(strictPartsOf('messages.list')).toBeNull();
  });

  it('(a) a device whose platform this app doesn’t know: not a shorter Devices list, the update path', async () => {
    let platform = 'visionos';
    const session = await applianceAnswering(() => ({
      endpoints: [device('end_one', 'web'), device('end_two', platform)],
    }));
    // Tolerantly the second device would simply vanish, although it still has access.
    const body = { endpoints: [device('end_one', 'web'), device('end_two', 'visionos')] };
    expect(EndpointsListOutput.safeParse(body).success).toBe(false);
    await expect(sessionOps.endpointsList(session)).rejects.toBeInstanceOf(NeedsNewerAppError);
    expect(leftOut.get()).toEqual({ items: 0, needsNewer: true });
    // Once it reads (a newer app, or the device gone), the notice goes.
    platform = 'android';
    expect((await sessionOps.endpointsList(session)).endpoints).toHaveLength(2);
    expect(leftOut.get()).toEqual({ items: 0, needsNewer: false });
  });

  it('a security view it couldn’t read stops counting when its screen is left (AP-701)', async () => {
    const session = await applianceAnswering(() => ({ endpoints: [device('end_two', 'visionos')] }));
    await expect(sessionOps.endpointsList(session)).rejects.toBeInstanceOf(NeedsNewerAppError);
    expect(leftOut.get().needsNewer).toBe(true);
    leftOut.clearStrict();
    expect(leftOut.get()).toEqual({ items: 0, needsNewer: false });
  });

  it('the inbox shows its own placeholder rows: what it leaves out isn’t counted (AP-701)', async () => {
    const row = inboxItem('ntf_1', { kind: 'mention', link: { type: 'dm', room: 'chat' } });
    const inbox = {
      sections: [
        {
          kind: 'mention',
          title: 'MENTIONS',
          items: [row, { ...row, id: 'ntf_newer', link: { type: 'ledger', id: 'lgr_1' } }],
        },
      ],
      counts: { all: 2, needs_you: 0, mentions: 2, agents: 0 },
      unread: 2,
    };
    const serving = async () =>
      new Response(JSON.stringify(inbox), { status: 200, headers: { 'content-type': 'application/json' } });
    const read = await fakeClient(serving, { validateResponses: false }).notifications.inbox({
      params: { burrow: 'burrow-hq' },
    });
    expect(read.sections[0]?.items.map((i) => i.id)).toEqual(['ntf_1']);
    expect(unsupportedItems(read.sections[0])).toBe(1);
    expect(leftOut.get()).toEqual({ items: 0, needsNewer: false });
  });

  describe('the agent’s page: tolerant, except its keys (AP-707)', () => {
    const serving = (body: unknown) => async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    async function theAgent(): Promise<Record<string, unknown>> {
      const world = createFixtureFetch();
      return (await (await world('http://w.test/api/v1/burrows/burrow-hq/agent')).json()) as Record<
        string,
        unknown
      >;
    }
    const params = { burrow: 'burrow-hq' };

    it('a recent row linking to something this app doesn’t know loses its link, the screen stays', async () => {
      const body = await theAgent();
      const recent = body.recent as { link: unknown }[];
      expect(recent.length).toBeGreaterThan(0);
      recent.push({ ...recent[0], eventId: 'evt_newer', link: { type: 'ledger', id: 'x' } } as never);
      for (const validateResponses of [true, false]) {
        const profile = await fakeClient(serving(body), { validateResponses }).agent.get({
          params,
        });
        expect(profile.recent).toHaveLength(recent.length);
        expect(profile.recent.at(-1)?.link).toBeNull();
        expect(profile.grants.length).toBeGreaterThan(0);
      }
      expect(leftOut.get().needsNewer).toBe(false);
    });

    it('a key this app can’t read: the update path, never a shorter KEYS list', async () => {
      const body = await theAgent();
      const grants = body.grants as Record<string, unknown>[];
      grants.push({ ...grants[0], keyId: 'ledger.write' });
      for (const validateResponses of [true, false])
        await expect(
          fakeClient(serving(body), { validateResponses }).agent.get({ params }),
        ).rejects.toBeInstanceOf(NeedsNewerAppError);
      expect(leftOut.get().needsNewer).toBe(true);
      grants.pop();
      await fakeClient(serving(body)).agent.get({ params });
      expect(leftOut.get().needsNewer).toBe(false);
    });
  });
});
