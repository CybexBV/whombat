/**
 * A tablet's or computer's screen page (Whombat desk-display.md DK-133, DK-135, DK-138, DK-146): the pure parts — the
 * words, what it calls itself, how often it asks for its state, which page shows, what the modal shows and whether it
 * was removed — tested without a page.
 */
import {
  DESK_FIRST_PAGE_AFTER_S,
  DESK_TURN_S,
  type DeskAttentionItem,
  type DeskTurn,
  fillDeskWords,
  type ScreenState,
} from '@whombat/client/desk';
import { OperationError } from '@whombat/client/session';

export const SCREEN_MODE_TEXT = {
  way: 'Show Whombat on this device, for everyone who walks past.',
  use: 'Use as a screen',
  on: 'Whombat on this {device}',
  title: 'Use as a screen',
  steps: 'In Whombat on your computer or phone, go to Settings → Screens → Add a screen and type:',
  works: 'Works for {minutes} minutes',
  expired: 'Those letters ran out.',
  again: 'Show new letters',
  back: 'Not now',
  failed: 'Whombat didn’t answer. Trying again…',
  online: 'Online',
  offline: 'Offline',
  locked: 'Locked',
  unlocked: 'Unlocked',
  lock: 'Lock',
  unlock: 'Unlock',
  fullscreen: 'Full screen',
  exitFullscreen: 'Leave full screen',
  pin: 'Type the PIN to unlock',
  pinWrong: 'That’s not the PIN. {n} tries left.',
  pinWait: 'Too many tries. Try again at {time}.',
  noPin: 'Choose a PIN in Settings → Screens on your phone or computer to unlock screens by touch.',
  cancel: 'Cancel',
  delete: 'Delete',
  answerElsewhere: 'Answer on your phone or at the box.',
  lookElsewhere: 'Take a look on your phone or at the box.',
  notNow: 'Not now',
  of: '{n} of {total}',
  previous: 'Previous',
  next: 'Next',
  removed: 'This device isn’t a screen any more.',
  page: 'Page {name}',
} as const;

/** How the device calls itself in the letters' title: “tablet”, “phone”, “computer”. */
export function deviceKind(ua: string, touch: boolean): 'tablet' | 'phone' | 'computer' {
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch) || (/Android/.test(ua) && !/Mobile/.test(ua)))
    return 'tablet';
  if (/iPhone|Android.*Mobile|Mobile/.test(ua)) return 'phone';
  return 'computer';
}

/**
 * The endpoint's label for this device: “Safari on iPad”, “Chrome on Mac”, as every endpoint's; the runtime shows it in
 * Settings → Screens as “iPad · Safari”.
 */
export function screenDeviceLabel(ua: string, touch = false): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\/|CriOS\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const device = /iPad/.test(ua)
    ? 'iPad'
    : /iPhone/.test(ua)
      ? 'iPhone'
      : /Macintosh/.test(ua) && touch
        ? 'iPad'
        : /Android/.test(ua)
          ? /Mobile/.test(ua)
            ? 'Android phone'
            : 'Android tablet'
          : /Mac OS X/.test(ua)
            ? 'Mac'
            : /Windows/.test(ua)
              ? 'Windows'
              : /CrOS/.test(ua)
                ? 'Chromebook'
                : /Linux/.test(ua)
                  ? 'Linux'
                  : 'Computer';
  return `${browser} on ${device}`;
}

/** The six letters as the screen shows them: “KTR·MWP”. */
export function lettersShown(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)}·${code.slice(3)}` : code;
}

/** How often a device waiting for its letters to be typed asks (the unenrolled budget is 20 requests a minute). */
export const STATUS_POLL_MS = 5_000;

/** How long until the next `screen.state`: every 10 s, every 3 s for two minutes after a touch. */
export const POLL_MS = 10_000;
export const POLL_TOUCHED_MS = 3_000;
export function pollDelay(now: number, touchedAt: number | null): number {
  return touchedAt !== null && now - touchedAt < DESK_FIRST_PAGE_AFTER_S * 1000 ? POLL_TOUCHED_MS : POLL_MS;
}

/**
 * The page a screen shows (DK-133): turning by itself every 30 s or minute (waiting while touched), and a screen that
 * turns when touched back on its first page after two minutes untouched.
 */
export function pageAt(input: {
  page: number;
  pages: number;
  turn: DeskTurn;
  /** When the page last changed (a touch, or a turn). */
  since: number;
  touchedAt: number | null;
  now: number;
}): number {
  const { page, pages, turn, since, touchedAt, now } = input;
  if (pages <= 1) return 0;
  const every = DESK_TURN_S[turn];
  if (every === null) {
    const idle = touchedAt === null ? now - since : now - Math.max(touchedAt, since);
    return idle >= DESK_FIRST_PAGE_AFTER_S * 1000 ? 0 : Math.min(page, pages - 1);
  }
  // Someone touched it within the last turn: it waits.
  if (touchedAt !== null && now - touchedAt < every * 1000) return Math.min(page, pages - 1);
  return now - since >= every * 1000 ? (page + 1) % pages : Math.min(page, pages - 1);
}

/** What the modal shows (DK-135): what pops and hasn't been put away, in order; the pill opens all of it. */
export function modalItems(
  items: readonly DeskAttentionItem[],
  away: ReadonlySet<string>,
  all: boolean,
): DeskAttentionItem[] {
  return all ? [...items] : items.filter((i) => i.pops && !away.has(i.key));
}

/** The pill's words (DK-136): “1 thing needs you”, “3 things need you”. */
export function pillText(count: number, words: { one: string; many: string }): string {
  return count === 1 ? words.one : fillDeskWords(words.many, { n: count });
}

/**
 * The assistant's name for the drawing (“Dusty did 3 things today”): `screen.state` doesn't carry it, so it's read from
 * what does — a question's item names it, the assistant's work is “{name}’s work” — else “Whombat”.
 */
export function assistantOf(state: Pick<ScreenState, 'grid' | 'assistant'>): string {
  if (state.assistant) return state.assistant;
  // An older runtime doesn't say: a question or the assistant's work names it.
  const ask = state.grid?.attention.items.find((i) => i.kind === 'ask' && i.name);
  if (ask?.name) return ask.name;
  const work = state.grid?.views.find((v) => /’s work$/.test(v.title));
  return work ? work.title.replace(/’s work$/, '') : 'Whombat';
}

/**
 * Whether an unlocked screen should lock itself now (DK-138): two minutes untouched. The runtime counts every
 * `screen.state` as use, so the page locks it.
 */
export function relockDue(now: number, touchedAt: number | null, unlockedAt: number | null): boolean {
  if (unlockedAt === null) return false;
  const last = Math.max(unlockedAt, touchedAt ?? 0);
  return now - last >= DESK_FIRST_PAGE_AFTER_S * 1000;
}

/** Whether an answer says this device isn't a screen any more (removed in Settings, its endpoint revoked). */
export function screenRemoved(error: unknown): boolean {
  return (
    error instanceof OperationError &&
    (error.code === 'revoked' || error.code === 'enrollment_required' || error.code === 'unknown_op')
  );
}
