/**
 * The assistant's Find My (docs/decisions/findmy-connection.md): `findmy_people` answers where each person is, as Find
 * My on the connection's Mac shows them, optionally one person by name or first name. When the last read is older than
 * 2 minutes it reads first, through the Mac's own Find My store (a Mac someone is using is left alone), and waits up to
 * 45 seconds; otherwise, or when that read doesn't work, it answers the last read with its age and why. It never gives
 * pictures or coordinates. Outside an assistant's turn it refuses, as the Servers tools do.
 *
 * `findmy_timeline` (docs/decisions/findmy-timeline.md) answers where the people the person keeps a timeline of were on
 * a day, only in the person's own turns.
 */
import {
  FIND_MY_TIMELINE_DAYS,
  FindMyPeopleArgs,
  FindMyTimelineArgs,
  type FindMyTimelineSegment,
  type FindMyTimelineWhy,
  findMyDateAdd,
  findMyDayBounds,
  findMyPlaceKey,
  findMyProblemText,
  type HostFindMy,
  type HostFindMyPerson,
} from '@whombat/core';
import { dayKey, formatClock, formatDayDivider } from '@whombat/core/text';
import { eq } from 'drizzle-orm';
import { outsideCommandScope } from '../../commit/scope';
import { accounts, burrows, principals } from '../../db/schema/index';
import { zoneOf } from '../../domain/notify';
import { type FindMyStore, findMyFor } from '../../hosts/findmy';
import { macOf } from '../../hosts/findmy-connection';
import { type KeptPerson, keptTimelinePeople, nameList } from '../../hosts/findmy-timeline';
import { personTimelineDay } from '../../hosts/findmy-timeline-view';
import { knownServer, serverLabel } from '../../hosts/self';
import { failure, output, scope } from '../../hosts/tools-shared';
import { loadPrincipalRow } from '../../read/principals';
import { ConnectionArgumentError } from '../request';
import { connectionRow } from '../store';
import type { Adapter, AdapterCall, AdapterContext, AdapterTool } from './types';

/** How long the tool waits for a read it started (ms). */
export const FIND_MY_PEOPLE_WAIT_MS = 45_000;

export interface FindMyPeopleDeps {
  /** The call's hosts service and the assistant as its actor (`scope`). */
  scope: typeof scope;
  /** The process's Find My store. */
  store: (ctx: AdapterContext) => FindMyStore;
  /** Waits this long (tests make it resolve when they say). */
  wait: (ms: number) => Promise<void>;
  now: (ctx: AdapterContext) => number;
}

const DEFAULT_DEPS: FindMyPeopleDeps = {
  scope,
  store: (ctx) => findMyFor((ctx.call as NonNullable<AdapterContext['call']>).services),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
  now: (ctx) => (ctx.call as NonNullable<AdapterContext['call']>).services.clock().getTime(),
};

/** “just now”, “4 min ago”, “2 h ago”. */
function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 90) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** A person as the assistant reads them: never their spot on a map. */
function personOut(p: HostFindMyPerson) {
  return {
    name: p.name,
    place: p.place,
    ...(p.address ? { street: p.address } : {}),
    // Find My's own words for when it saw them (“Now”, “5 min ago”).
    ...(p.when ? { seen: p.when } : {}),
    ...(p.nearby ? { nearby: true } : {}),
  };
}

/** The people a `person` names: the whole name, else the first name, else a part of the name (without case). */
export function matchPeople<P extends { name: string }>(people: readonly P[], person: string): P[] {
  const want = person.trim().toLowerCase();
  const exact = people.filter((p) => p.name.toLowerCase() === want);
  if (exact.length) return exact;
  const first = people.filter((p) => p.name.toLowerCase().split(/\s+/)[0] === want);
  if (first.length) return first;
  return people.filter((p) => p.name.toLowerCase().includes(want));
}

/** The answer from what the store has now (pure). */
export function peopleAnswer(
  shown: HostFindMy | null,
  options: { mac: string; person?: string | undefined; now: number; stillReading: boolean },
) {
  const { mac } = options;
  if (!shown?.readAt) {
    if (shown?.problem)
      return { error: findMyProblemText(shown.problem.code, mac, shown.problem.message), isError: true };
    return {
      error: options.stillReading
        ? `Whombat is still reading Find My on ${mac}. Ask again in a minute.`
        : `Whombat hasn’t read Find My on ${mac} yet.`,
      isError: true,
    };
  }
  const read = ago(options.now - new Date(shown.readAt).getTime());
  const why = shown.problem
    ? `It couldn’t read again just now: ${findMyProblemText(shown.problem.code, mac, shown.problem.message)}`
    : options.stillReading
      ? 'A new read is still under way.'
      : null;
  const picked = options.person ? matchPeople(shown.people, options.person) : shown.people;
  const missing =
    options.person && !picked.length
      ? `Nobody called ${options.person} is on Find My on ${mac}. People there: ${shown.people
          .map((p) => p.name)
          .join(', ')}.`
      : null;
  return {
    answer: {
      mac,
      read,
      readAt: shown.readAt,
      ...(why ? { note: `This is the read from ${read}. ${why}` } : {}),
      ...(missing ? { notFound: missing } : {}),
      people: picked.map(personOut),
    },
    isError: false,
  };
}

