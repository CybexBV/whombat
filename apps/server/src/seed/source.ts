/**
 * Where `pnpm db:seed` gets its world. When `@whombat/fixtures` exports `seedWorld(): SeedWorld` (or a
 * `SEED_WORLD` object) that is used — the full mock world; until then the built-in test world is.
 *
 * The fixtures are imported statically (MR-76). A dynamic `import()` made esbuild wrap them, and everything they
 * import (`@whombat/core` among it), in lazy initialisers; a module that read one of core's exports while loading then
 * found it undefined, and a release's server failed at start.
 */
import * as fixtures from '@whombat/fixtures';
import { testWorld } from './test-world';
import type { SeedWorld } from './world';

export async function seedWorldSource(): Promise<{ world: SeedWorld; source: string }> {
  const f = fixtures as unknown as Record<string, unknown>;
  try {
    if (typeof f.seedWorld === 'function') {
      return { world: (await f.seedWorld()) as SeedWorld, source: '@whombat/fixtures seedWorld()' };
    }
    if (f.SEED_WORLD && typeof f.SEED_WORLD === 'object') {
      return { world: f.SEED_WORLD as SeedWorld, source: '@whombat/fixtures SEED_WORLD' };
    }
  } catch {
    // A fixtures world that can't be built: fall through to the test world.
  }
  return { world: testWorld(), source: 'built-in test world (apps/server/src/seed/test-world.ts)' };
}
