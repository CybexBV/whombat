/** Mobile inbox, notifications, device registration and live activities. */
import { z } from 'zod';
import { Approval } from '../domain/approval.js';
import { Count } from '../domain/common.js';
import {
  Device,
  DevicePlatform,
  LiveActivityPush,
  Notification,
  NotificationKind,
  PushProvider,
} from '../domain/notification.js';
import { ApprovalId, DeviceId, NotificationId, RunId } from '../ids.js';
import { BurrowParam, endpoint } from './endpoint.js';
import { OkResponse } from './errors.js';

const B = z.object({ burrow: BurrowParam });

/** Inbox filter chips: All / Needs you / Mentions / Agents. */
export const InboxFilter = z.enum(['all', 'needs_you', 'mentions', 'agents']);
export type InboxFilter = z.infer<typeof InboxFilter>;

/** Section titles in order. Since 0.26 (CT-175) `reply` (REPLIES) sits after MENTIONS and counts under the Mentions chip. */
export const INBOX_SECTIONS: readonly { kind: NotificationKind; title: string; filter: InboxFilter }[] = [
  { kind: 'needs_you', title: 'NEEDS YOU', filter: 'needs_you' },
  { kind: 'mention', title: 'MENTIONS', filter: 'mentions' },
  { kind: 'reply', title: 'REPLIES', filter: 'mentions' },
  { kind: 'agent_update', title: 'FROM THE AGENT', filter: 'agents' },
];

/** An inbox row. Needs-you rows for an approval carry it for inline Approve / Details and the status line. */
export const InboxItem = Notification.extend({ approval: Approval.nullable() });
export type InboxItem = z.infer<typeof InboxItem>;

export const InboxResponse = z.object({
  sections: z.array(z.object({ kind: NotificationKind, title: z.string(), items: z.array(InboxItem) })),
  counts: z.object({ all: Count, needs_you: Count, mentions: Count, agents: Count }),
  unread: Count,
});
export type InboxResponse = z.infer<typeof InboxResponse>;

export const RegisterDeviceBody = z.object({
  platform: DevicePlatform,
  provider: PushProvider,
  /** FCM / APNs token, or the web push subscription endpoint. */
  token: z.string().min(1).max(4096),
  /** Web push subscription keys. */
  webPush: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }).optional(),
  name: z.string().max(120).optional(),
  liveActivityToken: z.string().max(4096).optional(),
});

/** A VAPID public key: the 65-byte uncompressed P-256 point, base64url without padding (87 characters). */
export const VapidPublicKey = z.string().regex(/^[A-Za-z0-9_-]{87}$/);
export const VapidKeyResponse = z.object({ publicKey: VapidPublicKey });
export type VapidKeyResponse = z.infer<typeof VapidKeyResponse>;

export const notificationEndpoints = {
  inbox: endpoint({
    id: 'notifications.inbox',
    method: 'GET',
    path: '/burrows/:burrow/inbox',
    summary: 'Mobile inbox: NEEDS YOU / MENTIONS / FROM AGENTS for a filter chip.',
    params: B,
    query: z.object({ filter: InboxFilter.default('all') }),
    response: InboxResponse,
  }),
  markRead: endpoint({
    id: 'notifications.markRead',
    method: 'POST',
    path: '/burrows/:burrow/notifications/read',
    summary: 'Mark notifications read (some, or all).',
    params: B,
    body: z.union([
      z.object({ ids: z.array(NotificationId).min(1).max(200) }),
      z.object({ all: z.literal(true) }),
    ]),
    response: z.object({ unread: Count }),
  }),
};

/** The most error notes an app sends in one report (the newest stay). */
export const APP_ERROR_NOTES_MAX = 5;

/**
 * One error that stopped the phone app, or a page of it, as the app noted it at that moment: the error's own words
 * and where in the code it was, for finding the cause (Apple's and Google's crash reports carry neither for an
 * error in the app's JavaScript). Never what was on screen.
 */
