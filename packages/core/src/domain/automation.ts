/**
 * Supervised automations (docs/decisions/bp-automations.md). An automation is a versioned definition — triggers
 * plus ordered, bounded steps — that runs as its own automation principal with delegated authority (BP-09).
 *
 * Definitions are strict JSON: unknown fields and unknown step kinds are rejected, so an imported file cannot
 * carry anything the engine would silently ignore (or worse, grant). Keys are never part of a definition: an
 * automation's grants are set on the automation by a person (a signed Keys event), and a definition cannot
 * change them.
 */
import { z } from 'zod';
import {
  ApprovalId,
  AutomationPlanId,
  BurrowId,
  ConnectionId,
  ConversationId,
  DispatchId,
  EventId,
  MessageId,
  PrincipalId,
} from '../ids.js';
import { MergeMethod } from './approval.js';
import { JsonObject, Timestamp } from './common.js';
import { TRACKER_CUSTOMER_REPLY_MAX, TrackerItemKind, TrackerRecipeWords } from './tracker.js';

/** The longest `AutomationAssessment.valueWhy` (3.12). */
export const FEATURE_VALUE_WHY_MAX = 400;
/** The longest `AutomationAssessment.declineReason` and a person's own reason or question on the card (3.12). */
export const FEATURE_DECLINE_REASON_MAX = 500;

/** Definition format version (the `version` field of an exported file). */
export const AUTOMATION_DEFINITION_VERSION = 1;
/** Largest definition accepted anywhere (bytes of its JSON). */
export const AUTOMATION_DEFINITION_MAX_BYTES = 64 * 1024;
export const AUTOMATION_MAX_STEPS = 20;
export const AUTOMATION_MAX_TRIGGERS = 4;

export const AutomationId = z
  .string()
  .regex(/^aut_[A-Za-z0-9_-]{1,64}$/, { message: 'Expected an aut_ id' })
  .describe('aut_ id');
export const AutomationRunId = z
  .string()
  .regex(/^arn_[A-Za-z0-9_-]{1,64}$/, { message: 'Expected an arn_ id' })
  .describe('arn_ id');

/** Step id: referenced from templates (`{{steps.investigate.text}}`) and conditions. */
export const AutomationStepId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, { message: 'Step ids are lowercase letters, digits and _' });

/** A template string: `{{trigger.text}}` / `{{steps.check.text}}` are filled in as plain text. */
const TemplateText = (max: number) => z.string().trim().min(1).max(max);

/**
 * Room a stored text keeps beyond what people and recipes write (4 000 for a step's prompt or message, 3 000 for a
 * recipe's instructions, 8 000 for a pull request's or a webhook's body and a comment), so a text an update renamed (a
 * tool's name a letter longer, a pull request's old line become the 17 characters longer marker) never stops fitting.
 */
export const RENAME_HEADROOM = 64;
/** The longest step prompt or message text a definition holds. */
export const STEP_TEXT_MAX = 4000 + RENAME_HEADROOM;

/* ---------------------------------------------------------------------------------------------- */
/* Triggers                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

export const MessagePostedTrigger = z
  .object({
    kind: z.literal('message_posted'),
    conversationId: ConversationId,
    /** Any of these words or phrases, case-insensitive. Empty: every message. */
    contains: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
    /** Only messages that mention this principal. */
    mentionsId: PrincipalId.optional(),
    /** Messages by agents never count unless this is on (their authority is never added either way). */
    includeAgents: z.boolean().default(false),
    /** Replies in threads count too. */
    includeReplies: z.boolean().default(false),
  })
  .strict();

export const ReactionAddedTrigger = z
  .object({
    kind: z.literal('reaction_added'),
    conversationId: ConversationId,
    /** The reaction, e.g. `🐛`. */
    value: z.string().min(1).max(32),
  })
  .strict();

/** What to do with a local time that does not exist (spring forward) or happens twice (fall back). */
export const DstPolicy = z
  .object({
    /** `shift`: run at the same wall-clock distance after the gap (02:30 → 03:30); `skip`: not that day. */
    skipped: z.enum(['shift', 'skip']).default('shift'),
    /** `once`: the first of the two; `twice`: both. */
    repeated: z.enum(['once', 'twice']).default('once'),
  })
  .strict();
export type DstPolicy = z.infer<typeof DstPolicy>;

export const CronSchedule = z
  .object({
    kind: z.literal('cron'),
    /** Five fields: minute hour day-of-month month day-of-week (`0 9 * * 1-5`). */
    expr: z.string().trim().min(9).max(120),
  })
  .strict();
export const IntervalSchedule = z
  .object({
    kind: z.literal('interval'),
    everyMinutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60),
  })
  .strict();
export const ScheduleSpec = z.discriminatedUnion('kind', [CronSchedule, IntervalSchedule]);
export type ScheduleSpec = z.infer<typeof ScheduleSpec>;

export const OverlapPolicy = z.enum(['skip', 'queue', 'cancel_previous']);
export type OverlapPolicy = z.infer<typeof OverlapPolicy>;
export const MissedRunPolicy = z.enum(['skip', 'run_once']);
export type MissedRunPolicy = z.infer<typeof MissedRunPolicy>;

export const ScheduleTrigger = z
  .object({
    kind: z.literal('schedule'),
    schedule: ScheduleSpec,
    /** IANA time zone the cron fields are read in (`Europe/Amsterdam`). */
    timeZone: z.string().min(1).max(64),
    dst: DstPolicy.default({ skipped: 'shift', repeated: 'once' }),
    /** A run is still going when the next one is due. */
    overlap: OverlapPolicy.default('skip'),
    /** Runs that fell due while Whombat was down. */
    missed: MissedRunPolicy.default('skip'),
    /** At most this many missed runs are considered when catching up. */
    maxCatchUp: z.number().int().min(1).max(10).default(3),
  })
  .strict();
export type ScheduleTrigger = z.infer<typeof ScheduleTrigger>;

export const GitHubTriggerEvent = z.enum([
  'pr_opened',
  'pr_updated',
  'checks_completed',
  'review_submitted',
  'branch_pushed',
  /** A new issue (0.66, CT-322): the poller reads issues of switched-on repos an automation listens to. */
  'issue_opened',
]);
export type GitHubTriggerEvent = z.infer<typeof GitHubTriggerEvent>;

/** Events about a pull request (the `drafts` filter applies to them). */
export const GITHUB_PR_EVENTS: readonly GitHubTriggerEvent[] = [
  'pr_opened',
  'pr_updated',
  'checks_completed',
  'review_submitted',
];

export const GitHubTrigger = z
  .object({
    kind: z.literal('github'),
    event: GitHubTriggerEvent,
    /** `owner/name`; only switched-on repos ever fire. */
    repo: z.string().min(3).max(255),
    /** Branch glob (`feat/*`); every branch when absent. Issues have no branch. */
    branch: z.string().min(1).max(255).optional(),
    /** checks_completed only: fire on this outcome. */
    checksState: z.enum(['passed', 'failed']).optional(),
    /**
     * Draft pull requests (0.66, CT-322). `false`: a draft fires nothing; with `pr_opened` it fires when it is marked
     * ready for review instead. Absent or `true`: drafts fire like any pull request.
     */
    drafts: z.boolean().optional(),
    /**
     * Issues and pull requests opened by bots (0.66): `false` leaves out accounts GitHub marks as bots (`…[bot]`,
     * Dependabot, Renovate). Absent or `true`: they fire too.
     */
    bots: z.boolean().optional(),
  })
  .strict();
