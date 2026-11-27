/**
 * The review of a T3 Code fix as its reviewer said it (report-trackers.md TA-57): the fix's thread hands its commits
 * to another model (`delegate_task`, titled “Review Acme Desk dev #15: …”), and the run's review step relays that
 * verdict. The server reads the reviewer's own last answer as well, so the merge rests on the reviewer's words, not on
 * the relay: its verdict, the commit its verdict's line names, when it began and which model it was.
 */
import { type AutomationVerdict, parseVerdict, renderTemplate, T3_REVIEW_TITLE } from '@whombat/core';
import { and, eq, isNull } from 'drizzle-orm';
import { catalogConnections, t3Watches } from '../../db/schema/index';
import type { Services } from '../../services';
import { answerArgs, lastAnswerOf } from '../../t3code/threads';
import { callT3 } from '../../things/kinds/business/t3code';
import type { AutomationRunRow } from '../store';
import { namedCommit } from './observe-commit';

/** The reviewer's own verdict and the commit its verdict's line names (null: it names none). */
export interface ReviewerVerdict {
  verdict: AutomationVerdict;
  commit: string | null;
  /** When the review began (its thread's creation): a commit made later wasn't in it. */
  startedAt: string | null;
  /** The reviewer's model and the fixing thread's, as T3 Code says them (null: not said). */
  model: string | null;
  fixerModel: string | null;
  /** Their providers (T3 Code's `providerInstanceId`; null: not said). */
  provider?: string | null;
  fixerProvider?: string | null;
}

/** A review thread as `t3_thread_list` lists it. */
export interface ListedReview {
  threadId: string;
  items: number;
  parentThreadId: string;
  createdAt: string | null;
  model: string | null;
  provider: string | null;
}

/**
 * The title the fix thread gives its review (“Review Acme Desk dev #15:”, `T3_REVIEW_TITLE` rendered for this run), as
 * the recipe names it — the server's own, never parsed from words an agent could change. Null without a report.
 */
export function reviewTitleOf(scope: Record<string, unknown>): string | null {
  const trigger = scope.trigger as { connection?: unknown; number?: unknown } | undefined;
  if (typeof trigger?.connection !== 'string' || typeof trigger.number !== 'number') return null;
  return renderTemplate(T3_REVIEW_TITLE, scope, 200);
}

const textOf = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * The newest review handed out by one of `own` (a `subagent` child whose title starts with `title`), from a
 * `t3_thread_list` answer. Pure.
 */
export function newestReviewOf(body: unknown, own: ReadonlySet<string>, title: string): ListedReview | null {
  const threads = (body as { threads?: unknown } | null)?.threads;
  if (!Array.isArray(threads)) return null;
  const newest = threads
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .filter(
      (t) =>
        t.relationshipToParent === 'subagent' &&
        typeof t.parentThreadId === 'string' &&
        own.has(t.parentThreadId) &&
        typeof t.title === 'string' &&
        t.title.startsWith(title) &&
        typeof t.threadId === 'string',
    )
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
  return newest
    ? {
        threadId: newest.threadId as string,
        items: typeof newest.itemCount === 'number' ? newest.itemCount : 0,
        parentThreadId: newest.parentThreadId as string,
        createdAt: textOf(newest.createdAt),
        model: textOf(newest.model),
        provider: textOf(newest.providerInstanceId),
      }
    : null;
}

/** Whether T3 Code named a thread's model: a name, not missing or only “default” (TA-57). */
export function modelKnown(model: string | null): boolean {
  return !!model && model.toLowerCase() !== 'default';
}

/**
 * Whether a review holds for `head`, the branch's head on GitHub: it is, as T3 Code says, another model
 * than the fixer's, and it read this branch: the commit its verdict names is the head or one of the branch's `commits`
 * (the fixes of what it found came after it) — or, naming none, the head was committed before the review began. Its
 * verdict doesn't decide here: a fix gets one review, and the run's review step judges whether what it found was dealt
 * with. The reason when it doesn't hold. Pure.
 */
