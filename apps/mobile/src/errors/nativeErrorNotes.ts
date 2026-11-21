/**
 * The app's error notes (`errorNotes.ts`) on the phone: files in the app's private documents, and the places an
 * error or an ending can be seen from. `startErrorNotes` runs before any of the app's own code (`start.ts`, the first
 * thing `index.ts` loads), so nothing here may load the app: no `managed/…`, no screens. A module that failed to load
 * throws again when it is asked for, and an error while noting one is swallowed by React Native, note and all.
 */
import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import { AppState, Platform } from 'react-native';
import { onDiagnostics, pendingDiagnostics, removeDiagnostics } from '../../modules/whombat-diagnostics';
import { notesOfExit } from './androidExits';
import { notesOfPayload } from './diagnostics';
import { createOpenMarker, noteOfLeftover } from './endedWhileOpen';
import {
  createErrorNotes,
  createQuietNotes,
  createRejectionHold,
  type ErrorNotes,
  type NoteFile,
  noteOfCaught,
  noteOfQuiet,
  noteOfReported,
  QUIET_NAMES,
  type ReportedError,
} from './errorNotes';

/** A file in the app's documents, read and written synchronously: the app may be gone a moment later. */
const documentFile = (name: string): NoteFile => {
  const file = () => new File(Paths.document, name);
  return {
    read() {
      const f = file();
      return f.exists ? f.textSync() : null;
    },
    write(text) {
      file().write(text);
    },
    remove() {
      const f = file();
      if (f.exists) f.delete();
    },
  };
};

export const errorNotes: ErrorNotes = createErrorNotes(documentFile('whombat-error-notes.json'));
const quiet = createQuietNotes(errorNotes);

let build: string | null = null;
/** “ios 3.129.2 (3129002)”, as the session's `hello` says it (`managed/env.ts` `phoneClient`), from the app's config. */
const buildLabel = (): string => {
  if (build) return build;
  try {
    const config = Constants.expoConfig;
    const number = Platform.OS === 'ios' ? config?.ios?.buildNumber : config?.android?.versionCode;
    build = `${Platform.OS} ${config?.version ?? '?'}${number != null ? ` (${number})` : ''}`.slice(0, 64);
  } catch {
    build = Platform.OS;
  }
  return build;
};

interface ExceptionsManagerModule {
  unstable_setExceptionDecorator(decorator: ((data: ReportedError) => ReportedError) | null): void;
}

interface HermesRejections {
  enablePromiseRejectionTracker?(options: {
    allRejections: boolean;
    onUnhandled(id: number, rejection: unknown): void;
    onHandled?(id: number): void;
  }): void;
}

/** A fatal error as React Native reports it, noted; never throws (it runs inside React Native's own error handling). */
function noteFatal(data: ReportedError | null | undefined): void {
  try {
    if (data?.isFatal)
      errorNotes.add(noteOfReported(data, { build: buildLabel(), at: new Date(), kind: 'app' }));
  } catch {}
}

/**
 * Notes every error that ends the app, as React Native reports it (an error thrown anywhere outside a page, or one no
 * page caught), and the quiet ones nobody sees. None of the hooks is public API: where one moved, that part isn't
 * noted and the app works as before.
 */
export function startErrorNotes(): void {
  // Errors once the app's code has loaded come through React Native's JavaScript handler…
  try {
    const manager: ExceptionsManagerModule | undefined =
      require('react-native/Libraries/Core/ExceptionsManager').default;
    manager?.unstable_setExceptionDecorator?.((data) => {
      noteFatal(data);
      return data;
    });
  } catch {}
  // …and the ones while it loads (a module that throws as it is read) through its native one, which never asks the
  // decorator. An error both saw is noted once (`ErrorNotes.add`).
  try {
    const register = (
      globalThis as { RN$registerExceptionListener?: (l: (data: ReportedError) => void) => void }
    ).RN$registerExceptionListener;
    register?.(noteFatal);
  } catch {}
  // A promise that failed and nobody caught says nothing in a release build: Hermes only tracks them in development,
  // where React Native shows them. One caught a moment later is told as handled, and isn't noted (`createRejectionHold`).
  try {
    if (!__DEV__) {
      const hermes = (globalThis as { HermesInternal?: HermesRejections }).HermesInternal;
      const hold = createRejectionHold((rejection) => noteQuiet(rejection, QUIET_NAMES.rejection), {
        set: (run, ms) => setTimeout(run, ms),
        clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      });
      hermes?.enablePromiseRejectionTracker?.({
        allRejections: true,
        onUnhandled: hold.unhandled,
        onHandled: hold.handled,
      });
    }
  } catch {}
  try {
    watchOpen();
  } catch {}
  // Android's endings are read once the first screen is drawn (`noteEndingsAfterFirstFrame`): reading a trace costs
  // time the start shouldn't wait for. iOS's payloads are small files already on the phone.
  if (Platform.OS === 'ios') {
    try {
      noteDiagnostics();
      onDiagnostics(noteDiagnostics);
    } catch {}
  }
}

