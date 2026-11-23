/**
 * Find My through a Mac, in words and numbers both apps share (docs/implementation/macos/findmy.md §5): when the tab
 * reads again, what its one line says (the screen's own reason first, then a read under way, then why the last read
 * didn't work), each person's line, the map's size and zoom, where each person's avatar sits on the picture, the
 * exact picture's words, and how the box reads it while nobody looks. The tab is the Find My connection's
 * (docs/implementation/macos/findmy-connection.md); the Mac's page links to it. Pure; the hooks are `findmy-react.ts`.
 */
import { thingHref } from '@whombat/core';
import {
  type ConnectionView,
  findMyPlaceKey,
  findMyProblemText,
  HOST_FIND_MY_FRESH_MS,
  HOST_SCREEN_LIMITS,
  type HostFindMy,
  type HostFindMyMap,
  type HostFindMyPerson,
} from '@whombat/core/domain';
import { formatAgoIso } from './format';
import type { MacMay } from './macos';
import type { HostTone } from './thresholds';

/** The words of the Find My tab that aren't built from what was read. */
export const FIND_MY_WORDS = {
  title: 'Find My',
  people: 'People',
  readAgain: 'Read again',
  reading: (server: string) => `Reading Find My on ${server}…`,
  read: (ago: string) => `Read ${ago}`,
  note: 'Spots are where Find My’s address is, about 100 m. Show exactly takes Find My’s own map.',
  showExactly: 'Show exactly',
  /** The button's spoken name beside the others on the list. */
  showExactlyLabel: (name: string) => `Show exactly where ${name} is`,
  taking: (server: string) => `Taking the picture on ${server}…`,
  exactTitle: (name: string) => `Exactly where ${name} is`,
  exactLine: (server: string, when: string) => `Find My on ${server} · ${when}`,
  exactAlt: (name: string, server: string) => `Find My’s map of ${name} on ${server}`,
  noPlace: 'No location found',
  nearby: 'Nearby',
  nobody: (server: string) => `Nobody shares their location with Find My on ${server}.`,
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fit: 'Fit everyone',
  mapAlt: (server: string) => `Map of everyone Find My shows on ${server}`,
  drawing: 'Drawing the map…',
  close: 'Close',
  /** Under the map, when the box reads only for whoever has the page open. */
  readsWhileLooking: 'Reads only while someone looks',
  /** The Mac's page: its one link to the Find My connection that reads it. */
  linkTitle: 'Find My',
  linkHint: 'Opens Find My',
} as const;

/* Reading in the background ---------------------------------------------------------------------------- */

/** “every 15 minutes”, “every hour”, “every 2 hours”, “every minute”. */
export function findMyEvery(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0)
    return minutes === 60 ? 'every hour' : `every ${minutes / 60} hours`;
  return minutes === 1 ? 'every minute' : `every ${minutes} minutes`;
}

/**
 * The muted line under the map: how the box reads Find My while nobody looks. “Reads only while someone looks” (off, or
 * an older box that doesn't say), “Reads every 15 minutes”, or, when an automation is why, “Reads every 15 minutes for
 * “Tell me when Mara gets home””, when a one-time watch is, “Reads every 5 minutes while watching Noor Visser”, and when
 * the timeline is, “Reads every 15 minutes for the timeline”.
 */
export function findMyBackgroundLine(background: HostFindMy['background']): string {
  if (!background) return FIND_MY_WORDS.readsWhileLooking;
  const every = `Reads ${findMyEvery(background.everyMinutes)}`;
  if (background.automation) return `${every} for “${background.automation}”`;
  // A watch reads more often than the timeline, so it is the reason the person sees.
  if (background.watching) return `${every} while watching ${background.watching}`;
  return background.timeline ? `${every} for the timeline` : every;
}

/* The connection a Mac reads for -------------------------------------------------------------------------- */

/** The Find My catalog entry's id. */
export const FIND_MY_CATALOG_ID = 'findmy';

