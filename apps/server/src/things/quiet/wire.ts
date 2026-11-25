/**
 * Worth a look as a page sends it (quiet-notices.md QN-10, QN-14; QN-S13, QN-S14): the lines in their order (active by
 * tone, heads-ups, then the quiet ones greyed at the bottom with who quieted them and until when), the head's status
 * and badge from the active lines, the server-only parts left out, and `ignore` only for who may manage the thing.
 */
import {
  type KeptQuiet,
  type NoticeQuiet,
  type QuietNoticeBody,
  type QuietNoticeResponse,
  type SetThingWatchBody,
  type ThingCause,
  type ThingPageNotice,
  type ThingStatus,
  type ThingWatch,
  type ThingWatchCheck,
  thingHref,
} from '@whombat/core';
import { inArray } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import { principals } from '../../db/schema/index';
import { applyQuiet, inPageOrder, natureOf, type QuietRow, type Skipped, type StateRow } from './apply';
import { notWatched } from './defaults';
import type { ThingQuiet } from './store';
import type { LooseNotice } from './types';
import { activeWindow, isHeldRow, keptQuiet, liveCause, thingCause } from './windows';
import { lowerWords, untilWords } from './words';

/** The line is quiet (contracts 0.122 `NoticeQuiet`, CT-1060). */
export type WireQuiet = NoticeQuiet;

/** A line on the wire (contracts 0.122 `ThingPageNotice`, CT-1061). */
export type WireNotice = ThingPageNotice;

/** `things.quiet`'s body and answer, `things.setWatch`'s body, What Whombat watches (CT-1062, CT-1063). */
export type QuietRequest = z.infer<typeof QuietNoticeBody>;
export type QuietAnswer = z.infer<typeof QuietNoticeResponse>;
export type WatchRequest = z.infer<typeof SetThingWatchBody>;
export type WireWatch = ThingWatch;
export type WireWatchCheck = ThingWatchCheck;

/** “until it’s back online”, “until tomorrow 09:00”, with who and when. */
export function quietOf(
  row: Pick<QuietRow, 'state' | 'words' | 'until' | 'byId' | 'at'>,
  names: ReadonlyMap<string, string>,
  now: Date,
  timeZone: string,
): WireQuiet {
  const name = row.byId ? names.get(row.byId) : undefined;
  const words =
    row.state === 'snoozed' && row.until ? untilWords(row.until, now, timeZone) : lowerWords(row.words);
  return {
    state: row.state,
    words,
    ...(row.until ? { until: row.until.toISOString() } : {}),
    ...(row.byId && name ? { by: { id: row.byId, name } } : {}),
    at: row.at.toISOString(),
    // Quiet with the whole thing: End now on the page, not Undo on the line.
    ...(isHeldRow(row) ? { held: row.held } : {}),
  };
}

/** A line as the wire takes it: without `episode`, `band`, `confirm`, `badge`, `offline`; `ignore` when it has a check. */
export function toWireNotice(line: LooseNotice, ctx: { quiet?: WireQuiet } = {}): WireNotice {
  const { episode: _e, band: _b, confirm: _c, badge: _g, offline: _o, ignore, nature: _n, ...rest } = line;
  return {
    ...rest,
    nature: natureOf(line),
    ...(ignore && line.check ? { ignore } : {}),
    ...(ctx.quiet ? { quiet: ctx.quiet } : {}),
  };
}

/** People's names as a quiet line says them (“Ignored by John”): their short name, else their first name. */
export async function quietNames(
  db: Db,
  rows: readonly Pick<QuietRow, 'byId'>[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.byId).filter((id): id is string => !!id))];
  if (!ids.length) return new Map();
  const found = await db
    .select({ id: principals.id, name: principals.name, shortName: principals.shortName })
    .from(principals)
    .where(inArray(principals.id, ids));
  return new Map(
    found.map((p) => [
      p.id,
      (p.shortName ?? p.name.split(' ')[0] ?? p.name).slice(0, 80) || p.name.slice(0, 80),
    ]),
  );
}

/** A page's Worth a look and its head (QN-S13). */
export interface MarkedLines {
  items: WireNotice[];
  /** From the active lines that aren't heads-ups (offline when the worst says the thing doesn't answer). */
  status: 'ok' | 'warn' | 'bad' | 'offline';
  /** The worst line's badge or title; absent when fine. */
  badge?: string;
  /** Kept quiet until a time: the page's `keptQuiet`. */
  keptQuiet?: KeptQuiet;
  /** Down because of something else: the page's `causedBy`, its words the badge. */
  causedBy?: ThingCause;
}

