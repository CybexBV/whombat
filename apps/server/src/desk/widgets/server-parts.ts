/**
 * A server's other widgets (docs/decisions/desk-display.md DK-153): one part of what its own screen shows — its
 * processor, memory or network over the widget's range, its storage, its virtual machines and containers, its
 * temperature or its open alerts — each as a view every screen already draws (a chart, a list, figures), so an older
 * screen draws them too. They're read as the server's own screen reads it (`readServerParts`: the detail, the metrics
 * over the range, the guests and the open alerts, as Whombat), kept a while per server and range, and drawn with the
 * fleet's card, so a server that's off or gone says so.
 */
import {
  DESK_VIEW_ROWS_MAX,
  type DeskServerRange,
  type DeskViewFigure,
  type DeskViewRow,
  type DeskViewTone,
  type DeskWidgetView,
  fillDeskWords,
  type HostAlert,
  type HostServer,
} from '@whombat/core';
import { SERVER_SHOW_WORDS, type ServerShow, serverShow } from '@whombat/screen';
import { screenText, tempTone } from '../glance';
import { deskServerPage, downsample, type ServerParts } from '../server-page';
import type { DeskServer } from '../shapes';
import { clockIn } from './own';
import {
  SERVER_REFRESH_S,
  SERVER_SPARK_POINTS,
  serverLineOf,
  serverRange,
  serverStats,
  serverView,
} from './servers';
import type { Resolved } from './types';

/** A part of a server, not its overview. */
export type ServerPart = Exclude<ServerShow, 'overview'>;

/** The parts drawn over the widget's range; the rest are read with the shortest. */
const CHARTS: ReadonlySet<ServerPart> = new Set(['cpu', 'memory', 'network']);

/** How long what was read of a server for its parts is kept, by the range read. */
export const SERVER_PARTS_KEEP_MS: Readonly<Record<DeskServerRange, number>> = {
  '1h': 30_000,
  '24h': 60_000,
  '7d': 120_000,
};

export const SERVER_PART_WORDS = {
  /** *Add a widget*'s names and lines, and each view's title. */
  ...SERVER_SHOW_WORDS,
  ranges: { '1h': 'Last hour', '24h': 'Last 24 hours', '7d': 'Last 7 days' },
  cores: 'of {n} cores',
  load: 'load {n}',
  memoryOf: '{used} of {total}',
  memoryAvg: 'Avg {avg} %',
  used: '{used} of {total} used',
  running: '{n} running',
  runningOff: '{n} running · {off} off',
  in: 'In',
  out: 'Out',
  hottest: 'Hottest',
  hotFrom: 'hot from {n} °C',
  vm: 'VM',
  container: 'Container',
  stopped: 'off',
  paused: 'paused',
  off: 'It’s switched off.',
  failed: 'I can’t read {name} right now.',
  noNetwork: 'It doesn’t say what goes in and out.',
  noStorage: 'It doesn’t say how full its disks are.',
  noGuests: 'Nothing runs on it.',
  noTemp: 'It doesn’t report its temperature.',
  noAlerts: 'Nothing’s wrong with it right now.',
} as const;

/** What a server widget reads for its part: its own range for a chart, else the shortest. */
export function serverPartRange(show: ServerPart, opts: Readonly<Record<string, string>>): DeskServerRange {
  return CHARTS.has(show) ? serverRange(opts) : '1h';
}

/** A server widget's part, or null for its overview. */
export function serverPartOf(opts: Readonly<Record<string, string>>): ServerPart | null {
  const show = serverShow(opts);
  return show === 'overview' ? null : show;
}

const TONES: Record<DeskServer['state'], DeskViewTone> = { ok: 'ok', warn: 'warn', bad: 'bad', off: 'off' };
const notOk = (tone: DeskViewTone | 'ok') => (tone === 'ok' ? undefined : tone);
const tenth = (n: number) => Math.round(n * 10) / 10;

/** A line's points as the view carries them: at most `SERVER_SPARK_POINTS`, gaps kept. */
function points(values: readonly (number | null)[], round: (n: number) => number): (number | null)[] {
  return downsample(values, SERVER_SPARK_POINTS).points.map((p) =>
    p === null || !Number.isFinite(p) ? null : round(p),
  );
}

/** When an alert opened: its time today, its weekday this week, else its date. */
function openedWhen(at: string, now: Date, timeZone: string): string {
  const t = new Date(at);
  if (Number.isNaN(t.getTime())) return '';
  const day = (d: Date) => {
    try {
      return new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeZone }).format(d);
    } catch {
      return d.toISOString().slice(0, 10);
    }
  };
  if (day(t) === day(now)) return clockIn(t, timeZone);
  const opts: Intl.DateTimeFormatOptions =
    now.getTime() - t.getTime() < 6 * 86_400_000 ? { weekday: 'short' } : { day: 'numeric', month: 'short' };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone }).format(t);
  } catch {
    return '';
  }
}

