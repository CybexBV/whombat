/**
 * Whether a service really works (Whombat docs/decisions/service-works.md): a service can answer while what people use
 * it for is broken — Nextcloud opens but can't read files, Immich's page loads but photos don't. For a few kinds of
 * service Whombat has one read-only test that does what a person would (open a file, the newest photo, the newest
 * document, an item of a library, a sensor's new reading) and says where it got stuck. A run keeps only its result:
 * whether it passed, the step it stopped at, the service's answer code, how long it took. Never what it opened.
 *
 * The test watches only once the person turns its check on (`works.test`, a switch in What Whombat watches and the
 * page's Watch it); Run now works either way. Words are the server's (rendered on read in the person's language).
 */
import { z } from 'zod';
import { Timestamp } from './common.js';

/** The check a watched test raises its line under, and the switch that turns watching on. */
export const SERVICE_TEST_CHECK = 'works.test';

/** How often a watched test runs, in minutes: no more often than this, so a home server isn't kept busy. */
export const SERVICE_TEST_EVERY_MINUTES = 15;

/** The kinds of service Whombat can test, by catalog id. */
export const SERVICE_TEST_KINDS = [
  'nextcloud',
  'immich',
  'paperless',
  'jellyfin',
  'plex',
  'homeassistant',
] as const;
export type ServiceTestKind = (typeof SERVICE_TEST_KINDS)[number];

/** Whether Whombat has a test for a connection of this catalog id. */
export function hasServiceTest(catalogId: string): catalogId is ServiceTestKind {
  return (SERVICE_TEST_KINDS as readonly string[]).includes(catalogId);
}

/**
 * How a run ended: `ok` it did what a person would; `empty` it worked but found nothing to open yet (a new Nextcloud
 * without files); `broken` the service answered but failed a step; `access` the sign-in Whombat uses was refused at a
 * step (it expired or lost access, so the person must fix the connection); `down` the service stopped answering.
 */
export const SERVICE_TEST_OUTCOMES = ['ok', 'empty', 'broken', 'access', 'down'] as const;
export const ServiceTestOutcome = z.enum(SERVICE_TEST_OUTCOMES);
export type ServiceTestOutcome = z.infer<typeof ServiceTestOutcome>;

/** A run passed: it worked, or found nothing to open. */
export function serviceTestPassed(outcome: ServiceTestOutcome): boolean {
  return outcome === 'ok' || outcome === 'empty';
}

/** Who started a run: the watch (every 15 minutes), the person (Run now, Watch it) or the assistant (`service_test`). */
export const ServiceTestBy = z.enum(['watch', 'person', 'assistant']);
export type ServiceTestBy = z.infer<typeof ServiceTestBy>;

/** One run as the assistant reads it: when, how it ended, in words, and how long it took. */
export const ServiceTestRunView = z.object({
  at: Timestamp,
  outcome: ServiceTestOutcome,
  /** “It works — opened your newest photo in 0.4 s.”, “Nextcloud opens, but it can’t list your files (it answered 503).” */
  words: z.string().min(1).max(200),
  ms: z.number().int().min(0),
  by: ServiceTestBy,
});
export type ServiceTestRunView = z.infer<typeof ServiceTestRunView>;