/** The most lines in Worth a look. */
export const NOTICES_MAX = 30;

/** Marks a page's lines with what is quiet now (a read: nothing ends here). */
export async function markLines(
  db: Db,
  lines: readonly LooseNotice[],
  ctx: {
    quiet: ThingQuiet;
    states: readonly StateRow[];
    now: Date;
    timeZone: string;
    skipped?: Skipped;
    /** Whether the viewer may end a window (End now): who may manage the thing. */
    mayEnd?: boolean;
  },
): Promise<MarkedLines> {
  const r = applyQuiet({
    lines,
    quiets: ctx.quiet.quiets,
    ...notWatched(ctx.quiet),
    states: ctx.states,
    now: ctx.now,
    pass: false,
    ...(ctx.skipped ? { skipped: ctx.skipped } : {}),
  });
  const window = activeWindow(ctx.quiet.windows, ctx.now);
  const cause = liveCause(ctx.quiet.cause, ctx.now);
  const names = await quietNames(db, [...r.quiet.map((q) => q.row), ...(window ? [window] : [])]);
  const kept = window
    ? keptQuiet(window, { now: ctx.now, timeZone: ctx.timeZone, names, canEnd: ctx.mayEnd ?? false })
    : undefined;
  const causedBy = cause ? thingCause(cause, causeHref(cause.causeThing)) : undefined;
  const items = inPageOrder(r)
    .slice(0, NOTICES_MAX - (kept || causedBy ? 1 : 0))
    .map(({ line, row }) =>
      toWireNotice(line, row ? { quiet: quietOf(row, names, ctx.now, ctx.timeZone) } : {}),
    );
  // The hold as the first line, a heads-up, for an app that doesn't draw `keptQuiet` or `causedBy`.
  const holdLine = kept ? keptLine(kept) : causedBy ? causeLine(causedBy) : null;
  return {
    items: holdLine ? [holdLine, ...items] : items,
    status: r.worst ? (r.worst.offline ? 'offline' : r.status) : 'ok',
    ...(r.badge ? { badge: r.badge } : kept ? { badge: kept.words.split(' · ')[0] as string } : {}),
    ...(kept ? { keptQuiet: kept } : {}),
    ...(causedBy ? { causedBy } : {}),
  };
}

/** The page of what a thing is down because of: a server's (or one of its machines'); the internet has none. */
export function causeHref(thing: string): string | null {
  if (!thing.startsWith('server:')) return null;
  const [server, guest] = thing.slice('server:'.length).split('/guest/');
  if (!server) return null;
  const page = thingHref('server', server);
  return guest ? `${page}?guest=${encodeURIComponent(decodeURIComponent(guest))}` : page;
}

/** Worth a look's first line while a thing is kept quiet: “Quiet until 23:00 · Moving the NAS”. */
function keptLine(kept: KeptQuiet): WireNotice {
  return { id: 'quiet-window', tone: 'info', icon: 'clock', title: kept.words.slice(0, 120), nature: 'fyi' };
}

/** Worth a look's first line while a thing is down because of something else: “Not answering while pve-02 is down”. */
function causeLine(cause: ThingCause): WireNotice {
  return {
    id: 'quiet-cause',
    tone: 'info',
    icon: 'power',
    title: cause.words.slice(0, 120),
    nature: 'fyi',
    ...(cause.href
      ? { link: { kind: 'href' as const, label: `See ${cause.name}`.slice(0, 30), href: cause.href } }
      : {}),
  };
}

/**
 * A page's head and fields while the thing is held quiet: down because of something else
 * is grey with the cause's words as its badge; kept quiet, or quiet with its server, keeps its status. `keptQuiet` and `causedBy` for the page.
 */
export function heldPage(
  marked: Pick<MarkedLines, 'keptQuiet' | 'causedBy'>,
  head: { status: ThingStatus; badge: string },
): {
  head: { status: ThingStatus; badge: string };
  fields: { keptQuiet?: KeptQuiet; causedBy?: ThingCause };
} {
  const fields = {
    ...(marked.keptQuiet ? { keptQuiet: marked.keptQuiet } : {}),
    ...(marked.causedBy ? { causedBy: marked.causedBy } : {}),
  };
  if (marked.causedBy && !marked.keptQuiet && marked.causedBy.kind !== 'quiet')
    return { head: { status: 'unknown', badge: marked.causedBy.words.slice(0, 60) }, fields };
  return { head, fields };
}