export type GitHubTrigger = z.infer<typeof GitHubTrigger>;

/** What a GitHub event is called in sentences (“When a new issue is opened on …”). */
export const GITHUB_EVENT_LABELS: Record<GitHubTriggerEvent, string> = {
  issue_opened: 'A new issue',
  pr_opened: 'A new pull request',
  pr_updated: 'New commits on a pull request',
  checks_completed: 'Checks finish on a pull request',
  review_submitted: 'A review on a pull request',
  branch_pushed: 'A push to a branch',
};

/**
 * What happens in a tracker that starts a run (0.69, CT-325): a new report; since 0.75 (CT-331; Whombat
 * report-trackers.md TA-31) `reporter_replied` — the reporter of a report an automation already ran for wrote back,
 * or reopened it (“Still happening”). Its run continues the report's thread.
 */
export const TrackerTriggerEvent = z.enum(['item_opened', 'reporter_replied']);
export type TrackerTriggerEvent = z.infer<typeof TrackerTriggerEvent>;

/**
 * A new report in a tracker connection (0.69, CT-325; Whombat report-trackers.md TA-04): the poller reads the
 * connections a live automation listens to, and only reports filed after it started listening fire (TA-06).
 */
export const TrackerTrigger = z
  .object({
    kind: z.literal('tracker'),
    /** The shared tracker connection (Settings → Connections) whose reports it listens to. */
    connectionId: ConnectionId,
    event: TrackerTriggerEvent,
    /** Only these kinds of report; both when absent. */
    itemKinds: z.array(TrackerItemKind).min(1).max(2).optional(),
  })
  .strict();
export type TrackerTrigger = z.infer<typeof TrackerTrigger>;

/** An authenticated inbound webhook (off until an owner turns it on and a secret exists). */
export const WebhookTrigger = z.object({ kind: z.literal('webhook') }).strict();

/** Only people start it (Run now). Every automation can also be test-run by hand. */
export const ManualTrigger = z.object({ kind: z.literal('manual') }).strict();

export const AutomationTrigger = z.discriminatedUnion('kind', [
  MessagePostedTrigger,
  ReactionAddedTrigger,
  ScheduleTrigger,
  GitHubTrigger,
  WebhookTrigger,
  ManualTrigger,
  TrackerTrigger,
]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;
export type AutomationTriggerInput = z.input<typeof AutomationTrigger>;
export type AutomationTriggerKind = AutomationTrigger['kind'];

/* ---------------------------------------------------------------------------------------------- */
/* Steps                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** `run`: the run's own conversation (where it was triggered, or the automation's room). */
export const StepConversation = z.union([z.literal('run'), ConversationId]);
export type StepConversation = z.infer<typeof StepConversation>;

const StepBase = {
  id: AutomationStepId,
  /** Shown in the step timeline; defaults to the kind's own label. */
  name: z.string().trim().min(1).max(80).optional(),
  /** Minutes before the step is stopped as failed (each kind has its own default and ceiling). */
  timeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(7 * 24 * 60)
    .optional(),
  /** Retries after a failure whose outcome is known (never after an uncertain one). */
  retries: z.number().int().min(0).max(3).default(0),
};

/**
 * Coding work for a `dispatch_agent` step (docs/decisions/bp-automations.md BP-C26): the runner prepares a checkout
 * of `repo` for the agent's turn. `write`: a worktree on the agent's own `branch` (created from `base`), which the
 * agent's branch key must allow — checked before the agent is asked (can: go; asks: a person approves first;
 * no: Blocked). `read`: a read-only checkout of `branch` (another step's branch, to review it) or of the base.
 */
export const StepWorkspace = z
  .object({
    /** `owner/name`; must be switched on for agents. */
    repo: z.string().min(3).max(255),
    /** The branch (template, e.g. `feat/bug-{{run.number}}`). Required for `write`; `read` without it: the base. */
    branch: TemplateText(255).optional(),
    /** The branch it starts from (and a review compares with); the repo's default branch when absent. */
    base: z.string().min(1).max(255).optional(),
    access: z.enum(['write', 'read']),
    /**
     * `read` only (0.66, CT-322): a pull request's number (template, `{{trigger.number}}`). The checkout is the pull
     * request's head — from a fork too — compared with its base. When it renders to nothing (an issue started the run)
     * the checkout is the base, as without it. Not together with `branch`.
     */
    pullRequest: TemplateText(20).optional(),
  })
  .strict();
export type StepWorkspace = z.infer<typeof StepWorkspace>;

/** The first words a `verdict` step's agent starts its reply with (BP-C27). */
export const VERDICT_APPROVE = 'Approve';
export const VERDICT_CHANGES = 'Changes needed';
export const AutomationVerdict = z.enum(['approve', 'changes_needed']);
export type AutomationVerdict = z.infer<typeof AutomationVerdict>;

/* ---------------------------------------------------------------------------------------------- */
/* Assessments (0.67, CT-323)                                                                     */
/* ---------------------------------------------------------------------------------------------- */

/** What an issue is, as the agent assessing it judges. `unclear`: it couldn't tell (or reported nothing). */
export const AssessmentKind = z.enum(['bug', 'feature', 'question', 'not_a_bug', 'duplicate', 'unclear']);
export type AssessmentKind = z.infer<typeof AssessmentKind>;
/** How much it matters, most first. */
export const AssessmentImportance = z.enum(['critical', 'high', 'medium', 'low']);
export type AssessmentImportance = z.infer<typeof AssessmentImportance>;
export const AssessmentConfidence = z.enum(['low', 'medium', 'high']);
export type AssessmentConfidence = z.infer<typeof AssessmentConfidence>;
/** The fix it expects: `small` stays in a few files and needs no design decision; anything else is `large`. */
export const AssessmentSize = z.enum(['small', 'large']);
export type AssessmentSize = z.infer<typeof AssessmentSize>;
/**
 * Whether the agent recommends changing the code (0.71, CT-327; Whombat automation-recipes.md AR-51): `change` — a fix,
 * an improvement or a feature, its fix plan saying what; `nothing` — a question, a duplicate, something unclear or a
 * report that needs no change.
 */
export const AssessmentRecommends = z.enum(['change', 'nothing']);
export type AssessmentRecommends = z.infer<typeof AssessmentRecommends>;

/**
 * An agent's structured assessment (0.67, CT-323), reported with its `report_assessment` tool in the turn of a
 * `dispatch_agent` step with `assessment: true`; conditions read it as `steps.<id>.assessment.*`. A turn that reports
 * none gives `unassessed()` (kind `unclear`), so nothing follows from a missing answer.
 */
export const AutomationAssessment = z
  .object({
    kind: AssessmentKind,
    importance: AssessmentImportance,
    confidence: AssessmentConfidence,
    size: AssessmentSize,
    /** One plain sentence anyone understands: what it is and why — no file names, code or commands (0.68). */
    summary: z.string().trim().min(1).max(300),
    /** For a bug: how it would be fixed, in a sentence or two (the fix step starts from it). */
    fixPlan: z.string().trim().max(1000).default(''),
    /**
     * The change in a few English words, for its pull request's title (“Explain why a released Blueprint can't be
     * deleted”): a tracker's customer writes in their own language and at length, so their words make a poor title.
     * Empty: a shortened `summary` stands in (`assessmentPrTitle`).
     */
    title: z.string().trim().max(120).default(''),
    /**
     * The technical part (0.68, CT-324): files and lines, what to check or test, in Markdown. People see it folded
     * under the plain answer (“Technical details”), and a GitHub comment folds it in a `<details>` block.
     */
    details: z.string().trim().max(4000).default(''),
    /** For a duplicate: the issue it duplicates. */
    duplicateOf: z.number().int().positive().nullable().default(null),
    /**
     * Whether it recommends changing the code (0.71, CT-327, AR-51): a recipe that fixes offers a `change` with its
     * approval card, as an important bug. Absent: `nothing`. `report_assessment` requires it
     * (`ReportAssessmentInput`).
     */
    recommends: AssessmentRecommends.optional(),
    /**
     * What the customer is told (0.75, CT-331; Whombat report-trackers.md TA-25): a tracker recipe that replies sends
     * it through the tracker with its `tracker_reply` step, signed with the agent's name (`customerSignature`). In the
     * customer's own language, two to four sentences, no internal words (`customerReplyProblem` checks). Empty: nothing
     * needs saying (the step skips).
     */
    reply: z.string().trim().max(TRACKER_CUSTOMER_REPLY_MAX).default(''),
    /** The reply asks the customer for something the agent needs to go on (0.75): the report becomes “Needs information”. */
    replyAsks: z.boolean().default(false),
    /** The language the customer wrote in, ISO 639-1 (`nl`, `en`; 0.75): the fix notices' language (`trackerFixNotice`). */
    language: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^([a-z]{2})?$/)
      .default(''),
    /**
     * For a feature request a person decides on (3.12, CT-1636; Whombat report-trackers.md TA-42): how valuable
     * building it would be, 1 (hardly) to 10 (very). Null for anything else.
     */
    value: z.number().int().min(1).max(10).nullable().default(null),
    /** Why that value, in a sentence or two anyone understands (3.12). */
    valueWhy: z.string().trim().max(FEATURE_VALUE_WHY_MAX).default(''),
    /** What the customer reads if a person approves the feature request: it will be built (3.12, unsigned). */
    approvedReply: z.string().trim().max(TRACKER_CUSTOMER_REPLY_MAX).default(''),
    /** The reason the agent would give for not building it, in a sentence for the person (3.12): the card's Decline. */
    declineReason: z.string().trim().max(FEATURE_DECLINE_REASON_MAX).default(''),
    /** What the customer reads if a person declines it with `declineReason` (3.12, unsigned). */
    declinedReply: z.string().trim().max(TRACKER_CUSTOMER_REPLY_MAX).default(''),
  })
  .strict();
