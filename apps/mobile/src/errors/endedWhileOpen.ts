/**
 * “The app ended while it was open, and no error of its JavaScript was noted”: what is left to say about an ending the
 * app's own code never saw. A crash in native code, iOS closing the app for the memory it used or for not answering,
 * and a frozen app the person swiped away all end it without a word; Apple's report of it, when there is one, comes a
 * day later (`diagnostics.ts`).
 *
 * A small file says the app is open: written when it comes to the foreground, again on a page change, a memory warning
 * and once a minute (so it says when the app was last alive), and removed when the app goes to the background. A file
 * still there at the next start is such an ending. While the app is only inactive (the app switcher, a system sheet,
 * Split View on a folding iPhone, where it stays on screen) the file stays and says since when, so an ending there
 * counts; a swipe-away from the app switcher is told apart by that mark only as “was inactive”, which the note says.
 *
 * The note claims no more than that: not that it was a crash, and “no memory warning” doesn't rule memory out.
 */
import type { AppErrorNote } from '@whombat/core';
import { ANDROID_EXIT_NAMES } from './androidExits';
import { DIAGNOSTIC_NAMES } from './diagnostics';
import type { NoteFile } from './errorNotes';

/** What the file holds. Times are ISO. */
export interface OpenMark {
  build: string;
  /** When it came to the foreground. */
  since: string;
  /** When the app last wrote it: it was alive then. */
  seen: string;
  /** The page on top (its route's name, never what it showed). */
  route: string | null;
  /** iOS warned about memory while it was open. */
  memoryWarning: boolean;
  /** Since when it was on screen without being the active app; null while active. */
  inactiveSince: string | null;
}

export const ENDED_WHILE_OPEN = 'EndedWhileOpen';

/** The endings noted after the fact, by a later run: never the explanation of another ending. */
const TOLD_LATER: ReadonlySet<string> = new Set([
  ENDED_WHILE_OPEN,
  ...Object.values(DIAGNOSTIC_NAMES),
  ...Object.values(ANDROID_EXIT_NAMES),
]);

const seconds = (from: string, to: string) =>
  Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000)) || 0;

/**
 * The note of a mark found at the start; null when a fatal error of this app's JavaScript was noted in that run (that
 * note says more), or the mark can't be read.
 */
export function noteOfLeftover(mark: OpenMark | null, pending: readonly AppErrorNote[]): AppErrorNote | null {
  if (!mark || Number.isNaN(Date.parse(mark.since)) || Number.isNaN(Date.parse(mark.seen))) return null;
  // Only an error of the app's own JavaScript in that run explains it. What iOS reports arrives late and is noted
  // with the time it arrived, about an ending of an earlier run: it says nothing about this one.
  const explained = pending.some(
    (n) => n.kind === 'app' && !TOLD_LATER.has(n.name ?? '') && Date.parse(n.at) >= Date.parse(mark.since),
  );
  if (explained) return null;
  const parts = [
    'The app ended while it was open and no JavaScript error was noted',
    `open for ${seconds(mark.since, mark.seen)} s`,
    `last seen alive ${mark.seen}`,
    mark.inactiveSince ? `inactive since ${mark.inactiveSince} (may have been swiped away)` : 'active',
    mark.memoryWarning ? 'iOS warned about memory' : 'no memory warning',
    `page ${mark.route ?? 'unknown'}`,
  ];
  return {
    at: mark.seen,
    build: mark.build.slice(0, 64),
    kind: 'app',
    name: ENDED_WHILE_OPEN,
    message: parts.join(' · ').slice(0, 1000),
    stack: [],
    components: null,
  };
}

export interface OpenMarker {
  /** The mark an earlier run left, taken once at the start (the file is this run's from then on). */
  leftover(): OpenMark | null;
  /** The app is the active one (again). */
  active(now: Date): void;
  /** On screen, not the active app. */
  inactive(now: Date): void;
  /** Gone to the background: an ending from here on is the system's ordinary one. */
  background(): void;
  /** Still alive; `route` when the page on top changed. */
  seen(now: Date, route?: string | null): void;
  memoryWarning(now: Date): void;
}

function readMark(file: NoteFile): OpenMark | null {
  try {
    const m = JSON.parse(file.read() ?? 'null') as Partial<OpenMark> | null;
    if (!m || typeof m.since !== 'string' || typeof m.seen !== 'string') return null;
    return {
      build: typeof m.build === 'string' ? m.build : '',
      since: m.since,
      seen: m.seen,
      route: typeof m.route === 'string' ? m.route : null,
      memoryWarning: m.memoryWarning === true,
      inactiveSince: typeof m.inactiveSince === 'string' ? m.inactiveSince : null,
    };
  } catch {
    return null;
  }
}

/** Every write is synchronous and its failure is swallowed: saying the app is open must never be what ends it. */
export function createOpenMarker(file: NoteFile, build: string): OpenMarker {
  let mark: OpenMark | null = null;
  let route: string | null = null;
  const save = () => {
    try {
      if (mark) file.write(JSON.stringify(mark));
      else file.remove();
    } catch {}
  };
  return {
    leftover() {
      const left = readMark(file);
      try {
        if (left) file.remove();
      } catch {}
      return left;
    },
    active(now) {
      const at = now.toISOString();
      mark = mark
        ? { ...mark, seen: at, inactiveSince: null }
        : { build, since: at, seen: at, route, memoryWarning: false, inactiveSince: null };
      save();
    },
    inactive(now) {
      if (!mark) return;
      const at = now.toISOString();
      mark = { ...mark, seen: at, inactiveSince: mark.inactiveSince ?? at };
      save();
    },
    background() {
      mark = null;
      save();
    },
    seen(now, next) {
      if (next !== undefined) route = next;
      if (!mark) return;
      mark = { ...mark, seen: now.toISOString(), route };
      save();
    },
    memoryWarning(now) {
      if (!mark) return;
      mark = { ...mark, seen: now.toISOString(), memoryWarning: true };
      save();
    },
  };
}
