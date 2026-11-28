/**
 * The test card's buttons (docs/decisions/service-works.md): **Run now** runs the service's test and says how it went in
 * the toast; **Watch it** turns its check on in What Whombat watches (the same switch) and runs it once, **Stop
 * watching** turns it off. Neither changes anything on the service, so neither is a change in Activity, and both work on
 * a connection set to Look only.
 */
import { hasServiceTest, SERVICE_TEST_CHECK, SERVICE_TEST_EVERY_MINUTES, thingId } from '@whombat/core';
import type { ConnectionViewer } from '../connections/store';
import type { CatalogConnectionRow } from '../connections/types';
import { checkConnectionHealth } from '../home/health';
import { burrowLocale } from '../i18n/locale';
import { localizePhrase } from '../i18n/phrases';
import { badRequest, forbidden } from '../lib/errors';
import type { Services } from '../services';
import { displayName } from '../things/part-of';
import { setThingWatch } from '../things/quiet/service';
import { clip } from '../things/words';
import { WORKS_RUN, WORKS_WATCH } from './page';
import { runWords } from './rules';
import { runServiceTest } from './run';
import type { TestFetch } from './tests';

/** Whether a button is one of the test card's. */
export function isWorksAction(action: string): boolean {
  return action === WORKS_RUN || action === WORKS_WATCH;
}

/** What the toast says after a run: the run's sentence. */
async function runNow(
  services: Services,
  row: CatalogConnectionRow,
  by: 'person' | 'watch',
  fetch?: TestFetch,
): Promise<string | null> {
  const kind = row.catalogId;
  if (!hasServiceTest(kind)) return null;
  const run = await runServiceTest(services, row, { by, ...(fetch ? { fetch } : {}) });
  if (!run) return null;
  // The dot and Worth a look follow the run at once, not at the next pass.
  services.background.run('works: glance after a run', () => checkConnectionHealth(services, row));
  return runWords(kind, displayName(row), run);
}

/** Runs one of the test card's buttons for the person; the toast's words in their language. */
export async function worksAction(
  services: Services,
  viewer: ConnectionViewer,
  row: CatalogConnectionRow,
  input: { action: string; value?: unknown },
  timeZone: string,
  fetch?: TestFetch,
): Promise<{ message: string; refresh: true }> {
  if (viewer.principal.kind !== 'person') throw forbidden('Only you can use a page’s actions.');
  const said = async (words: string) => ({
    message: clip(localizePhrase(words, await burrowLocale(services, viewer.burrowId)), 200),
    refresh: true as const,
  });
  if (input.action === WORKS_RUN) {
    const words = await runNow(services, row, 'person', fetch);
    if (!words) throw badRequest('This has no such action.');
    return said(words);
  }
  if (typeof input.value !== 'boolean') throw badRequest('This has no such action.');
  await setThingWatch(
    services,
    viewer,
    thingId('connection', row.id),
    { check: SERVICE_TEST_CHECK, watched: input.value },
    timeZone,
  );
  if (!input.value) return said('Whombat stopped running this test.');
  // Turned on: the first run now, so the card shows a result straight away.
  const words = await runNow(services, row, 'watch', fetch);
  const first = `Whombat runs this test every ${SERVICE_TEST_EVERY_MINUTES} minutes now.`;
  return said(words ? `${first} ${words}` : first);
}
