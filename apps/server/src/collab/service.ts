/**
 * The collaboration service: Hocuspocus (y-websocket compatible) serving one Yjs document per canvas over a session's
 * collab stream.
 *
 * - **Auth**: the first message carries a `canvases.collabToken` token (short-lived, HMAC-signed). The canvas and the
 *   principal must be in the token's burrow and, for an agent, its dispatch live. People may write; agents write only
 *   with a `can` "Write canvases" key, otherwise the connection is read-only. A periodic re-check closes an agent's
 *   connection once its dispatch is over (auth/credentials.ts); a session's streams close with the session.
 * - **Storage**: documents load from Postgres (snapshot + updates; canvases never opened are built from
 *   their Markdown). What each principal types is buffered and flushed in bursts (Hocuspocus's debounced
 *   store) through the commit pipeline as `record_canvas_edit` — the update row and a signed hidden event in
 *   one transaction. Server-side changes (agent edits, plan syncs, comment marks) are stored first and then
 *   applied to the live document. Compaction folds updates into the snapshot.
 * - **Awareness**: relayed by Hocuspocus; the server stamps each client's `user` from its connection and
 *   publishes agents' presence, caret and "is writing" itself.
 * - **Plan block**: Plan changes (`plan.updated` on the bus) are written into the document; plan-block
 *   edits become Plan changes (`record_canvas_edit` / `edit_canvas`).
 * - **Comments**: new anchored comments are marked in the text, resolved ones unmarked.
 * - **Search**: the canvas is re-indexed a moment after it changes.
 */
