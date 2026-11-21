/**
 * A demo job's progress (job-view.md): `@whombat/fixtures`' `jobFixture` in that state, its pull request as this
 * repository's `#number`. Pure TypeScript.
 */
import { type JobFixture, type JobFixtureState, jobFixture } from '@whombat/fixtures';

export function jobOf(
  state: JobFixtureState,
  madeMs: number,
  minutesAgo: number,
  pr: number | null,
): JobFixture {
  const fixture = jobFixture(state, madeMs, minutesAgo);
  if (!pr) return fixture;
  const url = `https://github.com/acmehq/whombat/pull/${pr}`;
  return {
    ...fixture,
    pullRequest: fixture.pullRequest ? { ...fixture.pullRequest, number: pr, url } : null,
    pullRequests: fixture.pullRequests.length ? [url] : [],
    changes: fixture.changes ? { ...fixture.changes, url: `${url}/files` } : null,
  };
}
