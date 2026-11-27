/** Search questions and answers, canvases (metadata and side comments) and plan steps. */
import { isRelativePosition } from '@whombat/canvas-schema';
import {
  AnswerId,
  CommentAnchor,
  CommentId,
  ConversationId,
  conversationLabel,
  newId,
  type Receipt,
  slugify,
  topics,
} from '@whombat/core';
import { resolveLanguage, type SupportedLanguage } from '@whombat/core/i18n';
import { and, desc, eq, gt, inArray, like, or } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import { canvasComments, canvases, principals, searchAnswers, searchDocuments } from '../db/schema/index';
import { enqueueDispatches } from '../domain/dispatch';
import { postMessage } from '../domain/messages';
import { ensurePersonalDm } from '../domain/personal-dm';
import { indexCanvas } from '../domain/search-index';
import { accountLocale } from '../i18n/locale';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { iso } from '../lib/time';
import { loadConversationRow } from '../read/conversations';
import { loadAgentRow, loadPrincipalRow } from '../read/principals';
import { docReadableBy, inSearchLanguage, SEARCH_ANSWER_REUSE_MS, sameSearchWords } from '../read/search';

/* Search ----------------------------------------------------------------------------------------- */

/**
 * The agent, who answers searches (one-agent.md OA-07: no researcher to look up), when it can take a turn; and the
 * asker's chat with it, where the answer's turn reports back.
 */
async function answererOf(ctx: ApplyContext) {
  const agent = await loadAgentRow(ctx.tx, ctx.burrow.id);
  return agent ?? undefined;
}

/** The language the asker reads in; English when it can't be told (no account, a read that failed). */
async function askerLanguage(ctx: ApplyContext, accountId: string | null): Promise<SupportedLanguage> {
  if (!accountId) return 'en';
  try {
    return resolveLanguage(await accountLocale(ctx.services, accountId));
  } catch {
    return 'en';
  }
}

export const askSearch = defineCommand({
  name: 'ask_search',
  // AI search asks the agent (LC-10); plain search stays open.
  licence: 'agentTurn',
  schema: z.object({ q: z.string().trim().min(1).max(500) }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Agents search with the search tool.');
    // The same words (case and spacing aside) asked again by the same person: the answer on its way or given within
    // the reuse window is the answer, and nobody is woken again (review-features.md RF-08). A failed one, one asked
    // while the agent couldn't answer and an older one are asked again.
    // Answers are kept by the language they were asked in: after a switch the same words are asked again in the new
    // language, while an earlier answer (on its way or given) stays readable by its id.
    const asker = await loadPrincipalRow(tx, ctx.actor.id);
    const language = await askerLanguage(ctx, asker?.accountId ?? null);
    const [recent] = await tx
      .select({ id: searchAnswers.id })
      .from(searchAnswers)
      .where(
        and(
          eq(searchAnswers.burrowId, ctx.burrow.id),
          eq(searchAnswers.askedById, ctx.actor.id),
          sameSearchWords(searchAnswers.query, input.q),
          inSearchLanguage(language),
          inArray(searchAnswers.status, ['pending', 'ready']),
          gt(searchAnswers.createdAt, new Date(ctx.now.getTime() - SEARCH_ANSWER_REUSE_MS)),
        ),
      )
      .orderBy(desc(searchAnswers.createdAt))
      .limit(1);
    if (recent) return { answerId: recent.id };
    const researcher = await answererOf(ctx);
    const id = newId('answer');
    await tx.insert(searchAnswers).values({
      id,
      burrowId: ctx.burrow.id,
      query: input.q,
      agentId: researcher?.id ?? ctx.actor.id,
      askedById: ctx.actor.id,
      language,
      status: researcher ? 'pending' : 'none',
      createdAt: ctx.now,
    });
    await ctx.emit({
      type: 'search.asked',
      kind: 'System',
      text: null,
      where: 'Search',
      ...(researcher ? { aboutId: researcher.id } : {}),
      payload: { answerId: id, query: input.q },
    });
    if (researcher) {
      if (!asker) throw notFound('Person');
      const conversationId = await ensurePersonalDm(ctx, researcher, asker);
      const services = ctx.services;
      const burrowId = ctx.burrow.id;
      const causedById = ctx.actor.id;
      const at = ctx.now;
      ctx.after(async () => {
        await enqueueDispatches(services, {
          burrowId,
          causedById,
          conversationId,
          messageId: null,
          threadRootId: null,
          requests: [{ agentId: researcher.id, trigger: 'search', mode: 'answer' }],
          at,
          search: { query: input.q, answerId: id },
        });
      });
    }
    return { answerId: id };
  },
});

