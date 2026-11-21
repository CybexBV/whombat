/**
 * The desk display's rules (Whombat desk-display.md DK-01…DK-09, DK-70…DK-71, DK-83…DK-87; appliance CG-37…, CG-171…,
 * CG-256…): when the console turns into the desk, which scene shows (the glance dimmed when nobody's there; a server's own
 * screen, every server, This Whombat's), the lock chip, when the page tells Whombat it's being used, and what a new ask
 * does (wake, amber edge, one sound) by day and by night. Pure: the page's clock, the last input and the polls come in
 * as values.
 */
import type { ConsoleState } from './api';
import { linkShown } from './console';
import type { DeskAsk, DeskGlance, DeskLock, DeskState } from './desk';

/** Desk scenes are laid out at 1280×800 (the Z13's 2560×1600 at 200 %); the claim screens keep 1024×768 (CG-18). */
export const DESK_STAGE = { width: 1280, height: 800 } as const;
/** In quiet hours a touch shows the glance for a minute (DK-09). */
export const SHOW_MS = 60_000;
/** While someone uses the unlocked screen, the page tells Whombat at most this often (DK-04's 2 minutes slide). */
export const TOUCH_EVERY_MS = 20_000;
/**
 * Nobody there (DK-71): idle this long after the last touch without the camera, and a new ask keeps the glance up as
 * long (the contracts' `DESK_IDLE_S`).
 */
export const DESK_IDLE_MS = 600 * 1000;
/** With the camera watching: idle this long after the last face and touch (the contracts' `DESK_AWAY_S`). */
export const DESK_AWAY_MS = 60 * 1000;
/** A server's screen, every server and This Whombat's go back to the glance this long after the last touch (DK-83). */
export const PAGE_MS = 2 * 60_000;

/**
 * The console shows the desk when Whombat has paired its screen or is pairing it (DK-01, DK-02), except while the
 * box shows a claim code (claimable, backoff) or a Whombat Link code (CG-404): those must never be hidden. Everything
 * else is today's console.
 */
export function deskActive(s: ConsoleState): boolean {
  const d = s.desk;
  if (!d || (!d.paired && !d.pairing)) return false;
  const claim = s.claim?.state;
  return claim !== 'claimable' && claim !== 'backoff' && !linkShown(s);
}

/** The screens a card opens (DK-83, DK-86, DK-87): a server's own, every server, This Whombat's. */
export const DESK_PAGES = ['server', 'servers', 'self'] as const;
export type DeskPage = (typeof DESK_PAGES)[number];

export type DeskScene = 'pairing' | 'black' | 'night' | 'idle' | 'clock' | 'glance' | 'talk' | DeskPage;

export const isPage = (scene: DeskScene): scene is DeskPage =>
  (DESK_PAGES as readonly string[]).includes(scene);

export interface SceneInput {
  desk: DeskState;
  /** Page clock (ms). */
  now: number;
  /** Whombat's clock (ms): the page's plus the offset it keeps from the polls. */
  serverNow: number;
  /** Last touch, key or pointer press (ms); the page's start counts as one. */
  lastInput: number;
  /** The person opened Talk. */
  talkOpen: boolean;
  /** When the last new ask arrived by day (page clock), or null: it keeps the glance up 10 minutes (DK-71). */
  alertAt?: number | null;
  /** Talk is listening, sending, thinking or speaking (`talkBusy`): never idle (DK-71). */
  talkBusy?: boolean;
  /** Since when nobody's there (the dimmed glance, page clock), while so; null otherwise (CG-171, DK-97). */
  idleSince?: number | null;
  /** The screen a card opened (DK-83, DK-86, DK-87), while the page keeps it open. */
  page?: DeskPage | null;
}

/**
 * Unlocked now (CG-51): Whombat says so and its `until` is still ahead by Whombat's clock. A poll that didn't come
 * (the lock slides with every touch, so the last one seen only runs out early) never keeps the screen open longer.
 */
export function isUnlocked(lock: DeskLock, serverNow: number): boolean {
  if (lock.state !== 'unlocked' || !lock.until) return false;
  const until = Date.parse(lock.until);
  return Number.isFinite(until) && until > serverNow;
}

/**
 * Nobody there: the glance dimmed (DK-97; DK-70, DK-71, CG-171). By day on a paired screen, locked or unlocked; never
 * while the phone is asked to unlock or Talk is busy, while the camera sees someone (`presence.here`) or within 10
 * minutes of a new ask; else 10 minutes after the last touch or key, or one minute while the camera can tell (`presence.watching`).
 * Once idle it stays so until a touch, a key, a face or a new ask wakes it: a camera that stops being able to tell
 * (dark, starting again) doesn't bring the glance back for a while, nor flicker it.
 */
