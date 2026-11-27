/**
 * A server's lines as Whombat watches them (quiet-notices.md QN-01…QN-04, QN-14, QN-22, QN-23; QN-S50…QN-S59). Each
 * alert and hint of the hosts service, and Whombat's own two about a server's agent, gets its check, item, kind of line
 * and Ignore words from the contract's `HOST_WATCH_CHECKS`. An alert is quiet in the hosts service: acknowledged
 * (ignored until it resolves, or snoozed), muted by maintenance or held back while the server it runs on is offline. A
 * hint is quiet in Whombat's own rows. A server comes to its dot, its reason and the line behind them (the desk's look)
 * from the alerts that ask for attention and the hints that nobody quieted. Heads-ups never count. Pure.
 */
import {
  type HostAlert,
  type HostHint,
  type HostServer,
  type HostServerStatus,
  type HostWatchCheck,
  hostAlertCheck,
  hostEntityName,
  hostHintCheck,
  hostHintNature,
  hostNoticeSubjectId,
  hostWatchCheckWords,
  type NoticeQuiet,
  type NoticeSubject,
  quietWordsOf,
} from '@whombat/core';
import { tServer } from '../i18n/catalog';
import { applyQuiet, type QuietRow } from '../things/quiet/apply';
import { notWatched } from '../things/quiet/defaults';
import type { GlanceNotice } from '../things/quiet/glance';
import { shortHash } from '../things/quiet/items';
import { NO_QUIET, type ThingQuiet } from '../things/quiet/store';
import type { NoticeIgnore, NoticeNature } from '../things/quiet/types';
import type { WindowLike as QuietWindowLike } from '../things/quiet/windows';
import { englishOf } from './localize';

/** The rule of the alert that says a server stopped reporting. */
export const HEARTBEAT_RULE = 'agent.heartbeat_missing';

/** Alert rules that belong to no server (the hub's checks, refused requests): not a server's to switch off. */
export const HUB_LEVEL = (rule: string) => rule.startsWith('check.') || rule.startsWith('security.');

/** A server's thing id, whose quiet rows and offs are Whombat's (hints). */
export const serverThingId = (serverId: string) => `server:${serverId}`;

/** A hint's id on Watch (its `hint` ref): the server, the kind and the item, which Ignore finds it by again. */
export const hintRefId = (h: Pick<HostHint, 'serverId' | 'kind' | 'entity'>) =>
  `${h.serverId}:${h.kind}:${h.entity}`.slice(0, 200);

/* Items ------------------------------------------------------------------------------------------------------------ */

/** A hint's entity: its own, else its id without `<kind>:` (a hub that sent only the id). */
export function hintEntity(h: Pick<HostHint, 'kind' | 'entity' | 'id'>): string {
  if (h.entity) return h.entity;
  return h.id?.startsWith(`${h.kind}:`) ? h.id.slice(h.kind.length + 1) : '';
}

/** A hint's id on its server, `<kind>:<entity>` (hosts HS-192); an older hub's joined the same way. */
export function hintId(h: Pick<HostHint, 'kind' | 'entity' | 'id'>): string {
  return h.id || `${h.kind}:${h.entity}`;
}

/** The item a line is about (QN-03), keyed as the web client keys it: `hostNoticeSubjectId`. */
function subjectOf(c: HostWatchCheck, entity: string | undefined): NoticeSubject | undefined {
  const id = hostNoticeSubjectId(c, entity);
  if (!id) return undefined;
  const name =
    c.rule === 'guest.stopped' ? id.replace(/^(docker|libvirt)\//, '') : hostEntityName(entity ?? id);
  return { id, name: (name || id).slice(0, 80) };
}

/**
 * The guests a folded hint lists (“web (12 days), dns (failed), …”), by name; null when it was cut short. What follows
 * “ · ” is said about them all (`incus.no_snapshots`: “web, db · no backup in 30 days either”).
 */
export function hintGuestNames(detail: string): string[] | null {
  // A list said in a language joins its last name with a word (“web, dns en db”, “web and db”).
  const names = (detail.split(' · ')[0] ?? '')
    .split(/, | en /)
    .map((n) => n.replace(/\s*\([^)]*\)$/, '').trim())
    .filter(Boolean);
  return names.includes('…') || names.some((n) => n.endsWith('…')) ? null : names;
}