export interface FindMyConnectionLink {
  connectionId: string;
  label: string;
  /** The connection's page (`/things/connection:con_…`), which opens on its Find My tab. */
  href: string;
}

/**
 * The Find My connection that reads Find My on the Mac `serverId` (its `mac` field names the Mac), for the one link on
 * the Mac's page; null when none does. Each Mac has at most one; the first by the list's order otherwise.
 */
export function findMyConnectionOf(
  connections: readonly Pick<ConnectionView, 'id' | 'catalogId' | 'label' | 'fields'>[] | null | undefined,
  serverId: string,
): FindMyConnectionLink | null {
  const c = (connections ?? []).find((x) => x.catalogId === FIND_MY_CATALOG_ID && x.fields.mac === serverId);
  return c ? { connectionId: c.id, label: c.label, href: thingHref('connection', c.id) } : null;
}

/** The Mac each Find My connection reads, by its `mac` field: `[connectionId, serverId]`, the ones without left out. */
export function findMyMacs(
  connections: readonly Pick<ConnectionView, 'id' | 'catalogId' | 'fields'>[] | null | undefined,
): { connectionId: string; serverId: string }[] {
  return (connections ?? []).flatMap((c) =>
    c.catalogId === FIND_MY_CATALOG_ID && c.fields.mac
      ? [{ connectionId: c.id, serverId: c.fields.mac }]
      : [],
  );
}

/** Whether a person's place is Home in Find My's own words (case and spaces don't count). */
export function findMyAtHome(person: Pick<HostFindMyPerson, 'place'>): boolean {
  return !!person.place && findMyPlaceKey(person.place) === 'home';
}

/** “just now” under a minute, else “5 min ago”. */
export function findMyAgo(iso: string, now: number): string {
  return now - Date.parse(iso) < 60_000 ? 'just now' : formatAgoIso(iso, now);
}

/* When to read ------------------------------------------------------------------------------------- */

/** The tab reads when it opens: nothing read yet, or the last read is older than the server keeps as fresh. */
export function findMyStale(state: Pick<HostFindMy, 'reading' | 'readAt'>, now: number): boolean {
  if (state.reading) return false;
  if (!state.readAt) return true;
  return now - Date.parse(state.readAt) >= HOST_FIND_MY_FRESH_MS;
}

/** A read or an exact picture is under way: the tab asks for the state again shortly. */
export function findMyPolls(state: Pick<HostFindMy, 'reading' | 'exact'> | null | undefined): boolean {
  return !!state && (state.reading || state.exact?.state === 'taking');
}

/* The tab in words ----------------------------------------------------------------------------------- */

export interface FindMyPersonRow {
  id: string;
  name: string;
  /** The name on the map: the first word (“Ilse” for “Ilse de Wit”). */
  firstName: string;
  /** “Home · Now” in Find My's own words, or “No location found”. */
  line: string;
  nearby: boolean;
  /** Find My shows where they are, so its own map can be taken (Show exactly). */
  placed: boolean;
  /** Whombat found a spot for them on the map. */
  located: boolean;
  /** Their avatar's tone: an index into the five human tones (`HUMAN_TONES`). */
  tone: number;
}

export interface FindMyView {
  /** The tab's one line: the screen's reason, a read under way, or why the last read didn't work. */
  status: { tone: HostTone; text: string } | null;
  /** A read is under way, or about to start (nothing read yet). */
  reading: boolean;
  /** Read again may be pressed. */
  canRead: boolean;
  /** “Read 5 min ago”, once something was read. */
  readLine: string | null;
  people: FindMyPersonRow[];
  /** Read, and nobody is on the People tab. */
  empty: string | null;
  /** Someone has a spot: the map is worth drawing. */
  anyLocated: boolean;
}

export interface FindMyViewInput {
  /** The Mac's name as the page shows it. */
  name: string;
  now: number;
  /** Whether the Mac's screen can be used now (`macScreenView(…).screen`): its reason comes first. */
  screen: MacMay;
}

