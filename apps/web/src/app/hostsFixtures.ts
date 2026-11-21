/**
 * Servers in fixture mode (`VITE_FIXTURE_HOSTS=1`, or `hosts: true` in `createWebFixtureFetch`; one-whombat-things.md
 * AP-1340): the hosts routes from `@whombat/client/hosts/fixtures` (the mock's five servers, pve-02 running hot), plus
 * what the Ask pane needs that the shared world lacks — the viewer's assistant, Neo with Neo's face (Whombat
 * assistant-name.md AN-02, AN-04; the one-Whombat layer keeps its name and face as saved), and a task chat about pve-02,
 * “Why is pve-02 so warm?”, with Neo's answer (mock 2; its “Move it” approval card is the room's, not drawn here). Chats about
 * other servers start empty and `chats.start` makes them. Other chats are left to the world (stream WS's fixtures).
 */
import {
  createHostsFixtures,
  withAgentUpdatesFixtures,
  withDashboardFixtures,
  withQuietFixtures,
  withUpdatesFixtures,
} from '@whombat/client/hosts/fixtures';
import type { Bootstrap, ChatSummary, ConversationDetail, Message, MessagePage } from '@whombat/core';
import { burrow } from '@whombat/fixtures';
import { WHOMBAT_ID } from './oneFixtures';

const API = '/api/v1';
const PVE02_CHAT = 'cnv_chat_pve02';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Chat {
  id: string;
  title: string;
  subject: { kind: 'server' | 'connection' | 'device'; id: string; name: string };
  messages: Message[];
}

export interface HostsFixtureLayer {
  /** Answers the hosts routes and the server chats; everything else goes to `inner`. */
  fetch(req: Request, inner: (req: Request) => Promise<Response>): Promise<Response>;
  /** “Don’t ask again on {server}” on an approval set the server to Never (Whombat server-asks.md SA-07; AP-1719). */
  stopAsking(serverId: string): void;
}

