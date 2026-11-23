/**
 * Find My on a Mac's page (docs/implementation/macos/findmy.md §4): Whombat reads the Find My app on a Mac through
 * Whombat Helper, as a person reads it, finds each person's place with the Mac's own geocoder and has the Mac draw the
 * map. Find My has no API and gives no coordinates, so a person's spot is their address's (about 100 m); “Show exactly”
 * cuts Find My's own map of that person from the Mac's screen.
 *
 * Someone using the Mac is left alone (`in_use`). A locked Mac is unlocked for the read and locked again after it, and
 * Find My is quit again when it wasn't open, whatever happened in between. One job at a time per Mac.
 *
 * What was read lives in this process's memory only and goes an hour after the last look, or once a Find My connection
 * stops reading it in the background: Whombat keeps no history of where anyone was, never logs a place and signs none of
 * these steps (the hosts service audits them, without places). After every read the Find My connections on that Mac
 * compare each person's place (`findmy-places.ts`).
 */
import { createHash } from 'node:crypto';
import {
  findMyProblemText,
  HOST_FIND_MY_FRESH_MS,
  HOST_FIND_MY_PEOPLE_MAX,
  HOST_SCREEN_LIMITS,
  type HostFindMy,
  type HostFindMyCode,
  type HostFindMyExact,
  type HostFindMyMap,
  type HostFindMyMapQuery,
  type HostFindMyPerson,
  type HostFindMyPicture,
  type HostFindMyProblem,
  type HostScreenBody,
  type HostScreenCode,
  type HostScreenOp,
  type HostScreenResult,
  type HostUiElement,
} from '@whombat/core';
import { ApiError } from '../lib/errors';
import { type HostsActor, HostsError, HostsUnavailable } from './client';
import { hostsErrorText } from './errors';
import { screenStep } from './screen';
import { HOSTS_TEXT, type HostsService } from './service';

type Hosts = Pick<HostsService, 'call'>;

/** Find My's bundle id: its name is the Mac's language's, the id is the same everywhere. */
export const FIND_MY_APP = 'com.apple.findmy';

/** Someone touched the Mac's keyboard or mouse this recently (seconds): they are using it, so Whombat waits. */
export const FIND_MY_IN_USE_S = 60;

/** The first Whombat Helper that reads Find My (an element's own actions, quit, the Mac's maps). */
const HELPER_MIN = [1, 1, 0] as const;

/** The steps Whombat Helper 1.1.0 brought: an older helper or agent answers them `unsupported`. */
const NEW_OPS: ReadonlySet<HostScreenOp> = new Set(['ui.action', 'ui.quit', 'map.geocode', 'map.snapshot']);

/** Places Find My names after the person's own cards: alone they say nothing about where on a map. */
const OWN_PLACE_LABELS: ReadonlySet<string> = new Set(['home', 'work', 'school', 'gym']);

/** How long things are kept and waited for (ms); tests shorten nothing, they inject the clock and the waits. */
export const FIND_MY_TIMING = {
  /** What was read goes this long after the last look. */
  keepMs: 60 * 60_000,
  /** An exact picture is kept this long. */
  pictureMs: 10 * 60_000,
  /** The same map picture answers again for this long. */
  mapMs: 60_000,
  /** Find My gets this many tries, `pollMs` apart, to show its tabs (8 s). */
  openTries: 16,
  pollMs: 500,
  /** The sidebar follows a pressed tab or row a moment later. */
  settleMs: 700,
  /** Tries for the sidebar to follow. */
  settleTries: 3,
  /** Find My's map moves to the person and draws its tiles. */
  mapSettleMs: 1500,
  /** How often the store forgets what is past its time even when nobody asks. */
  sweepMs: 5 * 60_000,
} as const;
export type FindMyTiming = { -readonly [K in keyof typeof FIND_MY_TIMING]: number };

/* Reading Find My's rows (pure) -------------------------------------------------------------------------------------- */

/** Find My's word for a person near the Mac. Only English is known; in other languages it reads as their place. */
const NEARBY = 'nearby';

/**
 * How far away someone is (“5,5 km”, “800 m”, “3.4 mi”): never a street, though a decimal comma looks like one, and no
 * place either.
 */
