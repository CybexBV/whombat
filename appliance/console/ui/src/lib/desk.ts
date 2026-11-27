import { localeTag } from '../i18n/locale';
/**
 * The desk display's state (Whombat desk-display.md DK-01…DK-30, DK-60…DK-65, DK-70…DK-74): what the runtime gives
 * the paired screen, passed through by the console server as `/api/state`'s `desk` (contracts 0.116.0
 * `@whombat/control-contracts/local` `DeskState`, appliance CG-37, CG-57, CG-131, CG-132, CG-135, CG-171, CG-192,
 * CG-280), the open conversation from `/api/desk/talk/session` (`DeskTalkSession`, CG-196, CG-284), and every server
 * and a server's own screen from `/api/desk/servers` and `/api/desk/server` (`DeskServersAnswer`, `DeskServerPage`,
 * CG-250). The runtime is the authority on what may show (DK-03) and what may be done (DK-05); the page draws what it
 * gets. `parseDesk` checks the shape as `parseState` does: a desk it doesn't understand is `null` (today's console), a
 * piece it doesn't understand is left out, and every display string is cut to its contract length.
 */
import { type DeskCalm, parseCalm } from './calm';
import { type DeskGrid, type DeskOutputGrid, parseGrid, parseOutputGrids } from './grid';
import { parseRemoteHelp, type RemoteHelp } from './remoteHelp';
import {
  LOOK_FIX_LABEL_MAX,
  LOOK_RESEARCH_STATES,
  LOOK_SUMMARY_MAX,
  LOOK_TITLE_MAX,
  type LookResearch,
} from './research';

export type { LookResearch, LookResearchState } from './research';

export const DESK_LOCKED_VIEWS = ['time', 'summary', 'everything'] as const;
export type DeskLockedView = (typeof DESK_LOCKED_VIEWS)[number];
export type DeskNight = 'dim' | 'black';
export const TONES = ['ok', 'warn', 'bad'] as const;
export type Tone = (typeof TONES)[number];

export interface DeskMeter {
  value: number;
  tone: Tone;
}

export const SERVER_STATES = ['ok', 'warn', 'bad', 'off'] as const;
export type ServerStateName = (typeof SERVER_STATES)[number];

export interface DeskServer {
  /**
   * The hosts service's id of the server (0.115, DK-83): the card opens the server's own screen. Absent from a runtime
   * before 0.115 (and on This Whombat's card): the card doesn't open.
   */
  id?: string;
  name: string;
  /** A `@whombat/brand` mark key (proxmox, unraid, debian, linux…), or null (unknown here): the page draws a server. */
  mark: string | null;
  state: ServerStateName;
  /** “up 41 d”, “updating”. */
  note: string;
  cpu: DeskMeter | null;
  memory: DeskMeter | null;
  /** Kept for the server's own screen and older consoles; the card no longer shows it (0.115, DK-80). */
  temp: DeskMeter | null;
  /** % of its storage in use (0.115, DK-80); absent from an older runtime: the DISK line shows “–” (DK-88). */
  disk?: DeskMeter | null;
}

export const TILE_ICONS = [
  'temperature',
  'heat',
  'sun',
  'power',
  'lock',
  'light',
  'water',
  'network',
  'generic',
] as const;
export type TileIcon = (typeof TILE_ICONS)[number];

export interface DeskTile {
  icon: TileIcon;
  mark: string | null;
  value: string;
  label: string;
  tone: Tone | null;
}

export const PHONE_REASONS = ['money', 'release', 'delete', 'keys', 'outside'] as const;
export type DeskPhoneReason = (typeof PHONE_REASONS)[number];

/** How far an ask's wider answers reach (0.116 `DESK_CHOICE_SCOPES`, TF-14): for this task, or from now on. */
export const CHOICE_SCOPES = ['task', 'agent'] as const;
export type ChoiceScope = (typeof CHOICE_SCOPES)[number];
/** At most this many wider choices on an ask, one per scope (`DESK_ASK_CHOICES`). */
export const ASK_CHOICES = CHOICE_SCOPES.length;

/** One of an ask's wider answers (0.116 `DeskAskChoice`): its scope and the web card's label. */
export interface DeskAskChoice {
  scope: ChoiceScope;
  /** “Don’t ask again on Home Assistant”, “Always allow Banjo to deploy”. */
  label: string;
}

export interface DeskAsk {
  number: number;
  kind: 'approval' | 'question';
  title: string;
  at: string;
  where: string | null;
  /** Only when unlocked (the runtime leaves them out otherwise). */
  detail: string | null;
  facts: string[];
  approveLabel: string | null;
  /** False: risky (DK-05, DK-62): Approve only with the PIN typed again, or on the phone; before 0.108 no buttons. */
  onDesk: boolean;
  phoneReason: DeskPhoneReason | null;
  /** The screen may say no (0.108, DK-61); absent or false: an older runtime, Not now only. */
  deny?: boolean;
  /** Only with `onDesk` false (0.108, DK-62): Approve after the PIN is typed again. */
  approveWithPin?: boolean;
  /** Asked in the screen's open conversation (0.108, DK-64): Ask goes back to it. */
  inTalk?: boolean;
  /**
   * The web card's wider choices after Approve (0.116, TF-14), in its order, each needing the PIN. Only while unlocked,
   * on an ask the screen may approve, on a screen with a PIN; absent or empty: none (and from an older runtime).
   */
  choices?: DeskAskChoice[];
  /** Who asks (0.116, TF-15): “Mara asks”, a person. Absent or null: the agent (and an older runtime). */
  from?: string | null;
}

/** What a look is about, and how badly it needs the person (0.118, DK-93; the contracts' `DESK_LOOK_KINDS`/`STATES`). */
export const LOOK_KINDS = ['server', 'connection', 'device'] as const;
export type LookKind = (typeof LOOK_KINDS)[number];
export const LOOK_STATES = ['down', 'bad', 'look'] as const;
export type LookState = (typeof LOOK_STATES)[number];
/** Needs you carries at most this many looks (the contracts' `DESK_LOOKS_MAX`). */
export const LOOKS_MAX = 5;

/**
 * What kind of line a look comes from (0.122, QN-01; core's `NOTICE_NATURES`): a problem the assistant can look into,
 * something only a person can do, or a heads-up (never a look, QN-02: the page leaves one out).
 */
