/**
 * The Home registry (docs/decisions/one-whombat.md ONE-05, ONE-07, ONE-08; one-whombat-assistant.md ONE-DW…): the parts
 * of Whombat that know about servers, devices and connections register what they have for a person's Home, and the
 * changes Whombat makes are recorded here with the recipe that undoes them.
 *
 * - **Sources** (`registerNeedsYouSource`, `registerThingsSource`, `registerWatchSource`): a named function that reads
 *   one person's items. Home and Watch call every source at once; a source that throws or takes longer than
 *   `SOURCE_TIMEOUT_MS` is left out of that read (logged), so one broken part never empties Home. A source sees only
 *   what the person may see: it gets the person's id and filters itself.
 * - **Changes** (`recordChange`): one row per change made through a tool, inside the caller's commit (`ctx` is the
 *   command's `ApplyContext` or any `TxSession`). An undo recipe's payload is sealed with key custody (AAD
 *   `change:<id>:undo`) because it can hold old values read from a connected service; it is opened only to undo.
 *   Settings saved in a row (`recordOrMergeChange`, docs/decisions/home-redesign.md HR-06): a save by the same actor of
 *   the same thing within `CHANGE_MERGE_WINDOW_MS` of the last one, not undone, updates that change instead.
 * - **Undoers** (`registerUndoer`): the inverse for one recipe kind. `changes.undo` runs it inside its own commit (the
 *   `undo_change` command) with the person who pressed Undo as `actor`. An undoer that needs a tool call does not make
 *   it in that transaction: it schedules the inverse as a new call through the pipeline (`ctx.after`), so keys, tiers
 *   and approvals apply again (ONE-08), and records that call's change as usual. It returns `{ ok: false, reason }` in
 *   plain words (“The light was changed again since; Whombat won’t undo it.”) when it can't.
 *
 * Pure registration and small reads; no route, no realtime of its own.
 */
import { newId } from '@whombat/core';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import type { ApplyContext } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { changes } from '../db/schema/index';
import type { KeyCustody } from '../keys/custody';
import type { ActorInfo, PrincipalRow } from '../read/principals';
import { turnThread } from '../runtime/dispatch-scope';
import type { Services } from '../services';
import type { QuietBook } from '../things/quiet/store';
import type { ChangeLink, ChangeSubject, NeedsYouItem, ThingSummary, WatchItem } from './types';

/** What a source reads with: one person in one burrow, at one moment. */
export interface SourceCtx {
  db: Db;
  burrowId: string;
  /** The person whose Home or Watch this is. */
  personId: string;
  now: Date;
  /** The server's services (the hosts client, the connection pool …); optional so pure tests can leave it out. */
  services?: Services;
  /** What this read shares with Home's other parts and sources; absent, a source reads everything itself. */
  reads?: SourceReads;
}

/**
 * The reads one Home read shares among its parts and sources (an overview, a desk glance): each made at most once and
 * dropped with the read, so the next read never sees an old answer and nothing needs forgetting.
 */
export interface SourceReads {
  /** The person whose Home it is (`SourceCtx.personId`), as the read began. */
  readonly person: PrincipalRow;
  /** What is quiet for the burrow's things. */
  quiet(): Promise<QuietBook>;
  /** A part's own read (the servers' fleet, the device skills), made once per key in this read. */
  once<T>(key: string, load: () => Promise<T>): Promise<T>;
}

/** `load` once per Home read when the read shares its reads, else now. */
export function readOnce<T>(ctx: Pick<SourceCtx, 'reads'>, key: string, load: () => Promise<T>): Promise<T> {
  return ctx.reads ? ctx.reads.once(key, load) : load();
}

/** A fresh set of shared reads for one Home read of `person` (`quiet` the caller's, so Home's own sections share it). */
export function sourceReads(person: PrincipalRow, quiet: () => Promise<QuietBook>): SourceReads {
  const made = new Map<string, Promise<unknown>>();
  return {
    person,
    quiet,
    once<T>(key: string, load: () => Promise<T>): Promise<T> {
      let read = made.get(key) as Promise<T> | undefined;
      if (!read) {
        // A query builder runs again on every await: kept as the one promise of its answer.
        read = Promise.resolve(load());
        made.set(key, read);
      }
      return read;
    },
  };
}

