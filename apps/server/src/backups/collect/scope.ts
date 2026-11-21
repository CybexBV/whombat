/**
 * What making a backup file reads (docs/decisions/backup-file.md BF-02, BF-05, BF-D05): the burrow as its maker sees it,
 * in one read-only snapshot. `CollectScope` says what the maker may see; `CollectOut` takes each category's records,
 * the ids they refer to (for `directory.jsonl`) and the bytes they point to (blobs, canvases, repository bundles).
 */
import {
  type BackupCategoryId,
  type BackupDirectoryEntry,
  type BackupNote,
  type BackupNoteCode,
  backupRecordCount,
  encodeBackupLine,
  parseBackupRecord,
} from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { BurrowRow } from '../../commit/types';
import type { Db } from '../../db/client';
import {
  accounts,
  automations,
  canvases,
  catalogConnections,
  connections,
  conversations,
  principals,
  repos,
  vaultEntries,
  vaultSshServers,
} from '../../db/schema/index';
import type { PrincipalRow } from '../../read/principals';
import type { Services } from '../../services';
import type { Spool } from '../spool';
import type { CollectSource } from './source';

export interface CollectScope {
  services: Services;
  /** The snapshot (a read-only, repeatable-read transaction). */
  db: Db;
  burrow: BurrowRow;
  maker: PrincipalRow;
  makerEmail: string;
  /** Conversations the maker reads: every one of the burrow (OP-S75). */
  readable: ReadonlySet<string>;
  /** The categories in this file. */
  categories: ReadonlySet<BackupCategoryId>;
  /** The job's scratch directory (spools, bundles), removed when the job ends. */
  scratch: string;
  /** Where the bytes records point to are read: the running Whombat's, or a backup opened for reading. */
  source: CollectSource;
}

/** The conversations the person reads in a burrow: every one (one-person.md OP-S75). */
export async function readableConversations(db: Db, burrowId: string): Promise<{ readable: Set<string> }> {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.burrowId, burrowId));
  return { readable: new Set(rows.map((r) => r.id)) };
}

/** Bytes a record points to, written after the records (each blob once). */
export interface BlobSource {
  sha256: string;
  size: number;
  open(): Promise<AsyncIterable<Uint8Array>>;
}

/** A category's records as they are written: counted, measured and kept in its spool. */
export class CategoryOut {
  count = 0;
  lines = 0;
  /** Bytes of its `.jsonl` and of the blobs only it brought in. */
  bytes = 0;

  constructor(
    readonly id: BackupCategoryId,
    readonly spool: Spool,
    private readonly out: CollectOut,
    /** Which records go in (bringing back what the person picked from a backup, backup-look.md); unset, every one. */
    private readonly keep?: (value: { type: string } & Record<string, unknown>) => boolean,
  ) {}

  /** Writes one record (checked against its schema outside production; a bad one is a bug, not a file). */
  async record(value: { type: string } & Record<string, unknown>): Promise<void> {
    if (this.keep && !this.keep(value)) return;
    if (this.out.services.config.NODE_ENV !== 'production') {
      const parsed = parseBackupRecord(this.id, value);
      if (!parsed.ok) throw new Error(`backup ${this.id}.${value.type}: ${parsed.problem}`);
    }
    const line = encodeBackupLine(value);
    await this.spool.write(line);
    this.bytes += line.length;
    this.lines++;
    // A counted type is one thing; a `servers_hub` its servers (CT-903).
    this.count += backupRecordCount(this.id, value as { type: string; servers?: readonly unknown[] });
    this.out.tick();
  }

  /** Something making the file had to leave out, for the manifest's notes (BF-19, BF-S12). */
  note(code: BackupNoteCode, n = 1): void {
    if (n <= 0) return;
    const key = `${code}:${this.id}`;
    const have = this.out.notes.get(key);
    if (have) have.count += n;
    else this.out.notes.set(key, { code, category: this.id, count: n });
  }

  /** The record refers to these ids (their directory entries are written). */
  ref(...ids: (string | null | undefined)[]): void {
    for (const id of ids) if (id) this.out.refs.add(id);
  }

  /** The record points to bytes kept under `files/<sha256>` (each blob once in the file). */
  blob(source: BlobSource): void {
    if (this.out.blobs.has(source.sha256)) return;
    this.out.blobs.set(source.sha256, source);
    this.bytes += source.size;
  }
}