const DISTANCE = /^[<~≈]?\s*\d+(?:[.,]\d+)?\s*(?:km|m|mi|ft|yd)$/i;

/** A row of Find My's sidebar, in Find My's own words. */
export interface FindMyRow {
  name: string;
  place: string | null;
  address: string | null;
  when: string | null;
  nearby: boolean;
}

/** A row's parts: Find My joins them with a middle dot between no-break spaces. */
export function rowParts(description: string): string[] {
  return description
    .split('·')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * A sidebar row's description as name, place, street, when and nearby: “Mara Visser · Nearby · Home · Now”, a selected
 * row “Mara Visser · Home · Nearby · Damrak 1, Amsterdam · 5 minutes ago”, someone further away “Ruben Visser · 5,5 km
 * · Lelystad · Now”. The name is first and the when last; a distance is left out; the street is the part with a comma;
 * the place is what is left. A row of two parts (“Mara’s Keys · No location found”) has no place.
 */
export function parseFindMyRow(description: string): FindMyRow | null {
  const parts = rowParts(description);
  const name = parts[0];
  if (!name) return null;
  const when = parts.length >= 2 ? (parts[parts.length - 1] ?? null) : null;
  const middle = parts.length >= 3 ? parts.slice(1, -1).filter((p) => !DISTANCE.test(p)) : [];
  const nearby = middle.some((p) => p.toLowerCase() === NEARBY);
  const address = middle.find((p) => p.includes(',')) ?? null;
  const place = middle.find((p) => p !== address && p.toLowerCase() !== NEARBY) ?? null;
  return {
    name: name.slice(0, 200),
    place: place?.slice(0, 300) ?? null,
    address: address?.slice(0, 300) ?? null,
    when: when?.slice(0, 100) ?? null,
    nearby,
  };
}

/** A person's id: the same for the same name on every read (12 hex characters of its SHA-256). */
export function findMyPersonId(name: string): string {
  return createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 12);
}

/** Find My's rows in a list of the app's elements: buttons whose description has the middle dot, each name once. */
export function findMyRows(elements: readonly HostUiElement[]): FindMyRow[] {
  const rows: FindMyRow[] = [];
  const seen = new Set<string>();
  for (const e of elements) {
    if (e.role !== 'AXButton' || !e.description?.includes('·')) continue;
    const row = parseFindMyRow(e.description);
    if (!row || seen.has(row.name)) continue;
    seen.add(row.name);
    rows.push(row);
    if (rows.length >= HOST_FIND_MY_PEOPLE_MAX) break;
  }
  return rows;
}

/** Find My's tabs (People, Devices, Items, Me), People first in any language. */
const tabsOf = (elements: readonly HostUiElement[]) => elements.filter((e) => e.role === 'AXRadioButton');

/** The window's largest picture: Find My's map. */
export function largestImage(elements: readonly HostUiElement[]): HostUiElement | null {
  let best: HostUiElement | null = null;
  for (const e of elements)
    if (e.role === 'AXImage' && e.w > 0 && e.h > 0 && (!best || e.w * e.h > best.w * best.h)) best = e;
  return best;
}

/** Whether a helper's version is older than the first that reads Find My; an unreadable one isn't judged here. */
export function helperTooOld(version: string | null | undefined): boolean {
  const m = version?.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  for (let i = 0; i < 3; i++) {
    const have = v[i] ?? 0;
    const need = HELPER_MIN[i] ?? 0;
    if (have !== need) return have < need;
  }
  return false;
}

/** What the geocoder is asked for a person: the street, else a place that is somewhere (not “Home”). */
export function geocodeQuery(p: Pick<HostFindMyPerson, 'address' | 'place'>): string | null {
  if (p.address) return p.address;
  if (p.place && !OWN_PLACE_LABELS.has(p.place.toLowerCase())) return p.place;
  return null;
}

/* Steps on the Mac --------------------------------------------------------------------------------------------------- */

/** A job ended for a reason the person reads (`findMyProblemText`). */
export class FindMyFailed extends Error {
  constructor(readonly problem: HostFindMyProblem) {
    super(problem.code);
    this.name = 'FindMyFailed';
  }
}

