/**
 * Turns an agent schedules for itself (Whombat resourceful-agents.md RA-30, contracts 0.44.0). Pure: the schedule, its
 * `when`, the next run (`nextScheduleRun`, the automations' cron, zone and DST rules), the limits, the room card and
 * copy.
 *
 * An agent makes one with the `schedule` MCP tool in a turn: it runs in that conversation and thread, for the person
 * the creating turn was for (their keys and Vault passes, as any of their turns), as a dispatch with trigger
 * `schedule` (`DispatchContext.schedule`). Active at once; at most `SCHEDULES_ACTIVE_MAX` active per agent; a repeating
 * one ends after `SCHEDULE_REPEAT_DAYS` unless renewed; it ends when that person leaves the burrow. People see an
 * agent's schedules on its page (Pause, Resume, Remove) and a `schedule` card in the room when one is made (Cancel).
 * Automations (BP-C) are unchanged: a person publishes those.
 */
import { z } from 'zod';
import { checkSchedule, cronWords, nextFireAfter, ScheduleError } from '../automations/schedule.js';
import { AgentScheduleId, ConversationId, MessageId, PrincipalId, RunId } from '../ids.js';
import { type DateInput, formatClock, formatDate, formatWeekday, toDate } from '../text/time.js';
import { Count, Timestamp } from './common.js';

/** A scheduled turn's prompt, in characters (RA-30). */
export const SCHEDULE_PROMPT_MAX = 2000;
/** Active schedules per agent (RA-30). */
export const SCHEDULES_ACTIVE_MAX = 20;
/** A repeating schedule ends this many days after it was made or renewed (RA-30). */
export const SCHEDULE_REPEAT_DAYS = 90;
/** The shortest interval, in minutes (RA-30); a cron schedule may not run more often either. */
export const SCHEDULE_EVERY_MIN_MINUTES = 5;
/** The longest interval: a year. */
export const SCHEDULE_EVERY_MAX_MINUTES = 525_600;
/** How far ahead a one-off may be: a year. */
export const SCHEDULE_AT_MAX_DAYS = 366;

/**
 * When a schedule runs (RA-30): `at` once (an instant with its offset), `every` N minutes from when it was made, or a
 * five-field `cron` expression read in an IANA `zone` (DST: a skipped time runs shifted, a repeated one once).
 */
export const ScheduleWhen = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('at'),
    at: Timestamp.describe('When, with its offset: 2026-10-04T09:00:00+02:00'),
  }),
  z.object({
    kind: z.literal('every'),
    minutes: z.number().int().min(SCHEDULE_EVERY_MIN_MINUTES).max(SCHEDULE_EVERY_MAX_MINUTES),
  }),
  z.object({
    kind: z.literal('cron'),
    expr: z
      .string()
      .trim()
      .min(9)
      .max(120)
      .describe('Five fields: minute hour day-of-month month day-of-week'),
    zone: z.string().trim().min(1).max(64).describe('IANA time zone, like Europe/Amsterdam'),
  }),
]);
export type ScheduleWhen = z.infer<typeof ScheduleWhen>;

/** `active` runs; `paused` doesn't until a person resumes it; `ended` never runs again. */
export const SCHEDULE_STATUSES = ['active', 'paused', 'ended'] as const;
export const ScheduleStatus = z.enum(SCHEDULE_STATUSES);
export type ScheduleStatus = z.infer<typeof ScheduleStatus>;

/**
 * Why a schedule ended: `done` (a one-off ran), `cancelled` (the agent or a person cancelled or removed it),
 * `expired` (a repeating one ran out its days; Resume renews it). `person_left` went in 3.0 (CT-1587): nobody leaves.
 */
export const SCHEDULE_END_REASONS = ['done', 'cancelled', 'expired'] as const;
export const ScheduleEndReason = z.enum(SCHEDULE_END_REASONS);
export type ScheduleEndReason = z.infer<typeof ScheduleEndReason>;

