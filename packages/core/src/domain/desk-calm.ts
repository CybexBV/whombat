/**
 * What the calm glance shows (3.2, CT-1631; Whombat docs/decisions/desk-display.md DK-112…DK-118, DK-121, DK-123): the
 * rules in one pure function, so the runtime, Settings' preview and the fakes decide alike. The runtime reads what is
 * true into a `DeskCalmInput`; `deskCalm` chooses with the person's choices (`DeskShow`) and what the lock lets show.
 */
import {
  DESK_MOMENTS_MAX,
  DESK_STRIP_MAX,
  type DeskAlso,
  type DeskCalm,
  type DeskDigest,
  type DeskHeadline,
  type DeskHero,
  type DeskMoment,
  type DeskPreviewScenario,
  type DeskShow,
  type DeskStripServer,
  deskShowLevel,
} from './desk-glance.js';
import {
  DESK_ATTENTION_MAX,
  type DeskAttention,
  type DeskAttentionItem,
  type DeskPopups,
} from './desk-screens.js';
import type { LookResearch } from './look-research.js';

/** What the lock lets show (DK-03): `everything` unlocked. */
export type DeskCalmView = 'time' | 'summary' | 'everything';

/** A question or approval waiting for the person, first first. */
export interface DeskCalmAsk {
  number: number;
  title: string;
}

/** A server, connection or device that is down or needs a look (`DeskLook`), down first. */
export interface DeskCalmLook {
  key: string;
  kind: 'server' | 'connection' | 'device';
  name: string;
  state: 'down' | 'bad' | 'look';
  reason?: string | undefined;
  server?: string | undefined;
  /** When it began, when Whombat knows. */
  since?: string | undefined;
  /** A down server's running guests' names (its hero says they're down too). */
  runsOn?: readonly string[] | undefined;
  /** A filling disk: how full, and the days left at this rate (null: not filling, or unknown). */
  disk?: { pct: number; days: number | null } | undefined;
  /** What the assistant found out about it (3.5; Whombat look-research.md LR-09): its words take the hero's. */
  research?: LookResearch | undefined;
}

/** A server as the strip may draw it, worst first. */
export interface DeskCalmServer {
  id?: string | undefined;
  name: string;
  mark: string;
  state: 'ok' | 'warn' | 'bad' | 'off';
  /** Why it isn't fine, a few words (“not answering”, “hot · 84°”); its card's note. */
  note?: string | undefined;
  cpu?: number | undefined;
  memory?: number | undefined;
  disk?: number | undefined;
  /** The last hour's processor, whole percent, oldest first. */
  spark?: readonly number[] | undefined;
  /** It is installing updates or restarting. */
  updating?: boolean | undefined;
}

/** A connection or device with something to show (`ConnectionGlance.activity`), or a pinned figure. */
export interface DeskCalmActivity {
  key: string;
  name: string;
  mark?: string | undefined;
  value: string;
  detail?: string | undefined;
  progress?: number | undefined;
  /** Something is going on now (someone watching, a queue), so *When it matters* shows it. */
  active: boolean;
}

/** The assistant's work: its title, its steps, what it's doing now. */
export interface DeskCalmWork {
  title: string;
  steps: readonly { label: string; state: 'done' | 'now' | 'next' }[];
  doing?: string | undefined;
}

/** Something coming up: an automation's next run. */
export interface DeskCalmComing {
  name: string;
  /** When, RFC 3339. */
  at: string;
}

export interface DeskCalmInput {
  /** The assistant's name, from the runtime. */
  assistant: string;
  now: Date;
  timeZone: string;
  asks: readonly DeskCalmAsk[];
  /** All waiting asks, `asks` being the first few. */
  askCount: number;
  looks: readonly DeskCalmLook[];
  work: DeskCalmWork | null;
  servers: readonly DeskCalmServer[];
  /** Connections and devices with something to show. */
  activities: readonly DeskCalmActivity[];
  /** Home's widgets as figures. */
  figures: readonly DeskCalmActivity[];
  /** Within the next 24 hours, soonest first. */
  coming: readonly DeskCalmComing[];
  /** Connections and devices Whombat watches (“14 services are running”). */
  services: number;
  /** Things the assistant finished today. */
  doneCount: number;
  digest?: DeskDigest | undefined;
  update?: DeskCalm['update'] | undefined;
}

