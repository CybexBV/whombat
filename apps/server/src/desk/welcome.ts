/**
 * *Welcome back* (docs/decisions/desk-display.md DK-120…DK-122; desk-display-server.md DK-S127…DK-S131): when someone
 * comes back to the screen after at least `DESK_WELCOME_AWAY_S` away — a face the camera sees, or a touch — the screen
 * starts with what happened meanwhile: a question waiting first, what the assistant finished, what went down, came back
 * or got worse. It shows for `DESK_WELCOME_SHOW_S`, or until a touch after it showed, once.
 *
 * What went down or came back is what this runtime saw in its own glance reads (`DeskLookLog`), so it knows only what
 * happened since it started; when someone was last there it keeps in memory too, and after a start it waits for a first
 * face or touch before it counts anyone away (a restart while someone sits there isn't a return).
 */
import { randomBytes } from 'node:crypto';
import {
  DESK_DIGEST_ITEMS,
  DESK_WELCOME_AWAY_S,
  DESK_WELCOME_SHOW_S,
  DESK_WORDS,
  type DeskCalmView,
  type DeskDigest,
  type DeskDigestItem,
  fillDeskWords,
} from '@whombat/core';
import { screenText } from './glance';
import type { DeskLook } from './shapes';

/* What changed while the runtime watched -------------------------------------------------------------------------- */

/** A look that began, got worse or went (`up`), when the runtime saw it. */
export interface LookChange {
  key: string;
  icon: 'down' | 'up' | 'look';
  text: string;
  server?: string;
  at: number;
}

/** A night away and then some, and never more than this many changes. */
export const LOOK_LOG_KEEP_MS = 24 * 3_600_000;
const LOOK_LOG_MAX = 100;

const RANK: Record<DeskLook['state'], number> = { down: 0, bad: 1, look: 2 };

type Seen = Pick<DeskLook, 'key' | 'name' | 'state' | 'server'>;

function changeOf(look: Seen, at: number): LookChange {
  const w = DESK_WORDS.calm.welcome;
  const words = look.state === 'down' ? w.down : look.state === 'bad' ? w.trouble : w.look;
  return {
    key: look.key,
    icon: look.state === 'look' ? 'look' : 'down',
    text: screenText(fillDeskWords(words, { name: look.name }), 120),
    ...(look.server ? { server: look.server } : {}),
    at,
  };
}

/**
 * The looks as the runtime saw them from one glance read to the next: when each began (the hero's “Since 14:30”,
 * DK-113) and what changed (*Welcome back*'s down, up and worse). The first read is where it starts: nothing before it
 * counts as a change. A look whose subject wasn't read this time (its read failed) stays as it was.
 */
export class DeskLookLog {
  #last: Map<string, Seen> | null = null;
  readonly #began = new Map<string, number>();
  #changes: LookChange[] = [];

  /** One glance read's looks at `at`; `keys` everything that read saw, fine or not. */
  observe(looks: readonly Seen[], keys: readonly string[], at: number): void {
    const now = new Map(looks.map((l) => [l.key, l]));
    const last = this.#last;
    this.#last = now;
    if (!last) return;
    const read = new Set(keys);
    for (const look of looks) {
      const before = last.get(look.key);
      if (!before) this.#began.set(look.key, at);
      if (!before || RANK[look.state] < RANK[before.state]) this.#changes.push(changeOf(look, at));
    }
    for (const [key, before] of last) {
      if (now.has(key)) continue;
      if (!read.has(key)) {
        // Not read this time: as it was, until a read says otherwise.
        now.set(key, before);
        continue;
      }
      this.#began.delete(key);
      this.#changes.push({
        key,
        icon: 'up',
        text: screenText(fillDeskWords(DESK_WORDS.calm.welcome.up, { name: before.name }), 120),
        ...(before.server ? { server: before.server } : {}),
        at,
      });
    }
    this.#changes = this.#changes.filter((c) => at - c.at < LOOK_LOG_KEEP_MS).slice(-LOOK_LOG_MAX);
  }

  /** When the runtime saw the look begin, or undefined (it was there at the first read). */
  since(key: string): string | undefined {
    const at = this.#began.get(key);
    return at === undefined ? undefined : new Date(at).toISOString();
  }

  /** What changed from `from` on: the latest change of each look, oldest first. */
  changesSince(from: number): LookChange[] {
    const latest = new Map<string, LookChange>();
    for (const c of this.#changes) if (c.at >= from) latest.set(c.key, c);
    return [...latest.values()].sort((a, b) => a.at - b.at);
  }

  forget(): void {
    this.#last = null;
    this.#began.clear();
    this.#changes = [];
  }
}

/* Welcome back ---------------------------------------------------------------------------------------------------- */