export const NOTICE_NATURES = ['problem', 'you', 'fyi'] as const;
export type NoticeNature = (typeof NOTICE_NATURES)[number];
/** A check's id (0.122, QN-03; core's `NOTICE_CHECK_RE`, at most 80 characters): `unifi.device_offline`. */
export const NOTICE_CHECK_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
/** *Ignore* (until it changes) and *Not now* (until 09:00 tomorrow) on a look (0.122; `DESK_LOOK_QUIET_HOWS`). */
export const LOOK_QUIET_HOWS = ['ignore', 'snooze'] as const;
export type LookQuietHow = (typeof LOOK_QUIET_HOWS)[number];

/** The line a look comes from (0.122, QN-03): its check and item, sent back as they came. */
export interface LookNotice {
  check: string;
  subject?: string;
}

/**
 * A server, connection or device that is down or needs a look (0.118, DK-93): `key` the thing's id (the same between
 * states), its name, why when Whombat knows, and a server's id when its screen opens (DK-83). Since 0.122 (QN-20): the
 * line it comes from (`notice`: absent, it can't be quieted here), `nature` (absent: a problem), when you'll hear again
 * after Ignore (`ignoreWords`) and the line's own question for *Ask {assistant} to look into it*. Since 3.5 (Whombat
 * look-research.md) what the assistant found out.
 */
export interface DeskLook {
  key: string;
  kind: LookKind;
  name: string;
  state: LookState;
  reason: string | null;
  server?: string;
  notice?: LookNotice;
  nature?: 'problem' | 'you';
  ignoreWords?: string;
  question?: string;
  /** What the assistant found out (3.5, CG-372); absent from an older runtime and before it started. */
  research?: LookResearch;
}

export type StepState = 'done' | 'now' | 'next';

export interface DeskGlance {
  status: { text: string; more: string | null };
  /** `count` the asks'; `looks` (0.118, DK-93) what needs a look, worst first, absent from an older runtime. */
  needsYou: { count: number; items: DeskAsk[]; looks?: DeskLook[] };
  working: null | { title: string; steps: { label: string; state: StepState }[] };
  done: { text: string; at: string }[];
  servers: DeskServer[];
  /** Every server not in `servers` (the extra ones too, DK-42). */
  moreServers: number;
  tiles: DeskTile[];
  /** This Whombat's own figures while there are no servers and no tiles (DK-22); null otherwise. */
  box: DeskBox | null;
  /**
   * This Whombat beside servers or tiles (0.104, DK-39): never with `box`, absent in *Only the time* and from a runtime
   * before 0.104 (then the glance is as before: This Whombat only on a new box).
   */
  self?: DeskBox | null;
  /** Servers five to eight (0.104, DK-41), only beside four in `servers`; absent or empty is none. */
  extraServers?: DeskServer[];
  /** Tiles five to eight (0.104, DK-41), only beside four in `tiles`; absent or empty is none. */
  extraTiles?: DeskTile[];
  /**
   * Found on your network (0.110, DF-01…DF-07): the services a scan found that aren't connected yet. Present exactly
   * when the panel or the strip shows (DF-06); absent from a runtime before 0.110, in *Only the time* and after Not now.
   */
  found?: DeskFound | null;
  /**
   * The calm glance (3.2, CG-350; DK-101): what this page draws in place of the members above when the runtime sends
   * it; null from an older runtime (then the glance is as before).
   */
  calm?: DeskCalm | null;
  /**
   * The screen of widgets (3.6; Whombat desk-display.md “Screens of widgets”): what this page draws under its top bar
   * in place of the calm glance when the runtime sends it, whose members Whombat's own widgets still read; null from an
   * older runtime and when the page can't draw it (lib/grid.ts).
   */
  grid?: DeskGrid | null;
  /** Each monitor on the box the page reported, with its screen (3.6); empty without one. */
  outputs?: DeskOutputGrid[];
}

/** A found service (0.110 `DeskFoundItem`, DF-01, DF-08): its catalog entry, name, short line and address as sent. */
export interface DeskFoundItem {
  /** The catalog entry ('homeassistant', 'synology', 'device', …): the mark, else the name's first letter (DF-12). */
  catalogId: string;
  name: string;
  /** What it is to a person (DF-08), ≤ 40 characters; empty when the runtime sends none. */
  tagline: string;
  /** Shown as is: “10.100.0.5”, “10.100.0.20:32400”. */
  address: string;
}

/** Found on your network (0.110 `DeskFound`). */
export interface DeskFound {
  scanning: boolean;
  /** Only while the first automatic scan runs (DF-07): addresses looked at, of all to look at. */
  progress: { done: number; total: number } | null;
  /** At most 8, in catalog order then by address (DF-03). */
  items: DeskFoundItem[];
  /** Every new one, `items` included. */
  count: number;
  /** When the result shown was finished; null while the first scan runs. */
  finishedAt: string | null;
}

/** A figure drawn big with a small unit (“11.2” “GB”), as the runtime wrote it. */
export interface DeskFigure {
  value: string;
  unit: string;
}

export const BOX_PARTS = ['whombat', 'agent'] as const;
export type DeskBoxPart = (typeof BOX_PARTS)[number];

/**
 * This Whombat (DK-22, contracts 0.101.0 `DeskBox`): the processor and memory now and over the last hour, the data
 * disk, the processor's temperature and the network. Figures and their units come written by the runtime; the page
 * only draws them.
 */
export interface DeskBox {
  /** “up 2 h 14 min”; empty when the manager doesn't say. */
  up: string;
  cpu: { percent: number; cores: number; tone: Tone };
  memory: { percent: number; used: DeskFigure; total: string; tone: Tone };
  /** The last hour, oldest first, one point per `stepS`, ending now; null where nothing was measured. */
  history: { stepS: number; cpu: (number | null)[]; memory: (number | null)[] };
  storage: {
    percent: number;
    free: DeskFigure;
    total: string;
    tone: Tone;
    /** In the order whombat, agent; only those measured. */
    parts: { key: DeskBoxPart; value: string; percent: number }[];
  };
  /** The processor's, °C; null without a sensor (a VM). */
  temp: DeskMeter | null;
  /** Per second over the last step; null when not known. */
  network: { down: string; up: string } | null;
}

export interface DeskPower {
  source: 'ac' | 'battery';
  percent: number;
  charging: boolean;
  minutesLeft: number | null;
  chargeLimit: number | null;
  /** On battery since. */
  since: string | null;
}