export function createHostsFixtureLayer(
  now = Date.now(),
  opts: {
    /**
     * John's servers for the dashboards (`dashboardFixtures`, stream K): pve-02 and blackbox as server.png and
     * unraid.png draw them, the-titan (Incus), kvm-lab (QEMU/KVM), the-falcon and raspi (plain Linux) by their address.
     */
    dashboards?: boolean;
  } = {},
): HostsFixtureLayer {
  const hosts = createHostsFixtures(now);
  // Updates waiting, being installed and installed waiting for a restart (server-updates-app.md AP-2878); each
  // agent's own update, and “Keep server agents up to date” (agent-updates-app.md AP-2990).
  // Ignore, Remind me tomorrow and Stop watching on servers (quiet-notices.md AP-4814): their pages read through them.
  const quiet = withQuietFixtures(
    withAgentUpdatesFixtures(
      withUpdatesFixtures(opts.dashboards ? withDashboardFixtures(hosts.handle, now) : hosts.handle, { now }),
      { now },
    ),
  );
  const handle = quiet.handle;
  const base = `${API}/burrows/${burrow.slug}`;
  const chats = new Map<string, Chat>();
  let seeding: Promise<void> | null = null;
  let detailTemplate: ConversationDetail | null = null;
  let messageTemplate: Message | null = null;
  let me = '';

  /** The shapes come from the world (Dusty's DM and its first message), so they stay valid. */
  function seed(inner: (req: Request) => Promise<Response>): Promise<void> {
    seeding ??= build(inner);
    return seeding;
  }

  async function build(inner: (req: Request) => Promise<Response>) {
    const boot = (await (
      await inner(new Request(`http://fixtures.local${base}/bootstrap`))
    ).json()) as Bootstrap;
    me = boot.me.id;
    const dm = boot.sidebar.dms[0];
    if (!dm) return;
    detailTemplate = (await (
      await inner(new Request(`http://fixtures.local${base}/conversations/${dm.id}`))
    ).json()) as ConversationDetail;
    const page = (await (
      await inner(new Request(`http://fixtures.local${base}/conversations/${dm.id}/messages`))
    ).json()) as MessagePage;
    messageTemplate = page.messages.find((m) => !m.card) ?? page.messages[0] ?? null;
    if (!messageTemplate) return;
    const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
    const msg = (
      id: string,
      authorId: string,
      text: string,
      minAgo: number,
      extra: Partial<Message> = {},
    ): Message => ({
      ...(messageTemplate as Message),
      id: id as Message['id'],
      conversationId: PVE02_CHAT as Message['conversationId'],
      authorId: authorId as Message['authorId'],
      text,
      createdAt: at(minAgo),
      editedAt: null,
      threadRootId: null,
      replyCount: 0,
      card: null,
      reactions: [],
      attachments: [],
      ...extra,
    });
    chats.set(PVE02_CHAT, {
      id: PVE02_CHAT,
      title: 'Why is pve-02 so warm?',
      subject: { kind: 'server', id: 'pve-02', name: 'pve-02' },
      messages: [
        msg('msg_pve02_q', me, 'Why is pve-02 so warm?', 3),
        msg(
          'msg_pve02_a',
          WHOMBAT_ID,
          'The CPU has been above 72 °C since last night. Most of the load comes from **cli-proxy-api** and **arnica-prod-nest-01**. pve-01 has almost nothing running, so I can move one over.',
          3,
        ),
      ],
    });
  }

  function summary(c: Chat): ChatSummary {
    const last = c.messages[c.messages.length - 1];
    return {
      id: c.id as ChatSummary['id'],
      title: c.title,
      subject: c.subject,
      lastAt: last?.createdAt ?? null,
      lastText: last?.text ?? '',
      unread: 0,
      default: false,
    };
  }

  function detail(c: Chat): ConversationDetail | null {
    if (!detailTemplate) return null;
    return {
      ...detailTemplate,
      conversation: {
        ...detailTemplate.conversation,
        id: c.id as ConversationDetail['conversation']['id'],
        title: c.title,
        chat: { title: c.title, subject: c.subject, archivedAt: null },
      },
      summary: {
        ...detailTemplate.summary,
        id: c.id as ConversationDetail['summary']['id'],
        title: c.title,
        link: { type: 'chat', id: c.id },
        unread: 0,
        mentions: 0,
      },
      lastReadMessageId: (c.messages[c.messages.length - 1]?.id ??
        null) as ConversationDetail['lastReadMessageId'],
    };
  }

  return {
    stopAsking(serverId) {
      hosts.world.asks.set(serverId, 'never');
    },
    async fetch(req, inner) {
      const url = new URL(req.url, 'http://fixtures.local');
      const path = url.pathname;
      if (path.startsWith(`${base}/hosts/`)) {
        const text = req.method === 'GET' || req.method === 'DELETE' ? '' : await req.text();
        const answer = handle({
          method: req.method,
          path: path.slice(`${base}/hosts`.length),
          query: Object.fromEntries(url.searchParams),
          body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
        });
        return answer
          ? json(answer.body, answer.status)
          : json({ error: { code: 'not_found', message: 'Not here.' } }, 404);
      }
      // A server's quiet lines and What Whombat watches (`things.quiet`, `things.watch`, `things.setWatch`).
      const thing = /^\/things\/server(?:%3A|:)([^/]+)\/(quiet|watch)$/i.exec(path.slice(base.length));
      if (thing) {
        const text = req.method === 'POST' ? await req.text() : '';
        const answer = quiet.things({
          method: req.method,
          serverId: decodeURIComponent(thing[1] as string),
          what: thing[2] as 'quiet' | 'watch',
          body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
        });
        return json(answer.body, answer.status);
      }
      const chatsPath = `${base}/chats`;
      if (path === chatsPath && req.method === 'GET' && url.searchParams.get('subjectKind')) {
        await seed(inner);
        const kind = url.searchParams.get('subjectKind');
        const id = url.searchParams.get('subjectId');
        return json({
          chats: [...chats.values()]
            .filter((c) => c.subject.kind === kind && (!id || c.subject.id === id))
            .map(summary),
        });
      }
      if (path === chatsPath && req.method === 'POST') {
        const body = (await req.clone().json()) as { text: string; subject?: Chat['subject'] };
        if (body.subject?.kind === 'server') {
          await seed(inner);
          const id = `cnv_chat_${body.subject.id.replace(/[^a-z0-9]/gi, '')}_${chats.size + 1}`;
          const first: Message | null = messageTemplate
            ? {
                ...messageTemplate,
                id: `msg_${id}_1` as Message['id'],
                conversationId: id as Message['conversationId'],
                authorId: me as Message['authorId'],
                text: body.text,
                createdAt: new Date().toISOString(),
                card: null,
                reactions: [],
                attachments: [],
                threadRootId: null,
                replyCount: 0,
                editedAt: null,
              }
            : null;
          const chat: Chat = {
            id,
            title: body.text.split('\n')[0]?.slice(0, 60) ?? 'New chat',
            subject: body.subject,
            messages: first ? [first] : [],
          };
          chats.set(id, chat);
          const d = detail(chat);
          return json({ conversation: d?.conversation, message: first }, 201);
        }
      }
      const m = path.match(new RegExp(`^${base}/conversations/(cnv_chat_[^/]+)(/messages)?$`));
      if (m) {
        await seed(inner);
        const chat = chats.get(m[1] ?? '');
        if (!chat) return json({ error: { code: 'not_found', message: 'That chat isn’t here.' } }, 404);
        if (!m[2] && req.method === 'GET') return json(detail(chat));
        if (m[2] && req.method === 'GET')
          return json({ messages: chat.messages, before: null, hasMore: false } satisfies MessagePage);
        if (m[2] && req.method === 'POST' && messageTemplate) {
          const body = (await req.json()) as { text: string; clientId?: string };
          const message: Message = {
            ...messageTemplate,
            id: `msg_${chat.id}_${chat.messages.length + 1}` as Message['id'],
            conversationId: chat.id as Message['conversationId'],
            authorId: me as Message['authorId'],
            text: body.text,
            clientId: body.clientId ?? null,
            createdAt: new Date().toISOString(),
            card: null,
            reactions: [],
            attachments: [],
            threadRootId: null,
            replyCount: 0,
            editedAt: null,
          } as Message;
          chat.messages.push(message);
          return json({ message, dispatches: [] }, 201);
        }
      }
      return inner(req);
    },
  };
}
