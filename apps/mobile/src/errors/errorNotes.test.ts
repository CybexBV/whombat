import { APP_ERROR_NOTES_MAX, AppErrorNote } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import { createSyncLog } from '../data/syncLog';
import {
  createErrorNotes,
  createNoteSender,
  createQuietNotes,
  createRejectionHold,
  keepNewest,
  type NoteFile,
  noteLine,
  noteOfCaught,
  noteOfQuiet,
  noteOfReported,
  QUIET_NAMES,
  QUIET_NOTES_PER_RUN,
  REJECTION_HOLD_MS,
  type ReportedError,
} from './errorNotes';

function memoryFile(initial: string | null = null): NoteFile & { text: string | null } {
  const f = {
    text: initial,
    read: () => f.text,
    write: (t: string) => {
      f.text = t;
    },
    remove: () => {
      f.text = null;
    },
  };
  return f;
}

const at = new Date('2026-11-13T14:47:43.999Z');
const build = 'ios 3.117.1 (3117001)';

describe('noteOfReported', () => {
  it('keeps the error’s own words, its frames and its components, within the contract', () => {
    const note = noteOfReported(
      {
        message:
          'TypeError: undefined is not a function\n\nThis error is located at:\n    in TabBar\n    in App',
        originalMessage: 'undefined is not a function',
        name: 'TypeError',
        componentStack: '\n    in TabBar (at App.tsx:3)\n    in App',
        stack: [
          { methodName: 'render', file: 'http://x/main.jsbundle', lineNumber: 1, column: 4242 },
          { methodName: null, file: null, lineNumber: null, column: null },
        ],
        isFatal: true,
      },
      { build, at, kind: 'app' },
    );
    expect(AppErrorNote.parse(note)).toEqual(note);
    expect(note).toMatchObject({
      kind: 'app',
      name: 'TypeError',
      message: 'undefined is not a function',
      build,
    });
    expect(note.at).toBe(at.toISOString());
    expect(note.stack[0]).toContain('main.jsbundle:1:4242');
    expect(note.components).toBe('TabBar < App');
  });

  it('cuts what is too long to send', () => {
    const note = noteOfReported(
      {
        message: 'x'.repeat(5000),
        stack: Array.from({ length: 50 }, () => ({ methodName: 'f'.repeat(500) })),
        isFatal: true,
      },
      { build, at, kind: 'app' },
    );
    expect(() => AppErrorNote.parse(note)).not.toThrow();
  });
});

describe('noteOfCaught', () => {
  it('notes a page’s error with its stack lines', () => {
    const error = new RangeError('Invalid time value');
    const note = noteOfCaught(error, '\n    in ChatScreen\n    in PageBoundary', { build, at });
    expect(AppErrorNote.parse(note)).toEqual(note);
    expect(note).toMatchObject({ kind: 'page', name: 'RangeError', message: 'Invalid time value' });
    expect(note.components).toBe('ChatScreen < PageBoundary');
  });

  it('names a frame’s file without the folders it is in', () => {
    const error = new Error('boom');
    error.stack = [
      'Error: boom',
      '    at anonymous (/private/var/containers/Bundle/Application/1A2B/Whombat.app/main.jsbundle:288000:38)',
      '    at run (http://localhost:8081/index.bundle?platform=ios:12:3)',
    ].join('\n');
    expect(noteOfCaught(error, null, { build, at }).stack).toEqual([
      'at anonymous (main.jsbundle:288000:38)',
      'at run (index.bundle?platform=ios:12:3)',
    ]);
  });

  it('takes a thrown value that isn’t an Error', () => {
    expect(noteOfCaught('boom', null, { build, at })).toMatchObject({
      name: null,
      message: 'boom',
      stack: [],
    });
  });
});