/** Since 0.116 (TF-16) `working`: no answer after 90 s, still waiting for the turn (not final). */
export const TALK_STATES = ['transcribing', 'thinking', 'answered', 'failed', 'working'] as const;
export type TalkState = (typeof TALK_STATES)[number];
export const TALK_REASONS = ['not_heard', 'slow', 'voice_unavailable', 'failed'] as const;
export type TalkReason = (typeof TALK_REASONS)[number];

export interface DeskTalk {
  id: string;
  state: TalkState;
  question: string | null;
  answer: string | null;
  thing: DeskServer | null;
  audio: boolean;
  reason: TalkReason | null;
}

export const LOCK_STATES = ['locked', 'unlocked', 'phone', 'backoff'] as const;
export type LockState = (typeof LOCK_STATES)[number];

export interface DeskLock {
  state: LockState;
  /** Unlocked until (slides with every touch). */
  until: string | null;
  /** Backoff: PINs are refused until then. */
  retryAt: string | null;
  /** Phone: the unlock request ends then. */
  expiresAt: string | null;
  /** The camera is on now (0.103, DK-30): the lock chip shows the camera mark. Only while unlocked. */
  camera?: boolean;
  /** The camera sees someone (DK-28): the chip says the screen stays unlocked. Only with `camera`. */
  present?: boolean;
  /** Unlocked until someone presses Lock (0.107, DK-74): the chip has no minutes. Only while unlocked. */
  stays?: boolean;
}

/**
 * The camera looking for someone in front of the screen (0.107, DK-72, DK-73): absent when it doesn't look, and the
 * screen goes idle by touch alone (DK-71).
 */
export interface DeskPresence {
  /** The camera is on now: the glance's top bar and the clock show the camera mark. */
  camera: boolean;
  /** The camera can tell now: idle a minute after the last face and touch; else 10 minutes after the last touch. */
  watching: boolean;
  /** A face within the last minute: the glance shows (the locked one while locked; a face never unlocks, DK-29). */
  here: boolean;
}

export interface DeskPaired {
  locale?: string;
  person: { name: string; initial: string; tone: 1 | 2 | 3 | 4 | 5 };
  /** False: no PIN chosen yet, only the phone unlocks (DK-18); an older runtime sends none, which is true. */
  hasPin: boolean;
  /** The PIN's length, 4 to 6 (0.103, DK-26): the pad's dots; absent (an older runtime, or no PIN yet) is 6. */
  pinDigits?: 4 | 5 | 6;
  /** The Whombat's agent: its name and the face it wears (contracts 0.123.0 `DeskAssistant.face`, OA-08). */
  assistant: { name: string; face: AgentFace };
  /** The paired person's burrow, if Whombat sends it (not in contracts 0.100.0): else the claimed screen's name. */
  burrow: string | null;
  timeZone: string;
  lockedView: DeskLockedView;
  night: DeskNight;
  /** Inside quiet hours now (DK-09). */
  quiet: boolean;
  /** Talk is on and possible (DK-06, DK-07). */
  voice: boolean;
}

export interface DeskState {
  now: string;
  paired: DeskPaired | null;
  pairing: null | { code: string; expiresAt: string };
  lock: DeskLock;
  glance: DeskGlance | null;
  power: DeskPower | null;
  talk: DeskTalk | null;
  /** 0.107 (DK-72): the camera looking for someone; absent when it doesn't, or from an older runtime. */
  presence?: DeskPresence;
  /** 0.120 (RH-12, CG-290): remote help while it is on; absent when off, or from an older runtime. */
  remoteHelp?: RemoteHelp;
  /** 3.2 (DK-119, CG-351): the Whombat's name for the top bar; absent until the app gave it, then the org's name. */
  name?: string | null;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | null =>
  values.includes(v as T) ? (v as T) : null;
const time = (v: unknown): string | null =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

/** A display string cut to `max` characters (code points); `null` when it isn't a string or is empty. */
export function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '') return null;
  const cps = [...t];
  return cps.length > max ? cps.slice(0, max).join('') : t;
}

const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v))) : null;

/** A figure: a whole number, −100…1000 (the bars clamp it; the number shows as sent). */
function meter(v: unknown): DeskMeter | null {
  if (!isObj(v)) return null;
  const value = int(v.value, -100, 1000);
  return value === null ? null : { value, tone: oneOf(v.tone, TONES) ?? 'ok' };
}

/** A `@whombat/brand` mark key as the contracts allow it (`DeskMark`). */
const markRe = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const mark = (v: unknown): string | null => (typeof v === 'string' && markRe.test(v) ? v : null);

/**
 * A server's id as the contracts let it through (0.115 `DESK_SERVER_ID_RE`): the hosts service's slugs (`nas`,
 * `pve-01`), not a talk id. It goes into `/api/desk/server` and a talk's `server` (DK-83, DK-85).
 */
export const SERVER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A server id the page may ask about, or null. */
export const serverIdOf = (v: unknown): string | null =>
  typeof v === 'string' && SERVER_ID_RE.test(v) ? v : null;

export function parseServer(v: unknown): DeskServer | null {
  if (!isObj(v)) return null;
  const name = text(v.name, 40);
  if (!name) return null;
  const id = serverIdOf(v.id);
  return {
    ...(id && { id }),
    name,
    mark: mark(v.mark),
    state: oneOf(v.state, SERVER_STATES) ?? 'ok',
    note: text(v.note, 40) ?? '',
    cpu: meter(v.cpu),
    memory: meter(v.memory),
    temp: meter(v.temp),
    disk: meter(v.disk),
  };
}

function parseTile(v: unknown): DeskTile | null {
  if (!isObj(v)) return null;
  const value = text(v.value, 24);
  if (!value) return null;
  return {
    icon: oneOf(v.icon, TILE_ICONS) ?? 'generic',
    mark: mark(v.mark),
    value,
    label: text(v.label, 48) ?? '',
    tone: oneOf(v.tone, TONES),
  };
}

/**
 * An ask's wider choices as the page may offer them (CG-280): only where `mayChoose` (unlocked, a screen with a PIN)
 * and on an ask the screen may approve; a scope it doesn't know or has seen already, or a choice without a label, is
 * left out; at most `ASK_CHOICES`.
 */