export type AutomationAssessment = z.infer<typeof AutomationAssessment>;
export type AutomationAssessmentInput = z.input<typeof AutomationAssessment>;

/**
 * What an agent reports with `report_assessment` (0.71, CT-327, AR-51): the assessment, with `recommends` required, so
 * Whombat never guesses a recommendation from the agent's words.
 */
export const ReportAssessmentInput = AutomationAssessment.extend({
  recommends: AssessmentRecommends.describe(
    'change: you recommend changing the code — a fix, an improvement or a feature — and fixPlan says what. nothing: a question, a duplicate, something unclear or a report that needs no change.',
  ),
  title: AutomationAssessment.shape.title.describe(
    'When you recommend a change: what the change does, in a few English words, as a pull request title (under 70 characters, no ending period). Empty otherwise.',
  ),
  reply: AutomationAssessment.shape.reply.describe(
    'Only when your instructions say the customer is answered: what the customer reads, in their own language — two to four short sentences: what you found, in their terms, and what happens next. No promise of a fix or a date, no file names, code, pull requests, links, other customers or labels like importance; don’t sign it. Empty when nothing needs saying.',
  ),
  replyAsks: AutomationAssessment.shape.replyAsks.describe(
    'true when your reply asks the customer for something you need before you can go on.',
  ),
  duplicateOf: AutomationAssessment.shape.duplicateOf.describe(
    'For a duplicate: the number of the earlier open report it repeats, as your tools list it; else null.',
  ),
  /**
   * The report is finished, so the customer's reply closes it in the tracker (TA-54). Kept on the step beside the
   * assessment, not in it: older apps read the assessment strictly.
   */
  closes: z
    .boolean()
    .default(false)
    .describe(
      'true when the report is finished and your reply says so: the customer asked to close it or says it is solved, you fully answered their question, it repeats an open report you name in duplicateOf, or it is a test or not about the product. Your reply then closes it; they can still write back. Never when you recommend a change, never with replyAsks.',
    ),
  language: AutomationAssessment.shape.language.describe(
    'The language the customer wrote in, as a two-letter code: nl, en, de …',
  ),
  value: AutomationAssessment.shape.value.describe(
    'Only for a feature request your instructions say a person decides on, else leave it out: how worthwhile building it is, 1 to 10 — how many customers it would help, how much, how well it fits the product, the size of the work and its risk. 8–10 clearly worth building soon, 5–7 worth it, 3–4 doubtful, 1–2 not worth it.',
  ),
  valueWhy: AutomationAssessment.shape.valueWhy.describe(
    'Why that value, in a sentence or two anyone understands.',
  ),
  approvedReply: AutomationAssessment.shape.approvedReply.describe(
    'For such a feature request: what the customer reads if it is approved, in their language, unsigned — it will be built and they hear when it is ready; no date.',
  ),
  declineReason: AutomationAssessment.shape.declineReason.describe(
    'For such a feature request: your reason not to build it, in one sentence for the team.',
  ),
  declinedReply: AutomationAssessment.shape.declinedReply.describe(
    'For such a feature request: what the customer reads if it is declined for that reason, in their language, unsigned, kind and short.',
  ),
});
export type ReportAssessmentInput = z.input<typeof ReportAssessmentInput>;

export const DispatchAgentStep = z
  .object({
    ...StepBase,
    kind: z.literal('dispatch_agent'),
    /** What the agent is asked (template), for the automation's person (OA-15). Posted as the automation's message. */
    prompt: TemplateText(STEP_TEXT_MAX),
    conversation: StepConversation.default('run'),
    /** `run`: in the run's thread; `top`: a new top-level message (it becomes the run's thread). */
    thread: z.enum(['run', 'top']).default('run'),
    /** A checkout for coding work (BP-C26). With `write`, the step succeeds only when the branch has new commits. */
    workspace: StepWorkspace.optional(),
    /**
     * The agent gives a verdict: its reply starts with “Approve” or “Changes needed” (`steps.<id>.verdict` is
     * `approve` / `changes_needed` for conditions); any other reply fails the step (BP-C27).
     */
    verdict: z.boolean().optional(),
    /**
     * The agent reports a structured assessment with `report_assessment` (0.67, CT-323): `steps.<id>.assessment.*`
     * (kind, importance, confidence, size, summary, fixPlan, duplicateOf, details, recommends, and the server's `line` —
     * “Bug · high importance · sure · small fix” — `heading` and `detailsBlock`, `assessmentMarkdown`'s parts of a
     * comment, 0.68, and `question` and `offer`, `assessmentQuestion`'s “Fix this bug?” or “Make this change?” and
     * `assessmentOffer`'s “Fix” or “Suggested change for”, the approval card's words, 0.71).
     * Without a report the assessment is `unclear`. Not together with `verdict`.
     */
    assessment: z.boolean().optional(),
  })
  .strict();

