/**
 * GitHub's page in slots, from the box's own mirror of the repositories switched on (pull requests, their checks and
 * who is asked to review), never a call to GitHub:
 *
 * - **Live** “Waiting for you”: reviews asked of you, then your pull requests with failing checks, then others'.
 * - **Inventory** “On GitHub”: repositories on, open pull requests with how many are new this week, failing checks,
 *   waiting on review.
 * - **Trend** “Merged” per day, **People** “Who opens most” in the last 30 days (two or more people).
 *
 * “You” is the viewer as the mirror knows them: the person a review is asked of, the person who opened it.
 */
import type { ThingPageItem } from '@whombat/core';
import { and, count, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import {
  githubConnections,
  prChecks,
  principals,
  prReviewers,
  pullRequests,
  repos,
} from '../../db/schema/index';
import { checksOf } from '../../desk/widgets/accounts';
import type { Services } from '../../services';
import {
  addedNote,
  countByDay,
  countLine,
  inventory,
  lastDays,
  liveList,
  people,
  slotPanels,
  trend,
  weekChange,
} from '../kinds/slots';
import { ago } from '../kinds/storage/shared';
import type { KindView } from '../kinds/types';
import { cap, clip, plural, thousands } from '../words';

const DAY = 86_400_000;
/** Open pull requests read at most. */
const OPEN_MAX = 200;
/** Rows in Waiting for you. */
const WAITING_ROWS = 6;

/** An open pull request as the page needs it. */
export interface GithubPull {
  /** The repository's short name (“billing”). */
  repo: string;
  number: number;
  title: string;
  draft: boolean;
  openedAt: Date;
  url: string | null;
  /** Who opened it, by name; null when the mirror doesn't know. */
  author: string | null;
  /** The viewer opened it. */
  mine: boolean;
  checks: 'passing' | 'failing' | 'running' | null;
  /** The viewer is asked to review it and hasn't yet. */
  asksYou: boolean;
  /** Someone is asked to review it and hasn't yet. */
  waiting: boolean;
}

export interface GithubInput {
  login: string | null;
  reposOn: number;
  open: GithubPull[];
  /** When each pull request merged in the last 14 days. */
  merged: Date[];
  /** Who opened pull requests in the last 30 days, most first. */
  openers: { name: string; n: number }[];
  now: Date;
  timeZone: string;
}

export type GithubView = Pick<
  KindView,
  'panels' | 'slots' | 'notices' | 'verdict' | 'readAt' | 'open' | 'refreshS'
>;

/** Waiting for you, in its order: reviews asked of you, your failing ones, others' failing ones; newest first in each. */
export function waitingForYou(
  open: readonly GithubPull[],
): { pull: GithubPull; why: 'review' | 'mine' | 'failing' }[] {
  const newest = (a: GithubPull, b: GithubPull) => b.openedAt.getTime() - a.openedAt.getTime();
  const reviews = open.filter((p) => p.asksYou && !p.draft).sort(newest);
  const failing = open.filter((p) => p.checks === 'failing' && !reviews.includes(p)).sort(newest);
  return [
    ...reviews.map((pull) => ({ pull, why: 'review' as const })),
    ...failing.filter((p) => p.mine).map((pull) => ({ pull, why: 'mine' as const })),
    ...failing.filter((p) => !p.mine).map((pull) => ({ pull, why: 'failing' as const })),
  ];
}

function waitingItem(w: ReturnType<typeof waitingForYou>[number], now: Date): ThingPageItem {
  const p = w.pull;
  const who =
    w.why === 'review'
      ? p.author
        ? `${p.author} asks your review`
        : 'Asks your review'
      : `${w.why === 'mine' ? 'Yours' : (p.author ?? 'Someone')} · Checks failing`;
  return {
    id: `pr-${p.repo}-${p.number}`.slice(0, 200),
    title: clip(`#${p.number} ${p.title}`, 160),
    detail: clip(`${p.repo} · ${who}`, 300),
    icon: w.why === 'review' ? 'clock' : 'warn',
    ...(w.why === 'review' ? {} : { tone: 'bad' as const }),
    at: p.openedAt.toISOString(),
    right: ago(p.openedAt, now),
    ...(p.url?.startsWith('https://') ? { url: p.url } : {}),
  };
}

/** GitHub's Summary in slots and its head's parts. */
export function githubView(input: GithubInput): GithubView {
  const { now, timeZone, open } = input;
  const waiting = waitingForYou(open);
  const reviews = waiting.filter((w) => w.why === 'review').length;
  const failing = open.filter((p) => p.checks === 'failing').length;
  const newThisWeek = open.filter((p) => now.getTime() - p.openedAt.getTime() <= 7 * DAY).length;
  const onReview = open.filter((p) => p.waiting && !p.draft).length;

  const live = liveList({
    id: 'waiting',
    title: 'Waiting for you',
    meta: String(waiting.length),
    items: waiting.slice(0, WAITING_ROWS).map((w) => waitingItem(w, now)),
    empty: 'Nothing waits for you.',
  });

  const added = addedNote(newThisWeek);
  const counts = inventory({
    id: 'github',
    title: 'On GitHub',
    items: [
      countLine({ id: 'repos', title: 'Repositories on', icon: 'database', value: thousands(input.reposOn) }),
      countLine({
        id: 'open',
        title: 'Open pull requests',
        icon: 'log',
        value: thousands(open.length),
        ...(added ?? {}),
      }),
      countLine({
        id: 'failing',
        title: 'Failing checks',
        icon: 'warn',
        value: thousands(failing),
        ...(failing ? { tone: 'warn' as const, noteTone: 'warn' as const } : {}),
      }),
      countLine({ id: 'review', title: 'Waiting on review', icon: 'clock', value: thousands(onReview) }),
    ],
  });

  const days = lastDays(now, timeZone);
  const values = countByDay(input.merged, days.keys, timeZone);
  const thisWeek = values.reduce((a, b) => a + b, 0);
  const before = input.merged.filter((d) => {
    const age = now.getTime() - d.getTime();
    return age >= 7 * DAY && age < 14 * DAY;
  }).length;
  const merged =
    thisWeek || before
      ? trend({
          id: 'merged',
          title: 'Merged',
          meta: 'Per day',
          days,
          values,
          label: 'Merged',
          figure: { value: thousands(thisWeek), rest: 'this week' },
          change: weekChange(thisWeek, before),
        })
      : null;

  const openers =
    input.openers.length >= 2
      ? people({
          title: 'Who opens most',
          meta: 'Last 30 days',
          items: input.openers.slice(0, 5).map((o) => ({ name: o.name, n: o.n })),
          unit: ['pull request'],
        })
      : null;

  const reviewWords = reviews === 1 ? '1 review waits for you' : `${reviews} reviews wait for you`;
  const failWords =
    failing === 1 ? '1 pull request has failing checks' : `${failing} pull requests have failing checks`;
  const verdict =
    reviews && failing
      ? `${reviewWords}, and ${failWords}.`
      : reviews
        ? `${reviewWords}.`
        : failing
          ? `${cap(failWords)}.`
          : open.length
            ? `${plural(open.length, 'open pull request')}, and nothing waits for you.`
            : 'No open pull requests.';

  return {
    ...slotPanels({ live, inventory: counts, trend: merged, people: openers }),
    notices: [],
    verdict,
    readAt: now,
    open: { label: 'Open GitHub', url: `https://github.com/${input.login ?? ''}` },
    refreshS: 60,
  };
}

/** What the page reads from the mirror for the viewer. */
export async function readGithub(
  services: Services,
  burrowId: string,
  viewerId: string,
  now: Date,
): Promise<Omit<GithubInput, 'now' | 'timeZone'>> {
  const db = services.db;
  const on = and(eq(pullRequests.burrowId, burrowId), eq(repos.enabled, true));
  const [[conn], [repoCount], openRows, mergedRows, openedRows] = await Promise.all([
    db
      .select({ login: githubConnections.login })
      .from(githubConnections)
      .where(eq(githubConnections.burrowId, burrowId)),
    db
      .select({ n: count() })
      .from(repos)
      .where(and(eq(repos.burrowId, burrowId), eq(repos.enabled, true))),
    db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        title: pullRequests.title,
        draft: pullRequests.draft,
        openedAt: pullRequests.openedAt,
        url: pullRequests.url,
        authorId: pullRequests.authorId,
        authorLogin: pullRequests.authorLogin,
        localOnly: pullRequests.localOnly,
        repo: repos.fullName,
        source: repos.source,
      })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(and(on, eq(pullRequests.state, 'open')))
      .orderBy(desc(pullRequests.openedAt))
      .limit(OPEN_MAX),
    db
      .select({ at: pullRequests.mergedAt })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(
          on,
          isNotNull(pullRequests.mergedAt),
          gte(pullRequests.mergedAt, new Date(now.getTime() - 14 * DAY)),
        ),
      ),
    db
      .select({
        authorId: pullRequests.authorId,
        authorLogin: pullRequests.authorLogin,
        n: count(),
      })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(
          on,
          eq(pullRequests.authorBot, false),
          gte(pullRequests.openedAt, new Date(now.getTime() - 30 * DAY)),
        ),
      )
      .groupBy(pullRequests.authorId, pullRequests.authorLogin),
  ]);
  const ids = openRows.map((p) => p.id);
  const authorIds = [
    ...new Set([...openRows, ...openedRows].flatMap((p) => (p.authorId ? [p.authorId] : []))),
  ];
  const [checks, pending, names] = await Promise.all([
    ids.length
      ? db
          .select({ prId: prChecks.prId, state: prChecks.state })
          .from(prChecks)
          .where(inArray(prChecks.prId, ids))
      : Promise.resolve([]),
    ids.length
      ? db
          .select({ prId: prReviewers.prId, principalId: prReviewers.principalId })
          .from(prReviewers)
          .where(and(inArray(prReviewers.prId, ids), eq(prReviewers.state, 'pending')))
      : Promise.resolve([]),
    authorIds.length
      ? db
          .select({ id: principals.id, name: principals.name, shortName: principals.shortName })
          .from(principals)
          .where(inArray(principals.id, authorIds))
      : Promise.resolve([]),
  ]);
  const nameOf = new Map(names.map((p) => [p.id, p.name || p.shortName || '']));
  const author = (p: { authorId: string | null; authorLogin: string | null }) =>
    (p.authorId ? nameOf.get(p.authorId) : null) || p.authorLogin || null;
  const byName = new Map<string, number>();
  for (const o of openedRows) {
    const name = author(o);
    if (name) byName.set(name, (byName.get(name) ?? 0) + o.n);
  }
  return {
    login: conn?.login ?? null,
    reposOn: repoCount?.n ?? 0,
    open: openRows.map((p) => {
      const waiting = pending.filter((r) => r.prId === p.id);
      const repo = p.repo.slice(p.repo.lastIndexOf('/') + 1);
      return {
        repo,
        number: p.number,
        title: p.title,
        draft: p.draft,
        openedAt: p.openedAt,
        // A repository kept on this Whombat, or a pull request opened while it wasn't on GitHub, has no page there.
        url:
          p.url ??
          (p.source === 'github' && !p.localOnly ? `https://github.com/${p.repo}/pull/${p.number}` : null),
        author: author(p),
        mine: p.authorId === viewerId,
        checks: checksOf(checks.filter((c) => c.prId === p.id).map((c) => c.state)),
        asksYou: waiting.some((r) => r.principalId === viewerId),
        waiting: waiting.length > 0,
      };
    }),
    merged: mergedRows.flatMap((r) => (r.at ? [r.at] : [])),
    openers: [...byName.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
  };
}
