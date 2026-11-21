/**
 * Link previews (docs/decisions/essentials-conversations.md EC-17…EC-22): after a message is posted or edited, the
 * server reads the pages its links point to and puts a compact card under it (`Message.previews`, at most three, no
 * images), then tells its conversation (`message.updated`).
 *
 * - Off the request's path: `schedule` queues the message and returns; a small pool fetches (four pages at a time).
 * - Cached per burrow and URL (`link_previews`): a found preview or a page without one for 24 hours, a failure for an
 *   hour. The cache is per burrow so one burrow can't learn from timing what another posted.
 * - Every fetch goes through `fetchPreview` (the outbound helper: public addresses, standard ports, 5 s, 512 KB).
 *   A failure leaves no preview and is recorded in the cache row (`reason`) and the debug log, never shown: on a
 *   managed appliance whose egress is closed, previews quietly don't appear.
 * - Off per conversation (`Conversation.linkPreviews`, the person; EC-23), per burrow (`Burrow.linkPreviews`, the person)
 *   or for the whole server (`WHOMBAT_LINK_PREVIEWS=off`, the default in tests).
 * - Written like a search-index update (a derived projection, C-12): in the burrow's transaction with its outbox
 *   frame, no signed event. The previews kept are those of links still in the message's current text, merged with
 *   what it had, so an older fetch finishing after an edit never brings back a removed link.
 */
import { LINK_PREVIEWS_MAX, type LinkPreview, topics } from '@whombat/core';
import { and, eq, lt } from 'drizzle-orm';
import { burrows, conversations, linkPreviews, messages } from '../db/schema/index';
import { loadConversationRow } from '../read/conversations';
import { loadMessages } from '../read/messages';
import type { Services } from '../services';
import { ownOrigins, previewUrls } from './extract';
import { fetchPreview, type PreviewFetchOptions, type PreviewFetchResult } from './fetch';

export const PREVIEW_CACHE_MS = 24 * 3_600_000;
export const PREVIEW_FAILURE_CACHE_MS = 3_600_000;
const CONCURRENCY = 4;
/** Messages waiting at most; beyond this new ones are dropped (a burst of links must not grow memory). */
const QUEUE_MAX = 500;

export class LinkPreviewService {
  readonly #queue: string[] = [];
  readonly #queued = new Set<string>();
  #running = 0;
  #idle: (() => void)[] = [];
  /** Test seam: the fetch options (DNS) every fetch uses. */
  fetchOptions: PreviewFetchOptions = {};

  constructor(private readonly services: Services) {}

  get enabled(): boolean {
    return this.services.config.WHOMBAT_LINK_PREVIEWS === 'on' && this.services.schemaAccess === 'read-write';
  }

  /** Queues a message for previews (no-op when previews are off). */
  schedule(messageId: string): void {
    if (!this.enabled || this.#queued.has(messageId) || this.#queue.length >= QUEUE_MAX) return;
    this.#queued.add(messageId);
    this.#queue.push(messageId);
    this.#pump();
  }

  /** Resolves once nothing is queued or running (tests). */
  settled(): Promise<void> {
    if (this.#running === 0 && this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idle.push(resolve));
  }

  #pump(): void {
    while (this.#running < CONCURRENCY && this.#queue.length > 0) {
      const id = this.#queue.shift() as string;
      this.#queued.delete(id);
      this.#running += 1;
      void this.run(id)
        .catch((err) => this.services.log.warn({ err: String(err), messageId: id }, 'link previews failed'))
        .finally(() => {
          this.#running -= 1;
          this.#pump();
          if (this.#running === 0 && this.#queue.length === 0) {
            const waiting = this.#idle.splice(0);
            for (const resolve of waiting) resolve();
          }
        });
    }
  }

  /** The links of one message worth a preview, in order (none when its burrow or conversation has previews off). */
  async linksOf(messageId: string): Promise<{ burrowId: string; urls: string[] } | null> {
    const db = this.services.db;
    const [row] = await db
      .select({
        burrowId: messages.burrowId,
        text: messages.text,
        deletedAt: messages.deletedAt,
        conversationId: messages.conversationId,
        linkPreviews: burrows.linkPreviews,
        conversationPreviews: conversations.linkPreviews,
      })
      .from(messages)
      .innerJoin(burrows, eq(burrows.id, messages.burrowId))
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(messages.id, messageId));
    if (!row || row.deletedAt || row.linkPreviews === false || row.conversationPreviews === false)
      return null;
    const urls = previewUrls(row.text, { ownOrigins: this.ownOrigins() });
    return { burrowId: row.burrowId, urls };
  }

