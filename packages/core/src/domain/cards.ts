/**
 * Chat cards. On the wire a message carries a resolved card (`MessageCard`): plan, run and approval cards
 * embed the live object so a card renders without extra requests and realtime updates can patch it.
 * In storage a message holds a `StoredCard` where those three are references.
 */
import { z } from 'zod';
import { ApprovalId, DispatchId, PlanId, PrincipalId, RunId } from '../ids.js';
import { Approval } from './approval.js';
import { AutomationPlanCard, StoredAutomationPlanCard } from './automation-plan.js';
import { Count, DiffStat, Timestamp, Tone } from './common.js';
import { CouncilCard } from './council.js';
import { DelegationCard } from './delegation.js';
import { DeployCard } from './deployment.js';
import { DeviceSkillCard } from './devices.js';
import { TURN_FAILURE_REASON_MAX, TurnFailureCode } from './dispatch.js';
import { FeatureRequestCard, StoredFeatureRequestCard } from './feature-request.js';
import { AssessmentCard, StoredAssessmentCard } from './feedback-assessment.js';
import { ReportCard, StoredReportCard } from './feedback-card.js';
import { FindMyWatchCard, StoredFindMyWatchCard } from './findmy-watch.js';
import { GuideCard } from './guides.js';
import { LinkRef } from './links.js';
import { LookPlanCard, StoredLookPlanCard } from './look-research.js';
import { Plan } from './plan.js';
import { Run } from './run.js';
import { ScheduleCard, StoredScheduleCard } from './schedules.js';
import { TaskCard } from './task-card.js';

/** A citation under an agent answer: [n] source · detail. Each receipt deep-links. */
export const Receipt = z.object({
  n: z.number().int().positive(),
  /** "#incidents · 3 Mar 2026" */
  source: z
    .string()
    .min(1)
    .max(160)
    .describe('One source and where it lives: “#incidents · 3 Mar 2026”, “PR #311 · round before format”.'),
  /** "Tom Beck", "merged", "14 messages" */
  detail: z
    .string()
    .max(120)
    .describe(
      'A few words beside the source: who, state, count or section (“Tom Beck”, “merged”, “14 messages”). Not the finding: that goes in the message text with [n].',
    ),
  link: LinkRef.nullable(),
  /** Search result this receipt cites, when it came from search. */
  resultId: z.string().max(80).nullable(),
});
export type Receipt = z.infer<typeof Receipt>;

export const ResearchVerdict = z.enum(['pick', 'no', 'maybe']);
export type ResearchVerdict = z.infer<typeof ResearchVerdict>;

export const RESEARCH_VERDICT_LABELS: Record<ResearchVerdict, string> = {
  pick: 'Pick',
  no: 'No',
  maybe: 'Maybe',
};

export const DiffLineKind = z.enum(['context', 'add', 'del']);
export type DiffLineKind = z.infer<typeof DiffLineKind>;

/** Diff line without its marker; render `+ `, `- ` or two spaces in front. */
export const DiffLine = z.object({ kind: DiffLineKind, text: z.string().max(500) });
export type DiffLine = z.infer<typeof DiffLine>;

export const Commit = z.object({
  sha: z.string().min(4).max(64),
  message: z.string().min(1).max(500),
});
export type Commit = z.infer<typeof Commit>;

export const PlanCard = z.object({ kind: z.literal('plan'), plan: Plan });

export const ResearchCard = z.object({
  kind: z.literal('research'),
  /** "PDF libraries" → header "RESEARCH · PDF LIBRARIES". */
  topic: z.string().min(1).max(80),
  /** "14 sources · 3 tested" */
  sourceCount: Count,
  testedCount: Count,
  rows: z.array(
    z.object({ name: z.string().min(1).max(80), verdict: ResearchVerdict, note: z.string().max(200) }),
  ),
});

export const RunCard = z.object({ kind: z.literal('run'), run: Run });

