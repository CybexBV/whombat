/**
 * Push (MA-03, MA-10): the appliance asks control to wake endpoints; control sends the alert through APNs/FCM/Web
 * Push. Since 0.51 (CT-286) the request may carry a short `preview` (title and text) the phone shows; without one the
 * phone shows a generic text by `kind`. Control passes a preview through and never stores it. Details are fetched
 * through the secure session. Cross-language.
 */
import { PushHandle, PushRef, pushRefFor } from '@whombat/protocol/session';
import { z } from 'zod';
import { OpaqueRef } from '../common.js';

export const PUSH_MAX_HANDLES = 50;
export const PUSH_MAX_PER_DEVICE_PER_MINUTE = 60;
export const PUSH_MAX_PER_HANDLE_PER_HOUR = 120;

/** Opaque handle control issued for one app install's push token (defined in `@whombat/protocol`, CT-11). */
/** Push refs (CT-32) are defined in `@whombat/protocol` (`push.resolve` takes them) and re-exported here. */
export { PushHandle, PushRef, pushRefFor };

/** Selects a generic, localized alert text on the phone; never content. */
export const PushKind = z.enum([
  'message',
  'mention',
  'approval',
  'run',
  'update',
  'backup',
  'security',
  'generic',
]);
export type PushKind = z.infer<typeof PushKind>;

/** Longest preview title and text in code points (CT-286): a notification's two lines, not the message. */
export const PUSH_PREVIEW_TITLE_MAX = 80;
export const PUSH_PREVIEW_BODY_MAX = 160;

/**
 * A preview line (CT-286): any script, one line, no control, format or surrogate code points and no separator but
 * U+0020 (the categories `ConsoleDisplayText` uses); the length in code
 * points is in the pattern (ECMAScript `u` mode and Go RE2 agree), not in `.min`/`.max`. A Unicode pattern the
 * cross-language subset admits by name (docs/contracts/cross-language.md).
 */
export const PUSH_PREVIEW_TITLE_RE = /^(?:[^\p{Cc}\p{Cf}\p{Cs}\p{Z}]| ){1,80}$/u;
export const PUSH_PREVIEW_BODY_RE = /^(?:[^\p{Cc}\p{Cf}\p{Cs}\p{Z}]| ){0,160}$/u;

/**
 * What the notification shows (CT-286): plain text, already shortened by the appliance. Absent when the person turned
 * “Show message text in notifications” off, and for kinds that never show content (`security`, `update`, `backup`).
 */
export const PushPreview = z.strictObject({
  title: z.string().regex(PUSH_PREVIEW_TITLE_RE),
  body: z.string().regex(PUSH_PREVIEW_BODY_RE),
});
export type PushPreview = z.infer<typeof PushPreview>;

export const PushRequest = z.strictObject({
  kind: PushKind,
  /** Opaque reference the app resolves through the session (e.g. an inbox item id hash). */
  ref: PushRef,
  handles: z.array(PushHandle).min(1).max(PUSH_MAX_HANDLES),
  /**
   * Replaces an earlier undelivered push with the same key; on the phone, notifications with the same key replace each
   * other (one per conversation thread or approval, CT-286).
   */
  collapseKey: OpaqueRef.optional(),
  ttlS: z.number().int().min(0).max(86_400),
  /** The notification's title and text (CT-286); absent = the phone's generic text for `kind`. */
  preview: PushPreview.optional(),
  /**
   * Removes the notification with this `collapseKey` from the phone instead of showing one (an approval decided
   * elsewhere, CT-286). Silent; ignored without a `collapseKey`.
   */
  clear: z.boolean().optional(),
});
export type PushRequest = z.infer<typeof PushRequest>;

export const PushResult = z.object({
  accepted: z.number().int().min(0).max(PUSH_MAX_HANDLES),
  /** Unknown or expired handles; the appliance should drop them. */
  invalidHandles: z.array(PushHandle).max(PUSH_MAX_HANDLES),
  rateLimited: z.boolean(),
});
export type PushResult = z.infer<typeof PushResult>;
