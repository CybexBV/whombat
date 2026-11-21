/**
 * Automations made by talking to the agent (Whombat automation-chat.md…). The agent proposes an automation, or a
 * change to one, as a plan; Whombat posts it in the Chat thread as an `automation_plan` card and the person turns it on,
 * says not now, or replies to change it, which makes a new plan that replaces the last one.
 *
 * The card's sections are written by Whombat from the definition (`automationPlanView`), never by the agent, so they say
 * exactly what will run. The agent's own words are the name, the one-line description and “How I thought about it”.
 */
import { z } from 'zod';
import { AutomationPlanId, PrincipalId } from '../ids.js';
import { AutomationId, STEP_TEXT_MAX } from './automation.js';
import { Timestamp } from './common.js';

/** “How I thought about it”: at most this many points, each this long. */
export const AUTOMATION_PLAN_THINKING_MAX = 4;
export const AUTOMATION_PLAN_THINKING_LINE_MAX = 300;
/** The agent's line above the card. */
export const AUTOMATION_PLAN_MESSAGE_MAX = 300;

/**
 * `waiting`: for the person to decide · `accepted`: turned on (a version of the automation) · `declined`: not now ·
 * `replaced`: a newer plan for the same automation came after it.
 */
export const AUTOMATION_PLAN_STATUSES = ['waiting', 'accepted', 'declined', 'replaced'] as const;
export const AutomationPlanStatus = z.enum(AUTOMATION_PLAN_STATUSES);
export type AutomationPlanStatus = z.infer<typeof AutomationPlanStatus>;

/** What the card shows of a plan: its status, or `gone` when the automation was deleted. */
export const AutomationPlanState = z.enum([...AUTOMATION_PLAN_STATUSES, 'gone']);
export type AutomationPlanState = z.infer<typeof AutomationPlanState>;

/** One line of a section: “A new issue on acme/web”, with “Not from bots” under it. */
export const AutomationPlanLine = z.object({
  text: z.string().min(1).max(300),
  detail: z.string().max(300).nullable(),
});
export type AutomationPlanLine = z.infer<typeof AutomationPlanLine>;

/** The card's rows, in this order: what starts it, what the agent does, what asks first, where it posts, its limits. */
export const AUTOMATION_PLAN_SECTIONS = ['when', 'does', 'asks', 'posts', 'limits'] as const;
export const AutomationPlanSectionId = z.enum(AUTOMATION_PLAN_SECTIONS);
export type AutomationPlanSectionId = z.infer<typeof AutomationPlanSectionId>;

export const AutomationPlanSection = z.object({
  id: AutomationPlanSectionId,
  /** “WHEN”, “DUSTY”, “ASKS YOU”, “POSTS”, “LIMIT”: the row's label as the card shows it. */
  label: z.string().min(1).max(40),
  lines: z.array(AutomationPlanLine).min(1).max(24),
});
export type AutomationPlanSection = z.infer<typeof AutomationPlanSection>;

/** One difference from the live version, for a change: a line added, removed, or what the agent is asked changed. */
export const AutomationPlanChange = z.object({
  change: z.enum(['added', 'removed', 'changed']),
  section: AutomationPlanSectionId,
  text: z.string().min(1).max(300),
});
export type AutomationPlanChange = z.infer<typeof AutomationPlanChange>;

/** What the agent is asked in one of its steps, word for word (“What Dusty is asked”, folded). */
export const AutomationPlanPrompt = z.object({
  step: z.string().min(1).max(80),
  text: z.string().min(1).max(STEP_TEXT_MAX),
});
export type AutomationPlanPrompt = z.infer<typeof AutomationPlanPrompt>;

/** A plan as its card shows it, resolved by the runtime (`automationPlanView`). */
export const AutomationPlanView = z.object({
  planId: AutomationPlanId,
  automationId: AutomationId,
  /** The agent's name for it (“New Fusebox issues”). */
  name: z.string().min(1).max(80),
  /** The agent's one sentence of what it does. */
  description: z.string().max(500),
  state: AutomationPlanState,
  /** A change to an automation that is live: the card says what changes (`changes`) and the live one runs until a yes. */
  change: z.boolean(),
  sections: z.array(AutomationPlanSection).max(AUTOMATION_PLAN_SECTIONS.length),
  /** For a change: what differs from the live version. Empty for a new automation. */
  changes: z.array(AutomationPlanChange).max(60),
  /** “How I thought about it”: the agent's own points. */
  thinking: z
    .array(z.string().min(1).max(AUTOMATION_PLAN_THINKING_LINE_MAX))
    .max(AUTOMATION_PLAN_THINKING_MAX),
  /** What the agent is asked, per step, word for word. */
  prompts: z.array(AutomationPlanPrompt).max(20),
  /**
   * What “Try it” does: on a recent issue, pull request or report (`sample`, `automations.samples`), or once now
   * (`now`). Either way it runs the plan once as a test run, before anything is on.
   */
  tryIt: z.enum(['sample', 'now']),
  decidedById: PrincipalId.nullable(),
  decidedAt: Timestamp.nullable(),
  /** The version turning it on made (accepted plans only). */
  version: z.number().int().positive().nullable(),
  createdAt: Timestamp,
});
export type AutomationPlanView = z.infer<typeof AutomationPlanView>;

/** The card a plan posts in its Chat thread: server-made (`plan` null: not resolved yet). */
export const AutomationPlanCard = z.object({
  kind: z.literal('automation_plan'),
  planId: AutomationPlanId,
  plan: AutomationPlanView.nullable().default(null),
});
export type AutomationPlanCard = z.infer<typeof AutomationPlanCard>;

/** Storage form: by reference, resolved on read. */
export const StoredAutomationPlanCard = z.object({
  kind: z.literal('automation_plan'),
  planId: AutomationPlanId,
});
export type StoredAutomationPlanCard = z.infer<typeof StoredAutomationPlanCard>;
