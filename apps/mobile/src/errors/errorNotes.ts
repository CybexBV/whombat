/**
 * The errors that stopped this app, or one of its pages, kept until the app can tell its Whombat. An error in the app's
 * JavaScript ends the app on purpose, and the crash report Apple or Google keep then names neither the error nor where
 * it was, so nobody can find the cause. The app writes the error down the moment it happens (the app is gone a moment
 * later, so the write is synchronous) and sends it the next time a session opens; the box writes it into its log.
 *
 * `kind: 'app'` is an ending of the app: an error in its JavaScript, or one the next start found out about
 * (`endedWhileOpen.ts`, `diagnostics.ts`). `kind: 'page'` is everything the app went on after: a page that showed
 * “This page didn’t load”, and the quiet errors nobody saw (`noteOfQuiet`: a promise nobody caught, a listener that
 * threw). `name` says which.
 *
 * What is kept is the error's own words and where in the code it was: never what was on screen.
 */
import { APP_ERROR_NOTES_MAX, AppErrorNote } from '@whombat/core';

/** What React Native hands the app about an error before it reports it (its `ExceptionData`). */
export interface ReportedError {
  message: string;
  originalMessage?: string | null;
  name?: string | null;
  componentStack?: string | null;
  stack?: readonly {
    methodName?: string | null;
    file?: string | null;
    lineNumber?: number | null;
    column?: number | null;
  }[];
  isFatal: boolean;
}

