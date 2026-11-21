/**
 * Shared links in fixture mode (docs/decisions/share-links.md): the Share sheet's preview, making a link, the list in
 * Settings → You → Shared links and stopping, over the real REST contract and kept in memory. A thread whose first words
 * mention the NAS shows the warnings; one link is in the list from the start.
 */
import type { SharedLink, SharePreview } from '@whombat/core';
import { newShare, type ShareExpiry, shareExpiresAt, shareLink } from '@whombat/core/share';
import { burrow } from '@whombat/fixtures';

const B = `/api/v1/burrows/${burrow.slug}`;
const VIEWER = 'https://app.whombat.com/s/';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function link(
  title: string,
  rootId: string,
  expiry: ShareExpiry,
  createdAt: Date,
  views: number,
): SharedLink {
  const { id, key } = newShare();
  const expiresAt = shareExpiresAt(expiry, Math.floor(createdAt.getTime() / 1000));
  return {
    id,
    title,
    url: shareLink(`${VIEWER}${id}`, key),
    rootId,
    messages: 4,
    pictures: true,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt === null ? null : new Date(expiresAt * 1000).toISOString(),
    stoppedAt: null,
    state: 'live',
    stopping: false,
    views,
  };
}

export function createShareFixtures(options: { seeded?: boolean } = {}) {
  const links: SharedLink[] =
    options.seeded === false
      ? []
      : [
          link(
            'A weekend in Lisbon in May',
            'msg_fixture_lisbon',
            '7d',
            new Date(Date.now() - 2 * 86_400_000),
            3,
          ),
        ];

  async function body<T>(req: Request): Promise<T> {
    const text = await req.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async function handle(req: Request): Promise<Response | null> {
    const path = new URL(req.url, 'http://fixtures.local').pathname;
    if (!path.startsWith(`${B}/shares`)) return null;
    const rest = path.slice(B.length);
    const route = `${req.method} ${rest}`;
    if (route === 'POST /shares/preview') {
      const preview: SharePreview = {
        title: 'Where should the backups go?',
        messages: 4,
        pictures: 1,
        pages: 0,
        leftOut: 1,
        warnings: [{ kind: 'address', messages: 1, example: '192.168.1.20' }],
        fits: { withPictures: true, withoutPictures: true },
      };
      return json(preview);
    }
    if (route === 'POST /shares') {
      const b = await body<{ rootId: string; pictures: boolean; expiry: ShareExpiry }>(req);
      const made = {
        ...link('Where should the backups go?', b.rootId, b.expiry, new Date(), 0),
        pictures: b.pictures,
      };
      links.unshift(made);
      return json({ share: made }, 201);
    }
    if (route === 'GET /shares') return json({ shares: links });
    if (route === 'POST /shares/stop') {
      let stopped = 0;
      for (const l of links)
        if (l.state === 'live') {
          Object.assign(l, { state: 'stopped', stoppedAt: new Date().toISOString(), views: null });
          stopped++;
        }
      return json({ stopped });
    }
    const one = /^\/shares\/(shr_[A-Za-z0-9_-]{22})$/.exec(rest);
    if (one && req.method === 'DELETE') {
      const l = links.find((x) => x.id === one[1]);
      if (!l) return json({ error: { code: 'not_found', message: 'Link not found.' } }, 404);
      Object.assign(l, { state: 'stopped', stoppedAt: new Date().toISOString(), views: null });
      return json({ share: l });
    }
    return null;
  }

  return { handle };
}