export const ReviewCard = z.object({
  kind: z.literal('review'),
  prNumber: z.number().int().positive().nullable(),
  /** "billing/pdf/format.ts" */
  file: z.string().min(1).max(500),
  line: z.number().int().positive().nullable(),
  /** Header "REVIEW · 2 CHANGES REQUESTED". */
  changesRequested: Count,
  diff: z.array(DiffLine),
  /** Numbered comments. Inline code in backticks (`formatEuro`). */
  comments: z.array(z.object({ n: z.number().int().positive(), text: z.string().min(1).max(2000) })),
});

export const ApprovalCard = z.object({ kind: z.literal('approval'), approval: Approval });

export const CommitsCard = z.object({
  kind: z.literal('commits'),
  prNumber: z.number().int().positive().nullable(),
  commits: z.array(Commit).min(1),
  /** Footer "+214 −12 · 6 files · signed by Banjo". */
  diff: DiffStat,
  signedById: PrincipalId,
});

/** Status pill: dot + mono text ("38 of 41 passed · 3 failing in invoice_format_test"). */
export const PillCard = z.object({ kind: z.literal('pill'), text: z.string().min(1).max(200), tone: Tone });

/** RECEIPTS block under an agent answer; `query` adds "Open in search". */
export const AnswerCard = z.object({
  kind: z.literal('answer'),
  receipts: z.array(Receipt).min(1),
  query: z.string().max(500).nullable(),
});

/**
 * One item of a digest: a mail, a meeting, a file, a notification. `url` opens it where it lives (the
 * provider's page, in a new tab).
 */
export const DigestItem = z.object({
  /** “15:33”, “Tue”, “09:00–09:30”: short, shown in mono. */
  time: z.string().trim().max(24).nullable().default(null),
  /** The subject, meeting or file name. */
  title: z.string().trim().min(1).max(200),
  /** Who or where it is from: “Lumio”, “Klaas Veenstra”, “#incidents”. */
  source: z.string().trim().max(120).nullable().default(null),
  /** The agent's one-line take: why it matters or what to do. */
  note: z.string().trim().max(300).nullable().default(null),
  url: z.url().max(2048).nullable().default(null),
});
export type DigestItem = z.infer<typeof DigestItem>;

export const DigestSection = z.object({
  /** “Worth a look”, “No action”, “Noise”: shown as a mono label. */
  label: z.string().trim().min(1).max(60),
  items: z.array(DigestItem).min(1).max(50),
  /** Folded to one line of titles until opened (noise, already handled). */
  collapsed: z.boolean().default(false),
});
export type DigestSection = z.infer<typeof DigestSection>;

/**
 * A roundup of several items from one source (docs/decisions/rich-messages.md RM-08): today's inbox, a
 * day's meetings, recent files. Header “INBOX · 7 UNREAD” from `title` and `summary`.
 */
export const DigestCard = z.object({
  kind: z.literal('digest'),
  /** “Inbox”, “Today”, “Drive”. */
  title: z.string().trim().min(1).max(60),
  /** “7 unread”, “4 meetings”. */
  summary: z.string().trim().max(80).nullable().default(null),
  sections: z.array(DigestSection).min(1).max(8),
});

/**
 * A turn that failed for good (0.26, CT-167): on the agent's failure message, server-made only. It says why in a safe
 * sentence (`reason`, from `turnFailureText`) and offers “Try again” (`dispatches.retry`) to people (`canRetryTurn`); after a retry it shows “Tried again” (`retriedAt`, `retryDispatchId`). The same shape is
 * stored.
 */
export const TurnFailedCard = z.object({
  kind: z.literal('turn_failed'),
  dispatchId: DispatchId,
  agentId: PrincipalId,
  code: TurnFailureCode,
  reason: z.string().min(1).max(TURN_FAILURE_REASON_MAX),
  retriedAt: Timestamp.nullable().default(null),
  retryDispatchId: DispatchId.nullable().default(null),
});
export type TurnFailedCard = z.infer<typeof TurnFailedCard>;

