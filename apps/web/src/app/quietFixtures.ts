/**
 * Quiet notices on the fixture world's own pages (UniFi, Home Assistant, Hetzner, a device, the generic page;
 * quiet-notices.md AP-4831): `things.quiet`, `things.watch` and `things.setWatch` as the runtime answers them, and a page
 * read through them — a line not watched leaves, a quiet line goes greyed to the bottom with `quiet`, a snooze past its
 * time or an ignore whose line went lifts, and a page whose problems are all quiet
 * or heads-ups reads fine. The service pages (`@whombat/fixtures`) and servers (`hostsFixtures.ts`) have their own.
 */
import {
  type NoticeQuiet,
  type NoticeSubject,
  noticeNature,
  QUIET_SNOOZE_HOUR,
  QUIET_WORDS,
  quietWordsOf,
  type ThingPage,
  type ThingPageNotice,
  type ThingWatch,
  type ThingWatchCheck,
  type ThingWatchException,
} from '@whombat/core';
import type { QuietNoticeBody, SetThingWatchBody } from '@whombat/core/contracts';

/** A check What Whombat watches lists for a thing. */
export type FixtureCheck = Pick<ThingWatchCheck, 'check' | 'name' | 'nature' | 'perItem'>;

/** Every connection's own two (Whombat QN-S*: the check's own failures). */
export const GENERIC_CHECKS: readonly FixtureCheck[] = [
  { check: 'conn.answers', name: 'Not answering', nature: 'problem', perItem: false },
  { check: 'conn.signin', name: 'Needing to sign in again', nature: 'you', perItem: false },
];

export interface QuietFixtureAnswer {
  status: number;
  body: unknown;
}

export function createQuietFixtures(opts: {
  now: () => number;
  by: NonNullable<NoticeQuiet['by']>;
  checks: (thing: string) => readonly FixtureCheck[];
}) {
  const quiets = new Map<string, { quiet: NoticeQuiet; subject?: NoticeSubject }>();
  const offs = new Map<string, { at: string; subject?: NoticeSubject }>();
  const keyOf = (thing: string, check: string, subject?: string) => `${thing}|${check}|${subject ?? ''}`;
  const { by } = opts;
  const checksOf = (thing: string) => [...GENERIC_CHECKS, ...opts.checks(thing)];

  function tomorrowNine(): string {
    const d = new Date(opts.now());
    d.setUTCDate(d.getUTCDate() + 1);
    // 09:00 in Amsterdam (CEST in October, UTC + 2): the fixture world's zone.
    d.setUTCHours(QUIET_SNOOZE_HOUR - 2, 0, 0, 0);
    return d.toISOString();
  }

  /** The page as quiet makes it. */
  function settle(thing: string, page: ThingPage): ThingPage {
    const seen = new Set<string>();
    const tabs = page.tabs.map((t) => ({
      ...t,
      panels: t.panels.map((p) => {
        if (p.kind !== 'notices') return p;
        const active: ThingPageNotice[] = [];
        const quiet: ThingPageNotice[] = [];
        for (const raw of p.items) {
          const { ignore, ...rest } = raw;
          const n = ignore ? raw : rest;
          if (!n.check) {
            active.push(n);
            continue;
          }
          if (offs.has(keyOf(thing, n.check)) || offs.has(keyOf(thing, n.check, n.subject?.id))) continue;
          const key = keyOf(thing, n.check, n.subject?.id);
          seen.add(key);
          const q = quiets.get(key);
          if (q?.quiet.until && Date.parse(q.quiet.until) <= opts.now()) quiets.delete(key);
          const still = quiets.get(key);
          if (still) quiet.push({ ...n, quiet: still.quiet });
          else active.push(n);
        }
        return { ...p, items: [...active, ...quiet] };
      }),
    }));
    for (const key of [...quiets.keys()])
      if (key.startsWith(`${thing}|`) && !seen.has(key)) quiets.delete(key);
    const lines = tabs.flatMap((t) => t.panels.flatMap((p) => (p.kind === 'notices' ? p.items : [])));
    // Only quieting makes a page fine here: one warn for another reason stays.
    const asking = lines.some((n) => !n.quiet && noticeNature(n) !== 'fyi');
    const fine = lines.some((n) => n.quiet) && !asking && (page.status === 'warn' || page.status === 'bad');
    return { ...page, tabs, ...(fine ? { status: 'ok', badge: 'Running fine' } : {}) };
  }

  function quiet(thing: string, body: QuietNoticeBody, page: ThingPage | null): QuietFixtureAnswer {
    if (!page)
      return { status: 404, body: { error: { code: 'not_found', message: 'There’s nothing here.' } } };
    const { notice, how } = body;
    const key = keyOf(thing, notice.check, notice.subject);
    if (how === 'undo') {
      if (!quiets.delete(key))
        return {
          status: 404,
          body: { error: { code: 'not_found', message: 'There’s nothing to take back.' } },
        };
      return { status: 200, body: { notice, quiet: null } };
    }
    const n = page.tabs
      .flatMap((t) => t.panels.flatMap((p) => (p.kind === 'notices' ? p.items : [])))
      .find((x) => x.check === notice.check && x.subject?.id === notice.subject);
    if (!n?.ignore)
      return {
        status: 404,
        body: { error: { code: 'not_found', message: 'That isn’t on this page any more.' } },
      };
    const at = new Date(opts.now()).toISOString();
    const q: NoticeQuiet =
      how === 'ignore'
        ? { state: 'ignored', words: quietWordsOf(n.ignore.words), by, at }
        : { state: 'snoozed', words: 'until tomorrow 09:00', until: body.until ?? tomorrowNine(), by, at };
    quiets.set(key, { quiet: q, ...(n.subject ? { subject: n.subject } : {}) });
    return { status: 200, body: { notice, quiet: q } };
  }

  function watch(thing: string): ThingWatch {
    const checks = checksOf(thing).map((c): ThingWatchCheck => {
      const whole = offs.get(keyOf(thing, c.check));
      const exceptions: ThingWatchException[] = [];
      for (const [key, o] of offs)
        if (o.subject && key === keyOf(thing, c.check, o.subject.id))
          exceptions.push({ subject: o.subject, state: 'stopped', words: QUIET_WORDS.always, by, at: o.at });
      for (const [key, q] of quiets)
        if (key.startsWith(`${thing}|${c.check}|`))
          exceptions.push({
            ...(q.subject ? { subject: q.subject } : {}),
            state: q.quiet.state,
            words: q.quiet.words,
            ...(q.quiet.until ? { until: q.quiet.until } : {}),
            by,
            at: q.quiet.at,
          });
      return { ...c, on: !whole, ...(whole ? { off: { by, at: whole.at } } : {}), exceptions };
    });
    return { checks, mayChange: true };
  }

  function setWatch(thing: string, body: SetThingWatchBody): QuietFixtureAnswer {
    if (!checksOf(thing).some((c) => c.check === body.check))
      return {
        status: 404,
        body: { error: { code: 'not_found', message: 'Whombat doesn’t watch that here.' } },
      };
    const key = keyOf(thing, body.check, body.subject?.id);
    if (body.watched) offs.delete(key);
    else
      offs.set(key, {
        at: new Date(opts.now()).toISOString(),
        ...(body.subject ? { subject: body.subject } : {}),
      });
    return { status: 200, body: watch(thing) };
  }

  return { settle, quiet, watch, setWatch };
}