export function reviewBinds(
  review: ReviewerVerdict,
  head: { sha: string; committedAt: string | null; commits?: readonly string[] },
  chosen: string | null = null,
): { ok: true } | { ok: false; reason: string } {
  // Another model must have reviewed it, which T3 Code has to say: not knowing (or only “default”) is no approval.
  if (!modelKnown(review.model) || !modelKnown(review.fixerModel))
    return { ok: false, reason: 'Which model reviewed it couldn’t be read.' };
  if (review.model === review.fixerModel)
    return { ok: false, reason: 'It was reviewed by the same model that made it.' };
  // Another provider's model, unless the automation chose this very reviewer (TA-49); T3 Code has to say which
  // providers they are, as it has to say the models.
  if (review.model !== chosen) {
    if (!review.provider || !review.fixerProvider)
      return { ok: false, reason: 'Which provider reviewed it couldn’t be read.' };
    if (review.provider === review.fixerProvider)
      return { ok: false, reason: 'It was reviewed by a model of the provider that made it.' };
  }
  const named = review.commit?.toLowerCase();
  if (named) {
    const read = [head.sha, ...(head.commits ?? [])].some((sha) => sha.toLowerCase().startsWith(named));
    return read ? { ok: true } : { ok: false, reason: 'The branch doesn’t have the commit its review read.' };
  }
  const committed = head.committedAt ? Date.parse(head.committedAt) : Number.NaN;
  const began = review.startedAt ? Date.parse(review.startedAt) : Number.NaN;
  return !Number.isNaN(committed) && !Number.isNaN(began) && committed <= began
    ? { ok: true }
    : { ok: false, reason: 'The review didn’t say which commit it read.' };
}

/**
 * What the reviewer of this run's fix last said: found through the T3 Code threads the run's own turns started (its
 * watches, on each T3 Code connection they are on) and their `subagent` children. Null when there is none to read, or
 * T3 Code didn't answer (logged).
 */
export async function reviewerVerdict(
  services: Services,
  run: AutomationRunRow,
  scope: Record<string, unknown>,
): Promise<ReviewerVerdict | null> {
  const title = reviewTitleOf(scope);
  if (!title) return null;
  const watched = await services.db
    .select({ threadId: t3Watches.threadId, connection: catalogConnections })
    .from(t3Watches)
    .innerJoin(catalogConnections, eq(catalogConnections.id, t3Watches.connectionId))
    .where(
      and(
        eq(t3Watches.conversationId, run.conversationId),
        run.threadRootId ? eq(t3Watches.threadRootId, run.threadRootId) : isNull(t3Watches.threadRootId),
      ),
    );
  const connections = new Map(watched.map((w) => [w.connection.id, w.connection]));
  for (const connection of connections.values()) {
    const own = new Set(watched.filter((w) => w.connection.id === connection.id).map((w) => w.threadId));
    try {
      const listed = await callT3(services, connection, 't3_thread_list', {
        allProjects: true,
        includeSubagents: true,
        titleContains: title,
        limit: 50,
      });
      const review = newestReviewOf(listed, own, title);
      if (!review) continue;
      const answer = lastAnswerOf(
        await callT3(services, connection, 't3_thread_read', answerArgs(review.threadId, review.items)),
      );
      const verdict = answer ? parseVerdict(answer) : null;
      if (!answer || !verdict) continue;
      const fixer = await callT3(services, connection, 't3_thread_read', {
        threadId: review.parentThreadId,
        limit: 1,
        maxCharsPerItem: 1,
      });
      return {
        verdict,
        commit: namedCommit([answer]),
        startedAt: review.createdAt,
        model: review.model,
        fixerModel: textOf((fixer as { thread?: { model?: unknown } } | null)?.thread?.model),
        provider: review.provider,
        fixerProvider: textOf(
          (fixer as { thread?: { providerInstanceId?: unknown } } | null)?.thread?.providerInstanceId,
        ),
      };
    } catch (err) {
      services.log.warn(
        { runId: run.id, connectionId: connection.id, err: String(err) },
        'automations: the review of a T3 Code fix could not be read',
      );
    }
  }
  return null;
}
