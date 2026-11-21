/**
 * One pass of a restore over some records (docs/decisions/backup-file.md BF-04, BF-D06): the preview (`dry`, reading
 * only) and each batch of the restore job (inside its `backup.restore_batch` command's transaction) share it. It
 * resolves the file's source ids onto this burrow's own — the restore map first, then the thing's portable key from
 * `directory.jsonl` (a person's email, an agent's handle, a channel's slug …) — remembers what it found or made, and
 * counts what each record did and what a person should know.
 */

import { join } from 'node:path';
import {
  type BackupCategoryId,
  type BackupDirectoryEntry,
  type BackupNoteCode,
  type BackupOnDifferent,
  backupRecordCount,
  type JsonValue,
  remapBackupIds,
} from '@whombat/core';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ApplyContext, BurrowRow } from '../../commit/types';
import type { ToolLimits } from '../../connections/limits';
import type { Db, Tx } from '../../db/client';
import {
  automations,
  backupRestoreMap,
  canvases,
  catalogConnections,
  connections,
  conversations,
  principals,
  repos,
  vaultEntries,
  vaultSshServers,
} from '../../db/schema/index';
import { loadAgentRow, type PrincipalRow } from '../../read/principals';
import type { Services } from '../../services';

/** What one record did (`detail`: a record that isn't counted, e.g. a destination). */
export type RecordOutcome = 'added' | 'updated' | 'unchanged' | 'kept' | 'skipped' | 'detail';

export interface CategoryTally {
  added: number;
  updated: number;
  unchanged: number;
  kept: number;
  skipped: number;
  /** Preview: different from what is here (`kept` or `updated` once restored). */
  different: number;
}

export const emptyTally = (): CategoryTally => ({
  added: 0,
  updated: 0,
  unchanged: 0,
  kept: 0,
  skipped: 0,
  different: 0,
});

/** A tool's tier and limits as the file has them. */
export interface RestoredTool {
  name: string;
  tier: 'can' | 'ask' | 'off';
  hash: string;
  limits?: ToolLimits | null;
}

/** What a batch hands back to the job beyond its counts. */
export interface RestoreFollowUps {
  /** Catalog connections (and connector accounts) to check once the restore has them. */
  checkConnections: {
    id: string;
    source: 'catalog' | 'connector';
    label: string;
    /** Tool tiers and limits the person chose, put back once the check found the tools (by name). */
    tools?: RestoredTool[];
    /** A built-in connection: never checked, its tiers put back as they are (BF-19). */
    builtin?: boolean;
    /** Its sign-in couldn't go in the file: it asks for one without a check (BF-S12). */
    needsSignIn?: boolean;
  }[];
  automationsOff: number;
  schedulesPaused: number;
  /** Home networks to add to this Whombat's list (the restorer's account, after the batch). */
  homeNetworks: { cidr: string; ports: number[]; note: string }[];
}

export const emptyFollowUps = (): RestoreFollowUps => ({
  checkConnections: [],
  automationsOff: 0,
  schedulesPaused: 0,
  homeNetworks: [],
});

export interface RunMark {
  journal: number;
  pending: number;
  checks: number;
  networks: number;
  automationsOff: number;
  schedulesPaused: number;
}

export interface RestoreRunOptions {
  services: Services;
  db: Db | Tx;
  burrow: BurrowRow;
  restorer: PrincipalRow;
  /** The restorer's account email (their own things in the file: Google and Microsoft accounts, Vault, profile). */
  restorerEmail: string;
  sourceBurrowId: string;
  onDifferent: BackupOnDifferent;
  /** Preview: nothing is written; new things get stand-in ids so later records still count as new. */
  dry: boolean;
  directory: ReadonlyMap<string, BackupDirectoryEntry>;
  /** Inside the restore batch command (null when dry). */
  ctx: ApplyContext | null;
  /** The source burrow's maker email (the file's `madeBy`), for things that were the maker's own. */
  makerEmail: string;
  /** The job's scratch directory: blobs (`blob-<sha256>`), canvases and bundles from the file. Null in a preview. */
  scratch: string | null;
  /** The blobs the file holds (sha256), whether or not they were kept in the scratch. */
  blobs: ReadonlySet<string>;
  /** Keep each record's outcome by its key (bringing back picked things from a backup, backup-look.md). */
  outcomes?: boolean;
}