export function isIdle({
  desk,
  now,
  lastInput,
  alertAt = null,
  talkBusy = false,
  idleSince = null,
}: SceneInput): boolean {
  const p = desk.paired;
  if (!p || p.quiet || desk.pairing || desk.lock.state === 'phone' || talkBusy) return false;
  if (desk.presence?.here) return false;
  if (alertAt !== null && now - alertAt < DESK_IDLE_MS) return false;
  if (idleSince !== null) return lastInput <= idleSince;
  return now - lastInput >= (desk.presence?.watching ? DESK_AWAY_MS : DESK_IDLE_MS);
}

/**
 * The scene: the pairing letters while Settings pairs; in quiet hours the dim clock (or black) unless touched in the
 * last minute or talking; by day the dimmed glance when nobody's there (`isIdle`, DK-97); Talk when it is open and unlocked
 * (typing needs no voice, DK-T12); the clock with its line when the person chose “Only the time” and the screen is
 * locked (no cards, so no server screen: DK-84); the screen a card opened, locked or not, until two minutes after the
 * last touch (DK-83, DK-84); else the glance.
 */
export function deskScene(input: SceneInput): DeskScene {
  const { desk, now, serverNow, lastInput, talkOpen } = input;
  if (desk.pairing) return 'pairing';
  const p = desk.paired;
  if (!p) return 'glance';
  const unlocked = isUnlocked(desk.lock, serverNow);
  const talking = talkOpen && unlocked;
  // A talk waiting for its answer keeps the screen up at night too, until the screen locks.
  if (p.quiet && !talking && now - lastInput >= SHOW_MS) return p.night === 'black' ? 'black' : 'night';
  if (isIdle(input)) return 'idle';
  if (talking) return 'talk';
  if (!unlocked && p.lockedView === 'time') return 'clock';
  if (input.page && now - lastInput < PAGE_MS) return input.page;
  return 'glance';
}

/**
 * Whether a screen a card opened stays open in this scene (DK-83): while it shows, and under Talk (Ask about a server,
 * DK-85: back from Talk is back on it). Anything else closes it: Back, two minutes untouched, the night or the idle
 * clock, *Only the time* while locked, the pairing letters.
 */
export const pageKept = (scene: DeskScene, page: DeskPage): boolean => scene === page || scene === 'talk';

/** The ask sheet and the PIN pad open over these (DK-60): the glance, the clock, Talk and the screens a card opens. */
export const sheetOver = (scene: DeskScene): boolean =>
  scene === 'glance' || scene === 'clock' || scene === 'talk' || isPage(scene);

/**
 * A touch on a locked screen that isn't on a button opens the PIN pad (“Locked · touch to use”): on the glance, the
 * clock and the screens a card opens. A card itself is a button: it opens its screen, not the pad (DK-84).
 */
export const touchUnlocks = (scene: DeskScene): boolean =>
  scene === 'glance' || scene === 'clock' || isPage(scene);

/**
 * The microphone may be open only while Talk shows on an unlocked screen with Talk's voice on and Whombat there
 * (DK-07, CG-52): anything else closes it, a microphone still opening included.
 */
export function mayListen(o: {
  scene: DeskScene;
  unlocked: boolean;
  voice: boolean;
  held: boolean;
}): boolean {
  return o.scene === 'talk' && o.unlocked && o.voice && !o.held;
}

/** Whole minutes until the screen locks again, at least 1; null when Whombat didn't say. */
export function locksIn(until: string | null, now: number): number | null {
  const t = until ? Date.parse(until) : Number.NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(1, Math.ceil((t - now) / 60_000));
}

/** Whether a touch now should be sent to Whombat (unlocked only, at most every 20 s). */
export function shouldTouch(lastSent: number | null, now: number, unlocked: boolean): boolean {
  return unlocked && (lastSent === null || now - lastSent >= TOUCH_EVERY_MS);
}

/** What the page remembers of the asks between polls: their count and the numbers it saw. */
export interface AskSig {
  count: number;
  numbers: readonly number[];
}

export const askSig = (g: DeskGlance | null): AskSig => ({
  count: g?.needsYou.count ?? 0,
  numbers: g?.needsYou.items.map((a) => a.number) ?? [],
});

/**
 * A new ask arrived: more of them, or one the page hadn't seen while it saw them all (titles appearing on an unlock,
 * or past the five shown, are not new). Not on the first state the page sees.
 */