function parseChoices(v: unknown, approvable: boolean, mayChoose: boolean): DeskAskChoice[] {
  if (!mayChoose || !approvable) return [];
  const seen = new Set<ChoiceScope>();
  return list(v, ASK_CHOICES).flatMap((c) => {
    if (!isObj(c)) return [];
    const scope = oneOf(c.scope, CHOICE_SCOPES);
    const label = text(c.label, 120);
    if (!scope || !label || seen.has(scope)) return [];
    seen.add(scope);
    return [{ scope, label }];
  });
}

function parseAsk(v: unknown, mayChoose: boolean): DeskAsk | null {
  if (!isObj(v)) return null;
  const number = int(v.number, 1, 1_000_000_000);
  const title = text(v.title, 120);
  const at = time(v.at);
  if (number === null || v.number !== number || !title || !at) return null;
  const approveWithPin = v.approveWithPin === true && v.onDesk !== true;
  return {
    number,
    kind: v.kind === 'question' ? 'question' : 'approval',
    title,
    at,
    where: text(v.where, 40),
    detail: text(v.detail, 400),
    facts: list(v.facts, 3).flatMap((f) => text(f, 80) ?? []),
    approveLabel: text(v.approveLabel, 40),
    // Only an explicit true puts buttons on the screen (DK-05).
    onDesk: v.onDesk === true,
    phoneReason: oneOf(v.phoneReason, PHONE_REASONS),
    // 0.108 (CG-192): only an explicit true; the PIN only off the desk (DeskStateValid).
    deny: v.deny === true,
    approveWithPin,
    inTalk: v.inTalk === true,
    // 0.116 (CG-280): only an approval the screen may approve, as the contracts' `deskStateValid`.
    choices: parseChoices(
      v.choices,
      v.kind !== 'question' && (v.onDesk === true || approveWithPin),
      mayChoose,
    ),
    from: text(v.from, 40),
  };
}

/**
 * A look's line (0.122, CG-332): a check the contracts take and an item of 1 to 160 characters, both exactly as sent
 * (the runtime finds the line by them); anything else is none, and the look can't be quieted here.
 */
function parseNotice(v: unknown): LookNotice | null {
  if (!isObj(v)) return null;
  const check = v.check;
  if (typeof check !== 'string' || check.length > 80 || !NOTICE_CHECK_RE.test(check)) return null;
  if (v.subject === undefined) return { check };
  const subject = v.subject;
  if (typeof subject !== 'string' || subject === '' || [...subject].length > 160) return null;
  return { check, subject };
}

/**
 * A look's research (3.5, CG-372): a state the page knows, about this look (`key`); its words cut to their bounds, the
 * step only while it is offered. Anything else is none, and the look shows as before.
 */
function parseResearch(v: unknown, key: string): LookResearch | null {
  if (!isObj(v) || text(v.key, 120) !== key) return null;
  const state = oneOf(v.state, LOOK_RESEARCH_STATES);
  if (!state) return null;
  const title = text(v.title, LOOK_TITLE_MAX);
  const summary = text(v.summary, LOOK_SUMMARY_MAX);
  const fix = state === 'found' ? text(v.fix, LOOK_FIX_LABEL_MAX) : null;
  return { state, ...(title && { title }), ...(summary && { summary }), ...(fix && { fix }) };
}

/**
 * A look as the page may draw it (0.118, CG-310): one without its key, its name or a state it knows is left out, and
 * since 0.122 a heads-up (QN-02); a nature it doesn't know is a problem's, as an older runtime's look (CG-332).
 */
function parseLook(v: unknown): DeskLook | null {
  if (!isObj(v)) return null;
  const key = text(v.key, 120);
  const name = text(v.name, 40);
  const kind = oneOf(v.kind, LOOK_KINDS);
  const state = oneOf(v.state, LOOK_STATES);
  const nature = oneOf(v.nature, NOTICE_NATURES);
  if (!key || !name || !kind || !state || nature === 'fyi') return null;
  const server = serverIdOf(v.server);
  const notice = parseNotice(v.notice);
  const ignoreWords = text(v.ignoreWords, 60);
  const question = text(v.question, 300);
  const research = parseResearch(v.research, key);
  return {
    key,
    kind,
    name,
    state,
    reason: text(v.reason, 120),
    ...(server && { server }),
    ...(notice && { notice }),
    ...(nature && { nature }),
    ...(ignoreWords && { ignoreWords }),
    ...(question && { question }),
    ...(research && { research }),
  };
}

/** `mayChoose`: an ask's wider choices may show (unlocked, a screen with a PIN; 0.116, CG-280). */
function parseGlance(v: unknown, mayChoose: boolean): DeskGlance | null {
  if (!isObj(v)) return null;
  const status = isObj(v.status) ? v.status : {};
  const needs = isObj(v.needsYou) ? v.needsYou : {};
  const items = list(needs.items, 5).flatMap((a) => parseAsk(a, mayChoose) ?? []);
  const looks = list(needs.looks, LOOKS_MAX).flatMap((l) => parseLook(l) ?? []);
  const w = isObj(v.working) ? v.working : null;
  const wTitle = w ? text(w.title, 120) : null;
  const servers = list(v.servers, 4).flatMap((s) => parseServer(s) ?? []);
  const tiles = list(v.tiles, 4).flatMap((t) => parseTile(t) ?? []);
  // The next four of each only beside a full four (DK-42); anything else is none (CG-135).
  const extraServers =
    servers.length === 4 ? list(v.extraServers, 4).flatMap((s) => parseServer(s) ?? []) : [];
  const extraTiles = tiles.length === 4 ? list(v.extraTiles, 4).flatMap((t) => parseTile(t) ?? []) : [];
  const something = servers.length > 0 || tiles.length > 0;
  return {
    status: { text: text(status.text, 200) ?? '', more: text(status.more, 200) },
    needsYou: {
      count: Math.max(int(needs.count, 0, 9999) ?? 0, items.length),
      items,
      ...(looks.length > 0 && { looks }),
    },
    working:
      w && wTitle
        ? {
            title: wTitle,
            steps: list(w.steps, 6).flatMap((s) => {
              if (!isObj(s)) return [];
              const label = text(s.label, 40);
              const state = oneOf(s.state, ['done', 'now', 'next'] as const);
              return label && state ? [{ label, state }] : [];
            }),
          }
        : null,
    done: list(v.done, 3).flatMap((d) => {
      if (!isObj(d)) return [];
      const t = text(d.text, 120);
      const at = time(d.at);
      return t && at ? [{ text: t, at }] : [];
    }),
    servers,
    // The extra servers are among the ones counted (a count that says less is the extra ones).
    moreServers: Math.max(int(v.moreServers, 0, 9999) ?? 0, extraServers.length),
    tiles,
    // The panel only on a glance without servers and tiles (DK-22), This Whombat beside them as `self` (DK-39).
    box: something ? null : parseBox(v.box),
    self: something ? parseBox(v.self) : null,
    extraServers,
    extraTiles,
    found: parseFound(v.found),
    calm: parseCalm(v.calm),
    grid: parseGrid(v.grid),
    outputs: parseOutputGrids(v.outputs),
  };
}

