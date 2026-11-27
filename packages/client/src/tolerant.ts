/**
 * Tolerant decoding for the screens (AP-255, updates.md UP-B3b): every answer and event a client reads goes through
 * contracts' `decodeTolerant`, so a runtime one or two releases newer — a new card kind, work item kind, role, event
 * type or update state — leaves out only what this app doesn't know, never the whole screen. Two things the screens
 * show in place of what was left out:
 *
 * - a message's card of an unknown kind becomes `UNSUPPORTED_CARD`, a neutral pill “This needs a newer version of the
 *   app.” (a valid card: every renderer, web and phone, shows it without knowing about this);
 * - items left out of an `items` list (Work sections, inbox sections) are counted on the object that holds the list
 *   (`unsupportedItems`), so the list shows a placeholder row for each and keeps the rest.
 *
 * Whatever else is left out (an agent with an unknown role, an activity row of an unknown kind) is simply not shown.
 */
import {
  REALTIME_EVENT_TOPICS,
  type RealtimeEvent,
  RealtimeEvent as RealtimeEventSchema,
  resolveLanguage,
} from '@whombat/core';
import { decodeTolerant, type SkippedItem } from '@whombat/protocol/session';
import type { z } from 'zod';

/** What a screen shows for something only a newer app can show. */
export const NEEDS_NEWER_APP = 'This needs a newer version of the app.';

export function needsNewerAppText(locale?: string | null): string {
  return resolveLanguage(locale) === 'nl'
    ? 'Hiervoor heb je een nieuwere versie van de app nodig.'
    : NEEDS_NEWER_APP;
}

/** A screen whose answer a security view reads strictly didn't match (AP-266): the way out. */
export const SCREEN_NEEDS_NEWER_APP =
  'This needs a newer version of the app. Reload to get the newest version.';

export function screenNeedsNewerAppText(locale?: string | null): string {
  return resolveLanguage(locale) === 'nl'
    ? 'Hiervoor heb je een nieuwere versie van de app nodig. Herlaad om de nieuwste versie te openen.'
    : SCREEN_NEEDS_NEWER_APP;
}

/** “1 item needs a newer version of the app.”, “3 items need …” (AP-266). */
export function itemsNeedNewerApp(n: number, locale?: string | null): string {
  if (resolveLanguage(locale) === 'nl') {
    return n === 1
      ? 'Voor 1 item heb je een nieuwere versie van de app nodig.'
      : `Voor ${n} items heb je een nieuwere versie van de app nodig.`;
  }
  return n === 1 ? '1 item needs a newer version of the app.' : `${n} items need a newer version of the app.`;
}

/** Part of what's on screen didn't match strictly (AP-266). */
export const PART_NEEDS_NEWER_APP = 'Part of this page needs a newer version of the app.';

export function partNeedsNewerAppText(locale?: string | null): string {
  return resolveLanguage(locale) === 'nl'
    ? 'Voor een deel van deze pagina heb je een nieuwere versie van de app nodig.'
    : PART_NEEDS_NEWER_APP;
}

/** The card a message gets in place of one of a kind this app doesn't know. */
export const UNSUPPORTED_CARD = {
  kind: 'pill',
  text: NEEDS_NEWER_APP,
  tone: 'neutral',
  unsupported: true,
} as const;

/** Whether a card is the placeholder of one this app doesn't know. */
export function isUnsupportedCard(
  card: { kind: string; text?: unknown; unsupported?: unknown } | null | undefined,
): boolean {
  return card?.kind === 'pill' && (card.unsupported === true || card.text === NEEDS_NEWER_APP);
}

/**
 * Where a list's left-out items are counted: an own, enumerable member of the object holding the list, so it survives
 * spreads and the query cache's structural sharing; read it with `unsupportedItems`.
 */
const UNSUPPORTED_ITEMS = '__unsupportedItems';

/** How many items of an `items` list held by `holder` this app left out (placeholder rows to show). */
export function unsupportedItems(holder: object | null | undefined): number {
  const n = (holder as Record<string, unknown> | null | undefined)?.[UNSUPPORTED_ITEMS];
  return typeof n === 'number' ? n : 0;
}

export type UiDecodeResult<T> =
  | { ok: true; data: T; skipped: SkippedItem[] }
  | { ok: false; error: z.ZodError };

