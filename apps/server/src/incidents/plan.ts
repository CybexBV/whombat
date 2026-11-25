/**
 * What a pass of the incident watcher decides, pure, with the clock given:
 *
 * - **Incidents.** A thing whose look is bad or down on two passes in a row opens one (amber never does), from the first
 *   of them; a pass that couldn't read the thing in between counts neither way. While it lasts, going from a problem to
 *   down makes it a `down` one, and a bad check that starts counting on it is noted once. It ends only on what Whombat
 *   saw of the thing itself, whatever is quiet about it (`ThingSeen`): two passes in a row that saw it fine end it, at
 *   the first of them; one that saw it still bad (not answering, a bad line someone quieted, held quiet or down because
 *   of something else) starts the count again; one that couldn't read it counts neither way. A thing that was removed
 *   ends its incident at once, as removed: it didn't come back. A `down` incident keeps when its thing stopped and
 *   started answering, so its down time ends when it answers again while a problem keeps it open. One that ended
 *   outside the watcher (its check now reads another address) takes what was counted of its thing with it.
 * - **The push.** An incident open 10 minutes, about which no research finding pushed meanwhile, is pushed once,
 *   together with the others that opened within a few minutes of it. Not one that something else took down with it
 *   (its cause), nor one older than an hour when Whombat first could push it (it was down before Whombat watched, or
 *   while it couldn't push), nor past the day's cap or a thing's. The clock starts at the incident's start, or when a
 *   hold over it ended or the last pass that couldn't read it when that is later: Whombat couldn't tell anyone while it
 *   was kept quiet, nor knew while it was blind.
 */
import type { IncidentNature } from '@whombat/core';

/** An incident opens after this many passes in a row with its look, and ends after as many without. */
export const CONFIRM_PASSES = 2;
/** An incident is pushed when it has been open this long (a research finding may push about it first). */
export const PUSH_AFTER_MS = 10 * 60_000;
/** Incidents that started within this long of the one pushed go in the same push. */
export const PUSH_GROUP_MS = 5 * 60_000;
/** An incident not pushed this long after it started isn't pushed any more: it is history by then. */
export const PUSH_FRESH_MS = 60 * 60_000;
/** At most this many pushes a day, and of one thing. */
export const PUSHES_PER_DAY = 6;
export const PUSHES_PER_THING = 2;
/** The most incidents one push takes: its words name the first three and say how many more. */
export const PUSH_MAX = 200;

/** A thing's look on this pass that could open an incident: down, or a bad dot. */
export interface SeenLook {
  /** Its thingId (`server:pve-02`). */
  thing: string;
  kind: 'server' | 'connection' | 'device';
  name: string;
  nature: IncidentNature;
  words: string;
  check: string | null;
  subject: string;
  /** Down because this, what it runs on, is down. */
  cause: { thing: string; name: string } | null;
  /** When Whombat knows it went wrong earlier than the pass before (a server's last report, a research's start). */
  since: Date | null;
  /** The bad lines that count on it now, by check: what an automation naming a check starts on. */
  problems?: readonly { check: string; words: string }[];
}

/** An incident still open, as the pass weighs it. */
export interface OpenIncident {
  id: string;
  thing: string;
  kind: 'server' | 'connection' | 'device';
  name: string;
  nature: IncidentNature;
  words: string;
  startedAt: Date;
  cause: { thing: string; name: string } | null;
  pushedAt: Date | null;
  /** The checks it signed an event for already: a bad check counting on it that isn't here is new. */
  checks?: readonly string[];
  /** A `down` incident whose thing answers again while a problem keeps it open: since when. */
  answeringSince?: Date | null;
}

/**
 * What Whombat saw of an open incident's thing on a pass without a look of it, from the thing's own state rather than
 * its dot: `fine` (it answers and has no bad line), `bad` (it doesn't answer, has a bad line someone quieted, or is held
 * quiet or down because of something else), `unread` (Whombat couldn't read it: the servers weren't read, its check
 * couldn't run, it wasn't checked since a hold ended) or `gone` (it was removed).
 */
export type ThingSeen = 'fine' | 'bad' | 'unread' | 'gone';

/** What the pass before saw: when, and the things with a look then. */
export interface PassBefore {
  at: Date;
  things: ReadonlySet<string>;
  /** When each thing's run of looks began, kept over passes that couldn't read it. */
  since?: ReadonlyMap<string, Date>;
  /** Open incidents' things seen fine, since the first pass of the run that saw them fine. */
  fine?: ReadonlyMap<string, Date>;
  /** The last pass that saw each thing held (kept quiet, or down because of something else): the watcher's memory. */
  held?: ReadonlyMap<string, Date>;
  /** The last pass of each thing's run of looks that couldn't read it: what it was meanwhile isn't known. */
  unread?: ReadonlyMap<string, Date>;
  /** The open incidents after it, by id, with their things: one that ended without the watcher starts its run again. */
  open?: ReadonlyMap<string, string>;
  /** It was the watcher's first pass since it started: what it saw was bad before Whombat watched. */
  first?: boolean;
}

