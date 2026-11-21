/**
 * What Android itself knows about how the app's earlier runs ended, as error notes. Android 11+ keeps the reasons a
 * process ended (`modules/whombat-diagnostics`, Android's `ApplicationExitInfo`): a crash, a crash in native code, an
 * app that stopped answering and was closed (ANR), an ending for memory. The app's own code is gone before it could
 * write anything about the last three, so this is the only place they are named.
 *
 * Each ending is read at the next start, which may be a newer build after an update: the note carries the build that
 * ended (Android keeps the label the run gave itself) and the moment it ended. Only structured facts are kept: the
 * reason, the signal and its code, a known thread's name and the frames (a code file by its name only), the memory
 * used, the build.
 * Android's free text (an ending's description, a native abort message, the causes it names) can carry whatever a
 * library put in it, an address, a link or a token, and the note goes to the box's log and the phone's sync log: it is
 * never kept, except an ANR's kind, matched against Android's own fixed words and said in ours.
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
  /** Android's own words about it: read only to tell which kind of ANR it was (`anrKind`), never kept. */
  description: string | null;
  /** `3.140.0 (3140000)`, the label that run gave itself. */
  build: string | null;
  /** That run's own id (`WhombatDiagnostics.runId`); null for a run of a build before it had one. */
  run: string | null;
  /** An ANR's thread dump, its start. */
  trace: string | null;
  /** A native crash's tombstone (a protocol buffer), base64, its start. */
  tombstone: string | null;
}

/** Android's `RunningAppProcessInfo.IMPORTANCE_VISIBLE`: this or lower (more important) is on screen. */
const IMPORTANCE_VISIBLE = 200;
/** An ending older than this when first read (the first start of a build that reads them) is let go. */
export const EXIT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const FRAMES = 20;
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
/**
 * A file a frame names, as its name only when it is a code file (a library, the APK, Android's compiled code): the
 * folders are the phone's (an app's install folder has random names), and a file in the app's or the person's data,
 * an anonymous mapping or a name with other characters could say something of the person: those are `(file)`.
 */
export function fileName(path: string): string {
  if (/^\/(data\/(data|user|user_de|media)|storage|sdcard|mnt)\//.test(path)) return '(file)';
  const name = path.split('/').pop() ?? '';
  return /^[\w.+-]+\.(so|apk|oat|odex|vdex|art|jar|dex)(![\w.+-]+\.so)?$/.test(name) ? name : '(file)';
}

/**
 * Thread names the note keeps as they are: React Native's, Android's own and the app's. A native thread can be named
 * by any library, so any other name is said as “another thread”. Linux cuts names to 15 characters.
 */
const KNOWN_THREADS = new Set([
  'main',
  'mqt_js',
  'mqt_v_js',
  'mqt_native_modu',
  'mqt_v_native',
  'RenderThread',
  'FinalizerDaemon',
  'FinalizerWatchd',
  'ReferenceQueueD',
  'HeapTaskDaemon',
  'Signal Catcher',
  'Jit thread pool',
  'Profile Saver',
  'whombat-voice',
  'GLThread',
  'FrescoDecodeExe',
  'FrescoBackgroun',
  'OkHttp Dispatch',
  'hermes-chrome-i',
]);
const KNOWN_THREAD_FORMS = [
  /^hwuiTask\d+$/,
  /^binder:\d+_[0-9A-F]+$/,
  /^pool-\d+-thread-\d+$/,
  /^AsyncTask #\d+$/,
  /^DefaultDispatch$/,
  /^RxCachedThreadS$/,
];
export function threadName(name: string): string {
  return KNOWN_THREADS.has(name) || KNOWN_THREAD_FORMS.some((form) => form.test(name))
    ? name
    : 'another thread';
}

/** `3.141.0 (3141000) run=ab12…`: the build and the run's id. */
function summaryOf(summary: string | null): { build: string | null; run: string | null } {
  const m = /^(.*?)(?:\s+run=([0-9a-f]{1,32}))?$/.exec(summary ?? '');
  return { build: m?.[1] || null, run: m?.[2] ?? null };
}

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
    ...summaryOf(str(o.build)),
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
    // Rebuilt from its parts: the lock's class and the thread holding it, nothing else of the line.
    const lock = /^- waiting (to lock|on) <0x[0-9a-f]+> \(a ([\w.$]+)\)(?: held by thread (\d+))?/.exec(line);
    if (!waiting && lock)
      waiting = cut(`waiting ${lock[1]} a ${lock[2]}${lock[3] ? ` held by thread ${lock[3]}` : ''}`, 200);
    const native = line.startsWith('native: ');
    if (!native && !line.startsWith('at ')) continue;
    if (native && !java && ++nativeOnTop > NATIVE_ON_TOP) continue;
    if (!native) java = true;
    frames.push(cut(native ? nativeFrame(line.slice('native: '.length)) : line, 300));
    if (frames.length >= FRAMES) break;
  }
  return { state, waiting, frames };
}

