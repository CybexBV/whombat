/** Canvases: index, metadata, comments and the collaboration token for `/collab`. */
import { z } from 'zod';
import { Canvas, CanvasComment, CanvasCommentThread, CommentAnchor } from '../domain/canvas.js';
import { Timestamp } from '../domain/common.js';
import { Plan } from '../domain/plan.js';
import { CommentId, ConversationId, PrincipalId } from '../ids.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });
const BS = B.extend({ slug: z.string().min(1).max(120) });

export const CanvasSummary = Canvas.extend({
  /** "#billing-v2" breadcrumb. */
  conversationTitle: z.string().nullable(),
});
export type CanvasSummary = z.infer<typeof CanvasSummary>;

export const CanvasDetail = z.object({
  canvas: Canvas,
  conversationTitle: z.string().nullable(),
  /** Plan bound to the plan block. */
  plan: Plan.nullable(),
  comments: z.array(CanvasCommentThread),
  /** Principals on the canvas now ("2 here"); live updates come from Yjs awareness. */
  presentIds: z.array(PrincipalId),
  /** Yjs document name on the Hocuspocus server. */
  documentName: z.string(),
});
export type CanvasDetail = z.infer<typeof CanvasDetail>;

/* Collaboration (`/collab`, Hocuspocus protocol) ------------------------------------------------- */

/** Hocuspocus WebSocket path on the server (the web dev server proxies it). */
export const COLLAB_PATH = '/collab';

/** Yjs document name of a canvas on the collaboration server (`CanvasDetail.documentName`). */
export function collabDocumentName(canvasId: string): string {
  return `canvas:${canvasId}`;
}

/** Canvas id of a collaboration document name, or null when it is not a canvas document. */
export function parseCollabDocumentName(name: string): string | null {
  const m = /^canvas:(cvs_[A-Za-z0-9_-]{1,80})$/.exec(name);
  return m ? (m[1] as string) : null;
}

/**
 * A `color` a collaborator may carry: a `#rrggbb` hex (people, from their avatar tone) or a `var(--…)`
 * token (agents, `var(--role-architect)`; the default `var(--brand)`). Rejects anything else — in
 * particular any `;`, `url(`, or other CSS that could break out of the `style` string it is interpolated
 * into (`presence.ts`'s `--writer`/`--caret` custom properties, `writerDecorations()`).
 */
const CollabColor = z
  .string()
  .max(80)
  .regex(/^(?:#[0-9a-fA-F]{6}|var\(--[a-zA-Z0-9-]+\))$/);

/**
 * Who a collaborator is, as carried in Yjs awareness (`state.user`, what Tiptap's CollaborationCaret reads).
 * The server stamps `principalId`, `name` and `kind` from the authenticated connection, so a client cannot appear as
 * someone else. `color` is a CSS color or a token variable (`var(--brand)`).
 */
export const CollabUser = z.object({
  principalId: PrincipalId,
  name: z.string().min(1).max(80),
  kind: z.enum(['person', 'agent']),
  color: CollabColor,
});
export type CollabUser = z.infer<typeof CollabUser>;

/**
 * One collaborator's awareness state on a canvas document: identity, whether they are writing right now
 * ("Toffee is writing") and their caret / selection as Yjs relative positions (y-prosemirror's `cursor`
 * field: `{anchor, head}` from `Y.relativePositionToJSON`).
 */
export const CollabAwarenessState = z.object({
  user: CollabUser,
  writing: z.boolean().default(false),
  cursor: z.object({ anchor: z.unknown(), head: z.unknown() }).nullable().default(null),
});
export type CollabAwarenessState = z.infer<typeof CollabAwarenessState>;

export const CollabTokenResponse = z.object({
  /** Pass as the Hocuspocus provider `token`; valid for connecting until `expiresAt`. */
  token: z.string(),
  documentName: z.string(),
  /** WebSocket URL of the collaboration server; a path (`/collab`) is relative to the page origin. */
  url: z.string(),
  expiresAt: Timestamp,
});
export type CollabTokenResponse = z.infer<typeof CollabTokenResponse>;

/**
 * `canvases.content` (0.55, CT-303): a canvas as Markdown — the same text `canvas_read` gives agents — for clients
 * without the collaborative editor (the phone's read-only canvas screen, MQ-05). `updatedAt` is when its document last
 * changed.
 */
export const CanvasContentResponse = z.object({
  canvas: Canvas,
  markdown: z.string(),
  updatedAt: Timestamp,
});
export type CanvasContentResponse = z.infer<typeof CanvasContentResponse>;

export const AddCommentBody = z.union([
  z.object({ anchor: CommentAnchor, text: z.string().trim().min(1).max(4000) }),
  z.object({ parentId: CommentId, text: z.string().trim().min(1).max(4000) }),
]);

export const canvasEndpoints = {
  list: endpoint({
    id: 'canvases.list',
    method: 'GET',
    path: '/burrows/:burrow/canvases',
    summary: 'Canvases index (sidebar "Canvases").',
    params: B,
    response: z.object({ canvases: z.array(CanvasSummary) }),
  }),
  create: endpoint({
    id: 'canvases.create',
    method: 'POST',
    path: '/burrows/:burrow/canvases',
    summary: 'New canvas (key canvas.write for the agent).',
    params: B,
    body: z.object({ title: z.string().trim().min(1).max(160), conversationId: ConversationId.optional() }),
    response: z.object({ canvas: Canvas }),
    status: 201,
  }),
  get: endpoint({
    id: 'canvases.get',
    method: 'GET',
    path: '/burrows/:burrow/canvases/:slug',
    summary: 'Canvas header, plan block data and side comments.',
    params: BS,
    response: CanvasDetail,
  }),
  content: endpoint({
    id: 'canvases.content',
    method: 'GET',
    path: '/burrows/:burrow/canvases/:slug/content',
    summary:
      'A canvas as Markdown, read-only: the text `canvas_read` gives the agent (0.55, feature `canvases.content`).',
    params: BS,
    response: CanvasContentResponse,
  }),
  collabToken: endpoint({
    id: 'canvases.collabToken',
    method: 'POST',
    path: '/burrows/:burrow/canvases/:slug/collab-token',
    summary: 'Short-lived token for the Hocuspocus connection at `/collab`.',
    params: BS,
    response: CollabTokenResponse,
  }),
  addComment: endpoint({
    id: 'canvases.addComment',
    method: 'POST',
    path: '/burrows/:burrow/canvases/:slug/comments',
    summary: 'Anchored side comment, or a reply to one.',
    params: BS,
    body: AddCommentBody,
    response: z.object({ comment: CanvasComment }),
    status: 201,
  }),
  resolveComment: endpoint({
    id: 'canvases.resolveComment',
    method: 'PATCH',
    path: '/burrows/:burrow/canvases/:slug/comments/:commentId',
    summary: 'Resolve or reopen a comment thread.',
    params: BS.extend({ commentId: CommentId }),
    body: z.object({ resolved: z.boolean() }),
    response: z.object({ comment: CanvasComment }),
  }),
};
