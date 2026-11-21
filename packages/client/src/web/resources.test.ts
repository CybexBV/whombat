import { describe, expect, it } from 'vitest';
import { type ApplianceSession, type ResourceStream, StreamError } from '../session';
import { createObjectUrlCache } from './resources';

/** A session whose downloads fail with each error in `failures`, in turn, then succeed. */
function session(failures: Error[]) {
  let opens = 0;
  const bytes = new TextEncoder().encode('a photo');
  const s = {
    async openResource(): Promise<ResourceStream> {
      opens += 1;
      const failure = failures.shift();
      if (failure) throw failure;
      return {
        meta: { contentType: 'image/png', size: bytes.byteLength, name: 'a.png', sha256: null },
        chunks: (async function* () {
          yield bytes;
        })(),
        cancel() {},
      } as unknown as ResourceStream;
    },
  } as unknown as ApplianceSession;
  return { s, opens: () => opens };
}

const ref = { kind: 'attachment', burrow: 'b', attachmentId: 'att_1' } as const;

describe('object URL cache: a download whose connection dropped (open-speed.md AP-4403)', () => {
  it('is fetched once more, so the picture still comes', async () => {
    const { s, opens } = session([new StreamError('lost', 'The connection dropped (lost).')]);
    const cache = createObjectUrlCache(() => s);
    const entry = await cache.get(ref);
    expect(entry.size).toBe(7);
    expect(opens()).toBe(2);
  });

  it('is fetched only once more', async () => {
    const lost = () => new StreamError('lost', 'The connection dropped (lost).');
    const { s, opens } = session([lost(), lost()]);
    const cache = createObjectUrlCache(() => s);
    await expect(cache.get(ref)).rejects.toMatchObject({ code: 'lost' });
    expect(opens()).toBe(2);
  });

  it('is not fetched again for any other failure', async () => {
    const { s, opens } = session([new StreamError('not_found', 'Download failed (not_found).')]);
    const cache = createObjectUrlCache(() => s);
    await expect(cache.get(ref)).rejects.toMatchObject({ code: 'not_found' });
    expect(opens()).toBe(1);
  });
});

/** A session whose downloads wait until `finish()`; `cancelled()`: whether the first one was cancelled. */
function slowSession() {
  let finish = () => {};
  const done = new Promise<void>((r) => {
    finish = r;
  });
  const signals: (AbortSignal | undefined)[] = [];
  const bytes = new TextEncoder().encode('a photo');
  const s = {
    async openResource(_ref: unknown, options: { signal?: AbortSignal } = {}): Promise<ResourceStream> {
      const signal = options.signal;
      signals.push(signal);
      await done;
      if (signal?.aborted) throw new StreamError('cancelled', 'cancelled');
      return {
        meta: { contentType: 'image/png', size: bytes.byteLength, name: 'a.png', sha256: null },
        chunks: (async function* () {
          yield bytes;
        })(),
        cancel() {},
      } as unknown as ResourceStream;
    },
  } as unknown as ApplianceSession;
  return { s, finish, cancelled: () => !!signals[0]?.aborted, opens: () => signals.length };
}

describe('object URL cache: callers who stop waiting', () => {
  it('a caller who stops doesn’t cancel the download another caller waits for', async () => {
    const { s, finish, cancelled } = slowSession();
    const cache = createObjectUrlCache(() => s);
    const first = new AbortController();
    const one = cache.get(ref, { signal: first.signal });
    const two = cache.get(ref, { signal: new AbortController().signal });
    first.abort();
    await expect(one).rejects.toMatchObject({ name: 'AbortError' });
    finish();
    expect((await two).size).toBe(7);
    expect(cancelled()).toBe(false);
    expect(cache.peek(ref)?.size).toBe(7);
  });

  it('the download is cancelled once nobody waits for it, and the next caller starts afresh', async () => {
    const { s, finish, cancelled, opens } = slowSession();
    const cache = createObjectUrlCache(() => s);
    const a = new AbortController();
    const b = new AbortController();
    const one = cache.get(ref, { signal: a.signal });
    const two = cache.get(ref, { signal: b.signal });
    a.abort();
    expect(cancelled()).toBe(false);
    b.abort();
    expect(cancelled()).toBe(true);
    await expect(Promise.all([one, two])).rejects.toMatchObject({ name: 'AbortError' });
    const again = cache.get(ref);
    finish();
    expect((await again).size).toBe(7);
    expect(opens()).toBe(2);
  });

  it('a caller already stopped gets nothing and starts nothing', async () => {
    const { s, opens } = session([]);
    const cache = createObjectUrlCache(() => s);
    const stopped = new AbortController();
    stopped.abort();
    await expect(cache.get(ref, { signal: stopped.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(opens()).toBe(0);
  });
});
