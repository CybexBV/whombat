/**
 * The demo world's new Home parts (Whombat home-redesign HR-21…HR-24; home-redesign-mobile.md AP-2266): what Neo did
 * (Done recently and Everything I did, with Undo and Review) and a pinned panel. `changes.list` without a thing (Home's
 * list, a page at a time) and `changes.undo` for these changes are answered here — Undo on a change Neo reported asks
 * Neo to put it back (`requested`, contracts 0.91) and refuses a second press within 10 minutes; a thing's own list
 * is `thingPages.ts`'. Pure TypeScript over `Response`; every answer parses with its endpoint's schema.
 */
import type { ChangeEntry, HomePart, Widget } from '@whombat/core';
import { at } from '@whombat/fixtures';

const HOUR = 3_600_000;

export interface HomeRedesignOptions {
  now: () => Date;
  json: (body: unknown, status?: number) => Response;
  notFound: (message: string) => Response;
  /** Home is told a part changed (`home.changed`). */
  changed: (parts: HomePart[]) => void;
  assistant: () => { id: string; name: string };
  chats: { pve: string; main: string };
}

export function createHomeRedesignFixtures(options: HomeRedesignOptions) {
  const { now, json, notFound } = options;
  const iso = (ms: number) => new Date(ms).toISOString();
  const ago = (ms: number) => iso(now().getTime() - ms);
  const whombat = () => ({ kind: 'whombat' as const, ...options.assistant() });
  const undone = new Set<string>(['chg_home-jellyfin-disk']);
  /** When Mara asked Neo to put a reported change back (contracts 0.91 `requested`, Whombat HR-03). */
  const requested = new Map<string, number>();
  /** Changes Neo reported with `report_change`: Undo asks Neo in their chat instead of running an inverse. */
  const REPORTED = new Set(['chg_home-charger-stats']);

  /** Neo's changes, newest first: two with Undo, two with Review, one undone. */
  function changes(): ChangeEntry[] {
    const list: ChangeEntry[] = [
      {
        id: 'chg_home-nest-memory',
        title: 'Gave arnica-prod-nest-01 4 GB more memory',
        detail: 'It uses it after a restart.',
        at: at('13:58'),
        actor: whombat(),
        undo: { state: 'available', until: iso(Date.parse(at('13:58')) + 24 * HOUR) },
        link: `/chats/${options.chats.pve}`,
        thingId: 'server:pve-02',
      },
      {
        id: 'chg_home-charger-stats',
        title: 'Deleted the old statistics of the charger’s “last session cost”',
        detail: 'About 2,000 entries Home Assistant kept warning about.',
        at: at('13:05'),
        actor: whombat(),
        undo: { state: 'available', until: iso(Date.parse(at('13:05')) + 24 * HOUR) },
        link: `/chats/${options.chats.main}`,
        thingId: 'connection:con_ha',
      },
      {
        id: 'chg_home-guests-moved',
        title: 'Moved jellyfin and grafana to pve-01',
        detail: 'pve-02 ran warm while both were busy.',
        at: at('12:18'),
        actor: whombat(),
        undo: { state: 'none' },
        link: `/chats/${options.chats.pve}`,
        thingId: 'server:pve-02',
      },
      {
        id: 'chg_home-hallway',
        title: 'Turned off the hallway lights',
        at: at('23:10', -1),
        actor: whombat(),
        undo: { state: 'none' },
        link: '/things/connection%3Acon_ha',
        thingId: 'connection:con_ha',
      },
      {
        id: 'chg_home-jellyfin-disk',
        title: 'Moved jellyfin’s disk to the faster pool',
        at: at('16:40', -2),
        actor: whombat(),
        undo: { state: 'available', until: iso(Date.parse(at('16:40', -2)) + 24 * HOUR) },
        link: `/chats/${options.chats.pve}`,
        thingId: 'server:pve-02',
      },
    ];
    return list.map((c) => (undone.has(c.id) ? { ...c, undo: { state: 'undone' as const } } : c));
  }

  /** Home's pinned panel: the house's and the heat pump's power over the last 24 hours, every 15 minutes. */
  function widgets(): Widget[] {
    const step = 15 * 60_000;
    const end = Math.floor(now().getTime() / step) * step;
    const points = Array.from({ length: 96 }, (_, i) => {
      const t = end - (95 - i) * step;
      const hour = (i / 4 + 14) % 24;
      const evening = hour >= 17 && hour <= 22 ? 1.4 : 0;
      const house = Math.round((0.45 + evening + Math.sin(i / 5) * 0.15) * 100) / 100;
      const heat = Math.round((hour < 7 || hour > 21 ? 1.1 : 0.6 + Math.cos(i / 7) * 0.2) * 100) / 100;
      return { t: iso(t), values: { house, heat } };
    });
    const last = points.at(-1)?.values ?? { house: null, heat: null };
    return [
      {
        id: 'wdg_home-power',
        title: 'Power use',
        subtitle: 'From Home Assistant',
        kind: 'line',
        series: [
          { key: 'house', label: 'House', unit: 'kW', color: 1 },
          { key: 'heat', label: 'Heat pump', unit: 'kW', color: 2 },
        ],
        latest: [
          { key: 'house', value: last.house ?? null, unit: 'kW' },
          { key: 'heat', value: last.heat ?? null, unit: 'kW' },
        ],
        points,
        refreshSec: 300,
        updatedAt: ago(3 * 60_000),
        fromConversationId: options.chats.main,
      },
    ];
  }

  return {
    /** Home's Done recently: the newest few (the server's cap). */
    doneRecently: () => changes(),
    widgets,
    /** The answer for Home's changes, or null (a thing's list and the rest of the world answer). */
    handle(id: string, params: Record<string, string>, url: URL): Response | null {
      switch (id) {
        case 'changes.list': {
          if (url.searchParams.get('thing')) return null;
          const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
          const before = url.searchParams.get('before');
          const all = changes();
          const start = before ? all.findIndex((c) => c.id === before) + 1 : 0;
          const page = all.slice(start, start + limit);
          const more = start + limit < all.length;
          return json({ changes: page, before: more ? (page.at(-1)?.id ?? null) : null });
        }
        case 'changes.undo': {
          const change = changes().find((c) => c.id === params.changeId);
          if (!change) return null;
          if (change.undo.state !== 'available') return notFound('This can’t be undone any more.');
          if (REPORTED.has(change.id)) {
            // A second press within 10 minutes is refused (HR-03).
            const asked = requested.get(change.id);
            if (asked !== undefined && now().getTime() - asked < 10 * 60_000)
              return json({ error: { code: 'conflict', message: 'I’m already undoing this.' } }, 409);
            requested.set(change.id, now().getTime());
            return json({ change, state: 'requested', conversationId: options.chats.main });
          }
          undone.add(change.id);
          options.changed(['doneRecently']);
          return json({ change: { ...change, undo: { state: 'undone' } }, state: 'undone' });
        }
        default:
          return null;
      }
    },
  };
}
