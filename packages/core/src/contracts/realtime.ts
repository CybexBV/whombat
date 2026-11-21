/**
 * Realtime events: the topics a session subscribes to and the `RealtimeEvent`s its `event` messages carry
 * (`@whombat/protocol/session`, `subscribe` → `event`). `@whombat/client` reduces events into the query cache.
 */
import { z } from 'zod';
import { Activity } from '../domain/activity.js';
import { Approval } from '../domain/approval.js';
import { AuditEvent } from '../domain/audit.js';
import { Automation, AutomationId, AutomationRun } from '../domain/automation.js';
import { Burrow } from '../domain/burrow.js';
import { Canvas, CanvasComment } from '../domain/canvas.js';
import { ChatRuntime } from '../domain/chat-runtime.js';
import { Count, Timestamp } from '../domain/common.js';
import { ChatRoom, Conversation, NotifyLevel, ThreadPlace, ThreadSettle } from '../domain/conversation.js';
import { Deployment } from '../domain/deployment.js';
import { Grant } from '../domain/grant.js';
import { HANDOFFS_MAX, Handoff } from '../domain/handoff.js';
import { HomePart } from '../domain/home.js';
import {
  HostAlert,
  HostGuestState,
  HostInstallState,
  HostRepointState,
  HostServer,
} from '../domain/hosts.js';
import { Message } from '../domain/message.js';
import { Plan } from '../domain/plan.js';
import { Agent, Person, Principal } from '../domain/principal.js';
import { PullRequest } from '../domain/repo.js';
import { Run, RunLogLine } from '../domain/run.js';
import { SearchAnswer } from '../domain/search.js';
import { SubscriptionUsage } from '../domain/usage.js';
import { DispatchSummary } from '../domain/work.js';
import {
  BackupFileId,
  BackupRestoreId,
  ConnectionId,
  ConversationId,
  DispatchId,
  MessageId,
  NotificationId,
  PrincipalId,
  RunId,
  VaultEntryId,
  WidgetId,
} from '../ids.js';
import { InboxItem } from './notifications.js';

/* Topics ----------------------------------------------------------------------------------------- */

/**
 * `hosts` (0.80, CT-339): a burrow's server events (`hosts.*`), on their own topic so the frequent updates reach only
 * clients that show servers.
 */
export const TOPIC_KINDS = ['burrow', 'conv', 'run', 'me', 'canvas', 'hosts'] as const;
export type TopicKind = (typeof TOPIC_KINDS)[number];

/**
 * `burrow:<burrowId>`, `conv:<conversationId>`, `run:<runId>`, `me:<principalId>`, `canvas:<canvasId>`,
 * `hosts:<burrowId>`.
 */
export const Topic = z.string().regex(/^(burrow|conv|run|me|canvas|hosts):[A-Za-z0-9_-]{1,80}$/);
export type Topic = z.infer<typeof Topic>;

export const topics = {
  burrow: (burrowId: string) => `burrow:${burrowId}`,
  conversation: (conversationId: string) => `conv:${conversationId}`,
  run: (runId: string) => `run:${runId}`,
  me: (principalId: string) => `me:${principalId}`,
  canvas: (canvasId: string) => `canvas:${canvasId}`,
  hosts: (burrowId: string) => `hosts:${burrowId}`,
} as const;

export function parseTopic(topic: string): { kind: TopicKind; id: string } | null {
  const m = /^(burrow|conv|run|me|canvas|hosts):([A-Za-z0-9_-]{1,80})$/.exec(topic);
  return m ? { kind: m[1] as TopicKind, id: m[2] as string } : null;
}

/* Events ----------------------------------------------------------------------------------------- */

const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...shape });

/** The most notification ids one `notification.read` event names (0.55, CT-300). */
export const NOTIFICATION_READ_IDS_MAX = 200;

