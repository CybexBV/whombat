import { AppErrorNote } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  ANDROID_EXIT_NAMES,
  anrKind,
  base64Bytes,
  CRASHED_THREAD_NOT_READ,
  EXIT_MAX_AGE_MS,
  mainThreadOf,
  notesOfExit,
  tombstoneOf,
} from './androidExits';

const now = new Date('2026-11-21T10:00:00.000Z');
const at = now.getTime() - 60_000;
const input = { build: 'android 3.141.0 (3141000)', now, pending: [] as AppErrorNote[] };
const exit = (over: Record<string, unknown>) =>
  JSON.stringify({
    platform: 'android',
    reason: 'crash',
    timestamp: at,
    importance: 100,
    status: 0,
    pss: 204_800,
    rss: 307_200,
    build: '3.140.0 (3140000)',
    ...over,
  });

// ── A tombstone, encoded the way Android writes one ──────────────────────────────────────────────────────────────

const varint = (n: number | bigint): number[] => {
  let v = BigInt.asUintN(64, BigInt(n));
  const out: number[] = [];
  do {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    out.push(v ? b | 0x80 : b);
  } while (v);
  return out;
};
const int = (no: number, n: number | bigint) => [...varint(no * 8), ...varint(n)];
const bytes = (no: number, b: number[]) => [...varint(no * 8 + 2), ...varint(b.length), ...b];
const text = (no: number, s: string) => bytes(no, [...new TextEncoder().encode(s)]);
const frame = (relPc: number, fn: string | null, file: string) => [
  ...int(1, relPc),
  ...(fn ? [...text(4, fn), ...int(5, 56)] : []),
  ...text(6, file),
  ...text(8, 'abc123'),
];
const thread = (id: number, name: string, frames: number[][]) => [
  ...int(1, id),
  ...text(2, name),
  ...frames.flatMap((f) => bytes(4, f)),
];
/** What a library could put in Android's free text: none of it may reach a note. */
const SECRETS = ['mara@example.com', 'https://example.com/reset?token=abc', 'Bearer sk-live-0123456789'];
const secret = SECRETS.join(' ');

const mainThread = bytes(16, [
  ...int(1, 4321),
  ...bytes(2, thread(4321, 'main', [frame(0x10, 'main_loop', '/system/lib64/libc.so')])),
]);
const tombstone = [
  ...int(5, 4321),
  ...int(6, 4400),
  ...text(9, 'com.whombat.mobile'),
  ...bytes(10, [
    ...int(1, 11),
    ...text(2, 'SIGSEGV'),
    ...int(3, 1),
    ...text(4, 'SEGV_MAPERR'),
    ...int(8, 1),
    ...int(9, 0xb400007a12345678n),
  ]),
  ...text(14, `Hermes ran out of room ${secret}`),
  ...bytes(15, text(1, `null pointer dereference ${secret}`)),
  ...mainThread,
  ...bytes(16, [
    ...int(1, 4400),
    ...bytes(
      2,
      thread(
        4400,
        'mqt_v_js',
        Array.from({ length: 25 }, (_, i) =>
          frame(
            0x1a2b3c + i,
            i === 0 ? 'hermes::vm::Runtime::crash' : null,
            '/data/app/~~x==/com.whombat.mobile-y==/lib/arm64/libhermes.so',
          ),
        ),
      ),
    ),
  ]),
  ...bytes(18, text(1, 'logcat lines are never read')),
];
const base64 = (b: number[]) => btoa(String.fromCharCode(...b));

const anrTrace = [
  '----- pid 4321 at 2026-11-21 10:59:00.000000000+0100 -----',
  'Cmd line: com.whombat.mobile',
  '',
  '"main" prio=5 tid=1 Blocked',
  '  | group="main" sCount=1 ucsCount=0 flags=1 obj=0x72c0a0b8 self=0xb400007a0',
  '  | state=S schedstat=( 0 0 0 ) utm=100 stm=20 core=4 HZ=100',
  ...Array.from(
    { length: 6 },
    (_, i) =>
      `  native: #0${i} pc 000000000009c4a8  /apex/com.android.runtime/lib64/bionic/libc.so (wait+${i}) (BuildId: f00)`,
  ),
  '  at com.whombat.live.LiveNotifications.show(LiveNotifications.kt:91)',
  '  - waiting to lock <0x0f1a2b3c> (a java.lang.Object) held by thread 23',
  '  native: #06 pc 0000000000001234  /data/app/~~r4nd0m==/com.whombat.mobile-q==/lib/arm64/libreactnative.so (x+1)',
  '  at android.os.Looper.loop(Looper.java:288)',
  '',
  '"Signal Catcher" daemon prio=10 tid=2 Runnable',
  '  at not.the.Main(Thread.java:1)',
].join('\n');

