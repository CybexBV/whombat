/**
 * A server as a widget (docs/decisions/desk-display.md DK-139, DK-148): its state and words as the strip's, its
 * processor, memory and disk now from the fleet the glance reads, what it is (“Proxmox · 16 cores”), how long it's been
 * up, and its processor over the widget's range (`opts.range`, 24 hours unless chosen) as a line of at most 48 points
 * with its average and its peak. The figures are read again every 15 s; the line as often as its range changes enough
 * to see. A server that's no longer in the fleet says so.
 */
import {
  DESK_CALM_WORDS,
  DESK_WIDGET_RANGES,
  type DeskServerRange,
  type DeskViewTone,
  type DeskWidgetView,
  fillDeskWords,
  type HostSeries,
  type HostServer,
} from '@whombat/core';
import { HOSTS_API, seg } from '../../hosts/client';
import { toHostSeries } from '../../hosts/map';
import { type HostsService, WHOMBAT_ACTOR } from '../../hosts/service';
import { DESK_HOSTS_WAIT_MS, screenText, within } from '../glance';
import { serverLine } from '../options';
import { downsample, serverHistory } from '../server-page';
import type { DeskServer } from '../shapes';
import { clockIn } from './own';
import type { Resolved } from './types';

/** A server widget's figures are read again this often (DK-148). */
export const SERVER_REFRESH_S = 15;
/** The most points of its line. */
export const SERVER_SPARK_POINTS = 48;
/** How long its line over each range is kept before it's read again. */
export const SERVER_HISTORY_KEEP_MS: Readonly<Record<DeskServerRange, number>> = {
  '1h': 60_000,
  '24h': 5 * 60_000,
  '7d': 30 * 60_000,
};

export const SERVER_WIDGET_WORDS = {
  gone: '{name} isn’t one of your servers any more.',
  unreachable: 'I can’t reach your servers right now.',
  stats: 'Avg {avg} % · Peak {peak} % {when}',
  up: {
    minute: 'Up 1 minute',
    minutes: 'Up {n} minutes',
    hour: 'Up 1 hour',
    hours: 'Up {n} hours',
    day: 'Up 1 day',
    days: 'Up {n} days',
  },
} as const;

/** The widget's range: its own choice, else 24 hours. */
export function serverRange(opts: Readonly<Record<string, string>>): DeskServerRange {
  const range = opts.range;
  return (DESK_WIDGET_RANGES as readonly string[]).includes(range ?? '') ? (range as DeskServerRange) : '24h';
}

/** “Up 21 days”, “Up 5 hours”, “Up 12 minutes”. */
export function uptimeWords(seconds: number): string {
  const w = SERVER_WIDGET_WORDS.up;
  if (seconds >= 86_400) {
    const n = Math.floor(seconds / 86_400);
    return n === 1 ? w.day : fillDeskWords(w.days, { n });
  }
  if (seconds >= 3_600) {
    const n = Math.floor(seconds / 3_600);
    return n === 1 ? w.hour : fillDeskWords(w.hours, { n });
  }
  const n = Math.max(1, Math.floor(seconds / 60));
  return n === 1 ? w.minute : fillDeskWords(w.minutes, { n });
}