/** Whether the viewer gets “Try again” on a `turn_failed` card (CT-167): not retried yet, and the viewer is a person. */
export function canRetryTurn(
  card: Pick<TurnFailedCard, 'retriedAt'>,
  viewer: { id: string; kind: 'person' | 'agent' | 'system' } | undefined,
): boolean {
  return !card.retriedAt && viewer?.kind === 'person';
}

export const MessageCard = z.discriminatedUnion('kind', [
  PlanCard,
  ResearchCard,
  RunCard,
  ReviewCard,
  ApprovalCard,
  CommitsCard,
  PillCard,
  AnswerCard,
  DigestCard,
  /** A Whombat Feedback report's root message (docs/decisions/feedback.md FB-16). */
  ReportCard,
  /** A step of a guide in the person's Chat (assistant-guides.md AG-02); server-made only. */
  GuideCard,
  /** A failed turn with “Try again” (0.26, CT-167); server-made only. */
  TurnFailedCard,
  /** A feedback assessment's verdict, decision and findings on the assessor's reply (0.28, CT-193); server-made only. */
  AssessmentCard,
  /** A turn an agent scheduled for itself, with Cancel (0.44, Whombat RA-30); server-made, resolved per viewer. */
  ScheduleCard,
  /** A recorded deploy (0.55, CT-297, Whombat RF-02); server-made only, the same shape stored. */
  DeployCard,
  /**
   * A device skill Whombat proposes, with tiers, limits and Switch on (0.80, CT-340, one-whombat.md ONE-18); server-made
   * only (`propose_device_skill`), the same shape stored.
   */
  DeviceSkillCard,
  /**
   * A server task Whombat follows in its thread, live while it runs and one line once it ended (0.116, CT-880; Whombat
   * task-feedback.md TF-10); server-made only, the same shape stored.
   */
  TaskCard,
  /**
   * A plan for an automation the agent proposed, with Turn it on, Try it and Not now (3.9, Whombat automation-chat.md);
   * server-made (`draft_automation`), resolved on read.
   */
  AutomationPlanCard,
  /**
   * What the assistant will do on a thing, with Go ahead and Change something (3.11, Whombat handle-it.md); server-made
   * (`look_report` with steps), resolved on read from its research.
   */
  LookPlanCard,
  /**
   * A tracker's feature request put to the person, with its value and Approve, Decline or Ask the customer (3.12,
   * CT-1636; Whombat report-trackers.md TA-44); server-made (`tracker_decision`), resolved on read.
   */
  FeatureRequestCard,
  /**
   * A council the agent leads (Whombat council.md): live while it works, final under its conclusion; server-made only, the
   * same shape stored.
   */
  CouncilCard,
  /**
   * Tasks the agent offers to hand to T3 Code, then their progress (Whombat delegate.md); server-made only, the same
   * shape stored.
   */
  DelegationCard,
  /**
   * A one-time Find My watch with Cancel (Whombat findmy-watch.md); server-made (`findmy_watch`), resolved on read.
   */
  FindMyWatchCard,
]);
export type MessageCard = z.infer<typeof MessageCard>;
export const CARD_KINDS = [
  'plan',
  'research',
  'run',
  'review',
  'approval',
  'commits',
  'pill',
  'answer',
  'digest',
  'report',
  'guide',
  'turn_failed',
  'assessment',
  'schedule',
  'deploy',
  'device_skill',
  'task',
  'automation_plan',
  'look_plan',
  'feature_request',
  'council',
  'delegation',
  'findmy_watch',
] as const;

export type PlanCard = z.infer<typeof PlanCard>;
export type ResearchCard = z.infer<typeof ResearchCard>;
export type RunCard = z.infer<typeof RunCard>;
export type ReviewCard = z.infer<typeof ReviewCard>;
export type ApprovalCard = z.infer<typeof ApprovalCard>;
export type CommitsCard = z.infer<typeof CommitsCard>;
export type PillCard = z.infer<typeof PillCard>;
export type AnswerCard = z.infer<typeof AnswerCard>;
export type DigestCard = z.infer<typeof DigestCard>;

