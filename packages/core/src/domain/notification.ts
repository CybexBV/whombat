import { z } from 'zod';
import { AccountId, ApprovalId, BurrowId, DeviceId, NotificationId, PrincipalId, RunId } from '../ids.js';
import { Count, Percent, Timestamp, Tone } from './common.js';
import { LinkRef } from './links.js';

/**
 * Inbox sections: NEEDS YOU / MENTIONS / FROM THE AGENT, and since 0.26 (CT-175) `reply` (a reply in a thread the
 * person is in).
 */
export const NotificationKind = z.enum(['needs_you', 'mention', 'agent_update', 'reply']);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const Notification = z.object({
  id: NotificationId,
  burrowId: BurrowId,
  /** Recipient. */
  principalId: PrincipalId,
  kind: NotificationKind,
  /** Who the row is from (avatar and name). */
  actorId: PrincipalId,
  /** "Chat", "Plan canvas", "feat/invoice-pdf". */
  where: z.string().max(120),
  text: z.string().max(500),
  link: LinkRef,
  /** Needs-you rows for an approval get inline Approve / Details. */
  approvalId: ApprovalId.nullable(),
  createdAt: Timestamp,
  readAt: Timestamp.nullable(),
});
export type Notification = z.infer<typeof Notification>;

export const DevicePlatform = z.enum(['android', 'ios', 'web']);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

/** Push transport: FCM HTTP v1 (Android), APNs (iOS), Web Push (VAPID). */
export const PushProvider = z.enum(['fcm', 'apns', 'webpush']);
export type PushProvider = z.infer<typeof PushProvider>;

export const WebPushSubscription = z.object({
  endpoint: z.url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
export type WebPushSubscription = z.infer<typeof WebPushSubscription>;

/** A push target. Devices belong to the account, so one phone gets notifications from every burrow. */
export const Device = z.object({
  id: DeviceId,
  accountId: AccountId,
  platform: DevicePlatform,
  provider: PushProvider,
  /** FCM / APNs token; for web push the subscription endpoint. */
  token: z.string().min(1).max(4096),
  name: z.string().max(120).nullable(),
  /** iOS ActivityKit push-to-start token for live activities. */
  liveActivityToken: z.string().max(4096).nullable(),
  createdAt: Timestamp,
  lastSeenAt: Timestamp.nullable(),
});
export type Device = z.infer<typeof Device>;

/* ---------------------------------------------------------------------------------------------- */
/* Live activities (TODO 9.4): a run in progress or a pending approval, tracked on the lock screen  */
/* / Dynamic Island (iOS ActivityKit) or as an ongoing notification (Android), kept fresh by data    */
/* pushes derived from `run.updated` / `approval.updated`, throttled to one update per 2 s.          */
/* ---------------------------------------------------------------------------------------------- */

export const LiveActivityKind = z.enum(['run', 'approval']);
export type LiveActivityKind = z.infer<typeof LiveActivityKind>;

/** start = the activity should begin on the device; update = refresh its content; end = dismiss it. */
export const LiveActivityEventType = z.enum(['start', 'update', 'end']);
export type LiveActivityEventType = z.infer<typeof LiveActivityEventType>;

/** A run in progress: agent, title, progress %, current step, tests passed/total, state. */
export const RunLiveActivity = z.object({
  kind: z.literal('run'),
  runId: RunId,
  number: z.number().int().positive(),
  burrowId: BurrowId,
  agentId: PrincipalId,
  agentName: z.string().min(1).max(120),
  title: z.string().min(1).max(160),
  branch: z.string().min(1).max(255),
  progress: Percent,
  currentStep: z.string().max(160).nullable(),
  testsPassed: Count.nullable(),
  testsTotal: Count.nullable(),
  state: z.enum(['live', 'paused', 'done', 'failed', 'taken_over']),
});
export type RunLiveActivity = z.infer<typeof RunLiveActivity>;

/** A pending approval: question, conditions met count, state. */
export const ApprovalLiveActivity = z.object({
  kind: z.literal('approval'),
  approvalId: ApprovalId,
  number: z.number().int().positive(),
  burrowId: BurrowId,
  requesterId: PrincipalId,
  question: z.string().min(1).max(200),
  conditionsMet: Count,
  conditionsTotal: Count,
  state: z.enum(['pending', 'approved', 'declined']),
});
export type ApprovalLiveActivity = z.infer<typeof ApprovalLiveActivity>;

export const LiveActivity = z.discriminatedUnion('kind', [RunLiveActivity, ApprovalLiveActivity]);
export type LiveActivity = z.infer<typeof LiveActivity>;

/** Buttons a live activity offers (Android notification actions; iOS widget links). */
export const LiveActivityAction = z.enum(['approve', 'details', 'open_run']);
export type LiveActivityAction = z.infer<typeof LiveActivityAction>;

/** Everything a live activity shows. Android renders it as a notification, iOS as the widget's content state. */
export const LiveActivityDisplay = z.object({
  /** `liveActivityRef()`: one activity per run / approval, whichever path updates it. */
  key: z.string().min(1),
  kind: LiveActivityKind,
  /** Run or approval number: the deep link (`whombat://runs/1907`, `whombat://approvals/12`). */
  number: z.number().int().positive(),
  /** `RUN · LIVE`, `NEEDS A PERSON`, `APPROVED · DEPLOYING`, `DEPLOYED` (the cards' labels). */
  label: z.string().max(80),
  tone: Tone,
  /** Run title or the approval's question. */
  title: z.string().max(200),
  /** `Banjo · Now: Run the billing test suite · 38 of 41 passing`, `Neo · 2 of 3 conditions met`. */
  text: z.string().max(300),
  /** 0–100: the run's progress, or the share of conditions met. */
  progress: z.number().int().min(0).max(100),
  /** Progress drawn in this many segments (an approval's conditions); 1 for a run. */
  segments: z.number().int().min(1).max(12),
  /** Status-bar chip while ongoing (`62%`, `2/3`); null once ended. */
  chip: z.string().max(7).nullable(),
  /** False once the run or approval is over: the activity shows this last state and can be dismissed. */
  ongoing: z.boolean(),
  actions: z.array(LiveActivityAction).max(3),
});
export type LiveActivityDisplay = z.infer<typeof LiveActivityDisplay>;

/** The content-state data push: what the mobile client shows the activity as, and how. */
export const LiveActivityPush = z.object({
  event: LiveActivityEventType,
  activity: LiveActivity,
  /** What to show (`runLiveActivity` / `approvalLiveActivity`); native code renders it as is. */
  display: LiveActivityDisplay,
});
export type LiveActivityPush = z.infer<typeof LiveActivityPush>;

/** `LiveActivity` id used to key throttling and the `live_activities` device registration table. */
export function liveActivityRef(activity: LiveActivity): string {
  return activity.kind === 'run' ? `run:${activity.runId}` : `approval:${activity.approvalId}`;
}