export interface IncidentPassInput {
  looks: readonly SeenLook[];
  open: readonly OpenIncident[];
  /** Null on the first pass after a start: nothing opens or ends yet. */
  before: PassBefore | null;
  /** The servers' cards were read; else what the pass before saw of servers carries over. */
  serversRead: boolean;
  /**
   * What Whombat saw of things without a look on this pass (`ThingSeen`): each open incident's (absent: it couldn't read
   * it) and those the pass before had a look of (one it couldn't read keeps its run of looks).
   */
  seen?: ReadonlyMap<string, ThingSeen>;
  /**
   * Whether each open incident's thing answers now, whatever is quiet about it: true, false (it doesn't), absent when
   * not known (held, not read).
   */
  answering?: ReadonlyMap<string, boolean>;
  /** The Whombat has no incidents yet: its first ones are what it found already bad when it started watching. */
  noneYet?: boolean;
  now: Date;
}

export interface IncidentPassPlan {
  /**
   * `pushed`: bad before Whombat watched, so it is told as already pushed (no push now). `downSince`: down after
   * passes that couldn't read it, so its down time starts at the last of them.
   */
  opened: (SeenLook & { startedAt: Date; pushed?: true; downSince?: Date })[];
  /** Open incidents that got worse (a problem now down), or learned their cause. */
  changed: {
    id: string;
    nature: IncidentNature;
    words: string;
    cause: SeenLook['cause'];
    worse: boolean;
    downSince?: string;
    check?: string | null;
    subject?: string;
  }[];
  /** Bad checks that began counting on an open incident: each signs once. */
  noted: { id: string; check: string; words: string }[];
  /** `down` incidents whose thing answered again (`down` false) or stopped answering again (true), at `at`. */
  stretched: { id: string; down: boolean; at: Date }[];
  /** `removed`: its thing is gone; it ended without coming back. */
  ended: { id: string; endedAt: Date; removed?: true }[];
  /** What this pass saw, for the next. */
  seen: PassBefore;
}

