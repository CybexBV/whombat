/**
 * A server's own screen and every server (Whombat desk-display.md DK-83…DK-87; appliance CG-250…): its header's state
 * and line, the four figures (the card's while the first answer comes), the chart's times, the storage and guests'
 * lines, and where a swipe goes. Pure: the page's clock and the person's time zone come in.
 */
import {
  type DeskGuest,
  type DeskServer,
  type DeskServerPage,
  type DeskVolume,
  RANGE_S,
  type ServerRange,
  type Tone,
} from './desk';
import { clockText, DESK_WORDS, fill, localTime, percent, weekdayText } from './deskCopy';

const W = DESK_WORDS.server;

/** A swipe goes to the next or the previous server past this (layout px), when it is more across than down (DK-83). */
export const SWIPE_PX = 60;
/** The figures refresh this often while the screen shows (DK-83). */
export const SERVER_REFRESH_MS = 10_000;
/** Dots under the screen while they fit (44 px each); more servers say “5 of 24” instead. */
export const DOTS_MAX = 12;
/** The temperature's bar: 90° fills it, or the server's limit when that is higher. */
export const TEMP_BAR_MAX = 90;
/** The figure cards' bars (24 segments) and a volume's (30). */
export const FIGURE_SEGMENTS = 24;
export const VOLUME_SEGMENTS = 30;

/** A move across the screen that is a swipe, not a touch: past 60 px, more across than down. */
export const isSwipe = (dx: number, dy: number): boolean =>
  Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy);

/** Where a swipe from `index` goes: the next (to the left) or the previous (to the right), none past either end. */
export function swipeTo(index: number, length: number, dx: number, dy: number): number | null {
  if (!isSwipe(dx, dy)) return null;
  const next = dx < 0 ? index + 1 : index - 1;
  return next >= 0 && next < length ? next : null;
}

/** The header's state on the right (DK-83): “All fine”, the alerts counted, or the card's note in its tone. */
export interface HeadState {
  text: string;
  tone: Tone | 'off';
}

export function headState(server: DeskServer, alerts: DeskServerPage['alerts'] | null): HeadState | null {
  if (alerts && alerts.count > 0) {
    const bad = server.state === 'bad' || alerts.items.some((a) => a.tone === 'bad');
    return {
      text: alerts.count === 1 ? W.alertsOne : fill(W.alertsMany, { n: alerts.count }),
      tone: bad ? 'bad' : 'warn',
    };
  }
  if (server.state === 'ok') return { text: W.allFine, tone: 'ok' };
  return server.note ? { text: server.note, tone: server.state } : null;
}

/** The line under the name: “Proxmox VE 9.0.10 · 16 cores · up 41 d”, what is known of it. */
export function subLine(page: DeskServerPage | null): string {
  if (!page) return '';
  const n = page.cpu?.cores;
  const cores = n === 1 ? W.coresOne : n ? fill(W.cores, { n }) : '';
  return [page.os, cores, page.up].filter(Boolean).join(' · ');
}

/** One of the four figure cards: the big value and its unit, the note on the right, the bar. */
export interface Figure {
  value: string;
  unit: string;
  note: string;
  tone: Tone;
  bar: { value: number; max: number } | null;
}

const NONE: Figure = { value: DESK_WORDS.card.none, unit: '', note: '', tone: 'ok', bar: null };

export interface Figures {
  cpu: Figure;
  memory: Figure;
  disk: Figure;
  temp: Figure;
}

/**
 * The four figures (DK-83): the page's, or while its first answer comes the card's (no spinner: the percentages and
 * the temperature the glance had). An off server's are “–”.
 */
export function figuresOf(server: DeskServer, page: DeskServerPage | null): Figures {
  if (server.state === 'off' && (!page || page.server.state === 'off'))
    return { cpu: NONE, memory: NONE, disk: NONE, temp: NONE };
  if (!page) {
    const pct = (m: DeskServer['cpu'] | undefined): Figure =>
      m
        ? { ...NONE, value: String(m.value), unit: '%', tone: m.tone, bar: { value: m.value, max: 100 } }
        : NONE;
    const t = server.temp;
    return {
      cpu: pct(server.cpu),
      memory: pct(server.memory),
      disk: pct(server.disk),
      temp: t
        ? {
            ...NONE,
            value: String(t.value),
            unit: '°C',
            tone: t.tone,
            bar: { value: t.value, max: TEMP_BAR_MAX },
          }
        : NONE,
    };
  }
  const { cpu, memory, disk, temp } = page;
  return {
    cpu: cpu
      ? {
          value: String(cpu.percent),
          unit: '%',
          note: cpu.load ? fill(W.load, { n: cpu.load }) : '',
          tone: cpu.tone,
          bar: { value: cpu.percent, max: 100 },
        }
      : NONE,
    memory: memory
      ? {
          value: memory.used.value,
          unit: memory.used.unit,
          note: fill(W.memoryOf, { total: memory.total }),
          tone: memory.tone,
          bar: { value: memory.percent, max: 100 },
        }
      : NONE,
    disk: disk
      ? {
          value: String(disk.percent),
          unit: '%',
          note: fill(W.diskOf, { used: disk.used, total: disk.total }),
          tone: disk.tone,
          bar: { value: disk.percent, max: 100 },
        }
      : NONE,
    temp: temp
      ? {
          value: String(temp.value),
          unit: '°C',
          note: fill(W.tempNote, { tone: DESK_WORDS.box.tones[temp.tone], n: temp.limit }),
          tone: temp.tone,
          bar: { value: temp.value, max: Math.max(TEMP_BAR_MAX, temp.limit) },
        }
      : NONE,
  };
}

