/**
 * Web search in fixture mode (Whombat web-search.md). Always served, so you can turn it on in any fixture world:
 * `burrows.setWebSearch` (checks the key first: Brave takes a key that starts with `BSA`, and turns any other away on
 * `apiKey`), `burrows.testWebSearch` and `burrows.clearWebSearch`, with the burrow's `webSearch` in the bootstrap,
 * `burrows.get` and every other answer that carries the burrow. `seeded` (`VITE_FIXTURE_WEB_SEARCH=1`, option
 * `webSearch`) starts with a key saved and checked 2 minutes before the mock world's moment. State lives in the closure,
 * built to the contracts' schemas.
 */
import type { Burrow } from '@whombat/core';
import { API_ENDPOINTS, matchPath, SetWebSearchBody } from '@whombat/core/contracts';
import type { WebSearchView } from '@whombat/core/domain';
import { WEB_SEARCH_COPY } from '@whombat/core/text';
import { burrow } from '@whombat/fixtures';

const API_BASE = '/api/v1';
/** The mock world's moment is 09:22 UTC on Wednesday 23 September 2026. */
const CHECKED = '2026-09-23T09:20:00.000Z';
const NOW = '2026-09-23T09:22:00.000Z';

export const FIXTURE_WEB_SEARCH: WebSearchView = {
  provider: 'brave',
  check: { state: 'ok', at: CHECKED, detail: null },
  updatedAt: '2026-09-21T15:04:00.000Z',
};

/** Brave's answer to a key: the ones this world plays start with `BSA`. */
function accepted(apiKey: string): boolean {
  return apiKey.startsWith('BSA');
}

export interface WebSearchFixtures {
  handle(req: Request, inner: (r: Request) => Promise<Response>): Promise<Response | null>;
  decorate(req: Request, response: Response): Promise<Response>;
}

export function createWebSearchFixtures({ seeded = false }: { seeded?: boolean } = {}): WebSearchFixtures {
  let view: WebSearchView | null = seeded ? { ...FIXTURE_WEB_SEARCH } : null;
  let seq = 0;

  const match = (req: Request) => {
    const url = new URL(req.url, 'http://fixtures.local');
    const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : url.pathname;
    for (const ep of API_ENDPOINTS) {
      if (ep.method !== req.method) continue;
      const params = matchPath(ep.path, path);
      if (params && params.burrow === burrow.slug) return { id: ep.id, params };
    }
    return null;
  };

  /** The burrow as it is now, from the layers under this one. */
  const burrowNow = async (inner: (r: Request) => Promise<Response>): Promise<Burrow> => {
    const boot = await inner(
      new Request(new URL(`${API_BASE}/burrows/${burrow.slug}/bootstrap`, 'http://fixtures.local')),
    );
    const data = (await boot.json()) as { burrow: Burrow };
    return { ...data.burrow, webSearch: view };
  };

  const invalid = (fields: Record<string, string[]>) =>
    json({ error: { code: 'validation_failed', message: 'Check the fields.', fields } }, 422);

  return {
    async handle(req, inner) {
      const m = match(req);
      if (!m) return null;
      switch (m.id) {
        case 'burrows.setWebSearch': {
          const parsed = SetWebSearchBody.safeParse(await req.clone().json());
          if (!parsed.success) return invalid({ apiKey: parsed.error.issues.map((issue) => issue.message) });
          if (!accepted(parsed.data.apiKey)) return invalid({ apiKey: [WEB_SEARCH_COPY.invalidKey] });
          view = {
            provider: 'brave',
            check: { state: 'ok', at: NOW, detail: null },
            updatedAt: NOW,
          };
          return json({ burrow: await burrowNow(inner), webSearch: view, eventId: `evt_web_${++seq}` });
        }
        case 'burrows.testWebSearch': {
          if (!view) return json({ error: { code: 'not_found', message: 'Web search is off.' } }, 404);
          view = { ...view, check: { state: 'ok', at: NOW, detail: null } };
          return json({ check: view.check });
        }
        case 'burrows.clearWebSearch': {
          const removed = !!view;
          view = null;
          return json({
            burrow: await burrowNow(inner),
            removed,
            eventId: removed ? `evt_web_${++seq}` : null,
          });
        }
        default:
          return null;
      }
    },

    async decorate(req, response) {
      if (!response.ok) return response;
      if (!match(req)) return response;
      // Every answer that carries the burrow (the bootstrap, `burrows.get`, the other burrow switches) has it.
      if (!response.headers.get('content-type')?.includes('application/json')) return response;
      const data = (await response.clone().json()) as { burrow?: Burrow };
      if (data?.burrow?.id !== burrow.id) return response;
      return json({ ...data, burrow: { ...data.burrow, webSearch: view } }, response.status);
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