export class RestoreRun {
  readonly services: Services;
  readonly db: Db | Tx;
  readonly burrow: BurrowRow;
  readonly restorer: PrincipalRow;
  readonly restorerEmail: string;
  readonly sourceBurrowId: string;
  readonly sameBurrow: boolean;
  readonly onDifferent: BackupOnDifferent;
  readonly dry: boolean;
  readonly directory: ReadonlyMap<string, BackupDirectoryEntry>;
  readonly makerEmail: string;
  readonly scratch: string | null;
  readonly blobs: ReadonlySet<string>;
  private readonly applyCtx: ApplyContext | null;
  /** Source id → target id, found in this run (restore map rows, keys, made). */
  private readonly found = new Map<string, string | null>();
  /** Pairs to write into the restore map at the end of the batch. */
  private readonly pending: { sourceId: string; targetId: string; category: string }[] = [];
  readonly tallies = new Map<BackupCategoryId, CategoryTally>();
  readonly notes = new Map<
    string,
    { code: BackupNoteCode; category: BackupCategoryId | null; count: number }
  >();
  readonly followUps = emptyFollowUps();
  /** Unknown authors kept as names (counted once each). */
  readonly unknownAuthors = new Set<string>();
  /** Conversations that got messages or files (their members' read markers move past them, BF-D09). */
  readonly touched = new Set<string>();
  private readonly journal: [string, string | null | undefined][] = [];
  /** Each record's outcome by its key, when asked for (`outcomes`). */
  readonly outcomes: [string, RecordOutcome][] | null;

  constructor(o: RestoreRunOptions) {
    this.services = o.services;
    this.db = o.db;
    this.burrow = o.burrow;
    this.restorer = o.restorer;
    this.restorerEmail = o.restorerEmail.toLowerCase();
    this.sourceBurrowId = o.sourceBurrowId;
    this.sameBurrow = o.sourceBurrowId === o.burrow.id;
    this.onDifferent = o.onDifferent;
    this.dry = o.dry;
    this.directory = o.directory;
    this.applyCtx = o.ctx;
    this.makerEmail = o.makerEmail.toLowerCase();
    this.scratch = o.scratch;
    this.blobs = o.blobs;
    this.outcomes = o.outcomes ? [] : null;
  }

  /** Whether the file holds a blob (a preview knows from the file, a restore from its scratch). */
  hasBlob(sha256: string): boolean {
    return this.blobs.has(sha256);
  }

  /** A blob's bytes in the job's scratch, or null (not in the file, or a preview). */
  blobPath(sha256: string): string | null {
    if (!this.scratch || !this.blobs.has(sha256) || !/^[0-9a-f]{64}$/.test(sha256)) return null;
    return join(this.scratch, `blob-${sha256}`);
  }

  /** A canvas's Yjs state in the job's scratch (by its source id), or null. */
  canvasPath(sourceId: string): string | null {
    if (!this.scratch || !/^cvs_[A-Za-z0-9_-]{1,64}$/.test(sourceId)) return null;
    return join(this.scratch, `canvas-${sourceId}`);
  }

