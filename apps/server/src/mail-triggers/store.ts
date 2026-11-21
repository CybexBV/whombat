/**
 * Reading mail connections, listened mail triggers and mirrored mail items for automations.
 */
import type { AutomationDefinition, ConnectorProvider, MailTrigger } from '@whombat/core';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { automations, automationVersions, connections, mailTriggerItems } from '../db/schema/index';
import { thePersonAccountId } from '../domain/the-person';
import type { MirroredMailItem } from './items';

export type MailConnectionRow = typeof connections.$inferSelect;

/** All `mail` triggers on a definition. */
export function mailTriggersOf(definition: AutomationDefinition | null | undefined): MailTrigger[] {
  return (definition?.triggers ?? []).filter((t): t is MailTrigger => t.kind === 'mail');
}

/**
 * Loads a connected mailbox belonging to the burrow's person that has the `mail` service enabled;
 * returns null if it does not exist, belongs to another account, or lacks mail.
 */
export async function mailConnectionRow(
  db: Db | Tx,
  burrowId: string,
  connectionId: string,
): Promise<MailConnectionRow | null> {
  const accountId = await thePersonAccountId(db, burrowId);
  if (!accountId) return null;
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.accountId, accountId)));
  if (!row?.services.includes('mail')) return null;
  return row;
}

/** Every connected mailbox of the burrow's person (for `automation_read`'s `mailConnections`). */
export async function personMailConnections(db: Db | Tx, burrowId: string): Promise<MailConnectionRow[]> {
  const accountId = await thePersonAccountId(db, burrowId);
  if (!accountId) return [];
  const rows = await db.select().from(connections).where(eq(connections.accountId, accountId));
  return rows.filter((r) => r.services.includes('mail'));
}

export interface ListenedMailbox {
  burrowId: string;
  triggers: MailTrigger[];
}

/**
 * Every mailbox watched by at least one live (published, non-deleted) automation, together with all active
 * `mail` triggers listening to it so the watcher can match headers before fetching any message body.
 */
export async function listenedMailConnections(db: Db): Promise<Map<string, ListenedMailbox>> {
  const rows = await db
    .select({ burrowId: automations.burrowId, definition: automationVersions.definition })
    .from(automations)
    .innerJoin(
      automationVersions,
      and(
        eq(automationVersions.automationId, automations.id),
        eq(automationVersions.n, automations.currentVersion),
      ),
    )
    .where(
      and(
        eq(automations.status, 'published'),
        isNull(automations.deletedAt),
        sql`exists (select 1 from jsonb_array_elements(${automationVersions.definition} -> 'triggers') as t
          where t ->> 'kind' = 'mail')`,
      ),
    );
  const out = new Map<string, ListenedMailbox>();
  for (const { burrowId, definition } of rows) {
    for (const trigger of mailTriggersOf(definition)) {
      const existing = out.get(trigger.connectionId);
      if (existing) existing.triggers.push(trigger);
      else out.set(trigger.connectionId, { burrowId, triggers: [trigger] });
    }
  }
  return out;
}

/** Checks whether an incoming email has already been mirrored for this mailbox (avoids duplicate full reads). */
export async function hasMirroredMailItem(
  db: Db | Tx,
  connectionId: string,
  externalId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: mailTriggerItems.id })
    .from(mailTriggerItems)
    .where(and(eq(mailTriggerItems.connectionId, connectionId), eq(mailTriggerItems.externalId, externalId)));
  return Boolean(row);
}

/** Loads a mirrored matched email row for `eventFacts`; null when missing. */
export async function mirroredMailItem(db: Db | Tx, rowId: string): Promise<MirroredMailItem | null> {
  const [row] = await db.select().from(mailTriggerItems).where(eq(mailTriggerItems.id, rowId));
  if (!row) return null;
  return {
    id: row.id,
    burrowId: row.burrowId,
    connectionId: row.connectionId,
    provider: row.provider as ConnectorProvider,
    mailbox: row.mailbox,
    externalId: row.externalId,
    threadId: row.threadId,
    fromHeader: row.fromHeader,
    fromAddress: row.fromAddress,
    subject: row.subject,
    snippet: row.snippet,
    body: row.body,
    bodyTruncated: row.bodyTruncated,
    attachments: row.attachments,
    receivedAt: row.receivedAt,
  };
}
