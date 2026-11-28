/**
 * What a service's test results mean (docs/decisions/service-works.md), pure: a run's sentence, when a watched test is
 * due, and its line in Worth a look. Words are English here and said in the person's language on the way out (the
 * phrasebook's `things.page.works.*`).
 *
 * - A watched test runs every 15 minutes; after a first failure once more at the next pass to confirm it, then on its
 *   rhythm again; and at the next pass after something was changed on the service (a restart, a fix) since its last run,
 *   so “did the fix work?” is answered without waiting a quarter of an hour.
 * - Its line shows only after two failed runs in a row (one blip says nothing), and goes with the first run that passes.
 *   A broken service is a problem the assistant can look into (red); a sign-in that was refused is the person's to fix
 *   in the connection (amber, it doesn't page anyone).
 */
import {
  SERVICE_TEST_CHECK,
  SERVICE_TEST_EVERY_MINUTES,
  type ServiceTestKind,
  type ServiceTestOutcome,
  serviceTestPassed,
} from '@whombat/core';
import type { ServiceTestFacts, ServiceTestReason } from '../db/schema/index';
import type { KindCheck, KindNotice } from '../things/quiet/types';
import { clip, clock, span } from '../things/words';
import { SERVICE_TESTS } from './tests';

/**
 * The switch in What Whombat watches. It starts off: nothing runs until the person turns it on for a service (Watch it
 * on the page), and then a failed test is exactly the “it is broken now” they asked to hear about.
 */
export const WORKS_CHECK: KindCheck = {
  check: SERVICE_TEST_CHECK,
  name: 'Whether it really works',
  nature: 'problem',
  perItem: false,
  startsOn: false,
};

/** A run as the rules read it. */
export interface RunLike {
  at: Date;
  outcome: ServiceTestOutcome;
  step: string | null;
  reason: ServiceTestReason | null;
  status: number | null;
  ms: number;
  facts: ServiceTestFacts;
}

export const EVERY_MS = SERVICE_TEST_EVERY_MINUTES * 60_000;
/** A first failure is run again this soon (the next health pass). */
export const CONFIRM_MS = 4 * 60_000;
/** After a change on the service, the test waits this long for it to come back before it runs. */
export const AFTER_CHANGE_MS = 2 * 60_000;
/** A result older than this says nothing about now: its line isn't shown and an Ignore of it doesn't end. */
export const FRESH_MS = 45 * 60_000;

/** “0.4”, “3”: seconds as a run's time reads. */
export function seconds(ms: number): string {
  // Under a tenth of a second still reads as one: “0.0 s” would say it took no time at all.
  const s = Math.max(100, ms) / 1000;
  if (s < 10) return (Math.round(s * 10) / 10).toFixed(1);
  return String(Math.round(s));
}

/** “12 s”, “5 min”, “2 h”: how long ago a reading came. */
export function ageWords(ageS: number): string {
  const s = Math.max(0, Math.round(ageS));
  return s < 60 ? `${s} s` : span(s * 1000);
}

/** What the step tried, as “it can’t {what}”. */
function stepWords(kind: ServiceTestKind, step: string | null): string {
  return (step ? SERVICE_TESTS[kind].steps[step] : undefined) ?? 'do what it should';
}

/**
 * A run in one sentence: “It works — opened your newest photo in 0.4 s.”, “Nextcloud opens, but it can’t list your
 * files (it answered 503).”, “The sign-in Whombat uses can’t list your files any more (it answered 401).”
 */
export function runWords(kind: ServiceTestKind, name: string, run: RunLike): string {
  const test = SERVICE_TESTS[kind];
  const what = stepWords(kind, run.step);
  const said = (() => {
    switch (run.outcome) {
      case 'ok':
        if (kind === 'homeassistant' && run.facts.ageS !== undefined)
          return `It works — a sensor changed ${ageWords(run.facts.ageS)} ago.`;
        return `It works — ${test.done(run.facts)} in ${seconds(run.ms)} s.`;
      case 'empty':
        return `${name} opens, but there’s nothing to open yet.`;
      case 'access':
        return run.status
          ? `The sign-in Whombat uses can’t ${what} any more (it answered ${run.status}).`
          : `The sign-in Whombat uses can’t ${what} any more.`;
      case 'down':
        return `${name} stopped answering when Whombat tried to ${what}.`;
      case 'broken':
        if (run.reason === 'stale') return `${name} opens, but none of its sensors changed in the last hour.`;
        if (run.reason === 'timeout')
          return `${name} opens, but it can’t ${what} (it didn’t answer in time).`;
        if (run.reason === 'status' && run.status)
          return `${name} opens, but it can’t ${what} (it answered ${run.status}).`;
        return `${name} opens, but it can’t ${what}.`;
    }
  })();
  return clip(said, 200);
}

/** The newest runs, newest first. */
function newestFirst<R extends RunLike>(runs: readonly R[]): R[] {
  return [...runs].sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** The last two runs both failed: the test fails now. */
export function failing(runs: readonly RunLike[]): boolean {
  const [a, b] = newestFirst(runs);
  return !!a && !!b && !serviceTestPassed(a.outcome) && !serviceTestPassed(b.outcome);
}

/**
 * Whether a watched test should run now: never run; its last run is 15 minutes old; its last run was a first failure
 * (the one before passed) and a pass has gone by; or something was changed on the service since its last run and it
 * had two minutes to come back.
 */
export function due(runs: readonly RunLike[], now: Date, changedAt: Date | null = null): boolean {
  const [last, before] = newestFirst(runs);
  if (!last) return true;
  const age = now.getTime() - last.at.getTime();
  if (age >= EVERY_MS) return true;
  const firstFailure = !serviceTestPassed(last.outcome) && (!before || serviceTestPassed(before.outcome));
  if (firstFailure && age >= CONFIRM_MS) return true;
  return (
    changedAt !== null &&
    changedAt.getTime() > last.at.getTime() &&
    now.getTime() - changedAt.getTime() >= AFTER_CHANGE_MS
  );
}

/** Whether the last run says something about now (it ran within the last 45 minutes). */
export function fresh(runs: readonly RunLike[], now: Date): boolean {
  const [last] = newestFirst(runs);
  return !!last && now.getTime() - last.at.getTime() <= FRESH_MS;
}

/**
 * The line in Worth a look while the test fails (two runs in a row): what it couldn't do in one sentence, and the way
 * forward — Look into it for a broken service, the connection for a sign-in that lost access. Null while it passes.
 */
export function worksNotice(
  kind: ServiceTestKind,
  name: string,
  runs: readonly RunLike[],
  timeZone: string,
): KindNotice | null {
  if (!failing(runs)) return null;
  const [last] = newestFirst(runs);
  if (!last) return null;
  const test = SERVICE_TESTS[kind];
  const access = last.outcome === 'access';
  return {
    id: 'works',
    tone: access ? 'warn' : 'bad',
    icon: access ? 'key' : test.icon,
    title: clip(runWords(kind, name, last), 120),
    detail: clip(`Whombat’s test of it failed twice in a row, last at ${clock(last.at, timeZone)}.`, 200),
    check: SERVICE_TEST_CHECK,
    nature: access ? 'you' : 'problem',
    badge: clip(access ? 'Test sign-in lost access' : test.badge, 40),
    link: access
      ? { kind: 'tab', label: 'Check the sign-in', tab: 'settings' }
      : { kind: 'ask', label: 'Look into it', question: clip(test.question(name), 300) },
    ignore: { lifts: 'fixed', words: 'Until the test passes again.' },
  };
}
