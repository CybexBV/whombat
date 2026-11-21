/**
 * Whombat Link on the runtime (docs/decisions/whombat-link.md), against a real database and the fake manager's 4.4
 * routes: `reach.get`, the owner turning Link on and off (signed events, the content proof), control moving it to grace
 * and ended (the signed change, the Inbox items, one push), the update channel, phones' push tokens through the box, and
 * remote help's switches following Link. Needs Postgres: the ops sign events and keep tokens on endpoints. One database,
 * one box: the tests run in order.
 */

import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { applianceEndpoints, applianceEvents } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import type { RequestAnswer } from './dispatcher';
import { RequestControl } from './dispatcher';
import { linkItems } from './link/notices';
import { ManagerCallError } from './ports';
import type { SessionPrincipal } from './trust';

const PROOF = 'ab'.repeat(64);
const m = useManagedRuntime({
  seed: true,
  prepare: (manager) => {
    manager.setLink('off');
    manager.channel = { channel: 'development' };
    // While Link runs, turning it on with a name only gives control that name and keeps the state (the manager's
    // Keeper.On). The stand-in would start Link again, and the runtime tells the name after every read: the state a
    // test just set would be gone before it looked.
    const start = manager.linkOn.bind(manager);
    manager.linkOn = async (request) => {
      const now = await manager.linkState();
      return request.name && (now.link.state === 'on' || now.link.state === 'grace') ? now : start(request);
    };
  },
  contentProof: async () => PROOF,
});
let mara: SessionPrincipal;
let maraEndpoint: string;
let requestNo = 0;

beforeAll(async () => {
  const id = await m.enroll(IDS.mara);
  maraEndpoint = id.endpointId;
  mara = await m.runtime.trust.identify(id.peerId, id.publicKey);
});

async function op(name: string, input: unknown = {}): Promise<RequestAnswer> {
  let answer: RequestAnswer | null = null;
  await m.runtime.dispatcher.handle(
    mara,
    { id: `req-link-${++requestNo}`, op: name, input },
    { accepted: () => {}, result: (a) => (answer = a) },
    new RequestControl(null),
  );
  return answer as unknown as RequestAnswer;
}

const events = async (type: string) =>
  (
    await m.t.services.db
      .select({ payload: applianceEvents.payload, actor: applianceEvents.actorAccountId })
      .from(applianceEvents)
      .where(eq(applianceEvents.type, type as never))
  ).map((r) => ({ actor: r.actor, payload: r.payload }));

const TOKEN = { platform: 'fcm' as const, token: 'fcm-token-of-maras-phone', appId: 'com.whombat.app' };

