/**
 * What Android itself knows about how the app's earlier runs ended, as error notes. Android 11+ keeps the reasons a
 * process ended (`modules/whombat-diagnostics`, Android's `ApplicationExitInfo`): a crash, a crash in native code, an
 * app that stopped answering and was closed (ANR), an ending for memory. The app's own code is gone before it could
 * write anything about the last three, so this is the only place they are named.
 *
 * Each ending is read at the next start, which may be a newer build after an update: the note carries the build that
 * ended (Android keeps the label the run gave itself) and the moment it ended. Only the frames of the thread that
 * mattered are kept, a file as its name only, never what was on screen or in the app's memory.
 *
 * Read tolerantly: an ending shaped another way gives a shorter note, never an error.
 */
import type { AppErrorNote } from '@whombat/core';

export const ANDROID_EXIT_NAMES = {
  /** A crash in Java or Kotlin; a fatal JavaScript error ends the app this way too. */
  crash: 'Crash',
  crashNative: 'NativeCrash',
  anr: 'Anr',
  lowMemory: 'LowMemory',
} as const;

/** What the module hands over for one ending (`describe` in `WhombatDiagnosticsModule.kt`). */
interface AndroidExit {
  reason: 'crash' | 'crash_native' | 'anr' | 'low_memory';
  /** Epoch ms. */
  timestamp: number;
  importance: number | null;
  status: number | null;
  /** kB. */
  pss: number | null;
  rss: number | null;
  description: string | null;
  /** `3.140.0 (3140000)`, the label that run gave itself. */
  build: string | null;
  /** An ANR's thread dump, its start. */
  trace: string | null;
  /** A native crash's tombstone (a protocol buffer), base64, its start. */
  tombstone: string | null;
}

/** Android's `RunningAppProcessInfo.IMPORTANCE_VISIBLE`: this or lower (more important) is on screen. */
const IMPORTANCE_VISIBLE = 200;
/** An ending older than this when first read (the first start of a build that reads them) is let go. */
export const EXIT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How close a JavaScript error noted in the ended run must be to the crash to be its cause. */
const SAME_CRASH_MS = 30_000;

const FRAMES = 20;
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
/** A path is its last part: the folders are the phone's (and an app's install folder has random names). */
const withoutPaths = (line: string) => line.replace(/[^\s(]*\//g, '');

function exitOf(json: string): AndroidExit | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const reason = o.reason;
  const timestamp = num(o.timestamp);
  if (
    timestamp === null ||
    (reason !== 'crash' && reason !== 'crash_native' && reason !== 'anr' && reason !== 'low_memory')
  )
    return null;
  return {
    reason,
    timestamp,
    importance: num(o.importance),
    status: num(o.status),
    pss: num(o.pss),
    rss: num(o.rss),
    description: str(o.description),
    build: str(o.build),
    trace: str(o.trace),
    tombstone: str(o.tombstone),
  };
}

// ── An ANR's thread dump ──────────────────────────────────────────────────────────────────────────────────────────

/** Native frames shown before the first Java one: the top of a frozen main thread is mostly waiting in the kernel. */
const NATIVE_ON_TOP = 4;

/**
 * The main thread of a thread dump as Android writes one for an ANR: its state (`Native`, `Blocked`…), the lock it
 * waits for, and its frames, innermost first, a file as its name only.
 */
export function mainThreadOf(trace: string): {
  state: string | null;
  waiting: string | null;
  frames: string[];
} {
  const lines = trace.split('\n');
  const start = lines.findIndex((l) => l.startsWith('"main" '));
  if (start === -1) return { state: null, waiting: null, frames: [] };
  const state = /\s(\w+)\s*$/.exec(lines[start] ?? '')?.[1] ?? null;
  let waiting: string | null = null;
  const frames: string[] = [];
  let java = false;
  let nativeOnTop = 0;
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (!line) break;
    if (!waiting && /^- waiting (to lock|on)/.test(line)) waiting = cut(line.slice(2), 200);
    const native = line.startsWith('native: ');
    if (!native && !line.startsWith('at ')) continue;
    if (native && !java && ++nativeOnTop > NATIVE_ON_TOP) continue;
    if (!native) java = true;
    frames.push(cut(withoutPaths(native ? line.slice('native: '.length) : line), 300));
    if (frames.length >= FRAMES) break;
  }
  return { state, waiting, frames };
}

// ── A native crash's tombstone (Android's tombstone.proto) ────────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 to bytes; anything not base64 ends it. */
export function base64Bytes(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let n = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v === -1) break;
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

/**
 * A 64-bit number from a protocol buffer as its two 32-bit halves, without BigInt: addresses on a 64-bit phone carry a
 * tag in their top byte, past what a JavaScript number holds exactly.
 */
interface Int64 {
  lo: number;
  hi: number;
}

/** One field of a protocol buffer message: a number (varint or fixed) or the bytes of a nested message or string. */
type Field = { no: number; int: Int64 } | { no: number; bytes: Uint8Array };