/** A schedule as stored and as the runtime and the agent's page read it (RA-30). */
export const AgentSchedule = z.object({
  id: AgentScheduleId,
  agentId: PrincipalId,
  /** Where its turns run and post: the conversation and thread of the turn that made it. */
  conversationId: ConversationId,
  threadRootId: MessageId.nullable(),
  /** What the agent told itself to do, given to every scheduled turn (`DispatchContext.schedule.prompt`). */
  prompt: z.string().min(1).max(SCHEDULE_PROMPT_MAX),
  when: ScheduleWhen,
  status: ScheduleStatus,
  /** Set once it ended. */
  endedReason: ScheduleEndReason.nullable().default(null),
  /** The next run; null while paused or ended. */
  nextAt: Timestamp.nullable(),
  /** When a repeating schedule ends (made or renewed + 90 days); null for a one-off. */
  endsAt: Timestamp.nullable(),
  /** Turns it started so far. */
  runs: Count,
  lastRunAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type AgentSchedule = z.infer<typeof AgentSchedule>;

/**
 * A schedule as the person sees it (the agent's Schedules tab, the room card). Since 3.0 (CT-1587) every one is theirs:
 * `forName`, `canChange` and the private schedule's null `prompt` went.
 */
export const AgentScheduleView = AgentSchedule;
export type AgentScheduleView = z.infer<typeof AgentScheduleView>;

const MINUTE = 60_000;
const DAY = 86_400_000;
const DST = { skipped: 'shift', repeated: 'once' } as const;

/**
 * The first run strictly after `after`, as an ISO instant, or null when there is none (a one-off already past, a cron
 * that never runs again, a zone this runtime doesn't know). `every` counts from `anchor` (when the schedule was made or
 * resumed; default `after`): the first run is `anchor` + the interval. Cron reads its own `zone` with the automations'
 * DST rules (`nextFireAfter`: a skipped local time runs shifted, a repeated one once).
 */
export function nextScheduleRun(
  when: ScheduleWhen,
  after: DateInput,
  options: { anchor?: DateInput } = {},
): string | null {
  const t = toDate(after).getTime();
  if (when.kind === 'at') {
    const at = toDate(when.at).getTime();
    return at > t ? new Date(at).toISOString() : null;
  }
  const anchor = options.anchor === undefined ? t : toDate(options.anchor).getTime();
  try {
    const next =
      when.kind === 'every'
        ? nextFireAfter({ kind: 'interval', everyMinutes: when.minutes }, t, {
            timeZone: 'UTC',
            dst: DST,
            anchor,
          })
        : nextFireAfter({ kind: 'cron', expr: when.expr }, t, { timeZone: when.zone, dst: DST, anchor: t });
    return next === null ? null : new Date(next).toISOString();
  } catch {
    return null;
  }
}

/** When a schedule made (or renewed) at `from` ends: 90 days later for a repeating one, null for a one-off. */
export function scheduleEndsAt(when: ScheduleWhen, from: DateInput): string | null {
  return when.kind === 'at'
    ? null
    : new Date(toDate(from).getTime() + SCHEDULE_REPEAT_DAYS * DAY).toISOString();
}

/**
 * Why a `when` can't be scheduled now, or null: a one-off in the past or more than a year ahead; a cron expression or
 * zone that doesn't parse, never runs, or runs more often than every 5 minutes.
 */
export function scheduleWhenProblem(when: ScheduleWhen, now: DateInput): string | null {
  const t = toDate(now).getTime();
  if (when.kind === 'at') {
    const at = toDate(when.at).getTime();
    if (at <= t) return 'That time has passed. Pick a time in the future.';
    if (at - t > SCHEDULE_AT_MAX_DAYS * DAY) return 'That is more than a year ahead.';
    return null;
  }
  if (when.kind === 'every') return null;
  try {
    checkSchedule({ kind: 'cron', expr: when.expr }, when.zone, t);
  } catch (e) {
    return e instanceof ScheduleError ? e.message : 'That schedule isn’t valid.';
  }
  let prev = nextFireAfter({ kind: 'cron', expr: when.expr }, t, {
    timeZone: when.zone,
    dst: DST,
    anchor: t,
  });
  for (let i = 0; prev !== null && i < 24; i++) {
    const next = nextFireAfter({ kind: 'cron', expr: when.expr }, prev, {
      timeZone: when.zone,
      dst: DST,
      anchor: t,
    });
    if (next === null) break;
    if (next - prev < SCHEDULE_EVERY_MIN_MINUTES * MINUTE)
      return `It may run at most every ${SCHEDULE_EVERY_MIN_MINUTES} minutes.`;
    prev = next;
  }
  return null;
}

/**
 * Why the agent can't make another schedule, or null: it has `SCHEDULES_ACTIVE_MAX` active ones (pause or end one, or
 * make the new one replace an old one).
 */
export function scheduleLimitProblem(activeCount: number): string | null {
  return activeCount >= SCHEDULES_ACTIVE_MAX
    ? `You have ${SCHEDULES_ACTIVE_MAX} active schedules, the most you can keep. Cancel one first.`
    : null;
}

/**
 * When a schedule runs, as people read it: “Once, Sat 4 Oct at 09:00” (in `timeZone`), “Every 30 minutes”, “Every
 * weekday at 09:00”, “Every Friday at 16:00 (New York time)” when its zone isn't `timeZone`, “On its own schedule” for a
 * cron expression words can't say. Never the expression itself.
 */
export function describeScheduleWhen(when: ScheduleWhen, timeZone: string, now?: DateInput): string {
  if (when.kind === 'at') {
    const day = `${formatWeekday(when.at, timeZone).slice(0, 3)} ${formatDate(when.at, timeZone, now === undefined ? {} : { now })}`;
    return `Once, ${day} at ${formatClock(when.at, timeZone)}`;
  }
  if (when.kind === 'every') {
    const m = when.minutes;
    if (m % 1440 === 0) return m === 1440 ? 'Every day' : `Every ${m / 1440} days`;
    if (m % 60 === 0) return m === 60 ? 'Every hour' : `Every ${m / 60} hours`;
    return `Every ${m} minutes`;
  }
  const words = cronWords(when.expr) ?? 'On its own schedule';
  // The Whombat's own time zone goes without saying; another one is named by its city.
  return when.zone === timeZone ? words : `${words} (${zoneWords(when.zone)} time)`;
}

/** A time zone as people know it: `America/New_York` → “New York”, `UTC` stays. */
function zoneWords(zone: string): string {
  return (zone.split('/').pop() ?? zone).replace(/_/g, ' ');
}

/** The first line of a prompt, at most `max` characters (“…” when cut): what a card and a list show of it. */
export function schedulePromptLine(prompt: string, max = 80): string {
  const line = (prompt.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/* The room card (RA-30) --------------------------------------------------------------------------------------- */

/** The card a new schedule posts in its room: server-made (`schedule` null: not resolved yet, or gone). */
export const ScheduleCard = z.object({
  kind: z.literal('schedule'),
  scheduleId: AgentScheduleId,
  schedule: AgentScheduleView.nullable().default(null),
  /**
   * The run the agent scheduled it from (CT-261): a chat shows it inside that run's line rather than as a message of
   * its own. Null or absent (scheduled outside a run): on its own.
   */
  runId: RunId.nullable().optional(),
});
export type ScheduleCard = z.infer<typeof ScheduleCard>;

/** Storage form: by reference, resolved on read. */
export const StoredScheduleCard = z.object({
  kind: z.literal('schedule'),
  scheduleId: AgentScheduleId,
  runId: RunId.nullable().optional(),
});
export type StoredScheduleCard = z.infer<typeof StoredScheduleCard>;

/** The card's title: “Neo scheduled: Check the deploy finished”. */
export function scheduleCardTitle(
  agentName: string,
  schedule: Pick<AgentScheduleView, 'prompt'> | null,
): string {
  return schedule?.prompt
    ? `${agentName} scheduled: ${schedulePromptLine(schedule.prompt)}`
    : `${agentName} scheduled a task`;
}

/** The card as text (inbox, search, other agents' windows): when and the status, never the prompt. */
export function scheduleCardText(card: Pick<ScheduleCard, 'schedule'>, timeZone: string): string {
  if (!card.schedule) return '[schedule]';
  return `[schedule: ${describeScheduleWhen(card.schedule.when, timeZone)}; ${SCHEDULE_STATUS_LABELS[card.schedule.status].toLowerCase()}]`;
}

/** Status labels (the Schedules tab, the card). */
export const SCHEDULE_STATUS_LABELS: Readonly<Record<ScheduleStatus, string>> = {
  active: 'Active',
  paused: 'Paused',
  ended: 'Ended',
};

/** Why it ended, as the card and the tab say it. */
export const SCHEDULE_END_LABELS: Readonly<Record<ScheduleEndReason, string>> = {
  done: 'Done',
  cancelled: 'Cancelled',
  expired: 'Ran its 90 days',
};

/** The Schedules tab and the card. `{agent}` is the agent's name (`scheduleCopy` fills it in). */
export const SCHEDULE_COPY = {
  tab: 'Schedules',
  title: 'SCHEDULES',
  intro: 'Reminders and checks {agent} set for itself.',
  empty: '{agent} hasn’t scheduled anything.',
  next: 'Next',
  ends: 'Stops',
  runs: 'Times run',
  pause: 'Pause',
  resume: 'Resume',
  remove: 'Remove',
  removeConfirm: 'Remove this schedule? {agent} won’t run it again.',
  cancel: 'Cancel',
  cancelled: 'Cancelled. {agent} won’t run it again.',
} as const;

/** `SCHEDULE_COPY` with the agent's name filled in. */
export function scheduleCopy(agentName: string): { -readonly [K in keyof typeof SCHEDULE_COPY]: string } {
  return Object.fromEntries(
    Object.entries(SCHEDULE_COPY).map(([k, v]) => [k, v.replaceAll('{agent}', agentName)]),
  ) as { -readonly [K in keyof typeof SCHEDULE_COPY]: string };
}

/** Which buttons a schedule offers a viewer who may change it: Pause while active, Resume while paused or expired. */
export function scheduleActions(schedule: Pick<AgentSchedule, 'status' | 'endedReason'>): {
  pause: boolean;
  resume: boolean;
  remove: boolean;
} {
  return {
    pause: schedule.status === 'active',
    resume:
      schedule.status === 'paused' || (schedule.status === 'ended' && schedule.endedReason === 'expired'),
    remove: schedule.status !== 'ended',
  };
}
