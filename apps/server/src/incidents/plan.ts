/**
 * What a pass of the incident watcher decides, pure, with the clock given:
 *
 * - **Incidents.** A thing whose look is bad or down on two passes in a row opens one (amber never does); one not seen on
 *   two passes in a row ends, at the first of them. While it lasts, going from a problem to down makes it a `down` one.
 *   A server not read on this pass is unknown: nothing opens or ends for it. Nor for a thing that left the looks because
 *   it is held (kept quiet, or down because of something else) or because Whombat couldn't see it: only seeing it fine
 *   again ends its incident.
 * - **The push.** An incident open 10 minutes, about which no research finding pushed meanwhile, is pushed once,
 *   together with the others that opened within a few minutes of it. Not one that something else took down with it
 *   (its cause), nor one older than an hour when Whombat first could push it (it was down before Whombat watched, or
 *   while it couldn't push), nor past the day's cap or a thing's.
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
}

/** What the pass before saw: when, and the things with a look then. */
export interface PassBefore {
  at: Date;
  things: ReadonlySet<string>;
  /** It was the watcher's first pass since it started: what it saw was bad before Whombat watched. */
  first?: boolean;
}

export interface IncidentPassInput {
  looks: readonly SeenLook[];
  open: readonly OpenIncident[];
  /** Null on the first pass after a start: nothing opens or ends yet. */
  before: PassBefore | null;
  /** The servers' cards were read: a server without a look is fine; else unknown. */
  serversRead: boolean;
  /**
   * Things without a look that Whombat didn't see fine this pass: held (kept quiet, down because of something else) or
   * not seen (a check that couldn't run, a thing not checked). Their open incidents neither end nor count a pass.
   */
  blind?: ReadonlySet<string>;
  /** The Whombat has no incidents yet: its first ones are what it found already bad when it started watching. */
  noneYet?: boolean;
  now: Date;
}

export interface IncidentPassPlan {
  /** `pushed`: bad before Whombat watched, so it is told as already pushed (no push now). */
  opened: (SeenLook & { startedAt: Date; pushed?: true })[];
  /** Open incidents that got worse (a problem now down), or learned their cause. */
  changed: {
    id: string;
    nature: IncidentNature;
    words: string;
    cause: SeenLook['cause'];
    worse: boolean;
    check?: string | null;
    subject?: string;
  }[];
  ended: { id: string; endedAt: Date }[];
  /** What this pass saw, for the next. */
  seen: PassBefore;
}

/** One pass's incidents, pure. */
export function planIncidents(input: IncidentPassInput): IncidentPassPlan {
  const { now, before } = input;
  const byThing = new Map(input.looks.map((l) => [l.thing, l]));
  const openThings = new Set(input.open.map((o) => o.thing));
  const unknown = (thing: string) => thing.startsWith('server:') && !input.serversRead;
  const opened: IncidentPassPlan['opened'] = [];
  const changed: IncidentPassPlan['changed'] = [];
  const ended: IncidentPassPlan['ended'] = [];
  const keep = new Set<string>();
  for (const inc of input.open) {
    const look = byThing.get(inc.thing);
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
          ...(worse ? { check: look.check, subject: look.subject } : {}),
        });
      continue;
    }
    // Held or not seen isn't fine: it stays open, and seeing it fine starts the two passes again.
    if (input.blind?.has(inc.thing)) {
      keep.add(inc.thing);
      continue;
    }
    if (unknown(inc.thing) || !before || before.things.has(inc.thing)) continue;
    ended.push({ id: inc.id, endedAt: before.at });
  }
  // The update itself mustn't push about what was red for days: on a Whombat's first incidents, what its watcher's
  // first pass already saw opens as told.
  const inherited = !!(input.noneYet && before?.first);
  if (before)
    for (const look of input.looks) {
      if (openThings.has(look.thing) || !before.things.has(look.thing)) continue;
      const since = look.since && look.since < before.at ? look.since : before.at;
      opened.push({ ...look, startedAt: since, ...(inherited ? { pushed: true as const } : {}) });
    }
  const things = new Set([...input.looks.map((l) => l.thing), ...keep]);
  // Servers not read this pass keep what the pass before saw of them.
  if (!input.serversRead && before) for (const t of before.things) if (t.startsWith('server:')) things.add(t);
  return { opened, changed, ended, seen: { at: now, things, first: before === null } };
}

/** An open incident as the push weighs it. */
export interface PushCandidate extends OpenIncident {
  /** A research finding about this thing pushed since the incident started. */
  findingPushed: boolean;
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
 * it and could be pushed too.
 */
export function planPush(input: PushInput): PushCandidate[] {
  if (input.pushedToday >= PUSHES_PER_DAY) return [];
  const now = input.now.getTime();
  const pushable = input.open.filter(
    (i) =>
      !i.pushedAt &&
      !i.cause &&
      !i.findingPushed &&
      now - i.startedAt.getTime() <= PUSH_FRESH_MS &&
      (input.pushedTodayOf.get(i.thing) ?? 0) < PUSHES_PER_THING,
  );
  const due = pushable
    .filter((i) => now - i.startedAt.getTime() >= PUSH_AFTER_MS)
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const first = due[0];
  if (!first) return [];
  const start = first.startedAt.getTime();
  return pushable.filter((i) => Math.abs(i.startedAt.getTime() - start) <= PUSH_GROUP_MS).sort(pushOrder);
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