export const RealtimeEvent = z.discriminatedUnion('type', [
  /** New message or thread reply (topic `conv`). */
  ev('message.created', { message: Message }),
  /** Reactions, card refresh, reply count (topic `conv`). */
  ev('message.updated', { message: Message }),
  ev('message.deleted', { conversationId: ConversationId, messageId: MessageId }),
  /**
   * "{name} is thinking"; `active: false` clears it (topic `conv`). Since 3.0 (CT-1515) only the agent's: people's
   * typing and its `mode` went with presence.
   */
  ev('typing', {
    conversationId: ConversationId,
    threadRootId: MessageId.nullable(),
    principalId: PrincipalId,
    active: z.boolean(),
    expiresAt: Timestamp,
    /** The agent's turn that thinks (0.55, CT-295): what “Stop” on the thinking line cancels (`dispatches.cancel`). */
    dispatchId: DispatchId.nullable().optional(),
  }),
  /** Run card, run page header/steps/tests/diff, sidebar status (topics `run` and `burrow`). */
  ev('run.updated', { run: Run }),
  /** New log lines (topic `run`). */
  ev('run.log', { runId: RunId, runNumber: z.number().int().positive(), lines: z.array(RunLogLine) }),
  /** Approval card, modal, branch pane, inbox (topic `burrow`). */
  ev('approval.updated', { approval: Approval }),
  /** Plan card and canvas plan block (topic `burrow`). */
  ev('plan.updated', { plan: Plan }),
  /** Status dot, RIGHT NOW, Settings → Agent (topic `burrow`). */
  ev('agent.updated', { agent: Agent }),
  /** Keys changed (topic `burrow`). */
  ev('grants.updated', { agentId: PrincipalId, grants: z.array(Grant) }),
  /** A new principal (topic `burrow`): the person at the claim, a system signer. */
  ev('principal.created', { principal: Principal }),
  /** The person changed their name, title or photo (topic `burrow`). */
  ev('person.updated', { person: Person }),
  /** Topic and actions (topic `burrow` for branch rooms, `me` for the person's rooms). */
  ev('conversation.updated', { conversation: Conversation }),
  /** The viewer's own notification level for a conversation changed, on another device too (topic `me`, 0.26). */
  ev('conversation.notify', { conversationId: ConversationId, notify: NotifyLevel }),
  /** Viewer's unread badge (topic `me`). */
  ev('conversation.unread', { conversationId: ConversationId, unread: Count, mentions: Count }),
  /** New signed event in the log (topic `burrow`). */
  ev('audit.appended', { event: AuditEvent }),
  /** Checks, reviews, status (topic `burrow`). */
  ev('pr.updated', { pr: PullRequest }),
  /** Inbox row and push (topic `me`). */
  ev('notification.created', { item: InboxItem }),
  /** Agent answer ready (topic `me`). */
  ev('search.answer', { answer: SearchAnswer }),
  /** Canvas metadata (topic `canvas`). */
  ev('canvas.updated', { canvas: Canvas }),
  /** Side comment added or resolved (topic `canvas`). */
  ev('canvas.comment', { comment: CanvasComment }),
  /** Burrow renamed etc. (topic `burrow`). */
  ev('burrow.updated', { burrow: Burrow }),
  /** An automation's definition, status or last run (topic `burrow`; docs/decisions/bp-automations.md). */
  ev('automation.updated', { automation: Automation }),
  /** An automation was deleted (topic `burrow`; 0.66, `automations.delete`): drop it from lists. */
  ev('automation.deleted', { automationId: AutomationId }),
  /** An automation run and its steps (topic `burrow`). */
  ev('automation.run.updated', { run: AutomationRun }),
  /** An observed activity row, created or updated (topics `conv` and `run`; work-supervision WS-12, WS-16). */
  ev('activity.updated', { activity: Activity }),
  /** A turn queued, started, finished, failed or was cancelled (topic `conv`; WS-19). */
  ev('dispatch.updated', { dispatch: DispatchSummary }),
  /**
   * One of the person's Vault entries changed: fields, secret, check, tools, keys, a use (topic `me`;
   * docs/decisions/vault.md). `null`: refetch the whole Vault (several entries, or the home network
   * list). Carries no entry data: the client refetches `vault.get` / `vault.list`.
   */
  ev('vault.updated', { entryId: VaultEntryId.nullable() }),
  /**
   * A subscription's usage snapshot changed (CT-154): a probe or a turn read it. Topic `me`.
   */
  ev('usage.updated', { usage: SubscriptionUsage }),
  /**
   * A conversation's Files changed: a file saved, renamed, moved or removed, or a message with files sent or deleted
   * (Whombat files-space.md FS-04, 0.49, CT-275). Topic `me`. Carries no file data: the client refetches
   * `files.summary` and, when that conversation's Files are open, `files.list`. Saving a
   * message's file or removing one from Files also sends that message's `message.updated` (`Attachment.inFiles`, 0.59).
   */
  ev('files.changed', { conversationId: ConversationId }),
  /**
   * A deploy was recorded (0.55, CT-296, Whombat RF-02): by an agent's `record_deploy` or a deploy job. Topic `burrow`.
   */
  ev('deployment.recorded', { deployment: Deployment }),
  /**
   * The viewer's notifications were marked read, on this device or another (0.55, CT-300, Whombat RF-05): every
   * mark-read path publishes it (`notifications.markRead`, reading a conversation or a thread, opening a push). `ids`:
   * these (at most `NOTIFICATION_READ_IDS_MAX`; more go in several events); null: every one created up to `before`
   * (`markRead` with `all`). `unread`: the viewer's unread count after it. Topic `me` only.
   */
  ev('notification.read', {
    ids: z.array(NotificationId).max(NOTIFICATION_READ_IDS_MAX).nullable(),
    before: Timestamp.optional(),
    unread: Count.optional(),
  }),
  /**
   * The burrow's AI gateway changed (0.76, CT-332; Whombat ai-gateway.md AIG-11): a poll read other limits, faults or
   * reachability, or a switch changed. Topic `burrow`. Carries no usage: the client refetches `usage.list`.
   */
  ev('usage.gateway_updated', { connectionId: ConnectionId }),
  /**
   * One of the person's backup files or restores changed (0.79, CT-335; Whombat backup-file.md): progress, ready, failed,
   * done. Topic `me` of its maker only. Carries no content: the client refetches `backups.get` / `backups.getRestore`
   * (or `backups.list`). The server sends progress at most once a second.
   */
  ev('backups.changed', {
    kind: z.enum(['file', 'restore']),
    id: z.union([BackupFileId, BackupRestoreId]),
  }),
  /**
   * Parts of the viewer's Home changed (0.80, CT-336): a Needs you item came or went, Working on moved, a thing's status
   * changed, a change was recorded or undone. Topic `me`. Carries no content: the client refetches `home.overview`
   * (and `watch.list` for `watch`). The server sends it at most every 2 seconds per person.
   */
  ev('home.changed', { parts: z.array(HomePart).min(1) }),
  /**
   * A pinned widget got new points (0.80, CT-336; ONE-09): its owner's `me` topic. The client refetches `widgets.list`
   * or `home.overview`.
   */
  ev('widget.updated', { widgetId: WidgetId }),
  /** A server's row changed: status, load, agent (topic `hosts`, 0.80, CT-339). `server` null: it was removed. */
  ev('hosts.server', { serverId: z.string(), server: HostServer.nullable() }),
  /** A guest's state changed (topic `hosts`). */
  ev('hosts.guest', { serverId: z.string(), guestId: z.string(), state: HostGuestState }),
  /** An alert opened, changed or resolved (topic `hosts`). */
  ev('hosts.alert', { alert: HostAlert }),
  /**
   * An action or a manage task finished (topic `hosts`): `actionId` for `hosts.guestAction`/`serverAction`, `taskId` for
   * a task `hosts.manage` started.
   */
  ev('hosts.task', {
    serverId: z.string(),
    guestId: z.string().nullable(),
    actionId: z.string().optional(),
    taskId: z.string().optional(),
    op: z.string(),
    result: z.enum(['ok', 'warning', 'error']),
    message: z.string().nullable().optional(),
  }),
  /** A server asks to be let in (topic `hosts`; owners refetch `hosts.listEnrollments`). */
  ev('hosts.enrollment', { enrollmentId: z.string(), hostname: z.string().nullable() }),
  /** The hosts service restarted or events were lost: refetch everything of `hosts.*` (topic `hosts`). */
  ev('hosts.resync', {}),
  /**
   * An install job of Sign in once moved on (topic `hosts`, 0.85, CT-376): refetch `hosts.getInstall`. Every member
   * gets the frame; only owners can read the job.
   */
  ev('hosts.install', { installId: z.string(), state: HostInstallState }),
  /**
   * A repoint job moved on (topic `hosts`, 0.117, CT-911; BF-15): refetch `hosts.getRepoint`. Every member gets the
   * frame; only owners can read the job.
   */
  ev('hosts.repoint', { repointId: z.string(), state: HostRepointState }),
  /**
   * A thread of the viewer's Chat got another choice of what answers (0.96, CT-462; Whombat chat-runtime.md CR-02), on
   * this device or another (`chats.setThreadRuntime`, `chats.start` with `runtime`). Topic `me` of the Chat's person
   * only. `runtime` null: the thread follows the assistant's own again.
   */
  ev('chat.thread_runtime', {
    conversationId: ConversationId,
    rootId: MessageId,
    runtime: ChatRuntime.nullable(),
  }),
  /**
   * The viewer cleared their Chat or Feedback room (0.119, CT-991; Whombat chat-clear.md), on this device or another
   * (`chats.clear`): its top-level messages up to `clearedAt` left the room's view, so the room's messages are read
   * again. Its threads are unchanged. Topic `me` of the room's person only.
   */
  ev('chat.cleared', { conversationId: ConversationId, room: ChatRoom, clearedAt: Timestamp }),
  /**
   * A thread of the viewer's Chat or Feedback room settled or opened again (3.8; Whombat chat-settle.md), by them on any
   * device, by itself, or by a new message in it. `rootId` null: several threads changed at once (`chats.settleFinished`,
   * the automatic round), so the room's messages and threads are read again. Topic `me` of the room's person only.
   */
  ev('chat.settled', {
    conversationId: ConversationId,
    room: ChatRoom,
    rootId: MessageId.nullable(),
    settled: ThreadSettle.nullable(),
  }),
  /**
   * A thread of the viewer's Chat moved to Code or back (3.20). Never sent since one Chat (Whombat one-chat.md); goes
   * with the next major.
   */
  ev('chat.placed', { conversationId: ConversationId, rootId: MessageId, place: ThreadPlace }),
  /**
   * The desk screen changed (0.100, CT-527; Whombat desk-display.md DK-02, DK-04): paired or unpaired, its settings, a
   * pairing started or ended, a phone unlock asked or answered. Topic `me`: refetch `desk.get`.
   */
  ev('desk.changed', {}),
  /**
   * Voice typing changed (contracts 3.1; Whombat dictation.md): its settings, or a speech model's download (at most
   * every 2 seconds while one downloads). Topic `me`: refetch `voice.get`.
   */
  ev('voice.changed', {}),
  /**
   * The agent's services changed (3.0, CT-1536; Whombat one-person.md OP-19): one started, stopped, failed or came back
   * after a restart. Topic `burrow`. Carries nothing: the client refetches `services.list`.
   */
  ev('services.changed', {}),
  /**
   * Work the agent handed over from a conversation moved on (Whombat t3code.md T3-25): started, a new step, a question,
   * a permission it waits for, its end, or the agent's answer after it. Topic `conv`; it carries the conversation's whole
   * list (`conversations.handoffs`), which replaces the one the client has.
   */
  ev('conversation.handoffs', {
    conversationId: ConversationId,
    handoffs: z.array(Handoff).max(HANDOFFS_MAX),
  }),
]);
export type RealtimeEvent = z.infer<typeof RealtimeEvent>;
export type RealtimeEventType = RealtimeEvent['type'];
export type RealtimeEventOf<T extends RealtimeEventType> = Extract<RealtimeEvent, { type: T }>;