const TWO32 = 2 ** 32;
const asNumber = (n: Int64) => n.hi * TWO32 + n.lo;
const isZero = (n: Int64) => n.lo === 0 && n.hi === 0;
const hex = (n: Int64) =>
  n.hi ? `0x${n.hi.toString(16)}${n.lo.toString(16).padStart(8, '0')}` : `0x${n.lo.toString(16)}`;
/** A protocol buffer's int32 as a varint: a negative one is written 64 bits wide, its low half is the number. */
const int32 = (n: Int64) => n.lo | 0;

/** The fields of one message, in order; a message cut short (the start of a long tombstone) ends where it is cut. */
function fieldsOf(buf: Uint8Array): Field[] {
  const fields: Field[] = [];
  let i = 0;
  const varint = (): Int64 | null => {
    let lo = 0;
    let hi = 0;
    for (let shift = 0; i < buf.length && shift < 70; shift += 7) {
      const b = buf[i++] ?? 0;
      const g = b & 0x7f;
      // The 7-bit groups don't overlap, so adding them is exact.
      if (shift < 32) {
        const v = g * 2 ** shift;
        lo += v % TWO32;
        hi += Math.floor(v / TWO32);
      } else if (shift < 64) hi += (g * 2 ** (shift - 32)) % TWO32;
      if (!(b & 0x80)) return { lo, hi: hi % TWO32 };
    }
    return null;
  };
  while (i < buf.length) {
    const key = varint();
    if (key === null) break;
    const no = Math.floor(asNumber(key) / 8);
    const wire = key.lo & 7;
    if (wire === 0) {
      const int = varint();
      if (int === null) break;
      fields.push({ no, int });
    } else if (wire === 2) {
      const len = varint();
      if (len === null || len.hi || i + len.lo > buf.length) break;
      fields.push({ no, bytes: buf.subarray(i, i + len.lo) });
      i += len.lo;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (i + size > buf.length) break;
      const word = (at: number) =>
        ((buf[at] ?? 0) |
          ((buf[at + 1] ?? 0) << 8) |
          ((buf[at + 2] ?? 0) << 16) |
          ((buf[at + 3] ?? 0) << 24)) >>>
        0;
      fields.push({ no, int: { lo: word(i), hi: size === 8 ? word(i + 4) : 0 } });
      i += size;
    } else break;
  }
  return fields;
}

/** UTF-8 to text; a broken sequence becomes U+FFFD. */
function utf8(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i] ?? 0;
    const extra = b < 0x80 ? 0 : b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : -1;
    if (extra < 0 || i + extra >= bytes.length) {
      s += '\ufffd';
      i += 1;
      continue;
    }
    let cp = extra ? b & (0x3f >> extra) : b;
    let ok = true;
    for (let k = 1; k <= extra; k += 1) {
      const c = bytes[i + k] ?? 0;
      if ((c & 0xc0) !== 0x80) ok = false;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (!ok || cp > 0x10ffff) {
      s += '\ufffd';
      i += 1;
      continue;
    }
    s += String.fromCodePoint(cp);
    i += extra + 1;
  }
  return s;
}

const intOf = (fields: Field[], no: number): Int64 | null => {
  const f = fields.find((x) => x.no === no && 'int' in x);
  return f && 'int' in f ? f.int : null;
};
const bytesOf = (fields: Field[], no: number): Uint8Array | null => {
  const f = fields.find((x) => x.no === no && 'bytes' in x);
  return f && 'bytes' in f ? f.bytes : null;
};
const textOf = (fields: Field[], no: number): string | null => {
  const b = bytesOf(fields, no);
  return b?.length ? utf8(b) : null;
};
const sameInt = (a: Int64 | null, b: Int64 | null) => !!a && !!b && a.lo === b.lo && a.hi === b.hi;

/** `#00 libhermes.so +0x1a2b3c (hermes::vm::foo+56) (BuildId: …)`, a file as its name only. */
function frameLine(frame: Field[], index: number): string {
  const file = textOf(frame, 6);
  const fn = textOf(frame, 4);
  const offset = intOf(frame, 5);
  const build = textOf(frame, 8);
  const parts = [
    `#${String(index).padStart(2, '0')}`,
    file ? withoutPaths(file) : '?',
    `+${hex(intOf(frame, 1) ?? { lo: 0, hi: 0 })}`,
    fn ? `(${fn}${offset && !isZero(offset) ? `+${asNumber(offset)}` : ''})` : null,
    build ? `(BuildId: ${build})` : null,
  ];
  return cut(parts.filter(Boolean).join(' '), 300);
}

/**
 * What a tombstone says about the crash: the signal, the abort message, the causes Android names, and the crashed
 * thread's name and frames (innermost first). Fields are the tombstone's own numbers; anything missing is left out.
 */
