/**
 * A voice typing recording over the session's upload stream: in memory, never resumed, each chunk
 * and the whole recording checked against their sha256, turned into text at END, and why not as the upload's error.
 * The stream is the session's own (`SessionStream`), fed the frames a client sends.
 */
import { createHash } from 'node:crypto';
import type { Chunk, StreamSpec } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { DictationError } from '../voice/service';
import { fakeRecording } from '../voice/testing/fake-voice';
import { STREAM_RESET } from './ports';
import { receiveDictation, type StreamContext } from './resources';
import { SessionStream } from './session/streams';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const CHUNK = 65_536;
const ID = 3;

type Sent = Record<string, unknown> & { t: string };
type Dictate = (audio: Buffer, signal: AbortSignal) => Promise<unknown>;

function upload(recording: Buffer, dictate: Dictate, options: { sha256?: string } = {}) {
  const sent: Sent[] = [];
  const resets: number[] = [];
  const ends: number[] = [];
  const waiting = new Set<() => void>();
  const changed = () => {
    for (const w of [...waiting]) w();
  };
  const stream = new SessionStream(ID, async (frame) => {
    if (frame.type === 'reset') resets.push(frame.code);
    if (frame.type === 'end') ends.push(frame.streamId);
    changed();
  });
  const ctx = {
    services: { log: { info() {}, warn() {}, debug() {} } },
    principal: {},
    stream,
    send: async (m: Sent) => {
      sent.push(m);
      changed();
    },
  } as unknown as StreamContext;
  const spec = {
    kind: 'upload',
    target: { type: 'dictation', burrow: 'burrow-hq' },
    size: recording.length,
    sha256: options.sha256 ?? sha(recording),
    chunkSize: CHUNK,
  } as Extract<StreamSpec, { kind: 'upload' }>;
  let released = 0;
  const opened = receiveDictation(ctx, spec, dictate as never, () => {
    released++;
    changed();
  });
  const chunk = (index: number, bytes: Buffer, hash = sha(bytes)): void => {
    const announced: Chunk = { index, offset: index * CHUNK, size: bytes.length, sha256: hash } as Chunk;
    opened.onChunk?.(announced);
    stream.receive({ type: 'data', streamId: ID, payload: bytes });
  };
  return {
    opened,
    sent,
    resets,
    ends,
    stream,
    released: () => released,
    chunk,
    /** Every chunk of the recording, then END. */
    all(): void {
      for (let i = 0; i * CHUNK < recording.length; i++)
        chunk(i, recording.subarray(i * CHUNK, (i + 1) * CHUNK));
      stream.receive({ type: 'end', streamId: ID });
    },
    /** Until `done` holds (checked now and after every message or frame the stream sends). */
    until(done: () => boolean): Promise<void> {
      return new Promise((resolve) => {
        const check = () => {
          if (!done()) return;
          waiting.delete(check);
          resolve();
        };
        waiting.add(check);
        check();
      });
    },
  };
}

describe('a voice typing recording', () => {
  it('is kept in memory, acknowledged chunk by chunk and answered with its text at END', async () => {
    const recording = fakeRecording(3);
    let heard: Buffer | null = null;
    const u = upload(recording, async (audio) => {
      heard = Buffer.from(audio);
      return { text: 'Is pve-02 okay?', seconds: 3, model: 'parakeet' };
    });
    // Never resumed: nothing was received before.
    expect(u.opened.meta).toEqual({ kind: 'upload', received: 0, chunkSize: CHUNK });
    u.all();
    await u.until(() => u.released() > 0);
    expect(u.ends).toEqual([ID]);
    expect(u.sent.filter((m) => m.t === 'chunk_ack').map((m) => m.index)).toEqual([0, 1]);
    expect(u.sent.find((m) => m.t === 'stream_done')).toMatchObject({
      stream: ID,
      size: recording.length,
      sha256: sha(recording),
      output: { text: 'Is pve-02 okay?', seconds: 3, model: 'parakeet' },
    });
    expect(heard && sha(heard)).toBe(sha(recording));
    expect(u.released()).toBe(1);
  });

  it('refuses a chunk that doesn’t match its sha256', async () => {
    const recording = fakeRecording(1);
    let asked = false;
    const u = upload(recording, async () => {
      asked = true;
      return { text: '', seconds: 1, model: 'parakeet' };
    });
    u.chunk(0, recording, sha(Buffer.from('something else')));
    await u.until(() => u.resets.length > 0);
    expect(u.resets).toEqual([STREAM_RESET.integrity]);
    expect(u.sent.find((m) => m.t === 'error')).toMatchObject({
      details: { code: 'upload_integrity', index: 0 },
    });
    expect(asked).toBe(false);
    expect(u.released()).toBe(1);
  });

  it('refuses a recording that doesn’t match its sha256', async () => {
    const recording = fakeRecording(1);
    const u = upload(recording, async () => ({ text: '', seconds: 1, model: 'parakeet' }), {
      sha256: sha(Buffer.from('another recording')),
    });
    u.all();
    await u.until(() => u.resets.length > 0);
    expect(u.resets).toEqual([STREAM_RESET.integrity]);
    expect(u.sent.find((m) => m.t === 'error')).toMatchObject({ details: { code: 'upload_integrity' } });
  });

  it('says why it wasn’t turned into text, under the session’s code', async () => {
    const cases = [
      ['dictation_off', 'conflict'],
      ['not_ready', 'unavailable'],
      ['busy', 'unavailable'],
      ['bad_audio', 'bad_request'],
      ['too_long', 'too_large'],
      ['failed', 'internal'],
    ] as const;
    for (const [why, code] of cases) {
      const u = upload(fakeRecording(1), async () => {
        throw new DictationError(why);
      });
      u.all();
      await u.until(() => u.resets.length > 0);
      expect(u.sent.find((m) => m.t === 'error')).toMatchObject({
        stream: ID,
        code,
        retryable: why === 'busy',
        details: { code: why },
      });
      expect(u.sent.some((m) => m.t === 'stream_done')).toBe(false);
      expect(u.released()).toBe(1);
    }
  });

  it('stops waiting for the text when the client lets it go, and tells nobody', async () => {
    let signal: AbortSignal | null = null;
    let started = () => {};
    const asked = new Promise<void>((resolve) => {
      started = resolve;
    });
    const u = upload(fakeRecording(1), (_audio, s) => {
      signal = s;
      started();
      return new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(new Error('gone'))));
    });
    u.all();
    await asked;
    u.stream.receive({ type: 'reset', streamId: ID, code: STREAM_RESET.cancelled });
    await u.until(() => u.released() > 0);
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    await Promise.resolve();
    expect(u.sent.filter((m) => m.t === 'error' || m.t === 'stream_done')).toEqual([]);
    expect(u.released()).toBe(1);
  });

  it('refuses chunks out of order, and an END before the whole recording', async () => {
    const recording = fakeRecording(3);
    const skipped = upload(recording, async () => ({ text: '', seconds: 3, model: 'parakeet' }));
    skipped.chunk(1, recording.subarray(CHUNK, CHUNK * 2));
    await skipped.until(() => skipped.resets.length > 0);
    expect(skipped.resets).toEqual([STREAM_RESET.protocolError]);

    const short = upload(recording, async () => ({ text: '', seconds: 3, model: 'parakeet' }));
    short.chunk(0, recording.subarray(0, CHUNK));
    short.stream.receive({ type: 'end', streamId: ID });
    await short.until(() => short.resets.length > 0);
    expect(short.resets).toEqual([STREAM_RESET.protocolError]);
    expect(short.released()).toBe(1);
  });
});