/** Words the planner needs: `DESK_WORDS.calm` and `DESK_WORDS.status` (passed in, so this file stays independent). */
export interface DeskCalmWords {
  headline: Record<
    'fine' | 'wrongOne' | 'wrongMany' | 'lookOne' | 'lookMany' | 'askOne' | 'askMany' | 'busy',
    string
  >;
  running: string;
  runningOne: string;
  and: string;
  servers: { one: string; many: string };
  services: { one: string; many: string };
  nothingNeedsYou: string;
  stepsDone: string;
  runsOnOne: string;
  runsOnTwo: string;
  runsOnMore: string;
  notAnswering: string;
  isOff: string;
  diskFull: string;
  diskForecast: string;
  diskForecastSoon: string;
  down: string;
  look: string;
  comingAt: string;
  strip: { notAnswering: string; off: string; disk: string; cpu: string; memory: string; updating: string };
  sampleWork: string;
  /** A look's research on the hero (3.5; look-research.md LR-09): while it looks, and while it takes the step. */
  looking: string;
  lookingSoFar: string;
  fixing: string;
  /** What Settings' preview shows the assistant found on its sample look (`{name}` the server's). */
  sampleFound: { title: string; summary: string; fix: string };
}

/** A moment's work is “coming up” this soon on *When it matters* (DK-115). */
export const DESK_COMING_SOON_S = 2 * 3_600;

const fill = (template: string, values: Readonly<Record<string, string | number>>) =>
  template.replace(/\{([a-z]+)\}/g, (hole, key: string) => (key in values ? String(values[key]) : hole));

/** At most `max` code points, “…” at the end when cut; one line. */
function cut(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  const points = Array.from(one);
  return points.length <= max ? one : `${points.slice(0, max - 1).join('')}…`;
}

const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** The muted line of an all-fine headline: “8 servers and 14 services are running. Nothing needs you.” */
function runningLine(input: DeskCalmInput, servers: number, w: DeskCalmWords): string {
  const parts: string[] = [];
  if (servers > 0) parts.push(servers === 1 ? w.servers.one : fill(w.servers.many, { n: servers }));
  if (input.services > 0)
    parts.push(input.services === 1 ? w.services.one : fill(w.services.many, { n: input.services }));
  if (parts.length === 0) return w.nothingNeedsYou;
  const things =
    parts.length === 2 ? fill(w.and, { a: parts[0] as string, b: parts[1] as string }) : parts[0];
  const one = parts.length === 1 && (servers === 1 || (servers === 0 && input.services === 1));
  return `${fill(one ? w.runningOne : w.running, { things: things as string })} ${w.nothingNeedsYou}`;
}

/** How far along the work is: done steps of all, in whole percent. */
function workProgress(work: DeskCalmWork): number | undefined {
  if (work.steps.length === 0) return undefined;
  const done = work.steps.filter((s) => s.state === 'done').length;
  return Math.round((done / work.steps.length) * 100);
}

function lookTitle(look: DeskCalmLook, w: DeskCalmWords): string {
  if (look.state === 'down') {
    if (look.kind === 'server') {
      const off = look.reason && /^off\b/i.test(look.reason);
      return fill(off ? w.isOff : w.notAnswering, { name: look.name });
    }
    return fill(w.down, { server: look.name }).replace(/\.$/, '');
  }
  return fill(w.look, { server: look.name }).replace(/\.$/, '');
}

function diskWords(disk: NonNullable<DeskCalmLook['disk']>, w: DeskCalmWords): string {
  if (disk.days === null) return fill(w.diskFull, { n: disk.pct });
  if (disk.days < 1) return fill(w.diskForecastSoon, { n: disk.pct });
  return fill(w.diskForecast, { n: disk.pct, days: Math.round(disk.days) });
}

function lookDetail(look: DeskCalmLook, w: DeskCalmWords): string | undefined {
  if (look.state === 'down' && look.runsOn && look.runsOn.length > 0) {
    const [a, b] = look.runsOn as [string, string | undefined];
    if (look.runsOn.length === 1) return fill(w.runsOnOne, { a });
    if (look.runsOn.length === 2) return fill(w.runsOnTwo, { a, b: b as string });
    return fill(w.runsOnMore, { a, b: b as string, n: look.runsOn.length - 2 });
  }
  if (look.disk) {
    const words = diskWords(look.disk, w);
    return cut(words.charAt(0).toUpperCase() + words.slice(1), 200);
  }
  return look.reason ? cut(look.reason, 200) : undefined;
}