export type NeedsYouSource = (ctx: SourceCtx) => Promise<NeedsYouItem[]>;
export type ThingsSource = (ctx: SourceCtx) => Promise<ThingSummary[]>;
export type WatchSource = (ctx: SourceCtx) => Promise<WatchItem[]>;

/**
 * An in-commit undoer's outcome: `ok` (the change is marked undone in the same commit), `ok` with `state: 'asked'` (the
 * inverse waits for a person's yes: the change keeps its Undo until the inverse runs and marks it), or a plain refusal.
 */
export type UndoResult =
  | { ok: true; state?: 'undone' | 'asked'; approvalNumber?: number }
  | { ok: false; reason: string };

/** A recorded change as an undoer gets it: the row, with its undo recipe opened. */
export interface RecordedChange {
  id: string;
  burrowId: string;
  actorId: string;
  agentId: string | null;
  personId: string | null;
  kind: string;
  title: string;
  detail: string | null;
  subject: ChangeSubject | null;
  conversationId: string | null;
  /** The thread of that chat it was made in (CHT-08); absent or null: the top level. */
  threadRootId?: string | null;
  createdAt: Date;
  undo: { kind: string; payload: unknown };
}

export type Undoer = (ctx: ApplyContext, change: RecordedChange, actor: ActorInfo) => Promise<UndoResult>;

/** What a direct undoer works with: no transaction; it commits through the pipeline itself. */
export interface DirectUndoCtx {
  services: Services;
  burrowId: string;
  /** The person who pressed Undo. */
  person: ActorInfo;
  now: Date;
}

/**
 * A direct undoer's outcome: the inverse ran (`undone`), waits for a person's yes (`asked`), or the agent that made it
 * was asked to put it back in that chat (`requested`, home-redesign.md HR-03).
 */
export type DirectUndoResult =
  | { ok: true; state: 'undone' | 'asked'; approvalNumber?: number }
  | { ok: true; state: 'requested'; conversationId: string }
  | { ok: false; reason: string };

/**
 * An undoer that makes its inverse as new pipeline calls outside any transaction (a connection tool call: keys, tiers
 * and approvals decide it again). The change is marked undone by the inverse's own recorded change (`undoes`), or by
 * the caller when the undoer says `undone` and recorded nothing.
 */
export type DirectUndoer = (ctx: DirectUndoCtx, change: RecordedChange) => Promise<DirectUndoResult>;

/** Longest a source may take before Home is shown without it. */
export const SOURCE_TIMEOUT_MS = 4000;

const needsYouSources = new Map<string, NeedsYouSource>();
const thingsSources = new Map<string, ThingsSource>();
const watchSources = new Map<string, WatchSource>();
const undoers = new Map<string, Undoer>();
const directUndoers = new Map<string, DirectUndoer>();

/** Registers (or replaces) a Needs you source by name. */
export function registerNeedsYouSource(name: string, source: NeedsYouSource): void {
  needsYouSources.set(name, source);
}

/** Registers (or replaces) a Your things source by name. */
export function registerThingsSource(name: string, source: ThingsSource): void {
  thingsSources.set(name, source);
}

/** Registers (or replaces) a Watch source by name. */
export function registerWatchSource(name: string, source: WatchSource): void {
  watchSources.set(name, source);
}

/** Registers (or replaces) the undoer of one recipe kind (`recordChange`'s `undo.kind`). */
export function registerUndoer(kind: string, undoer: Undoer): void {
  undoers.set(kind, undoer);
}

export function undoerFor(kind: string): Undoer | null {
  return undoers.get(kind) ?? null;
}

/** Registers (or replaces) a direct undoer of one recipe kind (it wins over an in-commit one of the same kind). */
export function registerDirectUndoer(kind: string, undoer: DirectUndoer): void {
  directUndoers.set(kind, undoer);
}

export function directUndoerFor(kind: string): DirectUndoer | null {
  return directUndoers.get(kind) ?? null;
}

/** Whether a recipe kind can be undone on this server (a change whose undoer is gone shows no Undo). */
export function hasUndoer(kind: string): boolean {
  return undoers.has(kind) || directUndoers.has(kind);
}

