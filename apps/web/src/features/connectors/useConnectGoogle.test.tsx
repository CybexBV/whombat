import { act, renderHook } from '@testing-library/react';
import { GOOGLE_CONNECT_KEY } from '@whombat/client/managed';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Providers } from '../../app/providers';
import type { AppServices } from '../../app/services';
import { mockedServices } from '../../test/renderApp';
import { useConnectGoogle } from './useConnectGoogle';

/** A managed Whombat's services whose server answers nothing useful: only whether it was asked counts here. */
function managedHarness() {
  const fetch = vi.fn(
    async () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }),
  );
  const services: AppServices = {
    ...mockedServices(fetch as unknown as typeof globalThis.fetch),
    managed: { applianceId: 'dev_1' } as NonNullable<AppServices['managed']>,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Providers services={services}>{children}</Providers>
  );
  return { fetch, wrapper };
}

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}

describe('connecting Google on a managed Whombat (AG-14, AP-592)', () => {
  it('holds which Whombat started it before asking for the consent URL', async () => {
    const { fetch, wrapper } = managedHarness();
    const storage = memoryStorage();
    const navigate = vi.fn();
    const { result } = renderHook(() => useConnectGoogle('hq', navigate, { storage }), { wrapper });
    await act(() => result.current.connect(['mail']));
    expect(JSON.parse(storage.raw.get(GOOGLE_CONNECT_KEY) ?? 'null')).toMatchObject({
      value: { device: 'dev_1' },
    });
    expect(fetch).toHaveBeenCalled();
  });

  it('doesn’t start when this tab can’t hold which Whombat started it', async () => {
    const { fetch, wrapper } = managedHarness();
    const storage = {
      ...memoryStorage(),
      setItem: () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      },
    };
    const navigate = vi.fn();
    const { result } = renderHook(() => useConnectGoogle('hq', navigate, { storage }), { wrapper });
    await act(() => result.current.connect(['mail']));
    expect(fetch).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(result.current.problem).toBe('Couldn’t start connecting Google. Try again in a moment.');
  });
});