/** A look's one line under the hero (DK-114): its reason or its disk, else its title. */
function lookLine(look: DeskCalmLook, w: DeskCalmWords): string {
  if (look.disk) return diskWords(look.disk, w);
  if (look.reason) return lower(cut(look.reason, 120));
  return lookTitle(look, w);
}

type Need =
  | { kind: 'look'; look: DeskCalmLook; tone: 'bad' | 'warn'; rank: number }
  | { kind: 'ask'; ask: DeskCalmAsk; tone: 'bad'; rank: number };

/** What needs the person, in the order the middle takes it (DK-113): down, the asks, in trouble, to look at. */
function needsOf(input: DeskCalmInput, show: Pick<DeskShow, 'items'>): Need[] {
  const needs: Need[] = [];
  for (const look of input.looks) {
    // *Off* means off on the screen, problems too (DK-104).
    if (deskShowLevel(show, look.key) === 'off') continue;
    const rank = look.state === 'down' ? 0 : look.state === 'bad' ? 2 : 3;
    needs.push({ kind: 'look', look, tone: look.state === 'look' ? 'warn' : 'bad', rank });
  }
  for (const ask of input.asks) needs.push({ kind: 'ask', ask, tone: 'bad', rank: 1 });
  return needs.sort((a, b) => a.rank - b.rank);
}

/**
 * A look's hero words with what the assistant found out (LR-09): while it looks, the look's own title and “I’m looking
 * into it.” with the reason so far; once found or fixed, its title and summary (the summary cut to the hero's 200 for an
 * older console) and, found, the step it offers; while it takes the step, its title and “I’m on it.”. None without
 * research, or when it failed: the hero says what it said before.
 */
function researchWords(
  look: DeskCalmLook,
  detail: string | undefined,
  w: DeskCalmWords,
): Pick<DeskHero, 'title' | 'detail' | 'research' | 'fix'> | null {
  const r = look.research;
  if (!r || r.state === 'failed') return null;
  const own = cut(lookTitle(look, w), 120);
  if (r.state === 'looking') {
    const soFar = detail?.replace(/[.!?…]+$/, '');
    return {
      title: own,
      detail: cut(soFar ? fill(w.lookingSoFar, { reason: soFar }) : w.looking, 200),
      research: 'looking',
    };
  }
  const title = r.title ? cut(r.title, 120) : own;
  if (r.state === 'fixing') return { title, detail: w.fixing, research: 'fixing' };
  return {
    title,
    ...(r.summary ? { detail: cut(r.summary, 200) } : {}),
    research: r.state,
    ...(r.state === 'found' && r.fix ? { fix: cut(r.fix, 32) } : {}),
  };
}

function heroOf(need: Need, view: DeskCalmView, input: DeskCalmInput, w: DeskCalmWords): DeskHero {
  if (need.kind === 'ask') {
    const title =
      view === 'everything'
        ? cut(need.ask.title, 120)
        : fill(w.headline.askOne, { assistant: input.assistant });
    return { kind: 'ask', tone: 'bad', title, ask: need.ask.number };
  }
  const { look } = need;
  const detail = lookDetail(look, w);
  // The assistant's words only where titles show: in *A summary* the hero keeps Whombat's own (DK-03).
  const found = view === 'everything' ? researchWords(look, detail, w) : null;
  return {
    kind: 'look',
    tone: need.tone,
    title: cut(lookTitle(look, w), 120),
    ...(detail ? { detail } : {}),
    ...(look.since ? { since: look.since } : {}),
    look: cut(look.key, 120),
    ...(look.server ? { server: look.server } : {}),
    ...(found ?? {}),
  };
}

function alsoOf(need: Need, view: DeskCalmView, input: DeskCalmInput, w: DeskCalmWords): DeskAlso {
  if (need.kind === 'ask') {
    const text =
      view === 'everything'
        ? cut(need.ask.title, 120)
        : fill(w.headline.askOne, { assistant: input.assistant });
    return { tone: 'bad', name: cut(input.assistant, 40), text, ask: need.ask.number };
  }
  const { look } = need;
  return {
    tone: need.tone,
    name: cut(look.name, 40),
    text: cut(lookLine(look, w), 120),
    look: cut(look.key, 120),
    ...(look.server ? { server: look.server } : {}),
  };
}

