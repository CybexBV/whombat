import { AppErrorNote } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { notesOfPayload } from './diagnostics';
import { createOpenMarker, ENDED_WHILE_OPEN, noteOfLeftover, type OpenMark } from './endedWhileOpen';
import { type NoteFile, noteOfReported } from './errorNotes';

function memoryFile(): NoteFile & { text: string | null } {
  const f = {
    text: null as string | null,
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

const build = 'ios 3.129.2 (3129002)';
const t = (seconds: number) => new Date(Date.parse('2026-11-17T10:00:00.000Z') + seconds * 1000);
const fatalAt = (when: Date) =>
  noteOfReported({ message: 'boom', name: 'Error', isFatal: true }, { build, at: when, kind: 'app' });

describe('the app ended while it was open', () => {
  it('is noted at the next start, with how long it was open, where, and what iOS said about memory', () => {
    const file = memoryFile();
    const first = createOpenMarker(file, build);
    first.active(t(0));
    first.seen(t(20), 'Chat');
    first.memoryWarning(t(80));
    // …and the app is gone without another word. The next run:
    const left = createOpenMarker(file, build).leftover();
    const note = noteOfLeftover(left, []);
    expect(AppErrorNote.parse(note)).toEqual(note);
    expect(note).toMatchObject({ kind: 'app', name: ENDED_WHILE_OPEN, build, at: t(80).toISOString() });
    expect(note?.message).toContain('80 s');
    expect(note?.message).toContain('Chat');
    expect(note?.message).toContain('warned about memory');
    expect(note?.message).not.toContain('no memory warning');
  });

  it('isn’t noted when the app had gone to the background', () => {
    const file = memoryFile();
    const marker = createOpenMarker(file, build);
    marker.active(t(0));
    marker.inactive(t(5));
    marker.background();
    expect(file.text).toBeNull();
    expect(noteOfLeftover(createOpenMarker(file, build).leftover(), [])).toBeNull();
    // Nothing is written while it is away: a timer still running there doesn't bring the mark back.
    marker.seen(t(60), 'Home');
    marker.memoryWarning(t(61));
    expect(file.text).toBeNull();
  });

  it('counts while the app is on screen but not the active one, and says it may have been swiped away', () => {
    const file = memoryFile();
    const marker = createOpenMarker(file, build);
    marker.active(t(0));
    marker.inactive(t(30));
    marker.seen(t(60));
    const note = noteOfLeftover(createOpenMarker(file, build).leftover(), []);
    expect(note?.message).toContain(`inactive since ${t(30).toISOString()}`);
    expect(note?.message).toContain('swiped away');
    // Active again clears that.
    marker.active(t(90));
    expect(noteOfLeftover(createOpenMarker(file, build).leftover(), [])?.message).not.toContain(
      'inactive since',
    );
  });

  it('isn’t a second note when the app’s own error was noted in that run', () => {
    const mark: OpenMark = {
      build,
      since: t(0).toISOString(),
      seen: t(40).toISOString(),
      route: 'Chat',
      memoryWarning: false,
      inactiveSince: null,
    };
    expect(noteOfLeftover(mark, [fatalAt(t(41))])).toBeNull();
    // An error of an earlier run, or one the app went on after, explains nothing.
    expect(noteOfLeftover(mark, [fatalAt(t(-3600))])).not.toBeNull();
    expect(noteOfLeftover(mark, [{ ...fatalAt(t(41)), kind: 'page' }])).not.toBeNull();
  });

  it('is still noted when iOS’s report of an earlier ending arrived during that run', () => {
    const mark: OpenMark = {
      build,
      since: t(0).toISOString(),
      seen: t(40).toISOString(),
      route: 'Chat',
      memoryWarning: false,
      inactiveSince: null,
    };
    // Noted with the time they arrived, and still waiting to be sent (the phone was offline).
    const late = notesOfPayload(
      JSON.stringify({
        crashDiagnostics: [{ diagnosticMetaData: { signal: 11 } }],
        applicationExitMetrics: { foregroundExitData: { cumulativeAppWatchdogExitCount: 1 } },
      }),
      { build, at: t(10) },
    );
    expect(late?.map((n) => n.kind)).toEqual(['app', 'app']);
    expect(noteOfLeftover(mark, late ?? [])).not.toBeNull();
    // Nor does an earlier “ended while open” explain this one.
    const earlier = noteOfLeftover({ ...mark, seen: t(5).toISOString() }, []);
    expect(noteOfLeftover(mark, earlier ? [{ ...earlier, at: t(5).toISOString() }] : [])).not.toBeNull();
  });

  it('is taken once: the next start after it finds nothing', () => {
    const file = memoryFile();
    createOpenMarker(file, build).active(t(0));
    const next = createOpenMarker(file, build);
    expect(next.leftover()).not.toBeNull();
    expect(next.leftover()).toBeNull();
  });

  it('reads a damaged or foreign file as nothing', () => {
    const file = memoryFile();
    file.text = '{nope';
    expect(createOpenMarker(file, build).leftover()).toBeNull();
    file.text = JSON.stringify({ since: 'yesterday', seen: 'today' });
    expect(noteOfLeftover(createOpenMarker(file, build).leftover(), [])).toBeNull();
  });
});
