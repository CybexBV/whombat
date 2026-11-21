import { afterEach, describe, expect, it, vi } from 'vitest';
import { realEnvironment } from './connect';

describe('the real environment when local storage can’t be reached (AP-594)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('still starts (no blank page), and reads no token: signed out', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    const fetch = vi.spyOn(globalThis, 'fetch');
    const env = realEnvironment('http://control.test');
    await expect(env.control.session()).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
