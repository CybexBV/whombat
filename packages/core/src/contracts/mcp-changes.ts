/**
 * `report_change` (Whombat home-redesign.md HR-03; contracts 0.91.0, CT-402), spread into `MCP_TOOLS`: an agent records a
 * change it made outside `connection_call` (over SSH, with one of its commands, a command on a server), so the thing's “Changes
 * here” shows it. One call per change a person would care about, never for a read. With
 * `undo` (private: how to put it back), the change offers Undo for 24 hours: pressing it wakes the agent (trigger `undo_requested`, `DispatchContext.undoRequest`)
 * in the chat the change was reported in, and the agent reports the reversal with `undoes`.
 *
 * Every agent has it, without a key (`requiredKey: null`, like `record_deploy`): it
 * changes nothing outside Whombat and only records what the agent already did with the keys that let it. A key would
 * leave changes made by an agent without it unrecorded, which is what this tool exists to stop.
 *
 * `report_done` (Whombat done-today.md DN-01…DN-04): when the agent finished what was asked in a thread, a few words of
 * what it did (“Checked the status of pve-01”). One per thread, a later one replaces it. The desk's *Done today* and
 * *Welcome back* list these, never the changes themselves. Only in a turn for the person (`personal`).
 */
import { z } from 'zod';
import { ChangeId } from '../ids.js';
import { commitOutcome } from './errors.js';
import type { McpTool } from './mcp.js';

export const REPORT_CHANGE_TITLE_MAX = 160;
export const REPORT_CHANGE_DETAIL_MAX = 300;
export const REPORT_CHANGE_THING_MAX = 220;
export const REPORT_CHANGE_UNDO_MAX = 1000;

export const ReportChangeInput = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(REPORT_CHANGE_TITLE_MAX)
    .describe(
      'What you changed, in plain words as you’d tell the person: “Removed 14 old Zonneplan entities”, “Cleared 2,000 old statistics from Home Assistant”.',
    ),
  detail: z
    .string()
    .trim()
    .max(REPORT_CHANGE_DETAIL_MAX)
    .optional()
    .describe('One more plain sentence when the title needs it. No commands, paths or logs.'),
  thing: z
    .string()
    .trim()
    .min(1)
    .max(REPORT_CHANGE_THING_MAX)
    .optional()
    .describe(
      'What you changed: a server (server:pve-02), a connection (connection:con_…) or a connection’s handle (homeassistant).',
    ),
  undo: z
    .string()
    .trim()
    .min(1)
    .max(REPORT_CHANGE_UNDO_MAX)
    .optional()
    .describe(
      'Private, for you only: how you would put it back (where the backup is, the old value). With it, the person can ask you to undo the change.',
    ),
  undoes: ChangeId.optional().describe(
    'When this change put an earlier one back: that change’s id (from the undo request).',
  ),
});
export type ReportChangeInput = z.input<typeof ReportChangeInput>;

/**
 * Why a report wasn't recorded: `unknown_thing` (`thing` names nothing in this burrow), `unknown_change` (`undoes` names
 * no change here), `already_undone` (that change was put back already), `capped` (too many reports in a short time).
 */
export const REPORT_CHANGE_REFUSAL_CODES = [
  'unknown_thing',
  'unknown_change',
  'already_undone',
  'capped',
] as const;
export const ReportChangeRefusalCode = z.enum(REPORT_CHANGE_REFUSAL_CODES);
export type ReportChangeRefusalCode = z.infer<typeof ReportChangeRefusalCode>;

export const ReportChangeOutput = z.discriminatedUnion('status', [
  ...commitOutcome({ changeId: ChangeId }).options,
  z.object({ status: z.literal('refused'), code: ReportChangeRefusalCode, reason: z.string() }),
]);
export type ReportChangeOutput = z.infer<typeof ReportChangeOutput>;

/** A finished task's few words, as the desk's *Done today* shows them. */
export const REPORT_DONE_SUMMARY_MAX = 60;

export const ReportDoneInput = z.object({
  summary: z
    .string()
    .trim()
    .min(1)
    .max(REPORT_DONE_SUMMARY_MAX)
    .describe(
      'What you did, a few plain words in the past tense: “Checked the status of pve-01”, “Restarted Plex”.',
    ),
});
export type ReportDoneInput = z.input<typeof ReportDoneInput>;

function changeTool<I extends z.ZodObject, O extends z.ZodType>(def: McpTool<I, O>): McpTool<I, O> {
  return def;
}

export const CHANGE_MCP_TOOLS = {
  report_change: changeTool({
    name: 'report_change',
    title: 'Report a change',
    description:
      'Call this after you changed something outside connection_call (over SSH, with one of your commands, a command on a server), so the person sees it under “Changes here” on the page of what you changed. Once per change a person would care about, not once per command; never for reads. Give undo when you can put it back (where the backup is, the old value): the person can then ask you to undo it. When you put an earlier change back, report that with undoes.',
    input: ReportChangeInput,
    output: ReportChangeOutput,
    requiredKey: null,
    readOnly: false,
  }),
  report_done: changeTool({
    name: 'report_done',
    title: 'Say what you did',
    description:
      'When you have finished what was asked in this thread and it took doing something (you checked, fixed, changed, made or found out something), say what you did in a few plain words in the past tense, the way the person would say it: “Checked the status of pve-01”, “Restarted Plex”, “Cleaned up old backups on the-falcon”. Call it once, at the end; again only after you did more in the same thread (it replaces the earlier one). Not for small talk or an answer that needed nothing done. No ids, commands or paths.',
    input: ReportDoneInput,
    output: commitOutcome({}),
    requiredKey: null,
    readOnly: false,
    personal: true,
  }),
} as const;
