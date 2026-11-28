/**
 * “Does it really work?” in fixture mode (Whombat docs/decisions/service-works.md): the card the server adds to the page
 * of a service it can test, the test's line in Worth a look while it fails, and the card's two buttons, Run now and
 * Watch it. The words are the server's, so the page reads as it would on a box.
 */
import type { ThingActionBody } from '@whombat/core/contracts';
import {
  SERVICE_TEST_CHECK,
  type ThingNoticeIcon,
  type ThingPageButton,
  type ThingPageNotice,
  type ThingPagePanel,
} from '@whombat/core/domain';
import type { FixtureServiceCtx } from './types.js';

/** How a fixture's test goes: what it says when it works, and how it fails now (absent: it works). */
export interface FixtureWorksSpec {
  /** The test in plain words: “Open your newest photo”. */
  name: string;
  icon: ThingNoticeIcon;
  /** Its sentence when it works: “It works — opened your newest photo in 0.4 s.” */
  works: string;
  /** How it fails now, twice in a row: a refused sign-in (`access`) or a broken service. */
  fails?: { words: string; access: boolean; badge: string; question: string; status: number };
  watched: boolean;
  /** How long ago it last ran; absent: it never ran. */
  ranAgo?: number;
  /** Runs counted in the card's line, and how many of them passed. */
  history?: { runs: number; passed: number };
}

/** The check in What Whombat watches, as every testable service has it. */
export const FIXTURE_WORKS_CHECK = {
  check: SERVICE_TEST_CHECK,
  name: 'Whether it really works',
  nature: 'problem' as const,
  perItem: false,
};

/** A service's test for one fixture world: its card, its line and its buttons, with what they change kept here. */
export function fixtureWorks(ctx: FixtureServiceCtx, spec: FixtureWorksSpec) {
  let watched = spec.watched;
  let ranAt = spec.ranAgo === undefined ? null : ctx.now() - spec.ranAgo;
  let history = spec.history ?? { runs: 0, passed: 0 };
  const failing = spec.fails ?? null;
  // Both buttons only read or change Whombat's own watching: allowed on Look only too.
  const button = (b: Omit<ThingPageButton, 'allowed'>): ThingPageButton => ({ ...b, allowed: true });
  const words = () => (failing ? failing.words : spec.works);

  const panel = (): ThingPagePanel => ({
    kind: 'list',
    id: 'works',
    place: 'main',
    title: 'Does it really work?',
    meta: !watched
      ? 'Runs only when you ask'
      : history.runs >= 2
        ? `Every 15 minutes · passed ${history.passed} of the last ${history.runs}`
        : 'Every 15 minutes',
    buttons: [
      button({ action: 'works_run', label: 'Run now', icon: 'play', tone: 'primary' }),
      button(
        watched
          ? { action: 'works_watch', value: false, label: 'Stop watching' }
          : { action: 'works_watch', value: true, label: 'Watch it', icon: 'check' },
      ),
    ],
    items: [
      {
        id: 'test',
        title: spec.name,
        detail:
          ranAt === null
            ? 'Not run yet. Whombat only reads: it opens something as you would, and keeps only the result.'
            : words(),
        ...(ranAt === null ? {} : { at: new Date(ranAt).toISOString() }),
        tone: ranAt === null ? 'info' : !failing ? 'ok' : failing.access ? 'warn' : 'bad',
        icon: failing?.access && ranAt !== null ? 'key' : spec.icon,
      },
    ],
  });

  /** Its line while it is watched and failed twice in a row. */
  const notice = (): ThingPageNotice | null => {
    if (!failing || !watched || ranAt === null) return null;
    const clock = new Date(ranAt).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return {
      id: 'works',
      tone: failing.access ? 'warn' : 'bad',
      icon: failing.access ? 'key' : spec.icon,
      title: failing.words,
      detail: `Whombat’s test of it failed twice in a row, last at ${clock}.`,
      check: SERVICE_TEST_CHECK,
      nature: failing.access ? 'you' : 'problem',
      link: failing.access
        ? { kind: 'tab', label: 'Check the sign-in', tab: 'settings' }
        : { kind: 'ask', label: 'Look into it', question: failing.question },
      ...(ctx.lookOnly ? {} : { ignore: { lifts: 'fixed' as const, words: 'Until the test passes again.' } }),
    };
  };

  /** A pressed button of the card; null for any other. */
  const action = (body: ThingActionBody): { message: string } | null => {
    const run = () => {
      ranAt = ctx.now();
      history = { runs: history.runs + 1, passed: history.passed + (failing ? 0 : 1) };
      return words();
    };
    if (body.action === 'works_run') return { message: run() };
    if (body.action !== 'works_watch' || typeof body.value !== 'boolean') return null;
    watched = body.value;
    if (!watched) return { message: 'Whombat stopped running this test.' };
    return { message: `Whombat runs this test every 15 minutes now. ${run()}` };
  };

  return { panel, notice, action, badge: () => (failing && watched ? failing.badge : null) };
}