export class CollectOut {
  /** Ids the records refer to. */
  readonly refs = new Set<string>();
  readonly blobs = new Map<string, BlobSource>();
  /** Canvases' Yjs states by canvas id (spooled while collecting: the size goes in the entry's header). */
  readonly canvases = new Map<string, Spool>();
  /** Repository bundles by repository name (a file in the job's scratch). */
  readonly bundles = new Map<string, { size: number; path: string }>();
  /** Directory entries made while collecting (the burrow first). */
  readonly directory = new Map<string, BackupDirectoryEntry>();
  /** What the collectors had to leave out, by code and category (the manifest's notes). */
  readonly notes = new Map<string, BackupNote>();
  /** The hosts service's own backup (`servers/hub.tar.gz`, BF-13), spooled encrypted: it holds its authority's key. */
  hostsBackup: { spool: Spool; size: number; sha256: string } | null = null;

  constructor(
    readonly services: Services,
    readonly tick: () => void,
  ) {}
}

/**
 * Directory entries for every id the records refer to that the collectors didn't describe themselves, by the id's kind.
 * Entries refer to more ids (a DM's agent and person, a skill's agent): those are described too. An id the maker
 * may not see (a conversation they can't read) is never described — collectors leave such references out.
 */
export async function describeRefs(scope: CollectScope, out: CollectOut): Promise<void> {
  const db = scope.db;
  const burrowId = scope.burrow.id;
  for (let round = 0; round < 6; round++) {
    const missing = [...out.refs].filter((id) => !out.directory.has(id));
    if (missing.length === 0) return;
    const of = (prefix: string) => missing.filter((id) => id.startsWith(`${prefix}_`));
    for (const id of missing) if (id === burrowId) out.directory.set(id, burrowEntry(scope.burrow));
    for (const ids of chunks(of('prn'))) {
      const rows = await db
        .select()
        .from(principals)
        .where(and(eq(principals.burrowId, burrowId), inArray(principals.id, ids)));
      for (const r of rows) out.directory.set(r.id, principalEntry(r));
    }
    for (const ids of chunks(of('cnv').filter((id) => scope.readable.has(id)))) {
      const rows = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.burrowId, burrowId), inArray(conversations.id, ids)));
      for (const r of rows) {
        const dm = r.kind === 'dm' && r.dmPersonId ? { person: r.dmPersonId } : null;
        if (dm) out.refs.add(dm.person);
        out.directory.set(r.id, {
          type: 'conversation',
          id: r.id,
          kind: r.kind,
          slug: r.slug.slice(0, 200) || r.id,
          title: (r.title || r.slug || r.id).slice(0, 200),
          // A DM is found by its person and task key on another box; a task chat keeps its title (BF-S13).
          taskKey: r.taskKey ?? null,
          chatTitle: r.chatTitle ? r.chatTitle.slice(0, 200) : null,
          chatSubject:
            r.chatSubjectKind && r.chatSubjectId
              ? {
                  kind: r.chatSubjectKind,
                  id: r.chatSubjectId.slice(0, 200),
                  name: (r.chatSubjectName ?? '').slice(0, 120),
                }
              : null,
          chatArchivedAt: r.chatArchivedAt ? r.chatArchivedAt.toISOString() : null,
          dm,
        });
      }
    }
    const conIds = of('con');
    for (const ids of chunks(conIds)) {
      const rows = await db
        .select({
          id: catalogConnections.id,
          catalogId: catalogConnections.catalogId,
          handle: catalogConnections.handle,
          label: catalogConnections.label,
          baseUrl: catalogConnections.baseUrl,
        })
        .from(catalogConnections)
        .where(inArray(catalogConnections.id, ids));
      for (const r of rows)
        out.directory.set(r.id, {
          type: 'connection',
          id: r.id,
          source: 'catalog',
          service: r.catalogId,
          handle: r.handle,
          label: (r.label || r.catalogId).slice(0, 200),
          address: r.baseUrl || null,
          account: null,
        });
      const google = await db
        .select({
          id: connections.id,
          provider: connections.provider,
          email: connections.email,
          owner: accounts.email,
        })
        .from(connections)
        .leftJoin(accounts, eq(accounts.id, connections.accountId))
        .where(inArray(connections.id, ids));
      for (const r of google)
        out.directory.set(r.id, {
          type: 'connection',
          id: r.id,
          source: 'connector',
          service: r.provider,
          handle: null,
          label: (r.email || r.provider).slice(0, 200),
          address: null,
          account: r.email,
        });
    }
    for (const ids of chunks(of('rep'))) {
      const rows = await db
        .select({ id: repos.id, fullName: repos.fullName, source: repos.source })
        .from(repos)
        .where(and(eq(repos.burrowId, burrowId), inArray(repos.id, ids)));
      for (const r of rows)
        out.directory.set(r.id, {
          type: 'repo',
          id: r.id,
          fullName: r.fullName,
          source: r.source ?? 'github',
        });
    }
    for (const ids of chunks(of('aut'))) {
      const rows = await db
        .select({ id: automations.id, name: automations.name, principalId: automations.principalId })
        .from(automations)
        .where(and(eq(automations.burrowId, burrowId), inArray(automations.id, ids)));
      for (const r of rows) {
        const entry = {
          type: 'automation' as const,
          id: r.id,
          principalId: r.principalId,
          name: r.name.slice(0, 200),
        };
        out.directory.set(r.id, entry);
      }
    }
    for (const ids of chunks(of('vlt'))) {
      const rows = await db
        .select({
          id: vaultEntries.id,
          ownerId: vaultEntries.ownerId,
          kind: vaultEntries.kind,
          name: vaultEntries.name,
        })
        .from(vaultEntries)
        .where(
          and(
            eq(vaultEntries.burrowId, burrowId),
            eq(vaultEntries.ownerId, scope.maker.id),
            inArray(vaultEntries.id, ids),
          ),
        );
      for (const r of rows)
        out.directory.set(r.id, {
          type: 'vault_entry',
          id: r.id,
          kind: r.kind,
          name: r.name,
        });
    }
    for (const ids of chunks(of('vss'))) {
      const rows = await db
        .select({ id: vaultSshServers.id, entryId: vaultSshServers.entryId, name: vaultSshServers.name })
        .from(vaultSshServers)
        .innerJoin(vaultEntries, eq(vaultEntries.id, vaultSshServers.entryId))
        .where(and(eq(vaultEntries.ownerId, scope.maker.id), inArray(vaultSshServers.id, ids)));
      for (const r of rows) {
        out.refs.add(r.entryId);
        out.directory.set(r.id, { type: 'vault_ssh_server', id: r.id, entry: r.entryId, name: r.name });
      }
    }
    for (const ids of chunks(of('cvs'))) {
      const rows = await db
        .select({
          id: canvases.id,
          slug: canvases.slug,
          title: canvases.title,
          conversationId: canvases.conversationId,
        })
        .from(canvases)
        .where(and(eq(canvases.burrowId, burrowId), inArray(canvases.id, ids)));
      for (const r of rows)
        if (!r.conversationId || scope.readable.has(r.conversationId))
          out.directory.set(r.id, {
            type: 'canvas',
            id: r.id,
            slug: r.slug.slice(0, 200),
            title: (r.title || r.slug).slice(0, 200),
          });
    }
    // Ids nothing above knows (a run, a plan, a message): they stay out of the directory, and a restore drops them.
    for (const id of missing) if (!out.directory.has(id)) out.refs.delete(id);
  }
}

