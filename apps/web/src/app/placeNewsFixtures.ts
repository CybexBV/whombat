/**
 * Where this Whombat is and the news it reads, in fixture mode (Whombat weather-news.md; app weather-news-apps.md):
 * `place.find`, `place.set`, `news.sources`, `news.setSources` and `news.addSite` from `@whombat/client/weather-news/fake`,
 * kept in memory, with the burrow's `place` in the bootstrap, `burrows.get` and every other answer that carries the
 * burrow. It starts with the time zone's guess (Amsterdam) and AT5 on, so Settings → This Whombat shows a site that is on
 * and NOS suggested; looking up “Eindhoven” finds Noord-Brabant and Omroep Brabant.
 */
import { createFakePlaceNews, PLACE_NEWS_OPS } from '@whombat/client/weather-news/fake';
import { type Burrow, placeFromTimeZone } from '@whombat/core';
import { API_ENDPOINTS, matchPath } from '@whombat/core/contracts';
import { burrow } from '@whombat/fixtures';

const API_BASE = '/api/v1';
const OPS: ReadonlySet<string> = new Set(PLACE_NEWS_OPS);

export interface PlaceNewsFixtures {
  handle(req: Request, inner: (r: Request) => Promise<Response>): Promise<Response | null>;
  decorate(req: Request, response: Response): Promise<Response>;
}

export function createPlaceNewsFixtures(): PlaceNewsFixtures {
  const fake = createFakePlaceNews({ guess: placeFromTimeZone(burrow.timeZone) });

  const match = (req: Request) => {
    const url = new URL(req.url, 'http://fixtures.local');
    const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : url.pathname;
    for (const ep of API_ENDPOINTS) {
      if (ep.method !== req.method) continue;
      const params = matchPath(ep.path, path);
      if (params && params.burrow === burrow.slug) return { id: ep.id, url };
    }
    return null;
  };

  /** The burrow as it is now, from the layers under this one. */
  const burrowNow = async (inner: (r: Request) => Promise<Response>): Promise<Burrow> => {
    const boot = await inner(
      new Request(new URL(`${API_BASE}/burrows/${burrow.slug}/bootstrap`, 'http://fixtures.local')),
    );
    const data = (await boot.json()) as { burrow: Burrow };
    return { ...data.burrow, place: fake.place() };
  };

  return {
    async handle(req, inner) {
      const m = match(req);
      if (!m || !OPS.has(m.id)) return null;
      const body = req.method === 'GET' ? undefined : await req.clone().json();
      const answer = fake.call(m.id, { query: Object.fromEntries(m.url.searchParams), body });
      if (!answer) return null;
      if (m.id === 'place.set' && answer.status === 200) return json({ burrow: await burrowNow(inner) });
      return json(answer.body, answer.status);
    },

    async decorate(req, response) {
      if (!response.ok || !match(req)) return response;
      if (!response.headers.get('content-type')?.includes('application/json')) return response;
      const data = (await response.clone().json()) as { burrow?: Burrow };
      if (data?.burrow?.id !== burrow.id) return response;
      return json({ ...data, burrow: { ...data.burrow, place: fake.place() } }, response.status);
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
