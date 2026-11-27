import { z } from 'zod';
import { coreWords } from '../i18n/catalog.js';
import { AnswerId, BurrowId, ConversationId, PrincipalId } from '../ids.js';
import { Count, Timestamp, Tone } from './common.js';
import { LinkRef } from './links.js';

/**
 * Indexed document types (TYPE tag on result rows). Since 0.12 (work-supervision WS-21): PLAN (a shared plan and its
 * steps), DECISION (an approval and how it was decided) and AUTOMATION (an automation run's outcome).
 */
export const SearchResultType = z.enum([
  'THREAD',
  'PATCH',
  'RUN',
  'CANVAS',
  'MESSAGE',
  'PLAN',
  'DECISION',
  'AUTOMATION',
]);
export type SearchResultType = z.infer<typeof SearchResultType>;

/** Type filter chips. URL values are lowercase (`/search?q=&type=patches`). */
export const SEARCH_FILTERS = [
  'all',
  'threads',
  'patches',
  'runs',
  'canvases',
  'plans',
  'decisions',
  'automations',
] as const;
export const SearchFilter = z.enum(SEARCH_FILTERS);
export type SearchFilter = z.infer<typeof SearchFilter>;

const SEARCH_FILTER_LABELS_KEYS = [
  'all',
  'threads',
  'patches',
  'runs',
  'canvases',
  'plans',
  'decisions',
  'automations',
] as const;

/** `SEARCH_FILTER_LABELS` in a locale. */
export function searchFilterLabels(
  locale?: string | null,
): Readonly<Record<(typeof SEARCH_FILTER_LABELS_KEYS)[number], string>> {
  return coreWords(locale, 'search.filter', SEARCH_FILTER_LABELS_KEYS);
}

export const SEARCH_FILTER_LABELS: Record<SearchFilter, string> = searchFilterLabels('en');

/** The TYPE tag a result row shows. */
export const SEARCH_TYPE_LABELS: Record<SearchResultType, string> = {
  THREAD: 'THREAD',
  MESSAGE: 'MESSAGE',
  PATCH: 'PATCH',
  RUN: 'RUN',
  CANVAS: 'CANVAS',
  PLAN: 'PLAN',
  DECISION: 'DECISION',
  AUTOMATION: 'AUTOMATION',
};

/** Which filter chip a result counts under (messages count as Threads). */
export function searchFilterOf(type: SearchResultType): Exclude<SearchFilter, 'all'> {
  switch (type) {
    case 'THREAD':
    case 'MESSAGE':
      return 'threads';
    case 'PATCH':
      return 'patches';
    case 'RUN':
      return 'runs';
    case 'CANVAS':
      return 'canvases';
    case 'PLAN':
      return 'plans';
    case 'DECISION':
      return 'decisions';
    case 'AUTOMATION':
      return 'automations';
  }
}

export const SearchResult = z.object({
  id: z.string().min(1).max(80),
  type: SearchResultType,
  /** "#incidents · 3 Mar 2026", "PR #311 · merged 4 Mar", "Run #1882 · ledger reconciliation". */
  where: z.string().max(200),
  authorId: PrincipalId,
  snippet: z.string().max(1000),
  /** Receipt number when the agent answer cites this result ("receipt 1"). */
  citedAs: z.number().int().positive().nullable(),
  link: LinkRef,
  createdAt: Timestamp,
  /**
   * The state a plan, decision or automation result is in, as a short pill (“APPROVED BY MARA”, “2 OF 4 DONE”,
   * “FAILED”), with its tone; null for other types (WS-21).
   */
  status: z
    .object({ text: z.string().max(60), tone: Tone })
    .nullable()
    .default(null),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const SearchCounts = z.object({
  all: Count,
  threads: Count,
  patches: Count,
  runs: Count,
  canvases: Count,
  plans: Count.default(0),
  decisions: Count.default(0),
  automations: Count.default(0),
});
export type SearchCounts = z.infer<typeof SearchCounts>;

/** Counts per filter chip for a result list. */
export function countSearchResults(results: readonly Pick<SearchResult, 'type'>[]): SearchCounts {
  const counts: SearchCounts = {
    all: results.length,
    threads: 0,
    patches: 0,
    runs: 0,
    canvases: 0,
    plans: 0,
    decisions: 0,
    automations: 0,
  };
  for (const r of results) counts[searchFilterOf(r.type)]++;
  return counts;
}

export const AnswerStatus = z.enum(['pending', 'ready', 'failed', 'none']);
export type AnswerStatus = z.infer<typeof AnswerStatus>;

/** Action buttons under the answer: "Post to #incidents", "Open PR #482". */
export const AnswerAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('post'), label: z.string().max(80), conversationId: ConversationId }),
  z.object({ kind: z.literal('open'), label: z.string().max(80), link: LinkRef }),
]);
export type AnswerAction = z.infer<typeof AnswerAction>;

/**
 * The agent answer card on the search screen: "Dusty · answered from 3 receipts · 1.8s".
 * `text` carries inline citations as `[n]` markers (see `segmentCitations`).
 */
export const SearchAnswer = z.object({
  id: AnswerId,
  burrowId: BurrowId,
  query: z.string().max(500),
  agentId: PrincipalId,
  status: AnswerStatus,
  text: z.string().max(4000),
  /** Receipt number → search result id. */
  citations: z.array(z.object({ n: z.number().int().positive(), resultId: z.string().max(80) })),
  durationMs: z.number().int().nonnegative().nullable(),
  actions: z.array(AnswerAction),
  createdAt: Timestamp,
});
export type SearchAnswer = z.infer<typeof SearchAnswer>;
