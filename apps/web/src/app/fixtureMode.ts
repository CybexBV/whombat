/**
 * Fixture mode's door (`VITE_FIXTURES=1`, Storybook, tests, the visual suite): the mock world of `fixtureWorld.ts`. A
 * production build loads `export const fixtureMode = null` in place of this module (vite.config `noFixtureMode`,
 * docs/decisions/web-efficiency.md WE-02), so `@whombat/fixtures`, the app's `*Fixtures.ts` and the fake AI stay out of
 * what its pages load; only the hosted app's demo brings them, on demand (docs/app/decisions/look-around.md).
 */
import { type FixtureMode, fixtureWorld } from './fixtureWorld';

export type { FixtureMode } from './fixtureWorld';

export const fixtureMode: FixtureMode | null = fixtureWorld;