/** A refused step as a problem: a step the helper doesn't know means it (or its agent) is older than Find My. */
export function stepProblem(
  op: HostScreenOp,
  r: Pick<HostScreenResult, 'code' | 'message'>,
  instead: Partial<Record<HostScreenCode, HostFindMyCode>> = {},
): HostFindMyProblem {
  const code: HostScreenCode = r.code ?? 'failed';
  const mapped: HostFindMyCode =
    instead[code] ?? (code === 'unsupported' && NEW_OPS.has(op) ? 'helper_old' : code);
  return r.message ? { code: mapped, message: r.message } : { code: mapped };
}

/** Why a job stopped, as the person reads it; the hosts service's own refusals in Whombat's words. */
export function problemOf(err: unknown, label: string): HostFindMyProblem {
  if (err instanceof FindMyFailed) return err.problem;
  if (err instanceof HostsUnavailable)
    return err.reason === 'timeout' ? { code: 'timeout' } : { code: 'failed', message: HOSTS_TEXT.down };
  if (err instanceof HostsError)
    return {
      code: err.status === 501 ? 'unsupported' : 'failed',
      message: hostsErrorText(err, { server: label, op: 'screen' }),
    };
  return { code: 'failed' };
}

/** The screen steps of one job, as the person who asked for it. */
class Steps {
  constructor(
    private readonly hosts: Hosts,
    readonly serverId: string,
    private readonly actor: HostsActor,
  ) {}

  /** A step, refused or not. */
  try(body: HostScreenBody): Promise<HostScreenResult> {
    return screenStep(this.hosts, this.serverId, body, this.actor);
  }

  /** A step that must work: its refusal ends the job with the Mac's reason. */
  async must(
    body: HostScreenBody,
    instead?: Partial<Record<HostScreenCode, HostFindMyCode>>,
  ): Promise<HostScreenResult> {
    const r = await this.try(body);
    if (!r.ok) throw new FindMyFailed(stepProblem(body.op, r, instead));
    return r;
  }

  /** A step to put things back: tried once, whatever it answers. */
  async quietly(body: HostScreenBody): Promise<boolean> {
    try {
      return (await this.try(body)).ok;
    } catch {
      return false;
    }
  }

  /** Find My's elements. */
  list(): Promise<HostScreenResult> {
    return this.must({ op: 'ui.list', app: FIND_MY_APP, limit: HOST_SCREEN_LIMITS.list });
  }
}

type Sleep = (ms: number) => Promise<void>;

/** The screen's size the Mac reported, to keep a crop inside it. */
interface ScreenSize {
  w: number | null;
  h: number | null;
}

/**
 * Opens Find My on the Mac for `work` and puts the Mac back after it: Find My quit again when it wasn't open, the
 * screen locked again when it was locked. Someone using the Mac, a helper without Accessibility or older than Find My
 * ends it before anything moves on the screen.
 */
async function withFindMy<T>(s: Steps, work: (screen: ScreenSize) => Promise<T>): Promise<T> {
  const st = await s.must({ op: 'status' });
  const helper = st.helper;
  if (!helper?.installed || !helper.running) throw new FindMyFailed({ code: 'no_helper' });
  if (helper.ax === false) throw new FindMyFailed({ code: 'no_access' });
  // A status without the idle time comes from an agent or helper older than Find My: such an agent would also send
  // the whole screen for the cropped picture.
  if (helperTooOld(helper.version) || helper.idleS === undefined)
    throw new FindMyFailed({ code: 'helper_old' });
  const locked = st.status?.locked === true;
  if (!locked && helper.idleS !== null && helper.idleS < FIND_MY_IN_USE_S)
    throw new FindMyFailed({ code: 'in_use' });
  const screen = { w: st.status?.w ?? null, h: st.status?.h ?? null };
  try {
    // Inside the try: an unlock that timed out may still have unlocked the Mac, so it is locked again either way.
    if (locked) await s.must({ op: 'unlock' });
    const apps = await s.must({ op: 'ui.apps' });
    const wasOpen = (apps.apps ?? []).some((a) => a.bundleId?.toLowerCase() === FIND_MY_APP);
    try {
      await s.must({ op: 'ui.open', target: FIND_MY_APP }, { not_found: 'no_find_my' });
      return await work(screen);
    } finally {
      if (!wasOpen) await s.quietly({ op: 'ui.quit', app: FIND_MY_APP });
    }
  } finally {
    if (locked) await s.quietly({ op: 'keys', keys: 'ctrl+cmd+q' });
  }
}

