import { afterEach, describe, expect, it, vi } from 'vitest';
import { getExistingSubscription, isPushSupported } from './webPush';

/** A minimal fake `PushSubscription` — jsdom implements neither Service Worker nor Push. */
function fakeSubscription(overrides: Partial<{ endpoint: string; p256dh: string; auth: string }> = {}) {
  const endpoint = overrides.endpoint ?? 'https://push.example/abc123';
  const p256dh = overrides.p256dh ?? 'p256dh-key';
  const auth = overrides.auth ?? 'auth-secret';
  return {
    endpoint,
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ endpoint, keys: { p256dh, auth } }),
  } as unknown as PushSubscription;
}

describe('isPushSupported', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is false when the browser has no PushManager (e.g. Safari desktop without a manifest)', () => {
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: {} });
    // `PushManager` deliberately left off `window`.
    expect(isPushSupported()).toBe(false);
  });
});

describe('registerServiceWorker / getExistingSubscription', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null without registering when push is unsupported', async () => {
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: undefined });
    expect(await getExistingSubscription()).toBeNull();
  });

  it('returns null when no registration exists yet (quiet opt-in, no prompt)', async () => {
    const getRegistration = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: { getRegistration } });
    vi.stubGlobal('PushManager', class {});
    expect(await getExistingSubscription()).toBeNull();
    expect(getRegistration).toHaveBeenCalledWith('/sw.js');
  });

  it('returns the existing subscription from the registration, without prompting', async () => {
    const sub = fakeSubscription();
    const getSubscription = vi.fn(async () => sub);
    const getRegistration = vi.fn(async () => ({ pushManager: { getSubscription } }));
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: { getRegistration } });
    vi.stubGlobal('PushManager', class {});
    expect(await getExistingSubscription()).toBe(sub);
  });
});
