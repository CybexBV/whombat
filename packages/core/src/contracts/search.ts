/** Search and the agent answer card. */
import { z } from 'zod';
import { Cursor, Handle, IsoDate } from '../domain/common.js';
import { Message } from '../domain/message.js';
import { SearchAnswer, SearchCounts, SearchFilter, SearchResult } from '../domain/search.js';
import { AnswerId, ConversationId } from '../ids.js';
import { BurrowParam, endpoint, limitQuery } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

export const SearchResponse = z.object({
  query: z.string(),
  /** Results for the selected type filter. */
  results: z.array(SearchResult),
  /** Chip counts over all types: exact, over everything in this search the viewer may open, not just this page. */
  counts: SearchCounts,
  /** Latest answer for this query, if one was asked. */
  answer: SearchAnswer.nullable(),
  /**
   * The next page of `results` (0.26, CT-180): pass as `cursor` with the same query. Opaque and bound to the search it
   * came from: a cursor of another search (viewer, words, type, filters) is refused (400 `validation_failed`, field
   * `cursor`; search again without it). A page may hold fewer than `limit` results, even none, and still have a `next`;
   * only null (or absent) means the search ended (Whombat SRP-01…SRP-13).
   */
  next: Cursor.nullable().optional(),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

/**
 * `search.query`'s query (CT-180): the text, the type chip, and since 0.26 the filters `from` (a person's or agent's
 * handle), `in` (a conversation), `after` / `before` (calendar days, inclusive, in the viewer's time zone) and the
 * page `cursor` (a `next` of this same search). Filters combine with AND; `q` may be empty when a filter is set.
 */
export const SearchQuery = z.object({
  q: z.string().max(500),
  type: SearchFilter.default('all'),
  limit: limitQuery(30, 100),
  from: Handle.optional(),
  in: ConversationId.optional(),
  after: IsoDate.optional(),
  before: IsoDate.optional(),
  cursor: Cursor.optional(),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const searchEndpoints = {
  query: endpoint({
    id: 'search.query',
    method: 'GET',
    path: '/burrows/:burrow/search',
    summary:
      'Full-text search over threads, patches, runs, canvases and messages; filters from, in, after and before; paged by cursor.',
    params: B,
    query: SearchQuery,
    response: SearchResponse,
  }),
  ask: endpoint({
    id: 'search.ask',
    method: 'POST',
    path: '/burrows/:burrow/search/answers',
    summary: 'Ask the agent to answer from the top results. Arrives as a `search.answer` event.',
    params: B,
    body: z.object({ q: z.string().trim().min(1).max(500) }),
    response: z.object({ answer: SearchAnswer }),
    status: 202,
  }),
  getAnswer: endpoint({
    id: 'search.getAnswer',
    method: 'GET',
    path: '/burrows/:burrow/search/answers/:answerId',
    summary: 'An answer (poll fallback when the socket is down).',
    params: B.extend({ answerId: AnswerId }),
    response: z.object({ answer: SearchAnswer }),
  }),
  postAnswer: endpoint({
    id: 'search.postAnswer',
    method: 'POST',
    path: '/burrows/:burrow/search/answers/:answerId/post',
    summary: '"Post to #incidents": post the answer with its receipts to a conversation.',
    params: B.extend({ answerId: AnswerId }),
    body: z.object({ conversationId: ConversationId }),
    response: z.object({ message: Message }),
    status: 201,
  }),
};