export const AppErrorNote = z.object({
  /** When it happened (ISO). */
  at: z.string().max(40),
  /** The app build that had it (`ios 3.117.1 (3117001)`). */
  build: z.string().max(64),
  /**
   * `app`: the app ended (an error in its JavaScript, or an ending the next start or iOS told it about); `page`: the app
   * went on (a page showed “This page didn’t load”, or an error nobody saw). `name` says which.
   */
  kind: z.enum(['app', 'page']),
  name: z.string().max(100).nullable(),
  message: z.string().max(1000),
  /** The innermost frames of its stack, a line each. */
  stack: z.array(z.string().max(300)).max(20),
  /** The components it was drawn in, innermost first, when it happened while drawing. */
  components: z.string().max(2000).nullable(),
});
export type AppErrorNote = z.infer<typeof AppErrorNote>;

export const deviceEndpoints = {
  register: endpoint({
    id: 'devices.register',
    method: 'POST',
    path: '/devices',
    summary: 'Register (or refresh) a push target for the signed-in account.',
    body: RegisterDeviceBody,
    response: z.object({ device: Device }),
    status: 201,
  }),
  update: endpoint({
    id: 'devices.update',
    method: 'PATCH',
    path: '/devices/:deviceId',
    summary: 'Rotate a push token or live-activity token.',
    params: z.object({ deviceId: DeviceId }),
    body: z.object({
      token: z.string().min(1).max(4096).optional(),
      liveActivityToken: z.string().max(4096).optional(),
    }),
    response: z.object({ device: Device }),
  }),
  remove: endpoint({
    id: 'devices.remove',
    method: 'DELETE',
    path: '/devices/:deviceId',
    summary: 'Stop sending pushes to a device (sign-out).',
    params: z.object({ deviceId: DeviceId }),
    response: OkResponse,
  }),
  registerLiveActivity: endpoint({
    id: 'devices.registerLiveActivity',
    method: 'POST',
    path: '/devices/:deviceId/live-activities',
    summary: 'iOS: push token of a started live activity for a run or a pending approval.',
    params: z.object({ deviceId: DeviceId }),
    body: z.union([
      z.object({ kind: z.literal('run'), runId: RunId, pushToken: z.string().min(1).max(4096) }),
      z.object({
        kind: z.literal('approval'),
        approvalId: ApprovalId,
        pushToken: z.string().min(1).max(4096),
      }),
    ]),
    response: OkResponse,
  }),
  reportErrors: endpoint({
    id: 'devices.reportErrors',
    method: 'POST',
    path: '/devices/error-notes',
    summary:
      'The phone app sends the errors that stopped it (or one of its pages) since it last could: the box writes them into its own log, for finding the cause. Nothing is stored.',
    body: z.object({ notes: z.array(AppErrorNote).min(1).max(APP_ERROR_NOTES_MAX) }),
    response: OkResponse,
  }),
  vapidKey: endpoint({
    id: 'devices.vapidKey',
    method: 'GET',
    path: '/push/vapid-key',
    auth: 'none',
    summary:
      'The box’s own Web Push key (1.1, CT-1307): a browser subscribes with it (`PushManager.subscribe({applicationServerKey})`) and registers the subscription with `devices.register`. Over the session for enrolled devices; a box without a key of its own (commercial: push goes through control) refuses with `push.web_unavailable` (`not_allowed`). `Bootstrap.capabilities.webPush` says whether to ask.',
    response: VapidKeyResponse,
  }),
};

/**
 * Data payload of a push (FCM data message / APNs custom keys / web push JSON). Clients route `link`
 * and update live activities from `run` / `approval`.
 */
export const PushPayload = z.object({
  burrow: z.string(),
  notificationId: NotificationId.nullable(),
  /** `direct` and `reply` since 0.26 (CT-175). */
  kind: z.enum([
    'needs_you',
    'mention',
    'agent_update',
    'direct',
    'reply',
    'run_progress',
    'approval_updated',
  ]),
  title: z.string(),
  body: z.string(),
  /** Web path to open (`linkPath()`). */
  path: z.string(),
  run: z
    .object({ number: z.number().int(), progress: z.number(), activity: z.string(), status: z.string() })
    .optional(),
  approval: z.object({ number: z.number().int(), state: z.string(), label: z.string() }).optional(),
  /** Present on `run_progress` / `approval_updated` pushes: the live activity's full content state. */
  liveActivity: LiveActivityPush.optional(),
});
export type PushPayload = z.infer<typeof PushPayload>;
