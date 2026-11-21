/** The demo world's address and burrow, and the burrow choice. Pure. */
import type { Membership } from '@whombat/core';

/** Origin the demo world's REST fixtures are addressed on (requests never leave the app). */
export const FIXTURE_ORIGIN = 'http://fixtures.whombat.local';
export const FIXTURE_BURROW = 'burrow-hq';

/**
 * How the app runs: `managed`, a Whombat over its end-to-end session; `fixtures`, the demo world on an in-memory box
 * (`EXPO_PUBLIC_WHOMBAT_MODE=fixtures`, hermes-engine-app.md AP-5370).
 */
export type AppMode = 'managed' | 'fixtures';

/** A demo build (`EXPO_PUBLIC_WHOMBAT_MODE=fixtures`): the demo world, never a Whombat. */
export const DEMO = process.env.EXPO_PUBLIC_WHOMBAT_MODE === 'fixtures';

/** The burrow to open: the saved one while it is still there, else the first. */
export function pickBurrow(memberships: readonly Membership[], saved: string | null): Membership | null {
  return memberships.find((m) => m.burrowSlug === saved) ?? memberships[0] ?? null;
}
