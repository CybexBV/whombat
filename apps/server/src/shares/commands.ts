/**
 * Shared links through the commit pipeline (docs/decisions/share-links.md). Making a link is two steps around the call to
 * control, which can't sit inside a transaction: `share_create` keeps the link's row (its id and sealed key, no viewer
 * URL yet) and `share_published` records that control kept the copy; `share_discard` drops a row whose copy never got
 * there. Stopping marks the row stopped and pending (`share_stop`) until control deleted the copy (`share_stop_done`).
 *
 * The assistant may ask for a link (`share_link`); it always asks the person first, whatever its keys say, because a
 * link reaches people outside the Whombat. On their yes `share_create` runs again as the assistant and the link is made
 * after the commit (`publishForAssistant`).
 */
import { CreateShareBody } from '@whombat/core';
import { newShare, shareExpiresAt, shareToBase64url } from '@whombat/core/share';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand, type KeyRequirement } from '../commit/types';
import { shares } from '../db/schema/index';
import { conflict, forbidden, notFound } from '../lib/errors';
import { publishForAssistant } from './publish';
import { loadShareThread } from './snapshot';

export const SHARE_KEY_ID = 'share.link';
export const SHARE_CREATED_EVENT = 'share.created';
export const SHARE_STOPPED_EVENT = 'share.stopped';

/** The sealed key's AAD. */
export const shareKeyAad = (id: string) => `share:${id}:key`;

const dayFormat = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d);

/** The card's line on how long the link works. */
export function expiryWords(expiresAt: Date | null): string {
  return expiresAt ? `It stops working on ${dayFormat(expiresAt)}.` : 'It works until you stop it.';
}

const CreateInput = CreateShareBody.extend({
  /** The person whose Chat it is (the route's caller, or the turn's person for the assistant). */
  personId: z.string().min(1).max(64),
});

export const createShare = defineCommand({
  name: 'share_create',
  schema: CreateInput,
  async requiredKey(input, { db, burrow, actor }): Promise<KeyRequirement | null> {
    if (actor.kind === 'person') return null;
    const thread = await loadShareThread(db, burrow.id, input.personId, input);
    const expiresAt = shareExpiresAt(input.expiry, Math.floor(Date.now() / 1000));
    const n = thread.shown.length;
    return {
      keyId: SHARE_KEY_ID,
      // Always asks: a link reaches people outside this Whombat (its cap is Ask too).
      grants: [{ agentId: actor.id, keyId: SHARE_KEY_ID, tier: 'ask' }],
      attempt: 'share a thread by link',
      action: {
        type: 'custom',
        params: { name: 'share_link', keyId: SHARE_KEY_ID, data: { rootId: input.rootId } },
      },
      where: 'Chat',
      conversationId: thread.conversationId,
      approval: {
        title: 'Share this thread by link',
        question: 'Share this thread by link?',
        target: 'Chat',
        whatHappens: [
          `Anyone with the link can read ${n === 1 ? 'its message' : `its ${n} messages`}${input.pictures ? ' and pictures' : ''}.`,
          expiryWords(expiresAt === null ? null : new Date(expiresAt * 1000)),
          'You can stop it in Settings.',
        ],
        explainer: `${actor.shortName} always asks before sharing. If you approve, Whombat makes the link once and ${actor.shortName} gives it to you.`,
        cardText: 'I need your yes before I make a link to this thread.',
      },
    };
  },
  async apply(tx, ctx, input) {
    if (ctx.actor.kind === 'person' && ctx.actor.id !== input.personId) throw forbidden();
    const thread = await loadShareThread(tx, ctx.burrow.id, input.personId, input);
    if (thread.shown.length === 0) throw conflict('There’s nothing in this thread to share yet.');
    const { id, key } = newShare();
    const expiresAt = shareExpiresAt(input.expiry, Math.floor(ctx.now.getTime() / 1000));
    await tx.insert(shares).values({
      id,
      burrowId: ctx.burrow.id,
      conversationId: thread.conversationId,
      rootId: thread.rootId,
      fromMessageId: input.fromMessageId ?? null,
      createdById: ctx.actor.id,
      title: thread.title,
      keyEnc: ctx.services.custody.seal(shareKeyAad(id), shareToBase64url(key)),
      viewerUrl: null,
      messages: thread.shown.length,
      pictures: input.pictures,
      bytes: 0,
      createdAt: ctx.now,
      expiresAt: expiresAt === null ? null : new Date(expiresAt * 1000),
    });
    if (ctx.approvalId) {
      // The person said yes to the assistant's ask: the link is made after this commit and the assistant is woken
      // with it in the card's thread.
      const services = ctx.services;
      const call = {
        shareId: id,
        agentId: ctx.actor.id,
        approvalId: ctx.approvalId,
        conversationId: thread.conversationId,
      };
      ctx.after(() => publishForAssistant(services, ctx.burrow.id, call));
    }
    return { id };
  },
});