let endingsAsked = false;
/**
 * On Android, how the earlier runs ended (`androidExits.ts`), noted after the next frame, once a run; the app's root
 * calls it as it mounts. The last run's own JavaScript error is still waiting to be sent then: a crash it explains
 * isn't noted twice.
 */
export function noteEndingsAfterFirstFrame(): void {
  if (Platform.OS !== 'android' || endingsAsked) return;
  endingsAsked = true;
  requestAnimationFrame(() => setTimeout(noteDiagnostics, 0));
}

function noteQuiet(error: unknown, name: string, where?: string): void {
  try {
    quiet(noteOfQuiet(error, { build: buildLabel(), at: new Date(), name, ...(where && { where }) }));
  } catch {}
}

/** A listener of the session that threw (`@whombat/client/session` `onListenerError`): the app goes on, it is noted. */
export function noteListenerError(error: unknown, where: string): void {
  console.error(`A session ${where} listener failed`, error);
  noteQuiet(error, QUIET_NAMES.listener, where);
}

/** A page that failed to draw: the app goes on, and its error is noted for the box. */
export function notePageError(error: unknown, componentStack: string | null | undefined): void {
  try {
    errorNotes.add(noteOfCaught(error, componentStack, { build: buildLabel(), at: new Date() }));
  } catch {}
}

// The app ended while it was open (`endedWhileOpen.ts`). iPhone only: on Android the app's own updater ends it while
// it is open at every update, which would be noted each time; there Android names how each run ended itself
// (`androidExits.ts`), and an update isn't one of the endings noted.
const openMarker = createOpenMarker(documentFile('whombat-open-mark.json'), buildLabel());
const OPEN_SEEN_MS = 60_000;

function watchOpen(): void {
  if (Platform.OS !== 'ios') return;
  const left = noteOfLeftover(openMarker.leftover(), errorNotes.pending());
  if (left) errorNotes.add(left);
  const follow = (state: string) => {
    if (state === 'active') openMarker.active(new Date());
    else if (state === 'inactive') openMarker.inactive(new Date());
    else openMarker.background();
  };
  follow(AppState.currentState);
  AppState.addEventListener('change', follow);
  AppState.addEventListener('memoryWarning', () => openMarker.memoryWarning(new Date()));
  setInterval(() => openMarker.seen(new Date()), OPEN_SEEN_MS);
}

/** The page on top changed (its route's name): the next “ended while open” says where. */
export function noteRoute(name: string | undefined): void {
  try {
    openMarker.seen(new Date(), name ?? null);
  } catch {}
}

/**
 * What iOS handed over since (`diagnostics.ts`), or how Android says the earlier runs ended (`androidExits.ts`), noted;
 * a payload that can't be read stays for a later version.
 */
function noteDiagnostics(): void {
  try {
    const done: string[] = [];
    for (const payload of pendingDiagnostics()) {
      const notes =
        Platform.OS === 'android'
          ? notesOfExit(payload.json, { build: buildLabel(), now: new Date(), pending: errorNotes.pending() })
          : notesOfPayload(payload.json, { build: buildLabel(), at: new Date() });
      if (!notes) continue;
      for (const note of notes) errorNotes.add(note);
      done.push(payload.id);
    }
    removeDiagnostics(done);
  } catch {}
}