/** Waits until Find My's window shows its tabs (up to 8 s): a Mac without Find My, or signed out, never does. */
async function findMyTabs(s: Steps, t: FindMyTiming, sleep: Sleep): Promise<HostUiElement[]> {
  for (let i = 0; i < t.openTries; i++) {
    const r = await s.try({ op: 'ui.list', app: FIND_MY_APP, limit: HOST_SCREEN_LIMITS.list });
    if (r.ok) {
      const tabs = tabsOf(r.elements ?? []);
      if (tabs.length) return tabs;
    } else if (r.code !== 'not_found' && r.code !== 'busy' && r.code !== 'timeout' && r.code !== 'failed')
      throw new FindMyFailed(stepProblem('ui.list', r));
    await sleep(t.pollMs);
  }
  throw new FindMyFailed({ code: 'no_find_my' });
}

/** Presses People (the first tab, by its own name) and answers Find My's elements once the sidebar shows it. */
async function showPeople(s: Steps, t: FindMyTiming, sleep: Sleep): Promise<HostUiElement[]> {
  const people = (await findMyTabs(s, t, sleep))[0];
  const name = people?.description || people?.title;
  if (!name) throw new FindMyFailed({ code: 'no_find_my' });
  await s.must({ op: 'ui.press', app: FIND_MY_APP, name, role: 'radio' }, { not_found: 'no_find_my' });
  let elements: HostUiElement[] = [];
  for (let i = 0; i < t.settleTries; i++) {
    await sleep(t.settleMs);
    elements = (await s.list()).elements ?? [];
    // A chosen tab says 1; one that doesn't say is taken as chosen.
    const tab = tabsOf(elements)[0];
    if (!tab?.value || tab.value === '1') break;
  }
  return elements;
}

/** Presses a person's row: by its whole description first, by the name when the row changed since the list. */
async function pressRow(s: Steps, name: string, description: string | null): Promise<boolean> {
  const press = (n: string) => s.try({ op: 'ui.press', app: FIND_MY_APP, name: n, role: 'button' });
  let r = description && description.length <= HOST_SCREEN_LIMITS.name ? await press(description) : null;
  if (!r || (!r.ok && r.code === 'not_found')) r = await press(name);
  if (r.ok) return true;
  if (r.code === 'not_found') return false;
  throw new FindMyFailed(stepProblem('ui.press', r));
}

/** The street Find My shows once a person's row is chosen, or null when it shows none. */
async function streetOf(s: Steps, t: FindMyTiming, sleep: Sleep, row: FindMyRow, description: string | null) {
  if (!(await pressRow(s, row.name, description))) return null;
  for (let i = 0; i < t.settleTries; i++) {
    await sleep(t.settleMs);
    const chosen = findMyRows((await s.list()).elements ?? []).find((r) => r.name === row.name);
    if (chosen?.address) return chosen.address;
  }
  return null;
}

/** A person as read, before the geocoder. */
type Read = Omit<HostFindMyPerson, 'location'>;

/** Find My's People with the street of each who has a place. */
async function readPeople(s: Steps, t: FindMyTiming, sleep: Sleep): Promise<Read[]> {
  const elements = await showPeople(s, t, sleep);
  const descriptions = new Map<string, string>();
  for (const e of elements)
    if (e.role === 'AXButton' && e.description?.includes('·')) {
      const name = parseFindMyRow(e.description)?.name;
      if (name && !descriptions.has(name)) descriptions.set(name, e.description);
    }
  const people: Read[] = [];
  for (const row of findMyRows(elements)) {
    const address = row.place ? await streetOf(s, t, sleep, row, descriptions.get(row.name) ?? null) : null;
    people.push({
      id: findMyPersonId(row.name),
      name: row.name,
      place: row.place,
      address: address ?? row.address,
      when: row.when,
      nearby: row.nearby,
    });
  }
  return people;
}

