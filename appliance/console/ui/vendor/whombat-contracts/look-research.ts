/**
 * What the assistant found out about a look (3.5; Whombat docs/decisions/look-research.md). When a server, connection or
 * device starts needing a look, the assistant looks into it by itself before anyone asks, in a thread of the person's
 * Chat, and says what is wrong in a few plain sentences. It may fix something small itself; for anything more it offers
 * one step, named on its button (“Restart Zigbee”), that the person's press lets it take. The desk's look and hero,
 * Home's Needs you and the thing's page carry the same shape, so every screen says the same.
 */
import { z } from 'zod';
import { ConversationId, MessageId } from '../ids.js';
import { displayLine as line } from './display-text.js';

/** A moment in RFC 3339, as the desk socket's `Rfc3339`. */
const Timestamp = z
  .string()
  .max(40)
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/);

/** “Zigbee stopped working in Home Assistant”, “Zigbee works again”. */
export const LOOK_TITLE_MAX = 80;
/** One to three plain sentences: what is wrong, what it means for the person, what can be done. */
export const LOOK_SUMMARY_MAX = 240;
/** The fix's button, the step itself: “Restart Zigbee”. */
export const LOOK_FIX_LABEL_MAX = 32;
/** The step in the assistant's own words, what it will do when the person presses it (never shown). */
export const LOOK_FIX_STEP_MAX = 300;
/**
 * A step of a plan as its card says it, with the defaults it chose (“Add the 6 machines to a nightly backup at 02:00,
 * keeping a week”).
 */
export const LOOK_PLAN_STEP_MAX = 120;
/** At most this many steps in one plan: what a person reads at a glance and says yes to at once. */
export const LOOK_PLAN_STEPS_MAX = 6;
/** The lines of a thing one research covers at most (its problems and only-you lines). */
export const LOOK_LINES_MAX = 12;

/**
 * Where it stands: `looking` the assistant is finding out; `found` it said what is wrong (with `fix` when it can take a
 * step, without when it can't or only the person can); `fixing` it is taking the step the person let it take; `fixed`
 * it fixed it (by itself or after the press) and saw it work; `failed` it couldn't finish (no AI, no time left today):
 * screens then say what they said before.
 */
export const LOOK_RESEARCH_STATES = ['looking', 'found', 'fixing', 'fixed', 'failed'] as const;
export const LookResearchState = z.enum(LOOK_RESEARCH_STATES);
export type LookResearchState = z.infer<typeof LookResearchState>;

/**
 * A look's research: `key` the look's (`DeskLook.key`, the thing's id on Home: `server:pve-02`, `connection:con_…`),
 * which `looks.fix`, `looks.handle` and the desk's `look/fix` take; `title` and `summary` the assistant's words once it
 * found out; `fix` the label of the one step it offers (only in `found`); `plan` the steps it will take on everything
 * that needs a look there, one press for all of them (3.11; handle-it.md): in `found` waiting for the person's *Go
 * ahead*, in `fixing` while it takes them, in `fixed` what it did — never with `fix`, so a screen that doesn't know
 * plans offers no button for steps it doesn't show; `conversationId` and `threadRootId` the thread where it looked into
 * it, which *Ask {assistant}* and *Change something* open in the apps; `at` when the state last changed.
 */
export const LookResearch = z.object({
  key: line(120),
  state: LookResearchState,
  title: line(LOOK_TITLE_MAX).optional(),
  summary: line(LOOK_SUMMARY_MAX).optional(),
  fix: line(LOOK_FIX_LABEL_MAX).optional(),
  plan: z.array(line(LOOK_PLAN_STEP_MAX)).min(1).max(LOOK_PLAN_STEPS_MAX).optional(),
  conversationId: ConversationId.optional(),
  threadRootId: MessageId.optional(),
  at: Timestamp,
});
export type LookResearch = z.infer<typeof LookResearch>;

/**
 * Where a plan's card is (3.11): `waiting` for the person's *Go ahead* or a reply that changes it, `doing` the steps
 * now, `done` (the assistant's words say what it did), `gone`: no longer needed (the problem went before anyone said go
 * ahead) or replaced by a later finding.
 */
export const LOOK_PLAN_STATES = ['waiting', 'doing', 'done', 'gone'] as const;
export const LookPlanState = z.enum(LOOK_PLAN_STATES);
export type LookPlanState = z.infer<typeof LookPlanState>;

/**
 * The plan card in the thing's thread of the person's Chat (`look_plan`, 3.11), resolved from its research on read:
 * the thing's `name` (“Here’s what I’ll do on pve-01:”), the steps, the assistant's title and summary, and the research
 * as the screens have it (`research`, absent once it went), whose key *Go ahead* sends.
 */
export const LookPlanView = z.object({
  name: z.string().min(1).max(120),
  state: LookPlanState,
  steps: z.array(z.string().min(1).max(LOOK_PLAN_STEP_MAX)).min(1).max(LOOK_PLAN_STEPS_MAX),
  title: z.string().max(LOOK_TITLE_MAX).nullable(),
  summary: z.string().max(LOOK_SUMMARY_MAX).nullable(),
  research: LookResearch.nullable(),
  at: Timestamp,
  /**
   * A server's care plan (Whombat care-plan.md): how the assistant will look after a server that was just added (“Here’s
   * how I’ll look after pve-01:”). Absent: a plan for what needs a look there.
   */
  care: z.boolean().optional(),
});
export type LookPlanView = z.infer<typeof LookPlanView>;

/** The plan card a research posts in its thread: server-made (`plan` null: nothing to show any more). */
export const LookPlanCard = z.object({
  kind: z.literal('look_plan'),
  researchId: z.string().min(1).max(64),
  plan: LookPlanView.nullable().default(null),
});
export type LookPlanCard = z.infer<typeof LookPlanCard>;

/** Storage form: by reference, resolved on read. */
export const StoredLookPlanCard = z.object({
  kind: z.literal('look_plan'),
  researchId: z.string().min(1).max(64),
});
export type StoredLookPlanCard = z.infer<typeof StoredLookPlanCard>;
