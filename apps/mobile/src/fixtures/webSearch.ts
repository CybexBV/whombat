/**
 * Web search in the demo world (Whombat web-search.md): with `webSearch` on (`EXPO_PUBLIC_WHOMBAT_WEB_SEARCH=1`) Lumio
 * has a Brave Search key, checked fine a quarter of an hour before the world's moment; off, none. Serves
 * `burrows.setWebSearch`, `burrows.testWebSearch` and `burrows.clearWebSearch` as the server does: Save checks the key
 * with one search first and keeps nothing when Brave turns it away (`validation_failed` on `apiKey`), Check again
 * keeps its result, the burrow goes out as `burrow.updated`. Brave's keys start with `BSA`; any other is turned away.
 * Pure TypeScript.
 */
import {
  type Burrow,
  type RealtimeEvent,
  WEB_SEARCH_COPY,
  type WebSearchCheck,
  type WebSearchView,
} from '@whombat/core';
import type { SetWebSearchBody } from '@whombat/core/contracts';
import { BURROW_ID, burrow as fixtureBurrow } from '@whombat/fixtures';

/** The seeded key's view: checked fine a quarter of an hour before the world's moment. */
export function braveWebSearch(now: Date): WebSearchView {
  const at = new Date(now.getTime() - 15 * 60_000).toISOString();
  return { provider: 'brave', check: { state: 'ok', at, detail: null }, updatedAt: at };
}

/** What Brave makes of a key: one of its own (`BSA…`), else turned away. */
export function braveAccepts(apiKey: string): boolean {
  return apiKey.trim().startsWith('BSA');
}

export interface WebSearchFixtureOptions {
  now: () => Date;
  emit: (topic: string, event: RealtimeEvent) => void;
  /** Start with a Brave Search key. */
  on: boolean;
  /** The burrow as the rest of this world has it (its model on the network); web search goes on top. */
  burrow?: () => Burrow;
}

export function createWebSearchFixtures(options: WebSearchFixtureOptions) {
  const { now, emit } = options;
  let view: WebSearchView | null = options.on ? braveWebSearch(now()) : null;
  let seq = 0;

  const burrowNow = (): Burrow => ({
    ...(options.burrow?.() ?? { ...fixtureBurrow, name: 'Lumio' }),
    webSearch: view,
  });
  const publish = () => emit(`burrow:${BURROW_ID}`, { type: 'burrow.updated', burrow: burrowNow() });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const bodyOf = <T>(init: RequestInit | undefined): T => JSON.parse(String(init?.body ?? '{}')) as T;
  const fine = (): WebSearchCheck => ({ state: 'ok', at: now().toISOString(), detail: null });

  return {
    view: () => view,
    /** A burrow read by anyone (the bootstrap, `burrows.get`), with web search as it is now. */
    burrow<B extends { webSearch?: WebSearchView | null }>(b: B): B {
      return { ...b, webSearch: view };
    },
    handle(id: string | undefined, init: RequestInit | undefined): Response | null {
      switch (id) {
        case 'burrows.setWebSearch': {
          const body = bodyOf<SetWebSearchBody>(init);
          if (!braveAccepts(body.apiKey)) {
            const message = WEB_SEARCH_COPY.invalidKey;
            return json(
              { error: { code: 'validation_failed', message, fields: { apiKey: [message] } } },
              400,
            );
          }
          const at = now().toISOString();
          view = { provider: 'brave', check: fine(), updatedAt: at };
          publish();
          return json({ burrow: burrowNow(), webSearch: view, eventId: `evt_web-search-${++seq}` });
        }
        case 'burrows.testWebSearch': {
          if (!view) return json({ error: { code: 'not_found', message: 'Web search is off.' } }, 404);
          view = { ...view, check: fine() };
          publish();
          return json({ check: view.check });
        }
        case 'burrows.clearWebSearch': {
          const removed = view !== null;
          view = null;
          if (removed) publish();
          return json({ burrow: burrowNow(), removed, eventId: removed ? `evt_web-search-${++seq}` : null });
        }
        default:
          return null;
      }
    },
  };
}