/** Each person's place from the Mac's geocoder; a failure leaves them without one and says why. */
async function locate(
  s: Steps,
  people: readonly Read[],
  label: string,
): Promise<{ people: HostFindMyPerson[]; problem: HostFindMyProblem | null }> {
  const queries = [...new Set(people.map(geocodeQuery).filter((q): q is string => q !== null))];
  const found = new Map<string, HostFindMyPerson['location']>();
  let problem: HostFindMyProblem | null = null;
  for (let i = 0; i < queries.length && !problem; i += HOST_SCREEN_LIMITS.queries) {
    const batch = queries.slice(i, i + HOST_SCREEN_LIMITS.queries);
    const r = await s.try({ op: 'map.geocode', queries: batch }).catch((err: unknown) => {
      problem = problemOf(err, label);
      return null;
    });
    if (!r) break;
    if (!r.ok) {
      problem = stepProblem('map.geocode', r);
      break;
    }
    batch.forEach((q, j) => {
      const p = r.places?.[j];
      if (p) found.set(q, { lat: p.lat, lon: p.lon, accuracyM: p.accuracyM });
    });
  }
  return {
    people: people.map((p) => {
      const q = geocodeQuery(p);
      return { ...p, location: (q && found.get(q)) || null };
    }),
    problem,
  };
}

/** A crop of the map inside the screen, in its pixels. */
export function cropOf(e: Pick<HostUiElement, 'x' | 'y' | 'w' | 'h'>, screen: ScreenSize) {
  const max = HOST_SCREEN_LIMITS.position;
  const x = Math.min(Math.max(0, e.x), max);
  const y = Math.min(Math.max(0, e.y), max);
  let w = Math.max(1, Math.min(e.w - (x - e.x), max));
  let h = Math.max(1, Math.min(e.h - (y - e.y), max));
  if (screen.w) w = Math.max(1, Math.min(w, screen.w - x));
  if (screen.h) h = Math.max(1, Math.min(h, screen.h - y));
  return { x, y, w, h };
}

/**
 * Whether a picture is the crop that was asked for: its shape is the crop's. An agent that doesn't cut would answer
 * the whole screen, which must never pass for Find My's map.
 */
export function isCropOf(look: Pick<HostScreenResult, 'w' | 'h'>, crop: { w: number; h: number }): boolean {
  if (!look.w || !look.h) return false;
  const expected = (crop.h * look.w) / crop.w;
  return look.w <= crop.w + 1 && Math.abs(look.h - expected) <= Math.max(2, expected * 0.02);
}

/** Find My's own map of one person, from the Mac's screen. */
async function exactPicture(
  s: Steps,
  t: FindMyTiming,
  sleep: Sleep,
  person: HostFindMyPerson,
  screen: ScreenSize,
): Promise<Omit<HostFindMyPicture, 'server' | 'person' | 'takenAt'>> {
  await showPeople(s, t, sleep);
  if (!(await pressRow(s, person.name, null))) throw new FindMyFailed({ code: 'not_found' });
  // Closer than Find My's own start, when the buttons are there (their names are English only).
  for (let i = 0; i < 2; i++)
    if (!(await s.try({ op: 'ui.press', app: FIND_MY_APP, name: 'Zoom in', role: 'button' })).ok) break;
  await sleep(t.mapSettleMs);
  const map = largestImage((await s.list()).elements ?? []);
  if (!map) throw new FindMyFailed({ code: 'failed', message: 'Find My’s map wasn’t on the screen.' });
  const crop = cropOf(map, screen);
  const look = await s.must({ op: 'look', crop, format: 'jpeg', maxW: 1280 });
  if (!look.imageB64 || !isCropOf(look, crop)) throw new FindMyFailed({ code: 'helper_old' });
  return { imageB64: look.imageB64, format: look.format ?? 'jpeg', w: look.w ?? 0, h: look.h ?? 0 };
}