describe('reach and Link', () => {
  it('reach.get says Link is off, with no address and no Tailscale here', async () => {
    expect(await op('reach.get')).toMatchObject({
      type: 'result',
      output: { link: { state: 'off' }, ownAddress: null, tailscale: null },
    });
    expect(m.runtime.link.active()).toBe(false);
  });

  it('without Link a phone’s token waits, and remote help shows no switch', async () => {
    expect(await op('push.token.set', { token: TOKEN })).toMatchObject({
      type: 'result',
      output: { registered: false },
    });
    expect(m.manager.pushHandles.size).toBe(0);
    expect(await op('remoteHelp.get')).toMatchObject({ type: 'result', output: { available: false } });
    // Phones aren't pushed through control while control doesn't know the box.
    expect(m.runtime.link.known()).toBe(false);
  });

  it('link.on: the box signs its part, the manager answers starting with a code; signed by the owner', async () => {
    const answer = await op('link.on');
    expect(answer).toMatchObject({
      type: 'result',
      output: { link: { state: 'starting', pending: { code: 'ABCD-EFGH' } } },
    });
    expect(m.manager.linkOns.at(-1)?.contentProof).toBe(PROOF);
    expect(await events('link.on')).toEqual([
      { actor: mara.account?.id, payload: { byAccountId: mara.account?.id, state: 'starting' } },
    ]);
    // The owner's own change isn't recorded as control's.
    expect(await events('link.state_changed')).toEqual([]);
    // Link runs: the token that waited is registered, and the box sends to its handle.
    await m.runtime.pushTokens.sync();
    const [row] = await m.t.services.db
      .select({ handle: applianceEndpoints.pushTokenHandle })
      .from(applianceEndpoints)
      .where(eq(applianceEndpoints.id, maraEndpoint));
    expect(row?.handle).toMatch(/^box-/);
    expect(m.manager.pushHandles.get(row?.handle as string)).toEqual(TOKEN);
  });

  it('control turns it on: the change is signed, phones are pushed through the box, remote help shows', async () => {
    m.manager.setLink('on', { label: 'quiet-otter-lamp' });
    await m.runtime.link.refresh();
    expect(await events('link.state_changed')).toEqual([{ actor: null, payload: { state: 'on' } }]);
    expect(m.runtime.link.known()).toBe(true);
    expect(await op('remoteHelp.get')).toMatchObject({ type: 'result' });
    const sent = m.manager.pushes.length;
    await m.runtime.controlPush.forAccounts([mara.account?.id as string], 'generic', 'test');
    const request = m.manager.pushes.at(sent);
    expect(request?.handles).toHaveLength(1);
    expect(request?.handles[0]).toMatch(/^box-/);
  });

  it('grace: one Inbox item and one push, not again after a restart’s read', async () => {
    const ends = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const pushed = m.manager.pushes.length;
    m.manager.setLink('grace', { graceEndsAt: ends });
    await m.runtime.link.refresh();
    await expect.poll(() => m.manager.pushes.length).toBe(pushed + 1);
    expect(m.manager.pushes.at(-1)).toMatchObject({ kind: 'security' });
    const [item] = linkItems(m.runtime.link.view());
    expect(item).toMatchObject({ id: `link.grace:${ends}`, severity: 'warn', nature: 'you' });
    expect(item?.body).toMatch(/Tailscale/);
    expect(item?.body).toMatch(/paper copy/);
    // The same grace read again (a restart reads it fresh): no second push.
    m.manager.setLink('on');
    await m.runtime.link.refresh();
    m.manager.setLink('grace', { graceEndsAt: ends });
    await m.runtime.link.refresh();
    await new Promise((r) => setTimeout(r, 50));
    expect(m.manager.pushes.length).toBe(pushed + 1);
  });

  it('ended: one item saying what still works and the way back in from away; the switches go', async () => {
    m.manager.setLink('ended');
    await m.runtime.link.refresh();
    const [item] = linkItems(m.runtime.link.view());
    expect(item?.title).toMatch(/ended/);
    // Every client shows it as it is, an iPhone too: Tailscale, and no place to subscribe (LNK-44).
    expect(item?.body).toMatch(/Tailscale/);
    expect(item?.body).not.toMatch(/app\.whombat\.com|subscribe/i);
    expect(m.runtime.link.active()).toBe(false);
    // A safety notice never depends on paying: an ended Link still sends `security` pushes.
    const sent = m.manager.pushes.length;
    await m.runtime.controlPush.security([mara.account?.id as string], 'test-ended', {
      title: 'A new device',
      body: 'Someone added a device.',
      path: '/settings',
    });
    expect(m.manager.pushes.slice(sent)).toEqual([expect.objectContaining({ kind: 'security' })]);
    expect(await op('remoteHelp.get')).toMatchObject({ type: 'result', output: { available: false } });
    // Policies follow: phone notifications and website feedback need Link.
    expect(await op('appliance.status')).toMatchObject({
      type: 'result',
      output: { policy: { nativePush: { available: false }, feedbackIntake: { available: false } } },
    });
  });

  it('link.off: off at once, signed; refusals carry their codes', async () => {
    m.manager.setLink('on');
    await m.runtime.link.refresh();
    expect(await op('link.off')).toMatchObject({ type: 'result', output: { link: { state: 'off' } } });
    expect((await events('link.off')).at(-1)?.payload).toEqual({
      byAccountId: mara.account?.id,
      state: 'off',
    });
    // Off means off: nothing goes to control, not even a `security` push.
    const sent = m.manager.pushes.length;
    await m.runtime.controlPush.security([mara.account?.id as string], 'test-off', {
      title: 'A new device',
      body: 'Someone added a device.',
      path: '/settings',
    });
    await m.runtime.controlPush.forAccounts([mara.account?.id as string], 'generic', 'test-off');
    expect(m.manager.pushes.length).toBe(sent);
    m.manager.linkFails = new ManagerCallError('/v1/link/on', 409, 'link.busy', 'busy');
    expect(await op('link.on')).toMatchObject({
      type: 'error',
      code: 'conflict',
      details: { code: 'whombat_link_busy' },
    });
    m.manager.linkFails = new ManagerCallError('/v1/link/on', 503, 'control_unreachable', 'down');
    expect(await op('link.on')).toMatchObject({ type: 'error', details: { code: 'control_unreachable' } });
    m.manager.linkFails = null;
  });

  it('link.off from a device on the relay: recorded and answered though turning it off closes that route', async () => {
    m.manager.setLink('on');
    await m.runtime.link.refresh();
    const before = (await events('link.off')).length;
    // Link stopping closes the relay, and with it this device's session, which cancels the request in flight.
    const control = new RequestControl(null);
    const stop = m.runtime.link.onChange((after) => {
      if (after.link.state === 'off') control.cancelled = true;
    });
    let answer: RequestAnswer | null = null;
    try {
      await m.runtime.dispatcher.handle(
        mara,
        { id: `req-link-${++requestNo}`, op: 'link.off', input: {} },
        { accepted: () => {}, result: (a) => (answer = a) },
        control,
      );
    } finally {
      stop();
    }
    expect(control.cancelled).toBe(true);
    expect(answer).toMatchObject({ type: 'result', output: { link: { state: 'off' } } });
    const off = await events('link.off');
    expect(off).toHaveLength(before + 1);
    expect(off.at(-1)).toEqual({
      actor: mara.account?.id,
      payload: { byAccountId: mara.account?.id, state: 'off' },
    });
  });

  it('push.token.clear: the handle goes at control and the token here', async () => {
    m.manager.setLink('on');
    await m.runtime.link.refresh();
    const [before] = await m.t.services.db
      .select({ handle: applianceEndpoints.pushTokenHandle })
      .from(applianceEndpoints)
      .where(eq(applianceEndpoints.id, maraEndpoint));
    expect(await op('push.token.clear')).toMatchObject({ type: 'result', output: { ok: true } });
    expect(m.manager.pushUnregistered).toContain(before?.handle);
    const [after] = await m.t.services.db
      .select({ handle: applianceEndpoints.pushTokenHandle, token: applianceEndpoints.pushToken })
      .from(applianceEndpoints)
      .where(eq(applianceEndpoints.id, maraEndpoint));
    expect(after).toEqual({ handle: null, token: null });
  });

  it('a late answer for a replaced token neither overwrites the new handle nor keeps its own', async () => {
    const OLD = { ...TOKEN, token: 'fcm-old-token' };
    const NEW = { ...TOKEN, token: 'fcm-new-token' };
    const manager = m.manager;
    const original = manager.pushRegister;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const atControl = new Promise<void>((resolve) => {
      reached = resolve;
    });
    // The first registration (the old token's) is answered only after the new token's finished.
    let first = true;
    manager.pushRegister = async (request) => {
      if (!first) return original.call(manager, request);
      first = false;
      const answer = await original.call(manager, request);
      reached();
      await gate;
      return answer;
    };
    try {
      const late = m.runtime.pushTokens.set(maraEndpoint, OLD);
      await atControl;
      const oldHandle = [...manager.pushHandles].find(([, t]) => t.token === OLD.token)?.[0];
      expect(oldHandle).toBeDefined();
      expect(await m.runtime.pushTokens.set(maraEndpoint, NEW)).toBe(true);
      release();
      expect(await late).toBe(false);
      const [row] = await m.t.services.db
        .select({ handle: applianceEndpoints.pushTokenHandle, token: applianceEndpoints.pushToken })
        .from(applianceEndpoints)
        .where(eq(applianceEndpoints.id, maraEndpoint));
      expect(row?.token).toEqual(NEW);
      expect(manager.pushHandles.get(row?.handle as string)).toEqual(NEW);
      // The old token's handle is released at control.
      expect(manager.pushUnregistered).toContain(oldHandle);
      expect(manager.pushHandles.has(oldHandle as string)).toBe(false);
    } finally {
      manager.pushRegister = original;
    }
  });

  it('the same token registered twice at once keeps its one handle at control', async () => {
    const SAME = { ...TOKEN, token: 'fcm-same-token' };
    const manager = m.manager;
    const original = manager.pushRegister;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const atControl = new Promise<void>((resolve) => {
      reached = resolve;
    });
    // The first registration is answered only after a second one of the same token stored its handle.
    let first = true;
    manager.pushRegister = async (request) => {
      if (!first) return original.call(manager, request);
      first = false;
      const answer = await original.call(manager, request);
      reached();
      await gate;
      return answer;
    };
    try {
      await m.runtime.pushTokens.clear(maraEndpoint);
      const late = m.runtime.pushTokens.set(maraEndpoint, SAME);
      await atControl;
      expect(await m.runtime.pushTokens.sync()).toBeUndefined();
      release();
      expect(await late).toBe(true);
      const [row] = await m.t.services.db
        .select({ handle: applianceEndpoints.pushTokenHandle })
        .from(applianceEndpoints)
        .where(eq(applianceEndpoints.id, maraEndpoint));
      expect(row?.handle).toBeTruthy();
      expect(manager.pushHandles.get(row?.handle as string)).toEqual(SAME);
      expect(manager.pushUnregistered).not.toContain(row?.handle);
    } finally {
      manager.pushRegister = original;
    }
  });
});

describe('the update channel', () => {
  it('reads it, and a switch to production says it stays on a newer release; signed by the owner', async () => {
    expect(await op('updates.channel.get')).toEqual(
      expect.objectContaining({ type: 'result', output: { channel: 'development' } }),
    );
    m.manager.staysOnAfterSwitch = 'whombat-dev-20261118.3';
    expect(await op('updates.channel.set', { channel: 'production' })).toMatchObject({
      type: 'result',
      output: { channel: 'production', staysOn: 'whombat-dev-20261118.3' },
    });
    expect((await events('update.channel_set')).at(-1)?.payload).toEqual({
      byAccountId: mara.account?.id,
      channel: 'production',
    });
  });

  it('a manager that can’t choose answers update_channel_unavailable', async () => {
    m.manager.channel = null;
    expect(await op('updates.channel.get')).toMatchObject({
      type: 'error',
      details: { code: 'update_channel_unavailable' },
    });
    expect(await op('updates.channel.set', { channel: 'development' })).toMatchObject({
      type: 'error',
      details: { code: 'update_channel_unavailable' },
    });
  });
});