/** Storage form: live objects by reference. */
export const StoredCard = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan'), planId: PlanId }),
  ResearchCard,
  z.object({ kind: z.literal('run'), runId: RunId }),
  ReviewCard,
  z.object({ kind: z.literal('approval'), approvalId: ApprovalId }),
  CommitsCard,
  PillCard,
  AnswerCard,
  DigestCard,
  StoredReportCard,
  GuideCard,
  TurnFailedCard,
  StoredAssessmentCard,
  StoredScheduleCard,
  DeployCard,
  DeviceSkillCard,
  TaskCard,
  StoredAutomationPlanCard,
  StoredLookPlanCard,
  StoredFeatureRequestCard,
  CouncilCard,
  DelegationCard,
  StoredFindMyWatchCard,
]);
export type StoredCard = z.infer<typeof StoredCard>;

/**
 * Cards an agent may post directly with `post_card` (run and approval cards come from their tools). Never `report`,
 * `guide`, `turn_failed`, `assessment`, `schedule`, `deploy`, `device_skill`, `task`, `automation_plan`, `look_plan`,
 * `feature_request`, `council`, `delegation` or `findmy_watch`: those only the server makes, so an agent can't forge one (AG-02; a schedule card from `schedule`,
 * RA-30; a deploy card from `record_deploy`, CT-297; a task card from a followed server task, CT-880; a plan from
 * `draft_automation`; a feature request from its step).
 */
export const PostableCard = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan'), planId: PlanId }),
  ResearchCard,
  ReviewCard,
  CommitsCard,
  PillCard,
  AnswerCard,
  DigestCard,
]);
export type PostableCard = z.infer<typeof PostableCard>;

/** The marker in front of a review diff line. */
export function diffLinePrefix(kind: DiffLineKind): string {
  return kind === 'add' ? '+ ' : kind === 'del' ? '- ' : '  ';
}

/** What each card is called when nothing on it names it better: plain words, never a status like “No reply yet”. */
const CARD_KIND_NAMES: Readonly<Record<(typeof CARD_KINDS)[number], string>> = {
  plan: 'A plan',
  research: 'Research',
  run: 'A run',
  review: 'A review',
  approval: 'Something to approve',
  commits: 'Commits',
  pill: 'A note',
  answer: 'An answer',
  digest: 'A summary',
  report: 'A report',
  guide: 'Set up',
  turn_failed: 'Something went wrong',
  assessment: 'An assessment',
  schedule: 'A scheduled turn',
  deploy: 'A deploy',
  device_skill: 'A device skill',
  task: 'A server task',
  automation_plan: 'An automation',
  look_plan: 'A plan',
  feature_request: 'A feature request',
  council: 'A council',
  delegation: 'Tasks to hand over',
  findmy_watch: 'A watch',
};

/** The first non-empty line of a string field, or null. */
function firstLine(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return (
    v
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? null
  );
}

/**
 * What a thread whose first message is only a card is called, in its row and its head: the card's own title (a guide's
 * “Your email”, a council's, a task's), else the words it leads with (a note's text, a device skill's name, research's
 * topic, a report's summary), else a plain name for its kind. Takes a card as stored or as sent, so the server and the
 * apps call it the same.
 */
export function cardTitle(card: Pick<MessageCard | StoredCard, 'kind'>): string {
  const c = card as {
    kind: string;
    title?: unknown;
    text?: unknown;
    name?: unknown;
    topic?: unknown;
    summary?: unknown;
  };
  const named =
    firstLine(c.title) ??
    firstLine(c.text) ??
    firstLine(c.name) ??
    firstLine(c.topic) ??
    firstLine(c.summary);
  return named ?? CARD_KIND_NAMES[c.kind as (typeof CARD_KINDS)[number]] ?? 'A message';
}
