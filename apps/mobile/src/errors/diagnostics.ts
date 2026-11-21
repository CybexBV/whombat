/**
 * What iOS itself knows about how the app ended, as error notes. iOS hands an app its own crash and hang reports and,
 * once a day, counts of how its runs ended (MetricKit; `modules/whombat-diagnostics` keeps what arrives as the JSON
 * iOS makes of it). Those are the only place a crash in native code is described and a memory or watchdog ending is
 * named: the app's own code is gone before it could write anything.
 *
 * They arrive late (a crash's at the next start or the one after, the counts a day later) and may be about an older
 * build, so each note carries the build and the time span iOS says it is about. Frames are a binary's name, its UUID
 * and an offset: `publish:ios` keeps each build's dSYMs, which turn them into the code's names.
 *
 * Read tolerantly: a payload shaped another way gives fewer notes, never an error.
 */
import type { AppErrorNote } from '@whombat/core';

export const DIAGNOSTIC_NAMES = { crash: 'NativeCrash', hang: 'Hang', exits: 'ExitCounts' } as const;

type Json = Record<string, unknown>;
const object = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null;
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** `ios 3.129.2 (3129002)`, the build iOS says the report is about. */
function buildOf(meta: Json | null, fallback: string): string {
  const version = text(meta?.appVersion) ?? text(meta?.applicationVersion);
  const number = text(meta?.appBuildVersion) ?? text(meta?.bundleVersion);
  if (!version && !number) return cut(fallback, 64);
  return cut(`ios ${version ?? '?'}${number ? ` (${number})` : ''}`, 64);
}

const span = (payload: Json) => {
  const from = text(payload.timeStampBegin);
  const to = text(payload.timeStampEnd);
  return from || to ? `${from ?? '?'} to ${to ?? '?'}` : null;
};

/** How many frames a note takes: the contract's. Both ends of a longer stack are kept, whichever is the innermost. */
const FRAMES = 20;
const FIRST = 12;

/** The frames of the thread that crashed (or the first), one line each: `binary uuid +offset`. */
export function framesOf(callStackTree: unknown): string[] {
  const stacks = list(object(callStackTree)?.callStacks).map(object);
  const stack = stacks.find((s) => s?.threadAttributed === true) ?? stacks[0];
  const lines: string[] = [];
  let frame = object(list(stack?.callStackRootFrames)[0]);
  for (let depth = 0; frame && depth < 512; depth += 1) {
    const name = text(frame.binaryName) ?? '?';
    const uuid = text(frame.binaryUUID) ?? '?';
    const offset = text(frame.offsetIntoBinaryTextSegment) ?? '?';
    lines.push(cut(`${name} ${uuid} +${offset}`, 300));
    frame = object(list(frame.subFrames)[0]);
  }
  if (lines.length <= FRAMES) return lines;
  return [...lines.slice(0, FIRST), ...lines.slice(lines.length - (FRAMES - FIRST))];
}

function crashNote(diagnostic: Json, payload: Json, input: NoteInput): AppErrorNote {
  const meta = object(diagnostic.diagnosticMetaData);
  const parts = [
    text(meta?.terminationReason),
    text(meta?.exceptionType) ? `exception type ${text(meta?.exceptionType)}` : null,
    text(meta?.exceptionCode) ? `code ${text(meta?.exceptionCode)}` : null,
    text(meta?.signal) ? `signal ${text(meta?.signal)}` : null,
    text(meta?.virtualMemoryRegionInfo),
    text(meta?.osVersion),
    span(payload),
  ].filter((p): p is string => p !== null);
  return {
    at: input.at.toISOString(),
    build: buildOf(meta, input.build),
    kind: 'app',
    name: DIAGNOSTIC_NAMES.crash,
    message: cut(parts.join(' · ') || 'A crash iOS reported', 1000),
    stack: framesOf(diagnostic.callStackTree),
    components: null,
  };
}

function hangNote(diagnostic: Json, payload: Json, input: NoteInput): AppErrorNote {
  const meta = object(diagnostic.diagnosticMetaData);
  const parts = [
    text(meta?.hangDuration) ? `didn’t answer for ${text(meta?.hangDuration)}` : null,
    text(meta?.osVersion),
    span(payload),
  ].filter((p): p is string => p !== null);
  return {
    at: input.at.toISOString(),
    build: buildOf(meta, input.build),
    // The app may well have gone on after it.
    kind: 'page',
    name: DIAGNOSTIC_NAMES.hang,
    message: cut(parts.join(' · ') || 'A hang iOS reported', 1000),
    stack: framesOf(diagnostic.callStackTree),
    components: null,
  };
}

/**
 * The endings that aren't the ordinary one, as `Name 2`: every count iOS gives except the normal exit and, in the
 * background, the memory iOS takes back from apps that aren't in use (routine, not a fault of the app).
 */
function abnormalExits(data: Json | null, background: boolean): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(data ?? {})) {
    const name = /^cumulative(.+)ExitCount$/.exec(key)?.[1];
    if (!name || typeof value !== 'number' || value <= 0) continue;
    if (name === 'NormalApp' || (background && name === 'MemoryPressure')) continue;
    out.push(`${name} ${value}`);
  }
  return out;
}

function exitsNote(payload: Json, input: NoteInput): AppErrorNote | null {
  const exits = object(payload.applicationExitMetrics);
  const foreground = abnormalExits(object(exits?.foregroundExitData), false);
  const background = abnormalExits(object(exits?.backgroundExitData), true);
  if (!foreground.length && !background.length) return null;
  const parts = [
    foreground.length ? `in the foreground: ${foreground.join(', ')}` : null,
    background.length ? `in the background: ${background.join(', ')}` : null,
    span(payload),
    payload.includesMultipleApplicationVersions === true ? 'covers more than one app version' : null,
  ].filter((p): p is string => p !== null);
  const meta = object(payload.metaData);
  return {
    at: input.at.toISOString(),
    build: buildOf(
      {
        // The version iOS names for the day's counts, under whichever of its names the payload has.
        appVersion: payload.latestApplicationVersion ?? payload.appVersion ?? meta?.appVersion,
        appBuildVersion: meta?.appBuildVersion ?? meta?.bundleVersion,
      },
      input.build,
    ),
    kind: 'app',
    name: DIAGNOSTIC_NAMES.exits,
    message: cut(`Endings iOS counted, ${parts.join(' · ')}`, 1000),
    stack: [],
    components: null,
  };
}

interface NoteInput {
  /** This build, for a payload that names none. */
  build: string;
  /** When the payload was read. */
  at: Date;
}

/**
 * The notes of one payload as iOS wrote it (a diagnostic payload: crashes and hangs; a metric payload: the exit
 * counts). A payload with nothing to tell gives none; null for text that isn't a payload at all, which is kept on
 * the phone for a version that can read it.
 */
export function notesOfPayload(json: string, input: NoteInput): AppErrorNote[] | null {
  let payload: Json | null;
  try {
    payload = object(JSON.parse(json));
  } catch {
    return null;
  }
  if (!payload) return null;
  const p = payload;
  const notes: AppErrorNote[] = [];
  for (const d of list(p.crashDiagnostics).map(object)) if (d) notes.push(crashNote(d, p, input));
  for (const d of list(p.hangDiagnostics).map(object)) if (d) notes.push(hangNote(d, p, input));
  const exits = exitsNote(p, input);
  if (exits) notes.push(exits);
  return notes;
}