export const PostMessageStep = z
  .object({
    ...StepBase,
    kind: z.literal('post_message'),
    text: TemplateText(STEP_TEXT_MAX),
    conversation: StepConversation.default('run'),
    thread: z.enum(['run', 'top']).default('run'),
    /** Attach what earlier dispatch steps' agents attached (attachment ids from their messages). */
    attachFrom: z.array(AutomationStepId).max(5).default([]),
  })
  .strict();

export const RequestApprovalStep = z
  .object({
    ...StepBase,
    kind: z.literal('request_approval'),
    /** The proposal a person approves (template): its title. */
    title: TemplateText(160),
    /** What exactly happens if they say yes (template). */
    details: TemplateText(2000),
    /** People who may decide; default: people in the run's conversation, else the owners. */
    approverIds: z.array(PrincipalId).max(10).default([]),
    /** Bind the approval to the current head of this branch: a new commit needs a new approval. */
    bindBranch: z
      .object({ repo: z.string().min(3).max(255), branch: TemplateText(255) })
      .strict()
      .optional(),
    onDecline: z.enum(['stop', 'continue']).default('stop'),
  })
  .strict();

export const WaitStep = z
  .object({
    ...StepBase,
    kind: z.literal('wait'),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60),
  })
  .strict();

export const ConditionStep = z
  .object({
    ...StepBase,
    kind: z.literal('condition'),
    /** A small expression over trigger and step outputs (`contains(steps.check.text, "ACTIONABLE")`). */
    if: z.string().trim().min(1).max(500),
    /** When it is false: stop the run (successfully), or skip ahead to a later step. */
    else: z.union([z.literal('stop'), z.object({ skipTo: AutomationStepId }).strict()]).default('stop'),
  })
  .strict();

export const OpenPullRequestStep = z
  .object({
    ...StepBase,
    kind: z.literal('open_pull_request'),
    repo: z.string().min(3).max(255),
    branch: TemplateText(255),
    base: z.string().min(1).max(255).optional(),
    title: TemplateText(200),
    body: z
      .string()
      .max(8000 + RENAME_HEADROOM)
      .default(''),
    /** The repo is not a permitted target (not switched on, or the key is missing): post the prepared PR instead. */
    otherwise: z.enum(['post_payload', 'fail']).default('post_payload'),
  })
  .strict();

export const HttpCallbackStep = z
  .object({
    ...StepBase,
    kind: z.literal('http_callback'),
    /** https only; must be a destination an owner approved (approved when an owner publishes). */
    url: z.url({ protocol: /^https$/ }).max(2048),
    /** JSON body template; values are filled in as JSON strings. */
    body: z
      .string()
      .max(8000 + RENAME_HEADROOM)
      .default('{}'),
  })
  .strict();

/**
 * Comment on a GitHub issue or pull request (0.66, CT-322): usually an agent's answer (`{{steps.assess.text}}`). Needs
 * the automation's “Comment on pull requests” key (`pr.comment`) for the repo, within what its publisher may do; the
 * comment ends with “— <agent> via Whombat”, the agent of the step before it that asked one.
 */
export const GitHubCommentStep = z
  .object({
    ...StepBase,
    kind: z.literal('github_comment'),
    /** `owner/name`; must be switched on. */
    repo: z.string().min(3).max(255),
    /** The issue or pull request (template, `{{trigger.number}}`). Renders to nothing: the step is skipped. */
    number: TemplateText(20),
    /** The comment (template; `{{steps.<id>.reply}}` is an agent's last message). Markdown, as GitHub shows it. */
    text: TemplateText(8000 + RENAME_HEADROOM),
    /** The key says No or the repo isn't switched on: `skip` the step (the run goes on) or `fail` the run. */
    otherwise: z.enum(['skip', 'fail']).default('skip'),
  })
  .strict();

/**
 * Write an agent's assessment back to a tracker's report (0.69, CT-325; Whombat report-trackers.md TA-11…TA-13): the
 * assessment and priority of step `from`'s `report_assessment` (`trackerWriteOf`), never a status or a message, which
 * the tracker shows neither to the reporter nor emails about. Needs the automation's “Update reports” key
 * (`report.update`) for the connection. Safe to repeat (`REPEATABLE_EXTERNAL_STEP_KINDS`).
 */
export const TrackerUpdateStep = z
  .object({
    ...StepBase,
    kind: z.literal('tracker_update'),
    /** The shared tracker connection the report is in. */
    connectionId: ConnectionId,
    /** The report's id (template, `{{trigger.reportId}}`). Renders to nothing: the step is skipped. */
    report: TemplateText(100),
    /** An earlier `dispatch_agent` step with `assessment: true`: whose assessment is written. */
    from: AutomationStepId,
    /** The key says No: `skip` the step (the run goes on) or `fail` the run. */
    otherwise: z.enum(['skip', 'fail']).default('skip'),
  })
  .strict();

/**
 * Reply to the customer of a tracker's report (0.75, CT-331; Whombat report-trackers.md TA-25…TA-28): step `from`'s
 * assessment `reply`, signed with its agent's name (“Banjo - AI Developer”, `customerSignature`), as a public message
 * the tracker shows and emails as its team, with a status (`trackerReplyStatus`: “Needs information” when the reply
 * asks something, else “Investigating” for a new report). An empty reply skips the step; a reply `customerReplyProblem`
 * finds fault with waits for a person's yes whatever the key says. Needs the automation's “Reply to customers” key
 * (`report.reply`) for the connection. Safe to repeat (`REPEATABLE_EXTERNAL_STEP_KINDS`).
 */
export const TrackerReplyStep = z
  .object({
    ...StepBase,
    kind: z.literal('tracker_reply'),
    /** The shared tracker connection the report is in. */
    connectionId: ConnectionId,
    /** The report's id (template, `{{trigger.reportId}}`). Renders to nothing: the step is skipped. */
    report: TemplateText(100),
    /** An earlier `dispatch_agent` step with `assessment: true`: whose reply is sent. */
    from: AutomationStepId,
    /**
     * An earlier `tracker_decision` step whose outcome this reply tells (3.12, CT-1637; Whombat report-trackers.md
     * TA-46): the decision's draft is sent (else step `from`'s reply, which words the person's reason or question) with
     * the decision's status (Planned, In progress, Not planned, Needs information). Without a decision: skipped.
     */
    decision: AutomationStepId.optional(),
    /** The key says No: `skip` the step (the run goes on) or `fail` the run. */
    otherwise: z.enum(['skip', 'fail']).default('skip'),
  })
  .strict();

