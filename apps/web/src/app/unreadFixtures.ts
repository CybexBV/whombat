/**
 * Where Mara stopped reading (docs/decisions/web-messages.md WX-07), for fixture mode (`VITE_FIXTURE_UNREAD=1` or
 * `unread: true`): the shared world's conversation details carry no `lastReadMessageId`, so the “New” divider has
 * nothing to start from. This puts the seed's own read marker on Mara's Chat and one on PR #482's branch room (the room
 * with people's messages that stays with one agent, one-agent.md AP-4949), whose later messages are unread — with the
 * agent's rich messages (`VITE_FIXTURE_RICH=1`, `richFixtures.ts`) a room long enough to open at the divider with “New
 * messages ↓”. Off by default, so the mock's screens stay as drawn.
 */
import { burrow } from '@whombat/fixtures';

const API_BASE = '/api/v1';

/** The seed's read marker (`seed.ts#readMarkers`) and the branch room's. */
const MARKERS: Record<string, string> = {
  cnv_pr482: 'msg_pr482-dusty-1055',
  'cnv_dm-dusty': 'msg_dm-dusty-mara-1404',
};

/** The branch room's messages after its marker by someone else than Mara: the agent's two. */
const BRANCH_UNREAD = 2;
/** The agent's rich messages in the branch room (`richFixtures.ts`), after the marker too. */
const RICH_UNREAD = 6;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Row {
  id: string;
  unread?: number;
}

export interface UnreadFixtures {
  decorate(req: Request, response: Response): Promise<Response>;
}

export function createUnreadFixtures({ rich }: { rich: boolean }): UnreadFixtures {
  const base = `${API_BASE}/burrows/${burrow.slug}`;
  return {
    async decorate(req, response) {
      if (req.method !== 'GET' || !response.ok) return response;
      const path = new URL(req.url, 'http://fixtures.local').pathname;
      if (path === `${base}/bootstrap`) {
        const data = (await response.clone().json()) as { sidebar?: { branchRooms?: Row[] } };
        const branchRooms = data.sidebar?.branchRooms?.map((c) =>
          c.id === 'cnv_pr482' ? { ...c, unread: BRANCH_UNREAD + (rich ? RICH_UNREAD : 0) } : c,
        );
        return data.sidebar ? json({ ...data, sidebar: { ...data.sidebar, branchRooms } }) : response;
      }
      // `conversations.get`.
      const rest = path.startsWith(`${base}/`) ? path.slice(base.length + 1).split('/') : [];
      if (rest.length !== 2 || rest[0] !== 'conversations') return response;
      const data = (await response.clone().json()) as {
        conversation?: { id?: string };
        lastReadMessageId?: string | null;
      };
      const id = data.conversation?.id;
      const marker = id ? MARKERS[id] : undefined;
      if (!marker || data.lastReadMessageId) return response;
      return json({ ...data, lastReadMessageId: marker });
    },
  };
}