function headlineOf(
  needs: readonly Need[],
  input: DeskCalmInput,
  servers: number,
  w: DeskCalmWords,
): DeskHeadline {
  const wrong = needs.filter((n) => n.kind === 'look' && n.tone === 'bad').length;
  const asks = input.askCount;
  const looks = needs.filter((n) => n.kind === 'look' && n.tone === 'warn').length;
  const a = { assistant: input.assistant };
  if (wrong > 0)
    return {
      tone: 'bad',
      text: wrong === 1 ? w.headline.wrongOne : fill(w.headline.wrongMany, { n: wrong }),
    };
  if (asks > 0)
    return {
      tone: 'bad',
      text: asks === 1 ? fill(w.headline.askOne, a) : fill(w.headline.askMany, { n: asks }),
    };
  if (looks > 0)
    return { tone: 'warn', text: looks === 1 ? w.headline.lookOne : fill(w.headline.lookMany, { n: looks }) };
  if (input.work) {
    const progress = input.work.steps.length
      ? fill(w.stepsDone, {
          n: input.work.steps.filter((s) => s.state === 'done').length,
          m: input.work.steps.length,
        })
      : '';
    const more = cut(`${input.work.title.replace(/[.!?]?$/, '.')}${progress ? ` ${progress}` : ''}`, 200);
    return { tone: 'busy', text: cut(fill(w.headline.busy, a), 80), more };
  }
  return { tone: 'ok', text: w.headline.fine, more: runningLine(input, servers, w) };
}

/** The strip's servers (DK-116, DK-117): *Always*, and *When it matters* only while not fine, in the person's order. */
function stripOf(input: DeskCalmInput, show: DeskShow): DeskCalmServer[] {
  const shown = input.servers.filter((s) => {
    if (!s.id) return true;
    const level = deskShowLevel(show, `server:${s.id}`);
    return level === 'always' || (level === 'matters' && (s.state !== 'ok' || s.updating === true));
  });
  const place = new Map(show.order.map((id, i) => [id, i]));
  const at = (s: DeskCalmServer) =>
    s.id !== undefined ? (place.get(s.id) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
  // Stable: the input is worst first, then by name; the person's order goes before it.
  return shown
    .map((s, i) => ({ s, i }))
    .sort((a, b) => at(a.s) - at(b.s) || a.i - b.i)
    .map(({ s }) => s);
}

function stripServer(s: DeskCalmServer, work: DeskCalmWork | null, w: DeskCalmWords): DeskStripServer {
  const step = work?.steps.find((st) => st.label.toLowerCase() === s.name.toLowerCase());
  let say: string | undefined;
  if (s.updating) say = w.strip.updating;
  else if (s.state === 'off') say = w.strip.off;
  else if (s.state !== 'ok') {
    if (s.note && !/^(up|ok)\b/i.test(s.note)) say = lower(s.note);
    else if ((s.disk ?? 0) >= 85) say = fill(w.strip.disk, { n: s.disk as number });
    else if ((s.cpu ?? 0) >= 75) say = fill(w.strip.cpu, { n: s.cpu as number });
    else if ((s.memory ?? 0) >= 80) say = fill(w.strip.memory, { n: s.memory as number });
    else if (s.state === 'bad') say = w.strip.notAnswering;
  }
  const out: DeskStripServer = {
    ...(s.id ? { id: s.id } : {}),
    name: cut(s.name, 40),
    mark: s.mark,
    state: s.state,
  };
  if (say) out.say = cut(say, 40);
  else if (s.spark && s.spark.length > 0)
    out.spark = s.spark.slice(-30).map((v) => Math.max(0, Math.min(100, Math.round(v))));
  if (step) out.work = step.state;
  else if (s.updating) out.work = 'now';
  return out;
}

/** The moments (DK-115): pinned first, then what's going on; three at most. */
function momentsOf(input: DeskCalmInput, show: DeskShow, view: DeskCalmView, w: DeskCalmWords): DeskMoment[] {
  const out: DeskMoment[] = [];
  const pinned: DeskMoment[] = [];
  const going: DeskMoment[] = [];
  const detail = (d: string | undefined) => (view === 'everything' && d ? { detail: cut(d, 80) } : {});
  const workLevel = deskShowLevel(show, 'work');
  if (input.work && workLevel !== 'off') {
    const progress = workProgress(input.work);
    const m: DeskMoment = {
      key: 'work',
      kind: 'work',
      name: cut(input.assistant, 40),
      value: cut(input.work.title, 40),
      ...detail(input.work.doing),
      ...(progress !== undefined ? { progress } : {}),
      ...(workLevel === 'always' ? { pinned: true } : {}),
    };
    (workLevel === 'always' ? pinned : going).push(m);
  }
  for (const a of [...input.activities, ...input.figures]) {
    const level = deskShowLevel(show, a.key);
    if (level === 'off' || (level === 'matters' && !a.active)) continue;
    const m: DeskMoment = {
      key: a.key,
      kind: input.figures.includes(a) ? 'figure' : 'activity',
      name: cut(a.name, 40),
      ...(a.mark ? { mark: a.mark } : {}),
      value: cut(a.value, 40),
      ...detail(a.detail),
      ...(a.progress !== undefined ? { progress: Math.max(0, Math.min(100, Math.round(a.progress))) } : {}),
      ...(level === 'always' ? { pinned: true } : {}),
    };
    (level === 'always' ? pinned : going).push(m);
  }
  const comingLevel = deskShowLevel(show, 'coming');
  const next = input.coming[0];
  if (next && comingLevel !== 'off') {
    const soon = Date.parse(next.at) - input.now.getTime() <= DESK_COMING_SOON_S * 1000;
    if (comingLevel === 'always' || soon) {
      const m: DeskMoment = {
        key: 'coming',
        kind: 'coming',
        name: cut(w.comingAt, 40),
        value: cut(next.name, 40),
        ...detail(clockOf(next.at, input.timeZone)),
        ...(comingLevel === 'always' ? { pinned: true } : {}),
      };
      (comingLevel === 'always' ? pinned : going).push(m);
    }
  }
  out.push(...pinned, ...going);
  return out.slice(0, DESK_MOMENTS_MAX);
}

/** “02:00” in the person's zone. */
function clockOf(at: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone,
    }).format(new Date(at));
  } catch {
    return at.slice(11, 16);
  }
}

