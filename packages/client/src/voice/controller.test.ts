/**
 * The composer's voice typing (dictation.md DT-01, DT-08): where the words go in the draft (the cursor, a selection,
 * the spaces English and Dutch need), a transcript dropped when the draft changed, one recording at a time, Cancel,
 * the box's refusals and the microphone's.
 */
import type { DictationOutput } from '@whombat/core/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamError } from '../session/types';
import {
  MicrophoneError,
  resetVoiceTypingForTests,
  resolveTranscriptCommit,
  type VoiceDraft,
  type VoiceRecorder,
  type VoiceTranscribe,
  VoiceTypingController,
  type VoiceTypingDependencies,
  voiceTypingBusy,
} from './controller';
import { voiceTypingProblemOf } from './model';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

const WAV = new Uint8Array([1, 2, 3]);

class TestRecorder implements VoiceRecorder {
  options: Parameters<VoiceRecorder['start']>[0] | null = null;
  readonly start = vi.fn(async (o: Parameters<VoiceRecorder['start']>[0]) => {
    this.options = o;
  });
  readonly stop = vi.fn(async () => WAV);
  readonly cancel = vi.fn(async () => undefined);
}

function draft(overrides: Partial<VoiceDraft> = {}): VoiceDraft {
  return {
    ownerKey: 'chat',
    text: 'hello world',
    selection: { start: 11, end: 11 },
    revision: 1,
    ...overrides,
  };
}

const said = (text: string): DictationOutput => ({ text, seconds: 3, model: 'parakeet' });

function harness(overrides: Partial<VoiceTypingDependencies> = {}, initial: VoiceDraft | null = draft()) {
  const recorder = new TestRecorder();
  let current = initial;
  const commits: { text: string; selection: { start: number; end: number } }[] = [];
  const states: string[] = [];
  const transcribe = vi.fn<VoiceTranscribe>(async () => said('check the backups'));
  const deps: VoiceTypingDependencies = {
    recorder,
    getTranscriber: () => transcribe,
    readDraft: () => current,
    commitDraft: (text, selection) => commits.push({ text, selection }),
    onStateChange: (s) => states.push(s.phase),
    problemOf: voiceTypingProblemOf,
    maxSeconds: 300,
    now: () => 1_000,
    ...overrides,
  };
  return {
    controller: new VoiceTypingController(deps),
    recorder,
    transcribe,
    commits,
    states,
    setDraft: (next: VoiceDraft | null) => {
      current = next;
    },
  };
}

describe('resolveTranscriptCommit', () => {
  it('puts the words at the cursor with the spaces they need', () => {
    expect(resolveTranscriptCommit(draft(), draft(), 'and more')).toMatchObject({
      kind: 'commit',
      text: 'hello world and more',
      selection: { start: 20, end: 20 },
    });
    const start = draft({ text: 'world', selection: { start: 0, end: 0 } });
    expect(resolveTranscriptCommit(start, start, 'hello')).toMatchObject({ text: 'hello world' });
    const middle = draft({ text: 'hello  world', selection: { start: 6, end: 6 } });
    expect(resolveTranscriptCommit(middle, middle, 'big')).toMatchObject({ text: 'hello big world' });
    const empty = draft({ text: '', selection: { start: 0, end: 0 } });
    expect(resolveTranscriptCommit(empty, empty, '  Hoi  ')).toMatchObject({
      text: 'Hoi',
      selection: { start: 3 },
    });
  });

  it('spaces Dutch words and curly quotes as English ones, and adds none inside a word', () => {
    const dutch = draft({ text: 'Café', selection: { start: 4, end: 4 } });
    expect(resolveTranscriptCommit(dutch, dutch, 'is open')).toMatchObject({ text: 'Café is open' });
    const quoted = draft({ text: '“klaar”', selection: { start: 7, end: 7 } });
    expect(resolveTranscriptCommit(quoted, quoted, 'zei ze')).toMatchObject({ text: '“klaar” zei ze' });
    const inside = draft({ text: 'abcd', selection: { start: 2, end: 2 } });
    expect(resolveTranscriptCommit(inside, inside, 'X')).toMatchObject({ text: 'abXcd' });
  });

  it('replaces a selection as it is', () => {
    const text = 'Fix 🧪 then $review please';
    const at = text.indexOf('$review');
    const captured = draft({ text, selection: { start: at, end: at + 7 } });
    expect(resolveTranscriptCommit(captured, captured, 'look again')).toEqual({
      kind: 'commit',
      text: 'Fix 🧪 then look again please',
      selection: { start: at + 10, end: at + 10 },
    });
  });

  it('drops a transcript for a draft that changed, and says when nothing was heard', () => {
    const captured = draft();
    expect(resolveTranscriptCommit(captured, null, 'x').kind).toBe('stale');
    expect(resolveTranscriptCommit(captured, draft({ ownerKey: 'thread' }), 'x').kind).toBe('stale');
    expect(resolveTranscriptCommit(captured, draft({ text: 'hello' }), 'x').kind).toBe('stale');
    expect(resolveTranscriptCommit(captured, draft({ revision: 3 }), 'x').kind).toBe('stale');
    expect(resolveTranscriptCommit(captured, captured, '   ').kind).toBe('empty');
  });
});