/** Whether the chart has anything to draw. */
export const hasPoints = (h: DeskServerPage['history']): boolean =>
  [...h.cpu, ...h.memory].some((p) => p !== null);

/** A time under the chart: where it lies (0 = the range ago, 1 = now) and what it says. */
export interface Tick {
  at: number;
  label: string;
}

/** The chart's foot (DK-83): the start, the times between (every 15 minutes, 6 hours or day) and “now”. */
export interface ChartFoot {
  start: string;
  ticks: Tick[];
  end: string;
}

/**
 * The chart's width at the 1280×800 stage (layout px; wider stages only have more room) and a time's advance per
 * character (DM Mono at 12.5 px: 0.6 em), so a time is kept only where it can't touch its neighbours.
 */
const FOOT_PX = 776;
const CHAR_PX = 7.5;
const FOOT_GAP = 16;

/** The chart's times for a range ending at `nowMs`, on the person's clock. */
export function chartFoot(range: ServerRange, nowMs: number, timeZone: string): ChartFoot {
  const span = RANGE_S[range] * 1000;
  const start = nowMs - span;
  const startLabel =
    range === '1h'
      ? DESK_WORDS.box.hourAgo
      : range === '24h'
        ? fill(W.yesterday, { time: clockText(start, timeZone) })
        : `${weekdayText(start, timeZone)} ${clockText(start, timeZone)}`;
  const end = DESK_WORDS.box.now;
  const step = range === '1h' ? 60_000 : 15 * 60_000;
  const ticks: Tick[] = [];
  let free = startLabel.length * CHAR_PX + FOOT_GAP;
  const last = FOOT_PX - end.length * CHAR_PX - FOOT_GAP;
  for (let t = Math.ceil(start / step) * step; t <= nowMs; t += step) {
    const { hour, minute } = localTime(t, timeZone);
    const due =
      range === '1h'
        ? minute % 15 === 0
        : range === '24h'
          ? minute === 0 && hour % 6 === 0
          : minute === 0 && hour === 0;
    if (!due) continue;
    const label = range === '7d' ? weekdayText(t, timeZone) : clockText(t, timeZone);
    const at = (t - start) / span;
    const half = (label.length * CHAR_PX) / 2;
    if (at * FOOT_PX - half < free || at * FOOT_PX + half > last) continue;
    ticks.push({ at, label });
    free = at * FOOT_PX + half + FOOT_GAP;
  }
  return { start: startLabel, ticks, end };
}

/** When the processor peaked: its clock time, with the day on the week's chart. */
export function peakTime(range: ServerRange, atMs: number, timeZone: string): string {
  const clock = clockText(atMs, timeZone);
  return range === '7d' ? `${weekdayText(atMs, timeZone)} ${clock}` : clock;
}

/** The chart's legend: “CPU · peak 61 % at 03:10”, “Memory · avg 52 %”, or the bare names without points. */
export function legend(page: DeskServerPage, timeZone: string): { cpu: string; memory: string } {
  const h = page.history;
  return {
    cpu: h.cpuPeak
      ? fill(W.cpuPeak, { n: h.cpuPeak.percent, time: peakTime(h.range, Date.parse(h.cpuPeak.at), timeZone) })
      : W.cpu,
    memory: h.memoryAvg === null ? W.memory : fill(W.memoryAvg, { n: h.memoryAvg }),
  };
}

/** A volume's line on the right: “nvme mirror · 41 %”, or “1.2 TB of 3.6 TB · 41 %” without a note. */
export const volumeNote = (v: DeskVolume): string =>
  `${v.note || fill(W.diskOf, { used: v.used, total: v.total })} · ${percent(v.percent)}`;

/** A guest's dot: running green, unhealthy amber, stopped or paused grey. */
export function guestTone(g: DeskGuest): 'ok' | 'warn' | 'off' {
  if (g.state === 'running') return 'ok';
  return g.state === 'unhealthy' ? 'warn' : 'off';
}

/** A guest's processor column: its share, else its state's word (“off”, “paused”) as the contracts say. */
export function guestCpu(g: DeskGuest): string {
  return g.cpu === null || g.state === 'stopped' ? W.guestStates[g.state] : percent(g.cpu);
}
