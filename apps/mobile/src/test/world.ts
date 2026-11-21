/** Test helpers: the fixture world as the mobile view models see it (Mara at 11:22, Amsterdam). */
import { bootstrap, SEED_NOW, SEED_TIME_ZONE } from '@whombat/fixtures';
import { peopleFrom, type ViewContext, viewerOf } from '../data/people';

export function worldContext(now: Date = SEED_NOW): ViewContext {
  const b = bootstrap();
  return { people: peopleFrom(b.principals), viewer: viewerOf(b), now, timeZone: SEED_TIME_ZONE };
}

/** A minute after the seed moment. */
export function minutesAfterSeed(minutes: number): Date {
  return new Date(SEED_NOW.getTime() + minutes * 60_000);
}
