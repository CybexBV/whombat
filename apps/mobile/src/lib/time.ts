/**
 * Time zones and the app clock. Pure (no React Native imports) so it is unit-tested in Node.
 *
 * Times are shown in the viewer's preferred zone, else the burrow's, else the device's — the same order
 * as the web app. `@whombat/core` formats with `Intl.DateTimeFormat` + `formatToParts` and an explicit
 * IANA zone; Hermes supports both on Android, and `isUsableTimeZone` guards against engines (or zone
 * names) that do not.
 */

const PROBE = new Date('2026-09-23T09:22:00.000Z');

/** True when this engine formats `zone` with `formatToParts` (probed once per zone). */
export function isUsableTimeZone(zone: string): boolean {
  const cached = usable.get(zone);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    // Only a probe that the zone can be read; nothing is shown, so the language doesn't matter.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      hour: 'numeric',
      minute: 'numeric',
    }).formatToParts(PROBE);
    ok = parts.some((p) => p.type === 'hour') && parts.some((p) => p.type === 'minute');
  } catch {
    ok = false;
  }
  usable.set(zone, ok);
  return ok;
}
const usable = new Map<string, boolean>();

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The first usable zone of the candidates (preference, burrow, device), else UTC. */
export function resolveTimeZone(candidates: readonly (string | null | undefined)[]): string {
  for (const zone of candidates) if (zone && isUsableTimeZone(zone)) return zone;
  return 'UTC';
}

/**
 * The app clock. Against a server it is the real clock. The fixture world is frozen at its seed moment
 * (Wednesday 23 September 2026, 11:22 Amsterdam), so the demo clock starts there and runs forward from
 * app start: "just now" after deciding still reads right and times stay on the seed day.
 */
export function createClock(anchor: Date | null, started: number = Date.now()): () => Date {
  if (!anchor) return () => new Date();
  const base = anchor.getTime();
  return () => new Date(base + Math.max(0, Date.now() - started));
}
