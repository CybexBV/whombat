/**
 * Client push registration (MA-10, MA-18): control stores the provider token (APNs/FCM) or the browser's Web Push
 * subscription and returns an opaque handle the client gives its appliance (`push.handles.set`). Device push requests
 * stay content-free; for Web Push control encrypts a generic payload to the subscription (RFC 8291).
 */
import { z } from 'zod';
import { PushHandle } from './device/push.js';
import { controlEndpoint } from './endpoint.js';

export const PushPlatform = z.enum(['apns', 'fcm', 'webpush']);
export type PushPlatform = z.infer<typeof PushPlatform>;

/** An app install's APNs or FCM token. */
export const NativePushRegistration = z.strictObject({
  platform: z.enum(['apns', 'fcm']),
  token: z
    .string()
    .min(16)
    .max(4_096)
    .regex(/^[\x21-\x7e]+$/),
  /** APNs topic/environment or FCM project the token belongs to. */
  appId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._:-]+$/),
});

/**
 * A browser's `PushSubscription.toJSON()` (Push API): the push service endpoint and the client's keys, subscribed
 * with control's VAPID key (`push.vapid`). `p256dh` is the 65-byte uncompressed P-256 public key, `auth` the 16-byte
 * secret, both base64url without padding.
 */
export const WebPushSubscription = z.strictObject({
  endpoint: z
    .string()
    .min(12)
    .max(2_048)
    .regex(/^https:[/][/][\x21-\x7e]+$/),
  keys: z.strictObject({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  }),
  /** Epoch milliseconds when the push service expires the subscription, or null (`toJSON()` always has it). */
  expirationTime: z.number().int().min(0).max(4_102_444_800_000).nullable(),
});
export type WebPushSubscription = z.infer<typeof WebPushSubscription>;

export const WebPushRegistration = z.strictObject({
  platform: z.literal('webpush'),
  subscription: WebPushSubscription,
});

export const PushRegistration = z.discriminatedUnion('platform', [
  NativePushRegistration,
  WebPushRegistration,
]);
export type PushRegistration = z.infer<typeof PushRegistration>;

/** Control's VAPID public key for this environment: `PushManager.subscribe({applicationServerKey})`. */
export const PushVapidKey = z.object({
  /** 65-byte uncompressed P-256 public key, base64url without padding. */
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
});

export const pushApi = {
  register: controlEndpoint({
    id: 'push.register',
    method: 'POST',
    path: '/push/handles',
    auth: 'session',
    summary:
      'Register this app install’s APNs/FCM token or this browser’s Web Push subscription; returns an opaque handle the client hands to its appliance (`push.handles.set`).',
    body: PushRegistration,
    response: z.object({ handle: PushHandle }),
  }),
  vapid: controlEndpoint({
    id: 'push.vapid',
    method: 'GET',
    path: '/push/vapid',
    auth: 'none',
    summary: 'Control’s VAPID public key for this environment (the browser subscribes with it).',
    response: PushVapidKey,
  }),
  unregister: controlEndpoint({
    id: 'push.unregister',
    method: 'DELETE',
    path: '/push/handles/:handle',
    auth: 'session',
    summary: 'Forget a handle (sign-out, uninstall, a revoked browser subscription).',
    response: z.object({ ok: z.literal(true) }),
  }),
};