describe('Android endings as notes', () => {
  it('a native crash names the signal, the cause and the crashed thread’s frames, files by name only', () => {
    const notes = notesOfExit(
      exit({ reason: 'crash_native', description: secret, tombstone: base64(tombstone) }),
      input,
    );
    expect(notes).toHaveLength(1);
    const note = notes?.[0];
    expect(AppErrorNote.safeParse(note).success).toBe(true);
    expect(note).toMatchObject({
      kind: 'app',
      name: ANDROID_EXIT_NAMES.crashNative,
      build: 'android 3.140.0 (3140000)',
      at: new Date(at).toISOString(),
    });
    for (const fact of [
      'signal 11 (SIGSEGV)',
      'SEGV_MAPERR',
      '0xb400007a12345678',
      'thread mqt_v_js',
      'PSS 200 MB',
      'on screen',
    ])
      expect(note?.message).toContain(fact);
    expect(note?.message).not.toContain('logcat');
    expect(note?.message).not.toContain('Hermes ran out of room');
    expect(note?.message).not.toContain('null pointer dereference');
    for (const s of SECRETS) expect(JSON.stringify(note)).not.toContain(s);
    expect(note?.message).not.toContain('com.whombat.mobile');
    expect(note?.stack).toHaveLength(20);
    expect(note?.stack[0]).toContain('libhermes.so +0x1a2b3c (hermes::vm::Runtime::crash+56)');
    expect(note?.stack.join('\n')).not.toContain('/');
  });

  it('a tombstone cut before the crashed thread gives no frames and says so, never another thread’s', () => {
    const t = tombstoneOf(Uint8Array.from(tombstone.slice(0, tombstone.length - 300)));
    expect(t.words[0]).toContain('SIGSEGV');
    expect(t.words).toContain(CRASHED_THREAD_NOT_READ);
    expect(t.frames).toEqual([]);
    expect(t.words.join(' ')).not.toContain('thread main');
    expect(tombstoneOf(Uint8Array.from([0xff, 0xff, 0xff]))).toEqual({ words: [], frames: [] });
  });

  it('without the crashed thread’s id, the first thread is taken', () => {
    const t = tombstoneOf(Uint8Array.from([...int(5, 4321), ...mainThread]));
    expect(t.words).toContain('thread main');
    expect(t.frames[0]).toContain('libc.so');
  });

  it('base64 decodes the module’s bytes', () => {
    expect([...base64Bytes(base64([0, 1, 254, 255, 128]))]).toEqual([0, 1, 254, 255, 128]);
    expect([...base64Bytes(base64(tombstone))]).toEqual(tombstone);
    expect([...base64Bytes('AAEC!AAA')]).toEqual([0, 1, 2]);
  });

  it('an ANR keeps the main thread: its state, the lock it waits for and a few native frames on top', () => {
    const main = mainThreadOf(anrTrace);
    expect(main.state).toBe('Blocked');
    expect(main.waiting).toContain('held by thread 23');
    expect(main.frames.filter((f) => f.includes('libc.so'))).toHaveLength(4);
    expect(main.frames).toContain('at com.whombat.live.LiveNotifications.show(LiveNotifications.kt:91)');
    expect(main.frames.some((f) => f.includes('libreactnative.so'))).toBe(true);
    expect(main.frames.join('\n')).not.toMatch(/\/|not\.the\.Main|r4nd0m/);

    const [note] =
      notesOfExit(
        exit({
          reason: 'anr',
          description: `Input dispatching timed out (${secret})`,
          trace: anrTrace,
        }),
        input,
      ) ?? [];
    expect(note).toMatchObject({ name: ANDROID_EXIT_NAMES.anr, kind: 'app' });
    expect(note?.message).toContain(anrKind('Input dispatching timed out') ?? '?');
    for (const s of SECRETS) expect(JSON.stringify(note)).not.toContain(s);
    expect(note?.message).toContain('main thread Blocked');
    expect(AppErrorNote.safeParse(note).success).toBe(true);
  });

  it('an ANR’s description is kept only as its kind, from Android’s fixed words', () => {
    expect(anrKind('Broadcast of Intent { act=x }')).toBeTruthy();
    expect(anrKind(secret)).toBeNull();
    const [note] = notesOfExit(exit({ reason: 'anr', description: secret }), input) ?? [];
    for (const s of SECRETS) expect(JSON.stringify(note)).not.toContain(s);
    for (const reason of ['crash', 'low_memory']) {
      const [other] = notesOfExit(exit({ reason, description: secret }), input) ?? [];
      for (const s of SECRETS) expect(JSON.stringify(other)).not.toContain(s);
    }
  });

  it('an ending for memory is noted only while the app was on screen', () => {
    expect(notesOfExit(exit({ reason: 'low_memory', importance: 100 }), input)?.[0]?.name).toBe(
      ANDROID_EXIT_NAMES.lowMemory,
    );
    expect(notesOfExit(exit({ reason: 'low_memory', importance: 200 }), input)).toHaveLength(1);
    expect(notesOfExit(exit({ reason: 'low_memory', importance: 400 }), input)).toEqual([]);
    expect(notesOfExit(exit({ reason: 'low_memory', importance: null }), input)).toEqual([]);
  });

  it('a crash a JavaScript error of that run explains is let go; one without is noted', () => {
    const js: AppErrorNote = {
      at: new Date(at - 800).toISOString(),
      build: 'android 3.140.0 (3140000)',
      kind: 'app',
      name: 'TypeError',
      message: 'x is undefined',
      stack: [],
      components: null,
    };
    expect(notesOfExit(exit({ reason: 'crash' }), { ...input, pending: [js] })).toEqual([]);
    const older = { ...js, at: new Date(at - 120_000).toISOString() };
    expect(notesOfExit(exit({ reason: 'crash' }), { ...input, pending: [older] })?.[0]?.name).toBe(
      ANDROID_EXIT_NAMES.crash,
    );
    const anotherEnding = { ...js, name: ANDROID_EXIT_NAMES.lowMemory };
    expect(notesOfExit(exit({ reason: 'crash' }), { ...input, pending: [anotherEnding] })).toHaveLength(1);
  });

  it('lets go of endings older than a week, keeps text that isn’t one, and names this build when the ending has none', () => {
    expect(notesOfExit(exit({ timestamp: now.getTime() - EXIT_MAX_AGE_MS - 1 }), input)).toEqual([]);
    expect(notesOfExit('not json', input)).toBeNull();
    expect(notesOfExit(exit({ reason: 'user_requested' }), input)).toBeNull();
    expect(notesOfExit(exit({ build: null }), input)?.[0]?.build).toBe(input.build);
  });
});