/** Hints that list items: “until another one” is a different set of them (QN-03, QN-11). */
const LISTS = new Set([
  'guests.unhealthy',
  'system.failed_units',
  'incus.no_snapshots',
  'libvirt.no_backup',
  'guest.backup_old',
  'guest.no_backup_job',
  'guest.agent_down',
  'guest.pending_changes',
  'guest.snapshot_old',
]);

/** Hints that count something: “until there are more” is a higher count (the line's `band`). */
const COUNTS = new Set([
  'system.updates',
  'docker.image_updates',
  'unraid.plugin_updates',
  'docker.update_available',
  'memory.limit',
]);

/** The first whole number of a text (“12 updates waiting” → 12; “A process …” → 1). */
export function countOf(text: string): number {
  // Thousands are grouped with a comma in English and a dot (or a narrow space) in Dutch: “1,204” and “1.204”.
  const m = /\d+/.exec(text.replace(/(?<=\d)[,.\u00a0\u202f](?=\d{3}\b)/g, ''));
  return m ? Number(m[0]) : 1;
}

/**
 * What a hint's Ignore compares (QN-11, QN-S52): nothing for one that lasts until it is fixed; for one until something
 * newer, the set of items it lists (the hub's guest ids, else the names in its detail), the count it says (`band`: only
 * more ends it), else its words.
 */
export function hintEpisode(
  c: HostWatchCheck,
  h: Pick<HostHint, 'kind' | 'title' | 'detail'>,
  guests?: readonly string[],
): { episode?: string; band?: number } {
  if (c.lifts !== 'newer') return {};
  // The hub's English when its words were said in another language: an Ignore outlasts a change of language.
  const en = englishOf(h) ?? h;
  if (COUNTS.has(h.kind)) return { band: countOf(en.title) };
  if (LISTS.has(h.kind)) {
    const names = guests?.length ? [...guests] : hintGuestNames(en.detail);
    if (names?.length) return { episode: shortHash(names) };
  }
  return { episode: shortHash([en.title, en.detail]) };
}

/* Lines ------------------------------------------------------------------------------------------------------------ */

/** A server's line as `applyQuiet` reads it, with what it came from. */
export interface ServerLine {
  check: string;
  subject?: NoticeSubject;
  tone: 'bad' | 'warn' | 'info';
  nature: NoticeNature;
  title: string;
  ignore: NoticeIgnore;
  episode?: string;
  band?: number;
  alert?: HostAlert;
  hint?: HostHint;
}

/** Whether an open alert asks for attention: not acknowledged, muted or suppressed. */
export function asksAttention(a: Pick<HostAlert, 'state' | 'attention'>): boolean {
  return a.state === 'open' && a.attention;
}

export function alertLine(a: HostAlert, locale?: string | null): ServerLine {
  const c = hostAlertCheck(a.rule);
  const subject = subjectOf(c, a.entity);
  return {
    check: c.check,
    ...(subject ? { subject } : {}),
    tone: a.severity === 'critical' ? 'bad' : 'warn',
    nature: c.nature,
    title: a.title.slice(0, 120) || tServer(locale, 'home.hosts.alert'),
    ignore: { lifts: c.lifts, words: c.words },
    alert: a,
  };
}

export function hintLine(h: HostHint, guests?: readonly string[], locale?: string | null): ServerLine {
  const c = hostHintCheck(h.kind);
  const subject = subjectOf(c, hintEntity(h));
  return {
    check: c.check,
    ...(subject ? { subject } : {}),
    tone: h.severity === 'warning' ? 'warn' : 'info',
    nature: hostHintNature(c, h.severity),
    title: h.title.slice(0, 120) || tServer(locale, 'home.hosts.worthALook'),
    ignore: { lifts: c.lifts, words: c.words },
    ...hintEpisode(c, h, guests),
    hint: h,
  };
}

/* What is quiet ---------------------------------------------------------------------------------------------------- */

