/**
 * Kept sites in fixture mode (Whombat kept-sites.md): the list under what the assistant can sign in to, and stopping
 * one, over the real REST contract and kept in memory. One site is kept from the start.
 */
import type { KeptSite } from '@whombat/core';
import { burrow } from '@whombat/fixtures';
import { WHOMBAT_ID } from './oneFixtures';

const B = `/api/v1/burrows/${burrow.slug}`;
const HOUR = 3600_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The site kept from the start of the fixture world. */
export const FIXTURE_KEPT_SITE = 'accounts.hetzner.com';

export function createKeptSiteFixtures(options: { seeded?: boolean } = {}) {
  const now = Date.now();
  const sites: KeptSite[] =
    options.seeded === false
      ? []
      : [
          {
            id: 'kst_fixturehetzner' as KeptSite['id'],
            site: FIXTURE_KEPT_SITE,
            origins: ['https://accounts.hetzner.com', 'https://konsoleh.hetzner.com'],
            agentId: WHOMBAT_ID as KeptSite['agentId'],
            hours: 4,
            keptAt: new Date(now - HOUR).toISOString(),
            lastUsedAt: new Date(now - HOUR).toISOString(),
            expiresAt: new Date(now + 3 * HOUR).toISOString(),
          },
        ];

  async function handle(req: Request): Promise<Response | null> {
    const path = new URL(req.url, 'http://fixtures.local').pathname;
    if (!path.startsWith(`${B}/kept-sites`)) return null;
    const rest = path.slice(B.length);
    if (req.method === 'GET' && rest === '/kept-sites') return json({ sites });
    const one = /^\/kept-sites\/(kst_[A-Za-z0-9_-]+)$/.exec(rest);
    if (one && req.method === 'DELETE') {
      const at = sites.findIndex((s) => s.id === one[1]);
      const [site] = at < 0 ? [] : sites.splice(at, 1);
      if (!site) return json({ error: { code: 'not_found', message: 'Kept website not found.' } }, 404);
      return json({ site });
    }
    return null;
  }

  return { handle };
}