const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** Why a server isn't fine, in the strip's words (“off”, “disk 91 %”, its card's note); none when it is. */
export function serverSay(card: DeskServer): string | undefined {
  const w = DESK_CALM_WORDS.strip;
  if (/updat|restart|install/i.test(card.note) && card.state !== 'off') return w.updating;
  if (card.state === 'off') return w.off;
  if (card.state === 'ok') return undefined;
  if (card.note && !/^(up|ok)\b/i.test(card.note)) return screenText(lower(card.note), 40) || undefined;
  if ((card.disk?.value ?? 0) >= 85) return fillDeskWords(w.disk, { n: card.disk?.value ?? 0 });
  if ((card.cpu?.value ?? 0) >= 75) return fillDeskWords(w.cpu, { n: card.cpu?.value ?? 0 });
  if ((card.memory?.value ?? 0) >= 80) return fillDeskWords(w.memory, { n: card.memory?.value ?? 0 });
  return card.state === 'bad' ? w.notAnswering : undefined;
}

/** A server's processor over a range, as the widget draws it. */
export interface ServerLine {
  spark: number[];
  avg: number | null;
  peak: { percent: number; at: string } | null;
}

/** The line of a server's processor over `range` (at most `SERVER_SPARK_POINTS`), its average and its peak. */
export function serverLineOf(series: HostSeries | null, range: DeskServerRange, now: Date): ServerLine {
  const history = serverHistory(series, range, now);
  const measured = history.cpu.filter((p): p is number => p !== null);
  const spark = downsample(history.cpu, SERVER_SPARK_POINTS)
    .points.filter((p): p is number => p !== null && Number.isFinite(p))
    .map((p) => Math.max(0, Math.min(100, Math.round(p))));
  return {
    spark,
    avg: measured.length ? Math.round(measured.reduce((a, p) => a + p, 0) / measured.length) : null,
    peak: history.cpuPeak,
  };
}

/** “Avg 14 % · Peak 63 % Sun 03:10”: the peak at its hour, with its day beyond an hour's range. */
export function serverStats(line: ServerLine, range: DeskServerRange, timeZone: string): string | null {
  if (line.avg === null || !line.peak) return null;
  const at = new Date(line.peak.at);
  const clock = clockIn(at, timeZone);
  let when = clock;
  if (range !== '1h') {
    try {
      when = `${new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone }).format(at)} ${clock}`;
    } catch {
      when = clock;
    }
  }
  return screenText(
    fillDeskWords(SERVER_WIDGET_WORDS.stats, { avg: line.avg, peak: line.peak.percent, when }),
    80,
  );
}

/** Reads a server's processor over `range` from the hosts service, as Whombat. */
export async function readServerLine(
  hosts: Pick<HostsService, 'call'>,
  id: string,
  range: DeskServerRange,
  now: Date,
  ms = DESK_HOSTS_WAIT_MS,
): Promise<ServerLine> {
  const raw = await within(
    hosts.call<unknown>({
      path: `${HOSTS_API}/servers/${seg(id)}/metrics`,
      query: { range, series: 'cpu_pct' },
      actor: WHOMBAT_ACTOR,
      timeoutMs: ms,
    }),
    ms,
  );
  return serverLineOf(toHostSeries(raw, id, null, now), range, now);
}

const TONES: Record<DeskServer['state'], DeskViewTone> = { ok: 'ok', warn: 'warn', bad: 'bad', off: 'off' };

/**
 * A server widget's view: the fleet's card and row for it (none: it isn't in the fleet any more), its line when read.
 * `unreachable`: the fleet couldn't be read, so a server not found may still be there.
 */
export function serverView(input: {
  id: string;
  serverId: string;
  card: DeskServer | undefined;
  row: HostServer | undefined;
  line: ServerLine | null;
  range: DeskServerRange;
  timeZone: string;
  unreachable?: boolean;
}): Resolved {
  const { id, card, row, line, range } = input;
  if (!card?.id) {
    const name = screenText(input.serverId, 60) || 'server';
    const view: DeskWidgetView = {
      kind: 'text',
      id,
      title: name,
      tone: 'off',
      body: input.unreachable
        ? SERVER_WIDGET_WORDS.unreachable
        : fillDeskWords(SERVER_WIDGET_WORDS.gone, { name }),
      problem: {
        text: input.unreachable
          ? SERVER_WIDGET_WORDS.unreachable
          : screenText(fillDeskWords(SERVER_WIDGET_WORDS.gone, { name }), 120),
      },
    };
    return { view, private: false, refreshS: SERVER_REFRESH_S };
  }
  const off = card.state === 'off';
  const say = serverSay(card);
  const what = row ? serverLine(row) : '';
  const stats = line && !off ? serverStats(line, range, input.timeZone) : null;
  const uptime = !off && row?.uptimeS && row.uptimeS > 0 ? uptimeWords(row.uptimeS) : '';
  const view: DeskWidgetView = {
    kind: 'server',
    id,
    title: screenText(card.name, 60) || card.id,
    mark: card.mark,
    tone: TONES[card.state],
    state: card.state,
    server: card.id,
    range,
    ...(what ? { line: screenText(what, 80) } : {}),
    ...(say ? { say: screenText(say, 40) } : {}),
    ...(!off && card.cpu ? { cpu: card.cpu.value } : {}),
    ...(!off && card.memory ? { memory: card.memory.value } : {}),
    ...(!off && card.disk ? { disk: card.disk.value } : {}),
    ...(line && line.spark.length > 0 ? { spark: line.spark } : {}),
    ...(stats ? { stats: [stats] } : {}),
    ...(uptime ? { uptime } : {}),
  };
  return { view, private: false, refreshS: SERVER_REFRESH_S };
}