/** The most found services the glance names (DF-03, the contracts' `DESK_FOUND_ITEMS`). */
export const FOUND_MAX = 8;
/** A catalog entry's id as the contracts let it through (`DeskFoundItem.catalogId`): a newer runtime's ids too. */
const catalogIdRe = /^[a-z][a-z0-9_]{1,30}$/;
/** The contracts' `Count`: a whole number up to a million. */
const COUNT_MAX = 1_000_000;

function parseFoundItem(v: unknown): DeskFoundItem | null {
  if (!isObj(v)) return null;
  const catalogId = typeof v.catalogId === 'string' && catalogIdRe.test(v.catalogId) ? v.catalogId : null;
  const name = text(v.name, 60);
  const address = text(v.address, 120);
  if (!catalogId || !name || !address) return null;
  return { catalogId, name, tagline: text(v.tagline, 40) ?? '', address };
}

/**
 * Found on your network (CG-230): the items it can name (a valid catalog id, a name and an address), the count at
 * least as many, the progress only as two whole numbers with `done` ≤ `total`. Null when it isn't one, or when there is
 * nothing to show: no scan looking and nothing found.
 */
export function parseFound(v: unknown): DeskFound | null {
  if (!isObj(v)) return null;
  // One card per service: the same entry at the same address twice is once.
  const keys = new Set<string>();
  const items = list(v.items, FOUND_MAX).flatMap((i) => {
    const item = parseFoundItem(i);
    const key = item && `${item.catalogId}@${item.address}`;
    if (!item || !key || keys.has(key)) return [];
    keys.add(key);
    return [item];
  });
  const p = isObj(v.progress) ? v.progress : null;
  const total = p ? int(p.total, 0, COUNT_MAX) : null;
  const done = p && total !== null ? int(p.done, 0, total) : null;
  const progress = total !== null && done !== null && total > 0 ? { done, total } : null;
  const count = Math.max(int(v.count, 0, COUNT_MAX) ?? 0, items.length);
  if (!progress && count === 0) return null;
  return { scanning: v.scanning === true, progress, items, count, finishedAt: time(v.finishedAt) };
}

const pct = (v: unknown): number | null => int(v, 0, 100);

function figure(v: unknown): DeskFigure | null {
  if (!isObj(v)) return null;
  const value = text(v.value, 8);
  const unit = text(v.unit, 8);
  return value && unit ? { value, unit } : null;
}

/** The last hour's points: whole percentages or null (a gap), the latest 60 at most. */
const points = (v: unknown): (number | null)[] => (Array.isArray(v) ? v.slice(-60).map(pct) : []);

/** This Whombat, or null when a part the panel can't do without is missing; the temperature and network may be. */
export function parseBox(v: unknown): DeskBox | null {
  if (!isObj(v) || !isObj(v.cpu) || !isObj(v.memory) || !isObj(v.storage)) return null;
  const { cpu, memory, storage } = v;
  const cpuPct = pct(cpu.percent);
  const cores = int(cpu.cores, 1, 4096);
  const memPct = pct(memory.percent);
  const used = figure(memory.used);
  const memTotal = text(memory.total, 16);
  const diskPct = pct(storage.percent);
  const free = figure(storage.free);
  const diskTotal = text(storage.total, 16);
  if (cpuPct === null || cores === null || memPct === null || !used || !memTotal) return null;
  if (diskPct === null || !free || !diskTotal) return null;
  const h = isObj(v.history) ? v.history : {};
  let hCpu = points(h.cpu);
  let hMem = points(h.memory);
  // Both the same length, ending now: a longer one loses its oldest points.
  const n = Math.min(hCpu.length, hMem.length);
  hCpu = hCpu.slice(hCpu.length - n);
  hMem = hMem.slice(hMem.length - n);
  const parts = BOX_PARTS.flatMap((key) => {
    const p = list(storage.parts, 2).find((x) => isObj(x) && x.key === key);
    if (!isObj(p)) return [];
    const value = text(p.value, 16);
    const percent = pct(p.percent);
    return value && percent !== null ? [{ key, value, percent }] : [];
  });
  const net = isObj(v.network) ? v.network : null;
  const down = net ? text(net.down, 16) : null;
  const up = net ? text(net.up, 16) : null;
  return {
    up: text(v.up, 40) ?? '',
    cpu: { percent: cpuPct, cores, tone: oneOf(cpu.tone, TONES) ?? 'ok' },
    memory: { percent: memPct, used, total: memTotal, tone: oneOf(memory.tone, TONES) ?? 'ok' },
    history: { stepS: int(h.stepS, 1, 3600) ?? 60, cpu: hCpu, memory: hMem },
    storage: {
      percent: diskPct,
      free,
      total: diskTotal,
      tone: oneOf(storage.tone, TONES) ?? 'ok',
      parts,
    },
    temp: meter(v.temp),
    network: down && up ? { down, up } : null,
  };
}

function parsePower(v: unknown): DeskPower | null {
  if (!isObj(v)) return null;
  const source = oneOf(v.source, ['ac', 'battery'] as const);
  const percent = int(v.percent, 0, 100);
  if (!source || percent === null) return null;
  return {
    source,
    percent,
    charging: v.charging === true,
    minutesLeft: int(v.minutesLeft, 0, 100_000),
    chargeLimit: int(v.chargeLimit, 0, 100),
    since: time(v.since),
  };
}

/** A talk's id (it goes into the audio URL), and a message's. */
const talkIdRe = /^[A-Za-z0-9_-]{8,64}$/;
/** A talk id the page may put in a URL or follow, or null. */
export const talkIdOf = (v: unknown): string | null => (typeof v === 'string' && talkIdRe.test(v) ? v : null);

