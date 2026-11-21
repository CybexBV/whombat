/**
 * Audit log read side: filters and chip counts (same semantics as core's `filterAuditEvents` /
 * `countAuditKinds`), newest first with a `seq` cursor, every event verified on read (hash, signature by
 * the actor's key, link to its predecessor), CSV export of the current filter.
 */
import {
  type AuditActorFilter,
  type AuditApprovalState,
  type AuditCounts,
  type AuditEvent,
  type AuditKindFilter,
  type AuditPage,
  auditCsv,
  GENESIS_HASH,
  verifyEvent,
} from '@whombat/core';
import { and, desc, eq, inArray, isNotNull, lt, or, type SQL, sql } from 'drizzle-orm';
import { rowToSignedEvent, toAuditEvent } from '../audit/events';
import type { BurrowRow } from '../commit/types';
import type { Db } from '../db/client';
import { approvals, events, principals } from '../db/schema/index';
import { isoOrNull } from '../lib/time';
import { withAuditVaultDetail } from '../vault/detail';
import { loadPrincipalRows, shortName } from './principals';

const KIND_OF: Record<Exclude<AuditKindFilter, 'all'>, string> = {
  code: 'Code',
  asks: 'Asks',
  keys: 'Keys',
  vault: 'Vault',
  messages: 'Messages',
  blocked: 'Blocked',
};

export interface AuditFilterInput {
  actor: AuditActorFilter;
  kind: AuditKindFilter;
  who?: string | undefined;
}

async function baseConditions(db: Db, burrowId: string, filter: AuditFilterInput): Promise<SQL[] | null> {
  const where: SQL[] = [eq(events.burrowId, burrowId), isNotNull(events.text)];
  if (filter.actor !== 'everyone') {
    const kind = filter.actor === 'agents' ? 'agent' : 'person';
    where.push(
      sql`${events.actorId} in (select ${principals.id} from ${principals} where ${principals.burrowId} = ${burrowId} and ${principals.kind} = ${kind})`,
    );
  }
  if (filter.who) {
    const [who] = await db
      .select({ id: principals.id })
      .from(principals)
      .where(and(eq(principals.burrowId, burrowId), eq(principals.handle, filter.who)));
    if (!who) return null;
    const match = or(eq(events.actorId, who.id), eq(events.aboutId, who.id));
    if (match) where.push(match);
  }
  return where;
}

/** Verifies events against their actors' keys and the predecessor of each in the chain. */
async function verified(
  db: Db,
  burrowId: string,
  rows: (typeof events.$inferSelect)[],
): Promise<AuditEvent[]> {
  if (rows.length === 0) return [];
  const actorIds = [...new Set(rows.map((r) => r.actorId))];
  const keyRows = await db
    .select({ id: principals.id, publicKey: principals.publicKey })
    .from(principals)
    .where(inArray(principals.id, actorIds));
  const keys = new Map(keyRows.map((k) => [k.id, k.publicKey]));
  const prevSeqs = [...new Set(rows.map((r) => r.seq - 1).filter((s) => s > 0))];
  const prevRows = prevSeqs.length
    ? await db
        .select({ seq: events.seq, hash: events.hash })
        .from(events)
        .where(and(eq(events.burrowId, burrowId), inArray(events.seq, prevSeqs)))
    : [];
  const prevHash = new Map(prevRows.map((p) => [p.seq, p.hash]));
  const approvalIds = rows
    .filter((r) => r.approvalId && r.type === 'approval.requested')
    .map((r) => r.approvalId as string);
  const approvalRows = approvalIds.length
    ? await db.select().from(approvals).where(inArray(approvals.id, approvalIds))
    : [];
  const approvalState = new Map<string, AuditApprovalState>(
    approvalRows.map((a) => [
      a.id,
      {
        number: a.number,
        state: a.state,
        decidedById: a.decidedById,
        decidedAt: isoOrNull(a.decidedAt),
        executedAt: isoOrNull(a.executedAt),
      },
    ]),
  );
  return rows.map((row) => {
    const event = rowToSignedEvent(row);
    const key = keys.get(row.actorId);
    const single = key ? verifyEvent(event, key).ok : false;
    const expectedPrev = row.seq === 1 ? GENESIS_HASH : prevHash.get(row.seq - 1);
    const linked = expectedPrev !== undefined && expectedPrev === row.prevHash;
    const approval =
      row.approvalId && row.type === 'approval.requested'
        ? (approvalState.get(row.approvalId) ?? null)
        : null;
    return toAuditEvent(event, single && linked, approval);
  });
}