/** `#00 pc 0009c4a8  /apex/…/libc.so (wait+8) (BuildId: …)` with its file as `fileName` says it. */
function nativeFrame(line: string): string {
  const m = /^(#\d+ pc [0-9a-f]+)\s+(\S+)(.*)$/.exec(line);
  return m ? `${m[1]}  ${fileName(m[2] ?? '')}${m[3] ?? ''}` : '(frame)';
}

// ── A native crash's tombstone (Android's tombstone.proto) ────────────────────────────────────────────────────────

/** Said when the crashed thread comes after the part of the tombstone that was read. */
export const CRASHED_THREAD_NOT_READ = 'crashed thread not in the part read';

/** Each character code's base64 value, 255 for one that isn't base64: a tombstone is up to 1.3 MB of it. */
const B64 = (() => {
  const table = new Uint8Array(128).fill(255);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < chars.length; i += 1) table[chars.charCodeAt(i)] = i;
  return table;
})();

/** Base64 to bytes; anything not base64 (the padding included) ends it. */
export function base64Bytes(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    const v = c < 128 ? (B64[c] ?? 255) : 255;
    if (v === 255) break;
    value = ((value << 6) | v) & 0xffffff;
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
    file ? fileName(file) : '?',
    `+${hex(intOf(frame, 1) ?? { lo: 0, hi: 0 })}`,
    fn ? `(${fn}${offset && !isZero(offset) ? `+${asNumber(offset)}` : ''})` : null,
    build ? `(BuildId: ${build})` : null,
  ];
  return cut(parts.filter(Boolean).join(' '), 300);
}

/**
 * What a tombstone says about the crash: the signal and its code, and the crashed thread's name and frames (innermost
 * first). Fields are the tombstone's own numbers; anything missing is left out. The abort message and the causes are
 * free text and are never read.
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
  const tid = intOf(top, 6);
  const threads = top.flatMap((f) => {
    if (f.no !== 16 || !('bytes' in f)) return [];
    const entry = fieldsOf(f.bytes);
    const thread = bytesOf(entry, 2);
    return thread ? [{ key: intOf(entry, 1), fields: fieldsOf(thread) }] : [];
  });
  // Without the crashed thread's id the first thread is the best guess; with it, never another thread's frames.
  const crashed =
    tid === null ? threads[0] : threads.find((t) => sameInt(t.key, tid) || sameInt(intOf(t.fields, 1), tid));
  if (!crashed) {
    if (tid !== null) words.push(CRASHED_THREAD_NOT_READ);
    return { words, frames: [] };
  }
  const name = textOf(crashed.fields, 2);
  if (name) words.push(`thread ${threadName(name)}`);
  const frames = crashed.fields
    .filter((f): f is Extract<Field, { bytes: Uint8Array }> => f.no === 4 && 'bytes' in f)
    .slice(0, FRAMES)
    .map((f, i) => frameLine(fieldsOf(f.bytes), i));
  return { words, frames };
}

/**
 * Which kind of ANR it was, in our words, from the start of Android's own fixed wording; null for anything else, whose
 * words are then left out.
 */
export function anrKind(description: string | null): string | null {
  if (!description) return null;
  const kinds: [RegExp, string][] = [
    [/^Input dispatching timed out/, 'input not handled in time'],
    [/^Broadcast of Intent/, 'a broadcast not handled in time'],
    [/^executing service/, 'a service not started in time'],
    [
      /^Context\.startForegroundService\(\) did not then call Service\.startForeground\(\)/,
      'a foreground service not started in time',
    ],
    [/^ContentProvider not responding/, 'a content provider not answering'],
    [/^App requested: /, 'reported by the app'],
  ];
  return kinds.find(([form]) => form.test(description))?.[1] ?? null;
}

// ── The runs that ended with a JavaScript error noted ──────────────────────────────────────────────────────────────

/** How many runs are remembered: the endings read at a start are a few runs back at most. */
const FATAL_RUNS_KEPT = 10;

/** The run ids in the small file beside the notes; anything else in it is nothing. */
export function readFatalRuns(text: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(text ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

/** The file's text with `run` added (once), the newest kept. */
export function withFatalRun(text: string | null, run: string): string {
  const runs = readFatalRuns(text).filter((r) => r !== run);
  return JSON.stringify([...runs, run].slice(-FATAL_RUNS_KEPT));
}

// ── Notes ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface ExitInput {
  /** This build, for an ending that names none. */
  build: string;
  now: Date;
  /** The runs that ended with a JavaScript error noted (`fatalRuns`): that note is their crash's cause. */
  fatalRuns: readonly string[];
}

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
  // A fatal JavaScript error ends the app as a Java crash: the same ending only when it was noted in that very run.
  if (exit.reason === 'crash' && exit.run && input.fatalRuns.includes(exit.run)) return [];

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
      const kind = anrKind(exit.description);
      if (kind) extra.push(kind);
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