export function parseTalk(v: unknown): DeskTalk | null {
  if (!isObj(v)) return null;
  const state = oneOf(v.state, TALK_STATES);
  if (typeof v.id !== 'string' || !talkIdRe.test(v.id) || !state) return null;
  return {
    id: v.id,
    state,
    question: text(v.question, 500),
    answer: text(v.answer, 600),
    thing: parseServer(v.thing),
    audio: v.audio === true,
    reason: oneOf(v.reason, TALK_REASONS),
  };
}

/** The faces the agent may wear (contracts `AGENT_FACES`, Whombat one-agent.md OA-08), in the contracts' order. */
export const AGENT_FACES = ['dusty', 'banjo', 'neo', 'skipper', 'hazel'] as const;
export type AgentFace = (typeof AGENT_FACES)[number];

const isFace = (v: unknown): v is AgentFace =>
  typeof v === 'string' && (AGENT_FACES as readonly string[]).includes(v);

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parsePaired(v: unknown): DeskPaired | null {
  if (!isObj(v) || !isObj(v.person) || !isObj(v.assistant)) return null;
  const name = text(v.person.name, 40);
  const assistant = text(v.assistant.name, 40);
  if (!name || !assistant) return null;
  const tz = typeof v.timeZone === 'string' && validZone(v.timeZone) ? v.timeZone : 'UTC';
  const tone = int(v.person.tone, 1, 5) ?? 1;
  const locale = localeTag(v.locale);
  return {
    ...(locale ? { locale } : {}),
    person: {
      name,
      initial: text(v.person.initial, 2) ?? ([...name][0] ?? '?').toUpperCase(),
      tone: tone as 1 | 2 | 3 | 4 | 5,
    },
    // Only an explicit false takes the keys away (DK-18): an older runtime always has a PIN.
    hasPin: v.hasPin !== false,
    // Anything but 4, 5 or 6 is the length before 0.103 (DK-34).
    pinDigits: v.pinDigits === 4 || v.pinDigits === 5 || v.pinDigits === 6 ? v.pinDigits : undefined,
    // A face this page doesn't know is Dusty's, the agent's own until someone picks another (CG-337).
    assistant: { name: assistant, face: isFace(v.assistant.face) ? v.assistant.face : 'dusty' },
    burrow: text(v.burrow, 40),
    timeZone: tz,
    lockedView: oneOf(v.lockedView, DESK_LOCKED_VIEWS) ?? 'summary',
    night: v.night === 'black' ? 'black' : 'dim',
    quiet: v.quiet === true,
    voice: v.voice === true,
  };
}

/** Four letters of the claim code's alphabet (DK-02, protocol `ClaimLetters`). */
const pairingRe = /^[ABCDEFGHJKMNPQRTVWXY]{4}$/;

/** The desk, or null when there is none or it isn't one the page understands (the console stays as it is). */
export function parseDesk(v: unknown): DeskState | null {
  if (!isObj(v) || v.v !== 1) return null;
  const now = time(v.now);
  if (!now) return null;
  const lock = isObj(v.lock) ? v.lock : {};
  const lockState = oneOf(lock.state, LOCK_STATES) ?? 'locked';
  // The camera only while unlocked, someone seen only with it on (DK-30): anything else is no camera.
  const camera = lockState === 'unlocked' && lock.camera === true;
  const pairing = isObj(v.pairing) ? v.pairing : null;
  const paired = parsePaired(v.paired);
  // The camera looking for someone only on a paired screen (DK-72); each member says only what an explicit true says.
  const presence = paired && isObj(v.presence) ? v.presence : null;
  const remoteHelp = parseRemoteHelp(v.remoteHelp);
  return {
    now,
    paired,
    pairing:
      pairing && typeof pairing.code === 'string' && pairingRe.test(pairing.code) && time(pairing.expiresAt)
        ? { code: pairing.code, expiresAt: pairing.expiresAt as string }
        : null,
    // Anything the page doesn't understand is locked: it never shows more than the runtime meant.
    lock: {
      state: lockState,
      until: time(lock.until),
      retryAt: time(lock.retryAt),
      expiresAt: time(lock.expiresAt),
      camera,
      present: camera && lock.present === true,
      stays: lockState === 'unlocked' && lock.stays === true,
    },
    glance: paired ? parseGlance(v.glance, lockState === 'unlocked' && paired.hasPin) : null,
    power: parsePower(v.power),
    talk: parseTalk(v.talk),
    ...(presence && {
      presence: {
        camera: presence.camera === true,
        watching: presence.watching === true,
        here: presence.here === true,
      },
    }),
    ...(remoteHelp && { remoteHelp }),
    name: paired ? text(v.name, 40) : null,
  };
}

/**
 * Why Whombat refused a desk request (CG-56): the console server answers `{"message": "<code>"}` as all its errors
 * (Go `web.Error`, `consoleapi.deskError`); `code` is read first should it ever send one. Null without either.
 */
export function deskErrorCode(body: unknown): string | null {
  if (!isObj(body)) return null;
  const c = body.code ?? body.message;
  return typeof c === 'string' ? c : null;
}

/* The open conversation (0.108, DK-63, DK-64; CG-196) ------------------------------------------------------------- */

export const SESSION_FROM = ['you', 'assistant'] as const;
export type SessionFrom = (typeof SESSION_FROM)[number];
export const SESSION_ASK_STATES = ['waiting', 'approved', 'denied'] as const;
export type SessionAskState = (typeof SESSION_ASK_STATES)[number];

export interface DeskSessionAsk {
  number: number;
  state: SessionAskState;
}

/** A server task's state (0.116 `DESK_TASK_STATES`, core's `TASK_CARD_STATES`). */
export const TASK_STATES = ['running', 'ok', 'warning', 'error', 'lost'] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** A server task's card in the conversation (0.116 `DeskSessionTask`, TF-17): a live row. */
export interface DeskSessionTask {
  /** The running words: “Installing 23 updates on Home Assistant”. */
  title: string;
  state: TaskState;
  startedAt: string;
  /** Exactly when not running. */
  endedAt: string | null;
  /** The outcome words, only once it ended. */
  result: string | null;
}

