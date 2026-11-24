/**
 * A thing held quiet as a whole (docs/decisions/monitoring.md MON-04, MON-05, MON-07, MON-08): kept quiet until a time
 * (a window, by a person or by Whombat for its own planned work), or down because of something else (a cause: its
 * server is down, its machine stopped or is kept quiet, the internet is down). While either holds, every line of the
 * thing is quiet — no dot, look, Inbox item, incident or push — and the health pass forgets how long each line was
 * seen, so what is still wrong when it ends counts again from the start. Pure: the rows come with the thing's quiet
 * rows (`store.ts`), and `applyQuiet` asks `holdOf` at its `now`.
 */
import type { KeptQuiet, ThingCause } from '@whombat/core';
import type { QuietWindowRow, ThingCauseRow } from '../../db/schema/quiet-windows';
import type { QuietRow } from './apply';
import { untilWords } from './words';

/** A window as `holdOf` reads it. */
export type WindowLike = Pick<
  QuietWindowRow,
  'id' | 'startsAt' | 'endsAt' | 'endedAt' | 'note' | 'byId' | 'work' | 'guestId'
>;
/** A cause as `holdOf` reads it. */
export type CauseLike = Pick<
  ThingCauseRow,
  'causeThing' | 'causeName' | 'kind' | 'words' | 'since' | 'checkedAt'
>;

/**
 * How long a cause counts after the job last found it: the job runs every minute, so a cause it stopped keeping current
 * (the job stopped, the server went away) ends by itself rather than keeping a thing quiet for ever.
 */
export const CAUSE_FRESH_MS = 5 * 60_000;

/** How long after Whombat's own work ends its window still holds (MON-05). */
export const AFTER_WORK_MS = 15 * 60_000;

/** Whombat's words for a window it keeps for its own work. */
export const WHOMBAT_WORK_NOTE = 'Whombat is updating it';

/** What holds a thing quiet now. */
export interface Hold {
  kind: 'window' | 'cause';
  /** A cause's words (“while pve-02 is down”); a window's are its time, said in the reader's zone. */
  words: string;
  until: Date | null;
  byId: string | null;
  at: Date;
  window?: WindowLike;
  cause?: CauseLike;
}

/** Whether a window holds at `now`: started, not over, not ended early. */
export function windowHolds(w: Pick<WindowLike, 'startsAt' | 'endsAt' | 'endedAt'>, now: Date): boolean {
  const t = now.getTime();
  return !w.endedAt && w.startsAt.getTime() <= t && w.endsAt.getTime() > t;
}

/** The window over the whole thing that holds at `now` (the one ending last); a window over one guest isn't. */
export function activeWindow<W extends WindowLike>(windows: readonly W[] | undefined, now: Date): W | null {
  let found: W | null = null;
  for (const w of windows ?? [])
    if (!w.guestId && windowHolds(w, now) && (!found || w.endsAt > found.endsAt)) found = w;
  return found;
}

/** The cause when the job still keeps it current. */
export function liveCause<C extends CauseLike>(cause: C | null | undefined, now: Date): C | null {
  if (!cause) return null;
  return now.getTime() - cause.checkedAt.getTime() <= CAUSE_FRESH_MS ? cause : null;
}

/**
 * What holds a thing quiet at `now`, or null. A window comes first: it is the person's own word (or Whombat's planned
 * work), and the cause still shows on the page as its `causedBy`.
 */
export function holdOf(
  q: { windows?: readonly WindowLike[] | undefined; cause?: CauseLike | null | undefined },
  now: Date,
): Hold | null {
  const window = activeWindow(q.windows, now);
  if (window)
    return {
      kind: 'window',
      words: 'until it ends',
      until: window.endsAt,
      byId: window.byId,
      at: window.startsAt,
      window,
    };
  const cause = liveCause(q.cause, now);
  if (cause) return { kind: 'cause', words: cause.words, until: null, byId: null, at: cause.since, cause };
  return null;
}

/** A quiet row a held line is drawn with: a window as a snooze until its end, a cause as an ignore while it lasts. */
export interface HeldRow extends QuietRow {
  held: 'window' | 'cause';
}