/** Which topic kinds carry each event type. */
export const REALTIME_EVENT_TOPICS: Record<RealtimeEventType, readonly TopicKind[]> = {
  'message.created': ['conv'],
  'message.updated': ['conv'],
  'message.deleted': ['conv'],
  typing: ['conv'],
  'run.updated': ['run', 'burrow'],
  'run.log': ['run'],
  'approval.updated': ['burrow'],
  'plan.updated': ['burrow'],
  'agent.updated': ['burrow'],
  'grants.updated': ['burrow'],
  'principal.created': ['burrow'],
  'person.updated': ['burrow'],
  'conversation.updated': ['burrow', 'me'],
  'conversation.notify': ['me'],
  'conversation.unread': ['me'],
  'audit.appended': ['burrow'],
  'pr.updated': ['burrow'],
  'notification.created': ['me'],
  'search.answer': ['me'],
  'canvas.updated': ['canvas'],
  'canvas.comment': ['canvas'],
  'burrow.updated': ['burrow'],
  'automation.updated': ['burrow'],
  'automation.deleted': ['burrow'],
  'automation.run.updated': ['burrow'],
  'activity.updated': ['conv', 'run'],
  'dispatch.updated': ['conv'],
  'vault.updated': ['me'],
  'usage.updated': ['me'],
  'files.changed': ['me'],
  'deployment.recorded': ['burrow'],
  'notification.read': ['me'],
  'usage.gateway_updated': ['burrow'],
  'backups.changed': ['me'],
  'home.changed': ['me'],
  'widget.updated': ['me'],
  'hosts.server': ['hosts'],
  'hosts.guest': ['hosts'],
  'hosts.alert': ['hosts'],
  'hosts.task': ['hosts'],
  'hosts.enrollment': ['hosts'],
  'hosts.resync': ['hosts'],
  'hosts.install': ['hosts'],
  'hosts.repoint': ['hosts'],
  'chat.thread_runtime': ['me'],
  'chat.cleared': ['me'],
  'chat.settled': ['me'],
  'chat.placed': ['me'],
  'desk.changed': ['me'],
  'voice.changed': ['me'],
  'services.changed': ['burrow'],
  'conversation.handoffs': ['conv'],
};

/** How long a typing / thinking indicator lives without a refresh. */
export const TYPING_TTL_MS = 6000;
