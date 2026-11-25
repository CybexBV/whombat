/**
 * The monitoring fixture world shows only outages the product can make: an incident opens while a thing's dot is red
 * (`problem`) or it doesn't answer (`down`), never for a warning (running warm, a disk filling up, an access point
 * offline), so an incident still going is on a thing whose dot is red or grey now, or that is kept quiet.
 */
import { type AnyEndpoint, api } from '@whombat/core/contracts';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { createWebFixtureFetch } from './fixtureFetch';

const B = `/api/v1/burrows/${burrow.slug}`;

async function call<E extends AnyEndpoint>(fetch: typeof globalThis.fetch, ep: E, path: string) {
  const res = await fetch(`http://fixtures.local${B}${path}`);
  expect(res.status, path).toBe(200);
  return ep.response.parse(await res.json()) as ReturnType<E['response']['parse']>;
}

/** What only a warning says: these never open an incident. */
const WARNING_WORDS = /\bwarm\b|running hot$|filling up|access point is offline|\bAP is offline/i;

describe('what happened in the fixture world', () => {
  it('lists only outages the product can make: red dots and things not answering', async () => {
    const fetch = createWebFixtureFetch({ hosts: true, connectors: 'connected', monitoring: true });
    const home = await call(fetch, api.home.overview, '/home');
    const seen: string[] = [];
    for (const thing of home.things) {
      const history = await call(
        fetch,
        api.things.history,
        `/things/${encodeURIComponent(thing.id)}/history?days=90`,
      );
      for (const i of history.incidents) {
        seen.push(i.words);
        expect(i.words, `${thing.id}: ${i.words}`).not.toMatch(WARNING_WORDS);
        // Still going: its dot is red now, or grey because it doesn't answer, unless it is kept quiet (its lines colour
        // nothing then, and what started before the window goes on).
        if (i.endedAt === null && !thing.quietUntil)
          expect(['bad', 'offline', 'unknown'], `${thing.id} is ${thing.status}`).toContain(thing.status);
      }
    }
    expect(seen.length).toBeGreaterThan(0);
  });
});
