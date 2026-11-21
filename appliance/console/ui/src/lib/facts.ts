/**
 * Wombat facts in random order (CG-08, CG-10): a new shuffle of all of them each round, never the same fact
 * twice in a row across rounds, none repeated until every one was shown.
 */
export const FACT_EVERY_MS = 60_000;

export type Random = () => number;

/** Fisher–Yates over 0…n-1. */
export function shuffle(n: number, random: Random): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j] as number, a[i] as number];
  }
  return a;
}

export class FactRotation {
  private order: number[] = [];
  private last = -1;

  constructor(
    private readonly count: number,
    private readonly random: Random = Math.random,
  ) {}

  /** The next fact's index (-1 when there are none). */
  next(): number {
    if (this.count === 0) return -1;
    if (this.order.length === 0) {
      this.order = shuffle(this.count, this.random);
      // A new round never starts with the fact that ended the last one.
      if (this.count > 1 && this.order[0] === this.last) {
        this.order.push(this.order.shift() as number);
      }
    }
    this.last = this.order.shift() as number;
    return this.last;
  }
}
