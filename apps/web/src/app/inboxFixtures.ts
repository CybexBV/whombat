/**
 * The Inbox in fixture mode (web-efficiency.md WE-11): `notifications.inbox` and `notifications.markRead` from Mara's
 * notifications of the mobile mock (`NOTIFICATIONS` in `@whombat/fixtures`, the phone's fixture server serves the same),
 * with read state kept in the closure. The NEEDS YOU rows carry no approval (the web's NEEDS YOU is `work.overview`'s).
 */

import { INBOX_SECTIONS, type InboxFilter, type InboxItem, type InboxResponse } from '@whombat/core';
import { api, matchPath } from '@whombat/core/contracts';
import { mara, NOTIFICATIONS } from '@whombat/fixtures';

const API_BASE = '/api/v1';
const READ_AT = '2026-09-23T09:22:00.000Z';

const FILTER_KINDS: Record<InboxFilter, readonly string[]> = {
  all: ['needs_you', 'mention', 'reply', 'agent_update'],
  needs_you: ['needs_you'],
  mentions: ['mention', 'reply'],
  agents: ['agent_update'],
};

export interface InboxFixtures {
  handle(req: Request): Promise<Response | null>;
}

export function createInboxFixtures(): InboxFixtures {
  const read = new Set<string>();
  const items = (): InboxItem[] =>
    NOTIFICATIONS.filter((n) => n.principalId === mara.id).map((n) => ({
      ...n,
      readAt: read.has(n.id) ? READ_AT : n.readAt,
      approval: null,
    }));
  const inbox = (filter: InboxFilter): InboxResponse => {
    const all = items();
    const shown = new Set(FILTER_KINDS[filter]);
    return {
      sections: INBOX_SECTIONS.filter((s) => shown.has(s.kind))
        .map((s) => ({ kind: s.kind, title: s.title, items: all.filter((i) => i.kind === s.kind) }))
        .filter((s) => s.items.length > 0),
      counts: {
        all: all.length,
        needs_you: all.filter((i) => i.kind === 'needs_you').length,
        mentions: all.filter((i) => FILTER_KINDS.mentions.includes(i.kind)).length,
        agents: all.filter((i) => i.kind === 'agent_update').length,
      },
      unread: all.filter((i) => i.readAt === null).length,
    };
  };
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  return {
    async handle(req) {
      const url = new URL(req.url, 'http://fixtures.local');
      const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : url.pathname;
      if (req.method === 'GET' && matchPath(api.notifications.inbox.path, path)) {
        const f = url.searchParams.get('filter') as InboxFilter | null;
        return json(inbox(f && f in FILTER_KINDS ? f : 'all'));
      }
      if (req.method === 'POST' && matchPath(api.notifications.markRead.path, path)) {
        const body = (await req.json()) as { ids?: string[]; all?: boolean };
        for (const n of items()) if (body.all || body.ids?.includes(n.id)) read.add(n.id);
        return json({ unread: inbox('all').unread });
      }
      return null;
    },
  };
}