/** The hub's `by` of an acknowledgement, “John Doe (prn_…)”, as the person it names; null for anyone else. */
export function hubBy(by: string | null | undefined): { id: string; name: string } | null {
  const m = /^(.*\S)\s+\((prn_[A-Za-z0-9_-]+)\)$/.exec((by ?? '').trim());
  return m?.[1] && m[2] ? { id: m[2], name: m[1] } : null;
}

/**
 * An alert's quiet as a line draws it (QN-14, QN-23): acknowledged until it resolves is ignored, with its check's words
 * (“until it’s back online”); with an end, snoozed (“until tomorrow 09:00”, `untilWords`); maintenance and an offline
 * parent are ignored “while it’s in maintenance” / “while … is offline”. Who did it, by their name here (`names`), when
 * the hosts service names a person of this Whombat. None while it asks for attention.
 */
export function alertQuiet(
  a: HostAlert,
  ctx: {
    now: Date;
    names: ReadonlyMap<string, string>;
    untilWords: (until: Date) => string;
    locale?: string | null;
  },
): NoticeQuiet | undefined {
  const locale = ctx.locale;
  if (a.state !== 'open' || a.attention) return undefined;
  const ack = a.acknowledged;
  if (ack) {
    const until = ack.until ? new Date(ack.until) : null;
    const snoozed = until !== null && until.getTime() > ctx.now.getTime();
    const person = hubBy(ack.by);
    const name = person ? (ctx.names.get(person.id) ?? null) : null;
    const words = snoozed
      ? ctx.untilWords(until)
      : quietWordsOf(hostWatchCheckWords(hostAlertCheck(a.rule), locale).words) ||
        tServer(locale, 'hosts.quiet.untilChanges');
    return {
      state: snoozed ? 'snoozed' : 'ignored',
      words: words.slice(0, 60),
      ...(snoozed && until ? { until: until.toISOString() } : {}),
      ...(person && name ? { by: { id: person.id, name } } : {}),
      at: ack.at,
    };
  }
  if (a.muted) return { state: 'ignored', words: tServer(locale, 'hosts.quiet.maintenance'), at: a.openedAt };
  if (a.suppressedBy)
    return {
      state: 'ignored',
      words: tServer(locale, 'hosts.quiet.parentOffline', {
        name: hostEntityName(a.suppressedBy).slice(0, 40),
      }).slice(0, 60),
      at: a.openedAt,
    };
  return undefined;
}

/**
 * An open alert of a server kept quiet, as the server's other lines are: quiet with the window
 * (`held`, its words the window's: “until 23:00”, with who kept it quiet), whether or not the hosts service muted it (a
 * maintenance window it refused shouldn't make the alert loud). Its own Ignore or Remind me tomorrow stays its own; the
 * hub's checks aren't the server's. None without a window.
 */
export function heldAlertQuiet(
  a: HostAlert,
  window: Pick<QuietWindowLike, 'startsAt' | 'endsAt' | 'byId'> | null | undefined,
  ctx: { names: ReadonlyMap<string, string>; untilWords: (until: Date) => string },
): NoticeQuiet | undefined {
  if (!window || a.state !== 'open' || a.acknowledged || HUB_LEVEL(a.rule)) return undefined;
  const name = window.byId ? ctx.names.get(window.byId) : undefined;
  return {
    state: 'snoozed',
    words: ctx.untilWords(window.endsAt).slice(0, 60),
    until: window.endsAt.toISOString(),
    ...(window.byId && name ? { by: { id: window.byId, name } } : {}),
    at: window.startsAt.toISOString(),
    held: 'window',
  };
}

/**
 * Marks an alert with what keeps it quiet: the server's window first (it no longer asks for attention, as when the hub
 * mutes it), else the hub's own reading (`alertQuiet`).
 */
export function markAlertQuiet(
  a: HostAlert,
  window: Pick<QuietWindowLike, 'startsAt' | 'endsAt' | 'byId'> | null | undefined,
  ctx: {
    now: Date;
    names: ReadonlyMap<string, string>;
    untilWords: (until: Date) => string;
    locale?: string | null;
  },
): void {
  const held = heldAlertQuiet(a, window, ctx);
  if (held) {
    a.quiet = held;
    a.attention = false;
    return;
  }
  const quiet = alertQuiet(a, ctx);
  if (quiet) a.quiet = quiet;
}