export function heldRow(
  line: {
    check?: string;
    subject?: { id: string; name: string };
    tone: 'bad' | 'warn' | 'info';
    title: string;
  },
  hold: Hold,
): HeldRow {
  return {
    checkId: line.check ?? '',
    subject: line.subject?.id ?? '',
    state: hold.kind === 'window' ? 'snoozed' : 'ignored',
    lifts: null,
    episode: null,
    tone: line.tone,
    band: null,
    until: hold.until,
    clearPasses: 0,
    title: line.title,
    subjectName: line.subject?.name ?? null,
    words: hold.words,
    byId: hold.byId,
    at: hold.at,
    held: hold.kind,
  };
}

/** Whether a quiet row stands for a hold rather than a row of the line's own. */
export function isHeldRow(row: object): row is HeldRow {
  return 'held' in row && ((row as HeldRow).held === 'window' || (row as HeldRow).held === 'cause');
}

/** “Quiet until 23:00 · Moving the NAS”: a window as its page says it. */
export function keptWords(w: Pick<WindowLike, 'endsAt' | 'note'>, now: Date, timeZone: string): string {
  const until = untilWords(w.endsAt, now, timeZone);
  const head = `Quiet ${until}`;
  const note = w.note?.trim();
  return (note ? `${head} · ${note}` : head).slice(0, 160);
}

/** A window as a page carries it (`KeptQuiet`). `names`: people's short names by id. */
export function keptQuiet(
  w: WindowLike,
  ctx: { now: Date; timeZone: string; names: ReadonlyMap<string, string>; canEnd: boolean },
): KeptQuiet {
  const name = w.byId ? ctx.names.get(w.byId) : undefined;
  const note = w.note?.trim();
  return {
    id: w.id,
    words: keptWords(w, ctx.now, ctx.timeZone),
    since: w.startsAt.toISOString(),
    until: w.endsAt.toISOString(),
    ...(note ? { note: note.slice(0, 120) } : {}),
    ...(w.byId && name ? { by: { id: w.byId, name } } : {}),
    ...(w.work ? { whombat: true } : {}),
    canEnd: ctx.canEnd,
  };
}

/**
 * A cause as a page carries it (`ThingCause`): “Not answering while pve-02 is down”, or for a thing quiet with its server
 * “Quiet while pve-02 is kept quiet”.
 */
export function thingCause(c: CauseLike, href?: string | null): ThingCause {
  return {
    thing: c.causeThing.slice(0, 220),
    name: c.causeName.slice(0, 80) || c.causeThing.slice(0, 80),
    words: `${c.kind === 'quiet' ? 'Quiet' : 'Not answering'} ${c.words}`.slice(0, 160),
    ...(c.kind === 'quiet' ? { kind: 'quiet' as const } : {}),
    ...(href ? { href: href.slice(0, 500) } : {}),
  };
}

/** “Plex and 4 more are down with it”: what a cause takes with it, or null when nothing. */
export function takenWords(names: readonly string[]): string | null {
  const [a, b] = names;
  if (!a) return null;
  if (!b) return `${a} is down with it`;
  if (names.length === 2) return `${a} and ${b} are down with it`;
  return `${a} and ${names.length - 1} more are down with it`;
}

/** The names of the things down because of each cause, from Home's things (`ThingSummary.causedBy`), by name. */
export function takenFrom(
  things: readonly { name: string; causedBy?: { thing: string; kind?: 'down' | 'quiet' } }[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of things) {
    const cause = t.causedBy?.thing;
    // What is only quiet with its server isn't down with it.
    if (!cause || t.causedBy?.kind === 'quiet') continue;
    // A thing down with one of a server's machines is down with the server too, for the server's look.
    const server = cause.split('/guest/')[0] as string;
    for (const key of new Set([cause, server])) out.set(key, [...(out.get(key) ?? []), t.name]);
  }
  for (const names of out.values()) names.sort((a, b) => a.localeCompare(b));
  return out;
}
