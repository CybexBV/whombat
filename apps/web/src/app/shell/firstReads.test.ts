import { QueryClient } from '@tanstack/react-query';
import { chatRoomsOf, type Realtime } from '@whombat/client';
import { api } from '@whombat/core/contracts';
import { describe, expect, it, vi } from 'vitest';
import { mockedServices } from '../../test/renderApp';
import { createWebFixtureFetch, type WebFixtureOptions } from '../fixtureFetch';
import { firstRoom, warmBurrow } from './firstReads';

/** A burrow's first reads go out together (open-speed.md AP-4404). */

/** The fixture world; `failing` answers a path ending so with a server error, `retry` is the cache's default. */
function world(
  options: WebFixtureOptions = {},
  { failing, retry }: { failing?: string; retry?: number } = {},
) {
  const fixture = createWebFixtureFetch({ ...options });
  const asked: string[] = [];
  // What reaches the box, in order: reads, and subscriptions, which (as the session's realtime) wait for `connect`.
  const wire: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req =
      input instanceof Request ? input : new Request(new URL(String(input), 'http://whombat.test'), init);
    const path = new URL(req.url).pathname.replace('/api/v1', '');
    if (req.method === 'GET') asked.push(path);
    wire.push(`${req.method} ${path}`);
    if (failing && path.endsWith(failing))
      return Response.json({ error: { code: 'internal', message: 'down' } }, { status: 500 });
    return fixture(req);
  });
  const subscribed: string[] = [];
  let connected = false;
  const realtime = {
    connect: () => {
      if (!connected) wire.push(...subscribed.map((t) => `subscribe ${t}`));
      connected = true;
    },
    subscribe: (topics: string | readonly string[]) => {
      const list = typeof topics === 'string' ? [topics] : topics;
      subscribed.push(...list);
      if (connected) wire.push(...list.map((t) => `subscribe ${t}`));
      return () => undefined;
    },
  } as unknown as Realtime;
  const services = mockedServices(fetch as typeof globalThis.fetch, {
    realtime,
    ...(retry === undefined
      ? {}
      : { queryClient: new QueryClient({ defaultOptions: { queries: { retry, retryDelay: 0 } } }) }),
  });
  services.session.connect();
  return { services, asked, subscribed, wire };
}

async function burrowOf(services: ReturnType<typeof world>['services']): Promise<string> {
  const me = await services.queryClient.fetchQuery(services.queries.me.get());
  const slug = me.memberships[0]?.burrowSlug;
  if (!slug) throw new Error('no burrow in the fixture world');
  return slug;
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('warmBurrow', () => {
  it('asks the bootstrap, the sidebar’s reads and Chat’s rooms, then the room’s conversation and messages', async () => {
    const { services, asked, subscribed } = world();
    const burrow = await burrowOf(services);
    asked.length = 0;
    warmBurrow(services, burrow, '/');
    await vi.waitFor(() => expect(asked.some((p) => p.includes('/messages'))).toBe(true));
    const base = `/burrows/${burrow}`;
    expect(asked).toEqual(
      expect.arrayContaining([
        `${base}/bootstrap`,
        `${base}/home`,
        `${base}/hosts/status`,
        `${base}/chats`,
        `${base}/chats/threads`,
      ]),
    );
    // The open room: Chat's conversation and its newest messages, with its live updates asked first.
    const list = await services.queryClient.fetchQuery(
      services.queries.chats.list({ params: { burrow }, query: {} }),
    );
    const chat = chatRoomsOf(list.chats).chat;
    expect(chat).toBeDefined();
    expect(asked).toEqual(expect.arrayContaining([`${base}/conversations/${chat?.id}`]));
    expect(subscribed).toContain(`conv:${chat?.id}`);
    expect(asked).not.toContain(`${base}/automations`);
  });

  it('has the room’s live updates on the way before it asks the room’s history', async () => {
    const { services, wire } = world();
    const burrow = await burrowOf(services);
    warmBurrow(services, burrow, '/chat');
    await vi.waitFor(() => expect(wire.some((p) => p.includes('/messages'))).toBe(true));
    const subscription = wire.findIndex((p) => p.startsWith('subscribe conv:'));
    expect(subscription).toBeGreaterThanOrEqual(0);
    expect(subscription).toBeLessThan(wire.findIndex((p) => p.includes('/messages')));
  });

  it('asks the sidebar’s reads once, without retries, as the shell does', async () => {
    const { services, asked } = world({}, { failing: '/hosts/status', retry: 1 });
    const burrow = await burrowOf(services);
    warmBurrow(services, burrow, '/settings');
    const status = services.queries.endpoint(api.hosts.status, { params: { burrow } }).queryKey;
    await vi.waitFor(() => expect(services.queryClient.getQueryState(status)?.status).toBe('error'));
    expect(asked.filter((p) => p.endsWith('/hosts/status'))).toHaveLength(1);
  });

  it('asks only once per burrow', async () => {
    const { services, asked } = world();
    const burrow = await burrowOf(services);
    warmBurrow(services, burrow, '/');
    await vi.waitFor(() => expect(asked.some((p) => p.includes('/messages'))).toBe(true));
    await settle();
    const count = asked.length;
    warmBurrow(services, burrow, '/chat');
    await settle();
    expect(asked.length).toBe(count);
  });

  it('opens no room for a page that isn’t one', async () => {
    const { services, asked } = world();
    const burrow = await burrowOf(services);
    warmBurrow(services, burrow, '/settings');
    await vi.waitFor(() => expect(asked.some((p) => p.endsWith('/chats'))).toBe(true));
    await settle();
    expect(asked.some((p) => p.includes('/messages') || p.includes('/conversations/'))).toBe(false);
  });
});

describe('firstRoom', () => {
  it('is Chat for / and /chat, Feedback for /feedback, none elsewhere', () => {
    expect(firstRoom('/')).toBe('chat');
    expect(firstRoom('/chat')).toBe('chat');
    expect(firstRoom('/feedback')).toBe('feedback');
    expect(firstRoom('/settings')).toBeNull();
  });
});
