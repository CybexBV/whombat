/**
 * “Does it really work?” on a service's page (docs/decisions/service-works.md): the test in plain words with how its
 * last run went, and two buttons, **Run now** and **Watch it** (Stop watching once on). It is a list card with buttons,
 * so the web and the phone draw it as they draw every service's cards. While the test is watched and fails, its line is
 * in Worth a look too, the same one the health pass keeps for the dot.
 *
 * Both buttons work on Look only: the test only reads, and what Whombat watches is Whombat's own setting.
 */
import {
  hasServiceTest,
  SERVICE_TEST_CHECK,
  SERVICE_TEST_EVERY_MINUTES,
  serviceTestPassed,
  type ThingPageButton,
  type ThingPagePanel,
} from '@whombat/core';
import type { CatalogConnectionRow } from '../connections/types';
import type { ServiceTestRunRow } from '../db/schema/index';
import type { Services } from '../services';
import { displayName } from '../things/part-of';
import { checkWatched } from '../things/quiet/defaults';
import type { ThingQuiet } from '../things/quiet/store';
import type { KindNotice } from '../things/quiet/types';
import { clip } from '../things/words';
import { fresh, runWords, worksNotice } from './rules';
import { recentRuns } from './store';
import { SERVICE_TESTS } from './tests';

/** The page's buttons. */
export const WORKS_RUN = 'works_run';
export const WORKS_WATCH = 'works_watch';

/** The line before the first run. */
export const NOT_RUN =
  'Not run yet. Whombat only reads: it opens something as you would, and keeps only the result.';

/** A button of the test's card: every person may press it, Look only too. */
function button(spec: Omit<ThingPageButton, 'allowed'>): ThingPageButton {
  return { ...spec, allowed: true };
}

/** The card's line under its title: how often it runs, and how the last runs went. */
export function worksMeta(watched: boolean, runs: readonly Pick<ServiceTestRunRow, 'outcome'>[]): string {
  if (!watched) return 'Runs only when you ask';
  const every = `Every ${SERVICE_TEST_EVERY_MINUTES} minutes`;
  if (runs.length < 2) return every;
  const passed = runs.filter((r) => serviceTestPassed(r.outcome)).length;
  return `${every} · passed ${passed} of the last ${runs.length}`;
}

/** The card, from the test's runs (newest first) and whether it is watched. */
export function worksCard(
  row: Pick<CatalogConnectionRow, 'catalogId' | 'label' | 'fields'>,
  runs: readonly ServiceTestRunRow[],
  watched: boolean,
): Extract<ThingPagePanel, { kind: 'list' }> | null {
  if (!hasServiceTest(row.catalogId)) return null;
  const test = SERVICE_TESTS[row.catalogId];
  const last = runs[0];
  const tone = !last
    ? 'info'
    : serviceTestPassed(last.outcome)
      ? 'ok'
      : last.outcome === 'access'
        ? 'warn'
        : 'bad';
  return {
    kind: 'list',
    id: 'works',
    place: 'main',
    title: 'Does it really work?',
    meta: worksMeta(watched, runs),
    // On the card's head, not the line: a line with buttons is one of the service's own things, and its title would
    // stay as the service wrote it instead of in the person's language.
    buttons: [
      button({ action: WORKS_RUN, label: 'Run now', icon: 'play', tone: 'primary' }),
      button(
        watched
          ? { action: WORKS_WATCH, value: false, label: 'Stop watching' }
          : { action: WORKS_WATCH, value: true, label: 'Watch it', icon: 'check' },
      ),
    ],
    items: [
      {
        id: 'test',
        title: test.name,
        detail: last ? runWords(row.catalogId, displayName(row), last) : NOT_RUN,
        ...(last ? { at: last.at.toISOString() } : {}),
        tone,
        icon: last?.outcome === 'access' ? 'key' : test.icon,
      },
    ],
  };
}

/** What a page shows of the test: its card, and its line while it is watched and fails. */
export async function worksOnPage(
  services: Services,
  row: CatalogConnectionRow,
  quiet: ThingQuiet,
  now: Date,
  timeZone: string,
): Promise<{ panel: ThingPagePanel | null; line: KindNotice | null }> {
  if (!hasServiceTest(row.catalogId)) return { panel: null, line: null };
  const runs = await recentRuns(services.db, row.id);
  const watched = checkWatched(quiet, SERVICE_TEST_CHECK);
  const line =
    watched && fresh(runs, now)
      ? worksNotice(row.catalogId, clip(displayName(row), 80), runs, timeZone)
      : null;
  return { panel: worksCard(row, runs, watched), line };
}