/**
 * Put a tracker's feature request to the person (3.12, CT-1637; Whombat report-trackers.md TA-44, TA-45): when step
 * `from` assessed a feature request that doesn't wait for the customer and the report wasn't decided before, a
 * `feature_request` card in the run's thread with the agent's value and both drafts, and the step waits for the
 * person's answer (`tracker.decide`): approve, approve and build (offered with `build`), decline with a reason, or ask the
 * customer. Anything else skips it. Its output is `decided`, `choice`, `build`, `status`, `message` (a draft that can go
 * as it is) and `needsWords` with `note` (the person's own reason or question, for the agent to word).
 */
export const TrackerDecisionStep = z
  .object({
    ...StepBase,
    kind: z.literal('tracker_decision'),
    /** The shared tracker connection the report is in. */
    connectionId: ConnectionId,
    /** The report's id (template, `{{trigger.reportId}}`). Renders to nothing: the step is skipped. */
    report: TemplateText(100),
    /** An earlier `dispatch_agent` step with `assessment: true`: whose assessment is put to the person. */
    from: AutomationStepId,
    /** Whether the card offers “Approve and build”: the steps after it build what is approved. */
    build: z.boolean().default(false),
  })
  .strict();

/**
 * Merge a pull request once its checks pass (0.70, CT-326; Whombat automation-recipes.md AR-44…AR-47): usually the fix
 * a recipe's `pr` step opened (`{{steps.pr.prNumber}}`). Needs the automation's “Merge into main” key (`merge.main`,
 * the base being the repo's default branch) else “Merge” (`merge`) for the repo, within what its publisher may do. It
 * waits (state `waiting`) until the pull request's checks pass, then merges with `method`; it leaves the pull request
 * for a person — the step fails — when checks fail, it is closed, it changed after the run's review, someone asked for
 * changes, or the checks didn't finish within `waitMinutes`. Merged by someone meanwhile: it succeeds.
 */
export const MergePullRequestStep = z
  .object({
    ...StepBase,
    kind: z.literal('merge_pull_request'),
    /** `owner/name`; must be switched on. */
    repo: z.string().min(3).max(255),
    /**
     * The pull request (template, `{{steps.pr.prNumber}}`; up to 64 characters, so any step id fits). Renders to
     * nothing (no pull request was opened): the step is skipped.
     */
    number: TemplateText(64),
    /** How it merges: one squashed commit unless asked otherwise. */
    method: MergeMethod.default('squash'),
    /** How long it waits for the checks, in minutes (a day by default, a week at most). */
    waitMinutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60)
      .default(24 * 60),
    /** The key says No or the repo isn't switched on: `skip` the step (the run goes on) or `fail` the run. */
    otherwise: z.enum(['skip', 'fail']).default('fail'),
  })
  .strict();

export const AutomationStep = z.discriminatedUnion('kind', [
  DispatchAgentStep,
  PostMessageStep,
  RequestApprovalStep,
  WaitStep,
  ConditionStep,
  OpenPullRequestStep,
  HttpCallbackStep,
  GitHubCommentStep,
  TrackerUpdateStep,
  MergePullRequestStep,
  TrackerReplyStep,
  TrackerDecisionStep,
]);
export type AutomationStep = z.infer<typeof AutomationStep>;
export type AutomationStepKind = AutomationStep['kind'];

/**
 * Steps whose effect leaves Whombat (the engine's external pass): after a crash mid-step their outcome is unknown
 * (`uncertain`, a person decides) — unless they are safe to repeat (`REPEATABLE_EXTERNAL_STEP_KINDS`).
 */
export const EXTERNAL_STEP_KINDS: readonly AutomationStepKind[] = [
  'http_callback',
  'open_pull_request',
  'github_comment',
  'tracker_update',
  'merge_pull_request',
  'tracker_reply',
];

/**
 * External steps that are safe to repeat (0.69, CT-325, TA-13): the request carries an id kept on the step attempt,
 * which the other side replays, so after a crash mid-step the step is sent again with the same id instead of becoming
 * `uncertain`.
 */
export const REPEATABLE_EXTERNAL_STEP_KINDS: readonly AutomationStepKind[] = [
  'tracker_update',
  'tracker_reply',
];

export const AutomationLimits = z
  .object({
    /** Whole run, including waits for people. */
    runTimeoutMinutes: z
      .number()
      .int()
      .min(5)
      .max(30 * 24 * 60)
      .default(7 * 24 * 60),
    /**
     * Runs of this automation going at once (schedules follow their overlap policy first). Since 0.73 (CT-329; Whombat
     * automation-recipes.md AR-56) a run waiting for a person's yes on its approval card doesn't count, and a run that
     * gets its yes while the others fill every place waits its turn (`queued`) again; since 3.12 neither does one waiting
     * for the person's answer to a feature request (`tracker_decision`).
     */
    maxConcurrentRuns: z.number().int().min(1).max(5).default(1),
    maxRunsPerDay: z.number().int().min(1).max(500).default(50),
    /** Tokens agents may use in one run / a day, when their provider reports usage. */
    maxTokensPerRun: z.number().int().min(1000).max(50_000_000).optional(),
    maxTokensPerDay: z.number().int().min(1000).max(500_000_000).optional(),
  })
  .strict();
export type AutomationLimits = z.infer<typeof AutomationLimits>;

/* ---------------------------------------------------------------------------------------------- */
/* Recipes: the simple form (0.66, CT-322)                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** What on GitHub starts a recipe: `checks_failed` is `checks_completed` with failed checks. */
export const RecipeGitHubEvent = z.enum(['issue_opened', 'pr_opened', 'pr_updated', 'checks_failed']);
export type RecipeGitHubEvent = z.infer<typeof RecipeGitHubEvent>;

/** What the agent does (automations/recipes.ts `RECIPE_JOBS`: label, words, which triggers offer it). */
export const RecipeJob = z.enum(['assess', 'review', 'answer', 'check', 'custom']);
export type RecipeJob = z.infer<typeof RecipeJob>;

export const RecipeWhen = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('github'),
      /** `owner/name`; must be switched on. */
      repo: z.string().min(3).max(255),
      events: z.array(RecipeGitHubEvent).min(1).max(4),
      /** Draft pull requests too (default: a draft waits until it is marked ready for review). */
      drafts: z.boolean().default(false),
      /** Issues and pull requests opened by bots too (Dependabot, Renovate, `…[bot]`). */
      bots: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal('message'),
      /** Any of these words or phrases, case-insensitive; empty: every message. In the recipe's room. */
      contains: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
      /** Replies in threads count too. */
      includeReplies: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal('schedule'),
      schedule: ScheduleSpec,
      timeZone: z.string().min(1).max(64),
    })
    .strict(),
  z.object({ kind: z.literal('manual') }).strict(),
  z
    .object({
      kind: z.literal('tracker'),
      /** The tracker connection whose new reports start it (TA-17). */
      connectionId: ConnectionId,
      /** Which reports: bug reports, feature requests or both. */
      itemKinds: z.array(TrackerItemKind).min(1).max(2).default(['bug', 'feature']),
      /** The tracker's words, as its driver gave them when the automation was made (the server fills them in). */
      words: TrackerRecipeWords.optional(),
    })
    .strict(),
]);
export type RecipeWhen = z.infer<typeof RecipeWhen>;