describe('error notes', () => {
  const note = (message: string) => noteOfCaught(new Error(message), null, { build, at });

  it('are written down at once and read back by the next run', () => {
    const file = memoryFile();
    createErrorNotes(file).add(note('one'));
    expect(
      createErrorNotes(file)
        .pending()
        .map((n) => n.message),
    ).toEqual(['one']);
  });

  it('keep the newest few', () => {
    const notes = createErrorNotes(memoryFile());
    for (let i = 0; i < APP_ERROR_NOTES_MAX + 3; i++) notes.add(note(String(i)));
    expect(notes.pending()).toHaveLength(APP_ERROR_NOTES_MAX);
    expect(notes.pending().at(-1)?.message).toBe(String(APP_ERROR_NOTES_MAX + 2));
  });

  it('start empty from a damaged file', () => {
    expect(createErrorNotes(memoryFile('{nope')).pending()).toEqual([]);
  });

  it('go once the box has them, and stay when sending failed', async () => {
    const file = memoryFile();
    const notes = createErrorNotes(file);
    notes.add(note('one'));
    await createNoteSender(notes, () => Promise.reject(new Error('offline')))();
    expect(notes.pending()).toHaveLength(1);
    const sent: string[][] = [];
    await createNoteSender(notes, async (batch) => sent.push(batch.map((n) => n.message)))();
    expect(sent).toEqual([['one']]);
    expect(notes.pending()).toEqual([]);
    expect(file.text).toBeNull();
  });

  it('keep a note added while a send was under way', async () => {
    const notes = createErrorNotes(memoryFile());
    notes.add(note('one'));
    const flush = createNoteSender(notes, async () => notes.add(note('two')));
    await flush();
    expect(notes.pending().map((n) => n.message)).toEqual(['two']);
  });
});

describe('an error React Native reports twice', () => {
  // The same fatal error can reach both of React Native's hooks (its JavaScript handler's decorator and the native
  // handler's listener, the only one called while the app's code loads).
  const fatal: ReportedError = {
    message: '[runtime not ready]: Error: boom',
    name: 'Error',
    stack: [{ methodName: 'loadModule', file: 'main.jsbundle', lineNumber: 1, column: 7 }],
    isFatal: true,
  };

  it('is noted once', () => {
    const notes = createErrorNotes(memoryFile());
    expect(notes.add(noteOfReported(fatal, { build, at, kind: 'app' }))).toBe(true);
    expect(notes.add(noteOfReported(fatal, { build, at: new Date(at.getTime() + 5), kind: 'app' }))).toBe(
      false,
    );
    expect(notes.pending()).toHaveLength(1);
  });

  it('and another error after it is its own note', () => {
    const notes = createErrorNotes(memoryFile());
    notes.add(noteOfReported(fatal, { build, at, kind: 'app' }));
    notes.add(noteOfReported({ ...fatal, message: 'Error: another' }, { build, at, kind: 'app' }));
    expect(notes.pending()).toHaveLength(2);
  });
});

describe('quiet errors', () => {
  const rejection = (words: string) =>
    noteOfQuiet(new TypeError(words), { build, at, name: QUIET_NAMES.rejection });
  const ending = (words: string) =>
    noteOfReported({ message: words, name: 'Error', isFatal: true }, { build, at, kind: 'app' });

  it('are notes the box takes: the app went on, the name says what it was', () => {
    const note = noteOfQuiet(new TypeError('x is undefined'), {
      build,
      at,
      name: QUIET_NAMES.listener,
      where: 'event',
    });
    expect(AppErrorNote.parse(note)).toEqual(note);
    expect(note).toMatchObject({ kind: 'page', name: 'ListenerError' });
    expect(note.message).toContain('event');
    expect(note.message).toContain('TypeError');
    expect(note.message).toContain('x is undefined');
    expect(noteOfQuiet({ code: 7 }, { build, at, name: QUIET_NAMES.rejection }).message).toContain('7');
    expect(() =>
      AppErrorNote.parse(noteOfQuiet('y'.repeat(5000), { build, at, name: QUIET_NAMES.rejection })),
    ).not.toThrow();
  });

  it('are noted once for the same words, and only the first few of a run', () => {
    const notes = createErrorNotes(memoryFile());
    const quiet = createQuietNotes(notes);
    quiet(rejection('same'));
    quiet(rejection('same'));
    expect(notes.pending()).toHaveLength(1);
    for (let i = 0; i < QUIET_NOTES_PER_RUN + 4; i++) quiet(rejection(`other ${i}`));
    expect(notes.pending()).toHaveLength(QUIET_NOTES_PER_RUN);
  });

  it('never push out an ending of the app', () => {
    const endings = Array.from({ length: APP_ERROR_NOTES_MAX - 1 }, (_, i) => ending(`ended ${i}`));
    const notes = createErrorNotes(memoryFile());
    for (const n of endings) notes.add(n);
    notes.add(rejection('first'));
    notes.add(rejection('second'));
    expect(notes.pending().map((n) => n.message)).toEqual([
      ...endings.map((n) => n.message),
      'TypeError: second',
    ]);
    // A full file of endings takes no quiet note at all, and says so.
    notes.add(ending('one more'));
    expect(notes.add(rejection('third'))).toBe(false);
    expect(notes.pending().every((n) => n.kind === 'app')).toBe(true);
    // Among endings the oldest goes.
    notes.add(ending('newest'));
    expect(notes.pending().map((n) => n.message)).not.toContain('ended 0');
    expect(keepNewest([rejection('a'), ending('b'), rejection('c')], 2).map((n) => n.message)).toEqual([
      'b',
      'TypeError: c',
    ]);
  });
});