/** A page of the log, events about a Vault entry with its detail (docs/decisions/vault.md VT-52). */
export async function auditPage(
  db: Db,
  burrowId: string,
  filter: AuditFilterInput & { before?: string | undefined; limit: number },
): Promise<AuditPage> {
  const empty: AuditPage = {
    events: [],
    counts: { all: 0, code: 0, asks: 0, keys: 0, vault: 0, messages: 0, blocked: 0 },
    before: null,
    hasMore: false,
  };
  const base = await baseConditions(db, burrowId, filter);
  if (!base) return empty;
  const countRows = await db
    .select({ kind: events.kind, n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(...base))
    .groupBy(events.kind);
  const counts: AuditCounts = { all: 0, code: 0, asks: 0, keys: 0, vault: 0, messages: 0, blocked: 0 };
  for (const r of countRows) {
    counts.all += r.n;
    for (const [f, k] of Object.entries(KIND_OF)) if (k === r.kind) counts[f as keyof AuditCounts] += r.n;
  }
  const where = [...base];
  if (filter.kind !== 'all') where.push(eq(events.kind, KIND_OF[filter.kind] as never));
  if (filter.before && /^\d+$/.test(filter.before)) where.push(lt(events.seq, Number(filter.before)));
  const rows = await db
    .select()
    .from(events)
    .where(and(...where))
    .orderBy(desc(events.seq))
    .limit(filter.limit + 1);
  const hasMore = rows.length > filter.limit;
  const page = rows.slice(0, filter.limit);
  const last = page[page.length - 1];
  return {
    events: await withAuditVaultDetail(db, await verified(db, burrowId, page)),
    counts,
    before: hasMore && last ? String(last.seq) : null,
    hasMore,
  };
}

/**
 * One event of the log by id — a listed one only: hidden events (`text` null, such as `browser.used`, whose payload
 * holds a page's origin) are never listed and are not found here either (BT-D47).
 */
export async function auditEvent(db: Db, burrowId: string, id: string): Promise<AuditEvent | null> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.burrowId, burrowId), eq(events.id, id), isNotNull(events.text)));
  const [event] = await withAuditVaultDetail(db, await verified(db, burrowId, rows));
  return event ?? null;
}

/** CSV of every event matching the filter (up to 10 000), the `vault` column on a Vault entry's rows. */
export async function auditExport(db: Db, burrow: BurrowRow, filter: AuditFilterInput, now: Date) {
  const base = await baseConditions(db, burrow.id, filter);
  const where = base ? [...base] : null;
  if (where && filter.kind !== 'all') where.push(eq(events.kind, KIND_OF[filter.kind] as never));
  const rows = where
    ? await db
        .select()
        .from(events)
        .where(and(...where))
        .orderBy(desc(events.seq))
        .limit(10_000)
    : [];
  const list = await withAuditVaultDetail(db, await verified(db, burrow.id, rows));
  const people = await loadPrincipalRows(db, burrow.id);
  const byId = new Map(people.map((p) => [p.id, p]));
  const csv = auditCsv(list, {
    principal: (id) => {
      const p = byId.get(id);
      if (!p) return undefined;
      return p.kind !== 'person'
        ? { kind: 'agent', name: p.name, shortName: p.name }
        : { kind: 'person', name: p.name, shortName: shortName(p) };
    },
    now,
    timeZone: burrow.timeZone,
  });
  return { csv, count: list.length };
}
