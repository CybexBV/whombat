/**
 * Looks ahead findings in the person's Inbox (docs/decisions/looks-ahead.md): unsolicited findings land here first as
 * calm `info` items with their short title, body, verified sources and optional one-tap next step, and promote to a
 * Chat thread only when the person acts or replies. Findings the person explicitly asked for (`ahead_watch`), or that
 * already have a Chat thread, stay in Chat and never appear here.
 */
import { AHEAD_SOURCES_MAX, type NeedsYouItem } from '@whombat/core';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { aheadChecks, aheadMatters, messages } from '../db/schema/index';
import { registerNeedsYouSource, type SourceCtx } from '../home/registry';
import { iso } from '../lib/time';
import { loadPrincipalRow } from '../read/principals';
import { findingTitle } from './commands';

const INBOX_LIMIT = 40;
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** Reads open unpromoted Looks ahead findings for the person's Inbox. */
export async function looksAheadNeedsYou(ctx: SourceCtx): Promise<NeedsYouItem[]> {
  const person = ctx.reads?.person ?? (await loadPrincipalRow(ctx.db, ctx.personId));
  if (person?.kind !== 'person') return [];
  const rows = await ctx.db
    .select({
      id: aheadChecks.id,
      source: aheadChecks.source,
      summary: aheadChecks.summary,
      kind: aheadChecks.kind,
      title: aheadChecks.title,
      text: aheadChecks.text,
      sources: aheadChecks.sources,
      actionLabel: aheadChecks.actionLabel,
      reportedAt: aheadChecks.reportedAt,
      startedAt: aheadChecks.startedAt,
      matterId: aheadChecks.matterId,
    })
    .from(aheadChecks)
    .where(
      and(
        eq(aheadChecks.burrowId, ctx.burrowId),
        eq(aheadChecks.personId, ctx.personId),
        eq(aheadChecks.state, 'told'),
        isNull(aheadChecks.promotedAt),
        isNull(aheadChecks.settledAt),
        isNull(aheadChecks.feedback),
        // Rows from before this change (or from an older binary after rollback) already live in Chat.
        sql`not exists (select 1 from ${messages} m where m.id = ${aheadChecks.threadRootId})`,
      ),
    )
    .orderBy(desc(aheadChecks.reportedAt), desc(aheadChecks.startedAt))
    .limit(INBOX_LIMIT);

  if (!rows.length) return [];

  const matterIds = [...new Set(rows.flatMap((r) => (r.matterId ? [r.matterId] : [])))];
  const matterTitles = new Map(
    matterIds.length
      ? (
          await ctx.db
            .select({ id: aheadMatters.id, title: aheadMatters.title })
            .from(aheadMatters)
            .where(inArray(aheadMatters.id, matterIds))
        ).map((m) => [m.id, m.title])
      : [],
  );

  const items: NeedsYouItem[] = [];
  for (const r of rows) {
    if (!r.kind || !r.text) continue;
    const matterTitle = r.matterId ? matterTitles.get(r.matterId) : undefined;
    const title = findingTitle(r.title ?? undefined, r.text, matterTitle ?? r.summary);
    const source: 'calendar' | 'mail' | 'matter' =
      r.source === 'calendar' ? 'calendar' : r.source === 'matter' ? 'matter' : 'mail';
    items.push({
      id: `ahead:${r.id}`,
      ref: { kind: 'ahead', id: r.id },
      kind: 'ahead',
      severity: 'info',
      title: clip(title, 200),
      body: clip(r.text, 600),
      at: iso(r.reportedAt ?? r.startedAt),
      actions: [],
      ahead: {
        checkId: r.id,
        source,
        kind: r.kind,
        sources: (r.sources ?? []).slice(0, AHEAD_SOURCES_MAX),
        ...(r.actionLabel ? { action: r.actionLabel } : {}),
        ...(r.matterId ? { matter: true } : {}),
        ...(matterTitle ? { matterTitle } : {}),
      },
    });
  }
  return items;
}

/** Registers the Looks ahead Inbox source (idempotent). */
export function registerLooksAheadSource(): void {
  registerNeedsYouSource('looks-ahead', looksAheadNeedsYou);
}
