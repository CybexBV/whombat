import { forgetAppliance } from '@whombat/client/managed';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localPushStore } from './webPush';

describe('the saved push registration when local storage can’t be reached (AP-594)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads as none and forgetting a Whombat still finishes', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    const store = localPushStore();
    await expect(store.get()).resolves.toBeNull();
    await expect(forgetAppliance(store, 'dev_1')).resolves.toBeUndefined();
  });

  it('a registration that can’t be saved is refused, not pretended', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    const store = localPushStore();
    await expect(
      store.set({
        platform: 'webpush',
        address: 'https://push.example/1',
        handle: 'h'.repeat(22),
        appliances: [],
      }),
    ).rejects.toThrow();
    await expect(store.get()).resolves.toBeNull();
  });
});