export function tombstoneOf(bytes: Uint8Array): { words: string[]; frames: string[] } {
  const top = fieldsOf(bytes);
  const words: string[] = [];
  const signal = bytesOf(top, 10);
  if (signal) {
    const s = fieldsOf(signal);
    const number = intOf(s, 1);
    const code = intOf(s, 3);
    const parts = [
      number !== null ? `signal ${int32(number)}${textOf(s, 2) ? ` (${textOf(s, 2)})` : ''}` : null,
      code !== null ? `code ${int32(code)}${textOf(s, 4) ? ` (${textOf(s, 4)})` : ''}` : null,
      sameInt(intOf(s, 8), { lo: 1, hi: 0 }) ? `fault addr ${hex(intOf(s, 9) ?? { lo: 0, hi: 0 })}` : null,
    ].filter(Boolean);
    if (parts.length) words.push(parts.join(', '));
  }
  const abort = textOf(top, 14);
  if (abort) words.push(`abort: ${cut(abort, 300)}`);
  for (const cause of top.filter((f) => f.no === 15 && 'bytes' in f)) {
    const said = 'bytes' in cause ? textOf(fieldsOf(cause.bytes), 1) : null;
    if (said) words.push(cut(said, 200));
  }
  const tid = intOf(top, 6);
  const threads = top.flatMap((f) => {
    if (f.no !== 16 || !('bytes' in f)) return [];
    const entry = fieldsOf(f.bytes);
    const thread = bytesOf(entry, 2);
    return thread ? [{ key: intOf(entry, 1), fields: fieldsOf(thread) }] : [];
  });
  const crashed = threads.find((t) => sameInt(t.key, tid) || sameInt(intOf(t.fields, 1), tid)) ?? threads[0];
  if (!crashed) return { words, frames: [] };
  const name = textOf(crashed.fields, 2);
  if (name) words.push(`thread ${cut(name, 60)}`);
  const frames = crashed.fields
    .filter((f): f is Extract<Field, { bytes: Uint8Array }> => f.no === 4 && 'bytes' in f)
    .slice(0, FRAMES)
    .map((f, i) => frameLine(fieldsOf(f.bytes), i));
  return { words, frames };
}

// ── Notes ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface ExitInput {
  /** This build, for an ending that names none. */
  build: string;
  now: Date;
  /** The notes waiting to be sent: a JavaScript error noted just before a crash is that crash's cause. */
  pending: readonly AppErrorNote[];
}

const NOTED_LATER: ReadonlySet<string> = new Set(Object.values(ANDROID_EXIT_NAMES));

const mb = (kb: number | null) => (kb === null ? null : `${Math.round(kb / 1024)} MB`);

/**
 * The note of one ending as the module handed it over; `[]` for one not worth a note (an ending for memory while the
 * app wasn't on screen, which Android does to any app it needs the room of; one older than a week; a crash a
 * JavaScript error noted in that run already explains), null for text that isn't an ending at all.
 */
export function notesOfExit(json: string, input: ExitInput): AppErrorNote[] | null {
  const exit = exitOf(json);
  if (!exit) return null;
  if (input.now.getTime() - exit.timestamp > EXIT_MAX_AGE_MS) return [];
  const onScreen = exit.importance !== null && exit.importance <= IMPORTANCE_VISIBLE;
  if (exit.reason === 'low_memory' && !onScreen) return [];
  if (exit.reason === 'crash') {
    const explained = input.pending.some((n) => {
      const at = Date.parse(n.at);
      return (
        n.kind === 'app' &&
        !NOTED_LATER.has(n.name ?? '') &&
        at <= exit.timestamp + 5_000 &&
        at >= exit.timestamp - SAME_CRASH_MS
      );
    });
    if (explained) return [];
  }

  let what: string;
  let name: string;
  let stack: string[] = [];
  const extra: string[] = [];
  switch (exit.reason) {
    case 'crash':
      what = 'A crash Android reported';
      name = ANDROID_EXIT_NAMES.crash;
      break;
    case 'crash_native': {
      what = 'A crash in native code Android reported';
      name = ANDROID_EXIT_NAMES.crashNative;
      if (exit.tombstone) {
        const t = tombstoneOf(base64Bytes(exit.tombstone));
        extra.push(...t.words);
        stack = t.frames;
      }
      break;
    }
    case 'anr': {
      what = 'Android closed the app: it stopped answering';
      name = ANDROID_EXIT_NAMES.anr;
      if (exit.trace) {
        const main = mainThreadOf(exit.trace);
        if (main.state) extra.push(`main thread ${main.state}`);
        if (main.waiting) extra.push(main.waiting);
        stack = main.frames;
      }
      break;
    }
    case 'low_memory':
      what = 'Android closed the app for memory';
      name = ANDROID_EXIT_NAMES.lowMemory;
      break;
  }
  const memory = [mb(exit.pss) && `PSS ${mb(exit.pss)}`, mb(exit.rss) && `RSS ${mb(exit.rss)}`]
    .filter(Boolean)
    .join(', ');
  const parts = [
    what,
    exit.description ? cut(exit.description, 300) : null,
    ...extra,
    exit.importance === null ? null : onScreen ? 'on screen' : 'in the background',
    memory || null,
  ].filter((p): p is string => p !== null);
  return [
    {
      at: new Date(exit.timestamp).toISOString(),
      build: cut(exit.build ? `android ${exit.build}` : input.build, 64),
      kind: 'app',
      name,
      message: cut(parts.join(' · '), 1000),
      stack: stack.slice(0, FRAMES),
      components: null,
    },
  ];
}