/** The assistant working in the conversation's thread (0.116 `DeskSessionWorking`, TF-17). */
export interface DeskSessionWorking {
  since: string;
  /** What it is doing now, as Chat's activity says it; null: nothing to say. */
  doing: string | null;
}

/** One message of the conversation, made plain by Whombat (`DeskSessionMessage`). */
export interface DeskSessionMessage {
  id: string;
  from: SessionFrom;
  at: string;
  paragraphs: string[];
  /** Something of it is only in Chat (code, a table, a picture, a file, or it was cut). */
  more: boolean;
  /** An approval's card asked here. */
  ask: DeskSessionAsk | null;
  /** The desk talk it was the question or the answer of. */
  talk: string | null;
  /** That answer's sound can still be played. */
  audio: boolean;
  thing: DeskServer | null;
  /** A server task's card (0.116, TF-17): drawn as a live row instead of its paragraphs (the card's line). */
  task?: DeskSessionTask | null;
}

/** `POST /api/desk/talk/session`: the open conversation, oldest first; `open` false: none (Talk starts empty). */
export interface DeskSession {
  open: boolean;
  messages: DeskSessionMessage[];
  /** Messages before these, only in Chat. */
  earlier: number;
  until: string | null;
  /** The assistant is working in it now (0.116, TF-17): the working row at the bottom. */
  working?: DeskSessionWorking | null;
}

export const CLOSED_SESSION: DeskSession = {
  open: false,
  messages: [],
  earlier: 0,
  until: null,
  working: null,
};

/**
 * A task's row as the page may draw it (CG-284): a title, a state it knows and when it started; `endedAt` exactly when
 * not running and a result only then, as the contracts' `deskTalkSessionValid`. Anything else is no row (the message
 * shows its paragraphs, the card's line).
 */
export function parseTask(v: unknown): DeskSessionTask | null {
  if (!isObj(v)) return null;
  const title = text(v.title, 120);
  const state = oneOf(v.state, TASK_STATES);
  const startedAt = time(v.startedAt);
  const endedAt = time(v.endedAt);
  if (!title || !state || !startedAt) return null;
  const running = state === 'running';
  if (running !== (endedAt === null) || (running && v.result != null)) return null;
  return { title, state, startedAt, endedAt, result: running ? null : text(v.result, 600) };
}

function parseSessionMessage(v: unknown): DeskSessionMessage | null {
  if (!isObj(v)) return null;
  const id = talkIdOf(v.id);
  const from = oneOf(v.from, SESSION_FROM);
  const at = time(v.at);
  const paragraphs = list(v.paragraphs, 8).flatMap((p) => text(p, 600) ?? []);
  if (!id || !from || !at || paragraphs.length === 0) return null;
  const ask = isObj(v.ask) ? v.ask : null;
  const number = ask ? int(ask.number, 1, 1_000_000_000) : null;
  const state = ask ? oneOf(ask.state, SESSION_ASK_STATES) : null;
  return {
    id,
    from,
    at,
    paragraphs,
    more: v.more === true,
    ask: number !== null && ask?.number === number && state ? { number, state } : null,
    talk: talkIdOf(v.talk),
    audio: v.audio === true,
    thing: parseServer(v.thing),
    // Never beside an ask (CT-895): the ask's card wins.
    task: ask ? null : parseTask(v.task),
  };
}

/** The conversation as the console server passes it on, or null when it isn't one the page understands. */
export function parseSession(v: unknown): DeskSession | null {
  if (!isObj(v) || v.v !== 1 || typeof v.open !== 'boolean') return null;
  if (!v.open) return CLOSED_SESSION;
  const w = isObj(v.working) ? v.working : null;
  const since = w ? time(w.since) : null;
  return {
    open: true,
    messages: list(v.messages, 40).flatMap((m) => parseSessionMessage(m) ?? []),
    earlier: int(v.earlier, 0, 1_000_000) ?? 0,
    until: time(v.until),
    working: w && since ? { since, doing: text(w.doing, 120) } : null,
  };
}

/* A server's own screen and every server (0.115, DK-83, DK-86; CG-250…) ------------------------------------------ */

/** The most servers `/api/desk/servers` sends (the contracts' `DESK_SERVERS`). */
export const DESK_SERVERS = 24;
export const SERVER_RANGES = ['1h', '24h', '7d'] as const;
export type ServerRange = (typeof SERVER_RANGES)[number];
/** Each range's length (s): the chart's span, ending now. */
export const RANGE_S: Record<ServerRange, number> = { '1h': 3600, '24h': 86_400, '7d': 7 * 86_400 };
/** Bounds of the page (the contracts' `DESK_SERVER_POINTS`, `_VOLUMES`, `_GUESTS`, `_ALERTS`). */
export const SERVER_POINTS = 96;
export const SERVER_VOLUMES = 6;
export const SERVER_GUESTS = 6;
export const SERVER_ALERTS = 3;
export const GUEST_STATES = ['running', 'stopped', 'unhealthy', 'paused'] as const;
export type GuestState = (typeof GUEST_STATES)[number];

/** `POST /api/desk/servers` (DK-86): every server as a card, worst first, the first `DESK_SERVERS`; the rest counted. */
export interface DeskServersAnswer {
  servers: DeskServer[];
  more: number;
}

export interface DeskVolume {
  name: string;
  /** “nvme mirror”, “on nas”; empty when there is none. */
  note: string;
  percent: number;
  used: string;
  total: string;
  tone: Tone;
}

export const GUEST_KINDS = ['vm', 'container'] as const;
export const ALERT_TONES = ['warn', 'bad'] as const;

export interface DeskGuest {
  name: string;
  kind: (typeof GUEST_KINDS)[number];
  state: GuestState;
  cpu: number | null;
  /** “6.1 GB”; empty when it is off. */
  memory: string;
}

/**
 * `POST /api/desk/server` (DK-83): one server's own screen, its figures written by the runtime. Locked, the alerts'
 * titles come only with *Everything* (DK-84).
 */
