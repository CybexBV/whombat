/**
 * The burrows on the console of a claimed box (appliance CG-08, contracts CT-116; managed-runtime MR-78): the
 * oldest live burrow's name and how many others there are, in the console file's `burrows`. Local only: this is read
 * from the database and written to the console file, never sent to control, the relay or a log.
 *
 * A burrow name is user input (`BurrowName`: any text, up to 80 characters); the console file takes
 * `ConsoleDisplayText` (1–64 code points, no control, format or separator characters but U+0020, no space at either
 * end). `consoleDisplayName` makes one from the other, and a name with nothing left leaves `burrows` out.
 */
import {
  CONSOLE_DISPLAY_TEXT_MAX,
  type ConsoleBurrows,
  ConsoleDisplayText,
} from '@whombat/control-contracts/local';
import { asc, count } from 'drizzle-orm';
import type { Db } from '../db/client';
import { burrows } from '../db/schema/index';
import type { BusFrame } from '../realtime/bus';

/** `ConsoleBurrows.more`'s ceiling. */
export const CONSOLE_BURROWS_MORE_MAX = 9999;

/** Line breaks, tabs and every separator (U+00A0, U+2028, U+3000, …) become a plain space. */
const SPACES = /[\t\n\v\f\r\u0085\p{Z}]+/gu;
/** What the console file refuses and has no place in a name: controls, format characters (bidi, zero-width), surrogates. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}]/gu;

/**
 * A burrow name as the console may show it (`ConsoleDisplayText`), or null when nothing is left: separators become
 * one space, controls and format characters go, the ends are trimmed, and a name over 64 code points is cut to 63
 * plus “…”.
 */
export function consoleDisplayName(name: string): string | null {
  let text = name.normalize('NFC').replace(SPACES, ' ').replace(INVISIBLE, '').replace(/ {2,}/g, ' ').trim();
  const points = Array.from(text);
  if (points.length > CONSOLE_DISPLAY_TEXT_MAX)
    text = `${points
      .slice(0, CONSOLE_DISPLAY_TEXT_MAX - 1)
      .join('')
      .trimEnd()}…`;
  return ConsoleDisplayText.safeParse(text).success ? text : null;
}

/**
 * `burrows` from the oldest burrow's name and the number of burrows; undefined when there is none or its name has
 * nothing to show.
 */
export function consoleBurrows(oldest: string | null, total: number): ConsoleBurrows | undefined {
  if (oldest === null || total < 1) return undefined;
  const first = consoleDisplayName(oldest);
  if (first === null) return undefined;
  return { first, more: Math.min(total - 1, CONSOLE_BURROWS_MORE_MAX) };
}

/** Signed events that change which burrows exist or what they are called. */
const BURROW_EVENTS: ReadonlySet<string> = new Set([
  'burrow.created',
  'burrow.renamed',
  'burrow.deleted',
  'burrow.archived',
  'burrow.restored',
]);

/** A committed frame after which the console's burrows may have changed (a burrow created, renamed or removed). */
export function changesBurrows(frame: BusFrame): boolean {
  const event = frame.event;
  if (event.type === 'burrow.updated') return true;
  return event.type === 'audit.appended' && BURROW_EVENTS.has(event.event.type);
}

/**
 * A committed frame after which the box's own name may have changed (`loadOwnName`: the name the person's app gave the
 * screen, else the oldest burrow's).
 */
export function namesTheBox(frame: BusFrame): boolean {
  const event = frame.event;
  if (event.type === 'burrow.updated') return true;
  return (
    event.type === 'audit.appended' &&
    (BURROW_EVENTS.has(event.event.type) || event.event.type === 'desk.named')
  );
}

/**
 * The console's burrows from the database: every row of `burrows` is live (a burrow is never archived or deleted
 * today), the oldest first (creation time, then id).
 */
export async function loadConsoleBurrows(db: Db): Promise<ConsoleBurrows | undefined> {
  const [oldest] = await db
    .select({ name: burrows.name })
    .from(burrows)
    .orderBy(asc(burrows.createdAt), asc(burrows.id))
    .limit(1);
  if (!oldest) return undefined;
  const [row] = await db.select({ n: count() }).from(burrows);
  return consoleBurrows(oldest.name, row?.n ?? 1);
}