/** The person ids an alert's acknowledgement names (for their names). */
export function ackPeople(alerts: readonly HostAlert[]): string[] {
  return alerts.flatMap((a) => {
    const p = hubBy(a.acknowledged?.by);
    return p ? [p.id] : [];
  });
}

/**
 * A server's hints with what is quiet about them now: watched ones with their row, the rest left out (switched off, or
 * of a kind that starts off and nobody turned on, watch-defaults.md).
 */
export interface MarkedHints {
  /** Watched hints, each with its quiet row when one holds. */
  hints: { hint: HostHint; line: ServerLine; row: QuietRow | null }[];
  /** Hints of a check (or an item) Whombat doesn't watch. */
  dropped: HostHint[];
}

export function markHints(
  hints: readonly HostHint[],
  quiet: ThingQuiet,
  now: Date,
  guestsOf: (h: HostHint) => readonly string[] | undefined = () => undefined,
): MarkedHints {
  const lines = hints.map((h) => hintLine(h, guestsOf(h)));
  const r = applyQuiet({
    lines,
    quiets: quiet.quiets,
    ...notWatched(quiet),
    states: [],
    now,
    pass: false,
  });
  const rows = new Map(r.quiet.map((q) => [q.line, q.row] as const));
  const dropped = new Set(r.dropped);
  return {
    hints: lines
      .filter((l) => !dropped.has(l))
      .map((l) => ({ hint: l.hint as HostHint, line: l, row: rows.get(l) ?? null })),
    dropped: r.dropped.map((l) => l.hint as HostHint),
  };
}

/* What a server comes to ------------------------------------------------------------------------------------------ */

/** What a server comes to (QN-02, QN-14, QN-23). */
export interface ServerVerdict {
  /** pending and offline as the hosts service says (facts); else from the lines: bad, warn or ok. */
  status: HostServerStatus;
  /** Why it isn't fine: the hosts service's note while it is about the same line, else that line's title. */
  note: string | null;
  /**
   * Whether it shows as not fine (the dot, Watch, Needs you, the desk's look). An offline server whose “offline” alert
   * is quiet (ignored, snoozed, in maintenance, its parent offline) or switched off doesn't, though it stays offline.
   */
  dot: boolean;
  /** The line behind it, for the desk's look. */
  worst: ServerLine | null;
  /** Every line behind it, worst first: what the assistant looks into when it looks into the server. */
  asking: ServerLine[];
  /** Kept quiet until this time: Home's `quietUntil`. */
  quietUntil?: string;
}

/**
 * A server's status and reason from its open alerts and hints (QN-23, QN-S51): an alert counts while it asks for
 * attention and isn't a heads-up, a hint while it is a warning nobody quieted that isn't a heads-up (as the page's “N
 * to look at”); the worst is bad (a critical alert), else warn. Offline stays a fact; whether it shows depends on its
 * “offline” alert. `heartbeatOff`: the hosts service doesn't watch whether this server is online.
 */