/** Tests: forget a registration. */
export function unregister(
  what: 'needsYou' | 'things' | 'watch' | 'undoer' | 'directUndoer' | 'subject',
  name: string,
): void {
  const maps: Record<typeof what, Map<string, unknown>> = {
    needsYou: needsYouSources,
    things: thingsSources,
    watch: watchSources,
    undoer: undoers,
    directUndoer: directUndoers,
    subject: subjectResolvers,
  };
  maps[what].delete(name);
}

export function registeredSources(): {
  needsYou: string[];
  things: string[];
  watch: string[];
  undoers: string[];
} {
  return {
    needsYou: [...needsYouSources.keys()],
    things: [...thingsSources.keys()],
    watch: [...watchSources.keys()],
    undoers: [...undoers.keys(), ...directUndoers.keys()],
  };
}

/**
 * What a chat subject is called, for one person (a server's name from the hosts service, a device's): null when the
 * person can't see it. A kind without a resolver takes the name the client sent. SH registers `server`, SD `device`;
 * `connection` is resolved here (task chats).
 */
export type SubjectResolver = (ctx: SourceCtx, id: string) => Promise<{ name: string } | null>;

const subjectResolvers = new Map<string, SubjectResolver>();

export function registerSubjectResolver(kind: string, resolver: SubjectResolver): void {
  subjectResolvers.set(kind, resolver);
}

export function subjectResolverFor(kind: string): SubjectResolver | null {
  return subjectResolvers.get(kind) ?? null;
}

/** A failed or slow source, for the caller's log (never shown to people). */
export interface SourceFailure {
  source: string;
  reason: 'error' | 'timeout';
  error?: string;
}

