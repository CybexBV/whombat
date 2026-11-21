/**
 * Automations (`automations.jsonl`, BF-05): every automation that isn't deleted — its published definition and saved
 * draft as stored (source ids; a restore remaps and validates them), summary, who made it, keys, tags and whether it had an
 * inbound webhook — and the destinations the person approved. Never the webhook secret, runs or cursors.
 */
import type { BackupAutomationsLine, JsonObject } from '@whombat/core';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { automationGrants, loadVersion, toAutomation } from '../../automations/store';
import { automationDestinations, automations } from '../../db/schema/index';
import { iso } from '../../lib/time';
import type { CategoryOut, CollectScope } from './scope';

const rec = (v: BackupAutomationsLine) =>
  v as BackupAutomationsLine & { type: string } & Record<string, unknown>;

export async function collectAutomations(scope: CollectScope, out: CategoryOut): Promise<void> {
  const { db, burrow } = scope;
  const rows = await db
    .select()
    .from(automations)
    .where(and(eq(automations.burrowId, burrow.id), isNull(automations.deletedAt)))
    .orderBy(asc(automations.createdAt));
  for (const row of rows) {
    const version = row.currentVersion ? await loadVersion(db, row.id, row.currentVersion) : null;
    const view = await toAutomation(db, row, { recentRuns: [] });
    const grants = await automationGrants(db, row.principalId);
    const definition = (version?.definition as unknown as JsonObject | undefined) ?? null;
    out.ref(row.id, row.principalId, row.createdById, version?.publishedById);
    for (const g of grants) out.ref(...(g.connections ?? []));
    await out.record(
      rec({
        type: 'automation',
        id: row.id,
        principal: row.principalId,
        name: row.name.slice(0, 80),
        description: (row.description ?? '').slice(0, 500),
        status: row.status,
        version: row.currentVersion ?? null,
        definition,
        draft: row.draftJson ?? null,
        createdBy: row.createdById,
        publishedBy: version?.publishedById ?? null,
        grants: grants.map((g) => ({
          keyId: g.keyId,
          tier: g.tier,
          repos: g.repos ?? null,
          connections: g.connections ?? null,
        })),
        webhook: row.webhookEnabled,
        summary: (view.summary ?? '').slice(0, 500),
        tags: (view.glance?.does ?? []).map((d) => d.id).slice(0, 16),
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      }),
    );
    // Ids inside the definitions (rooms, agents, connections) get directory entries where the maker may see them.
    for (const value of [definition, row.draftJson])
      if (value)
        for (const id of idsIn(value)) if (!id.startsWith('cnv_') || scope.readable.has(id)) out.ref(id);
  }
  const destinations = await db
    .select()
    .from(automationDestinations)
    .where(eq(automationDestinations.burrowId, burrow.id))
    .orderBy(asc(automationDestinations.approvedAt));
  for (const d of destinations) {
    out.ref(d.approvedById);
    await out.record(
      rec({
        type: 'destination',
        url: d.url.slice(0, 2000),
        approvedBy: d.approvedById,
        approvedAt: iso(d.approvedAt),
      }),
    );
  }
}

/** Whole-id strings in a JSON value. */
function idsIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    if (/^[a-z]{2,4}_[A-Za-z0-9_-]{1,64}$/.test(value)) into.add(value);
  } else if (Array.isArray(value)) for (const v of value) idsIn(v, into);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) idsIn(v, into);
  return into;
}