  /** A repository's bundle in the job's scratch, or null. */
  bundlePath(name: string): string | null {
    if (!this.scratch || !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name)) return null;
    return join(this.scratch, `bundle-${name}`);
  }

  /** The command context (never in a preview). */
  get ctx(): ApplyContext {
    if (!this.applyCtx) throw new Error('restore: no command context in a preview');
    return this.applyCtx;
  }

  get tx(): Tx {
    if (this.dry) throw new Error('restore: no writes in a preview');
    return this.db as Tx;
  }

  tally(category: BackupCategoryId): CategoryTally {
    let t = this.tallies.get(category);
    if (!t) {
      t = emptyTally();
      this.tallies.set(category, t);
    }
    return t;
  }

  /** Keeps a record's outcome under its key, when outcomes are kept. */
  keepOutcome(key: string | null, outcome: RecordOutcome): void {
    if (key && this.outcomes) this.outcomes.push([key, outcome]);
  }

  /** Counts a record's outcome as much as the category counts it (`backupRecordCount`: a hub as its servers). */
  count(
    category: BackupCategoryId,
    record: { type: string; servers?: readonly unknown[] },
    outcome: RecordOutcome,
  ): void {
    const n = outcome === 'detail' ? 0 : backupRecordCount(category, record);
    if (n === 0 || outcome === 'detail') return;
    const t = this.tally(category);
    if (outcome === 'updated' || outcome === 'kept') t.different += n;
    t[outcome] += n;
  }

  note(code: BackupNoteCode, category: BackupCategoryId | null, n = 1): void {
    if (n <= 0) return;
    const key = `${code}:${category ?? ''}`;
    const have = this.notes.get(key);
    if (have) have.count += n;
    else this.notes.set(key, { code, category, count: n });
  }

  /**
   * For a thing that is here and differs: `kept` (the default), or `updated` after `write` ran (`replace`). A preview
   * only says it differs.
   */
  async different(write: () => Promise<void>): Promise<RecordOutcome> {
    if (this.dry) return 'kept';
    if (this.onDifferent !== 'replace') return 'kept';
    await write();
    return 'updated';
  }

  /** A target id for a thing a preview would make (so later records see it as new, not missing). */
  standIn(sourceId: string): string {
    return `new:${sourceId}`;
  }

  isStandIn(id: string | null | undefined): boolean {
    return !!id && id.startsWith('new:');
  }

  /** Remembers source → target (written to the restore map with the batch). */
  remember(sourceId: string, targetId: string, category: string): void {
    this.journal.push([sourceId, this.found.get(sourceId)]);
    this.found.set(sourceId, targetId);
    if (!this.dry && !this.isStandIn(targetId)) this.pending.push({ sourceId, targetId, category });
  }

  /** Where this run is, so a record whose savepoint rolled back leaves nothing behind in it either. */
  mark(): RunMark {
    return {
      journal: this.journal.length,
      pending: this.pending.length,
      checks: this.followUps.checkConnections.length,
      networks: this.followUps.homeNetworks.length,
      automationsOff: this.followUps.automationsOff,
      schedulesPaused: this.followUps.schedulesPaused,
    };
  }

  rollback(m: RunMark): void {
    while (this.journal.length > m.journal) {
      const [id, before] = this.journal.pop() as [string, string | null | undefined];
      if (before === undefined) this.found.delete(id);
      else this.found.set(id, before);
    }
    this.pending.length = m.pending;
    this.followUps.checkConnections.length = m.checks;
    this.followUps.homeNetworks.length = m.networks;
    this.followUps.automationsOff = m.automationsOff;
    this.followUps.schedulesPaused = m.schedulesPaused;
  }

  /** Writes what this batch found or made into the restore map. */
  async flushMap(): Promise<void> {
    if (this.dry || this.pending.length === 0) return;
    const now = this.services.clock();
    // One row per source id: the last pair found or made wins.
    const last = new Map(this.pending.splice(0).map((p) => [p.sourceId, p]));
    const rows = [...last.values()].map((p) => ({
      burrowId: this.burrow.id,
      sourceBurrowId: this.sourceBurrowId,
      sourceId: p.sourceId,
      category: p.category,
      targetId: p.targetId,
      createdAt: now,
    }));
    for (let i = 0; i < rows.length; i += 500)
      await this.tx
        .insert(backupRestoreMap)
        .values(rows.slice(i, i + 500))
        .onConflictDoUpdate({
          target: [backupRestoreMap.burrowId, backupRestoreMap.sourceBurrowId, backupRestoreMap.sourceId],
          set: { targetId: sql`excluded.target_id`, category: sql`excluded.category` },
        });
  }

  /** Loads the restore map's pairs for these source ids (one query per batch). */
  async preload(sourceIds: Iterable<string>): Promise<void> {
    const ids = [...new Set(sourceIds)].filter((id) => !this.found.has(id));
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await this.db
        .select({ sourceId: backupRestoreMap.sourceId, targetId: backupRestoreMap.targetId })
        .from(backupRestoreMap)
        .where(
          and(
            eq(backupRestoreMap.burrowId, this.burrow.id),
            eq(backupRestoreMap.sourceBurrowId, this.sourceBurrowId),
            inArray(backupRestoreMap.sourceId, ids.slice(i, i + 1000)),
          ),
        );
      for (const r of rows) this.found.set(r.sourceId, r.targetId);
    }
  }

  /** The restore map's target for a source id, when a restore remembered one (no key lookup). */
  mapped(sourceId: string): string | null {
    return this.found.get(sourceId) ?? null;
  }

  /**
   * This burrow's id for a source id: the restore map, else its directory key here. Null: neither here nor made by
   * this restore (yet).
   */
  async resolve(sourceId: string | null | undefined): Promise<string | null> {
    if (!sourceId) return null;
    if (this.found.has(sourceId)) return this.found.get(sourceId) ?? null;
    const entry = this.directory.get(sourceId);
    const target = entry ? await this.byKey(entry) : null;
    // A key lookup that found nothing isn't remembered as missing: a later record of this batch may make it.
    if (target) this.remember(sourceId, target, entry?.type ?? 'directory');
    return target;
  }

  /** Every id in `ids` resolved, dropping those that aren't here (`missing` counts them). */
  async resolveAll(ids: readonly string[]): Promise<{ ids: string[]; missing: number }> {
    const out: string[] = [];
    let missing = 0;
    for (const id of ids) {
      const t = await this.resolve(id);
      if (t) out.push(t);
      else missing++;
    }
    return { ids: out, missing };
  }

  /** The ids of principals here that may still act and belong (no one who left, no retired agent, no stand-in). */
  async activeOnly(ids: readonly string[]): Promise<string[]> {
    const real = [...new Set(ids.filter((id) => !this.isStandIn(id)))];
    if (real.length === 0) return [];
    const rows = await this.db
      .select({ id: principals.id })
      .from(principals)
      .where(and(eq(principals.burrowId, this.burrow.id), inArray(principals.id, real)));
    const ok = new Set(rows.map((r) => r.id));
    return real.filter((id) => ok.has(id));
  }

  /** Rewrites raw JSON (an automation's definition, a card) with resolved ids; unresolved ones are listed. */
  async remapJson<T extends JsonValue>(value: T): Promise<{ value: T; missing: string[] }> {
    const ids = new Set<string>();
    const walk = (v: JsonValue) => {
      if (typeof v === 'string') ids.add(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(value);
    const lookup = new Map<string, string>();
    for (const id of ids) {
      if (!/^[a-z]{2,4}_[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
      const t = await this.resolve(id);
      if (t) lookup.set(id, t);
    }
    return remapBackupIds(value, lookup);
  }

  private async byKey(entry: BackupDirectoryEntry): Promise<string | null> {
    const db = this.db;
    const burrowId = this.burrow.id;
    switch (entry.type) {
      case 'burrow':
        return burrowId;
      case 'person':
        return this.personByEmail(entry.email);
      case 'agent': {
        // Any agent of the file is this Whombat's one agent (one-agent.md OA-01).
        const [row] = await db
          .select({ id: principals.id })
          .from(principals)
          .where(and(eq(principals.burrowId, burrowId), eq(principals.kind, 'agent')));
        return row?.id ?? null;
      }
      case 'system': {
        const [row] = await db
          .select({ id: principals.id })
          .from(principals)
          .where(and(eq(principals.burrowId, burrowId), eq(principals.system, entry.system)));
        return row?.id ?? null;
      }
      case 'automation': {
        const [row] = await db
          .select({ id: automations.id, principalId: automations.principalId })
          .from(automations)
          .where(
            and(
              eq(automations.burrowId, burrowId),
              eq(automations.name, entry.name),
              isNull(automations.deletedAt),
            ),
          );
        if (row && entry.principalId !== entry.id) this.found.set(entry.principalId, row.principalId);
        return row?.id ?? null;
      }
      case 'conversation':
        return this.conversationByKey(entry);
      case 'connection': {
        // A Google, Microsoft or mail account is the person's, whoever made the file (OP-S54).
        if (entry.source === 'connector') {
          const [row] = await db
            .select({ id: connections.id })
            .from(connections)
            .where(
              and(
                eq(connections.accountId, this.restorer.accountId ?? ''),
                eq(connections.provider, entry.service as never),
              ),
            );
          return row?.id ?? null;
        }
        const rows = await db
          .select({
            id: catalogConnections.id,
            baseUrl: catalogConnections.baseUrl,
            handle: catalogConnections.handle,
          })
          .from(catalogConnections)
          .where(
            and(eq(catalogConnections.burrowId, burrowId), eq(catalogConnections.catalogId, entry.service)),
          );
        const address = normalizeAddress(entry.address);
        const byAddress = rows.find((r) => normalizeAddress(r.baseUrl) === address);
        if (byAddress) return byAddress.id;
        return rows.find((r) => entry.handle && r.handle === entry.handle)?.id ?? null;
      }
      case 'repo': {
        const [row] = await db
          .select({ id: repos.id })
          .from(repos)
          .where(and(eq(repos.burrowId, burrowId), eq(repos.fullName, entry.fullName)));
        return row?.id ?? null;
      }
      case 'vault_entry': {
        const [row] = await db
          .select({ id: vaultEntries.id })
          .from(vaultEntries)
          .where(
            and(
              eq(vaultEntries.burrowId, burrowId),
              eq(vaultEntries.ownerId, this.restorer.id),
              eq(vaultEntries.kind, entry.kind),
              eq(vaultEntries.name, entry.name),
            ),
          );
        return row?.id ?? null;
      }
      case 'vault_ssh_server': {
        const owner = await this.resolve(entry.entry);
        if (!owner || this.isStandIn(owner)) return null;
        const [row] = await db
          .select({ id: vaultSshServers.id })
          .from(vaultSshServers)
          .where(
            and(
              eq(vaultSshServers.entryId, owner),
              sql`lower(${vaultSshServers.name}) = ${entry.name.toLowerCase()}`,
            ),
          );
        return row?.id ?? null;
      }
      case 'canvas': {
        const [row] = await db
          .select({ id: canvases.id })
          .from(canvases)
          .where(and(eq(canvases.burrowId, burrowId), eq(canvases.slug, entry.slug)));
        return row?.id ?? null;
      }
    }
  }

  /** A person here by email (one-person.md OP-S08: no one is marked as having left). */
  async personByEmail(email: string, _options: { active?: boolean } = {}): Promise<string | null> {
    const rows = await this.db
      .select({ id: principals.id })
      .from(principals)
      .where(
        and(
          eq(principals.burrowId, this.burrow.id),
          eq(principals.kind, 'person'),
          isNull(principals.system),
          sql`lower(${principals.email}) = ${email.toLowerCase()}`,
        ),
      );
    return rows[0]?.id ?? null;
  }

  private async conversationByKey(
    entry: Extract<BackupDirectoryEntry, { type: 'conversation' }>,
  ): Promise<string | null> {
    const db = this.db;
    const burrowId = this.burrow.id;
    if (entry.kind === 'dm') {
      if (!entry.dm) return null;
      const agent = (await loadAgentRow(db, burrowId))?.id ?? null;
      const person = await this.resolve(entry.dm.person);
      if (!agent || !person || this.isStandIn(person)) return null;
      // By its person and task key (BF-19, BF-S13): a task chat or the Feedback room is its own, the default DM (no
      // key) the person's Chat.
      const [row] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.kind, 'dm'),
            eq(conversations.dmAgentId, agent),
            eq(conversations.dmPersonId, person),
            entry.taskKey ? eq(conversations.taskKey, entry.taskKey) : isNull(conversations.taskKey),
          ),
        );
      return row?.id ?? null;
    }
    const [row] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.burrowId, burrowId),
          eq(conversations.kind, entry.kind),
          eq(conversations.slug, entry.slug),
        ),
      );
    return row?.id ?? null;
  }

  /** The note list in the contract's shape. */
  noteList(): { code: BackupNoteCode; category: BackupCategoryId | null; count: number }[] {
    return [...this.notes.values()];
  }
}

/** A base URL compared loosely: lower-case scheme and host, no trailing slash. */
export function normalizeAddress(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return url.trim().replace(/\/+$/, '').toLowerCase();
  }
}