/** One pass's incidents, pure. */
export function planIncidents(input: IncidentPassInput): IncidentPassPlan {
  const { now } = input;
  const byThing = new Map(input.looks.map((l) => [l.thing, l]));
  const openThings = new Set(input.open.map((o) => o.thing));
  const before = withoutEndedElsewhere(input.before, new Set(input.open.map((o) => o.id)));
  const opened: IncidentPassPlan['opened'] = [];
  const changed: IncidentPassPlan['changed'] = [];
  const noted: IncidentPassPlan['noted'] = [];
  const stretched: IncidentPassPlan['stretched'] = [];
  const ended: IncidentPassPlan['ended'] = [];
  const keep = new Set<string>();
  const fine = new Map<string, Date>();
  for (const inc of input.open) {
    const look = byThing.get(inc.thing);
    // Its down time is how long it didn't answer, not how long the incident lasts: a problem can keep it open after.
    const answers = input.answering?.get(inc.thing);
    if (inc.nature === 'down' && answers === true && !inc.answeringSince)
      stretched.push({ id: inc.id, down: false, at: now });
    else if (inc.nature === 'down' && answers === false && inc.answeringSince) {
      const since = look?.since;
      stretched.push({
        id: inc.id,
        down: true,
        at: since && since > inc.answeringSince && since <= now ? since : now,
      });
    }
    if (look) {
      const worse = inc.nature === 'problem' && look.nature === 'down';
      const cause = inc.cause ?? look.cause;
      if (worse || (cause && !inc.cause))
        changed.push({
          id: inc.id,
          nature: worse ? 'down' : inc.nature,
          words: worse ? look.words : inc.words,
          cause,
          worse,
          ...(worse
            ? {
                check: look.check,
                subject: look.subject,
                downSince: (look.since && look.since > inc.startedAt && look.since <= now
                  ? look.since
                  : now
                ).toISOString(),
              }
            : {}),
        });
      // A bad check counting on it now that it never signed for (the UPS on battery while a disk keeps the server's
      // incident open) is news to an automation that names that check. What something else took down starts nothing.
      if (!cause) {
        const known = new Set([...(inc.checks ?? []), ...(worse && look.check ? [look.check] : [])]);
        for (const p of look.problems ?? [])
          if (!known.has(p.check)) {
            known.add(p.check);
            noted.push({ id: inc.id, check: p.check, words: p.words });
          }
      }
      continue;
    }
    const seen = input.seen?.get(inc.thing) ?? 'unread';
    if (seen === 'gone') {
      ended.push({ id: inc.id, endedAt: now, removed: true });
      continue;
    }
    // Still bad underneath, or held: it stays open and the count of passes seen fine starts again.
    if (seen === 'bad') {
      keep.add(inc.thing);
      continue;
    }
    const fineSince = before?.fine?.get(inc.thing);
    // Not read: it counts neither way, so what was counted carries over.
    if (seen === 'unread') {
      if (fineSince) fine.set(inc.thing, fineSince);
      else if (before?.things.has(inc.thing)) keep.add(inc.thing);
      continue;
    }
    if (fineSince) ended.push({ id: inc.id, endedAt: fineSince });
    else fine.set(inc.thing, now);
  }
  // The update itself mustn't push about what was red for days: on a Whombat's first incidents, what its watcher's
  // first pass already saw opens as told.
  const inherited = !!(input.noneYet && before?.first);
  // When each thing's run of looks began: a pass that couldn't read a server in between doesn't start it again.
  const runSince = new Map<string, Date>();
  for (const look of input.looks)
    runSince.set(
      look.thing,
      before?.things.has(look.thing) ? (before.since?.get(look.thing) ?? before.at) : now,
    );
  if (before)
    for (const look of input.looks) {
      if (openThings.has(look.thing) || !before.things.has(look.thing)) continue;
      const first = runSince.get(look.thing) ?? before.at;
      const since = look.since && look.since < first ? look.since : first;
      // Passes that couldn't read it in between say nothing of whether it answered then.
      const blind = before.unread?.get(look.thing);
      opened.push({
        ...look,
        startedAt: since,
        ...(inherited ? { pushed: true as const } : {}),
        ...(look.nature === 'down' && blind && blind > since ? { downSince: blind } : {}),
      });
    }
  const things = new Set([...input.looks.map((l) => l.thing), ...keep]);
  // What this pass couldn't read (any server while the servers weren't read) keeps what the pass before saw of it,
  // with when its run began: bad, unread, bad opens from the first bad pass.
  if (before)
    for (const t of before.things) {
      const unread = (!input.serversRead && t.startsWith('server:')) || input.seen?.get(t) === 'unread';
      if (unread && !things.has(t)) {
        things.add(t);
        runSince.set(t, before.since?.get(t) ?? before.at);
      }
    }
  const endedIds = new Set(ended.map((e) => e.id));
  const stillOpen = new Map(
    input.open.filter((o) => !endedIds.has(o.id)).map((o) => [o.id, o.thing] as const),
  );
  // The last pass of each run that couldn't read its thing: the push's clock starts again then. A thing seen fine once
  // while its incident waits to end keeps it too: bad again on the next pass, it is the same outage. So does every
  // thing whose incident stays open, also one no pass of this run could read yet (after a restart, or a pass that
  // couldn't read Home); one Whombat has no reading of is unread.
  const openNow = new Set(stillOpen.values());
  const unread = new Map<string, Date>();
  for (const t of new Set([...things, ...fine.keys(), ...openNow])) {
    const seen = input.seen?.get(t) ?? (openNow.has(t) ? 'unread' : undefined);
    const blind = !byThing.has(t) && ((!input.serversRead && t.startsWith('server:')) || seen === 'unread');
    const was = before?.unread?.get(t);
    if (blind) unread.set(t, now);
    else if (was) unread.set(t, was);
  }
  return {
    opened,
    changed,
    noted,
    stretched,
    ended,
    seen: { at: now, things, since: runSince, fine, unread, open: stillOpen, first: input.before === null },
  };
}

/**
 * The pass before without the things whose incident ended outside the watcher (a Website check pointed at another
 * address ends its outage): what was counted of the old target says nothing of the new one, so its next incident
 * opens from what Whombat sees from now on.
 */
function withoutEndedElsewhere(before: PassBefore | null, openIds: ReadonlySet<string>): PassBefore | null {
  const gone = new Set([...(before?.open ?? [])].flatMap(([id, t]) => (openIds.has(id) ? [] : [t])));
  if (!before || !gone.size) return before;
  const drop = <V>(map: ReadonlyMap<string, V> | undefined) =>
    map && new Map([...map].filter(([t]) => !gone.has(t)));
  return {
    ...before,
    things: new Set([...before.things].filter((t) => !gone.has(t))),
    since: drop(before.since),
    fine: drop(before.fine),
    unread: drop(before.unread),
  };
}

/**
 * What the watcher keeps over a pass that couldn't read Home at all: only what it knew of the open incidents (their
 * run of looks, the passes that saw them fine), with this pass as one that couldn't read them, so an outage Whombat
 * was blind to for a while is pushed once it can read it again instead of counting as stale; and when it last saw
 * holds. Everything else is forgotten, as is all of it when nothing is open: a look must be seen on two passes that
 * read it.
 */