  ownOrigins(): string[] {
    const c = this.services.config;
    return ownOrigins([c.WHOMBAT_APP_URL, this.services.links.managedBase]);
  }

  /** Fetches (or reads from the cache) the previews of one message and stores them on it. */
  async run(messageId: string): Promise<void> {
    const links = await this.linksOf(messageId);
    if (!links) return;
    const found = new Map<string, LinkPreview>();
    for (const url of links.urls) {
      const preview = await this.previewFor(links.burrowId, url);
      if (preview) found.set(url, preview);
    }
    await this.apply(links.burrowId, messageId, found);
  }

  /** One URL's preview for a burrow: the cached answer while fresh, else a fetch (recorded either way). */
  async previewFor(burrowId: string, url: string): Promise<LinkPreview | null> {
    const db = this.services.db;
    const now = this.services.clock();
    const [cached] = await db
      .select()
      .from(linkPreviews)
      .where(and(eq(linkPreviews.burrowId, burrowId), eq(linkPreviews.url, url)));
    if (cached) {
      const ttl = cached.status === 'failed' ? PREVIEW_FAILURE_CACHE_MS : PREVIEW_CACHE_MS;
      if (now.getTime() - cached.fetchedAt.getTime() < ttl) return cached.preview ?? null;
    }
    const result: PreviewFetchResult = await fetchPreview(url, {
      allowPrivate: this.services.config.WHOMBAT_OUTBOUND_ALLOW_PRIVATE,
      ...this.fetchOptions,
    });
    if (result.status !== 'ok')
      this.services.log.debug({ url, status: result.status, reason: result.reason }, 'no link preview');
    const preview = result.status === 'ok' ? result.preview : null;
    await db
      .insert(linkPreviews)
      .values({
        burrowId,
        url,
        preview,
        status: result.status,
        reason: result.status === 'ok' ? null : result.reason,
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: [linkPreviews.burrowId, linkPreviews.url],
        set: {
          preview,
          status: result.status,
          reason: result.status === 'ok' ? null : result.reason,
          fetchedAt: now,
        },
      });
    return preview;
  }

  /** Stores the previews of the links still in the message (merged with what it had) and tells its room. */
  async apply(burrowId: string, messageId: string, found: ReadonlyMap<string, LinkPreview>): Promise<void> {
    await this.services.pipeline.transact(burrowId, async (session) => {
      const tx = session.tx;
      const [row] = await tx.select().from(messages).where(eq(messages.id, messageId)).for('update');
      if (!row || row.deletedAt) return;
      const conversation = await loadConversationRow(tx, row.conversationId);
      if (!conversation) return;
      const had = new Map((row.previews ?? []).map((p) => [p.url, p]));
      const next = previewUrls(row.text, { ownOrigins: this.ownOrigins() })
        .map((url) => found.get(url) ?? had.get(url))
        .filter((p): p is LinkPreview => !!p)
        .slice(0, LINK_PREVIEWS_MAX);
      const before = JSON.stringify(row.previews ?? []);
      if (JSON.stringify(next) === before) return;
      await tx
        .update(messages)
        .set({ previews: next.length ? next : null })
        .where(eq(messages.id, row.id));
      const [message] = await loadMessages(tx, [{ ...row, previews: next.length ? next : null }], null);
      if (message)
        session.publish(topics.conversation(row.conversationId), { type: 'message.updated', message });
    });
  }

  #timer: NodeJS.Timeout | null = null;

  /** Prunes the cache hourly. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      this.prune().catch((err) => this.services.log.warn({ err: String(err) }, 'link preview prune failed'));
    }, 3_600_000);
    this.#timer.unref?.();
  }

  close(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Drops cache rows nobody would use any more (older than the longest TTL). */
  async prune(): Promise<number> {
    const cutoff = new Date(this.services.clock().getTime() - PREVIEW_CACHE_MS);
    const gone = await this.services.db
      .delete(linkPreviews)
      .where(lt(linkPreviews.fetchedAt, cutoff))
      .returning({ url: linkPreviews.url });
    return gone.length;
  }
}
