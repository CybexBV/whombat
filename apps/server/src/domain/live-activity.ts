/**
 * Live activities (TODO 9.4): a run in progress or a pending approval, kept fresh on mobile — Android as
 * an ongoing notification, iOS as an ActivityKit activity — by data pushes derived from `run.updated` /
 * `approval.updated`. `LiveActivityBroadcaster` is the one place that turns a run/approval into a
 * `start` / `update` / `end` event and throttles updates to one push per activity per `THROTTLE_MS` — the
 * last update inside a window goes out when it closes, so a device never keeps a stale state; `start` and
 * `end` always go through immediately so the activity never misses its beginning or its dismissal. Call sites (`publishRun`, `publishApproval`, `createApproval`) add a `ctx.after()` hook that
 * calls into this after the commit, the same way `notify()` sends push for inbox rows.
 *
 * What an activity shows, when it ends and who sees it are `@whombat/core`'s `runLiveActivity` /
 * `approvalLiveActivity` and their audiences, shared with the app's own realtime updates.
 */
import {
  type Approval,
  approvalLiveActivity,
  approvalLiveActivityAudience,
  isApprovalActivityEnded,
  isRunActivityEnded,
  type LiveActivityEventType,
  type LiveActivityState,
  liveActivityPush,
  type Run,
  runLiveActivity,
  runLiveActivityAudience,
} from '@whombat/core';
import type { Db } from '../db/client';
import { devicesForActivity } from '../push/devices';
import type { PushSender } from '../push/sender';
import { loadPrincipalRow, shortName } from '../read/principals';
import { thePerson } from './the-person';

export const THROTTLE_MS = 2000;

/** The person_approves condition's approver list — who a pending approval's live activity goes to. */
export const approverIdsOf = approvalLiveActivityAudience;

/** Short name of a principal ("Dusty"), for an approval's live activity. */
async function principalName(db: Db, principalId: string): Promise<string> {
  const row = await loadPrincipalRow(db, principalId);
  return row ? shortName(row) : 'Someone';
}

/**
 * Who sees a run's live activity (`runLiveActivityAudience`): the person who asked, or — when an agent
 * asked (a review it asked for) — the person, who reads every conversation.
 */
async function runAudience(db: Db, run: Run): Promise<string[]> {
  const asker = await loadPrincipalRow(db, run.askedById);
  if (!asker || asker.kind === 'person') return [run.askedById];
  const person = await thePerson(db, run.burrowId);
  return runLiveActivityAudience({
    askedById: run.askedById,
    askedByAgent: true,
    conversationPeople: person ? [person.id] : [],
  });
}

/** Database lookups, overridable for tests (the throttling and lifecycle rules need no Postgres). */
export interface LiveActivityLookups {
  devices: typeof devicesForActivity;
  name: (db: Db, principalId: string) => Promise<string>;
  runAudience: (db: Db, run: Run) => Promise<string[]>;
}

/** What to send for one change; the state is built when it is sent (a throttled update, when its window closes). */
interface Pending {
  build: () => Promise<LiveActivityState>;
  recipients: () => Promise<readonly string[]>;
  burrowSlug: string;
}

export class LiveActivityBroadcaster {
  /** ref -> ms of the last event sent (`start`/`update`/`end`, used only to throttle `update`). */
  private readonly lastSent = new Map<string, number>();
  /** refs with an activity currently live on devices (so we know `start` from `update`). */
  private readonly active = new Set<string>();
  /** A throttled update waits here (the latest wins) and goes out when the window closes. */
  private readonly trailing = new Map<string, { pending: Pending; timer: ReturnType<typeof setTimeout> }>();
  private readonly lookups: LiveActivityLookups;

  constructor(
    private readonly db: Db,
    private readonly push: PushSender,
    private readonly clock: () => Date = () => new Date(),
    lookups: Partial<LiveActivityLookups> = {},
  ) {
    this.lookups = { devices: devicesForActivity, name: principalName, runAudience, ...lookups };
  }

  async onRunChanged(run: Run, agentName: string, burrowSlug: string): Promise<void> {
    await this.handle(`run:${run.id}`, isRunActivityEnded(run), {
      build: async () => runLiveActivity(run, agentName),
      recipients: () => this.lookups.runAudience(this.db, run),
      burrowSlug,
    });
  }

  async onApprovalChanged(approval: Approval, burrowSlug: string): Promise<void> {
    await this.handle(`approval:${approval.id}`, isApprovalActivityEnded(approval), {
      // The requester's name is looked up only when something is sent.
      build: async () =>
        approvalLiveActivity(approval, await this.lookups.name(this.db, approval.requesterId)),
      recipients: async () => approverIdsOf(approval),
      burrowSlug,
    });
  }

  private async handle(ref: string, ended: boolean, pending: Pending): Promise<void> {
    const now = this.clock().getTime();
    let event: LiveActivityEventType;
    if (ended) {
      // Nothing to end if it never started on any device (e.g. an approval declined on first sight).
      if (!this.active.has(ref)) return;
      event = 'end';
      this.active.delete(ref);
      this.lastSent.delete(ref);
    } else if (!this.active.has(ref)) {
      event = 'start';
      this.active.add(ref);
      this.lastSent.set(ref, now);
    } else {
      const wait = THROTTLE_MS - (now - (this.lastSent.get(ref) ?? 0));
      if (wait > 0) {
        this.deferUpdate(ref, pending, wait);
        return;
      }
      event = 'update';
      this.lastSent.set(ref, now);
    }
    this.cancelTrailing(ref);
    const state = await pending.build();
    const { activity } = state;
    const refId = activity.kind === 'run' ? activity.runId : activity.approvalId;
    const recipients = await pending.recipients();
    const payload = liveActivityPush(state, event, pending.burrowSlug);
    // Managed: no wake through control (NT-13). A content-free wake can't show progress, only “A run has news” on
    // every start and update; what needs the person (an approval, a question) is its own inbox notification.
    const devices = await this.lookups.devices(this.db, activity.kind, refId, recipients);
    if (devices.length === 0) return;
    await this.push.sendAll(devices, payload);
  }

  /** The latest throttled update goes out when the window closes, so a device never keeps a stale state. */
  private deferUpdate(ref: string, pending: Pending, wait: number): void {
    const existing = this.trailing.get(ref);
    if (existing) {
      existing.pending = pending;
      return;
    }
    const timer = setTimeout(() => {
      const entry = this.trailing.get(ref);
      this.trailing.delete(ref);
      if (entry && this.active.has(ref)) void this.handle(ref, false, entry.pending).catch(() => {});
    }, wait);
    timer.unref?.();
    this.trailing.set(ref, { pending, timer });
  }

  private cancelTrailing(ref: string): void {
    const entry = this.trailing.get(ref);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.trailing.delete(ref);
  }
}
