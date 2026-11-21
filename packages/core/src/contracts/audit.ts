/** Audit log: query with filters and counts, one event, CSV export, chain verification. */
import { z } from 'zod';
import { AuditActorFilter, AuditKindFilter } from '../audit/log.js';
import { AuditEvent } from '../domain/audit.js';
import { Count, Cursor, Handle } from '../domain/common.js';
import { EventId } from '../ids.js';
import { BurrowParam, endpoint, limitQuery } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

/** Same names as the web route (`/:burrow/log?actor=&kind=&who=&open=`). */
export const AuditQuery = z.object({
  actor: AuditActorFilter.default('everyone'),
  kind: AuditKindFilter.default('all'),
  /** "Only Banjo": agent or person handle; matches events by or about them. */
  who: Handle.optional(),
  before: Cursor.optional(),
  limit: limitQuery(100, 500),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export const AuditCountsSchema = z.object({
  all: Count,
  code: Count,
  asks: Count,
  keys: Count,
  /** 0.14 (vault.md VT-50). */
  vault: Count.default(0),
  messages: Count,
  blocked: Count,
});

export const AuditPage = z.object({
  /** Newest first. Only events with text (internals are hidden). */
  events: z.array(AuditEvent),
  /** Chip counts over the actor/who filter, ignoring the kind filter. */
  counts: AuditCountsSchema,
  before: Cursor.nullable(),
  hasMore: z.boolean(),
});
export type AuditPage = z.infer<typeof AuditPage>;

export const ChainReport = z.object({
  ok: z.boolean(),
  checked: Count,
  head: z.object({ seq: z.number().int(), hash: z.string() }).nullable(),
  failures: z.array(z.object({ seq: z.number().int(), id: z.string(), reason: z.string() })),
});

export const auditEndpoints = {
  list: endpoint({
    id: 'audit.list',
    method: 'GET',
    path: '/burrows/:burrow/audit',
    summary: 'Signed events matching the filters, verified on read, with kind counts.',
    params: B,
    query: AuditQuery,
    response: AuditPage,
  }),
  get: endpoint({
    id: 'audit.get',
    method: 'GET',
    path: '/burrows/:burrow/audit/:eventId',
    summary: 'One event (`?open=` deep link).',
    params: B.extend({ eventId: EventId }),
    response: z.object({ event: AuditEvent }),
  }),
  export: endpoint({
    id: 'audit.export',
    method: 'GET',
    path: '/burrows/:burrow/audit/export',
    summary: 'CSV of every event matching the current filter (`auditCsv()` columns).',
    params: B,
    query: AuditQuery.omit({ before: true, limit: true }),
    response: z.string(),
    contentType: 'text/csv',
  }),
  verify: endpoint({
    id: 'audit.verify',
    method: 'GET',
    path: '/burrows/:burrow/audit/verify',
    summary: 'Walk the whole chain: signatures and links.',
    params: B,
    response: ChainReport,
  }),
};