import { type Connection, type Document, Hocuspocus, type WebSocketLike } from '@hocuspocus/server';
import {
  type DocPlanStep,
  docFromUpdate,
  docToPlainText,
  markComment,
  planStepsFromDoc,
  readCanvas,
  syncPlanIntoDoc,
  unmarkComment,
  writeCanvas,
} from '@whombat/canvas-schema';
import {
  type CanvasComment,
  COLLAB_PATH,
  type CollabUser,
  collabDocumentName,
  decide,
  type Plan,
  parseCollabDocumentName,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { deadCredentials, isDead } from '../auth/credentials';
import { canvases, dispatches } from '../db/schema/index';
import { indexCanvas } from '../domain/search-index';
import { loadGrants, loadPrincipalRow, type PrincipalRow } from '../read/principals';
import { loadPlan } from '../read/work';
import type { Services } from '../services';
import { collabUser, presentPrincipalIds, ServerParticipant, stampState } from './awareness';
import { recordCanvasEdit } from './commands';
import { exportMarkdown, initialCanvasState, principalNames, scratchDoc } from './document';
import {
  COMPACT_AFTER_UPDATES,
  compactCanvas,
  countCanvasUpdates,
  insertCanvasUpdate,
  loadCanvasState,
  materializeCanvas,
} from './store';
import { type CollabTokenPayload, CollabTokens } from './token';

type CanvasRow = typeof canvases.$inferSelect;

/** Who a connection is, set by `onAuthenticate`. */
export interface CollabContext {
  principalId: string;
  burrowId: string;
  canvasId: string;
  dispatchId: string | null;
  user: CollabUser;
  readOnly: boolean;
}

export interface CollabTimings {
  /** Hocuspocus store debounce: a burst of typing is flushed this long after it stops … */
  storeDebounceMs: number;
  /** … and at least this often while it goes on. */
  storeMaxDebounceMs: number;
  /** An agent shows "is writing" this long after its last edit. */
  writingMs: number;
  /** An agent stays present on the canvas this long after its last edit. */
  presenceMs: number;
  /** Search re-index delay after a change. */
  indexMs: number;
  /** How often live connections' sessions, API tokens and dispatches are re-checked. */
  revalidateMs: number;
}

export const DEFAULT_COLLAB_TIMINGS: CollabTimings = {
  storeDebounceMs: 1000,
  storeMaxDebounceMs: 5000,
  writingMs: 4000,
  presenceMs: 60_000,
  indexMs: 2000,
  revalidateMs: 25_000,
};

/** Awareness entries are dropped by peers after 30 s without renewal (y-protocols `outdatedTimeout`). */
const RENEW_MS = 15_000;

/** Origin of server-side changes that are already stored (Hocuspocus skips its store hooks for them). */
const STORED = { source: 'local', skipStoreHooks: true, context: { stored: true } } as const;

interface Participant {
  canvasId: string;
  principalId: string;
  p: ServerParticipant;
  writingTimer?: NodeJS.Timeout;
  presenceTimer?: NodeJS.Timeout;
  renewTimer?: NodeJS.Timeout;
}

interface LiveConnection {
  connection: Connection<CollabContext>;
  context: CollabContext;
  documentName: string;
}

export class CollabRejected extends Error {
  readonly reason = 'permission-denied';
}

export class CollabService {
  readonly tokens: CollabTokens;
  readonly hocuspocus: Hocuspocus<CollabContext>;
  private readonly timings: CollabTimings;
  /** Buffered connection updates per canvas, per author (flushed by `onStoreDocument`). */
  private readonly pending = new Map<string, Map<string, Uint8Array[]>>();
  /** The plan block as it was at the last flush or sync, per canvas (what block edits are measured from). */
  private readonly planBaseline = new Map<string, DocPlanStep[] | null>();
  private readonly participants = new Map<string, Participant>();
  private readonly indexTimers = new Map<string, NodeJS.Timeout>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly live = new Set<LiveConnection>();
  private readonly unsubscribe: (() => void)[] = [];
  private readonly revalidateTimer: NodeJS.Timeout;
  private revalidating: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly services: Services,
    timings: Partial<CollabTimings> = {},
  ) {
    this.timings = { ...DEFAULT_COLLAB_TIMINGS, ...timings };
    this.tokens = new CollabTokens(services.config.WHOMBAT_MASTER_KEY);
    this.hocuspocus = new Hocuspocus<CollabContext>({
      name: 'whombat-collab',
      quiet: true,
      debounce: this.timings.storeDebounceMs,
      maxDebounce: this.timings.storeMaxDebounceMs,
      onAuthenticate: async ({ token, documentName, connectionConfig, context: given }) => {
        const context = await this.authenticate(token, documentName);
        // A managed session stream (handleStream): the token must be for this session's own account.
        const sessionAccountId = (given as { sessionAccountId?: string } | undefined)?.sessionAccountId;
        if (sessionAccountId !== undefined) {
          const principal = await loadPrincipalRow(this.services.db, context.principalId);
          if (principal?.accountId !== sessionAccountId)
            throw new CollabRejected('Not allowed on this canvas.');
        }
        if (context.readOnly) connectionConfig.readOnly = true;
        return context;
      },
      onLoadDocument: async ({ documentName }) => this.loadDocument(documentName),
      afterLoadDocument: async ({ documentName, document }) => {
        const canvasId = parseCollabDocumentName(documentName);
        if (canvasId) this.planBaseline.set(canvasId, await this.planStepsOf(canvasId, document));
      },
      connected: async ({ connection, context, documentName }) => {
        this.live.add({ connection, context, documentName });
      },
      onDisconnect: async ({ socketId, documentName }) => {
        for (const entry of this.live)
          if (entry.connection.socketId === socketId && entry.documentName === documentName)
            this.live.delete(entry);
      },
      onChange: async ({ documentName, update, transactionOrigin, context }) => {
        if (!isConnectionOrigin(transactionOrigin) || !context?.principalId) return;
        this.buffer(documentName, context.principalId, update);
      },
      onStoreDocument: async ({ documentName, document }) => {
        await this.serial(documentName, () => this.flush(documentName, document));
      },
      beforeHandleAwareness: async ({ context, states }) => {
        if (!context?.user) return;
        for (const state of states.values()) if (state) stampState(state, context.user);
      },
      afterUnloadDocument: async ({ documentName }) => {
        const canvasId = parseCollabDocumentName(documentName);
        if (!canvasId) return;
        this.planBaseline.delete(canvasId);
        for (const [key, part] of this.participants)
          if (part.canvasId === canvasId) this.dropParticipant(key);
        this.track(this.compact(canvasId));
      },
    });

    this.unsubscribe.push(
      services.bus.onFrame((frame) => {
        if (frame.event.type === 'plan.updated') this.track(this.syncPlan(frame.event.plan));
        if (frame.event.type === 'canvas.comment') this.track(this.syncCommentMark(frame.event.comment));
      }),
    );
    this.revalidateTimer = setInterval(() => {
      this.revalidate().catch((err) =>
        services.log.warn({ err: String(err) }, 'collab credential re-check failed'),
      );
    }, this.timings.revalidateMs);
    this.revalidateTimer.unref?.();
  }

  private disconnect(entry: LiveConnection): void {
    entry.connection.close({ code: 4403, reason: 'forbidden' });
    this.live.delete(entry);
  }

  /** Closes every connection whose dispatch is no longer live. */
  revalidate(): Promise<void> {
    if (!this.revalidating) {
      this.revalidating = this.recheck().finally(() => {
        this.revalidating = null;
      });
    }
    return this.revalidating;
  }

  private async recheck(): Promise<void> {
    const entries = [...this.live];
    if (entries.length === 0) return;
    const dead = await deadCredentials(
      this.services,
      entries.map((e) => e.context),
    );
    for (const entry of entries)
      if (this.live.has(entry) && isDead(entry.context, dead)) this.disconnect(entry);
  }

  /* Sockets and tokens ------------------------------------------------------------------------- */

  /**
   * Serves one session collaboration stream (managed/resources.ts `openCollab`): Hocuspocus, with the session's
   * account bound so a token of another account is refused.
   */
  handleStream(socket: WebSocketLike, sessionAccountId: string) {
    const request = new Request('http://appliance.session/collab');
    return this.hocuspocus.handleConnection(socket, request, {
      sessionAccountId,
    } as unknown as CollabContext);
  }

  /** `canvases.collabToken`: a token for a collab stream (the caller has already been checked for access). */
  issueToken(input: { canvasId: string; burrowId: string; principalId: string; dispatchId: string | null }) {
    const { token, expiresAt } = this.tokens.issue(
      { c: input.canvasId, b: input.burrowId, p: input.principalId, d: input.dispatchId },
      this.services.clock(),
    );
    return { token, documentName: collabDocumentName(input.canvasId), url: COLLAB_PATH, expiresAt };
  }

  private async authenticate(token: string, documentName: string): Promise<CollabContext> {
    const canvasId = parseCollabDocumentName(documentName);
    const payload = this.tokens.verify(token, this.services.clock());
    if (!canvasId || !payload || payload.c !== canvasId)
      throw new CollabRejected('Not allowed on this canvas.');
    return this.authorize(payload);
  }

  /** Re-checks everything the token stood for: burrow, dispatch, write key. */
  private async authorize(payload: CollabTokenPayload): Promise<CollabContext> {
    const db = this.services.db;
    const [canvas] = await db.select().from(canvases).where(eq(canvases.id, payload.c));
    const principal = await loadPrincipalRow(db, payload.p);
    if (!canvas || !principal || canvas.burrowId !== payload.b || principal.burrowId !== payload.b)
      throw new CollabRejected('Not allowed on this canvas.');
    if (payload.d) {
      const [dispatch] = await db
        .select({ state: dispatches.state })
        .from(dispatches)
        .where(eq(dispatches.id, payload.d));
      if (!dispatch || !['queued', 'claimed', 'running'].includes(dispatch.state))
        throw new CollabRejected('That dispatch is over.');
    }
    return {
      principalId: principal.id,
      burrowId: canvas.burrowId,
      canvasId: canvas.id,
      dispatchId: payload.d,
      user: collabUser(principal),
      readOnly: !(await this.mayWrite(principal)),
    };
  }

  /** People write canvases; agents need "Write canvases" at `can` (an `ask` key cannot type live). */
  private async mayWrite(principal: PrincipalRow): Promise<boolean> {
    if (principal.kind === 'person') return true;
    const grants = await loadGrants(this.services.db, principal.id);
    return decide({ id: principal.id, kind: 'agent' }, grants, 'canvas.write').outcome === 'allow';
  }

  /* Documents ---------------------------------------------------------------------------------- */

  /** The document's stored state; a canvas without one gets it built from its Markdown (and stored). */
  private async storedState(row: CanvasRow): Promise<Uint8Array> {
    const stored = await loadCanvasState(this.services.db, row.id);
    if (stored.state) return stored.state;
    const plan = row.planId ? ((await loadPlan(this.services.db, row.planId)) ?? null) : null;
    const built = initialCanvasState(row.markdown, { title: row.title, plan });
    return (await materializeCanvas(this.services.db, row.id, built, this.services.clock())) ?? built;
  }

  private async loadDocument(documentName: string): Promise<Uint8Array> {
    const canvasId = parseCollabDocumentName(documentName);
    const [row] = canvasId
      ? await this.services.db.select().from(canvases).where(eq(canvases.id, canvasId))
      : [];
    if (!row) throw new CollabRejected('No such canvas.');
    return this.storedState(row);
  }

  /** The live document of a canvas, if loaded (or loading). */
  private async liveDocument(canvasId: string): Promise<Document | null> {
    const name = collabDocumentName(canvasId);
    const loaded = this.hocuspocus.documents.get(name);
    if (loaded) return loaded;
    const loading = this.hocuspocus.loadingDocuments.get(name);
    if (!loading) return null;
    try {
      return await loading;
    } catch {
      return null;
    }
  }

  /** The canvas's current state: the live document when it is open, else what is stored. */
  async currentState(row: CanvasRow): Promise<Uint8Array> {
    const live = await this.liveDocument(row.id);
    return live ? Y.encodeStateAsUpdate(live) : this.storedState(row);
  }

  /** The current document of a canvas (read-only snapshot). */
  async currentDoc(row: CanvasRow) {
    const scratch = scratchDoc(await this.currentState(row));
    const { doc } = readCanvas(scratch);
    scratch.destroy();
    return doc;
  }

  /** `canvas_read`: the canvas as Markdown, from the live document. */
  async readMarkdown(row: CanvasRow): Promise<string> {
    return exportMarkdown(await this.currentDoc(row), await principalNames(this.services.db, row.burrowId));
  }

  /** Applies an update that is already stored to the live document (if open): peers get it at once. */
  async applyStored(canvasId: string, update: Uint8Array): Promise<void> {
    const doc = await this.liveDocument(canvasId);
    if (doc && !doc.isDestroyed) Y.applyUpdate(doc, update, STORED);
  }

  /** Principals on the canvas right now (awareness), for `CanvasDetail.presentIds`. */
  presentIds(canvasId: string): string[] {
    const name = collabDocumentName(canvasId);
    const doc = this.hocuspocus.documents.get(name);
    if (!doc) return [];
    // Everyone connected, in the order they came, plus agents the server shows (awareness).
    const ids: string[] = [];
    for (const entry of this.live)
      if (entry.documentName === name && !ids.includes(entry.context.principalId))
        ids.push(entry.context.principalId);
    for (const id of presentPrincipalIds(doc.awareness)) if (!ids.includes(id)) ids.push(id);
    return ids;
  }

  /* Flushing people's edits -------------------------------------------------------------------- */

  private buffer(documentName: string, principalId: string, update: Uint8Array) {
    let byAuthor = this.pending.get(documentName);
    if (!byAuthor) {
      byAuthor = new Map();
      this.pending.set(documentName, byAuthor);
    }
    const list = byAuthor.get(principalId) ?? [];
    list.push(update);
    byAuthor.set(principalId, list);
  }

  /** Runs `fn` after everything queued for the same document (flushes, syncs, marks never interleave). */
  private serial<T>(documentName: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(documentName) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.chains.set(documentName, settled);
    void settled.then(() => {
      if (this.chains.get(documentName) === settled) this.chains.delete(documentName);
    });
    return next;
  }

  /**
   * Commits the buffered edits of each author (`record_canvas_edit`, signed as them). Plan-block edits since
   * the last flush go with the last author's commit. A failure puts the updates back and rethrows, so
   * Hocuspocus keeps the document in memory and tries again.
   */
  private async flush(documentName: string, document: Document): Promise<void> {
    const canvasId = parseCollabDocumentName(documentName);
    const byAuthor = this.pending.get(documentName);
    if (!canvasId || !byAuthor || byAuthor.size === 0) return;
    this.pending.delete(documentName);
    const [row] = await this.services.db.select().from(canvases).where(eq(canvases.id, canvasId));
    if (!row) return;
    const doc = docFromUpdate(Y.encodeStateAsUpdate(document));
    const markdown = exportMarkdown(doc, await principalNames(this.services.db, row.burrowId));
    const planAfter = row.planId ? planStepsFromDoc(doc, row.planId) : null;
    const planBefore = this.planBaseline.get(canvasId) ?? null;
    const planEdit =
      row.planId && planBefore && planAfter && JSON.stringify(planBefore) !== JSON.stringify(planAfter)
        ? { planId: row.planId, before: planBefore, after: planAfter }
        : undefined;
    const authors = [...byAuthor.entries()];
    try {
      for (const [index, [principalId, updates]] of authors.entries()) {
        const merged = updates.length === 1 ? (updates[0] as Uint8Array) : Y.mergeUpdates(updates);
        const last = index === authors.length - 1;
        const res = await this.services.pipeline.commit(
          recordCanvasEdit,
          {
            canvasId,
            update: Buffer.from(merged).toString('base64'),
            markdown,
            ...(last && planEdit ? { plan: planEdit } : {}),
          },
          { burrowId: row.burrowId, actorId: principalId },
        );
        byAuthor.delete(principalId);
        if (res.status !== 'ok')
          this.services.log.warn({ canvasId, principalId }, 'canvas edit not recorded');
      }
      this.planBaseline.set(canvasId, planAfter);
    } catch (err) {
      // Put back what was not committed (in front of anything typed meanwhile).
      const again = this.pending.get(documentName) ?? new Map<string, Uint8Array[]>();
      for (const [principalId, updates] of byAuthor)
        again.set(principalId, [...updates, ...(again.get(principalId) ?? [])]);
      this.pending.set(documentName, again);
      this.services.log.error({ err: String(err), canvasId }, 'could not store canvas edits');
      throw err;
    }
    if ((await countCanvasUpdates(this.services.db, canvasId)) >= COMPACT_AFTER_UPDATES)
      await this.compact(canvasId);
  }

  /** Flushes a document's buffered edits now (before a server-side change reads the plan block). */
  private async flushNow(canvasId: string): Promise<void> {
    const name = collabDocumentName(canvasId);
    const doc = this.hocuspocus.documents.get(name);
    if (doc && this.pending.get(name)?.size) await this.flush(name, doc);
  }

  private async compact(canvasId: string): Promise<void> {
    try {
      await compactCanvas(this.services.db, canvasId, this.services.clock());
    } catch (err) {
      this.services.log.warn({ err: String(err), canvasId }, 'canvas compaction failed');
    }
  }

  /* Server-side changes ------------------------------------------------------------------------ */

  /**
   * Stores a server-derived change (plan sync, comment mark) as an unsigned update — the signed event is
   * the change it mirrors — and applies it to the live document.
   */
  private async storeDerived(row: CanvasRow, update: Uint8Array, markdown: string): Promise<void> {
    await this.services.db.transaction(async (tx) => {
      await insertCanvasUpdate(tx, {
        canvasId: row.id,
        update,
        authorId: null,
        createdAt: this.services.clock(),
      });
      await tx.update(canvases).set({ markdown }).where(eq(canvases.id, row.id));
    });
    await this.applyStored(row.id, update);
  }

  /** Rewrites a canvas document through `change` (null: nothing to do), serialized with its flushes. */
  private async derive(
    canvasId: string,
    change: (
      doc: ReturnType<typeof readCanvas>['doc'],
      ydoc: Y.Doc,
      meta: ReturnType<typeof readCanvas>['meta'],
    ) => ReturnType<typeof readCanvas>['doc'] | null,
  ) {
    return this.serial(collabDocumentName(canvasId), async () => {
      const [row] = await this.services.db.select().from(canvases).where(eq(canvases.id, canvasId));
      if (!row) return false;
      await this.flushNow(canvasId);
      const scratch = scratchDoc(await this.currentState(row));
      const { doc, meta } = readCanvas(scratch);
      const next = change(doc, scratch, meta);
      if (!next) {
        scratch.destroy();
        return false;
      }
      const before = Y.encodeStateVector(scratch);
      writeCanvas(scratch, next, meta);
      const update = Y.encodeStateAsUpdate(scratch, before);
      scratch.destroy();
      const markdown = exportMarkdown(next, await principalNames(this.services.db, row.burrowId));
      await this.storeDerived(row, update, markdown);
      const live = this.hocuspocus.documents.get(collabDocumentName(canvasId));
      if (row.planId) this.planBaseline.set(canvasId, live ? await this.planStepsOf(canvasId, live) : null);
      this.scheduleIndex(canvasId);
      return true;
    });
  }

  /** 11.2: the Plan changed (a run finished, an approval moved, someone edited the block) → the block. */
  async syncPlan(plan: Plan): Promise<boolean> {
    if (!plan.canvasId) return false;
    return this.derive(plan.canvasId, (doc) => syncPlanIntoDoc(doc, plan));
  }

  /** 11.3: an anchored comment is marked in the text while open, unmarked once resolved. */
  async syncCommentMark(comment: CanvasComment): Promise<boolean> {
    if (comment.parentId || !comment.anchor) return false;
    const anchor = comment.anchor;
    return this.derive(comment.canvasId, (doc, ydoc, meta) =>
      comment.resolved ? unmarkComment(doc, comment.id) : markComment(ydoc, meta, doc, comment.id, anchor),
    );
  }

  private async planStepsOf(canvasId: string, document: Y.Doc): Promise<DocPlanStep[] | null> {
    const [row] = await this.services.db
      .select({ planId: canvases.planId })
      .from(canvases)
      .where(eq(canvases.id, canvasId));
    if (!row?.planId) return null;
    const doc = docFromUpdate(Y.encodeStateAsUpdate(document));
    return planStepsFromDoc(doc, row.planId);
  }

  /* Agents' awareness ------------------------------------------------------------------------- */

  private participantKey(canvasId: string, principalId: string) {
    return `${canvasId}|${principalId}`;
  }

  private async participant(canvasId: string, principalId: string): Promise<Participant | null> {
    const key = this.participantKey(canvasId, principalId);
    const existing = this.participants.get(key);
    if (existing) return existing;
    const row = await loadPrincipalRow(this.services.db, principalId);
    if (!row) return null;
    const created: Participant = { canvasId, principalId, p: new ServerParticipant(collabUser(row)) };
    this.participants.set(key, created);
    return created;
  }

  private publish(part: Participant, patch: Parameters<ServerParticipant['publish']>[1]) {
    const doc = this.hocuspocus.documents.get(collabDocumentName(part.canvasId));
    if (!doc || doc.isDestroyed) return;
    part.p.publish(doc.awareness, patch, 'whombat-server');
    clearInterval(part.renewTimer);
    part.renewTimer = setInterval(() => {
      const live = this.hocuspocus.documents.get(collabDocumentName(part.canvasId));
      if (live && !live.isDestroyed) part.p.publish(live.awareness, {}, 'whombat-server');
    }, RENEW_MS);
    part.renewTimer.unref();
  }

  /** "Dusty is writing": shown while an agent's edit is on its way (auto-clears). */
  async participantWriting(canvasId: string, principalId: string, writing: boolean): Promise<void> {
    if (!this.hocuspocus.documents.has(collabDocumentName(canvasId))) return;
    const part = await this.participant(canvasId, principalId);
    if (!part) return;
    this.publish(part, { writing });
    this.armTimers(part, writing);
  }

  /** The agent's edit landed: its caret rests after what it wrote; "writing" lingers a moment. */
  participantWrote(canvasId: string, principalId: string, caret: unknown): void {
    const part = this.participants.get(this.participantKey(canvasId, principalId));
    if (!part) return;
    this.publish(part, { writing: true, cursor: caret === null ? null : { anchor: caret, head: caret } });
    this.armTimers(part, true);
  }

  private armTimers(part: Participant, writing: boolean) {
    clearTimeout(part.writingTimer);
    clearTimeout(part.presenceTimer);
    if (writing) {
      part.writingTimer = setTimeout(() => this.publish(part, { writing: false }), this.timings.writingMs);
      part.writingTimer.unref();
    }
    part.presenceTimer = setTimeout(
      () => this.dropParticipant(this.participantKey(part.canvasId, part.principalId)),
      this.timings.presenceMs,
    );
    part.presenceTimer.unref();
  }

  private dropParticipant(key: string) {
    const part = this.participants.get(key);
    if (!part) return;
    clearTimeout(part.writingTimer);
    clearTimeout(part.presenceTimer);
    clearInterval(part.renewTimer);
    this.participants.delete(key);
    const doc = this.hocuspocus.documents.get(collabDocumentName(part.canvasId));
    if (doc && !doc.isDestroyed) part.p.remove(doc.awareness, 'whombat-server');
  }

  /* Search ------------------------------------------------------------------------------------- */

  /** Re-indexes the canvas a moment after it changed (bursts of edits index once). */
  scheduleIndex(canvasId: string): void {
    if (this.closed) return;
    clearTimeout(this.indexTimers.get(canvasId));
    const timer = setTimeout(() => {
      this.indexTimers.delete(canvasId);
      this.track(this.index(canvasId));
    }, this.timings.indexMs);
    timer.unref();
    this.indexTimers.set(canvasId, timer);
  }

  private async index(canvasId: string): Promise<void> {
    const [row] = await this.services.db.select().from(canvases).where(eq(canvases.id, canvasId));
    if (!row) return;
    const text = docToPlainText(await this.currentDoc(row));
    await indexCanvas(this.services.db, canvasId, text);
  }

  /* Lifecycle ---------------------------------------------------------------------------------- */

  private track<T>(work: Promise<T>): void {
    const p = work.catch((err) =>
      this.services.log.warn({ err: String(err) }, 'collab background work failed'),
    );
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  /** Waits until background work (plan syncs, marks, pending index runs, flushes) is done. For tests. */
  async settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      for (const [canvasId, timer] of this.indexTimers) {
        clearTimeout(timer);
        this.indexTimers.delete(canvasId);
        this.track(this.index(canvasId));
      }
      if (this.inflight.size === 0 && this.chains.size === 0) return;
      await Promise.all([...this.inflight, ...this.chains.values()]);
    }
  }

  /** Stores every open document and closes its connections (server shutdown). */
  async close(): Promise<void> {
    if (this.closed) return;
    clearInterval(this.revalidateTimer);
    for (const off of this.unsubscribe) off();
    for (const key of [...this.participants.keys()]) this.dropParticipant(key);
    for (const [name, doc] of this.hocuspocus.documents) {
      try {
        await this.serial(name, () => this.flush(name, doc));
      } catch {
        // logged by flush
      }
    }
    this.hocuspocus.closeConnections();
    await this.settle();
    this.closed = true;
    for (const timer of this.indexTimers.values()) clearTimeout(timer);
    this.indexTimers.clear();
  }
}

function isConnectionOrigin(origin: unknown): boolean {
  return (
    typeof origin === 'object' && origin !== null && (origin as { source?: unknown }).source === 'connection'
  );
}