/** What a digest says, read when the state is made. */
export interface WelcomeFacts {
  assistant: string;
  asks: readonly { number: number; title: string }[];
  askCount: number;
  /** What the assistant finished, newest first. */
  recent: readonly { text: string; at: string }[];
  /** What changed since `from` (`DeskLookLog.changesSince`). */
  changes: (from: number) => readonly LookChange[];
}

/** Rows of what changed at most, so a busy morning's done things don't push them out. */
const CHANGE_ROWS = 3;

const iso = (at: number | string) => new Date(at).toISOString();

/**
 * The digest's rows (DK-120, DK-122): the first question waiting (with its words only in `everything`; else counted),
 * what the assistant finished since `from` (each by its words in `everything` where they fit, else counted), then
 * what went down, came back or got worse. At most `DESK_DIGEST_ITEMS`.
 */
export function welcomeItems(facts: WelcomeFacts, from: number, view: DeskCalmView): DeskDigestItem[] {
  const w = DESK_WORDS.calm.welcome;
  const a = { assistant: facts.assistant };
  const items: DeskDigestItem[] = [];
  const first = facts.asks[0];
  if (facts.askCount > 0) {
    const text =
      view === 'everything' && first
        ? fillDeskWords(w.asks, { ...a, title: first.title })
        : facts.askCount === 1
          ? fillDeskWords(w.askOne, a)
          : fillDeskWords(w.asksCount, { n: facts.askCount });
    items.push({ icon: 'ask', text: screenText(text, 120), ...(first ? { ask: first.number } : {}) });
  }
  const done = facts.recent.filter((d) => Date.parse(d.at) >= from).reverse();
  const changes = facts.changes(from).slice(-CHANGE_ROWS);
  const room = DESK_DIGEST_ITEMS - items.length - changes.length;
  if (view === 'everything' && done.length > 0 && done.length <= room)
    items.push(...done.map((d) => ({ icon: 'done' as const, text: screenText(d.text, 120), at: iso(d.at) })));
  else if (done.length > 0)
    items.push({
      icon: 'done',
      text: screenText(
        done.length === 1
          ? fillDeskWords(w.doneOne, a)
          : fillDeskWords(w.doneCount, { ...a, n: done.length }),
        120,
      ),
    });
  for (const c of changes)
    items.push({
      icon: c.icon,
      text: c.text,
      at: iso(c.at),
      // A look that went has no card to open; its server still has its screen.
      ...(c.icon !== 'up' ? { look: screenText(c.key, 120) } : {}),
      ...(c.server ? { server: c.server } : {}),
    });
  return items.filter((i) => i.text).slice(0, DESK_DIGEST_ITEMS);
}

/** Someone came back, or the digest showing for it. */
interface Held {
  id: string;
  awayS: number;
  /** When they were last there before, and when they came back. */
  from: number;
  at: number;
  /** When the screen first got it to draw (not in *Only the time*); a touch after that ends it. */
  shownAt: number | null;
}

/** When someone was last at the screen and the *Welcome back* it owes them (DK-120, DK-121). */
export class DeskWelcome {
  #lastAt: number | null = null;
  #back: { from: number; at: number } | null = null;
  #held: Held | null = null;

  constructor(private readonly newId: () => string = () => randomBytes(12).toString('base64url')) {}

  /** Someone is at the screen at `now`: a face (`touch` false) or a touch. A touch after a digest showed ends it. */
  here(now: number, touch: boolean): void {
    if (touch && this.#held?.shownAt != null && now > this.#held.shownAt) this.#held = null;
    if (this.#lastAt !== null && now - this.#lastAt >= DESK_WELCOME_AWAY_S * 1_000) {
      this.#back = { from: this.#lastAt, at: now };
      this.#held = null;
    }
    this.#lastAt = Math.max(this.#lastAt ?? now, now);
  }

  /**
   * The digest for the screen now: made at the first state after someone came back (when *Welcome back* is on and there
   * is something to say), its rows read again for the lock at each state (`view`), gone `DESK_WELCOME_SHOW_S` after
   * the return or at a touch after it showed.
   */
  digest(now: number, view: DeskCalmView, on: boolean, facts: () => WelcomeFacts): DeskDigest | null {
    const back = this.#back;
    if (back) {
      this.#back = null;
      const away = Math.round((back.at - back.from) / 1_000);
      if (on && welcomeItems(facts(), back.from, 'everything').length > 0)
        this.#held = { id: this.newId(), awayS: Math.min(away, 31_536_000), ...back, shownAt: null };
    }
    const held = this.#held;
    if (!held) return null;
    if (!on || now - held.at >= DESK_WELCOME_SHOW_S * 1_000) {
      this.#held = null;
      return null;
    }
    const items = welcomeItems(facts(), held.from, view);
    if (items.length === 0) return null;
    if (view !== 'time') held.shownAt ??= now;
    return { id: held.id, awayS: held.awayS, items };
  }

  /** A new pairing: nobody has been here yet. */
  forget(): void {
    this.#lastAt = null;
    this.#back = null;
    this.#held = null;
  }
}