/** "Post to #incidents": the answer with its receipts as a message in a conversation. */
export const postAnswer = defineCommand({
  name: 'post_answer_to_conversation',
  schema: z.object({ answerId: AnswerId, conversationId: ConversationId }),
  async apply(tx, ctx, input) {
    const [answer] = await tx
      .select()
      .from(searchAnswers)
      .where(and(eq(searchAnswers.id, input.answerId), eq(searchAnswers.burrowId, ctx.burrow.id)));
    if (!answer) throw notFound('Answer');
    if (answer.status !== 'ready') throw conflict('The answer isn’t ready yet.');
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    if (answer.askedById !== ctx.actor.id) throw notFound('Answer');
    const docs = answer.citations.length
      ? await tx
          .select()
          .from(searchDocuments)
          .where(
            inArray(
              searchDocuments.id,
              answer.citations.map((c) => c.resultId),
            ),
          )
      : [];
    const authors = docs.length
      ? await tx
          .select()
          .from(principals)
          .where(
            inArray(
              principals.id,
              docs.map((d) => d.authorId),
            ),
          )
      : [];
    // Every source must still be readable by the poster (WS-22).
    const poster = await loadPrincipalRow(tx, ctx.actor.id);
    for (const doc of docs) {
      if (!poster || !(await docReadableBy(tx, poster, doc)))
        throw forbidden('One of the answer’s sources isn’t yours to share any more.');
    }
    const receipts: Receipt[] = answer.citations.flatMap((c) => {
      const doc = docs.find((d) => d.id === c.resultId);
      if (!doc) return [];
      const who = authors.find((a) => a.id === doc.authorId);
      return [
        {
          n: c.n,
          source: doc.where.slice(0, 160),
          detail: (who?.name ?? '').slice(0, 120),
          link: doc.link,
          resultId: doc.id,
        },
      ];
    });
    const posted = await postMessage(ctx, {
      conversation,
      text: answer.text,
      card: receipts.length ? { kind: 'answer', receipts, query: answer.query } : null,
      dispatch: false,
    });
    return { messageId: posted.id };
  },
});

/* Canvases --------------------------------------------------------------------------------------- */

async function uniqueCanvasSlug(ctx: ApplyContext, title: string): Promise<string> {
  const stem = slugify(title, 'canvas').slice(0, 100).replace(/-+$/g, '') || 'canvas';
  const rows = await ctx.tx
    .select({ slug: canvases.slug })
    .from(canvases)
    .where(
      and(
        eq(canvases.burrowId, ctx.burrow.id),
        or(eq(canvases.slug, stem), like(canvases.slug, `${stem}-%`)),
      ),
    );
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(stem)) return stem;
  for (let i = 2; ; i++) if (!taken.has(`${stem}-${i}`)) return `${stem}-${i}`;
}

/** A canvas of the actor's burrow: every one is the person's and the agent's to read. */
export function canvasVisible(ctx: Pick<ApplyContext, 'burrow'>, canvas: typeof canvases.$inferSelect) {
  return canvas.burrowId === ctx.burrow.id;
}

/**
 * Inserts a canvas (in a conversation, optionally bound to a plan) with its signed `canvas.created` event and
 * frame; the search index follows after the commit. The caller checked access.
 */