/** `decodeTolerant`, then the placeholders above in the decoded value. */
export function decodeForUi<S extends z.ZodType>(schema: S, value: unknown): UiDecodeResult<z.output<S>> {
  const r = decodeTolerant(schema, value);
  if (!r.ok || r.skipped.length === 0) return r;
  placeholders(r.data, r.skipped);
  return r;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * The object at `path` (a path into the value before the repairs) in the decoded value: list indexes move down by the
 * items dropped before them in the same list. Null when it is gone (inside a dropped item) or not an object.
 */
function locate(root: unknown, path: readonly (string | number)[], drops: SkippedItem[]): unknown {
  let at: unknown = root;
  for (let i = 0; i < path.length; i++) {
    const k = path[i] as string | number;
    if (Array.isArray(at) && typeof k === 'number') {
      const list = path.slice(0, i);
      let shift = 0;
      for (const d of drops) {
        if (d.path.length !== i + 1 || !list.every((s, j) => s === d.path[j])) continue;
        const j = d.path[i] as number;
        if (j === k) return null;
        if (j < k) shift++;
      }
      at = at[k - shift];
    } else if (isObject(at)) at = at[k as string];
    else return null;
  }
  return at;
}

function placeholders(data: unknown, skipped: SkippedItem[]): void {
  const drops = skipped.filter((s) => s.action === 'dropped');
  for (const s of skipped) {
    const key = s.path.at(-1);
    if (s.action === 'nulled' && key === 'card') {
      const message = locate(data, s.path.slice(0, -1), drops);
      if (isObject(message) && message.card === null) message.card = { ...UNSUPPORTED_CARD };
      continue;
    }
    if (s.action === 'dropped' && s.path.at(-2) === 'items') {
      const holder = locate(data, s.path.slice(0, -2), drops);
      if (isObject(holder) && !Array.isArray(holder))
        holder[UNSUPPORTED_ITEMS] = unsupportedItems(holder) + 1;
    }
  }
}

/* What was left out, for the screens' notice (AP-266) ----------------------------------------------------- */

/**
 * What the answers on screen left out: list items only a newer app can show (`items`, “1 item needs a newer version
 * of the app.”) and whether a strictly decoded answer (`strict.ts`) didn't match (`needsNewer`). Each source (an
 * endpoint with its parameters, a session op) counts its latest answer only, so a list that reads fine again stops
 * counting. The app shows it in its notice strip, so nothing is left out silently anywhere; lists that show their own
 * placeholder rows (the work overview, the inbox) and cards (the placeholder pill) aren't counted.
 */
export interface LeftOut {
  items: number;
  needsNewer: boolean;
}

const hiddenBySource = new Map<string, number>();
const strictFailures = new Set<string>();
const leftOutListeners = new Set<() => void>();
let leftOutNow: LeftOut = { items: 0, needsNewer: false };

function publishLeftOut() {
  let items = 0;
  for (const n of hiddenBySource.values()) items += n;
  const needsNewer = strictFailures.size > 0;
  if (items === leftOutNow.items && needsNewer === leftOutNow.needsNewer) return;
  leftOutNow = { items, needsNewer };
  for (const l of [...leftOutListeners]) l();
}

export const leftOut = {
  get: (): LeftOut => leftOutNow,
  subscribe(listener: () => void): () => void {
    leftOutListeners.add(listener);
    return () => {
      leftOutListeners.delete(listener);
    };
  },
  /**
   * Leaving the screen that asked (AP-701): a security view it couldn't read is that screen's, so the notice goes with
   * it (a screen opened again asks again). Left-out list items keep counting until their list reads whole.
   */
  clearStrict() {
    if (strictFailures.size === 0) return;
    strictFailures.clear();
    publishLeftOut();
  },
  /** Leaving a Whombat: nothing it sent counts any more. */
  reset() {
    hiddenBySource.clear();
    strictFailures.clear();
    publishLeftOut();
  },
};

/**
 * A tolerantly decoded answer from `source`: how many list items it left out (0 clears the source). A source that starts
 * leaving items out says which and why in the console once (where, and the value this app doesn't know), so the notice
 * can be traced to its answer.
 */
export function noteSkipped(source: string, skipped: readonly SkippedItem[]): void {
  const dropped = skipped.filter((s) => s.action === 'dropped');
  const n = dropped.length;
  if (n > 0) {
    if (hiddenBySource.get(source) !== n)
      console.warn(
        `whombat: left out ${n} item${n === 1 ? '' : 's'} of ${source} this app can't read`,
        dropped.map((s) => `${s.path.join('.')} = ${JSON.stringify(s.value)}`),
      );
    hiddenBySource.set(source, n);
  } else if (!hiddenBySource.delete(source)) return;
  publishLeftOut();
}

/** A strictly decoded answer from `source`: whether it didn't match. */
export function noteStrict(source: string, failed: boolean): void {
  if (failed) {
    if (strictFailures.has(source)) return;
    strictFailures.add(source);
  } else if (!strictFailures.delete(source)) return;
  publishLeftOut();
}

/* Realtime --------------------------------------------------------------------------------------------- */

export type EventDecode =
  | { kind: 'event'; event: RealtimeEvent }
  /** An event type only a newer app knows: skipped quietly (nothing here shows it). */
  | { kind: 'unknown'; type: string }
  /** Not an event at all, or a known type that doesn't match even tolerantly. */
  | { kind: 'invalid' };

const KNOWN_EVENT_TYPES = new Set(Object.keys(REALTIME_EVENT_TOPICS));

/** One realtime event of a session subscription, tolerantly. */
export function decodeRealtimeEvent(value: unknown): EventDecode {
  const type = isObject(value) ? value.type : undefined;
  if (typeof type !== 'string') return { kind: 'invalid' };
  if (!KNOWN_EVENT_TYPES.has(type)) return { kind: 'unknown', type };
  const r = decodeForUi(RealtimeEventSchema, value);
  return r.ok ? { kind: 'event', event: r.data } : { kind: 'invalid' };
}