/** `findmy_people`, with the waits and the store it uses. */
export function findMyPeopleTool(deps: FindMyPeopleDeps = DEFAULT_DEPS): AdapterTool {
  return async (ctx, args) => {
    const parsed = FindMyPeopleArgs.safeParse(args);
    if (!parsed.success) throw new ConnectionArgumentError('person: a name or first name, or leave it out.');
    const serverId = ctx.fields.mac?.trim();
    if (!serverId)
      throw new ConnectionArgumentError('This Find My connection names no Mac. Pick one in its settings.');
    let s: Awaited<ReturnType<typeof scope>>;
    try {
      s = await deps.scope(ctx);
    } catch (err) {
      if (err instanceof ConnectionArgumentError) throw err;
      return failure(err, { server: serverId });
    }
    // The Mac's name as screens give it (the fleet read notes the names people gave their servers).
    if (!knownServer(serverId)) await s.hosts.fleetRaw().catch(() => null);
    const mac = serverLabel(serverId);
    const store = deps.store(ctx);
    // A read starts unless one runs or the last worked under two minutes ago; it leaves a Mac in use alone.
    const started = outsideCommandScope(() => store.refresh(s.hosts, serverId, s.actor('admin'), mac));
    let stillReading = false;
    if (started.reading)
      stillReading = !(await Promise.race([
        store.idle(serverId).then(() => true),
        deps.wait(FIND_MY_PEOPLE_WAIT_MS).then(() => false),
      ]));
    const shown = store.view(serverId);
    const res = peopleAnswer(shown, {
      mac,
      person: parsed.data.person,
      now: deps.now(ctx),
      stillReading: stillReading || shown.reading,
    });
    return 'error' in res ? output({ error: res.error }, true) : output(res.answer);
  };
}

/* The timeline ------------------------------------------------------------------------------------------------- */

/** Where the person turns a timeline on, as the tool says it. */
const TURN_IT_ON = 'Turn it on under Find My → Timeline.';

/** The words `findmy_timeline` answers with when there is nothing to tell (made-up names in the examples). */
export const FIND_MY_TIMELINE_TEXT = {
  off: `Whombat keeps no Find My timeline. ${TURN_IT_ON}`,
  /** “Whombat keeps no timeline for Ilse. Turn it on under Find My → Timeline.” */
  notKept: (firstNames: readonly string[]) =>
    `Whombat keeps no timeline for ${nameList(firstNames)}. ${TURN_IT_ON}`,
  tooOld: `Whombat keeps ${FIND_MY_TIMELINE_DAYS} days.`,
  future: 'That day hasn’t come yet.',
  nothing: 'Nothing kept that day.',
  personal: 'The Find My timeline is read only in your own chats.',
} as const;

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** A stretch without a place in a few words, and why when a read didn't work. */
function whyWords(why: FindMyTimelineWhy): { what: string; because: string } {
  if (why === 'no_location') return { what: 'no location', because: '' };
  if (why === 'not_read') return { what: 'not read', because: '' };
  if (why === 'in_use') return { what: 'not read', because: ' (someone was using the Mac)' };
  if (why === 'timeout') return { what: 'not read', because: ' (the Mac didn’t answer)' };
  return { what: 'not read', because: ' (Find My couldn’t be read)' };
}

/**
 * One person's day as lines in the person's time zone (pure): “08:30–12:15 Home (Kerkstraat 4, Rietveen)”, “12:15–12:40
 * on the way”, “13:00–14:10 not read (someone was using the Mac)”, a stay still going “16:05–now Wilgendam, still
 * there”, a stretch without a place inside a stay after it (“; no location 02:10–06:30”). Never coordinates.
 */
export function timelineLines(
  segments: readonly FindMyTimelineSegment[],
  opts: { timeZone: string; dayTo: string },
): string[] {
  const end = new Date(opts.dayTo).getTime();
  const clock = (t: string) => (new Date(t).getTime() >= end ? '24:00' : formatClock(t, opts.timeZone));
  const range = (from: string, to: string, ongoing = false) => {
    const a = clock(from);
    if (ongoing) return `${a}–now`;
    const b = clock(to);
    return a === b ? a : `${a}–${b}`;
  };
  return segments.map((s) => {
    if (s.kind === 'trip') return `${range(s.from, s.to)} on the way`;
    if (s.kind === 'gap') {
      const w = whyWords(s.why);
      return `${range(s.from, s.to)} ${w.what}${w.because}`;
    }
    const street =
      s.address && findMyPlaceKey(s.address) !== findMyPlaceKey(s.place) ? ` (${s.address})` : '';
    const holes = s.holes
      .map((h) => {
        const w = whyWords(h.why);
        return `; ${w.what} ${range(h.from, h.to)}${w.because}`;
      })
      .join('');
    return `${range(s.from, s.to, s.ongoing)} ${s.place}${street}${s.ongoing ? ', still there' : ''}${holes}`;
  });
}

