/**
 * A Vault event's detail (docs/decisions/vault.md VT-52, VT-72; one-person.md OP-S70): signed texts stay neutral
 * (VT-51); reads and frames of audit events (`audit.list`, `audit.get`, `audit.export`, `audit.appended`) carry which
 * entry it was, what was done and how it ended — the person's, as everything in the Vault.
 */
import type { AuditEvent, AuditVaultDetail } from '@whombat/core';
import { and, inArray } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { vaultEntries, vaultUses } from '../db/schema/index';

/** Whether an audit event is about a Vault entry (its payload names one). */
export function isVaultEvent(e: Pick<AuditEvent, 'type' | 'payload'>): boolean {
  return (
    (e.type.startsWith('vault.') || e.type.startsWith('approval.')) &&
    typeof (e.payload as Record<string, unknown> | undefined)?.entryId === 'string'
  );
}

/** The Vault detail of these events, by event id. */
export async function auditVaultDetails(
  db: Db | Tx,
  events: readonly Pick<AuditEvent, 'id' | 'type' | 'payload'>[],
): Promise<Map<string, AuditVaultDetail>> {
  const out = new Map<string, AuditVaultDetail>();
  const about = events.filter(isVaultEvent);
  if (!about.length) return out;
  const entryIds = [...new Set(about.map((e) => String((e.payload as Record<string, unknown>).entryId)))];
  const entries = await db
    .select({ id: vaultEntries.id, name: vaultEntries.name })
    .from(vaultEntries)
    .where(inArray(vaultEntries.id, entryIds));
  const named = new Map(entries.map((e) => [e.id, e.name]));
  if (!named.size) return out;
  const uses = await db
    .select({
      eventId: vaultUses.eventId,
      what: vaultUses.what,
      outcome: vaultUses.outcome,
      entryId: vaultUses.entryId,
    })
    .from(vaultUses)
    .where(
      and(
        inArray(
          vaultUses.eventId,
          about.map((e) => e.id),
        ),
        inArray(vaultUses.entryId, [...named.keys()]),
      ),
    );
  const useOf = new Map(uses.map((u) => [u.eventId, u]));
  for (const e of about) {
    const entryId = String((e.payload as Record<string, unknown>).entryId);
    const name = named.get(entryId);
    if (name === undefined) continue;
    const use = useOf.get(e.id);
    out.set(e.id, {
      entryId,
      entryName: name,
      what: use && use.entryId === entryId ? use.what : null,
      outcome: use && use.entryId === entryId ? use.outcome : null,
    });
  }
  return out;
}

/** The events with `vault` filled on a Vault entry's events. */
export async function withAuditVaultDetail(db: Db | Tx, events: AuditEvent[]): Promise<AuditEvent[]> {
  const details = await auditVaultDetails(db, events);
  if (!details.size) return events;
  return events.map((e) => {
    const detail = details.get(e.id);
    return detail ? { ...e, vault: detail } : e;
  });
}
