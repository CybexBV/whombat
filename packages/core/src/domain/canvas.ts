import { z } from 'zod';
import { BurrowId, CanvasId, CommentId, ConversationId, PlanId, PrincipalId } from '../ids.js';
import { Timestamp } from './common.js';

/** "Drafted by Toffee from Priya’s request · edited by Mara, Dusty · 12 min ago" */
export const CanvasProvenance = z.object({
  createdById: PrincipalId,
  requestedById: PrincipalId.nullable(),
  /** Other editors, most recent first. */
  editorIds: z.array(PrincipalId),
});
export type CanvasProvenance = z.infer<typeof CanvasProvenance>;

/** Canvas metadata. The body is a Yjs document served by Hocuspocus at `/collab`. */
export const Canvas = z.object({
  id: CanvasId,
  burrowId: BurrowId,
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/),
  title: z.string().min(1).max(160),
  conversationId: ConversationId.nullable(),
  /** Plan bound to the plan block, if any. */
  planId: PlanId.nullable(),
  provenance: CanvasProvenance,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Canvas = z.infer<typeof Canvas>;

/** Anchor of a side comment: a Yjs relative position (base64) plus the quoted text for fallback. */
export const CommentAnchor = z.object({
  relativePosition: z.string().min(1).max(4096),
  quote: z.string().max(500),
});
export type CommentAnchor = z.infer<typeof CommentAnchor>;

export const CanvasComment = z.object({
  id: CommentId,
  canvasId: CanvasId,
  /** Root comments are anchored; replies have `parentId` and inherit the root's anchor. */
  anchor: CommentAnchor.nullable(),
  parentId: CommentId.nullable(),
  authorId: PrincipalId,
  text: z.string().min(1).max(4000),
  createdAt: Timestamp,
  resolved: z.boolean(),
});
export type CanvasComment = z.infer<typeof CanvasComment>;

/** A root comment and its replies, as the comments column groups them. */
export const CanvasCommentThread = z.object({
  id: CommentId,
  anchor: CommentAnchor,
  resolved: z.boolean(),
  comments: z.array(CanvasComment).min(1),
});
export type CanvasCommentThread = z.infer<typeof CanvasCommentThread>;

/** Groups flat comments into threads (root first, replies by time), roots in creation order. */
export function groupCommentThreads(comments: readonly CanvasComment[]): CanvasCommentThread[] {
  const byTime = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const threads: CanvasCommentThread[] = [];
  const index = new Map<string, CanvasCommentThread>();
  for (const c of byTime) {
    if (c.parentId === null && c.anchor) {
      const t: CanvasCommentThread = { id: c.id, anchor: c.anchor, resolved: c.resolved, comments: [c] };
      threads.push(t);
      index.set(c.id, t);
    }
  }
  for (const c of byTime) {
    if (c.parentId === null) continue;
    index.get(c.parentId)?.comments.push(c);
  }
  return threads;
}
