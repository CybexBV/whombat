/**
 * Remote help on the desk (Whombat RH-04, RH-12; appliance CG-290…CG-292, CG-295…CG-297): while an owner lets Whombat
 * support in, the top bar's “Remote” chip says so, and its sheet has Stop, locked or not. It is the desk state's
 * `remoteHelp` (contracts 0.120.0 `DeskRemoteHelp`), absent while off; the console server checked and cleaned it (Go
 * `desk.RemoteHelp`).
 *
 * The words are core's `REMOTE_HELP_WORDS.desk`, its title and its levels, and the line is `remoteHelpDeskLine`
 * (`@whombat/core` domain/remote-help.ts, contracts 0.120.0), copied with the same keys because the page can't import
 * the contracts; `remoteHelp.test.ts` checks each word against the vendored source (`vendor/whombat-contracts/remote-help.ts`).
 */
import { clockText } from './deskCopy';

export const REMOTE_HELP_LEVELS = ['look', 'fix'] as const;
export type RemoteHelpLevel = (typeof REMOTE_HELP_LEVELS)[number];

/** `DeskRemoteHelp`: the level, until when (null: forever), who is connected now (null: nobody). */
export interface RemoteHelp {
  level: RemoteHelpLevel;
  until: string | null;
  connected: string | null;
}

/** The contracts' words (copied). */
export const REMOTE_HELP_DESK_WORDS = {
  on: 'Remote help is on · until {time}',
  onForever: 'Remote help is on · forever',
  connected: '{who} is connected',
  stop: 'Stop',
} as const;

/** The contracts' title and level words (`REMOTE_HELP_WORDS.title`, `.levels`; copied). */
export const REMOTE_HELP_TITLE = 'Remote help';
export const REMOTE_HELP_LEVEL_WORDS = {
  look: {
    label: 'Look',
    hint: 'Read its logs, status, hardware and network. They can’t change anything or see your chats, files or Vault.',
  },
  fix: {
    label: 'Look and fix',
    hint: 'Also restart parts, change settings and run commands. This lets them see everything on this Whombat.',
  },
} as const satisfies Record<RemoteHelpLevel, { label: string; hint: string }>;

/** The page's own: the chip's word (CG-295), the sheet's title and Close, Stop's label for a screen reader. */
export const REMOTE_HELP_PAGE_WORDS = {
  chip: 'Remote',
  title: REMOTE_HELP_TITLE,
  close: 'Close',
  stopLabel: 'Stop remote help',
} as const;

/** A name as the page may draw it: one line, at most 40 characters (the server cleaned it already). */
function who(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  const cps = [...t];
  return cps.length > 40 ? cps.slice(0, 40).join('') : t;
}

/** `/api/state`'s `remoteHelp`: null when off, or anything the page doesn't understand. */
export function parseRemoteHelp(v: unknown): RemoteHelp | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const level = REMOTE_HELP_LEVELS.find((l) => l === o.level);
  if (!level) return null;
  let until: string | null = null;
  if (o.until !== null) {
    if (typeof o.until !== 'string' || !Number.isFinite(Date.parse(o.until))) return null;
    until = o.until;
  }
  return { level, until, connected: who(o.connected) };
}

const fill = (t: string, values: Record<string, string>) =>
  t.replace(/\{([a-z]+)\}/g, (hole, k: string) => values[k] ?? hole);

const dayFormats = new Map<string, Intl.DateTimeFormat>();
function dayFormat(timeZone: string): Intl.DateTimeFormat {
  let f = dayFormats.get(timeZone);
  if (!f) {
    const o: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
    };
    try {
      f = new Intl.DateTimeFormat('en-GB', { ...o, timeZone });
    } catch {
      f = new Intl.DateTimeFormat('en-GB', { ...o, timeZone: 'UTC' });
    }
    dayFormats.set(timeZone, f);
  }
  return f;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The calendar day in the zone: its number (for differences), the weekday's short name, the date's parts. */
function day(ms: number, timeZone: string) {
  const parts = dayFormat(timeZone).formatToParts(ms);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const y = n('year');
  const m = n('month');
  const d = n('day');
  return {
    number: Date.UTC(y, m - 1, d) / 86_400_000,
    weekday: parts.find((p) => p.type === 'weekday')?.value ?? '',
    year: y,
    text: `${d} ${MONTHS[m - 1] ?? ''}`,
  };
}

/**
 * When a grant ends, on the person's clock (`remoteHelpUntilText`): today the time (“14:00”), “tomorrow 14:00”, else
 * “Thu 23 Oct, 14:00” (with the year when it isn't this one).
 */
export function untilText(untilMs: number, nowMs: number, timeZone: string): string {
  const clock = clockText(untilMs, timeZone);
  const u = day(untilMs, timeZone);
  const n = day(nowMs, timeZone);
  const days = u.number - n.number;
  if (days <= 0) return clock;
  if (days === 1) return `tomorrow ${clock}`;
  return `${u.weekday} ${u.text}${u.year !== n.year ? ` ${u.year}` : ''}, ${clock}`;
}

/** The line (`remoteHelpDeskLine`): “Remote help is on · until 14:00”, “… · until tomorrow 14:00”, “… · forever”. */
export function remoteHelpLine(h: RemoteHelp, nowMs: number, timeZone: string): string {
  const until = h.until === null ? Number.NaN : Date.parse(h.until);
  return Number.isFinite(until)
    ? fill(REMOTE_HELP_DESK_WORDS.on, { time: untilText(until, nowMs, timeZone) })
    : REMOTE_HELP_DESK_WORDS.onForever;
}

/** “Support is connected”, or null while nobody is. */
export function remoteHelpConnected(h: RemoteHelp): string | null {
  return h.connected === null ? null : fill(REMOTE_HELP_DESK_WORDS.connected, { who: h.connected });
}

/** The level and what it lets support do: “Look and fix”, “Also restart parts, …”. */
export function remoteHelpLevel(h: RemoteHelp): { label: string; hint: string } {
  return REMOTE_HELP_LEVEL_WORDS[h.level];
}

/** The chip's accessible name: the line, and who is connected (“Remote help is on · forever. Claude from …”). */
export function remoteHelpChipLabel(h: RemoteHelp, nowMs: number, timeZone: string): string {
  return [remoteHelpLine(h, nowMs, timeZone), remoteHelpConnected(h)].filter(Boolean).join('. ');
}