/* What Whombat keeps in memory --------------------------------------------------------------------------------------- */

interface Picture {
  imageB64: string;
  format: 'png' | 'jpeg';
  w: number;
  h: number;
  at: number;
}

interface Entry {
  serverId: string;
  lookedAt: number;
  readAt: number | null;
  problem: HostFindMyProblem | null;
  people: HostFindMyPerson[];
  exact: HostFindMyExact | null;
  pictures: Map<string, Picture>;
  map: { key: string; at: number; value: HostFindMyMap } | null;
  /** The last job in line; jobs run one after another. */
  tail: Promise<void>;
  /** Jobs in line or running: an entry with one is never forgotten. */
  jobs: number;
  /** A read is in line or running. */
  reading: boolean;
  /** An exact picture is in line and hasn't started: the person it takes is read when it starts. */
  exactWaiting: boolean;
}

export interface FindMyDeps {
  now: () => number;
  sleep?: Sleep;
  timing?: Partial<FindMyTiming>;
  /** Told only a server and a code, never a place. */
  warn?: (facts: { server: string; code: string }, msg: string) => void;
}

/** Told of every read that worked: the Mac, the people as read, and when. */
export type FindMyReadListener = (serverId: string, people: readonly HostFindMyPerson[], at: Date) => void;

const iso = (ms: number) => new Date(ms).toISOString();

/** Find My on the Macs of this Whombat: what was read, the jobs in line and the pictures, per Mac. */
export class FindMyStore {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #sleep: Sleep;
  readonly #warn: NonNullable<FindMyDeps['warn']>;
  readonly timing: FindMyTiming;
  readonly #listeners = new Set<FindMyReadListener>();
  /** Macs a Find My connection reads in the background: what was read there stays while it does. */
  #held: ReadonlySet<string> = new Set();

  constructor(deps: FindMyDeps) {
    this.#now = deps.now;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#warn = deps.warn ?? (() => {});
    this.timing = { ...FIND_MY_TIMING, ...deps.timing };
  }

  /** Tells `listener` of every read that worked from now on; returns its removal. */
  onRead(listener: FindMyReadListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The Macs read in the background now (lower case ids): kept while they are, the hour after the last look after. */
  hold(serverIds: Iterable<string>): void {
    this.#held = new Set([...serverIds].map((id) => id.toLowerCase()));
  }

  /** Forgets what is past its time: a Mac nobody looked at for an hour, old pictures and maps. */
  sweep(): void {
    const now = this.#now();
    for (const [id, e] of this.#entries) {
      if (e.jobs === 0 && now - e.lookedAt > this.timing.keepMs && !this.#held.has(id.toLowerCase())) {
        this.#entries.delete(id);
        continue;
      }
      for (const [person, pic] of e.pictures)
        if (now - pic.at > this.timing.pictureMs) e.pictures.delete(person);
      if (e.exact?.state === 'ready' && !e.pictures.has(e.exact.person)) e.exact = null;
      if (e.map && now - e.map.at > this.timing.mapMs) e.map = null;
    }
  }

  /** `hosts.findMy`: what was read last; a look keeps it another hour. */
  view(serverId: string): HostFindMy {
    this.sweep();
    const e = this.#entries.get(serverId);
    if (!e) return { server: serverId, reading: false, readAt: null, problem: null, people: [], exact: null };
    e.lookedAt = this.#now();
    return this.#shown(e);
  }

  /** What was read last without counting as a look (the background, the assistant's answer); null: nothing kept. */
  peek(serverId: string): HostFindMy | null {
    this.sweep();
    const e = this.#entries.get(serverId);
    return e ? this.#shown(e) : null;
  }

  #shown(e: Entry): HostFindMy {
    return {
      server: e.serverId,
      reading: e.reading,
      readAt: e.readAt === null ? null : iso(e.readAt),
      problem: e.problem ? { ...e.problem } : null,
      people: e.people.map((p) => ({ ...p, location: p.location ? { ...p.location } : null })),
      exact: e.exact ? { ...e.exact, problem: e.exact.problem ? { ...e.exact.problem } : null } : null,
    };
  }