describe('a note the box would refuse', () => {
  it('isn’t kept, so it can’t hold back the notes after it', () => {
    const notes = createErrorNotes(memoryFile());
    const good = noteOfCaught(new Error('fine'), null, { build, at });
    expect(notes.add({ ...good, message: 'x'.repeat(5000) })).toBe(false);
    expect(notes.add({ ...good, kind: 'quiet' as never })).toBe(false);
    expect(notes.pending()).toEqual([]);
  });

  it('isn’t read back from the file either', () => {
    const good = noteOfCaught(new Error('fine'), null, { build, at });
    const file = memoryFile(JSON.stringify([{ ...good, stack: 'not a list' }, good, 'junk']));
    expect(createErrorNotes(file).pending()).toEqual([good]);
  });
});

describe('noteLine', () => {
  it('says what it was, the build, its words and its first frames, in one line', () => {
    const line = noteLine(
      noteOfReported(
        {
          message: 'boom',
          name: 'Error',
          stack: [{ methodName: 'a', file: 'main.jsbundle', lineNumber: 1, column: 2 }],
          isFatal: true,
        },
        { build, at, kind: 'app' },
      ),
    );
    expect(line).toContain('app ended');
    expect(line).toContain(build);
    expect(line).toContain('Error: boom');
    expect(line).toContain('main.jsbundle:1:2');
    expect(line).not.toContain('\n');
  });

  it('of the longest note is still read back by the sync log after a restart', () => {
    const long = noteOfReported(
      {
        message: 'x'.repeat(5000),
        name: 'E'.repeat(200),
        stack: Array.from({ length: 5 }, () => ({ methodName: 'f'.repeat(500), file: 'main.jsbundle' })),
        isFatal: true,
      },
      { build, at, kind: 'app' },
    );
    const saved = [{ at: 1, text: noteLine(long) }];
    const next = createSyncLog();
    next.prepend(saved);
    expect(next.entries()).toEqual(saved);
  });
});

describe('a promise nobody caught', () => {
  const timers = {
    set: (run: () => void, ms: number) => setTimeout(run, ms),
    clear: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };

  it('is noted once it has stayed uncaught for a moment', () => {
    vi.useFakeTimers();
    const noted: unknown[] = [];
    const held = createRejectionHold((r) => noted.push(r), timers);
    held.unhandled(1, 'first');
    vi.advanceTimersByTime(REJECTION_HOLD_MS - 1);
    expect(noted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(noted).toEqual(['first']);
    // Told as handled after that: nothing more to do.
    held.handled(1);
    expect(noted).toEqual(['first']);
    vi.useRealTimers();
  });

  it('isn’t noted when someone caught it meanwhile', () => {
    vi.useFakeTimers();
    const noted: unknown[] = [];
    const held = createRejectionHold((r) => noted.push(r), timers);
    held.unhandled(1, 'caught late');
    held.unhandled(2, 'never caught');
    vi.advanceTimersByTime(REJECTION_HOLD_MS / 2);
    held.handled(1);
    vi.advanceTimersByTime(REJECTION_HOLD_MS);
    expect(noted).toEqual(['never caught']);
    vi.useRealTimers();
  });

  it('holds only a few at a time: the oldest is noted when more come', () => {
    vi.useFakeTimers();
    const noted: unknown[] = [];
    const held = createRejectionHold((r) => noted.push(r), timers, REJECTION_HOLD_MS, 2);
    held.unhandled(1, 'a');
    held.unhandled(2, 'b');
    held.unhandled(3, 'c');
    expect(noted).toEqual(['a']);
    vi.useRealTimers();
  });
});
