/**
 * Shared links (Whombat docs/decisions/share-links.md): the person's REST contract for sharing part of a Chat thread by
 * link, and the list of their links. A link holds a sealed copy that control keeps and serves; the key is in the link
 * itself, so only people the person gives the link to can read it. Session ops too (`shares.*`).
 */
import { z } from 'zod';
import { Timestamp } from '../domain/common.js';
import { MessageId } from '../ids.js';
import { ShareExpiry, ShareId } from '../share/index.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

/** What a link would show: a thread from its first message, or from `fromMessageId` (one of its messages) on. */
export const ShareScope = z.strictObject({
  rootId: MessageId,
  fromMessageId: MessageId.optional(),
});
export type ShareScope = z.infer<typeof ShareScope>;

/** Something in the words to look at before sharing: an address on a home network, an email address, a key or password. */
export const ShareWarning = z.object({
  kind: z.enum(['address', 'email', 'secret']),
  /** How many of the shared messages have it. */
  messages: z.number().int().min(1),
  /** The first one found, as written (a secret is shown cut short). */
  example: z.string().max(80),
});
export type ShareWarning = z.infer<typeof ShareWarning>;

export const SharePreview = z.object({
  title: z.string().max(200),
  /** The messages the link would show (the person's and the assistant's). */
  messages: z.number().int().min(0),
  /** Pictures in those messages; they are in the link only when the person keeps them. */
  pictures: z.number().int().min(0),
  /** Charts and pages the assistant drew there (always in the link). */
  pages: z.number().int().min(0),
  /** What the link never shows that these messages have: approvals and other cards, files, details. */
  leftOut: z.number().int().min(0),
  warnings: z.array(ShareWarning),
  /** Whether the copy fits with its pictures, and without them. */
  fits: z.object({ withPictures: z.boolean(), withoutPictures: z.boolean() }),
});
export type SharePreview = z.infer<typeof SharePreview>;

export const ShareState = z.enum(['live', 'expired', 'stopped']);
export type ShareState = z.infer<typeof ShareState>;

/** One of the person's links. `url` holds the key (after `#`): it opens the copy. */
export const SharedLink = z.object({
  id: ShareId,
  title: z.string().max(200),
  url: z.string().max(400),
  rootId: MessageId,
  messages: z.number().int().min(0),
  pictures: z.boolean(),
  createdAt: Timestamp,
  /** Null: works until the person stops it. */
  expiresAt: Timestamp.nullable(),
  stoppedAt: Timestamp.nullable(),
  state: ShareState,
  /** Stopped here, but Whombat's servers haven't deleted the copy yet: it does as soon as they can be reached. */
  stopping: z.boolean(),
  /** How often it was opened, when control could say (null: unknown now). */
  views: z.number().int().min(0).nullable(),
});
export type SharedLink = z.infer<typeof SharedLink>;

export const CreateShareBody = ShareScope.extend({
  /** Keep the pictures in the copy (on unless the person turns it off). */
  pictures: z.boolean(),
  expiry: ShareExpiry,
});
export type CreateShareBody = z.infer<typeof CreateShareBody>;

export const shareEndpoints = {
  preview: endpoint({
    id: 'shares.preview',
    method: 'POST',
    path: '/burrows/:burrow/shares/preview',
    summary:
      'What a link to a thread of the caller’s Chat would show: how many messages and pictures, what is left out, and anything in the words to look at first. Changes nothing.',
    params: B,
    body: ShareScope,
    response: SharePreview,
  }),
  create: endpoint({
    id: 'shares.create',
    method: 'POST',
    path: '/burrows/:burrow/shares',
    summary:
      'Share a thread of the caller’s Chat by link: Whombat seals a copy, keeps it at Whombat’s servers until it expires or is stopped, and answers the link (with its key).',
    params: B,
    body: CreateShareBody,
    response: z.object({ share: SharedLink }),
    status: 201,
  }),
  list: endpoint({
    id: 'shares.list',
    method: 'GET',
    path: '/burrows/:burrow/shares',
    summary: 'The caller’s shared links, newest first, with how often each was opened.',
    params: B,
    response: z.object({ shares: z.array(SharedLink) }),
  }),
  stop: endpoint({
    id: 'shares.stop',
    method: 'DELETE',
    path: '/burrows/:burrow/shares/:shareId',
    summary: 'Stop a link: its copy is deleted at Whombat’s servers and the link stops working.',
    params: B.extend({ shareId: ShareId }),
    response: z.object({ share: SharedLink }),
  }),
  stopAll: endpoint({
    id: 'shares.stopAll',
    method: 'POST',
    path: '/burrows/:burrow/shares/stop',
    summary: 'Stop every link of the caller that still works.',
    params: B,
    body: z.strictObject({}),
    response: z.object({ stopped: z.number().int().min(0) }),
  }),
} as const;
