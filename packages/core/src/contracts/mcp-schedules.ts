/**
 * The `schedule` MCP tool (Whombat resourceful-agents.md RA-30, contracts 0.44.0): an agent schedules its own turns.
 * Spread into `MCP_TOOLS` (`./mcp`); no key.
 *
 * - `create` (`when`, `prompt`): active at once, in this conversation and thread, for the person this turn is for. The
 *   server checks `scheduleWhenProblem`, `SCHEDULES_ACTIVE_MAX` and the prompt, posts the `schedule` card in the room and
 *   answers `ok` with it; `invalid` with the problems otherwise. A turn that isn't for a person (a system turn without
 *   one, a Feedback assessment, a search answer) answers `unavailable`.
 * - `list`: the agent's active and paused schedules this turn may see — those in this conversation and those for the
 *   person this turn is for; the rest are only counted (`others`), so one person's reminders never reach another's turn.
 * - `cancel` (`scheduleId`): ends one of the listed ones (`cancelled`).
 */
import { z } from 'zod';
import { Count, Timestamp } from '../domain/common.js';
import { SCHEDULE_PROMPT_MAX, ScheduleStatus, ScheduleWhen } from '../domain/schedules.js';
import { AgentScheduleId, ConversationId, MessageId } from '../ids.js';
import type { McpTool } from './mcp.js';

export const SCHEDULE_TOOL_ACTIONS = ['create', 'list', 'cancel'] as const;

/** What `schedule` takes: `create` needs `when` and `prompt`, `cancel` needs `scheduleId`. */
export const ScheduleToolInput = z
  .object({
    action: z.enum(SCHEDULE_TOOL_ACTIONS),
    when: ScheduleWhen.optional().describe(
      'create: {kind: "at", at: ISO time with offset} once, {kind: "every", minutes} (5 or more), or {kind: "cron", expr, zone}',
    ),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(SCHEDULE_PROMPT_MAX)
      .optional()
      .describe('create: what to do in that turn, written to yourself, with what you need to know then'),
    scheduleId: AgentScheduleId.optional().describe('cancel: which one (from list)'),
  })
  .superRefine((input, ctx) => {
    if (input.action === 'create' && !input.when)
      ctx.addIssue({ code: 'custom', path: ['when'], message: 'Say when.' });
    if (input.action === 'create' && !input.prompt)
      ctx.addIssue({ code: 'custom', path: ['prompt'], message: 'Say what to do then.' });
    if (input.action === 'cancel' && !input.scheduleId)
      ctx.addIssue({ code: 'custom', path: ['scheduleId'], message: 'Say which schedule.' });
  });
export type ScheduleToolInput = z.input<typeof ScheduleToolInput>;

/** A schedule as the agent sees it in `schedule`'s answers. */
export const ScheduleToolItem = z.object({
  id: AgentScheduleId,
  when: ScheduleWhen,
  /** “Every day at 09:00 · Europe/Amsterdam” (`describeScheduleWhen`). */
  description: z.string(),
  prompt: z.string(),
  status: ScheduleStatus,
  nextAt: Timestamp.nullable(),
  endsAt: Timestamp.nullable(),
  runs: Count,
  conversationId: ConversationId,
  threadRootId: MessageId.nullable(),
});
export type ScheduleToolItem = z.infer<typeof ScheduleToolItem>;

/**
 * `schedule`'s answer: `ok` with the schedule made or cancelled (null for `list`) and the agent's schedules this turn may
 * see, plus how many others it has; `invalid` with what to fix; `unavailable` when this turn can't schedule.
 */
export const ScheduleToolOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    schedule: ScheduleToolItem.nullable(),
    schedules: z.array(ScheduleToolItem),
    others: Count,
  }),
  z.object({ status: z.literal('invalid'), problems: z.array(z.string()).min(1).max(10) }),
  z.object({ status: z.literal('unavailable'), message: z.string() }),
]);
export type ScheduleToolOutput = z.infer<typeof ScheduleToolOutput>;

function scheduleTool<I extends z.ZodObject, O extends z.ZodType>(def: McpTool<I, O>): McpTool<I, O> {
  return def;
}

export const SCHEDULE_MCP_TOOLS = {
  schedule: scheduleTool({
    name: 'schedule',
    title: 'Schedule a turn',
    description:
      'Schedule a turn of your own, here and for the person this turn is for: a reminder, a check later (“see whether the deploy finished in 30 minutes”), a monitor or a weekly summary. action "create" with when ({kind: "at", at} once, {kind: "every", minutes} 5 or more, or {kind: "cron", expr, zone}) and prompt (what to do then, with what you will need to know); it is active at once and people see a card with Cancel. action "list" shows yours; "cancel" ends one. A scheduled turn can’t wait for answers: it does what it can, posts what it found and asks once when it needs a person. At most 20 active; a repeating one ends after 90 days.',
    input: ScheduleToolInput,
    output: ScheduleToolOutput,
    requiredKey: null,
    readOnly: false,
  }),
} as const;