describe('VoiceTypingController', () => {
  beforeEach(() => resetVoiceTypingForTests());

  it('records, sends the recording, and puts the words in the draft without sending it', async () => {
    const h = harness();
    await h.controller.start();
    expect(h.controller.currentState).toMatchObject({ phase: 'recording', since: 1_000 });
    expect(voiceTypingBusy(h.controller.currentState)).toBe(true);
    expect(h.recorder.options?.maxSeconds).toBe(300);
    await h.controller.stop();
    expect(h.transcribe).toHaveBeenCalledWith(
      WAV,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(h.commits).toEqual([{ text: 'hello world check the backups', selection: { start: 29, end: 29 } }]);
    expect(h.states).toEqual(['preparing', 'recording', 'transcribing', 'idle']);
  });

  it('drops the words when the draft changed while the person spoke', async () => {
    const h = harness();
    await h.controller.start();
    h.setDraft(draft({ text: 'hello world!', revision: 2 }));
    await h.controller.stop();
    expect(h.commits).toEqual([]);
    expect(h.controller.currentState).toMatchObject({ phase: 'error', problem: 'changed' });
  });

  it('says when nothing was heard', async () => {
    const h = harness();
    h.transcribe.mockResolvedValueOnce(said(''));
    await h.controller.start();
    await h.controller.stop();
    expect(h.controller.currentState.problem).toBe('nothing');
  });

  it('cancels a recording: the microphone stops and nothing is sent', async () => {
    const h = harness();
    await h.controller.start();
    h.controller.cancel();
    await vi.waitFor(() => expect(h.recorder.cancel).toHaveBeenCalled());
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.controller.currentState.phase).toBe('idle');
  });

  it('cancels while the box works: the upload is called off and its late answer dropped', async () => {
    const answer = deferred<DictationOutput>();
    const entered = deferred<AbortSignal>();
    const h = harness();
    h.transcribe.mockImplementationOnce(async (_wav, { signal }) => {
      entered.resolve(signal);
      return answer.promise;
    });
    await h.controller.start();
    const stopping = h.controller.stop();
    const signal = await entered.promise;
    h.controller.cancel();
    expect(signal.aborted).toBe(true);
    answer.resolve(said('too late'));
    await stopping;
    expect(h.commits).toEqual([]);
    expect(h.controller.currentState.phase).toBe('idle');
  });

  it('records once at a time across composers, and the next waits for a cancelled one to let go', async () => {
    const first = harness();
    const second = harness({}, draft({ ownerKey: 'thread' }));
    await first.controller.start();
    await second.controller.start();
    expect(second.controller.currentState).toMatchObject({ phase: 'error', problem: 'elsewhere' });
    first.controller.cancel();
    await vi.waitFor(() => expect(first.recorder.cancel).toHaveBeenCalled());
    await second.controller.start();
    expect(second.controller.currentState.phase).toBe('recording');
  });

  it('says why it can’t record instead of recording', async () => {
    const notReady = harness({ check: () => 'not_ready' });
    await notReady.controller.start();
    expect(notReady.controller.currentState.problem).toBe('not_ready');
    expect(notReady.recorder.start).not.toHaveBeenCalled();

    const denied = harness({ requestPermission: async () => ({ granted: false, canAskAgain: false }) });
    await denied.controller.start();
    expect(denied.controller.currentState.problem).toBe('microphone');
    expect(denied.recorder.start).not.toHaveBeenCalled();

    const refused = harness();
    refused.recorder.start.mockRejectedValueOnce(new MicrophoneError());
    await refused.controller.start();
    expect(refused.controller.currentState.problem).toBe('microphone');

    const nothing = harness({ getTranscriber: () => null });
    await nothing.controller.start();
    expect(nothing.controller.currentState.problem).toBe('not_ready');
  });

  it('shows the box’s reason and a lost connection', async () => {
    const busy = harness();
    busy.transcribe.mockRejectedValueOnce(new StreamError('internal', 'no', { code: 'busy' }));
    await busy.controller.start();
    await busy.controller.stop();
    expect(busy.controller.currentState.problem).toBe('busy');

    const lost = harness();
    lost.transcribe.mockRejectedValueOnce(new StreamError('lost', 'The connection dropped.'));
    await lost.controller.start();
    await lost.controller.stop();
    expect(lost.controller.currentState.problem).toBe('offline');
  });

  it('finishes by itself at the time limit and drops a recording whose microphone went', async () => {
    const limit = harness();
    await limit.controller.start();
    limit.recorder.options?.onEnd?.('limit');
    await vi.waitFor(() => expect(limit.commits).toHaveLength(1));

    const gone = harness();
    await gone.controller.start();
    gone.recorder.options?.onEnd?.('error');
    await vi.waitFor(() => expect(gone.controller.currentState.problem).toBe('interrupted'));
    expect(gone.transcribe).not.toHaveBeenCalled();
  });

  it('drops what goes on when the composer holds another draft, and clears a failure', async () => {
    const h = harness();
    await h.controller.start();
    h.controller.ownerChanged();
    expect(h.controller.currentState.phase).toBe('idle');
    const failing = harness({ check: () => 'not_ready' });
    await failing.controller.start();
    failing.controller.cancel();
    expect(failing.controller.currentState.phase).toBe('idle');
  });
});