export function blindPass(
  before: PassBefore | null,
  open: ReadonlyMap<string, string>,
  now: Date,
): PassBefore | null {
  if (!before || !open.size) return null;
  const openThings = new Set(open.values());
  const things = [...before.things].filter((t) => openThings.has(t));
  return {
    at: now,
    things: new Set(things),
    since: new Map(things.map((t) => [t, before.since?.get(t) ?? before.at] as const)),
    fine: new Map([...(before.fine ?? [])].filter(([t]) => openThings.has(t))),
    ...(before.held ? { held: before.held } : {}),
    unread: new Map([...openThings].map((t) => [t, now] as const)),
    open,
    first: false,
  };
}

/** An open incident as the push weighs it. */
export interface PushCandidate extends OpenIncident {
  /** A research finding about this thing pushed since the incident started. */
  findingPushed: boolean;
  /**
   * When a hold over its thing last ended (a quiet window, a cause), or the last pass that couldn't read it: the push's
   * clock starts then when it is later.
   */
  heldUntil?: Date | null;
}

/** When the push's clock starts: the incident's start, or the end of a hold or a blind stretch when that is later. */
export function pushFrom(i: Pick<PushCandidate, 'startedAt' | 'heldUntil'>): number {
  return Math.max(i.startedAt.getTime(), i.heldUntil?.getTime() ?? 0);
}

export interface PushInput {
  open: readonly PushCandidate[];
  /** Pushes made today, and of each thing today. */
  pushedToday: number;
  pushedTodayOf: ReadonlyMap<string, number>;
  now: Date;
}

/**
 * The incidents one push names now, worst first then by name, or none: the oldest that is due (open 10 minutes, not
 * pushed, no cause, no finding pushed, not stale, under the caps) with the others that started within a few minutes of
 * it and could be pushed too, at most `PUSH_MAX` of them. Each counts from `pushFrom`.
 */
export function planPush(input: PushInput): PushCandidate[] {
  if (input.pushedToday >= PUSHES_PER_DAY) return [];
  const now = input.now.getTime();
  const pushable = input.open.filter(
    (i) =>
      !i.pushedAt &&
      !i.cause &&
      !i.findingPushed &&
      now - pushFrom(i) <= PUSH_FRESH_MS &&
      (input.pushedTodayOf.get(i.thing) ?? 0) < PUSHES_PER_THING,
  );
  const due = pushable
    .filter((i) => now - pushFrom(i) >= PUSH_AFTER_MS)
    .sort((a, b) => pushFrom(a) - pushFrom(b));
  const first = due[0];
  if (!first) return [];
  const start = pushFrom(first);
  return pushable
    .filter((i) => Math.abs(pushFrom(i) - start) <= PUSH_GROUP_MS)
    .sort(pushOrder)
    .slice(0, PUSH_MAX);
}

/** The order a push names its incidents in: down first, then by name. */
export function pushOrder(
  a: Pick<OpenIncident, 'nature' | 'name'>,
  b: Pick<OpenIncident, 'nature' | 'name'>,
) {
  return a.nature === b.nature ? a.name.localeCompare(b.name) : a.nature === 'down' ? -1 : 1;
}

/** A name as it reads inside a sentence: “The NAS” becomes “the NAS”, “Plex” stays. */
function inSentence(name: string): string {
  return /^The [A-Z]/.test(name) ? `t${name.slice(1)}` : name;
}

/** “a disk is failing” from “A disk is failing”; a first word like a name or an acronym (UniFi, NAS) keeps its capital. */
function lowerFirst(words: string): string {
  const first = /^\S+/.exec(words)?.[0] ?? '';
  return /^[A-Z][a-z]*[.,:]?$/.test(first) && first !== 'I'
    ? words.charAt(0).toLowerCase() + words.slice(1)
    : words;
}

/** “Plex, the NAS and Home Assistant”; past three, “… and 2 more”. */
function names(list: readonly string[]): string {
  const shown = list.slice(0, list.length > 3 ? 3 : list.length).map(inSentence);
  if (list.length > 3) return `${shown.join(', ')} and ${list.length - 3} more`;
  if (shown.length === 1) return shown[0] as string;
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

/**
 * The push's words: “Plex is down”, “The NAS: a disk is failing”, “3 things are down: Plex, the NAS and Home Assistant”,
 * “2 things aren’t working: Plex and the NAS”.
 */
export function incidentPushText(group: readonly Pick<OpenIncident, 'name' | 'nature' | 'words'>[]): string {
  const [one] = group;
  if (!one) return '';
  if (group.length === 1)
    return one.nature === 'down' ? `${one.name} is down` : `${one.name}: ${lowerFirst(one.words)}`;
  const allDown = group.every((i) => i.nature === 'down');
  return `${group.length} things ${allDown ? 'are down' : 'aren’t working'}: ${names(group.map((i) => i.name))}`;
}