/** Where the notes are kept: a file the app reads and writes synchronously. */
export interface NoteFile {
  read(): string | null;
  write(text: string): void;
  remove(): void;
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function frameLine(f: NonNullable<ReportedError['stack']>[number]): string {
  const where = [f.file ? f.file.split('/').pop() : null, f.lineNumber, f.column]
    .filter((v) => v != null)
    .join(':');
  return cut(`${f.methodName || '?'}${where ? ` ${where}` : ''}`, 300);
}

/** Innermost first, at most this many lines: the frames past the first few seldom help. */
const STACK_LINES = 20;

/** A note of an error React Native is about to report. */
export function noteOfReported(
  error: ReportedError,
  input: { build: string; at: Date; kind: AppErrorNote['kind'] },
): AppErrorNote {
  // `message` has the components appended to it; the error's own words are `originalMessage` then.
  const message = error.originalMessage ?? error.message;
  return {
    at: input.at.toISOString(),
    build: cut(input.build, 64),
    kind: input.kind,
    name: error.name ? cut(error.name, 100) : null,
    message: cut(message || 'No message', 1000),
    stack: (error.stack ?? []).slice(0, STACK_LINES).map(frameLine),
    components: error.componentStack ? cut(componentLines(error.componentStack), 2000) : null,
  };
}

/** A note of an error a page caught (it showed “This page didn’t load” instead). */
export function noteOfCaught(
  error: unknown,
  componentStack: string | null | undefined,
  input: { build: string; at: Date },
): AppErrorNote {
  const e = error instanceof Error ? error : null;
  return {
    at: input.at.toISOString(),
    build: cut(input.build, 64),
    kind: 'page',
    name: e?.name ? cut(e.name, 100) : null,
    message: cut((e ? e.message : String(error)) || 'No message', 1000),
    stack: stackLines(e),
    components: componentStack ? cut(componentLines(componentStack), 2000) : null,
  };
}

/**
 * An error's own stack, innermost first, without the line that repeats its name and words; a file is its name only,
 * as in `frameLine` (the folders before it are the phone's, and say nothing about the code).
 */
function stackLines(e: Error | null): string[] {
  return (e?.stack ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== `${e?.name}: ${e?.message}`)
    .slice(0, STACK_LINES)
    .map((l) => cut(l.replace(/[^\s(]*\//g, ''), 300));
}

/** What a quiet error is noted as. */
export const QUIET_NAMES = {
  /** A promise that failed and nobody caught. */
  rejection: 'UnhandledRejection',
  /** A listener of the session that threw (`@whombat/client/session` `onListenerError`). */
  listener: 'ListenerError',
} as const;

/**
 * A note of an error the app went on after without anyone seeing it. `name` is what kind of quiet error it was and the
 * error's own name leads its words, with `where` (which listener) before it when there is one.
 */
export function noteOfQuiet(
  error: unknown,
  input: { build: string; at: Date; name: string; where?: string },
): AppErrorNote {
  const e = error instanceof Error ? error : null;
  const words = e ? `${e.name}: ${e.message}` : describe(error);
  return {
    at: input.at.toISOString(),
    build: cut(input.build, 64),
    kind: 'page',
    name: cut(input.name, 100),
    message: cut(`${input.where ? `${input.where}: ` : ''}${words}` || 'No message', 1000),
    stack: stackLines(e),
    components: null,
  };
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** `\n    in Foo (at …)\n    in Bar` → `Foo < Bar`, the components only. */
function componentLines(stack: string): string {
  const names = stack
    .split('\n')
    .map((l) => l.trim().replace(/^(in|at)\s+/, ''))
    .map((l) => l.split(/[\s(@]/)[0] ?? '')
    .filter(Boolean);
  return names.length ? names.join(' < ') : stack.trim();
}

export interface ErrorNotes {
  /**
   * Writes it down at once (the app may be gone a moment later). The same error is noted once while the app runs
   * (React Native may report one error twice, a page may fail again on Try again), and a note the box would refuse
   * isn't kept: one refused note would hold back every note after it. The newest notes stay, an ending of the app
   * before anything else (`keepNewest`). False when it wasn't kept.
   */
  add(note: AppErrorNote): boolean;
  pending(): readonly AppErrorNote[];
  /** These reached the box: they go from the file. */
  delivered(notes: readonly AppErrorNote[]): void;
  /** Called after each `add`. */
  onAdd(listener: () => void): () => void;
}

/** The same error again: its kind, name, words and innermost frame. */
const signature = (n: AppErrorNote) => [n.kind, n.name, n.message, n.stack[0] ?? ''].join('\n');

/**
 * At most `max` notes, the newest kept; a note of something the app went on after never pushes out an ending of the
 * app, which is what whoever reads them is looking for.
 */
export function keepNewest(
  notes: readonly AppErrorNote[],
  max: number = APP_ERROR_NOTES_MAX,
): AppErrorNote[] {
  const kept = [...notes];
  while (kept.length > max) {
    const quiet = kept.findIndex((n) => n.kind !== 'app');
    kept.splice(quiet === -1 ? 0 : quiet, 1);
  }
  return kept;
}

export function createErrorNotes(file: NoteFile): ErrorNotes {
  let notes: AppErrorNote[] | null = null;
  const listeners = new Set<() => void>();
  const noted = new Set<string>();
  const load = (): AppErrorNote[] => {
    if (notes) return notes;
    try {
      const parsed: unknown = JSON.parse(file.read() ?? '[]');
      // Only what the box takes: a note it refuses would be sent, and refused, for ever.
      notes = Array.isArray(parsed)
        ? parsed.flatMap((n) => {
            const note = AppErrorNote.safeParse(n);
            return note.success ? [note.data] : [];
          })
        : [];
    } catch {
      notes = [];
    }
    return notes;
  };
  const save = () => {
    try {
      if (notes?.length) file.write(JSON.stringify(notes));
      else file.remove();
    } catch {
      // Nothing more to do: noting an error must never become the next one.
    }
  };
  return {
    add(note) {
      if (!AppErrorNote.safeParse(note).success) return false;
      const sign = signature(note);
      if (noted.has(sign)) return false;
      noted.add(sign);
      notes = keepNewest([...load(), note]);
      if (!notes.includes(note)) return false;
      save();
      for (const l of listeners) {
        try {
          l();
        } catch {}
      }
      return true;
    },
    pending: () => load(),
    delivered(sent) {
      const gone = new Set(sent);
      notes = load().filter((n) => !gone.has(n));
      save();
    },
    onAdd(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The longest line the phone's sync log reads back from its saved copy (`data/syncLog.ts` `prepend`). */
export const NOTE_LINE_MAX = 300;

/** A note as one line of the phone's sync log: what it was, its words and its innermost frames. */
export function noteLine(note: AppErrorNote): string {
  const frames = note.stack.slice(0, 3).join(' | ');
  const what = note.kind === 'app' ? 'app ended' : 'error';
  const words = `${cut(note.name ?? 'Error', 40)}: ${cut(note.message, 160)}`;
  return cut(`${what} · ${note.build} · ${words}${frames ? ` · ${frames}` : ''}`, NOTE_LINE_MAX);
}

/** Where a rejection waits before it is noted: a timer, as `setTimeout` and `clearTimeout`. */
export interface HoldTimers {
  set(run: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}

/** How long a promise nobody caught is given for someone to catch it after all. */
export const REJECTION_HOLD_MS = 2_000;

/**
 * A promise's rejection is reported the moment nobody has caught it yet, and it may still be caught a little later
 * (awaited after a timer): `unhandled` holds it for a moment and `handled` lets it go, so only one nobody caught in
 * that time is noted. Never more than a few are held: the oldest is noted at once when another comes on top.
 */
export function createRejectionHold(
  note: (rejection: unknown) => void,
  timers: HoldTimers,
  holdMs: number = REJECTION_HOLD_MS,
  most = 20,
) {
  const held = new Map<number, { timer: unknown; rejection: unknown }>();
  const release = (id: number) => {
    const waiting = held.get(id);
    if (!waiting) return;
    held.delete(id);
    timers.clear(waiting.timer);
    note(waiting.rejection);
  };
  return {
    unhandled(id: number, rejection: unknown): void {
      const oldest = held.keys().next();
      if (held.size >= most && !oldest.done) release(oldest.value);
      held.set(id, { rejection, timer: timers.set(() => release(id), holdMs) });
    },
    handled(id: number): void {
      const waiting = held.get(id);
      if (!waiting) return;
      held.delete(id);
      timers.clear(waiting.timer);
    },
  };
}

/** Quiet errors noted while the app runs, at most: a part that keeps failing would fill the box's log otherwise. */
export const QUIET_NOTES_PER_RUN = 3;

/** `add` for quiet errors (`noteOfQuiet`): the first few of a run are noted, the rest let go. */
export function createQuietNotes(
  notes: ErrorNotes,
  max: number = QUIET_NOTES_PER_RUN,
): (note: AppErrorNote) => void {
  let kept = 0;
  return (note) => {
    if (kept >= max) return;
    if (notes.add(note)) kept += 1;
  };
}

/**
 * Sends what is pending, one report at a time; a failed send leaves the notes for the next try (the next session, or
 * the next note).
 */
export function createNoteSender(notes: ErrorNotes, send: (notes: AppErrorNote[]) => Promise<unknown>) {
  let busy = false;
  return async function flush(): Promise<void> {
    if (busy) return;
    const batch = [...notes.pending()];
    if (!batch.length) return;
    busy = true;
    try {
      await send(batch);
      notes.delivered(batch);
    } catch {
      // Kept for the next try.
    } finally {
      busy = false;
    }
  };
}