async function collect<T>(
  sources: Map<string, (ctx: SourceCtx) => Promise<T[]>>,
  ctx: SourceCtx,
  timeoutMs: number,
): Promise<{ items: T[]; failures: SourceFailure[] }> {
  const entries = [...sources.entries()];
  const failures: SourceFailure[] = [];
  const results = await Promise.all(
    entries.map(async ([name, source]) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      try {
        const out = await Promise.race([source(ctx), timeout]);
        if (out === 'timeout') {
          failures.push({ source: name, reason: 'timeout' });
          return [];
        }
        return out;
      } catch (err) {
        failures.push({ source: name, reason: 'error', error: err instanceof Error ? err.name : 'error' });
        return [];
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  if (failures.length && ctx.services)
    ctx.services.log.warn({ failures }, 'a Home source failed; shown without it');
  return { items: results.flat(), failures };
}

/** Every Needs you source's items for one person (unordered; the read model sorts and filters snoozes). */
export function collectNeedsYou(ctx: SourceCtx, timeoutMs = SOURCE_TIMEOUT_MS) {
  return collect(needsYouSources, ctx, timeoutMs);
}

/** Every Your things source's items for one person. */
export function collectThings(ctx: SourceCtx, timeoutMs = SOURCE_TIMEOUT_MS) {
  return collect(thingsSources, ctx, timeoutMs);
}

/** Every Watch source's items for one person. */
export function collectWatch(ctx: SourceCtx, timeoutMs = SOURCE_TIMEOUT_MS) {
  return collect(watchSources, ctx, timeoutMs);
}

/** AAD of a change's sealed undo recipe. */
export function changeUndoAad(changeId: string): string {
  return `change:${changeId}:undo`;
}

/** A new change id (`chg_…`, contracts 0.80.0). */
export function newChangeId(): string {
  return newId('change');
}

/** What a caller records (ONE-08). */
export interface ChangeInput {
  burrowId: string;
  /** Who made the change: the Whombat (agent) or a person. */
  actorId: string;
  /** The Whombat that made it, if an agent did. */
  agentId?: string | null;
  /** The person it was made for. */
  personId?: string | null;
  /** What changed: `connection.call`, `hosts.guest_power`, `hosts.guest_config`, `device.action` … */
  kind: string;
  /** Plain words: “Turned off the hallway light”. At most 200 characters. */
  title: string;
  detail?: string | null;
  subject?: ChangeSubject | null;
  /** The inverse: a registered undoer's kind and what it needs (sealed). `until`: Undo offered until then. */
  undo?: { kind: string; payload: unknown; until?: Date | null } | null;
  link?: ChangeLink | null;
  /** The chat it was made in. */
  conversationId?: string | null;
  /**
   * The thread of that chat it was made in (chat-channel.md CHT-08): absent, the thread of the turn the agent is in
   * there (`turnThread`), else none.
   */
  threadRootId?: string | null;
  /** Default: now. */
  at?: Date;
  /** Set when this change undoes another: that change is marked undone by this one. */
  undoes?: { changeId: string; byId: string } | null;
  /** What a later save merges on and the fields this one changed (`recordOrMergeChange`, HR-06). */
  merge?: { key: string; fields: string[] } | null;
}

/** Whoever writes a change: a command's `ApplyContext`, any `TxSession`, or a transaction with the key custody. */
export interface ChangeWriter {
  tx: Tx | Db;
  services: { custody: KeyCustody };
}

/** The thread a change was made in: the one given, else the agent's turn's thread in that chat (RC-14), else none. */
async function changeThread(writer: ChangeWriter, input: ChangeInput): Promise<string | null> {
  if (input.threadRootId !== undefined) return input.threadRootId;
  if (!input.conversationId || !input.agentId) return null;
  return turnThread(writer.tx, { agentId: input.agentId, conversationId: input.conversationId });
}

/** Records a change inside the caller's commit and returns its id; the undo payload is sealed. */
export async function recordChange(writer: ChangeWriter, input: ChangeInput): Promise<string> {
  const id = newChangeId();
  const at = input.at ?? new Date();
  const undoEnc = input.undo
    ? writer.services.custody.seal(changeUndoAad(id), JSON.stringify(input.undo.payload ?? null))
    : null;
  await writer.tx.insert(changes).values({
    id,
    burrowId: input.burrowId,
    actorId: input.actorId,
    agentId: input.agentId ?? null,
    personId: input.personId ?? null,
    kind: input.kind.slice(0, 80),
    title: input.title.slice(0, 200),
    detail: input.detail ? input.detail.slice(0, 1000) : null,
    subjectKind: input.subject?.kind ?? null,
    subjectId: input.subject?.id ?? null,
    subjectName: input.subject?.name ?? null,
    undoKind: input.undo?.kind ?? null,
    undoEnc,
    undoUntil: input.undo?.until ?? null,
    link: input.link ?? null,
    conversationId: input.conversationId ?? null,
    threadRootId: await changeThread(writer, input),
    mergeKey: input.merge?.key.slice(0, 300) ?? null,
    mergeFields: input.merge ? input.merge.fields.slice(0, 50) : null,
    createdAt: at,
  });
  if (input.undoes)
    await writer.tx
      .update(changes)
      .set({ undoneAt: at, undoneById: input.undoes.byId, undoChangeId: id })
      .where(and(eq(changes.id, input.undoes.changeId), isNull(changes.undoneAt)));
  return id;
}

export type ChangeRow = typeof changes.$inferSelect;

/** How long after a settings change a save of the same thing by the same actor merges into it (HR-06). */
export const CHANGE_MERGE_WINDOW_MS = 2 * 60_000;

/** How a save merges into the change before it (HR-06). */
export interface ChangeMerge {
  /** The thing and kind it merges on (`hosts.server_settings:pve-01:`). */
  key: string;
  /** The fields this save changed (as the title's words take them). */
  fields: string[];
  /** The title naming every field changed so far. */
  title: (fields: string[]) => string;
  /** The merged change's Undo: from the earlier recipe and this save's (both of the change's kind), null for none. */
  undo: (earlier: unknown, later: unknown) => unknown;
  /** The merged detail, from the earlier one and this save's. */
  detail?: (earlier: string | null, later: string | null) => string | null;
}

/** Fields in the order they were first changed, each once. */
export function mergedFields(earlier: readonly string[], later: readonly string[]): string[] {
  return [...new Set([...earlier, ...later])];
}

/**
 * Records a settings change, or merges it into the actor's last change of the same thing (HR-06): same actor, kind and
 * `merge.key`, made within `CHANGE_MERGE_WINDOW_MS` before this one, not undone and not asked to be undone, and both with
 * an Undo or both without. The merged change names every field so far, its Undo goes back to how it was before the
 * first (`merge.undo`), and its time becomes this save's. An undo's own change never merges.
 */
export async function recordOrMergeChange(
  writer: ChangeWriter,
  input: ChangeInput,
  merge: ChangeMerge,
): Promise<{ changeId: string; merged: boolean }> {
  const at = input.at ?? new Date();
  if (!input.undoes) {
    const [earlier] = await writer.tx
      .select()
      .from(changes)
      .where(
        and(
          eq(changes.burrowId, input.burrowId),
          eq(changes.actorId, input.actorId),
          eq(changes.kind, input.kind.slice(0, 80)),
          eq(changes.mergeKey, merge.key.slice(0, 300)),
          isNull(changes.undoneAt),
          isNull(changes.undoAskedAt),
          gte(changes.createdAt, new Date(at.getTime() - CHANGE_MERGE_WINDOW_MS)),
        ),
      )
      .orderBy(desc(changes.createdAt))
      .limit(1)
      .for('update');
    const opened = earlier?.undoEnc ? openChange(writer.services.custody, earlier) : null;
    // Both with an Undo (that still opens) or both without one: else each keeps its own.
    const fits = earlier && (input.undo ? opened !== null : earlier.undoEnc === null);
    if (earlier && fits) {
      const fields = mergedFields(earlier.mergeFields ?? [], merge.fields).slice(0, 50);
      const payload = input.undo && opened ? merge.undo(opened.undo.payload, input.undo.payload) : null;
      const detail = merge.detail
        ? merge.detail(earlier.detail, input.detail ?? null)
        : (input.detail ?? earlier.detail);
      await writer.tx
        .update(changes)
        .set({
          title: merge.title(fields).slice(0, 200),
          detail: detail ? detail.slice(0, 1000) : null,
          mergeFields: fields,
          undoEnc:
            payload === null || payload === undefined
              ? null
              : writer.services.custody.seal(changeUndoAad(earlier.id), JSON.stringify(payload)),
          undoKind: payload === null || payload === undefined ? null : earlier.undoKind,
          ...(input.undo?.until ? { undoUntil: input.undo.until } : {}),
          createdAt: at,
        })
        .where(eq(changes.id, earlier.id));
      return { changeId: earlier.id, merged: true };
    }
  }
  const changeId = await recordChange(writer, {
    ...input,
    at,
    title: merge.title(merge.fields),
    merge: input.undoes ? null : { key: merge.key, fields: merge.fields },
  });
  return { changeId, merged: false };
}

/** A change row with its undo recipe opened; null when it has none or the recipe doesn't open. */
export function openChange(custody: KeyCustody, row: ChangeRow): RecordedChange | null {
  if (!row.undoKind || !row.undoEnc) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(custody.open(changeUndoAad(row.id), row.undoEnc));
  } catch {
    return null;
  }
  return {
    id: row.id,
    burrowId: row.burrowId,
    actorId: row.actorId,
    agentId: row.agentId,
    personId: row.personId,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    subject:
      row.subjectKind && row.subjectId
        ? { kind: row.subjectKind, id: row.subjectId, ...(row.subjectName ? { name: row.subjectName } : {}) }
        : null,
    conversationId: row.conversationId,
    threadRootId: row.threadRootId,
    createdAt: row.createdAt,
    undo: { kind: row.undoKind, payload },
  };
}

/** Undo state of a change for one reader (`ChangeEntry.undo`): available only while its undoer exists and in time. */
export function undoStateOf(
  row: Pick<ChangeRow, 'undoKind' | 'undoEnc' | 'undoUntil' | 'undoneAt'>,
  now: Date,
): { state: 'available' | 'undone' | 'none'; until?: string } {
  if (row.undoneAt) return { state: 'undone' };
  if (!row.undoKind || !row.undoEnc || !hasUndoer(row.undoKind)) return { state: 'none' };
  if (row.undoUntil && row.undoUntil.getTime() <= now.getTime()) return { state: 'none' };
  return row.undoUntil ? { state: 'available', until: row.undoUntil.toISOString() } : { state: 'available' };
}