/**
 * The simple form's answers: when, what the agent does, where it answers. `recipeDefinition` turns them into an
 * ordinary definition (one agent step, and a GitHub comment when asked), so it is validated, signed, published and
 * run like any other.
 */
/**
 * Fixing bugs the agent finds (0.67, CT-323): a bug at least `minImportance` important is fixed on `feat/issue-<n>` by
 * the agent, which first writes a test that reproduces it, then reviews it in a fresh turn that didn't write it
 * (Whombat one-agent.md OA-15), and a pull request is opened that fixes the issue. Merging stays with a
 * person unless they ticked `merge` (0.70, CT-326). `ask`: a person approves each fix first. `auto`: it fixes by itself
 * only when the agent is sure (high confidence, a small fix), the issue was opened by someone with access to the repo,
 * nobody is assigned, no pull request is linked, it isn't a test run and fewer than `maxPerDay` fixes started in the
 * last 24 hours — otherwise it asks, as `ask` does. Since 0.71 (CT-327, AR-52, AR-53) anything else the agent
 * recommends changing (`recommends: 'change'`: a bug below `minImportance`, a feature, an improvement) is offered with
 * the same approval card and, on a yes, made the same way; only an important enough bug is ever done without asking.
 * A tracker report's `auto` (Whombat report-trackers.md TA-38) fixes every bug at least `minImportance` important that
 * the agent recommends fixing, outside a test run and below `maxPerDay`; nothing about who filed it applies.
 */
export const RecipeFix = z
  .object({
    mode: z.enum(['ask', 'auto']),
    minImportance: AssessmentImportance.default('high'),
    maxPerDay: z.number().int().min(1).max(20).default(5),
    /**
     * Merging the fix (0.70, CT-326; Whombat automation-recipes.md AR-44): `checks` merges its pull request into the
     * default branch once its checks pass, after the review approved it (a `merge_pull_request` step after `pr`;
     * `RECIPE_FIX_MERGE` has the form's words). Absent: the pull request is left for a person. GitHub issues and
     * (report-trackers.md TA-39) tracker reports, whose fix then reaches development by itself; production still waits
     * for a person's release. Never on by itself.
     */
    merge: z.enum(['checks']).optional(),
    /**
     * Fix it when sure also fixes issues the repo's own GitHub Actions opened (0.73, CT-329; Whombat
     * automation-recipes.md AR-55): an issue whose author is `GITHUB_ACTIONS_LOGIN` passes the gate's “someone with
     * access to the repo opened it”, as `trigger.trusted` does (a workflow that opens an issue when a new version is
     * out). `RECIPE_FIX_ACTIONS` has the form's words. `auto` on GitHub issues only, and only with bots' issues starting
     * runs (`recipeProblem`); `recipeDefinition` keeps it only when true. Never on by itself.
     */
    trustActions: z.boolean().optional(),
  })
  .strict();
export type RecipeFix = z.infer<typeof RecipeFix>;

export const AutomationRecipe = z
  .object({
    when: RecipeWhen,
    job: RecipeJob,
    /** What the agent is asked: the job's own words (`recipeInstructions`) unless the person changed them. */
    instructions: z
      .string()
      .trim()
      .min(1)
      .max(3000 + RENAME_HEADROOM),
    /**
     * The room it answers in (the person's Chat), in a thread per issue, pull request, message or run; for a message
     * trigger also the room it listens to.
     */
    conversationId: ConversationId,
    /**
     * A read-only checkout for the agent, of this repo (`owner/name`). GitHub recipes always read their own repo (a pull
     * request's head, else the default branch) and leave this out.
     */
    repo: z.string().min(3).max(255).optional(),
    /** GitHub only: the agent's answer is also posted on the issue or pull request as a comment. */
    replyOnGitHub: z.boolean().default(false),
    /**
     * Fixing the bugs it finds (0.67, CT-323), GitHub issues and (0.69) trackers' bug reports, those always asking
     * first. Absent: it only assesses. Never on by itself: a person turns it on in the form.
     */
    fix: RecipeFix.optional(),
    /**
     * Trackers only (0.69, CT-325, TA-17): write the assessment back to the tracker (“Write the assessment back to …”),
     * when the job assesses. `recipeDefinition` stores it as given, absent as true.
     */
    writeBack: z.boolean().optional(),
    /**
     * Trackers only (0.75, CT-331; Whombat report-trackers.md TA-25…TA-33): “Reply to the customer” — after assessing,
     * the agent's `reply` goes to the customer through the tracker (a `tracker_reply` step), the customer's answers
     * start a run in the report's thread (`reporter_replied`), and the customer hears when a fix is live (TA-29). Needs
     * the job to assess. Absent: off (`refreshRecipe` turns it on, so “Update” offers it); the form sends it on by
     * default.
     */
    replyToCustomer: z.boolean().optional(),
    /**
     * Trackers only: the handle of the T3 Code connection code work goes to (Whombat t3code.md T3-15,
     * report-trackers.md TA-37). The assessment looks into the code, and a fix and its review are made, in T3 Code
     * threads instead of checkouts of the agent's own; the fix's pull request and merge stay Whombat's steps. Absent:
     * the agent's own checkouts.
     */
    t3: z.string().trim().min(1).max(64).optional(),
    /**
     * With `t3`: the model T3 Code reviews a fix with, inside the fix's own thread, as `orchestrator_capabilities` names
     * it (`gpt-6.1-sol`), and its effort (`xhigh`). Absent: a model from another provider than the one that made the fix.
     */
    t3Review: z
      .object({
        model: z.string().trim().min(1).max(80),
        effort: z.string().trim().min(1).max(20).optional(),
      })
      .strict()
      .optional(),
    /**
     * Trackers only (3.12, CT-1637; Whombat report-trackers.md TA-41…TA-48): a feature request the agent can judge
     * comes to the person as a `feature_request` card — its value from 1 to 10, Approve, Approve and build (when the
     * recipe fixes), Decline with a reason, Ask the customer — and the customer hears the decision. Needs
     * `replyToCustomer` and feature requests among the trigger's kinds. Absent: off (`refreshRecipe` turns it on).
     */
    decideFeatures: z.boolean().optional(),
  })
  .strict();
export type AutomationRecipe = z.infer<typeof AutomationRecipe>;
export type AutomationRecipeInput = z.input<typeof AutomationRecipe>;

export const AutomationDefinition = z
  .object({
    version: z.literal(AUTOMATION_DEFINITION_VERSION),
    /** The room runs post in when their trigger has none (schedules, webhooks, GitHub, manual runs). */
    conversationId: ConversationId,
    triggers: z.array(AutomationTrigger).min(1).max(AUTOMATION_MAX_TRIGGERS),
    steps: z.array(AutomationStep).min(1).max(AUTOMATION_MAX_STEPS),
    limits: AutomationLimits.default({
      runTimeoutMinutes: 7 * 24 * 60,
      maxConcurrentRuns: 1,
      maxRunsPerDay: 50,
    }),
    /**
     * The simple form's answers this definition was made from (0.66, CT-322; automations/recipes.ts). Kept so the
     * simple form can open it again; `recipeOf` tells whether the definition is still exactly what they make (an edit
     * in the step editor or the JSON makes it an ordinary definition). Never read by the engine.
     */
    recipe: AutomationRecipe.optional(),
    /**
     * Read by nobody: definitions saved while a run that went well could wait for a morning brief carry it, and the
     * strict schema must still accept them. Every run tells as it posts.
     */
    tell: z.enum(['brief', 'each_run']).optional(),
  })
  .strict();