export function serverVerdict(input: {
  card: { id: string; status: string; statusNote?: string | null };
  pending: boolean;
  alerts: readonly HostAlert[];
  hints?: readonly HostHint[];
  quiet?: ThingQuiet;
  now: Date;
  heartbeatOff?: boolean;
  guestsOf?: (h: HostHint) => readonly string[] | undefined;
}): ServerVerdict {
  const { card } = input;
  const own = input.alerts.filter((a) => a.serverId === card.id && a.state === 'open');
  const attention = own.filter(asksAttention);
  const lines: ServerLine[] = [
    ...attention.map((a) => alertLine(a)).sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'bad' ? -1 : 1)),
  ];
  if (input.hints?.length)
    for (const h of markHints(
      input.hints.filter((x) => x.serverId === card.id),
      input.quiet ?? NO_QUIET,
      input.now,
      input.guestsOf,
    ).hints)
      if (!h.row) lines.push(h.line);
  // Kept quiet: its alerts are muted in the hosts service too, but count for nothing here
  // even before the hub has the maintenance window.
  const windows = input.quiet?.windows ?? [];
  const r = applyQuiet({ lines, quiets: [], offs: [], states: [], now: input.now, pass: false, windows });
  const worst = r.worst;
  const asking = worst ? [worst, ...r.asking.filter((l) => l !== worst)] : [];
  const hubNote = card.statusNote?.trim() || null;
  if (input.pending) return { status: 'pending', note: hubNote, dot: false, worst: null, asking: [] };
  if (card.status === 'offline') {
    const beat = own.find((a) => a.rule === HEARTBEAT_RULE);
    const quiet =
      r.held !== null || input.heartbeatOff === true || (beat !== undefined && !asksAttention(beat));
    const beatLine = beat && !quiet ? alertLine(beat) : null;
    const behind = beatLine ?? worst;
    return {
      status: 'offline',
      note: hubNote,
      dot: !quiet || worst !== null,
      worst: behind ?? null,
      asking: beatLine ? [beatLine, ...asking.filter((l) => l.alert !== beat)] : asking,
    };
  }
  if (!worst) {
    // The hosts service said warning while it listed no open alert of the server (a list read a moment apart).
    if (card.status === 'warning' && own.length === 0)
      return { status: 'warn', note: hubNote, dot: true, worst: null, asking: [] };
    return { status: 'ok', note: null, dot: false, worst: null, asking: [] };
  }
  // The hosts service's note is its most severe attention alert's: the same line unless a heads-up came first.
  const sameAsHub =
    worst.alert !== undefined &&
    card.status === 'warning' &&
    attention.every((a) => alertLine(a).nature !== 'fyi');
  return {
    status: r.status === 'bad' ? 'bad' : 'warn',
    note: sameAsHub && hubNote ? hubNote : worst.title || hubNote,
    dot: true,
    worst,
    asking,
  };
}

/** The question the desk sends when someone asks the assistant to look into a server's line (QN-20). */
export function lineQuestion(
  line: Pick<ServerLine, 'title'>,
  serverName: string,
  locale?: string | null,
): string {
  const title = line.title.replace(/[.\s]+$/, '');
  return tServer(locale, 'hosts.lineQuestion', { title, server: serverName }).slice(0, 300);
}

/** The notice a desk look of a server carries: its worst line's check, item, kind and Ignore words (QN-20). */
export function noticeOfLine(line: ServerLine, serverName: string, locale?: string | null): GlanceNotice {
  return {
    check: line.check,
    ...(line.subject ? { subject: line.subject.id } : {}),
    nature: line.nature,
    ignoreWords: line.ignore.words,
    ...(line.nature === 'problem' ? { question: lineQuestion(line, serverName, locale) } : {}),
  };
}

/* The desk's look of a server (S0's desk/glance.ts reads it) --------------------------------------------------------- */

const VERDICTS = new WeakMap<HostServer, ServerVerdict>();

/** Keeps what a fleet row came to beside it (the contract's `HostServer` gains nothing on the wire). */
export function keepVerdict(row: HostServer, verdict: ServerVerdict): void {
  VERDICTS.set(row, verdict);
}

/** What a fleet row came to, when the fleet was read through `HostsService.fleet()`. */
export function verdictOf(row: HostServer): ServerVerdict | undefined {
  return VERDICTS.get(row);
}

/**
 * The line behind a server row that isn't fine (QN-20, QN-23), for the desk's look and the glance's worst: a server is
 * a look only with one. None for a fine server, for an offline one whose “offline” alert is quiet or switched off, and
 * for a row not read through `HostsService.fleet()`.
 */
export function serverNotice(row: HostServer, locale?: string | null): GlanceNotice | undefined {
  const v = VERDICTS.get(row);
  if (!v?.dot || !v.worst || v.worst.nature === 'fyi') return undefined;
  return noticeOfLine(v.worst, row.name, locale);
}

/** Every line behind a server row that isn't fine, worst first (none as for `serverNotice`). */
export function serverLines(row: HostServer): ServerLine[] {
  const v = VERDICTS.get(row);
  if (!v?.dot || !v.worst || v.worst.nature === 'fyi') return [];
  return v.asking.filter((l) => l.nature !== 'fyi');
}