export function newAsk(prev: AskSig | null, next: AskSig): boolean {
  if (!prev) return false;
  if (next.count > prev.count) return true;
  const complete = (s: AskSig) => s.numbers.length === s.count;
  return complete(prev) && complete(next) && next.numbers.some((n) => !prev.numbers.includes(n));
}

export interface Alert {
  /** Brighten a dimmed screen. */
  wake: boolean;
  /** One soft sound. */
  chime: boolean;
}

/** DK-08, DK-09: by day a new ask wakes the screen and chimes once; in quiet hours nothing happens. */
export function alertFor(prev: AskSig | null, next: AskSig, quiet: boolean): Alert {
  const fresh = newAsk(prev, next) && !quiet;
  return { wake: fresh, chime: fresh };
}

export interface Attention {
  /** The amber edge: an ask nobody has looked at yet, or the ask sheet is open. */
  glow: boolean;
}

/**
 * The amber edge stays from a new ask until the next touch, while something still needs the person (DK-08); on the
 * glance, the clock with its line and the screens a card opens, not in Talk, not on the dimmed glance of nobody there
 * (DK-97, CG-312).
 */
export function attention(o: {
  scene: DeskScene;
  lastInput: number;
  /** When the last new ask arrived by day (ms), or null. */
  alertAt: number | null;
  needsYou: number;
  sheetOpen: boolean;
}): Attention {
  const lit = o.scene === 'glance' || o.scene === 'clock' || isPage(o.scene);
  const unseen = o.alertAt !== null && o.alertAt > o.lastInput && o.needsYou > 0;
  return { glow: lit && (o.sheetOpen || unseen) };
}

/** A touch on these only wakes the screen (DK-09, DK-97): the night's clock, black, and the dimmed glance. */
export const wakesOnly = (scene: DeskScene): boolean =>
  scene === 'night' || scene === 'black' || scene === 'idle';

/**
 * The night's one line (DK-03's “all fine / something needs you”, the contracts' `status.allFine` and
 * `status.somethingNeedsYou`): never a title or a name; a server that is down, and anything that needs a look (DK-93),
 * needs the person too.
 */
export function nightLine(g: DeskGlance | null): 'fine' | 'needsYou' {
  if (!g) return 'fine';
  const looks = g.needsYou.looks?.length ?? 0;
  return g.needsYou.count > 0 || looks > 0 || g.servers.some((s) => s.state === 'bad') ? 'needsYou' : 'fine';
}

/**
 * Whether Talk follows on from the last one (DK-06: within 2 minutes of the thread's last change it continues the
 * thread). `lastTalkAt` is the page's last talk sent, answered or failed (CG-54): the answer changes the thread too.
 */
export const CONTINUE_MS = 2 * 60_000;
export function continueTalk(lastTalkAt: number | null, now: number, freshTopic: boolean): boolean {
  return !freshTopic && lastTalkAt !== null && now - lastTalkAt < CONTINUE_MS;
}

/**
 * An ask as a locked screen may show it: no detail, facts, button words or wider choices (the runtime's “Everything”,
 * DK-03; choices only unlocked, 0.116 TF-14).
 */
export const bareAsk = (a: DeskAsk): DeskAsk => ({
  ...a,
  detail: null,
  facts: [],
  approveLabel: null,
  choices: [],
});

/** Which buttons the ask sheet has: Close only (answered elsewhere), the phone line, a question's, an approval's. */
export type AskActions = 'gone' | 'phone' | 'question' | 'approval' | null;

export interface AskShown {
  /** The ask as the sheet may draw it now. */
  ask: DeskAsk;
  actions: AskActions;
  /** The Ask or Answer button (opens Talk about it). */
  talk: boolean;
}

/**
 * What the ask sheet shows (DK-03, DK-05; CG-50): an ask's detail, facts and buttons only while the screen is unlocked
 * now. Locked, the title and when and where (what “Everything” lets a locked screen show) beside the PIN pad, whatever
 * the page still holds; an ask that stays on the phone says so, one answered somewhere else has Close.
 */
export function askShown(ask: DeskAsk, o: { unlocked: boolean; gone: boolean; voice: boolean }): AskShown {
  const actions: AskActions = o.gone
    ? 'gone'
    : !ask.onDesk
      ? 'phone'
      : !o.unlocked
        ? null
        : ask.kind === 'question'
          ? 'question'
          : 'approval';
  return {
    ask: o.unlocked ? ask : bareAsk(ask),
    actions,
    talk: o.voice && (actions === 'question' || actions === 'approval'),
  };
}