export type AutomationDefinition = z.infer<typeof AutomationDefinition>;

export type AutomationDefinitionInput = z.input<typeof AutomationDefinition>;

/** The exported file: the definition with its name and description. */
export const AutomationExport = z
  .object({
    whombat: z.literal('automation'),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).default(''),
    definition: AutomationDefinition,
  })
  .strict();
export type AutomationExport = z.infer<typeof AutomationExport>;

/* ---------------------------------------------------------------------------------------------- */
/* Automations and versions                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/** draft: never published · published: live (its triggers fire) · disabled: published, switched off. */
export const AutomationStatus = z.enum(['draft', 'published', 'disabled']);
export type AutomationStatus = z.infer<typeof AutomationStatus>;

export const AutomationKeyTier = z.enum(['can', 'ask', 'cannot']);
/**
 * Keys an automation principal may hold (what its steps can need). `pr.comment` since 0.66 (`github_comment`),
 * `report.update` since 0.69 (`tracker_update`, CT-325), `merge` and `merge.main` since 0.70 (`merge_pull_request`,
 * CT-326), `report.reply` since 0.75 (`tracker_reply` and the fix notices, CT-331).
 */
export const AUTOMATION_KEYS = [
  'pr.open',
  'messages.external',
  'pr.comment',
  'report.update',
  'merge',
  'merge.main',
  'report.reply',
] as const;
export const AutomationKey = z.enum(AUTOMATION_KEYS);
export type AutomationKey = z.infer<typeof AutomationKey>;
export const AutomationGrant = z.object({
  keyId: AutomationKey,
  tier: AutomationKeyTier,
  /** Repos (`owner/name`) the key is limited to; all switched-on repos when absent. */
  repos: z.array(z.string().min(3).max(255)).max(20).optional(),
  /**
   * Connections the key is limited to (0.69, CT-325; `report.update`, 0.75 `report.reply`): the grant's `KeyScope.connections`. Every
   * connection the key applies to when absent.
   */
  connections: z.array(ConnectionId).max(20).optional(),
});
export type AutomationGrant = z.infer<typeof AutomationGrant>;

export const AutomationRunStatus = z.enum([
  'queued',
  'running',
  'waiting',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
  'needs_review',
]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatus>;

export const AutomationRunSummary = z.object({
  id: AutomationRunId,
  number: z.number().int().positive(),
  status: AutomationRunStatus,
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  /**
   * What the run waits on a person for (0.72, CT-328): `approval` — one of its steps waits for a person's yes (a
   * `request_approval` step, or any step whose key asks); `review` — it needs review (a step a person must look at). Null
   * otherwise, also while it waits for an agent, checks or time.
   * The Automations list says so under the row.
   */
  waitingOn: z.enum(['approval', 'review']).nullable(),
});
export type AutomationRunSummary = z.infer<typeof AutomationRunSummary>;

/** How many of an automation's latest runs `Automation.recentRuns` holds (0.72, CT-328). */
export const AUTOMATION_RECENT_RUNS = 10;

/**
 * What starts an automation, for its tile on the Automations list (0.72, CT-328): the kind of its first trigger
 * (`message_posted` is `message`, `reaction_added` is `reaction`).
 */
export const AutomationSource = z.enum([
  'github',
  'tracker',
  'schedule',
  'message',
  'reaction',
  'webhook',
  'manual',
]);
export type AutomationSource = z.infer<typeof AutomationSource>;

/**
 * Something an automation may do, for the list's tags (0.72, CT-328; `automationGlance` has the words): the agent's job
 * (`assess` … `instructions`, or `agent` for a step editor's agent step), then what it does outside the chat.
 */
export const AutomationDoes = z.enum([
  'assess',
  'review',
  'answer',
  'check',
  'instructions',
  'agent',
  'post',
  'approval',
  'comment',
  'write_back',
  'callback',
  'open_pr',
  'fix_ask',
  'fix_auto',
  'merge',
  'reply',
]);
export type AutomationDoes = z.infer<typeof AutomationDoes>;

/**
 * One tag: “Fixes when sure”. `tone` is how far it reaches: `plain` stays in the chat or only reports (an assessment, a
 * comment), `changes` changes code or calls out (a fix, a pull request, a URL), `merges` lands code by itself.
 */
export const AutomationGlanceTag = z.object({
  id: AutomationDoes,
  label: z.string().min(1).max(80),
  tone: z.enum(['plain', 'changes', 'merges']),
});
export type AutomationGlanceTag = z.infer<typeof AutomationGlanceTag>;

/**
 * An automation at a glance (0.72, CT-328; Whombat automation-list.md): what a row of the Automations list shows
 * instead of the summary sentence. `automationGlance` makes it from a definition; the runtime names rooms and tracker
 * connections as it does for `summary`.
 */
export const AutomationGlance = z.object({
  source: AutomationSource,
  /**
   * The repo a GitHub automation watches (`owner/name`, its first GitHub trigger's); the tile shows the owner's picture
   * (`github.avatar`). Null for other sources.
   */
  repo: z.string().min(3).max(255).nullable(),
  /** What starts it, in a few words: “New issue · Fusebox”, “Weekdays at 09:00”, “Message in #bugs”. */
  trigger: z.string().min(1).max(160),
  /** It has a step the agent does (a recipe, or a `dispatch_agent` step). */
  agentStep: z.boolean(),
  /** Where it answers: “Chat”; “a private room” when the viewer isn't in it (BP-C24). */
  room: z.string().min(1).max(120).nullable(),
  /** What it may do, mildest first (`plain`, then `changes`, then `merges`). */
  does: z.array(AutomationGlanceTag).max(12),
});
export type AutomationGlance = z.infer<typeof AutomationGlance>;

/**
 * Where “Talk about it” goes for an automation (Whombat automation-chat.md): the Chat thread of its latest plan —
 * the conversation and the thread's first message.
 */
export const AutomationTalk = z.object({ conversationId: ConversationId, threadRootId: MessageId });
export type AutomationTalk = z.infer<typeof AutomationTalk>;

export const Automation = z.object({
  id: AutomationId,
  burrowId: BurrowId,
  name: z.string().min(1).max(80),
  description: z.string().max(500),
  status: AutomationStatus,
  /** The live version; null until the first publish. */
  currentVersion: z.number().int().positive().nullable(),
  /** The definition being edited (a new draft version), or null when there is none. */
  draft: AutomationDefinition.nullable(),
  /** The draft as last saved, even when it does not validate yet (the editor's JSON). */
  draftJson: JsonObject.nullable(),
  /** Validation problems of the saved draft (empty when it can be published). */
  draftProblems: z.array(z.string()),
  /**
   * `definitionHash` of the valid draft (null when there is none). Publishing sends the hash of the draft the person
   * reviewed; a draft changed since is refused (BP-C21).
   */
  draftHash: z.string().nullable().default(null),
  /** The definition runs use (the current version's), null before the first publish. */
  definition: AutomationDefinition.nullable(),
  /** The automation's own principal: it signs everything the automation does. */
  principalId: PrincipalId,
  createdById: PrincipalId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** Who published the live version (its authority bounds every run). */
  publishedById: PrincipalId.nullable(),
  /**
   * Summary of the live triggers: “Message in #bugs · 🐛 in #bugs”. Rooms the viewer isn’t in read “a private room”
   * (BP-C24).
   */
  triggerSummary: z.string(),
  /**
   * What it does in one sentence (0.66, CT-322; `describeAutomation`): “When a new issue is opened on acme/web, Banjo
   * assesses it and answers in #web.” The live definition's, else the draft's; rooms as in `triggerSummary`.
   */
  summary: z.string().default(''),
  /** Deleted (0.66, `automations.delete`): only its runs still show it; it never runs again. */
  deletedAt: Timestamp.nullable().default(null),
  grants: z.array(AutomationGrant),
  webhook: z.object({ enabled: z.boolean(), hasSecret: z.boolean(), path: z.string() }),
  /** Next scheduled run, when a schedule trigger is live. */
  nextRunAt: Timestamp.nullable(),
  lastRun: AutomationRunSummary.nullable(),
  /**
   * Its latest runs, newest first, at most `AUTOMATION_RECENT_RUNS` (0.72, CT-328): the list's run history.
   */
  recentRuns: z.array(AutomationRunSummary).max(AUTOMATION_RECENT_RUNS),
  /**
   * The live definition at a glance, else the draft's (0.72, CT-328, `automationGlance`). Null for a draft that doesn't
   * validate yet (the list shows `summary`).
   */
  glance: AutomationGlance.nullable(),
  /**
   * The plan waiting for the person's yes (3.9, Whombat automation-chat.md): the list says “Waiting for you” and
   * opens its thread. Null when none waits.
   */
  waitingPlanId: AutomationPlanId.nullable().default(null),
  /** The thread of its latest plan, where “Talk about it” goes (3.9). Null when it has no plan. */
  talk: AutomationTalk.nullable().default(null),
});
export type Automation = z.infer<typeof Automation>;

/* ---------------------------------------------------------------------------------------------- */
/* Runs                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

export const FINISHED_RUN_STATUSES: readonly AutomationRunStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
];

export const AutomationStepState = z.enum([
  'pending',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
  'blocked',
  /** The step's external effect may or may not have happened (a crash mid-step): a person decides. */
  'uncertain',
]);
export type AutomationStepState = z.infer<typeof AutomationStepState>;