export async function insertCanvas(
  ctx: ApplyContext,
  input: { title: string; conversationId: string | null; markdown?: string; planId?: string | null },
): Promise<{ canvasId: string; slug: string }> {
  let where = 'Canvases';
  if (input.conversationId) {
    const conv = await loadConversationRow(ctx.tx, input.conversationId);
    if (conv) where = conversationLabel(conv);
  }
  const id = newId('canvas');
  const slug = await uniqueCanvasSlug(ctx, input.title);
  await ctx.tx.insert(canvases).values({
    id,
    burrowId: ctx.burrow.id,
    slug,
    title: input.title,
    conversationId: input.conversationId,
    planId: input.planId ?? null,
    provenance: { createdById: ctx.actor.id, requestedById: null, editorIds: [] },
    ...(input.markdown ? { markdown: input.markdown } : {}),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  const event = await ctx.emit({
    type: 'canvas.created',
    kind: 'Messages',
    text: `Wrote the canvas “${input.title}”`,
    where,
    ref: { type: 'canvas', slug },
    payload: { canvasId: id, ...(input.planId ? { planId: input.planId } : {}) },
  });
  const [row] = await ctx.tx.select().from(canvases).where(eq(canvases.id, id));
  if (row)
    ctx.publish(
      topics.canvas(id),
      {
        type: 'canvas.updated',
        canvas: {
          id,
          burrowId: row.burrowId,
          slug,
          title: row.title,
          conversationId: row.conversationId,
          planId: row.planId,
          provenance: row.provenance,
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
        },
      },
      { eventId: event.id },
    );
  const services = ctx.services;
  ctx.after(() => indexCanvas(services.db, id));
  return { canvasId: id, slug };
}

export const createCanvas = defineCommand({
  name: 'create_canvas',
  schema: z.object({
    title: z.string().trim().min(1).max(160),
    conversationId: ConversationId.optional(),
    /** Starting text after the title (MCP `canvas_create`). */
    markdown: z.string().max(20_000).optional(),
  }),
  // An ask lands where the canvas would be (one-agent.md OA-S42).
  requiredKey: (input) => ({
    keyId: 'canvas.write',
    attempt: `write the canvas “${input.title}”`,
    where: null,
    conversationId: input.conversationId ?? null,
  }),
  async apply(tx, ctx, input) {
    if (input.conversationId) {
      const conv = await loadConversationRow(tx, input.conversationId);
      if (!conv || conv.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    }
    return insertCanvas(ctx, {
      title: input.title,
      conversationId: input.conversationId ?? null,
      ...(input.markdown?.trim() ? { markdown: `# ${input.title}\n\n${input.markdown.trim()}\n` } : {}),
    });
  },
});

async function canvasBySlug(ctx: ApplyContext, slug: string) {
  const [row] = await ctx.tx
    .select()
    .from(canvases)
    .where(and(eq(canvases.burrowId, ctx.burrow.id), eq(canvases.slug, slug)));
  if (!row || !canvasVisible(ctx, row)) throw notFound('Canvas');
  return row;
}

function commentOf(row: typeof canvasComments.$inferSelect) {
  return {
    id: row.id,
    canvasId: row.canvasId,
    anchor: row.anchor,
    parentId: row.parentId,
    authorId: row.authorId,
    text: row.text,
    createdAt: iso(row.createdAt),
    resolved: row.resolved,
  };
}

export const addCanvasComment = defineCommand({
  name: 'add_canvas_comment',
  schema: z.object({
    slug: z.string().min(1).max(120),
    anchor: CommentAnchor.optional(),
    parentId: CommentId.optional(),
    text: z.string().trim().min(1).max(4000),
  }),
  async apply(tx, ctx, input) {
    const canvas = await canvasBySlug(ctx, input.slug);
    if (!input.anchor && !input.parentId) throw badRequest('Anchor the comment or reply to one.');
    // Anchors are Yjs relative positions in the canvas document (collab-server.md).
    if (!input.parentId && input.anchor && !isRelativePosition(input.anchor.relativePosition))
      throw badRequest('The comment anchor is not a position in this canvas.');
    if (input.parentId) {
      const [parent] = await tx.select().from(canvasComments).where(eq(canvasComments.id, input.parentId));
      if (!parent || parent.canvasId !== canvas.id || parent.parentId) throw notFound('Comment');
    }
    const id = newId('comment');
    const [row] = await tx
      .insert(canvasComments)
      .values({
        id,
        canvasId: canvas.id,
        burrowId: ctx.burrow.id,
        anchor: input.parentId ? null : (input.anchor ?? null),
        parentId: input.parentId ?? null,
        authorId: ctx.actor.id,
        text: input.text,
        createdAt: ctx.now,
      })
      .returning();
    const event = await ctx.emit({
      type: 'canvas.commented',
      kind: 'Messages',
      text: null,
      where: canvas.title,
      ref: { type: 'canvas', slug: canvas.slug },
      payload: { canvasId: canvas.id, commentId: id, parentId: input.parentId ?? null },
    });
    if (row)
      ctx.publish(
        topics.canvas(canvas.id),
        { type: 'canvas.comment', comment: commentOf(row) },
        { eventId: event.id },
      );
    return { commentId: id };
  },
});

export const resolveCanvasComment = defineCommand({
  name: 'resolve_canvas_comment',
  schema: z.object({ slug: z.string().min(1).max(120), commentId: CommentId, resolved: z.boolean() }),
  async apply(tx, ctx, input) {
    const canvas = await canvasBySlug(ctx, input.slug);
    const [row] = await tx.select().from(canvasComments).where(eq(canvasComments.id, input.commentId));
    if (!row || row.canvasId !== canvas.id) throw notFound('Comment');
    const rootId = row.parentId ?? row.id;
    await tx.update(canvasComments).set({ resolved: input.resolved }).where(eq(canvasComments.id, rootId));
    const event = await ctx.emit({
      type: 'canvas.resolved',
      kind: 'Messages',
      text: null,
      where: canvas.title,
      ref: { type: 'canvas', slug: canvas.slug },
      payload: { canvasId: canvas.id, commentId: rootId, resolved: input.resolved },
    });
    const [root] = await tx.select().from(canvasComments).where(eq(canvasComments.id, rootId));
    if (root)
      ctx.publish(
        topics.canvas(canvas.id),
        { type: 'canvas.comment', comment: commentOf(root) },
        { eventId: event.id },
      );
    return { commentId: rootId };
  },
});
