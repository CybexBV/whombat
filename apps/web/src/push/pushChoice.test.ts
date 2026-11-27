import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedWebPush } from '../managed/webPush';
import { PUSH_CHOICE_KEY, pushStart, readPushChoice, writePushChoice } from './pushChoice';
import { webPushController } from './useWebPush';

describe('whether this browser turns notifications on by itself', () => {
  const base = { supported: true, registered: false, offHere: false, answered: false } as const;

  it('subscribes where the browser already allows them, offers once where it never asked, else leaves them be', () => {
    expect(pushStart({ ...base, permission: 'granted' })).toBe('subscribe');
    expect(pushStart({ ...base, permission: 'default' })).toBe('offer');
    expect(pushStart({ ...base, permission: 'denied' })).toBe('none');
  });

  it('never where they can’t work, are on already, were turned off here, or the person answered', () => {
    for (const permission of ['granted', 'default', 'denied'] as const) {
      expect(pushStart({ ...base, permission, supported: false })).toBe('none');
      expect(pushStart({ ...base, permission, registered: true })).toBe('none');
      expect(pushStart({ ...base, permission, offHere: true })).toBe('none');
    }
    // Answering the Chat's question ends the offer; a browser that allows them still subscribes.
    expect(pushStart({ ...base, permission: 'default', answered: true })).toBe('none');
    expect(pushStart({ ...base, permission: 'granted', answered: true })).toBe('subscribe');
  });

  it('keeps what the person said in this browser, and reads nothing said where storage fails', () => {
    const kept = new Map<string, string>();
    const storage = {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
    };
    expect(readPushChoice(storage)).toEqual({ off: false, answered: false });
    writePushChoice({ answered: true }, storage);
    writePushChoice({ off: true }, storage);
    expect(readPushChoice(storage)).toEqual({ off: true, answered: true });
    expect(JSON.parse(kept.get(PUSH_CHOICE_KEY) ?? '{}')).toEqual({ off: true, answered: true });
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readPushChoice(broken)).toEqual({ off: false, answered: false });
    expect(() => writePushChoice({ off: true }, broken)).not.toThrow();
  });
});

/** A browser with Push: no registration yet, the permission as given, and what subscribing asked. */
function browser(permission: NotificationPermission) {
  const requestPermission = vi.fn(async () => {
    fake.permission = 'granted';
    return 'granted' as const;
  });
  const fake: { permission: NotificationPermission; requestPermission: typeof requestPermission } = {
    permission,
    requestPermission,
  };
  const subscribe = vi.fn(async () => ({
    endpoint: 'https://push.example/abc',
    unsubscribe: async () => true,
    toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }),
  }));
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: async () => ({ pushManager: { subscribe } }),
      getRegistration: async () => undefined,
    },
  });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', fake);
  return { requestPermission, subscribe };
}

function fakePush(registered = false) {
  return {
    vapidKey: async () =>
      'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    registered: async () => registered,
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
  } satisfies ManagedWebPush;
}

/** Until the controller's look at this browser is done. */
async function settled(controller: ReturnType<typeof webPushController>) {
  await vi.waitFor(() => expect(['unknown', 'busy']).not.toContain(controller.get().status));
}

describe('this browser’s notifications, one state per Whombat', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    localStorage.clear();
  });

  it('subscribes by itself where the browser already allows it, without asking', async () => {
    const b = browser('granted');
    const push = fakePush();
    const controller = webPushController(push);
    controller.start();
    controller.start();
    await settled(controller);
    expect(controller.get()).toEqual({ status: 'on', offer: false });
    expect(push.enable).toHaveBeenCalledTimes(1);
    expect(b.requestPermission).not.toHaveBeenCalled();
  });

  it('stays off where the person turned it off here, and Off is remembered', async () => {
    browser('granted');
    const push = fakePush(true);
    const controller = webPushController(push);
    controller.start();
    await settled(controller);
    expect(controller.get().status).toBe('on');
    await controller.disable();
    expect(push.disable).toHaveBeenCalled();
    expect(readPushChoice()).toMatchObject({ off: true });

    const later = fakePush();
    const next = webPushController(later);
    next.start();
    await settled(next);
    expect(next.get()).toEqual({ status: 'off', offer: false });
    expect(later.enable).not.toHaveBeenCalled();
  });

  it('offers once where the browser never asked: Turn on asks it first, Not now is remembered', async () => {
    const b = browser('default');
    const controller = webPushController(fakePush());
    controller.start();
    await settled(controller);
    expect(controller.get()).toEqual({ status: 'off', offer: true });
    await controller.enable();
    expect(b.requestPermission).toHaveBeenCalledTimes(1);
    expect(controller.get()).toEqual({ status: 'on', offer: false });

    localStorage.clear();
    browser('default');
    const other = webPushController(fakePush());
    other.start();
    await settled(other);
    other.dismiss();
    expect(other.get().offer).toBe(false);
    const again = webPushController(fakePush());
    again.start();
    await settled(again);
    expect(again.get()).toEqual({ status: 'off', offer: false });
  });
});