export const AutomationTriggerInfo = z.object({
  kind: z.enum(['message_posted', 'reaction_added', 'schedule', 'github', 'webhook', 'manual', 'tracker']),
  /** “Mara in #bugs”, “Every day at 09:00”, “Webhook delivery 7f3c…”. */
  summary: z.string().max(200),
  actorId: PrincipalId.nullable(),
  eventId: EventId.nullable(),
  messageId: MessageId.nullable(),
  /** When a schedule fired: the instant it was due. */
  scheduledFor: Timestamp.nullable(),
});
export type AutomationTriggerInfo = z.infer<typeof AutomationTriggerInfo>;

export const AutomationRunStep = z.object({
  stepId: AutomationStepId,
  index: z.number().int().nonnegative(),
  kind: z
    .enum([
      'dispatch_agent',
      'post_message',
      'request_approval',
      'wait',
      'condition',
      'open_pull_request',
      'http_callback',
      'github_comment',
      'tracker_update',
      'merge_pull_request',
      // 0.75.1 (CT-331): 0.75.0 added the step kind but not here, so a run with a reply didn't parse.
      'tracker_reply',
      'tracker_decision',
      // A kind this version doesn't know (a finished run of an older version's step): shown as an earlier step.
      'unknown',
    ])
    .catch('unknown'),
  name: z.string(),
  state: AutomationStepState,
  attempt: z.number().int().nonnegative(),
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  /** A wait (or a retry backoff) ends then. */
  wakeAt: Timestamp.nullable(),
  /** Short, content-light summary of what went in (“Asked Scout in #repo-checks”). */
  inputSummary: z.string().max(300),
  /** What came out (agent text, approval decision, PR number) — shown to people who can see the run. */
  output: JsonObject,
  error: z.string().max(1000).nullable(),
  dispatchId: DispatchId.nullable(),
  approvalId: ApprovalId.nullable(),
  approvalNumber: z.number().int().positive().nullable(),
  messageIds: z.array(MessageId),
  prNumber: z.number().int().positive().nullable(),
  runNumbers: z.array(z.number().int().positive()),
});
export type AutomationRunStep = z.infer<typeof AutomationRunStep>;

export const AutomationRun = z.object({
  id: AutomationRunId,
  number: z.number().int().positive(),
  burrowId: BurrowId,
  automationId: AutomationId,
  automationName: z.string(),
  /** The version it runs; 0 for a test run of the draft. */
  version: z.number().int().nonnegative(),
  status: AutomationRunStatus,
  trigger: AutomationTriggerInfo,
  conversationId: ConversationId,
  threadRootId: MessageId.nullable(),
  /** Automation-caused events carry this chain; beyond a small depth they trigger nothing. */
  causalDepth: z.number().int().nonnegative(),
  /** Manual/test run started by this person. */
  startedById: PrincipalId.nullable(),
  test: z.boolean(),
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  error: z.string().max(1000).nullable(),
  /** Tokens agents reported in this run's dispatches (null: nobody reported usage). */
  tokens: z.number().int().nonnegative().nullable(),
  steps: z.array(AutomationRunStep),
});
export type AutomationRun = z.infer<typeof AutomationRun>;

/** The shipped templates (automations/templates.ts). */
export const AutomationTemplateId = z.enum(['suspected_bug', 'repo_check']);
export type AutomationTemplateId = z.infer<typeof AutomationTemplateId>;

/** Human-readable label of a step kind. */
export const STEP_KIND_LABELS: Record<AutomationStepKind, string> = {
  dispatch_agent: 'Ask the agent',
  post_message: 'Post a message',
  request_approval: 'Ask a person to approve',
  wait: 'Wait',
  condition: 'Check a condition',
  open_pull_request: 'Open a pull request',
  http_callback: 'Call a URL',
  github_comment: 'Comment on GitHub',
  tracker_update: 'Write back to the tracker',
  merge_pull_request: 'Merge a pull request',
  tracker_reply: 'Reply to the customer',
  tracker_decision: 'Ask you about a feature request',
};

/** What a step kind is called; a kind this version doesn't know (an older version's) is “An earlier step”. */
export function stepKindLabel(kind: string): string {
  return (STEP_KIND_LABELS as Record<string, string>)[kind] ?? 'An earlier step';
}

export const TRIGGER_KIND_LABELS: Record<AutomationTriggerKind, string> = {
  message_posted: 'A message is posted',
  reaction_added: 'A reaction is added',
  schedule: 'On a schedule',
  github: 'Something happens on GitHub',
  webhook: 'A webhook is called',
  manual: 'Only when started by hand',
  tracker: 'A report arrives in a tracker',
};
