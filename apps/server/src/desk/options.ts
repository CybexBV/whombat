/**
 * What the person can choose the screen shows, as Settings → Screen lists it (`DeskScreen.showOptions`;
 * docs/decisions/desk-display.md DK-106; desk-display-server.md DK-S123): the assistant's work and what's coming up,
 * each connection and device of Home with what its *When it matters* shows, each Home widget with its value now, each
 * server in the strip's order with what it is, and This Whombat. Pure: the service reads Home and the fleet once.
 */
import {
  DESK_SHOW_KEY_RE,
  DESK_WORDS,
  type DeskShow,
  type DeskShowOption,
  deskWords,
  fillDeskWords,
  type HostServer,
  type ThingSummary,
} from '@whombat/core';
import type { WidgetNow } from '../home/widgets';
import { calmMark } from './calm';
import { screenText, widgetTile } from './glance';
import type { DeskServer } from './shapes';

/** At most this many of each in Settings' list (`DeskScreen.showOptions` takes 200 in all). */
const THINGS_MAX = 100;
const WIDGETS_MAX = 12;
const SERVERS_MAX = 80;

/** What a platform is called in a server's line; any other server by its system's name. */
const PLATFORM_NAMES: Partial<Record<HostServer['platform'], string>> = {
  proxmox: 'Proxmox',
  unraid: 'Unraid',
  incus: 'Incus',
  libvirt: 'QEMU',
  macos: 'Mac',
};

/**
 * What a server is, in a few words (“Proxmox · 16 cores”, “Debian · 4 cores”): its platform or its system's name
 * without the version, and its processor's cores when known.
 */
export function serverLine(row: Pick<HostServer, 'platform' | 'os' | 'cpu'>, locale?: string | null): string {
  const system =
    PLATFORM_NAMES[row.platform] ?? (row.os ?? '').split(/\s+(?:GNU\/Linux\b|v?\d|\()/)[0]?.trim();
  const w = (locale ? deskWords(locale) : DESK_WORDS).server;
  const n = row.cpu?.cores ?? 0;
  const cores = n > 0 ? (n === 1 ? w.coresOne : fillDeskWords(w.cores, { n })) : '';
  return screenText([system, cores].filter(Boolean).join(' · '), 120);
}

export interface ShowOptionsInput {
  assistant: string;
  /** Home's things as the person sees them. */
  things: readonly ThingSummary[];
  /** Home's widgets, with their value now. */
  widgets: readonly WidgetNow[];
  /** The fleet's cards worst first, then by name, each with its row when the fleet was read. */
  servers: readonly { card: DeskServer; row?: HostServer | undefined }[];
  show: Pick<DeskShow, 'order'>;
  /** What a kind shows as its activity (“Who’s watching”), or null (`DeskCalmSources.activityLine`). */
  activityLine: (catalogId: string) => string | null;
}

/** Settings → Screen's lists (DK-106): grouped in `DESK_SHOW_GROUPS`' order, the servers in the strip's (DK-108). */
export function deskShowOptions(input: ShowOptionsInput): DeskShowOption[] {
  const words = DESK_WORDS.settings;
  const a = { assistant: input.assistant };
  const option = (o: DeskShowOption): DeskShowOption[] => (o.name && DESK_SHOW_KEY_RE.test(o.key) ? [o] : []);
  const things = input.things
    .filter((t) => t.kind !== 'server')
    .slice(0, THINGS_MAX)
    .flatMap((t) => {
      const shows = t.catalogId ? input.activityLine(t.catalogId) : null;
      const mark = calmMark(t.catalogId);
      return option({
        key: t.id,
        group: 'connection',
        name: screenText(t.name, 80),
        line: screenText(shows ?? t.line, 120),
        ...(mark ? { mark } : {}),
        activity: shows !== null,
      });
    });
  const widgets = input.widgets.slice(0, WIDGETS_MAX).flatMap((w) =>
    option({
      key: `widget:${w.id}`,
      group: 'widget',
      name: screenText(w.title, 80),
      line: widgetTile(w)?.value ?? '',
      activity: false,
    }),
  );
  const place = new Map(input.show.order.map((id, i) => [id, i]));
  const at = (card: DeskServer) =>
    card.id ? (place.get(card.id) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
  const servers = input.servers
    .filter((s) => s.card.id)
    .map((s, i) => ({ s, i }))
    .sort((x, y) => at(x.s.card) - at(y.s.card) || x.i - y.i)
    .slice(0, SERVERS_MAX)
    .flatMap(({ s }) =>
      option({
        key: `server:${s.card.id}`,
        group: 'server',
        name: screenText(s.card.name, 80),
        line: s.row ? serverLine(s.row) : '',
        mark: s.card.mark,
        activity: false,
      }),
    );
  return [
    {
      key: 'work',
      group: 'assistant',
      name: screenText(fillDeskWords(words.work.name, a), 80),
      line: screenText(fillDeskWords(words.work.line, a), 120),
      activity: true,
    },
    { key: 'coming', group: 'assistant', name: words.coming.name, line: words.coming.line, activity: true },
    ...things,
    ...widgets,
    ...servers,
    { key: 'box', group: 'box', name: words.box.name, line: words.box.line, activity: false },
  ];
}