/**
 * The calm glance for `input`, the person's `show` and the lock's `view` (DK-112…DK-118, DK-121). In *Only the time*
 * only the sentence and the clock; in *A summary* no ask's title and no moment's detail; *Welcome back* only from *A
 * summary* on.
 */
export function deskCalm(
  input: DeskCalmInput,
  show: DeskShow,
  view: DeskCalmView,
  w: DeskCalmWords,
): DeskCalm {
  const needs = needsOf(input, show);
  const strip = view === 'time' ? [] : stripOf(input, show);
  const visibleServers = input.servers.filter(
    (s) => !s.id || deskShowLevel(show, `server:${s.id}`) !== 'off',
  ).length;
  const headline = headlineOf(needs, input, visibleServers, w);
  if (view === 'time') {
    const quiet: DeskHeadline =
      headline.tone === 'ok' || headline.tone === 'busy'
        ? { tone: 'ok', text: w.headline.fine }
        : { ...headline };
    return {
      headline: quiet,
      clock: 'big',
      also: [],
      moreNeeds: 0,
      moments: [],
      strip: [],
      moreStrip: 0,
      bar: show.bar,
      ...(input.update ? { update: input.update } : {}),
    };
  }
  const [first, ...rest] = needs;
  const hero = first ? heroOf(first, view, input, w) : undefined;
  const also = rest.slice(0, 2).map((n) => alsoOf(n, view, input, w));
  // Asks beyond the ones read count too (`askCount`).
  const unread = Math.max(0, input.askCount - input.asks.length);
  const moments = hero ? [] : momentsOf(input, show, view, w);
  const drawn = strip.slice(0, DESK_STRIP_MAX).map((s) => stripServer(s, input.work, w));
  return {
    headline,
    clock: hero ? 'small' : show.clock,
    ...(hero ? { hero } : {}),
    also,
    moreNeeds: Math.max(0, rest.length - also.length) + unread,
    moments,
    strip: drawn,
    moreStrip: Math.max(0, strip.length - drawn.length),
    bar: show.bar,
    ...(show.doneToday && input.doneCount > 0 ? { doneCount: input.doneCount } : {}),
    ...(input.digest && show.welcomeBack ? { digest: input.digest } : {}),
    ...(input.update ? { update: input.update } : {}),
  };
}

/**
 * A look the assistant has taken on: Needs you puts it under “{assistant}’s on it” and doesn't count it (core's
 * `needsYouGroupOf`), so the screen's pill and modal leave it out too until it finds something or gives up.
 */