/** The server's open alerts that ask for a look, the worst and then the newest first, with when each opened. */
export function serverAlertRows(
  alerts: readonly HostAlert[],
  serverId: string,
  now: Date,
  timeZone: string,
): { rows: DeskViewRow[]; count: number } {
  const open = alerts
    .filter((a) => a.serverId === serverId && a.state === 'open' && a.attention !== false)
    .sort(
      (a, b) =>
        (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1) ||
        Date.parse(b.openedAt) - Date.parse(a.openedAt),
    );
  const rows = open.flatMap((a): DeskViewRow[] => {
    const title = screenText(a.title, 120);
    if (!title) return [];
    const time = screenText(openedWhen(a.openedAt, now, timeZone), 16);
    return [{ title, tone: a.severity === 'critical' ? 'bad' : 'warn', ...(time ? { time } : {}) }];
  });
  return { rows: rows.slice(0, DESK_VIEW_ROWS_MAX), count: open.length };
}

/**
 * A part of a server as its widget draws it: null until what it shows was read (the screen draws it empty meanwhile).
 * A server no longer in the fleet says so as its overview does; one that's off says so instead of old figures.
 */
export function serverPartView(input: {
  id: string;
  show: ServerPart;
  serverId: string;
  card: DeskServer | undefined;
  row: HostServer | undefined;
  parts: ServerParts | null;
  range: DeskServerRange;
  now: Date;
  timeZone: string;
  /** The fleet couldn't be read, so a server not found may still be there. */
  unreachable?: boolean;
  /** The last read of its parts failed. */
  failed?: boolean;
}): Resolved | null {
  const { id, show, card, row, parts, range, now } = input;
  const W = SERVER_PART_WORDS;
  if (!card?.id) {
    const gone = serverView({ ...input, line: null, card: undefined, row: undefined });
    return {
      ...gone,
      view: { ...gone.view, title: W[show].name, name: screenText(input.serverId, 40) || 'server' },
    };
  }
  const base = {
    id,
    title: W[show].name,
    name: screenText(card.name, 40) || card.id,
    mark: card.mark,
    tone: TONES[card.state],
  };
  const resolved = (view: DeskWidgetView, isPrivate = false): Resolved => ({
    view,
    private: isPrivate,
    refreshS: SERVER_REFRESH_S,
  });
  const text = (body: string, tone: DeskViewTone = base.tone): Resolved =>
    resolved({ kind: 'text', ...base, tone, body });
  if (card.state === 'off') return text(W.off, 'off');
  if (!row || !parts) return input.failed ? text(fillDeskWords(W.failed, { name: base.name })) : null;

  const page = deskServerPage({ ...parts, row, card, range, now, titles: true });
  const ranged = W.ranges[range];
  switch (show) {
    case 'cpu': {
      const cpu = page.cpu;
      const line = serverLineOf(parts.series, range, now);
      const stats = serverStats(line, range, input.timeZone);
      const rest = [
        cpu?.cores ? fillDeskWords(W.cores, { n: cpu.cores }) : '',
        cpu?.load ? fillDeskWords(W.load, { n: cpu.load }) : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return resolved({
        kind: 'chart',
        ...base,
        ...(cpu
          ? {
              figure: {
                value: `${cpu.percent} %`,
                ...(rest ? { rest: screenText(rest, 60) } : {}),
                ...(notOk(cpu.tone) ? { tone: cpu.tone } : {}),
              },
            }
          : {}),
        series: [{ points: points(page.history.cpu, Math.round), tone: 'ok' }],
        unit: '%',
        stats: [screenText(stats ? `${ranged} · ${stats}` : ranged, 80)],
      });
    }
    case 'memory': {
      const mem = page.memory;
      const avg = page.history.memoryAvg;
      return resolved({
        kind: 'chart',
        ...base,
        ...(mem
          ? {
              figure: {
                value: `${mem.percent} %`,
                rest: screenText(
                  fillDeskWords(W.memoryOf, { used: `${mem.used.value} ${mem.used.unit}`, total: mem.total }),
                  60,
                ),
                ...(notOk(mem.tone) ? { tone: mem.tone } : {}),
              },
            }
          : {}),
        series: [{ points: points(page.history.memory, Math.round), tone: 'ok' }],
        unit: '%',
        stats: [screenText(avg === null ? ranged : `${ranged} · ${fillDeskWords(W.memoryAvg, { avg })}`, 80)],
      });
    }
    case 'network': {
      const rx = parts.series?.series.net_rx_mbps ?? [];
      const tx = parts.series?.series.net_tx_mbps ?? [];
      if (!page.network && rx.length === 0 && tx.length === 0) return text(W.noNetwork);
      return resolved({
        kind: 'chart',
        ...base,
        ...(page.network
          ? { figure: { value: `↓ ${page.network.down}`, rest: `↑ ${page.network.up}` } }
          : {}),
        series: [
          { label: W.in, points: points(rx, tenth) },
          { label: W.out, points: points(tx, tenth) },
        ],
        unit: 'Mb/s',
        stats: [ranged],
      });
    }
    case 'storage': {
      const disk = page.disk;
      const rows: DeskViewRow[] = page.volumes.map((v) => ({
        title: v.name,
        detail: screenText(
          [v.note, fillDeskWords(W.memoryOf, { used: v.used, total: v.total })].filter(Boolean).join(' · '),
          120,
        ),
        meta: `${v.percent} %`,
        progress: v.percent,
        ...(notOk(v.tone) ? { tone: v.tone } : {}),
      }));
      if (!disk && rows.length === 0) return text(W.noStorage);
      return resolved({
        kind: 'list',
        ...base,
        ...(disk
          ? { head: screenText(fillDeskWords(W.used, { used: disk.used, total: disk.total }), 80) }
          : {}),
        ...(disk ? { progress: disk.percent } : {}),
        rows,
        empty: W.noStorage,
      });
    }
    case 'guests': {
      const guests = page.guests;
      if (!guests) return text(W.noGuests);
      const rows: DeskViewRow[] = guests.items.map((g) => {
        const on = g.state === 'running' || g.state === 'unhealthy';
        const meta = on
          ? g.cpu !== null
            ? `${g.cpu} %`
            : g.memory
          : g.state === 'paused'
            ? W.paused
            : W.stopped;
        return {
          title: g.name,
          detail: g.kind === 'vm' ? W.vm : W.container,
          state: on ? 'on' : 'off',
          ...(meta ? { meta } : {}),
          // Running and fine is green, not a lamp's amber.
          ...(g.state === 'unhealthy' ? { tone: 'warn' as const } : on ? { tone: 'ok' as const } : {}),
        };
      });
      const total = guests.running + guests.off;
      return resolved({
        kind: 'list',
        ...base,
        head: guests.off
          ? fillDeskWords(W.runningOff, { n: guests.running, off: guests.off })
          : fillDeskWords(W.running, { n: guests.running }),
        rows,
        ...(total > rows.length ? { count: total } : {}),
        empty: W.noGuests,
      });
    }
    case 'temp': {
      const sensors = parts.detail.sensors
        .filter(
          (s): s is typeof s & { nowC: number } => typeof s.nowC === 'number' && Number.isFinite(s.nowC),
        )
        .sort((a, b) => b.nowC - a.nowC)
        .slice(0, 4);
      const hottest = sensors[0];
      const limit = page.temp?.limit ?? Math.round(hottest?.limitC ?? 85);
      const items: DeskViewFigure[] = sensors.map((s) => {
        const value = Math.round(s.nowC);
        const tone = tempTone(value, typeof s.limitC === 'number' ? s.limitC : null);
        return {
          value: String(value),
          unit: '°C',
          label: screenText(s.label, 40) || W.hottest,
          ...(notOk(tone) ? { tone } : {}),
        };
      });
      if (items.length === 0 && page.temp)
        items.push({
          value: String(page.temp.value),
          unit: '°C',
          label: W.hottest,
          ...(notOk(page.temp.tone) ? { tone: page.temp.tone } : {}),
        });
      const first = items[0];
      if (!first) return text(W.noTemp);
      // The hottest big with how close it is to too hot; the others under it.
      return resolved({
        kind: 'figures',
        ...base,
        items,
        progress: Math.max(0, Math.min(100, Math.round((Number(first.value) / Math.max(1, limit)) * 100))),
        line: screenText(`${first.label} · ${fillDeskWords(W.hotFrom, { n: limit })}`, 120),
      });
    }
    case 'alerts': {
      const { rows, count } = serverAlertRows(parts.alerts, card.id, now, input.timeZone);
      return resolved(
        {
          kind: 'list',
          ...base,
          rows,
          ...(count > rows.length ? { count } : {}),
          empty: W.noAlerts,
        },
        true,
      );
    }
  }
}
