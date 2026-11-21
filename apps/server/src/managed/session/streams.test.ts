import { describe, expect, it, vi } from 'vitest';
import type { Frame } from '../ports';
import { STREAM_RESET } from '../ports';
import { LengthFramer, SendBudget, SessionStream, StreamReset } from './streams';

function harness(options: ConstructorParameters<typeof SessionStream>[2] = {}) {
  const sent: Frame[] = [];
  const stream = new SessionStream(1, async (f) => void sent.push(f), options);
  const dataBytes = () =>
    sent
      .filter((f): f is Extract<Frame, { type: 'data' }> => f.type === 'data')
      .reduce((n, f) => n + f.payload.length, 0);
  return { stream, sent, dataBytes };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('session streams', () => {
  it('sends only what the peer credited, in DATA frames of at most 64 KiB', async () => {
    const { stream, sent, dataBytes } = harness({ initialSendCredit: 100_000 });
    const writing = stream.write(new Uint8Array(300_000));
    await tick();
    expect(dataBytes()).toBe(100_000);
    expect(sent.every((f) => f.type !== 'data' || f.payload.length <= 65_536)).toBe(true);
    expect(stream.receive({ type: 'credit', streamId: 1, credit: 150_000 })).toBeNull();
    await tick();
    expect(dataBytes()).toBe(250_000);
    stream.receive({ type: 'credit', streamId: 1, credit: 50_000 });
    await writing;
    expect(dataBytes()).toBe(300_000);
  });

  it('keeps the connection-wide in-flight bytes under the budget across streams', async () => {
    const budget = new SendBudget(100_000);
    const a = harness({ initialSendCredit: 1_000_000, budget });
    const b = harness({ initialSendCredit: 1_000_000, budget });
    void a.stream.write(new Uint8Array(80_000));
    void b.stream.write(new Uint8Array(80_000));
    await tick();
    expect(a.dataBytes() + b.dataBytes()).toBe(100_000);
    // Credit from the peer returns budget.
    a.stream.receive({ type: 'credit', streamId: 1, credit: 80_000 });
    await tick();
    expect(a.dataBytes() + b.dataBytes()).toBe(160_000);
  });

  it('grants credit back only after the consumer handled the bytes, and refuses DATA beyond the window', async () => {
    const { stream, sent } = harness({ window: 1000 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stream.onData(async () => {
      await gate;
    });
    expect(stream.receive({ type: 'data', streamId: 1, payload: new Uint8Array(600) })).toBeNull();
    expect(stream.receive({ type: 'data', streamId: 1, payload: new Uint8Array(600) })).toBe(
      STREAM_RESET.flowControl,
    );
    await tick();
    expect(sent.filter((f) => f.type === 'credit')).toHaveLength(0);
    release();
    await tick();
    expect(sent.filter((f) => f.type === 'credit')).toEqual([{ type: 'credit', streamId: 1, credit: 600 }]);
  });

  it('a reset ends waiting writers', async () => {
    const { stream } = harness({ initialSendCredit: 0 });
    const writing = stream.write(new Uint8Array(10));
    stream.receive({ type: 'reset', streamId: 1, code: STREAM_RESET.cancelled });
    await expect(writing).rejects.toBeInstanceOf(StreamReset);
  });

  it.each(['peer reset', 'local reset', 'connection close'] as const)(
    'cleans up resources acquired after a %s during asynchronous setup',
    async (how) => {
      const { stream } = harness();
      if (how === 'peer reset') stream.receive({ type: 'reset', streamId: 1, code: STREAM_RESET.cancelled });
      else if (how === 'local reset') await stream.reset(STREAM_RESET.cancelled);
      else stream.abort();

      const cleanup = vi.fn();
      stream.onReset(cleanup);
      expect(cleanup).toHaveBeenCalledExactlyOnceWith(STREAM_RESET.cancelled);
    },
  );

  it('frames messages that span DATA frames', () => {
    const framer = new LengthFramer(10);
    const a = LengthFramer.encode(new Uint8Array([1, 2, 3]));
    const b = LengthFramer.encode(new Uint8Array([4]));
    const joined = new Uint8Array([...a, ...b]);
    expect(framer.push(joined.subarray(0, 5))).toEqual([]);
    expect(framer.push(joined.subarray(5))).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array([4])]);
    expect(() => framer.push(LengthFramer.encode(new Uint8Array(11)))).toThrow(StreamReset);
  });
});
