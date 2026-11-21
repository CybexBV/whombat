/**
 * An agent's schedules on the phone (Whombat resourceful-agents.md RA-30; contracts 0.44 `schedules.*`;
 * mobile-parity.md MQ-01): the Schedules screen as the web's Schedules tab reads — what each does (the prompt's first
 * line), when it runs and its state, NEXT, ENDS and RUNS, and Pause, Resume and Remove (every schedule is yours,
 * one-person-android.md AP-5769). Core holds the words and the rules
 * (`SCHEDULE_COPY`, `describeScheduleWhen`, `scheduleActions`), and the few it leaves to the clients are
 * `@whombat/client`'s. Pure.
 */
import { SCHEDULE_TEXT, scheduleStatusText, scheduleTimeText } from '@whombat/client';
import {
  type AgentScheduleView,
  describeScheduleWhen,
  type ScheduleStatus,
  scheduleActions,
  scheduleCopy,
  schedulePromptLine,
  type Tone,
} from '@whombat/core';

/** The status's dot: active ok, paused waiting, ended quiet. */
export const SCHEDULE_TONES: Readonly<Record<ScheduleStatus, Tone | null>> = {
  active: 'ok',
  paused: 'warn',
  ended: null,
};

export type ScheduleAction = 'pause' | 'resume' | 'remove';

export interface ScheduleRow {
  id: string;
  /** The prompt's first line (120 characters). */
  what: string;
  /** “Weekdays at 08:30 · Europe/Amsterdam · Active”. */
  when: string;
  tone: Tone | null;
  status: ScheduleStatus;
  /** NEXT, ENDS (while not ended), RUNS. */
  facts: { label: string; value: string }[];
  /** The buttons this viewer gets, in order: none unless they may change it. */
  actions: ScheduleAction[];
  accessibilityLabel: string;
}

/** The Schedules screen's rows, in the server's order. */
export function scheduleRows(
  schedules: readonly AgentScheduleView[],
  agentName: string,
  timeZone: string,
  now: Date,
): ScheduleRow[] {
  const copy = scheduleCopy(agentName);
  return schedules.map((s) => {
    const can = scheduleActions(s);
    const what = schedulePromptLine(s.prompt, 120);
    const when = `${describeScheduleWhen(s.when, timeZone, now)} · ${scheduleStatusText(s)}`;
    const facts = [
      ...(s.nextAt ? [{ label: copy.next, value: scheduleTimeText(s.nextAt, timeZone, now) }] : []),
      ...(s.endsAt && s.status !== 'ended'
        ? [{ label: copy.ends, value: scheduleTimeText(s.endsAt, timeZone, now) }]
        : []),
      { label: copy.runs, value: String(s.runs) },
    ];
    const actions = (['pause', 'resume', 'remove'] as const).filter((a) => can[a]);
    return {
      id: s.id,
      what,
      when,
      tone: SCHEDULE_TONES[s.status],
      status: s.status,
      facts,
      actions,
      accessibilityLabel: `${what}. ${when}. ${facts.map((f) => `${f.label} ${f.value}`).join(', ')}`,
    };
  });
}

/** A button's words: Pause, Resume, Remove. */
export function scheduleActionLabel(action: ScheduleAction, agentName: string): string {
  return scheduleCopy(agentName)[action];
}

/** What a change says once it went through. */
export function scheduleDoneText(action: ScheduleAction, agentName: string): string {
  return action === 'pause'
    ? SCHEDULE_TEXT.paused
    : action === 'resume'
      ? SCHEDULE_TEXT.resumed
      : scheduleCopy(agentName).cancelled;
}