export interface DeskServerPage {
  now: string;
  /** The card's own shape, with the id asked for. */
  server: DeskServer & { id: string };
  /** “Proxmox VE 9.0.10”; empty when not known. */
  os: string;
  /** “up 41 d”; empty when off or not known. */
  up: string;
  cpu: { percent: number; cores: number | null; load: string; tone: Tone } | null;
  memory: { percent: number; used: DeskFigure; total: string; tone: Tone } | null;
  disk: { percent: number; used: string; total: string; tone: Tone } | null;
  temp: { value: number; limit: number; tone: Tone } | null;
  history: {
    range: ServerRange;
    /** One point per `stepS`, ending now, oldest first. */
    stepS: number;
    cpu: (number | null)[];
    memory: (number | null)[];
    cpuPeak: { percent: number; at: string } | null;
    memoryAvg: number | null;
  };
  volumes: DeskVolume[];
  /** Null: the server has no guests. */
  guests: { running: number; off: number; items: DeskGuest[] } | null;
  network: { down: string; up: string } | null;
  alerts: { count: number; items: { tone: (typeof ALERT_TONES)[number]; title: string }[] };
}

/** Every server as cards (CG-250): the ones the page can draw, at most `DESK_SERVERS`, the rest counted. */
export function parseServersAnswer(v: unknown): DeskServersAnswer | null {
  if (!isObj(v) || v.v !== 1 || !Array.isArray(v.servers)) return null;
  const servers = list(v.servers, DESK_SERVERS).flatMap((s) => parseServer(s) ?? []);
  return { servers, more: int(v.more, 0, COUNT_MAX) ?? 0 };
}

/** A series: whole percentages or null (a gap), the latest `SERVER_POINTS`. */
const series = (v: unknown): (number | null)[] => (Array.isArray(v) ? v.slice(-SERVER_POINTS).map(pct) : []);

/**
 * One server's screen (CG-250), or null when it isn't one the page understands or is another server's than the one
 * asked for: the screen then keeps what it had. A figure, volume, guest or alert it doesn't understand is left out;
 * the two series are cut to the same length, ending now; strings to their contract lengths.
 */
export function parseServerPage(v: unknown, id: string): DeskServerPage | null {
  if (!isObj(v) || v.v !== 1) return null;
  const now = time(v.now);
  const server = parseServer(v.server);
  if (!now || !server || server.id !== id) return null;
  const c = isObj(v.cpu) ? v.cpu : null;
  const cpuPct = c ? pct(c.percent) : null;
  const m = isObj(v.memory) ? v.memory : null;
  const memPct = m ? pct(m.percent) : null;
  const memUsed = m ? figure(m.used) : null;
  const memTotal = m ? text(m.total, 16) : null;
  const d = isObj(v.disk) ? v.disk : null;
  const diskPct = d ? pct(d.percent) : null;
  const diskUsed = d ? text(d.used, 16) : null;
  const diskTotal = d ? text(d.total, 16) : null;
  const t = isObj(v.temp) ? v.temp : null;
  const tempValue = t ? int(t.value, -100, 1000) : null;
  const tempLimit = t ? int(t.limit, -100, 1000) : null;
  const h = isObj(v.history) ? v.history : {};
  let hCpu = series(h.cpu);
  let hMem = series(h.memory);
  const n = Math.min(hCpu.length, hMem.length);
  hCpu = hCpu.slice(hCpu.length - n);
  hMem = hMem.slice(hMem.length - n);
  const peak = isObj(h.cpuPeak) ? h.cpuPeak : null;
  const peakPct = peak ? pct(peak.percent) : null;
  const peakAt = peak ? time(peak.at) : null;
  const g = isObj(v.guests) ? v.guests : null;
  const al = isObj(v.alerts) ? v.alerts : {};
  const alertItems = list(al.items, SERVER_ALERTS).flatMap((a) => {
    if (!isObj(a)) return [];
    const tone = oneOf(a.tone, ALERT_TONES);
    const title = text(a.title, 120);
    return tone && title ? [{ tone, title }] : [];
  });
  const net = isObj(v.network) ? v.network : null;
  const down = net ? text(net.down, 16) : null;
  const up = net ? text(net.up, 16) : null;
  const toneOf = (o: Obj) => oneOf(o.tone, TONES) ?? 'ok';
  return {
    now,
    server: { ...server, id },
    os: text(v.os, 60) ?? '',
    up: text(v.up, 40) ?? '',
    cpu:
      c && cpuPct !== null
        ? { percent: cpuPct, cores: int(c.cores, 1, 4096), load: text(c.load, 8) ?? '', tone: toneOf(c) }
        : null,
    memory:
      m && memPct !== null && memUsed && memTotal
        ? { percent: memPct, used: memUsed, total: memTotal, tone: toneOf(m) }
        : null,
    disk:
      d && diskPct !== null && diskUsed && diskTotal
        ? { percent: diskPct, used: diskUsed, total: diskTotal, tone: toneOf(d) }
        : null,
    temp:
      t && tempValue !== null && tempLimit !== null
        ? { value: tempValue, limit: tempLimit, tone: toneOf(t) }
        : null,
    history: {
      range: oneOf(h.range, SERVER_RANGES) ?? '24h',
      stepS: int(h.stepS, 1, 86_400) ?? 900,
      cpu: hCpu,
      memory: hMem,
      cpuPeak: peakPct !== null && peakAt ? { percent: peakPct, at: peakAt } : null,
      memoryAvg: pct(h.memoryAvg),
    },
    volumes: list(v.volumes, SERVER_VOLUMES).flatMap((x) => {
      if (!isObj(x)) return [];
      const name = text(x.name, 40);
      const percent = pct(x.percent);
      const used = text(x.used, 16);
      const total = text(x.total, 16);
      return name && percent !== null && used && total
        ? [{ name, note: text(x.note, 40) ?? '', percent, used, total, tone: toneOf(x) }]
        : [];
    }),
    guests: g
      ? {
          running: int(g.running, 0, COUNT_MAX) ?? 0,
          off: int(g.off, 0, COUNT_MAX) ?? 0,
          items: list(g.items, SERVER_GUESTS).flatMap((x) => {
            if (!isObj(x)) return [];
            const name = text(x.name, 60);
            const kind = oneOf(x.kind, GUEST_KINDS);
            const state = oneOf(x.state, GUEST_STATES);
            return name && kind && state
              ? [{ name, kind, state, cpu: pct(x.cpu), memory: text(x.memory, 16) ?? '' }]
              : [];
          }),
        }
      : null,
    network: down && up ? { down, up } : null,
    // The count holds the titles sent at least.
    alerts: { count: Math.max(int(al.count, 0, COUNT_MAX) ?? 0, alertItems.length), items: alertItems },
  };
}