/** The first word of a name, for the map's small labels. */
export function findMyFirstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** How many human avatar tones there are (the design README's five). */
const TONES = 5;

/**
 * Each person's avatar tone, an index into the five: stable for the person (from their id), and not one a person
 * before them has while there are tones left, so the map's avatars tell apart.
 */
export function findMyTones(ids: readonly string[]): number[] {
  const used = new Set<number>();
  return ids.map((id) => {
    if (used.size >= TONES) used.clear();
    let i = (Number.parseInt(id.slice(0, 8), 16) || 0) % TONES;
    while (used.has(i)) i = (i + 1) % TONES;
    used.add(i);
    return i;
  });
}

/** A person's line: their place and when in Find My's own words, or that Find My has no place for them. */
export function findMyPersonLine(p: Pick<HostFindMyPerson, 'place' | 'when'>): string {
  if (!p.place) return FIND_MY_WORDS.noPlace;
  return p.when ? `${p.place} · ${p.when}` : p.place;
}

/**
 * The Find My tab from what Whombat read last (undefined: not answered yet). The screen's reason (the Mac not checking
 * in, the shell switch, Screen Sharing, its password) comes first, as the Screen tab says it, and stops a read.
 */
export function findMyView(state: HostFindMy | undefined, input: FindMyViewInput): FindMyView {
  const { name, now, screen } = input;
  const tones = findMyTones((state?.people ?? []).map((p) => p.id));
  const people: FindMyPersonRow[] = (state?.people ?? []).map((p, i) => ({
    id: p.id,
    name: p.name,
    firstName: findMyFirstName(p.name),
    line: findMyPersonLine(p),
    nearby: p.nearby,
    placed: !!p.place,
    located: !!p.location,
    tone: tones[i] ?? 0,
  }));
  const readAt = state?.readAt ?? null;
  // Nothing read and nothing wrong: the tab's own read is about to start.
  const pending = !state || (!state.reading && !readAt && !state.problem);
  const reading = screen.can && (!!state?.reading || pending);
  const status: FindMyView['status'] = !screen.can
    ? { tone: 'warn', text: screen.why }
    : reading
      ? { tone: 'mut', text: FIND_MY_WORDS.reading(name) }
      : state?.problem
        ? { tone: 'warn', text: findMyProblemText(state.problem.code, name, state.problem.message) }
        : null;
  return {
    status,
    reading,
    canRead: screen.can && !state?.reading,
    readLine: readAt ? FIND_MY_WORDS.read(findMyAgo(readAt, now)) : null,
    people,
    empty: readAt && people.length === 0 && !state?.problem ? FIND_MY_WORDS.nobody(name) : null,
    anyLocated: people.some((p) => p.located),
  };
}

/* The exact picture ---------------------------------------------------------------------------------- */

export type FindMyExactView =
  | { kind: 'taking'; text: string }
  | { kind: 'failed'; text: string }
  | { kind: 'ready'; text: string; takenAt: string };

/**
 * The exact picture of `person` as the dialog shows it: being taken (also before the server's answer names them),
 * failed with its reason, or ready with “Find My on studio · 12 s ago”.
 */
export function findMyExactView(
  state: Pick<HostFindMy, 'exact'> | undefined,
  person: string,
  server: string,
  now: number,
): FindMyExactView {
  const e = state?.exact;
  if (!e || e.person !== person || e.state === 'taking')
    return { kind: 'taking', text: FIND_MY_WORDS.taking(server) };
  if (e.state === 'failed' || !e.takenAt)
    return {
      kind: 'failed',
      text: findMyProblemText(e.problem?.code ?? 'failed', server, e.problem?.message),
    };
  return {
    kind: 'ready',
    text: FIND_MY_WORDS.exactLine(server, findMyAgo(e.takenAt, now)),
    takenAt: e.takenAt,
  };
}

/* The map ---------------------------------------------------------------------------------------------- */

/** The part of the world the map shows: its centre and its shorter side in metres. */
export interface FindMyRegion {
  lat: number;
  lon: number;
  spanM: number;
}

/** The spans the map may show (the contract's): 50 m to half the world. */
export const FIND_MY_SPAN = { min: 50, max: 20_000_000 } as const;

/** One step of ＋ or −: half or twice the span around the same centre, within the spans the Mac draws. */
export function findMyZoom(region: FindMyRegion, dir: 'in' | 'out'): FindMyRegion {
  const next = dir === 'in' ? region.spanM / 2 : region.spanM * 2;
  return {
    lat: region.lat,
    lon: region.lon,
    spanM: Math.round(Math.min(FIND_MY_SPAN.max, Math.max(FIND_MY_SPAN.min, next))),
  };
}

/** Whether ＋ or − still changes anything. */
export function findMyCanZoom(region: Pick<FindMyRegion, 'spanM'> | null, dir: 'in' | 'out'): boolean {
  if (!region) return true;
  return dir === 'in' ? region.spanM > FIND_MY_SPAN.min : region.spanM < FIND_MY_SPAN.max;
}

/** Points are asked in steps of this many, so a card that grows a little reuses the picture it has. */
const ASK_STEP = 32;

/**
 * The size to ask the Mac for, in points, for a map box of `box` (CSS pixels or points): rounded up to a step, within
 * the sides the Mac draws. Null until the box has a size.
 */
export function findMyMapAsk(box: { w: number; h: number }): { w: number; h: number } | null {
  if (!(box.w > 0) || !(box.h > 0)) return null;
  const side = (v: number) =>
    Math.min(HOST_SCREEN_LIMITS.mapSide, Math.max(64, Math.ceil(v / ASK_STEP) * ASK_STEP));
  return { w: side(box.w), h: side(box.h) };
}

/** The map's query: its size, the app's theme, and the region once someone zoomed (else the Mac fits everyone). */
export function findMyMapQuery(ask: { w: number; h: number }, dark: boolean, region: FindMyRegion | null) {
  return {
    w: ask.w,
    h: ask.h,
    dark: dark ? ('true' as const) : ('false' as const),
    ...(region ? { lat: region.lat, lon: region.lon, spanM: region.spanM } : {}),
  };
}

/** The region a map picture shows, to zoom from. */
export function findMyMapRegion(map: Pick<HostFindMyMap, 'lat' | 'lon' | 'spanM'>): FindMyRegion {
  return { lat: map.lat, lon: map.lon, spanM: map.spanM };
}

export interface FindMyPin {
  person: string;
  /** Where the avatar's middle sits in the box. */
  x: number;
  y: number;
  /** The name goes above the avatar: under it, it would leave the box. */
  above: boolean;
}

/** Avatars closer than this many points are moved apart so each stays readable. */
export const FIND_MY_PIN_GAP = 34;

/** Room an avatar's name takes under its middle. */
const NAME_ROOM = 44;

/**
 * Each person's avatar in the map box: the Mac's points (asked at `ask`) carried to a box of `box` showing the picture
 * as `cover` does (scaled to fill, centred), people outside the box left out, and avatars that would cover each other
 * moved sideways by one gap at a time, in the People tab's order.
 */
export function findMyPins(
  points: readonly { person: string; x: number; y: number }[],
  ask: { w: number; h: number },
  box: { w: number; h: number },
): FindMyPin[] {
  if (!(ask.w > 0 && ask.h > 0 && box.w > 0 && box.h > 0)) return [];
  const s = Math.max(box.w / ask.w, box.h / ask.h);
  const out: FindMyPin[] = [];
  for (const p of points) {
    const x0 = box.w / 2 + (p.x - ask.w / 2) * s;
    const y = box.h / 2 + (p.y - ask.h / 2) * s;
    if (x0 < 0 || x0 > box.w || y < 0 || y > box.h) continue;
    let x = x0;
    // Bounded: at most one step a pin already placed.
    for (let i = 0; i <= out.length && out.some((q) => Math.hypot(q.x - x, q.y - y) < FIND_MY_PIN_GAP); i++)
      x += FIND_MY_PIN_GAP;
    out.push({ person: p.person, x, y, above: y > box.h - NAME_ROOM });
  }
  return out;
}