/** Whom a `findmy_timeline` call is about: the kept people it names (all when none), and those named who aren't kept. */
export function pickTimelinePeople(
  kept: readonly KeptPerson[],
  others: readonly { id: string; name: string }[],
  person: string | undefined,
): { picked: KeptPerson[]; notKept: string[]; notFound: boolean } {
  const keptIds = new Set(kept.map((k) => k.person));
  const unkept = others.filter((o) => !keptIds.has(o.id));
  if (!person) return { picked: [...kept], notKept: unkept.map((o) => o.name), notFound: false };
  const everyone = [
    ...kept.map((k) => ({ id: k.person, name: k.name })),
    ...unkept.filter((o, i) => unkept.findIndex((x) => x.id === o.id) === i),
  ];
  const named = new Set(matchPeople(everyone, person).map((p) => p.id));
  return {
    picked: kept.filter((k) => named.has(k.person)),
    notKept: unkept.filter((o) => named.has(o.id)).map((o) => o.name),
    notFound: named.size === 0,
  };
}

/** The zone the person's days are in: their own, else their Whombat's, else UTC. */
async function personZone(call: AdapterCall, personId: string): Promise<string> {
  const [r] = await call.services.db
    .select({ preferences: accounts.preferences, burrowZone: burrows.timeZone })
    .from(principals)
    .innerJoin(burrows, eq(burrows.id, principals.burrowId))
    .leftJoin(accounts, eq(accounts.id, principals.accountId))
    .where(eq(principals.id, personId));
  const own = (r?.preferences as { timeZone?: string | null } | null | undefined)?.timeZone;
  return zoneOf(own, r?.burrowZone);
}

export interface FindMyTimelineDeps {
  /** The person's time zone. */
  zone: (call: AdapterCall, personId: string) => Promise<string>;
}

/**
 * `findmy_timeline { person?, date? }`: where the kept people were on a day, in the person's own turns only (never an
 * outsiders' turn), the day in the person's time zone (today when none is given). It names who isn't kept, says when
 * nothing is, and that Whombat keeps 30 days.
 */
export function findMyTimelineTool(deps: FindMyTimelineDeps = { zone: personZone }): AdapterTool {
  return async (ctx, args) => {
    const parsed = FindMyTimelineArgs.safeParse(args);
    if (!parsed.success)
      throw new ConnectionArgumentError(
        'person: a name or first name; date: YYYY-MM-DD. Both may be left out.',
      );
    const call = ctx.call;
    if (!call) throw new ConnectionArgumentError('This connection’s tools run only in an assistant’s turn.');
    const services = call.services;
    // Only the person's own turns: an outsiders' turn has no person, and nobody else's turn reads it.
    const person = call.personId ? await loadPrincipalRow(services.db, call.personId) : null;
    if (person?.kind !== 'person' || person.burrowId !== call.burrowId)
      return output({ error: FIND_MY_TIMELINE_TEXT.personal }, true);
    const row = await connectionRow(services.db, call.connectionId);
    if (!row) throw new ConnectionArgumentError('This Find My connection is gone.');
    const timeZone = await deps.zone(call, person.id);
    const now = services.clock();
    const today = dayKey(now, timeZone);
    const date = parsed.data.date ?? today;
    if (date > today) return output({ date, note: FIND_MY_TIMELINE_TEXT.future });
    if (date < findMyDateAdd(today, -FIND_MY_TIMELINE_DAYS))
      return output({ date, note: FIND_MY_TIMELINE_TEXT.tooOld });
    const kept = await keptTimelinePeople(services.db, row.id);
    if (!kept.length) return output({ date, note: FIND_MY_TIMELINE_TEXT.off });
    const mac = macOf(row);
    const read = (mac ? findMyFor(services).peek(mac)?.people : null) ?? [];
    const { picked, notKept, notFound } = pickTimelinePeople(kept, read, parsed.data.person);
    if (notFound)
      return output({
        date,
        notFound: `Nobody called ${parsed.data.person} is on the timeline. Kept: ${nameList(kept.map((k) => k.name))}.`,
      });
    const { to } = findMyDayBounds(date, timeZone);
    const people = [];
    for (const k of picked) {
      const segments = (await personTimelineDay(services, row, k.person, date, timeZone, kept)) ?? [];
      const lines = timelineLines(segments, { timeZone, dayTo: to });
      people.push({ name: k.name, day: lines.length ? lines : [FIND_MY_TIMELINE_TEXT.nothing] });
    }
    return output({
      date,
      day: formatDayDivider(findMyDayBounds(date, timeZone).from, now, timeZone),
      timeZone,
      people,
      ...(notKept.length ? { notKept: FIND_MY_TIMELINE_TEXT.notKept(notKept.map(firstName)) } : {}),
    });
  };
}

/** Find My's typed tools (`findmy_people`, `findmy_timeline`), served through the connection's adapter. */
export const FINDMY_ADAPTER: Adapter = {
  findmy_people: findMyPeopleTool(),
  findmy_timeline: findMyTimelineTool(),
};
