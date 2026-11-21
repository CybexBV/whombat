import { AppErrorNote } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_NAMES, framesOf, notesOfPayload } from './diagnostics';

const input = { build: 'ios 3.130.0 (3130000)', at: new Date('2026-11-18T08:00:00.000Z') };

/** A stack as iOS nests it: each frame inside the one before. */
function nested(count: number): unknown {
  let frame: unknown;
  for (let i = count - 1; i >= 0; i -= 1) {
    frame = {
      binaryUUID: `70B89F27-1634-3580-A695-57CDB41D${String(7000 + i)}`,
      offsetIntoBinaryTextSegment: 1000 + i,
      binaryName: i === 0 ? 'Whombat' : 'UIKitCore',
      address: 74565 + i,
      ...(frame ? { subFrames: [frame] } : {}),
    };
  }
  return frame;
}

const tree = (frames: number) => ({
  callStackPerThread: true,
  callStacks: [
    {
      threadAttributed: false,
      callStackRootFrames: [{ binaryName: 'other', binaryUUID: 'X', offsetIntoBinaryTextSegment: 1 }],
    },
    { threadAttributed: true, callStackRootFrames: [nested(frames)] },
  ],
});

const diagnosticPayload = {
  timeStampBegin: '2026-11-17 09:00:00',
  timeStampEnd: '2026-11-17 09:30:00',
  crashDiagnostics: [
    {
      version: '1.0.0',
      callStackTree: tree(3),
      diagnosticMetaData: {
        appBuildVersion: '3129002',
        appVersion: '3.129.2',
        osVersion: 'iPhone OS 27.1 (25B80)',
        exceptionType: 1,
        exceptionCode: 0,
        signal: 11,
        terminationReason: 'Namespace SIGNAL, Code 0xb',
        virtualMemoryRegionInfo: '0 is not in any region.',
      },
    },
  ],
  hangDiagnostics: [
    {
      callStackTree: tree(2),
      diagnosticMetaData: { appBuildVersion: '3129002', appVersion: '3.129.2', hangDuration: '20 sec' },
    },
  ],
};

describe('what iOS reports about a crash', () => {
  const notes = notesOfPayload(JSON.stringify(diagnosticPayload), input) ?? [];

  it('is an ending of the app, with iOS’s reason, the build it was about and its frames', () => {
    const crash = notes.find((n) => n.name === DIAGNOSTIC_NAMES.crash);
    expect(AppErrorNote.parse(crash)).toEqual(crash);
    // The build iOS names, not the one that read the report: it can arrive after an update.
    expect(crash).toMatchObject({ kind: 'app', build: 'ios 3.129.2 (3129002)', at: input.at.toISOString() });
    expect(crash?.message).toContain('Namespace SIGNAL, Code 0xb');
    expect(crash?.message).toContain('signal 11');
    expect(crash?.message).toContain('2026-11-17 09:00:00');
    // The crashed thread's frames: a binary's name, its UUID and an offset, which a dSYM turns into names.
    expect(crash?.stack).toEqual([
      'Whombat 70B89F27-1634-3580-A695-57CDB41D7000 +1000',
      'UIKitCore 70B89F27-1634-3580-A695-57CDB41D7001 +1001',
      'UIKitCore 70B89F27-1634-3580-A695-57CDB41D7002 +1002',
    ]);
  });

  it('and a hang is something the app may have gone on after', () => {
    const hang = notes.find((n) => n.name === DIAGNOSTIC_NAMES.hang);
    expect(AppErrorNote.parse(hang)).toEqual(hang);
    expect(hang?.kind).toBe('page');
    expect(hang?.message).toContain('20 sec');
    expect(hang?.stack).toHaveLength(2);
  });

  it('keeps both ends of a long stack within what a note takes', () => {
    const frames = framesOf(tree(60));
    expect(frames).toHaveLength(20);
    expect(frames[0]).toContain('+1000');
    expect(frames.at(-1)).toContain('+1059');
  });
});

describe('the endings iOS counts in a day', () => {
  const metric = (foreground: object, background: object, more: object = {}) =>
    JSON.stringify({
      timeStampBegin: '2026-11-16 00:00:00',
      timeStampEnd: '2026-11-17 00:00:00',
      latestApplicationVersion: '3.128.0',
      metaData: { appBuildVersion: '3128000' },
      applicationExitMetrics: { foregroundExitData: foreground, backgroundExitData: background },
      ...more,
    });

  it('are one note naming the ones that weren’t ordinary: memory, not answering, a bad access', () => {
    const notes = notesOfPayload(
      metric(
        {
          cumulativeNormalAppExitCount: 9,
          cumulativeMemoryResourceLimitExitCount: 2,
          cumulativeAppWatchdogExitCount: 1,
          cumulativeBadAccessExitCount: 0,
        },
        {
          cumulativeMemoryPressureExitCount: 14,
          cumulativeAbnormalExitCount: 1,
          cumulativeNormalAppExitCount: 3,
        },
        { includesMultipleApplicationVersions: true },
      ),
      input,
    );
    expect(notes).toHaveLength(1);
    const note = notes?.[0];
    expect(AppErrorNote.parse(note)).toEqual(note);
    expect(note).toMatchObject({ kind: 'app', name: DIAGNOSTIC_NAMES.exits, build: 'ios 3.128.0 (3128000)' });
    expect(note?.message).toContain('MemoryResourceLimit 2');
    expect(note?.message).toContain('AppWatchdog 1');
    expect(note?.message).toContain('Abnormal 1');
    // Not the ordinary exits, nor iOS taking memory back from an app that wasn't in use.
    expect(note?.message).not.toContain('NormalApp');
    expect(note?.message).not.toContain('MemoryPressure');
    expect(note?.message).not.toContain('BadAccess');
    expect(note?.message).toContain('more than one app version');
  });

  it('name the build under whichever name iOS gave the version', () => {
    const payload = JSON.stringify({
      appVersion: '3.128.0',
      metaData: { appBuildVersion: '3128000' },
      applicationExitMetrics: { foregroundExitData: { cumulativeBadAccessExitCount: 1 } },
    });
    expect(notesOfPayload(payload, input)?.[0]?.build).toBe('ios 3.128.0 (3128000)');
  });

  it('are no note on a day of ordinary endings', () => {
    expect(
      notesOfPayload(
        metric({ cumulativeNormalAppExitCount: 9 }, { cumulativeMemoryPressureExitCount: 4 }),
        input,
      ),
    ).toEqual([]);
  });
});

describe('a payload it can’t read', () => {
  it('is told apart from one with nothing to tell, so it can be kept', () => {
    expect(notesOfPayload('{nope', input)).toBeNull();
    expect(notesOfPayload('[1, 2]', input)).toBeNull();
    expect(notesOfPayload('{}', input)).toEqual([]);
    // Shaped another way: fewer details, never an error.
    const odd = notesOfPayload(JSON.stringify({ crashDiagnostics: [{ callStackTree: 'gone' }, 7] }), input);
    expect(odd).toHaveLength(1);
    expect(AppErrorNote.parse(odd?.[0])).toEqual(odd?.[0]);
    expect(odd?.[0]).toMatchObject({ build: input.build, stack: [] });
  });
});
