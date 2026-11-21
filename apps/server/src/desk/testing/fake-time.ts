/**
 * A clock and its timers for the desk's tests (the camera's checks, desk-display-server.md DK-S37): `after` is the
 * loop's timer, `advance` moves the clock and runs what is due on the way, in order, letting each one's promises settle.
 * The time is read and written through the test's own clock, so a test that moves it by hand stays on the same one.
 */
export class FakeTime {
  #timers: { at: number; seq: number; fn: () => void }[] = [];
  #seq = 0;

  constructor(
    private readonly read: () => number,
    private readonly write: (ms: number) => void,
  ) {}

  get now(): number {
    return this.read();
  }

  after = (ms: number, fn: () => void): (() => void) => {
    const timer = { at: this.read() + ms, seq: this.#seq++, fn };
    this.#timers.push(timer);
    return () => {
      this.#timers = this.#timers.filter((t) => t !== timer);
    };
  };

  async advance(ms: number): Promise<void> {
    const end = this.read() + ms;
    for (;;) {
      await settle();
      const [due] = this.#timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq);
      if (!due) break;
      this.#timers = this.#timers.filter((t) => t !== due);
      this.write(Math.max(this.read(), due.at));
      due.fn();
    }
    this.write(end);
    await settle();
  }
}

/** A fake time of its own, from `start`. */
export function fakeTime(start = Date.parse('2026-10-20T12:00:00.000Z')): FakeTime {
  let now = start;
  return new FakeTime(
    () => now,
    (ms) => {
      now = ms;
    },
  );
}

/** Lets every promise started so far settle (one turn of the event loop). */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