function* chunks(ids: string[], size = 500): Generator<string[]> {
  for (let i = 0; i < ids.length; i += size) yield ids.slice(i, i + size);
}

/** The directory's first line: the source burrow. */
export function burrowEntry(burrow: BurrowRow): BackupDirectoryEntry {
  return {
    type: 'burrow',
    id: burrow.id,
    name: burrow.name.slice(0, 200),
    slug: burrow.slug.slice(0, 200),
    timeZone: burrow.timeZone || 'UTC',
  };
}

/** A principal's directory entry: a person by email, the agent by handle, a system. */
export function principalEntry(r: PrincipalRow): BackupDirectoryEntry {
  if (r.kind === 'person')
    return {
      type: 'person',
      id: r.id,
      accountId: r.accountId ?? null,
      email: (r.email ?? `${r.handle}@example.com`).toLowerCase(),
      name: r.name.slice(0, 200),
      handle: r.handle,
    };
  if (r.system)
    return { type: 'system', id: r.id, system: r.system, name: r.name.slice(0, 200), handle: r.handle };
  return {
    type: 'agent',
    id: r.id,
    handle: r.handle,
    name: r.name.slice(0, 200),
  };
}

/** The burrow's agent (one-agent.md OA-01), as a list. */
export async function liveAgents(db: Db, burrowId: string): Promise<PrincipalRow[]> {
  return db
    .select()
    .from(principals)
    .where(and(eq(principals.burrowId, burrowId), eq(principals.kind, 'agent')));
}
