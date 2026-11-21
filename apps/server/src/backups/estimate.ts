/**
 * What a backup file would hold for the person asking (`backups.estimate`, BF-02, BF-05, BF-D08): per category the
 * number the panel's line counts and roughly how many bytes it adds, cheaply (counts and sums, never the records
 * themselves).
 */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKUP_CATEGORY_IDS, type BackupCategoryEstimate, type BackupCategoryId } from '@whombat/core';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { BurrowRow } from '../commit/types';
import type { Db } from '../db/client';
import {
  attachments,
  automations,
  catalogConnections,
  connections,
  feedbackIntegrations,
  githubConnections,
  messages,
  principals,
  repos,
  vaultEntries,
} from '../db/schema/index';
import { agentNotesOf } from '../memory/notes';
import type { PrincipalRow } from '../read/principals';
import { readableConversations } from './collect/scope';

/** What one Hermes home adds to a file, roughly (its memory files, session store and learned skills). */
const HOME_GUESS_BYTES = 512 * 1024;

const n = (v: unknown) => Number(v ?? 0) || 0;

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      const st = await lstat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) await walk(p);
      else if (st.isFile()) total += st.size;
    }
  };
  await walk(dir);
  return total;
}

export async function estimateBackup(
  db: Db,
  burrow: BurrowRow,
  maker: PrincipalRow,
  /** The servers' line (`collect/servers.ts`: the hosts service's, not the database's); not offered without it. */
  servers: BackupCategoryEstimate | null = null,
): Promise<BackupCategoryEstimate[]> {
  const { readable } = await readableConversations(db, burrow.id);
  const conv = [...readable];
  const accountId = maker.accountId ?? '';
  const out = new Map<BackupCategoryId, BackupCategoryEstimate>();
  const set = (
    id: BackupCategoryId,
    count: number,
    bytes: number,
    extra: Partial<BackupCategoryEstimate> = {},
  ) =>
    out.set(id, {
      id,
      count,
      bytes: Math.max(0, Math.round(bytes)),
      offered: true,
      ...extra,
    });

  const [agents] = await db
    .select({
      c: sql<number>`count(*)::int`,
      b: sql<number>`coalesce(sum(length(coalesce(${principals.job}, '')) + 1500), 0)::bigint`,
    })
    .from(principals)
    .where(and(eq(principals.burrowId, burrow.id), eq(principals.kind, 'agent'), isNull(principals.system)));
  set('agents', n(agents?.c), n(agents?.b));

  // The maker's own Hermes home (hermes-engine.md HE-S123): its size is the runner's, so a fixed guess here, plus the
  // agent's notes.
  const notes = await agentNotesOf(db, burrow.id);
  set('memories', accountId ? 1 : 0, (accountId ? HOME_GUESS_BYTES : 0) + (notes?.text.length ?? 0) + 250);

  const [auto] = await db
    .select({
      c: sql<number>`count(*)::int`,
      b: sql<number>`coalesce(sum(coalesce(pg_column_size(${automations.draftJson}), 0) + 2500), 0)::bigint`,
    })
    .from(automations)
    .where(and(eq(automations.burrowId, burrow.id), isNull(automations.deletedAt)));
  set('automations', n(auto?.c), n(auto?.b) * 2);

  const [catalog] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(catalogConnections)
    .where(eq(catalogConnections.burrowId, burrow.id));
  const [google] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(connections)
    .where(eq(connections.accountId, accountId));
  const [sources] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(feedbackIntegrations)
    .where(eq(feedbackIntegrations.burrowId, burrow.id));
  const [gh] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(githubConnections)
    .where(eq(githubConnections.burrowId, burrow.id));
  const connCount = n(catalog?.c) + n(google?.c) + n(sources?.c) + n(gh?.c);
  set('connections', connCount, connCount * 1500);

  // Skills are Hermes's (hermes-engine.md HE-41): the runner's archives carry them (stream M), not the store's tables.
  set('skills', 0, 0);

  // The person and the settings (OP-S75).
  set('settings', 1, 1800);

  const [vault] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(vaultEntries)
    .where(and(eq(vaultEntries.burrowId, burrow.id), eq(vaultEntries.ownerId, maker.id)));
  set('vault', n(vault?.c), n(vault?.c) * 1200);

  const [msg] = conv.length
    ? await db
        .select({
          c: sql<number>`count(*)::int`,
          b: sql<number>`coalesce(sum(length(${messages.text}) + coalesce(pg_column_size(${messages.card}), 0) + 350), 0)::bigint`,
        })
        .from(messages)
        .where(
          and(
            inArray(messages.conversationId, conv),
            or(isNull(messages.deletedAt), sql`${messages.replyCount} > 0`),
          ),
        )
    : [{ c: 0, b: 0 }];
  set('messages', n(msg?.c), n(msg?.b));

  let files: { c: number; b: number } | undefined = { c: 0, b: 0 };
  if (conv.length) {
    const blobs = db
      .selectDistinctOn([attachments.sha256], { sha256: attachments.sha256, size: attachments.size })
      .from(attachments)
      .where(
        and(
          inArray(attachments.conversationId, conv),
          eq(attachments.state, 'ready'),
          or(sql`${attachments.filedAt} is not null`, sql`${attachments.messageId} is not null`),
        ),
      )
      .as('blobs');
    [files] = await db
      .select({ c: sql<number>`count(*)::int`, b: sql<number>`coalesce(sum(${blobs.size}), 0)::bigint` })
      .from(blobs);
  }
  set('files', n(files?.c), n(files?.b));

  const local = await db
    .select({ originPath: repos.originPath })
    .from(repos)
    .where(and(eq(repos.burrowId, burrow.id), eq(repos.source, 'local')));
  let repoBytes = 0;
  for (const r of local) if (r.originPath) repoBytes += await dirBytes(r.originPath);
  set('repositories', local.length, repoBytes);
  // The servers are the hosts service's to count, where they are offered (BF-13).
  if (servers) out.set('servers', servers);
  else set('servers', 0, 0, { offered: false });

  return BACKUP_CATEGORY_IDS.map((id) => out.get(id) as BackupCategoryEstimate);
}