function assistantIsOn(look: DeskCalmLook): boolean {
  const state = look.research?.state;
  return state === 'looking' || state === 'fixing' || state === 'fixed';
}

/**
 * What needs the person on a screen of widgets (3.6; Whombat desk-display.md DK-135…DK-138): everything the calm
 * glance's hero and its lines would take, in the same order and words, for the modal and the pill. An outage (a server,
 * connection or device down) opens the modal unless the screen's pop-ups are *Nothing*; a question or approval only
 * where they are *Questions and problems*; the rest is only in the pill's list. *Only the time* shows nothing.
 */
export function deskAttention(
  input: DeskCalmInput,
  show: Pick<DeskShow, 'items'>,
  view: DeskCalmView,
  popups: DeskPopups,
  w: DeskCalmWords,
): DeskAttention {
  if (view === 'time') return { items: [], more: 0 };
  const needs = needsOf(input, show).filter((n) => n.kind === 'ask' || !assistantIsOn(n.look));
  const items = needs.slice(0, DESK_ATTENTION_MAX).map((need): DeskAttentionItem => {
    const hero = heroOf(need, view, input, w);
    const pops = need.kind === 'ask' ? popups === 'all' : need.look.state === 'down' && popups !== 'none';
    const { kind, tone, title, detail, since, ask, look, server, research, fix } = hero;
    return {
      key: need.kind === 'ask' ? `ask:${need.ask.number}` : cut(need.look.key, 120),
      kind,
      tone,
      pops,
      title,
      name: cut(need.kind === 'ask' ? input.assistant : need.look.name, 40),
      ...(detail ? { detail } : {}),
      ...(since ? { since } : {}),
      ...(ask !== undefined ? { ask } : {}),
      ...(look ? { look } : {}),
      ...(server ? { server } : {}),
      ...(research ? { research } : {}),
      ...(fix ? { fix } : {}),
    };
  });
  const more = needs.length - items.length + Math.max(0, input.askCount - input.asks.length);
  if (needs.length === 0 && more === 0) return { items, more: 0 };
  const tone = needs.some((n) => n.tone === 'bad') || input.askCount > 0 ? 'bad' : 'warn';
  return { items, more, tone };
}

/**
 * Settings' preview scenarios (DK-123): `wrong` makes the first server the strip shows not answer (its guests unknown),
 * with what the assistant found and the step it offers (3.5; look-research.md LR-09), `busy` sets the assistant to work through the strip's first four servers (done, done, now, next). `now` is what's
 * true. Nothing else changes.
 */
export function deskPreviewInput(
  input: DeskCalmInput,
  show: DeskShow,
  scenario: DeskPreviewScenario,
  w: Pick<DeskCalmWords, 'sampleWork' | 'sampleFound'>,
): DeskCalmInput {
  if (scenario === 'now') return input;
  const strip = input.servers.filter((s) => !s.id || deskShowLevel(show, `server:${s.id}`) === 'always');
  if (scenario === 'wrong') {
    const target = strip[0] ?? input.servers[0];
    if (!target) return input;
    const key = `server:${target.id ?? target.name}`;
    const at = input.now.toISOString().replace(/\.\d{3}Z$/, 'Z');
    return {
      ...input,
      servers: [
        { ...target, state: 'bad', note: undefined, spark: undefined, updating: false },
        ...input.servers.filter((s) => s !== target),
      ],
      looks: [
        {
          key,
          kind: 'server',
          name: target.name,
          state: 'down',
          ...(target.id ? { server: target.id } : {}),
          since: new Date(input.now.getTime() - 4 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          // What the assistant found, with a step, so Settings shows the hero's buttons (look-research.md LR-09).
          research: {
            key: cut(key, 120),
            state: 'found',
            title: cut(fill(w.sampleFound.title, { name: target.name }), 80),
            summary: cut(w.sampleFound.summary, 240),
            fix: cut(fill(w.sampleFound.fix, { name: target.name }), 32),
            at,
          },
        },
        ...input.looks,
      ],
    };
  }
  const states = ['done', 'done', 'now', 'next'] as const;
  const steps = strip.slice(0, 4).map((s, i) => ({ label: s.name, state: states[i] ?? 'next' }));
  return {
    ...input,
    work: { title: w.sampleWork, steps: steps.length ? steps : [{ label: w.sampleWork, state: 'now' }] },
  };
}
