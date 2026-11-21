/**
 * Fixture mode for the essentials' message features (docs/decisions/essentials-messages.md AP-453): the shared fixture
 * world (`@whombat/fixtures`, contracts 0.26) doesn't serve editing, deleting, pinning, reactions, the pins list, search
 * filters or creating a canvas, so this layer does, over the real REST contract, for tests, `VITE_FIXTURES=1` and the
 * fake managed world. Its state lives in the closure: edits, deletions, pins and reactions are patches applied to every
 * message read.
 *
 * With `seed` (`VITE_FIXTURE_ESSENTIALS=1`, or `essentials: true` in `createWebFixtureFetch`) it also adds Mara's
 * messages to the branch room of PR #482 (the conversation with people's messages that stays with one agent, Whombat
 * one-agent.md OA-04) so the screens show each state: an edited message with a link preview and emoji reactions, a
 * deleted thread root kept for its two replies, and Mara's message about merging pinned; search then pages by six. Without it the
 * mock's screens stay as drawn.
 */
import { toggleReaction } from '@whombat/client/query';
import {
  type Canvas,
  type CanvasSummary,
  conversationLabel,
  countSearchResults,
  dayKey,
  type LinkRef,
  type Message,
  plainMessageText,
  type SearchResponse,
  type SearchResult,
  searchFilterOf,
} from '@whombat/core';
import { API_ENDPOINTS, api, matchPath } from '@whombat/core/contracts';
import { AGENT, burrow, CONVERSATIONS, mara, PRINCIPALS, roomOf, SEED_TIME_ZONE } from '@whombat/fixtures';
import { WHOMBAT_HANDLE } from './oneFixtures';

const API_BASE = '/api/v1';
const ROOM = 'cnv_pr482';

