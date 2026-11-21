/**
 * *This Whombat* on the glance (docs/decisions/desk-display.md DK-22, DK-24; desk-display-server.md DK-S31): the box's
 * own figures while the glance has no servers and no home tiles. The manager measures the box every 10 s; the runtime
 * reads its metrics with the power (`power.ts`, one call every 10 s while the screen shows the panel, never on the
 * console's 1 s path): the hour's points once, then only the points since the last one (`since`), kept here as one
 * window of the last hour. Core's `deskBox` makes the panel from the latest reading and that window.
 */
import type { HostDisks, HostNow, HostPoint, HostSeries } from '@whombat/protocol/session';

/** How far back the panel's chart goes (DK-22). */
export const BOX_HISTORY_MS = 3_600_000;

/**
 * What core's `deskBox` is made from (its `DeskBoxInput`): the manager's latest `HostMetrics` with the window as its
 * series, the last point ending now.
 */
export interface BoxReading {
  now: HostNow;
  disks: Pick<HostDisks, 'data'>;
  series: Pick<HostSeries, 'start' | 'stepS' | 'points'>;
}

/**
 * The last hour of the manager's points (oldest first, by when each starts), from a whole-hour read and then reads
 * `since` the end of the last point. Points come on the manager's step grid, so a gap stays a gap (null).
 */
export class HostSeriesWindow {
  #stepMs = 10_000;
  readonly #points = new Map<number, HostPoint | null>();
  /** When the last point the window has ends; null before the first read with points. */
  #until: number | null = null;

  /** What to ask for next: the end of the last point, or undefined for the whole hour (first, or after an hour away). */
  since(now: number): string | undefined {
    if (this.#until === null || now - this.#until > BOX_HISTORY_MS) return undefined;
    return new Date(this.#until).toISOString();
  }

  get empty(): boolean {
    return this.#until === null;
  }

  /** Adds a read's points (of the `hour` range) and forgets what is older than an hour. */
  add(series: HostSeries, now: number): void {
    if (series.range !== 'hour') return;
    const step = series.stepS * 1000;
    if (step !== this.#stepMs) {
      this.#points.clear();
      this.#until = null;
      this.#stepMs = step;
    }
    if (this.#until !== null && now - this.#until > BOX_HISTORY_MS) {
      this.#points.clear();
      this.#until = null;
    }
    const start = Date.parse(series.start);
    if (!Number.isFinite(start)) return;
    series.points.forEach((p, i) => {
      this.#points.set(start + i * step, p);
    });
    if (series.points.length > 0)
      this.#until = Math.max(this.#until ?? 0, start + series.points.length * step);
    for (const at of this.#points.keys()) if (at < now - BOX_HISTORY_MS) this.#points.delete(at);
  }

  /** The window as one series ending at the last point, at most an hour; null before the first read with points. */
  series(): BoxReading['series'] | null {
    if (this.#until === null) return null;
    const step = this.#stepMs;
    const end = this.#until;
    const oldest = this.#points.size ? Math.min(...this.#points.keys()) : end;
    const count = Math.max(0, Math.min(Math.round(BOX_HISTORY_MS / step), Math.round((end - oldest) / step)));
    const start = end - count * step;
    const points = Array.from({ length: count }, (_, i) => this.#points.get(start + i * step) ?? null);
    return { start: new Date(start).toISOString(), stepS: step / 1000, points };
  }
}
