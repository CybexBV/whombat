import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedConnector, type SecureChannelPort } from '../session/connector';
import { createHttpControl } from './control';
import { controlTickets } from './retired';

afterEach(() => vi.useRealTimers());

describe('bounded relay admission over HTTP', () => {
  for (const stuck of ['headers', 'body', 'directory'] as const)
    it(`cancels admission when the ${stuck} never answer`, async () => {
      vi.useFakeTimers();
      const requests: { url: string; init?: RequestInit }[] = [];
      const control = createHttpControl('https://control.test', {
        tokens: { get: () => 'test-token', set: () => {}, remove: () => {} },
        fetch: async (url, init) => {
          requests.push({ url, init });
          if (stuck === 'directory' && requests.length === 1)
            return new Response(
              JSON.stringify({ error: { code: 'not_found', details: { code: 'device_not_found' } } }),
              { status: 404 },
            );
          if (stuck === 'body') return { ok: true, text: () => new Promise<string>(() => {}) } as Response;
          return new Promise<Response>(() => {});
        },
      });
      const socket = vi.fn();
      const connector = createManagedConnector({
        tickets: controlTickets(control, { orgId: 'org_test', device: 'wb-test' }),
        secure: {} as SecureChannelPort<string>,
        identity: async () => 'test-identity',
        appliance: { peerId: 'test-pin' },
        channel: 'app',
        ticketTimeoutMs: 100,
        socket,
      });
      const pending = connector.connect({ class: 'interactive', signal: new AbortController().signal });
      const rejected = expect(pending).rejects.toMatchObject({ reason: 'offline' });
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(requests).toHaveLength(stuck === 'directory' ? 2 : 1);
      expect(requests.every((r) => r.init?.signal?.aborted)).toBe(true);
      expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
        device: 'wb-test',
        channel: 'app',
        class: 'interactive',
      });
      expect(socket).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
});