/** Control kept the copy: the link works from now on. */
export const sharePublished = defineCommand({
  name: 'share_published',
  schema: z.object({
    id: z.string(),
    viewerUrl: z.string().max(300),
    messages: z.number().int().min(0),
    bytes: z.number().int().min(0),
  }),
  async apply(tx, ctx, input) {
    const [row] = await tx.select().from(shares).where(eq(shares.id, input.id)).for('update');
    if (!row || row.burrowId !== ctx.burrow.id) throw notFound('Link');
    await tx
      .update(shares)
      .set({ viewerUrl: input.viewerUrl, messages: input.messages, bytes: input.bytes })
      .where(eq(shares.id, row.id));
    await ctx.emit({
      type: SHARE_CREATED_EVENT,
      kind: 'Messages',
      text: 'Shared a thread of Chat by link',
      where: 'Chat',
      // Ids and counts only: what the thread says stays out of the log.
      payload: {
        shareId: row.id,
        rootId: row.rootId,
        messages: input.messages,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      },
    });
    return { id: row.id };
  },
});

/** The copy never got to control: the row goes, nothing to tell. */
export const shareDiscard = defineCommand({
  name: 'share_discard',
  schema: z.object({ id: z.string() }),
  async apply(tx, ctx, input) {
    await tx
      .delete(shares)
      .where(and(eq(shares.id, input.id), eq(shares.burrowId, ctx.burrow.id), isNull(shares.viewerUrl)));
    return { id: input.id };
  },
});

/** Stop links: they no longer show here as working, and control is asked to delete their copies. */
export const shareStop = defineCommand({
  name: 'share_stop',
  schema: z.object({
    ids: z.array(z.string()).min(1).max(500),
    why: z.enum(['person', 'thread_gone']),
  }),
  async apply(tx, ctx, input) {
    const rows = await tx
      .select()
      .from(shares)
      .where(and(inArray(shares.id, input.ids), eq(shares.burrowId, ctx.burrow.id), isNull(shares.stoppedAt)))
      .for('update');
    if (rows.length === 0) return { stopped: [] as string[] };
    await tx
      .update(shares)
      .set({ stoppedAt: ctx.now, stopPending: true })
      .where(
        inArray(
          shares.id,
          rows.map((r) => r.id),
        ),
      );
    await ctx.emit({
      type: SHARE_STOPPED_EVENT,
      kind: 'Messages',
      text: rows.length === 1 ? 'Stopped a shared link' : `Stopped ${rows.length} shared links`,
      where: 'Chat',
      payload: { shareIds: rows.map((r) => r.id), why: input.why },
    });
    return { stopped: rows.map((r) => r.id) };
  },
});

/** Control deleted these copies. */
export const shareStopDone = defineCommand({
  name: 'share_stop_done',
  schema: z.object({ ids: z.array(z.string()).min(1).max(500) }),
  async apply(tx, ctx, input) {
    await tx
      .update(shares)
      .set({ stopPending: false })
      .where(and(inArray(shares.id, input.ids), eq(shares.burrowId, ctx.burrow.id)));
    return { ids: input.ids };
  },
});

export const SHARE_COMMANDS = [createShare, sharePublished, shareDiscard, shareStop, shareStopDone];
