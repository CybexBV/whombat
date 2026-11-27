import { createFakeAppliance } from '@whombat/client/fake';
import type { PushRegistration, PushStore, SavedPush } from '@whombat/client/managed';
import { createSecureSession } from '@whombat/client/session';
import { describe, expect, it } from 'vitest';
import { parsePushTapUrl, pushTapUrl, urlFromPushData } from '../navigation/routes';
import { createPushTaps } from './context';
import { type NativePush, registerManagedPush, savedPushState } from './push';
import { notificationsView } from './pushView';
import { preloadedStorage, type TextFile } from './stores';

function memoryPushStore(): PushStore & { value: SavedPush | null } {
  const s = {
    value: null as SavedPush | null,
    get: async () => s.value,
    set: async (v: SavedPush) => {
      s.value = v;
    },
    remove: async () => {
      s.value = null;
    },
  };
  return s;
}

function fakeSession(ops: string[]) {
  const appliance = createFakeAppliance({
    handle: async (op) => {
      ops.push(op);
      return { status: 200, body: { ok: true } };
    },
  });
  return createSecureSession({ connector: appliance.connector });
}

const native = (over: Partial<NativePush> = {}): NativePush => ({
  platform: 'fcm',
  appId: 'com.whombat.mobile',
  permission: async () => 'granted',
  token: async () => 'fcm-token-0123456789abcdef',
  ...over,
});

describe('managed push on the phone', () => {
  const control = (registered: PushRegistration[]) => ({
    pushRegister: async (r: PushRegistration) => {
      registered.push(r);
      return { handle: 'handle_0123456789abcdefghij' };
    },
    pushUnregister: async () => {},
  });

  it('registers the FCM token with control and gives the appliance the handle', async () => {
    const ops: string[] = [];
    const registered: PushRegistration[] = [];
    const store = memoryPushStore();
    const session = fakeSession(ops);
    const state = await registerManagedPush({
      native: native(),
      control: control(registered),
      store,
      session,
      device: 'wb-1',
      ask: 'ask',
    });
    expect(state).toEqual({ status: 'registered', handle: 'handle_0123456789abcdefghij' });
    expect(registered).toEqual([
      { platform: 'fcm', token: 'fcm-token-0123456789abcdef', appId: 'com.whombat.mobile' },
    ]);
    expect(ops).toEqual(['push.handles.set']);
    expect(await savedPushState(store, 'wb-1')).toMatchObject({ status: 'registered' });
    expect(await savedPushState(store, 'wb-2')).toEqual({ status: 'off' });
    session.close();
  });

  it('keeps denial, an undecided permission and a missing push service apart — nothing is sent', async () => {
    const ops: string[] = [];
    const registered: PushRegistration[] = [];
    const session = fakeSession(ops);
    const base = { control: control(registered), store: memoryPushStore(), session, device: 'wb-1' };
    expect(
      await registerManagedPush({
        ...base,
        native: native({ permission: async () => 'denied' }),
        ask: 'ask',
      }),
    ).toEqual({ status: 'denied' });
    expect(
      await registerManagedPush({
        ...base,
        native: native({ permission: async () => 'undetermined' }),
        ask: 'look',
      }),
    ).toEqual({ status: 'off' });
    expect(
      await registerManagedPush({
        ...base,
        native: native({
          token: async () => {
            throw new Error('no Firebase');
          },
        }),
        ask: 'ask',
      }),
    ).toEqual({ status: 'unavailable', reason: 'no Firebase' });
    expect(registered).toEqual([]);
    expect(ops).toEqual([]);
    session.close();
  });

  it('says what each push state means, with the last delivery apart from the session', () => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    expect(
      notificationsView({ state: { status: 'registered', handle: 'h' }, lastReceivedAt: now - 300_000 }, now),
    ).toMatchObject({
      dot: 'ok',
      title: 'On',
    });
    expect(
      notificationsView({ state: { status: 'registered', handle: 'h' }, lastReceivedAt: now - 300_000 }, now)
        .meta,
    ).toContain('Last one 5 minutes ago');
    expect(notificationsView({ state: { status: 'denied' }, lastReceivedAt: null })).toMatchObject({
      title: 'Not allowed',
      action: 'settings',
    });
    expect(notificationsView({ state: { status: 'off' }, lastReceivedAt: null }).action).toBe('enable');
  });
});

describe('notification taps', () => {
  it('parses the content-free tap and refuses anything else', () => {
    const url = pushTapUrl({ kind: 'approval', ref: 'AbCdEfGhIjKlMnOpQrStUv' });
    expect(url).toBe('whombat://push?kind=approval&ref=AbCdEfGhIjKlMnOpQrStUv');
    expect(parsePushTapUrl(url)).toEqual({ kind: 'approval', ref: 'AbCdEfGhIjKlMnOpQrStUv' });
    expect(parsePushTapUrl('whombat://push?kind=approval&ref=short')).toBeNull();
    expect(parsePushTapUrl('whombat://push?kind=APPROVAL<script>&ref=AbCdEfGhIjKlMnOpQrStUv')).toBeNull();
    expect(parsePushTapUrl('whombat://approvals/12')).toBeNull();
  });

  it('reads an iOS managed push (`w: {kind, ref}`)', () => {
    expect(urlFromPushData({ w: { kind: 'mention', ref: 'AbCdEfGhIjKlMnOpQrStUv' } })).toBe(
      'whombat://push?kind=mention&ref=AbCdEfGhIjKlMnOpQrStUv',
    );
  });

  it('holds a tap until the app listens, then hands each new one over', () => {
    const taps = createPushTaps();
    const tap = { kind: 'run', ref: 'AbCdEfGhIjKlMnOpQrStUv' };
    taps.push(tap);
    expect(taps.take()).toEqual(tap);
    expect(taps.take()).toBeNull();
    const seen: unknown[] = [];
    const off = taps.subscribe((t) => seen.push(t));
    taps.push(tap);
    off();
    expect(seen).toEqual([tap]);
    expect(taps.take()).toBeNull();
  });
});

describe('the appliance registry file', () => {
  it('is read once, written on every change and removed on clear', () => {
    let text: string | null = JSON.stringify({ a: '1' });
    const file: TextFile = {
      read: () => text,
      write: (t) => {
        text = t;
      },
      remove: () => {
        text = null;
      },
    };
    const storage = preloadedStorage(file);
    expect(storage.getItem('a')).toBe('1');
    storage.setItem('b', '2');
    expect(JSON.parse(text ?? '{}')).toEqual({ a: '1', b: '2' });
    storage.removeItem('a');
    expect(storage.getItem('a')).toBeNull();
    storage.clear();
    expect(text).toBeNull();
    expect(
      preloadedStorage({ read: () => 'not json', write: () => {}, remove: () => {} }).getItem('x'),
    ).toBeNull();
  });
});
