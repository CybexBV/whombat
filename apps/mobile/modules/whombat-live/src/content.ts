/**
 * The app side of live activities, pure (unit-tested): which runs and approvals the viewer sees as a live
 * activity — the same audiences the server pushes to — what to show or dismiss after reconnecting, and the native
 * accent colors from the tokens. The copy itself is `@whombat/core`'s `runLiveActivity` / `approvalLiveActivity`, so a
 * realtime update and a push render the same notification.
 */
import {
  type Approval,
  approvalLiveActivity,
  approvalLiveActivityAudience,
  type LiveActivityState,
  type Run,
  runLiveActivity,
  runLiveActivityAudience,
} from '@whombat/core';
import { fixedColors, statusColors, themeColors } from '@whombat/tokens';

/** Accent colors by tone for the native side (Android notification color, progress segments). */
export interface LiveColors {
  ok: string;
  warn: string;
  bad: string;
  neutral: string;
}

/** Run progress green, the waiting dot's amber, `bad`, the idle dot's grey (README fixed colors). */
export const LIVE_COLORS: LiveColors = {
  ok: fixedColors.progress,
  warn: statusColors.waiting,
  bad: themeColors.light.bad,
  neutral: statusColors.idle,
};

/** An activity on screen, by key (`run:<id>`, `approval:<id>`) and burrow slug. */
export interface ActiveActivity {
  key: string;
  burrow: string;
}

/**
 * A notification in the shade the app may cancel once it is read (MN-04): `tag` goes back to `cancel`. A self-hosted
 * inbox push carries its `burrow`, `notificationId` and `path`; a managed push its opaque `ref` (resolved through the
 * session). `postedAt` is epoch ms (the phone's clock).
 */
export interface ShadeNotification {
  tag: string;
  postedAt: number;
  kind?: string;
  burrow?: string;
  notificationId?: string;
  path?: string;
  ref?: string;
}

/**
 * The low-priority channel of runs in progress (`LiveNotifications.CHANNEL_RUNS`): turned off, it is usually on purpose,
 * and the rest still arrives.
 */
export const RUNS_CHANNEL = 'whombat.runs';

/** One of Whombat's Android notification channels: its id, the name Android shows, and whether it is turned off. */
export interface DeliveryChannel {
  id: string;
  name: string;
  blocked: boolean;
}

/**
 * Android: what lets Whombat's notifications through beyond the app-wide permission. Null where Android has no such
 * thing (an older version).
 */
export interface DeliveryStatus {
  /** The app-wide switch (Android 8 to 12 leave the channels as they were when it is off). */
  enabled: boolean | null;
  /** In the order they matter: needs you, mentions and updates, runs. */
  channels: DeliveryChannel[];
  /** The person restricted the app's battery use: its pushes don't arrive in the background. */
  backgroundRestricted: boolean | null;
  /** Android's default battery optimisation (most apps have it). */
  batteryOptimized: boolean | null;
  /** Android 16 QPR1+: runs and approvals may show as Live Updates. */
  liveUpdatesAllowed: boolean | null;
}

/** A settings page that turns one of those back on. */
export type DeliveryPage =
  | { page: 'channel'; channel: string }
  | { page: 'notifications' }
  | { page: 'liveUpdates' }
  | { page: 'battery' };

/** Who is looking, from the burrow's bootstrap. */
export interface LiveViewer {
  id: string;
  kindOf(principalId: string): 'person' | 'agent' | undefined;
  /** Short name ("Banjo"). */
  nameOf(principalId: string): string;
  /** The conversation is in the viewer's sidebar. */
  inConversation(conversationId: string): boolean;
}

/** A run's live activity when the viewer asked for it, or follows its conversation and an agent asked. */
export function runLiveFor(run: Run, viewer: LiveViewer, locale?: string): LiveActivityState | null {
  const audience = runLiveActivityAudience({
    askedById: run.askedById,
    askedByAgent: viewer.kindOf(run.askedById) === 'agent',
    conversationPeople: viewer.inConversation(run.conversationId) ? [viewer.id] : [],
  });
  if (!audience.includes(viewer.id)) return null;
  return runLiveActivity(run, viewer.nameOf(run.agentId), locale);
}

/** An approval's live activity when the viewer is one of the people who can say yes. */
export function approvalLiveFor(
  approval: Approval,
  viewer: LiveViewer,
  locale?: string,
): LiveActivityState | null {
  if (!approvalLiveActivityAudience(approval).includes(viewer.id)) return null;
  return approvalLiveActivity(approval, viewer.nameOf(approval.requesterId), locale);
}

/**
 * After (re)loading — and on every push and on coming back to the foreground (MN-02): ongoing activities on screen are
 * shown again (fresh state, and their 10-minute timeout starts again), new ones are shown, and one shown lately that
 * isn't on screen any more (`recent`: it timed out or was swiped away) is left until its run or approval changes;
 * on-screen activities of this burrow that ended while the app was away show their last state (`finish`), and those
 * that are gone from the lists are dismissed (`end`).
 */
export function reconcileActivities(
  onScreen: readonly ActiveActivity[],
  current: readonly LiveActivityState[],
  burrow: string,
  recent: ReadonlySet<string> = new Set(),
): { show: LiveActivityState[]; finish: LiveActivityState[]; end: string[] } {
  const here = new Set(onScreen.filter((a) => a.burrow === burrow).map((a) => a.key));
  const visible = new Set(onScreen.map((a) => a.key));
  const show = current.filter((s) => !s.ended && (visible.has(s.display.key) || !recent.has(s.display.key)));
  const finish = current.filter((s) => s.ended && here.has(s.display.key));
  const known = new Set(current.map((s) => s.display.key));
  const end = [...here].filter((key) => !known.has(key));
  return { show, finish, end };
}