  #entry(serverId: string, look = true): Entry {
    let e = this.#entries.get(serverId);
    if (!e) {
      e = {
        serverId,
        lookedAt: this.#now(),
        readAt: null,
        problem: null,
        people: [],
        exact: null,
        pictures: new Map(),
        map: null,
        tail: Promise.resolve(),
        jobs: 0,
        reading: false,
        exactWaiting: false,
      };
      this.#entries.set(serverId, e);
    } else if (look) e.lookedAt = this.#now();
    return e;
  }

  /** Puts a job in line behind the Mac's others. */
  #queue(e: Entry, job: () => Promise<void>): void {
    e.jobs++;
    // A job words its own failures; the line never breaks for the jobs behind it.
    e.tail = e.tail
      .then(job)
      .catch(() => {})
      .finally(() => {
        e.jobs--;
      });
  }

  /** Waits until the Mac's jobs in line are done (tests). */
  async idle(serverId: string): Promise<void> {
    for (let e = this.#entries.get(serverId); e && e.jobs > 0; e = this.#entries.get(serverId)) await e.tail;
  }

  /**
   * `hosts.findMyRefresh`: a read starts unless one is in line or the last worked under two minutes ago. `look: false`
   * (the background) doesn't count as someone looking.
   */
  refresh(
    hosts: Hosts,
    serverId: string,
    actor: HostsActor,
    label: string,
    options: { look?: boolean } = {},
  ): HostFindMy {
    this.sweep();
    const e = this.#entry(serverId, options.look !== false);
    const fresh = e.readAt !== null && !e.problem && this.#now() - e.readAt < HOST_FIND_MY_FRESH_MS;
    if (!e.reading && !fresh) {
      e.reading = true;
      this.#queue(e, () => this.#read(e, new Steps(hosts, serverId, actor), label));
    }
    return this.#shown(e);
  }

  async #read(e: Entry, s: Steps, label: string): Promise<void> {
    try {
      const read = await withFindMy(s, () => readPeople(s, this.timing, this.#sleep));
      // The geocoder works while the Mac is locked again: the screen is left as soon as Find My is read.
      const located = await locate(s, read, label);
      e.people = located.people;
      e.readAt = this.#now();
      e.problem = located.problem;
      e.map = null;
      const at = new Date(e.readAt);
      for (const listener of this.#listeners) {
        try {
          listener(e.serverId, e.people, at);
        } catch {
          // A listener says its own failures; the read stands.
        }
      }
    } catch (err) {
      e.problem = problemOf(err, label);
      this.#warn({ server: e.serverId, code: e.problem.code }, 'Find My: a read didn’t work');
    } finally {
      e.reading = false;
    }
  }

  /** `hosts.findMyExact`: Find My's own map of one person is taken, after the Mac's other job if one runs. */
  exact(hosts: Hosts, serverId: string, person: string, actor: HostsActor, label: string): HostFindMy {
    this.sweep();
    const e = this.#entries.get(serverId);
    if (!e?.people.some((p) => p.id === person))
      throw new ApiError(
        'not_found',
        `Whombat didn’t read that person from Find My on ${label}. Read it again and try once more.`,
        { details: { code: 'find_my_person' } },
      );
    e.lookedAt = this.#now();
    if (e.exact?.person === person && e.exact.state === 'taking') return this.#shown(e);
    e.exact = { person, state: 'taking', takenAt: null, problem: null };
    if (!e.exactWaiting) {
      e.exactWaiting = true;
      this.#queue(e, () => this.#exact(e, new Steps(hosts, serverId, actor), label));
    }
    return this.#shown(e);
  }

  async #exact(e: Entry, s: Steps, label: string): Promise<void> {
    e.exactWaiting = false;
    const id = e.exact?.state === 'taking' ? e.exact.person : null;
    if (!id) return;
    const settle = (exact: HostFindMyExact) => {
      if (e.exact?.person === id) e.exact = exact;
    };
    // A read in between may no longer have the person: then there is nobody to take.
    const person = e.people.find((p) => p.id === id);
    if (!person) {
      settle({ person: id, state: 'failed', takenAt: null, problem: { code: 'not_found' } });
      return;
    }
    try {
      const pic = await withFindMy(s, (screen) => exactPicture(s, this.timing, this.#sleep, person, screen));
      const at = this.#now();
      e.pictures.set(id, { ...pic, at });
      settle({ person: id, state: 'ready', takenAt: iso(at), problem: null });
    } catch (err) {
      const problem = problemOf(err, label);
      this.#warn({ server: e.serverId, code: problem.code }, 'Find My: an exact picture didn’t work');
      settle({ person: id, state: 'failed', takenAt: null, problem });
    }
  }

  /** `hosts.findMyPicture`: the exact picture of a person, while it is kept. */
  picture(serverId: string, person: string, label: string): HostFindMyPicture {
    this.sweep();
    const pic = this.#entries.get(serverId)?.pictures.get(person);
    if (!pic)
      throw new ApiError('not_found', `That picture from ${label} is gone. Show it exactly again.`, {
        details: { code: 'find_my_picture' },
      });
    const { at, ...rest } = pic;
    return { server: serverId, person, ...rest, takenAt: iso(at) };
  }

  /**
   * `hosts.findMyMap`: the Mac draws a map with everyone who has a place (at most its 20 pins), in the page's theme;
   * the same picture answers again for a minute.
   */
  async map(
    hosts: Hosts,
    serverId: string,
    q: HostFindMyMapQuery,
    actor: HostsActor,
    label: string,
  ): Promise<HostFindMyMap> {
    this.sweep();
    const e = this.#entries.get(serverId);
    const located = (e?.people ?? []).filter((p) => p.location).slice(0, HOST_SCREEN_LIMITS.pins);
    const centred = q.lat !== undefined && q.lon !== undefined && q.spanM !== undefined;
    if (!located.length && !centred)
      throw new ApiError('conflict', `Whombat hasn’t found a place for anyone on ${label} yet.`, {
        details: { code: 'find_my_no_places' },
      });
    const dark = q.dark ?? false;
    const region = centred ? { lat: q.lat, lon: q.lon, spanM: q.spanM } : {};
    const key = JSON.stringify([q.w, q.h, dark, region, e?.readAt ?? null]);
    if (e?.map?.key === key) return e.map.value;
    const r = await screenStep(
      hosts,
      serverId,
      {
        op: 'map.snapshot',
        w: q.w,
        h: q.h,
        scale: 2,
        dark,
        format: 'jpeg',
        pins: located.map((p) => ({ lat: p.location?.lat ?? 0, lon: p.location?.lon ?? 0 })),
        ...region,
      },
      actor,
    );
    if (!r.ok || !r.imageB64) {
      const p = r.ok ? { code: 'failed' as const } : stepProblem('map.snapshot', r);
      throw new ApiError('conflict', findMyProblemText(p.code, label, p.message), {
        details: { code: p.code },
      });
    }
    const points = located.flatMap((p, i) => {
      const at = r.points?.[i];
      return at ? [{ person: p.id, x: at.x, y: at.y }] : [];
    });
    const value: HostFindMyMap = {
      server: serverId,
      imageB64: r.imageB64,
      format: r.format ?? 'jpeg',
      w: r.w ?? 0,
      h: r.h ?? 0,
      points,
      lat: r.lat ?? q.lat ?? 0,
      lon: r.lon ?? q.lon ?? 0,
      spanM: r.spanM ?? q.spanM ?? 0,
    };
    if (e) e.map = { key, at: this.#now(), value };
    return value;
  }
}

const instances = new WeakMap<object, FindMyStore>();

/** The process's Find My store (one per `Services`), which forgets on time even when nobody asks. */
export function findMyFor(services: {
  clock: () => Date;
  log: { warn: (facts: object, msg: string) => void };
}): FindMyStore {
  let store = instances.get(services);
  if (!store) {
    const made = new FindMyStore({
      now: () => services.clock().getTime(),
      warn: (facts, msg) => services.log.warn(facts, msg),
    });
    setInterval(() => made.sweep(), made.timing.sweepMs).unref();
    instances.set(services, made);
    store = made;
  }
  return store;
}