/** The seed clock is 11:22 in Amsterdam on Wednesday 23 September 2026 (UTC+2). */
const T = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 8, 23, (h ?? 0) - 2, m ?? 0)).toISOString();
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function refuse(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function base(o: Partial<Message> & Pick<Message, 'id' | 'authorId' | 'createdAt' | 'text'>): Message {
  return {
    conversationId: ROOM,
    editedAt: null,
    mentions: [],
    card: null,
    suggestions: [],
    more: null,
    attachments: [],
    reactions: [],
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
    ...o,
  };
}

/** The seeded messages (only with `seed`). */
export function essentialsMessages(): Message[] {
  return [
    base({
      id: 'msg_billing-mara-1126',
      authorId: mara.id,
      createdAt: T('11:26'),
      editedAt: T('11:28'),
      text: 'Heads-up: the template review moved to Thursday. Typeset’s notes on templates are worth a read first: https://typeset.dev/docs/templates',
      previews: [
        {
          url: 'https://typeset.dev/docs/templates',
          title: 'Templates · Typeset docs',
          description:
            'Build invoice layouts from reusable blocks: headers, line tables and totals, with number formatting per locale.',
          siteName: 'Typeset',
        },
      ],
      reactions: [
        { value: '👍', count: 1, mine: false, principalIds: [AGENT.id] },
        { value: '🎉', count: 1, mine: true, principalIds: [mara.id] },
      ],
    }),
    base({
      id: 'msg_billing-mara-1127',
      authorId: mara.id,
      createdAt: T('11:27'),
      text: '',
      deletedAt: T('11:31'),
      replyCount: 2,
      lastReplyAt: T('11:30'),
      threadParticipantIds: [mara.id, AGENT.id],
    }),
    base({
      id: 'msg_thread-mara-1129',
      authorId: mara.id,
      createdAt: T('11:29'),
      text: 'Is Thursday the new staging date too?',
      threadRootId: 'msg_billing-mara-1127',
    }),
    base({
      id: 'msg_thread-agent-1130',
      authorId: AGENT.id,
      createdAt: T('11:30'),
      text: 'I’ll wait for the new date before anything goes to staging.',
      threadRootId: 'msg_billing-mara-1127',
    }),
  ];
}

/** Pins the seed starts with: Mara's message about merging, pinned by her. */
const SEEDED_PATCHES: [string, Partial<Message>][] = [
  ['msg_pr482-mara-1130', { pinnedAt: T('11:10'), pinnedById: mara.id }],
];

/** Mara's seeded message as a search result (so the filters have something of hers to find). */
function seededResults(): SearchResult[] {
  return [
    {
      id: 'msg_billing-mara-1126',
      type: 'MESSAGE',
      where: 'feat/invoice-pdf · today 11:26',
      authorId: mara.id,
      snippet:
        'Heads-up: the template review moved to Thursday. Typeset’s notes on templates are worth a read first.',
      citedAs: null,
      link: {
        type: 'message',
        in: { type: 'pr', number: 482 },
        messageId: 'msg_billing-mara-1126',
      },
      createdAt: T('11:26'),
      status: null,
    },
    {
      id: 'msg_chat-mara-0930',
      type: 'MESSAGE',
      where: 'Chat · today 09:30',
      authorId: mara.id,
      snippet: 'Invoice PDFs are the focus this week. Tell me if you need anything from finance.',
      citedAs: null,
      link: { type: 'message', in: { type: 'dm', room: 'chat' }, messageId: 'msg_chat-mara-0930' },
      createdAt: T('09:30'),
      status: null,
    },
  ];
}

/** The conversation a search result belongs to, for the `in` filter. */
function conversationOf(link: LinkRef): string | null {
  const find = (pred: (c: (typeof CONVERSATIONS)[number]) => boolean) => CONVERSATIONS.find(pred)?.id ?? null;
  switch (link.type) {
    case 'pr':
      return find((c) => c.kind === 'branch' && c.prNumber === link.number);
    case 'dm':
      return find((c) => c.kind === 'dm' && roomOf(c) === (link.room ?? 'chat'));
    case 'chat':
      return link.id;
    case 'message':
    case 'plan':
      return conversationOf(link.in);
    case 'approval':
      return link.in ? conversationOf(link.in) : null;
    default:
      return null;
  }
}

export interface EssentialsFixtureOptions {
  seed?: boolean;
  /** Search's page size in fixture mode (default: the request's `limit`; 6 with `seed`). */
  searchPageSize?: number;
}

export interface EssentialsFixtures {
  /** Answers what the shared world lacks; null for anything else. */
  handle(req: Request, world: (req: Request) => Promise<Response>): Promise<Response | null>;
  /** Applies the patches (and the seed) to the world's message reads and canvas list. */
  decorate(req: Request, response: Response): Promise<Response>;
}

type Route = { id: string; params: Record<string, string> };

const ROUTED = new Set([
  api.messages.edit.id,
  api.messages.delete.id,
  api.messages.pin.id,
  api.messages.react.id,
  api.messages.get.id,
  api.messages.thread.id,
  api.messages.list.id,
  api.conversations.pins.id,
  api.search.query.id,
  api.canvases.create.id,
  api.canvases.get.id,
  api.canvases.list.id,
]);

function route(req: Request): Route | null {
  const path = new URL(req.url, 'http://fixtures.local').pathname;
  if (!path.startsWith(API_BASE)) return null;
  const rest = path.slice(API_BASE.length);
  for (const ep of API_ENDPOINTS) {
    if (!ROUTED.has(ep.id) || ep.method !== req.method) continue;
    const params = matchPath(ep.path, rest);
    if (params) return { id: ep.id, params };
  }
  return null;
}

export function createEssentialsFixtures(options: EssentialsFixtureOptions = {}): EssentialsFixtures {
  const seed = options.seed ?? false;
  const seeded = new Map<string, Message>(seed ? essentialsMessages().map((m) => [m.id, m]) : []);
  const patches = new Map<string, Partial<Message>>(seed ? SEEDED_PATCHES : []);
  const pinned = new Set<string>(seed ? SEEDED_PATCHES.map(([id]) => id) : []);
  const removed = new Set<string>();
  const canvases: Canvas[] = [];
  const pageSize = options.searchPageSize ?? (seed ? 6 : undefined);
  const now = () => new Date().toISOString();

  const patched = (m: Message): Message => {
    const p = patches.get(m.id);
    return p ? { ...m, ...p } : m;
  };
  const patch = (id: string, change: Partial<Message>) => patches.set(id, { ...patches.get(id), ...change });

  /** The current message: a seeded one, else the world's, with its patches; null when it's gone. */
  async function current(
    world: (req: Request) => Promise<Response>,
    origin: string,
    slug: string,
    id: string,
  ): Promise<Message | null> {
    if (removed.has(id)) return null;
    const own = seeded.get(id);
    if (own) return patched(own);
    const res = await world(new Request(`${origin}${API_BASE}/burrows/${slug}/messages/${id}`));
    if (!res.ok) return null;
    const { message } = (await res.json()) as { message: Message };
    return patched(message);
  }

  const visible = (list: Message[]) => list.filter((m) => !removed.has(m.id)).map(patched);

  return {
    async handle(req, world) {
      const r = route(req);
      if (!r) return null;
      const url = new URL(req.url, 'http://fixtures.local');
      const origin = url.origin;
      const slug = r.params.burrow ?? burrow.slug;
      const id = r.params.messageId ?? '';
      switch (r.id) {
        case api.messages.edit.id: {
          const m = await current(world, origin, slug, id);
          if (!m) return refuse(404, 'not_found', 'That message is gone.');
          if (m.authorId !== mara.id || m.card || m.deletedAt)
            return refuse(403, 'forbidden', 'You can only edit your own messages.');
          const { text } = (await req.json()) as { text: string };
          const trimmed = text.trim();
          if (!trimmed && m.attachments.length === 0)
            return refuse(400, 'invalid', 'A message needs some text.');
          patch(id, { text: trimmed, editedAt: now() });
          return json({ message: patched(m) });
        }
        case api.messages.delete.id: {
          const m = await current(world, origin, slug, id);
          if (!m) return refuse(404, 'not_found', 'That message is gone.');
          pinned.delete(id);
          if (m.replyCount > 0) {
            patch(id, {
              deletedAt: now(),
              text: '',
              attachments: [],
              card: null,
              previews: [],
              reactions: [],
              pinnedAt: null,
              pinnedById: null,
              mentions: [],
            });
            return json({ messageId: id, message: patched(m) });
          }
          removed.add(id);
          if (m.threadRootId) {
            const root = await current(world, origin, slug, m.threadRootId);
            if (root) patch(root.id, { replyCount: Math.max(0, root.replyCount - 1) });
          }
          return json({ messageId: id, message: null });
        }
        case api.messages.pin.id: {
          const m = await current(world, origin, slug, id);
          if (!m) return refuse(404, 'not_found', 'That message is gone.');
          const { pinned: on } = (await req.json()) as { pinned: boolean };
          if (on) pinned.add(id);
          else pinned.delete(id);
          patch(
            id,
            on
              ? { pinnedAt: m.pinnedAt ?? now(), pinnedById: m.pinnedById ?? mara.id }
              : { pinnedAt: null, pinnedById: null },
          );
          return json({ message: patched(m) });
        }
        case api.messages.react.id: {
          const m = await current(world, origin, slug, id);
          if (!m) return refuse(404, 'not_found', 'That message is gone.');
          const { value, on } = (await req.json()) as { value: string; on: boolean };
          const reactions = toggleReaction(m.reactions, value, on, mara.id);
          patch(id, { reactions });
          return json({ reactions });
        }
        case api.messages.get.id: {
          const own = seeded.get(id);
          if (!own) return null;
          return removed.has(id)
            ? refuse(404, 'not_found', 'No such message.')
            : json({ message: patched(own) });
        }
        case api.messages.thread.id: {
          const own = seeded.get(id);
          if (!own || own.threadRootId) return null;
          if (removed.has(id)) return refuse(404, 'not_found', 'No such message.');
          const replies = visible([...seeded.values()].filter((m) => m.threadRootId === id));
          const c = CONVERSATIONS.find((x) => x.id === own.conversationId);
          return json({
            root: patched(own),
            replies,
            conversationId: own.conversationId,
            where: c ? conversationLabel(c) : '',
            topic: null,
            more: null,
          });
        }
        case api.conversations.pins.id: {
          const conversationId = r.params.conversationId ?? '';
          const messages: Message[] = [];
          for (const pinnedId of pinned) {
            const m = await current(world, origin, slug, pinnedId);
            if (m?.pinnedAt && m.conversationId === conversationId) messages.push(m);
          }
          messages.sort((a, b) => (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? ''));
          return json({ messages: messages.slice(0, 50) });
        }
        case api.canvases.create.id: {
          const body = (await req.json()) as { title: string; conversationId?: string };
          const title = body.title.trim();
          if (!title) return refuse(400, 'invalid', 'A canvas needs a title.');
          const stem =
            title
              .toLowerCase()
              .normalize('NFKD')
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '')
              .slice(0, 100) || 'canvas';
          let slugged = stem;
          for (let n = 2; canvases.some((c) => c.slug === slugged); n++) slugged = `${stem}-${n}`;
          const at = now();
          const canvas: Canvas = {
            id: `cvs_new-${canvases.length + 1}-${Date.now().toString(36)}`,
            burrowId: burrow.id,
            slug: slugged,
            title,
            conversationId: body.conversationId ?? null,
            planId: null,
            provenance: { createdById: mara.id, requestedById: null, editorIds: [] },
            createdAt: at,
            updatedAt: at,
          };
          canvases.unshift(canvas);
          return json({ canvas }, 201);
        }
        case api.canvases.get.id: {
          const canvas = canvases.find((c) => c.slug === r.params.slug);
          if (!canvas) return null;
          const c = CONVERSATIONS.find((x) => x.id === canvas.conversationId);
          return json({
            canvas,
            conversationTitle: c ? conversationLabel(c) : null,
            plan: null,
            comments: [],
            presentIds: [],
            documentName: `canvas:${canvas.id}`,
          });
        }
        case api.search.query.id:
          return search(url, req, world);
        default:
          return null;
      }
    },

    async decorate(req, response) {
      if (req.method !== 'GET' || !response.ok) return response;
      const r = route(req);
      if (!r) return response;
      if (r.id === api.messages.list.id) {
        const page = (await response.clone().json()) as { messages: Message[] };
        const own = [...seeded.values()].filter(
          (m) => m.conversationId === r.params.conversationId && m.threadRootId === null,
        );
        const messages = visible([...page.messages.filter((m) => !seeded.has(m.id)), ...own]).sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
        return json({ ...page, messages });
      }
      if (r.id === api.messages.thread.id) {
        const view = (await response.clone().json()) as { root: Message; replies: Message[] };
        return json({ ...view, root: patched(view.root), replies: visible(view.replies) });
      }
      if (r.id === api.messages.get.id) {
        const { message } = (await response.clone().json()) as { message: Message };
        if (removed.has(message.id)) return refuse(404, 'not_found', 'No such message.');
        return json({ message: patched(message) });
      }
      if (r.id === api.canvases.list.id && canvases.length) {
        const data = (await response.clone().json()) as { canvases: CanvasSummary[] };
        const mine: CanvasSummary[] = canvases.map((canvas) => {
          const c = CONVERSATIONS.find((x) => x.id === canvas.conversationId);
          return { ...canvas, conversationTitle: c ? conversationLabel(c) : null };
        });
        return json({ ...data, canvases: [...mine, ...data.canvases] });
      }
      return response;
    },
  };

  /** Search with the filters (`from`, `in`, `after`, `before`) and cursor paging over the world's results. */
  async function search(
    url: URL,
    req: Request,
    world: (req: Request) => Promise<Response>,
  ): Promise<Response> {
    const res = await world(new Request(url.toString(), { method: 'GET', headers: req.headers }));
    if (!res.ok) return res;
    const data = (await res.json()) as SearchResponse;
    const q = url.searchParams;
    const from = q.get('from');
    const inId = q.get('in');
    const after = q.get('after');
    const before = q.get('before');
    const type = q.get('type') ?? 'all';
    // The agent goes by the name Mara gave it (`oneFixtures.ts`).
    const authorId = from
      ? from === WHOMBAT_HANDLE
        ? AGENT.id
        : (PRINCIPALS.find((p) => p.handle === from)?.id ?? '?')
      : null;
    const filtered = [...data.results, ...(seed ? seededResults() : [])]
      .filter((r) => !removed.has(r.id))
      .map((r) => {
        const own = seeded.get(r.id);
        const text = own ? patched(own).text : null;
        return text ? { ...r, snippet: plainMessageText(text).slice(0, 1000) } : r;
      })
      .filter((r) => !authorId || r.authorId === authorId)
      .filter((r) => !inId || conversationOf(r.link) === inId)
      .filter((r) => !after || dayKey(r.createdAt, SEED_TIME_ZONE) >= after)
      .filter((r) => !before || dayKey(r.createdAt, SEED_TIME_ZONE) <= before);
    const counts = countSearchResults(filtered);
    const typed = type === 'all' ? filtered : filtered.filter((r) => searchFilterOf(r.type) === type);
    const limit = Math.min(Number(q.get('limit') ?? 30) || 30, pageSize ?? 100);
    const offset = Number(/^o:(\d+)$/.exec(q.get('cursor') ?? '')?.[1] ?? 0);
    const results = typed.slice(offset, offset + limit);
    const next = offset + limit < typed.length ? `o:${offset + limit}` : null;
    return json({ ...data, results, counts, next, answer: offset ? null : data.answer });
  }
}
