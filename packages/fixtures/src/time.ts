/**
 * The seed clock: Wednesday 23 September 2026, 11:22 Europe/Amsterdam (CEST, UTC+2).
 * Matches `packages/core/src/__fixtures__/world.ts` exactly so ids and timestamps line up.
 */
export const SEED_TIME_ZONE = 'Europe/Amsterdam';
export const SEED_NOW = new Date('2026-09-23T09:22:00.000Z');

/** `at('11:25')` → ISO instant on the seed day (23 Sep 2026, Europe/Amsterdam, UTC+2). */
export function at(hhmm: string, dayOffset = 0): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const d = new Date(Date.UTC(2026, 8, 23 + dayOffset, h - 2, m));
  return d.toISOString();
}
