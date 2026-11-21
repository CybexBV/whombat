/**
 * An agent's schedules on the web (Whombat resourceful-agents.md RA-30; contracts 0.44 CT-246…; AP-683, AP-684): the
 * pure parts of the room card (the list is in Automations). Core holds the words (`SCHEDULE_COPY`, `SCHEDULE_STATUS_LABELS`,
 * `SCHEDULE_END_LABELS`, `describeScheduleWhen`, `scheduleCardTitle`, `schedulePromptLine`) and the rules
 * (`scheduleActions`); the few it leaves to the clients are `@whombat/client`'s, and the dot is the web's.
 */
import type { ScheduleStatus } from '@whombat/core';
import type { DotTone } from '../../components/StatusDot';

/** The status's dot: active ok, paused waiting, ended quiet. */
export const SCHEDULE_TONES: Readonly<Record<ScheduleStatus, DotTone>> = {
  active: 'ok',
  paused: 'warn',
  ended: 'mut',
};
