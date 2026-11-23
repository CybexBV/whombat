/**
 * Chat view model for the person's Chat with the agent (mock bubbles + receipts) and a branch room (not mocked: the
 * same bubbles, plus author names on the agent's messages and compact card summaries).
 * Digest cards pass through whole (docs/decisions/rich-messages.md RM-08), and so do guide cards
 * (docs/decisions/assistant-guides.md AG-15). Pure.
 */

import { replaceEqualDeep } from '@tanstack/query-core';
import {
  ApiError,
  agentWords,
  approvalLine,
  assessmentLine,
  assessmentVerdict,
  attachmentsBesideCard,
  CARD_FRAME_WORDS,
  type CardDisplay,
  type CardFrame,
  type CardMark,
  cardDisplay,
  continuesMessage,
  DECISION_ACTION_HINTS,
  decidedLine,
  deploySettledLine,
  earlierCardLine,
  earlierCardText,
  featureRequestLine,
  findMyWatchLine,
  foldIntoRuns,
  type LookPlanCardView,
  lastReplyLabel,
  lookPlanCardView,
  lookPlanLine,
  lookThreadHref,
  planFocus,
  planFrame,
  planLine,
  type ReportLine,
  RUN_ATTENTION_LABEL,
  type RunChips,
  type RunLineText,
  ranOnSwitches,
  reportLine,
  runAttention,
  runChips,
  runFrame,
  runLineControls,
  runLineText,
  runLiveText,
  runShowsAsLine,
  SCHEDULE_TEXT,
  type SettledLine,
  scheduleLine,
  TASK_TONES,
  taskCardView,
  taskLine,
  textFoldsIntoCard,
  turnFailedLine,
} from '@whombat/client';
import {
  type AssessmentCard,
  type AssessmentDetailRow,
  type Attachment,
  approvalAnswer,
  approvalView,
  assessmentCardLabel,
  assessmentDetailRows,
  assessmentHeadline,
  type ChatRuntimeView,
  type ChatSubject,
  DEPLOYMENT_STATUS_PILLS,
  type DeviceSkillCard,
  type DigestCard,
  dayKey,
  describeScheduleWhen,
  evidenceLine,
  FEEDBACK_OUTCOME_LABELS,
  findMyWatchCardLines,
  formatAdditions,
  formatClock,
  formatCommitsFooter,
  formatDayDivider,
  formatDeletions,
  formatDue,
  formatPlanLabel,
  formatRecent,
  formatResearchLabel,
  formatResearchMeta,
  formatReviewLabel,
  formatRunLabel,
  formatTestsPassing,
  type GuideCard,
  isDeletedMessage,
  isEverydayAsk,
  type LookPlanCard,
  type LookResearch,
  MESSAGE_DELETED_TEXT,
  type Message,
  type MessageCard,
  type MessagePage,
  type Plan,
  type Principal,
  planProgress,
  plural,
  type Receipt,
  type ReportCard,
  type Run,
  reportCardLabel,
  reportCardState,
  runNowText,
  SCHEDULE_STATUS_LABELS,
  scheduleCardTitle,
  type Tone,
} from '@whombat/core';
import { type PlanCardView, planCardView, planDisplay, planSettledLine } from './automationPlan';
import { type RanOnView, ranOnView } from './chatRuntime';
import { type CouncilItem, councilItem } from './council';
import { type DelegationItem, delegationItem } from './delegation';
import { type FeatureRequestCardView, featureDeciderName, featureRequestItem } from './featureRequest';
import { approvalContext, type ViewContext } from './people';
import { type PreviewCard, previewCards, type ReactionPill, reactionPills } from './reactions';
import { type TurnFailedView, turnFailedView } from './turns';
import { type VaultSavedRow, vaultSavedRows } from './vaultSaved';

export interface CardSummary {
  kind: MessageCard['kind'];
  /** Mono label: "PLAN · 4 STEPS", "RUN · LIVE", "NEEDS A PERSON". */
  label: string;
  title: string;
  detail: string | null;
  tone: Tone | null;
  /** Approval cards open the approval screen. */
  approvalNumber: number | null;
  /**
   * An approval card is a door to the approval screen, where it is answered (server-asks-mobile.md AP-1747): while it
   * waits on the viewer, “Review and answer ›”; once answered, where it is (“Scheduled for tonight, 03:00”, Running,
   * Done, “You said no”) under its title.
   */
  approvalDoor?: { waiting: boolean; state: { text: string; tone: 'ok' | 'mut' | 'bad' } | null };
  /** Plan cards offer “Open plan” (the plan screen, work-supervision WS-09). */
  planId?: string | null;
  /**
   * The cards' one layout (docs/decisions/chat-threads-cards.md): the status line, title and sentence of a plan or a
   * run card, the plan's steps under Show more and the technical facts under Details.
   */
  head?: CardHeadModel | null;
  /** A quiet mono line under the card (a report's state: `Burrow Billing · New · Likely bug`), in `tone`. */
  meta?: string | null;
  /** The title is a placeholder rather than content (“Content removed”): shown muted. */
  quiet?: boolean;
  /** The assessor's card (Whombat FB-32): its options while undecided and the full assessment, folded. */
  assessment?: AssessmentCardModel;
  /** A run that changed nothing yet (AP-668): shown as the run line instead of a card; tapping it opens the run. */
  runLine?: RunLineModel | null;
  /** A run with changes (AP-705): the card's progress, diff and PR, Watch run and, on a failed run, Try again. */
  run?: RunCardModel | null;
  /** A run with changes, as its line once done (AP-730, AP-731) and its compact card while it works (AP-733). */
  runSettled?: RunSettledModel | null;
  /** A recorded deploy (contracts 0.55, MX-09): its site, if the deployer named one, and the Deploys board. */
  deploy?: { url: string | null };
  /** A server task Whombat follows (task-feedback.md AP-4305): the live card while it runs, its server's page. */
  task?: TaskCardModel | null;
  /** A one-time Find My watch that still watches (findmy-watch.md): its Cancel. */
  findMyWatch?: { watchId: string } | null;
}

/** A card's head in the one layout, with its time in the person's zone and what folds under it. */
export interface CardHeadModel extends CardFrame {
  /** “11:22”, or null. */
  time: string | null;
  /** The step a plan names (“Current step” · its title). */
  callout: { label: string; text: string } | null;
  /** A plan's steps, under Show more. */
  steps: { id: string; title: string; mark: CardMark; state: string; note: string | null }[];
  /** The technical facts under Details, a line each (`Run #1907 · RUN · FAILED`, the branch, the tests). */
  facts: string[];
}

const STEP_MARK: Record<Plan['steps'][number]['state'], CardMark> = {
  done: 'done',
  active: 'working',
  gate: 'waiting',
  blocked: 'failed',
  queued: 'queued',
  cancelled: 'stopped',
};

/** A plan card's head: its focus step called out, every step under Show more (Details: what it counts). */
export function planHead(plan: Plan, assistant: string, timeZone: string): CardHeadModel {
  const frame = planFrame(plan, assistant);
  const focus = planFocus(plan);
  const { done, total } = planProgress(plan);
  return {
    ...frame,
    time: frame.at ? formatClock(frame.at, timeZone) : null,
    callout: focus ? { label: focus.label, text: focus.step.title } : null,
    steps: plan.steps.map((s) => ({
      id: s.id,
      title: s.title,
      mark: STEP_MARK[s.state],
      state: s.stateLabel,
      note: s.note,
    })),
    facts: [
      `${formatPlanLabel(plan.steps.length)} · ${done} of ${total} done`,
      ...(plan.due ? [formatDue(plan.due)] : []),
    ],
  };
}

/** A run card's head: the run's number, branch, tests and changes under Details. */
export function runHead(run: Run, timeZone: string): CardHeadModel {
  const frame = runFrame(run);
  return {
    ...frame,
    time: frame.at ? formatClock(frame.at, timeZone) : null,
    callout: null,
    steps: [],
    facts: [
      `${CARD_FRAME_WORDS.run(run.number)} · ${formatRunLabel(run.status)}`,
      ...(run.branch ? [`${CARD_FRAME_WORDS.branch}: ${run.branch}`] : []),
      ...(run.tests ? [formatTestsPassing(run.tests)] : []),
    ],
  };
}

/**
 * A server task Whombat follows (contracts 0.116, CT-880; task-feedback.md AP-4305): what the live card shows while it
 * runs — its time ticks on the screen's clock from `startedAt` — and the server whose page it opens. Once it ended the
 * message shows its line (`settledLine`), which opens the card with the runtime's full words.
 */
export interface TaskCardModel {
  serverId: string;
  server: string;
  title: string;
  running: boolean;
  /** “Running”, “Done”, …: the dot's word for TalkBack. */
  state: string;
  /** The card's name: “Task on Home Assistant: Installing 23 updates on Home Assistant”. */
  label: string;
  startedAt: string;
}

/**
 * A run that changed something, in the two forms that aren't its card (docs/decisions/card-settle.md AP-730…AP-733):
 * its line once done or taken over (`Run #3 · Done in 6m 12s` · summary, with `PR #3` and `+12 −8`), and while it works
 * the compact live card's words (`Run #5 · Verify and deploy`, `Now: …`); the elapsed time is the screen's, it ticks.
 */
export interface RunSettledModel {
  runNumber: number;
  line: SettledLine;
  chips: RunChips;
  /** “Watch ›” while live, “Open ›” after (AP-699). */
  link: (typeof RUN_LINE_LINK)[keyof typeof RUN_LINE_LINK];
  /** The compact live card's title: `Run #5 · Verify and deploy`. */
  title: string;
  /** `Now: Running pnpm test`; null when the run says nothing yet. */
  now: string | null;
  /** When it started, for the live card's ticking `3m 12s`. */
  startedAt: string;
  /** 0–100. */
  progress: number;
}

/** A card shown inside its run (AP-732): a scheduled turn or a deploy, as its line, opening its card. */
export interface ChatSubItem {
  id: string;
  line: SettledLine;
  card: CardSummary | null;
}

/** The run line's link on the phone (AP-699): the web's “Watch run” / “Open run”, short, with the phone's chevron. */
const RUN_LINE_LINK = { 'Watch run': 'Watch ›', 'Open run': 'Open ›' } as const;

/** The run line (AP-668): what it says, the run it opens and, while live, its progress. */
export interface RunLineModel extends RunLineText {
  runNumber: number;
  live: boolean;
  progress: number;
  /** “Watch ›” while the run is live, “Open ›” once nothing moves on it (AP-699). */
  link: (typeof RUN_LINE_LINK)[keyof typeof RUN_LINE_LINK];
  /** Try again on a failed run (AP-705). */
  retry: boolean;
  /** Whose run it is, for “Asked Banjo to try again.”. */
  agentName: string;
}

/**
 * The run card on the phone (AP-705), what the web's `RunCard` shows besides the summary: the progress bar while live
 * (still, while it needs a person), the diff (`+42 −7 · 3 files`) and the pull request, and Try again on a failed run.
 */
export interface RunCardModel {
  runNumber: number;
  live: boolean;
  /** 0–100. */
  progress: number;
  /** A live run that needs a person: the bar stands still. */
  attention: boolean;
  diff: { add: string; del: string; files: string } | null;
  /** `PR #482`, once the run opened one. */
  pr: string | null;
  prNumber: number | null;
  retry: boolean;
  agentName: string;
}

export interface AssessmentCardModel {
  reportId: string;
  /** The options while nobody picked one yet; null once decided or when there is no decision. */
  options: { label: string; recommended: boolean; hint: string }[] | null;
  rows: AssessmentDetailRow[];
  evidence: string[];
}

/**
 * The assessor's card (Whombat docs/decisions/feedback.md FB-32): the verdict as the title in its tone (bug reports:
 * Bug, Not a bug, Unsure; else the outcome), the question, who picked what or the folded headline, and the options and
 * the full assessment for the screen to show. The assessor's words are plain text.
 */
export function assessmentSummary(card: AssessmentCard, ctx: ViewContext): CardSummary {
  const verdict = assessmentVerdict(card);
  const decided = card.decided
    ? decidedLine(
        card.decided,
        card.decided.decidedById === ctx.viewer.id ? 'You' : ctx.people.name(card.decided.decidedById),
        formatClock(card.decided.decidedAt, ctx.timeZone),
      )
    : null;
  return {
    kind: 'assessment',
    label: assessmentCardLabel(card),
    title: verdict.text,
    detail: card.decision?.question ?? null,
    meta: decided ?? assessmentHeadline(card.assessment),
    tone: verdict.tone === 'mut' ? null : verdict.tone,
    approvalNumber: null,
    assessment: {
      reportId: card.reportId,
      options:
        card.decision && !card.decided
          ? card.decision.options.map((o) => ({
              label: o.label,
              recommended: o.recommended,
              hint: DECISION_ACTION_HINTS[o.action],
            }))
          : null,
      rows: assessmentDetailRows(card.assessment),
      evidence: card.assessment.evidence.map(evidenceLine),
    },
  };
}

/**
 * A Whombat Feedback report (docs/decisions/feedback.md FB-16): the visitor's summary as plain text (Text
 * renders no Markdown or mentions), the assessment's summary once there is one, and the state line with the
 * screenshot count; failed assessments in the bad tone, blocked ones in warn.
 */
export function reportSummary(card: ReportCard): CardSummary {
  const assessed = card.assessment.state === 'done' && card.assessment.summary;
  const outcome = card.assessment.outcome ? FEEDBACK_OUTCOME_LABELS[card.assessment.outcome] : null;
  const files = card.attachments > 0 ? ` · ${plural(card.attachments, 'screenshot')}` : '';
  return {
    kind: 'report',
    label: reportCardLabel(card),
    title: card.contentRemoved ? 'Content removed' : card.summary,
    quiet: card.contentRemoved,
    detail: assessed ? (outcome ? `${outcome}: ${card.assessment.summary}` : card.assessment.summary) : null,
    meta: `${reportCardState(card)}${files}`,
    tone: card.assessment.state === 'failed' ? 'bad' : card.assessment.state === 'blocked' ? 'warn' : null,
    approvalNumber: null,
  };
}

/** A card as it was on a message before it moved on: its folded line, and the card to open read-only. */
export interface EarlierItem {
  /** “Tasks · earlier version · 5 tasks”. */
  line: string;
  /** The copy read out for screen readers (`earlierCardText`). */
  spoken: string | null;
  council: CouncilItem | null;
  delegation: DelegationItem | null;
}

export interface ChatItem {
  id: string;
  /**
   * The row's list key: the client's id while it has one, so a message just sent keeps its row when the server's copy
   * (another id) replaces it, instead of being drawn again.
   */
  key?: string;
  mine: boolean;
  authorId: string;
  authorName: string;
  /** Name + avatar above the first of consecutive messages by the same author, the viewer's own too (AP-706). */
  showAuthor: boolean;
  /**
   * The same author's next message, without its author line: a faint line above it shows where it starts
   * (chat-polish.md AP-6144).
   */
  continues: boolean;
  /**
   * Its time as it reads once its first minute is over (`09:13`, `Yesterday`): the row says “just now” before that
   * (`sentLabel`), so the items don't change with the clock.
   */
  time: string;
  /** When it was sent, for the row's “just now”. */
  sentAt: string;
  text: string;
  /** RECEIPTS card under an agent answer. */
  receipts: Receipt[] | null;
  /** A digest card, shown whole (sections of tappable items), not as a summary. */
  digest: DigestCard | null;
  /** A guide card in the assistant's DM (AG-15), shown whole and actionable. */
  guide: GuideCard | null;
  /**
   * A device skill Whombat proposes (one-whombat-mobile.md AP-1368): shown whole — what it reads, Off · Ask me · Allowed
   * per action, Switch on — and as its decided state once you chose.
   */
  deviceSkill: DeviceSkillCard | null;
  /**
   * A plan for an automation the agent proposed (Whombat automation-chat.md): shown whole while it waits — Turn it on,
   * Try it, Not now — and as its line (`line`) once decided, which opens it in place. Null on every other message and
   * while the plan isn't resolved.
   */
  automationPlan: PlanCardView | null;
  /**
   * The assistant's plan for a thing (Whombat handle-it.md): shown whole while it waits, is taken or says what was done,
   * and as its line once no longer needed. Null on every other message and while it isn't resolved.
   */
  lookPlan: LookPlanItem | null;
  /**
   * A tracker's feature request put to the person: shown whole while it waits — its value, Approve, Approve and build,
   * Decline, Ask the customer — and as its line (`line`) once decided, replaced or stopped, which opens it in place. Null
   * on every other message and while it isn't resolved.
   */
  featureRequest: FeatureRequestCardView | null;
  /**
   * A council the agent leads (Whombat council.md CNL-40, CNL-42): always the whole card — live while its members work
   * (their marks, states and scores, Go ahead on the plan, Stop), final under the agent's conclusion (the scores, the
   * plan, the pictures of what changed). The message's words are the agent's latest thoughts, above it. Null on every
   * other message.
   */
  council: CouncilItem | null;
  /**
   * Tasks the agent offers to hand to T3 Code (Whombat delegate.md): always the whole card — the checklist with Hand
   * over while it waits for the person, then each task's progress until all of them ended. The message's words are the
   * agent's intro, above it; its latest words show under it. Null on every other message.
   */
  delegation: DelegationItem | null;
  /**
   * Its council or Tasks card as it was here, kept because the person talked after it (Whombat card-moves.md):
   * one folded line that opens it read-only, with the link to the newest. Absent or null otherwise.
   */
  earlier?: EarlierItem | null;
  card: CardSummary | null;
  /** Files on the message (docs/decisions/bp-attachments.md), without the ones a council card shows as its pictures. */
  attachments: Attachment[];
  /** Optimistic copy that has not reached the server yet. */
  sending: boolean;
  /** `3 replies` under a thread root, which opens the thread (a handoff's lane, DG-18); null without replies. */
  replies: string | null;
  /** Its last repliers (up to three), their faces before `3 replies` as Slack has them (AP-944); empty without replies. */
  replyHeads: Principal[];
  /**
   * When the thread's last reply came, for `Last reply 2 hours ago` after `3 replies` (AP-944), which its row words on
   * the clock (`lastReplyText`); null without replies.
   */
  lastReplyAt: string | null;
  /**
   * What a thread in Chat is about (contracts 0.93 `Message.subject`, CHT-05; chat-channel.md AP-2459): a chip on its
   * first message in the room; inside the thread the header shows it.
   */
  subject: ChatSubject | null;
  /**
   * What answered an assistant's reply in Chat (contracts 0.96 `Message.ranOn`, CR-07, CR-08; chat-runtime-android.md
   * AP-2725…): its mark after the time, the divider above it when it ran on something else than the thread's previous
   * reply, and the quiet lines under it. Null elsewhere (only the Chat room asks for it, `options.ranOn`).
   */
  ranOn: RanOnView | null;
  /** A deleted thread root kept for its replies: “This message was deleted.”, quietly (CT-173, AP-503). */
  deleted: boolean;
  /** Edited after it was sent: “(edited)” beside the time (CT-173). */
  edited: boolean;
  /** Pinned in its conversation (CT-174). */
  pinned: boolean;
  /** Reactions as pills under the message (AP-507). */
  reactions: ReactionPill[];
  /** Compact cards for the links in it (CT-174, AP-508). */
  previews: PreviewCard[];
  /**
   * “Saved to your Vault · Plex” under it once Whombat blanked a secret in it (contracts 0.112 `Message.vaultSaved`,
   * vault-self-serve.md VS-07; AP-4037), each opening its entry; empty on every other message.
   */
  vaultSaved: VaultSavedRow[];
  /** A failed turn's card with Try again (CT-167, AP-500); null on every other message. */
  turnFailed: TurnFailedView | null;
  /**
   * How its card shows (docs/decisions/card-settle.md AP-730): `full` the card, `line` one line that opens the card in
   * place, `live` a run's compact live card; null without a card.
   */
  display: CardDisplay | null;
  /** The settled card's line (AP-731) when `display` is `line`, except a run's (`card.runLine`, `card.runSettled`). */
  line: SettledLine | null;
  /**
   * A report's row in its conversation (docs/decisions/report-rows.md RR-01, RR-02): the outcome and one sentence over
   * the reference and the facts; Details opens the card in place. Null in its thread, where the root is the card (RR-07).
   */
  report?: ReportLine | null;
  /** What its run did, shown inside it (AP-732): scheduled turns and deploys, oldest first. */
  inside: ChatSubItem[];
  /** A day divider above it, the first of its calendar day in the viewer's zone (`Today · Wednesday 7 October`, MX-05). */
  day: string | null;
  /** The “New” line above it: the first message by someone else after where the viewer had read (MX-05). */
  unread: boolean;
  /**
   * Its thread is settled (contracts 3.8 `Message.settled`; chat-settle.md AP-6251): a room leaves it to Settled, or,
   * kept for a link, says “Settled” after the time. False inside a thread and for replies.
   */
  settled: boolean;
}

/** The line above the first unread message (MX-05). */
export const UNREAD_MARKER_TEXT = 'New';

/**
 * The first message the viewer hadn't read when they opened the conversation (MX-05): the first one by someone else
 * after `readUpTo` (the conversation's `lastReadMessageId` at open). When that message isn't loaded but older pages are
 * still to come (`moreAbove`), everything loaded is newer: the first loaded one by someone else. Null without a read
 * point (a conversation never read, a thread) or when nothing after it is someone else's.
 */
export function firstUnreadId(
  messages: readonly Pick<Message, 'id' | 'authorId'>[],
  readUpTo: string | null | undefined,
  viewerId: string,
  moreAbove: boolean,
): string | null {
  if (!readUpTo) return null;
  const at = messages.findIndex((m) => m.id === readUpTo);
  if (at < 0 && !moreAbove) return null;
  const next = messages.slice(at + 1).find((m) => m.authorId !== viewerId && !m.id.startsWith('msg_local-'));
  return next?.id ?? null;
}

/** Infinite pages (page 0 newest, each oldest first) → one list, oldest first, without duplicates. */
export function flattenPages(pages: readonly MessagePage[] | undefined): Message[] {
  if (!pages) return [];
  const seen = new Set<string>();
  const out: Message[] = [];
  for (let i = pages.length - 1; i >= 0; i--) {
    for (const m of pages[i]?.messages ?? []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

/** The card as it was on this message, folded; null when it keeps none. */
function earlierItem(m: Message, ctx: ViewContext): EarlierItem | null {
  const card = m.earlierCard;
  const line = earlierCardLine(m);
  if (!card || !line) return null;
  const now = ctx.now.getTime();
  return {
    line,
    spoken: earlierCardText(m),
    // A copy doesn't tick: nothing on it is at work now.
    council: card.kind === 'council' ? { ...councilItem(card, [], now), ticking: false } : null,
    delegation:
      card.kind === 'delegation'
        ? {
            ...delegationItem(card, [], now, ctx.people.agent?.name ?? ctx.people.name(m.authorId)),
            ticking: false,
          }
        : null,
  };
}

export function cardSummary(card: MessageCard | null, ctx: ViewContext): CardSummary | null {
  if (!card) return null;
  const base = { kind: card.kind, tone: null, approvalNumber: null } as const;
  switch (card.kind) {
    case 'plan': {
      // Cancelled steps don't count (WS-02).
      const { done, total } = planProgress(card.plan);
      return {
        ...base,
        label: formatPlanLabel(card.plan.steps.length),
        title: card.plan.title,
        detail: `${done} of ${total} done`,
        planId: card.plan.id,
        head: planHead(card.plan, agentWords(ctx.people.agent?.name).name, ctx.timeZone),
      };
    }
    case 'research':
      return {
        ...base,
        label: formatResearchLabel(card.topic),
        title: card.rows.map((r) => r.name).join(', '),
        detail: formatResearchMeta(card.sourceCount, card.testedCount),
      };
    case 'run': {
      // A live run that needs a person says why instead of “Now: …”, in warn (CT-197, AP-597).
      const r = card.run;
      const attention = runAttention(r);
      const live = r.status === 'live';
      const progress = Math.max(0, Math.min(100, r.progress));
      const controls = runLineControls(r);
      const agentName = ctx.people.name(r.agentId);
      const runLine: RunLineModel | null = runShowsAsLine(r)
        ? {
            ...runLineText(r),
            runNumber: r.number,
            live,
            progress,
            link: RUN_LINE_LINK[controls.link],
            retry: controls.retry,
            agentName,
          }
        : null;
      const settled = runLineText(r);
      const liveText = runLiveText(r, 0);
      return {
        ...base,
        runLine,
        runSettled: runLine
          ? null
          : {
              runNumber: r.number,
              line: settled,
              chips: runChips(r),
              link: RUN_LINE_LINK[controls.link],
              title: liveText.title,
              now: liveText.now,
              startedAt: r.startedAt,
              progress,
            },
        run: runLine
          ? null
          : {
              runNumber: r.number,
              live,
              progress,
              attention: attention !== null,
              diff:
                r.diff.files > 0
                  ? {
                      add: formatAdditions(r.diff.add),
                      del: formatDeletions(r.diff.del),
                      files: plural(r.diff.files, 'file'),
                    }
                  : null,
              pr: r.prNumber ? `PR #${r.prNumber}` : null,
              prNumber: r.prNumber,
              retry: controls.retry,
              agentName,
            },
        head: runLine ? null : runHead(r, ctx.timeZone),
        label: formatRunLabel(r.status),
        title: r.title,
        detail: attention ? `${RUN_ATTENTION_LABEL} · ${attention}` : runNowText(r),
        tone: attention ? 'warn' : live ? 'ok' : null,
      };
    }
    case 'review':
      return {
        ...base,
        label: formatReviewLabel(card.changesRequested),
        title: card.line ? `${card.file}:${card.line}` : card.file,
        detail: card.comments[0]?.text ?? null,
        tone: 'bad',
      };
    case 'approval': {
      const vc = approvalContext(ctx, card.approval);
      const view = approvalView(card.approval, vc);
      const everyday = isEverydayAsk(card.approval);
      const waiting = card.approval.state === 'pending' && (view.canApprove || view.canDecline);
      const state = everyday ? approvalAnswer(card.approval, vc) : null;
      return {
        ...base,
        // An everyday ask in plain words (handle-it.md): “Neo needs your OK”.
        label: view.ask?.needs ?? view.label,
        title: view.title,
        // What a yes does, when the data says: why the agent runs a command, what code's approval rolls out. An everyday
        // ask's “won’t do it without a person” only repeats the card, and once answered its state says where it is.
        detail:
          view.why && view.phase === 'needs_person'
            ? view.why
            : everyday && (view.ask || state)
              ? null
              : view.message,
        tone: view.tone,
        approvalNumber: card.approval.number,
        approvalDoor: { waiting, state: state ? { text: state.text, tone: state.tone } : null },
      };
    }
    case 'commits':
      return {
        ...base,
        label: card.commits.length === 1 ? '1 COMMIT' : `${card.commits.length} COMMITS`,
        title: card.commits[0]?.message ?? '',
        detail: formatCommitsFooter(card.diff, ctx.people.name(card.signedById)),
      };
    case 'pill':
      return { ...base, label: '', title: card.text, detail: null, tone: card.tone };
    case 'report':
      return reportSummary(card);
    case 'assessment':
      return assessmentSummary(card, ctx);
    case 'schedule': {
      // A turn an agent scheduled for itself (RA-30, AP-691): read on the phone, cancelled on the web.
      const s = card.schedule;
      if (!s) return { ...base, label: 'SCHEDULE', title: SCHEDULE_TEXT.gone, detail: null, quiet: true };
      return {
        ...base,
        label: `SCHEDULE · ${SCHEDULE_STATUS_LABELS[s.status].toUpperCase()}`,
        title: scheduleCardTitle(ctx.people.name(s.agentId), s),
        detail: describeScheduleWhen(s.when, ctx.timeZone, ctx.now),
        tone: s.status === 'active' ? 'ok' : s.status === 'paused' ? 'warn' : null,
      };
    }
    case 'deploy': {
      // A recorded deploy (contracts 0.55, CT-297; MX-09): settled at once, so a line that opens this card.
      const ok = card.status === 'succeeded';
      return {
        ...base,
        label: DEPLOYMENT_STATUS_PILLS[card.status],
        title: `${card.service} to ${card.environment}`,
        detail: null,
        meta: card.sha ? deploySettledLine(card).detail : null,
        tone: ok ? 'ok' : 'bad',
        deploy: { url: card.url ?? null },
      };
    }
    case 'task': {
      // The live card while it runs; once ended the card its line opens: the full words, the server and the time.
      const view = taskCardView(card, ctx.now.getTime());
      const tone = TASK_TONES[card.state];
      const running = card.state === 'running';
      return {
        ...base,
        label: `TASK · ${view.state.toUpperCase()}`,
        title: card.title,
        detail: card.result,
        meta: running ? card.server : [card.server, view.elapsed].filter(Boolean).join(' · '),
        tone: tone === 'ok' || tone === 'warn' || tone === 'bad' ? tone : null,
        task: {
          serverId: card.serverId,
          server: card.server,
          title: card.title,
          running,
          state: view.state,
          label: view.label,
          startedAt: card.startedAt,
        },
      };
    }
    case 'findmy_watch': {
      // A one-time Find My watch (findmy-watch.md), every word core's: what it waits for and until when, with Cancel
      // while it watches. One nobody can read any more leaves the message's words alone.
      if (!card.watch) return null;
      const lines = findMyWatchCardLines(card.watch, ctx.timeZone, ctx.now);
      return {
        ...base,
        label: '',
        title: lines.title,
        detail: lines.detail,
        findMyWatch: lines.canCancel ? { watchId: card.watchId } : null,
      };
    }
    case 'answer':
    case 'digest':
    case 'guide':
    // Shown whole (`ChatItem.deviceSkill`, `ChatItem.automationPlan`).
    case 'device_skill':
    case 'automation_plan':
    // Shown whole (`ChatItem.lookPlan`, `ChatItem.featureRequest`).
    case 'look_plan':
    case 'feature_request':
    // Shown whole (`ChatItem.council`, `ChatItem.delegation`).
    case 'council':
    case 'delegation':
    // A failed turn has its own view (`ChatItem.turnFailed`, AP-500).
    case 'turn_failed':
      return null;
    default:
      // A card kind this app doesn't know yet: the message's own text still shows.
      return null;
  }
}

/** A thing's plan as its row draws it: the card's view, the research Go ahead sends, the thread Change something opens. */
export interface LookPlanItem {
  view: LookPlanCardView;
  research: LookResearch | null;
  thread: string | null;
}

/** The `look_plan` card as a row draws it; null when there is nothing to draw (its research is gone). */
export function lookPlanItem(card: LookPlanCard): LookPlanItem | null {
  const view = lookPlanCardView(card.plan);
  if (!view) return null;
  const research = card.plan?.research ?? null;
  return { view, research, thread: research ? lookThreadHref(research) : null };
}

/**
 * A settled card's line (docs/decisions/card-settle.md AP-731), for the cards that aren't runs (a run's line is
 * `card.runLine` or `card.runSettled`): approval, plan, schedule, assessment, a feature request, a retried failed
 * turn and an ended Find My watch. Null while the card is still a card, and for a card without a line. `authorId`: who posted it, the agent of a
 * schedule the viewer can't read.
 */
export function settledLine(
  card: MessageCard | null | undefined,
  ctx: ViewContext,
  authorId: string,
): SettledLine | null {
  // A plan's line is the phone's own: the shared rules don't know the card yet.
  if (card?.kind === 'automation_plan')
    return card.plan
      ? planSettledLine(card.plan, {
          viewerId: ctx.viewer.id,
          name: ctx.people.name,
          now: ctx.now,
          timeZone: ctx.timeZone,
        })
      : null;
  if (!card || cardDisplay(card) !== 'line') return null;
  switch (card.kind) {
    case 'look_plan':
      return lookPlanLine(card.plan);
    case 'feature_request':
      // Who decided, by name, as an approval's line says it.
      return card.request
        ? featureRequestLine(card.request, featureDeciderName(card.request, ctx.people))
        : null;
    case 'approval':
      return approvalLine(
        card.approval,
        card.approval.decidedById ? ctx.people.name(card.approval.decidedById) : null,
      );
    case 'plan':
      return planLine(card.plan);
    case 'schedule':
      return scheduleLine(
        card,
        ctx.people.name(card.schedule?.agentId ?? authorId),
        ctx.timeZone,
        ctx.now.getTime(),
      );
    case 'assessment':
      return assessmentLine(card);
    case 'turn_failed':
      return turnFailedLine(card, ctx.timeZone);
    case 'deploy':
      return deploySettledLine(card);
    case 'task':
      return taskLine(card, ctx.now.getTime());
    case 'findmy_watch':
      return card.watch ? findMyWatchLine(card.watch, ctx.timeZone, ctx.now.getTime()) : null;
    default:
      return null;
  }
}

export function chatItems(
  messages: readonly Message[],
  ctx: ViewContext,
  /**
   * `threads`: offer “N replies” under roots (not inside a thread, where the replies follow the root). `retry`: the
   * runtime can retry a failed turn (`dispatches.retry`; true when absent).
   */
  /**
   * `readUpTo` / `moreAbove`: where the viewer had read when the conversation opened and whether older pages are still to
   * come, for the “New” line (MX-05, `firstUnreadId`). `previews`: the conversation shows link previews (Whombat EC-23,
   * `conversationLinkPreviewsOn`; true when absent): off leaves out the cards its messages already have (AP-1102).
   * `everyAuthor`: each message has its author line, also after one by the same author (a threaded room, where every
   * top-level message is a thread of its own: chat-channel.md AP-2453). `ranOn`: the Chat room, where the agent's reply
   * says what answered it (chat-runtime-android.md AP-2725…); `switches` draws the divider when that changed (in a
   * thread), and `view` (`chats.runtime`) names a skipped model.
   */
  options: {
    authors: boolean;
    ranOn?: { switches: boolean; view?: Pick<ChatRuntimeView, 'providers'> | null } | null;
    everyAuthor?: boolean;
    previews?: boolean;
    threads?: boolean;
    retry?: boolean;
    readUpTo?: string | null;
    moreAbove?: boolean;
  },
): ChatItem[] {
  const me = ctx.viewer.id;
  // The message shown before, for whether the next one continues it (the web's rule, `continuesMessage`).
  let previous: Message | null = null;
  // Day dividers and the “New” line (MX-05): the first item of each day, the first item at or after the first unread.
  let previousDay: string | null = null;
  const unreadId = firstUnreadId(messages, options.readUpTo, me, options.moreAbove === true);
  const unreadAt = unreadId ? messages.findIndex((m) => m.id === unreadId) : -1;
  let unreadShown = false;
  const labels = timeLabels(ctx.now, ctx.timeZone);
  // In a thread, the dividers before replies that ran on something else than the one before (CR-07).
  const shownRanOn = options.ranOn ?? null;
  const switches = shownRanOn?.switches ? ranOnSwitches(messages) : null;
  const ranOnOf = (m: Message): RanOnView | null =>
    shownRanOn ? ranOnView(m, switches?.get(m.id), shownRanOn.view) : null;
  const marks = (m: Message, index: number): Pick<ChatItem, 'day' | 'unread'> => {
    const key = labels.dayKey(m.createdAt);
    const day = key !== previousDay ? labels.divider(m.createdAt) : null;
    previousDay = key;
    const unread = !unreadShown && unreadAt >= 0 && index >= unreadAt;
    if (unread) unreadShown = true;
    // After a divider or the “New” line the author is named again.
    if (day || unread) previous = null;
    return { day, unread };
  };
  // What a run did shows inside the run (AP-732): those messages leave the list, their lines go under the run.
  const folds = foldIntoRuns(messages);
  const subItem = (m: Message): ChatSubItem | null => {
    const line = settledLine(m.card, ctx, m.authorId);
    return line ? { id: m.id, line, card: cardSummary(m.card ?? null, ctx) } : null;
  };
  return messages.flatMap((m, index): ChatItem[] => (folds.hidden.has(m.id) ? [] : [item(m, index)]));

  function item(m: Message, index: number): ChatItem {
    const mark = marks(m, index);
    const mine = m.authorId === me;
    // Messages are flat rows, the viewer's own too (AP-706): the author line says who wrote it.
    // The same author's next message moments later runs on without it; after a pause it says who and when again.
    const showAuthor = options.authors && (options.everyAuthor === true || !continuesMessage(previous, m));
    const continues = options.authors && !showAuthor;
    previous = m;
    const thread = options.threads !== false && m.threadRootId === null && m.replyCount > 0;
    const replies = thread ? plural(m.replyCount, 'reply', 'replies') : null;
    const replyHeads = thread
      ? m.threadParticipantIds
          .slice(0, 3)
          .map((id) => ctx.people.get(id))
          .filter((p): p is Principal => !!p)
      : [];
    const lastReplyAt = thread && m.lastReplyAt ? m.lastReplyAt : null;
    // Only a room's list leaves a settled thread out (AP-6251); inside it the root is the thread's head.
    const settledRoot = options.threads !== false && m.threadRootId === null && !!m.settled;
    if (isDeletedMessage(m))
      // What's left of a deleted thread root: the replies (CT-173).
      return {
        id: m.id,
        key: m.clientId ? `c-${m.clientId}` : m.id,
        mine,
        authorId: m.authorId,
        authorName: ctx.people.name(m.authorId),
        showAuthor,
        continues,
        time: labels.settled(m.createdAt),
        sentAt: m.createdAt,
        text: MESSAGE_DELETED_TEXT,
        receipts: null,
        digest: null,
        guide: null,
        deviceSkill: null,
        automationPlan: null,
        lookPlan: null,
        featureRequest: null,
        council: null,
        delegation: null,
        card: null,
        attachments: [],
        sending: false,
        replies,
        replyHeads,
        lastReplyAt,
        subject: null,
        ranOn: null,
        deleted: true,
        edited: false,
        pinned: false,
        reactions: [],
        previews: [],
        vaultSaved: [],
        turnFailed: null,
        display: null,
        line: null,
        report: null,
        inside: [],
        settled: settledRoot,
        ...mark,
      };
    const failed =
      m.card?.kind === 'turn_failed'
        ? turnFailedView(m.card, {
            text: m.text,
            agent: ctx.people.get(m.card.agentId),
            viewer: { id: me, kind: ctx.viewer.kind },
            retryFeature: options.retry !== false,
            timeZone: ctx.timeZone,
          })
        : null;
    // In a thread the root is the whole report (RR-07); in the conversation its row (RR-02).
    const inThread = options.threads === false;
    const report = m.card?.kind === 'report' && !inThread ? reportLine(m.card) : null;
    return {
      id: m.id,
      key: m.clientId ? `c-${m.clientId}` : m.id,
      mine,
      authorId: m.authorId,
      authorName: ctx.people.name(m.authorId),
      showAuthor,
      continues,
      time: labels.settled(m.createdAt),
      sentAt: m.createdAt,
      // The header the server posts a report with folds into its row or card (RR-04).
      text: textFoldsIntoCard(m.text, m.card) ? '' : m.text,
      receipts: m.card?.kind === 'answer' ? m.card.receipts : null,
      digest: m.card?.kind === 'digest' ? m.card : null,
      guide: m.card?.kind === 'guide' ? m.card : null,
      deviceSkill: m.card?.kind === 'device_skill' ? m.card : null,
      automationPlan:
        m.card?.kind === 'automation_plan' && m.card.plan
          ? planCardView(m.card.plan, ctx.people.agent?.name ?? ctx.people.name(m.authorId))
          : null,
      lookPlan: m.card?.kind === 'look_plan' ? lookPlanItem(m.card) : null,
      featureRequest: featureRequestItem(m.card, ctx.people),
      council: m.card?.kind === 'council' ? councilItem(m.card, m.attachments, ctx.now.getTime()) : null,
      // A question a task asks the assistant reads “Asked Dusty”: the assistant is the card's author.
      delegation:
        m.card?.kind === 'delegation'
          ? delegationItem(
              m.card,
              m.attachments,
              ctx.now.getTime(),
              ctx.people.agent?.name ?? ctx.people.name(m.authorId),
            )
          : null,
      earlier: earlierItem(m, ctx),
      card: cardSummary(m.card, ctx),
      attachments: ownAttachments(m),
      sending: m.id.startsWith('msg_local-'),
      replies,
      replyHeads,
      lastReplyAt,
      subject: !inThread && m.threadRootId === null ? (m.subject ?? null) : null,
      ranOn: ranOnOf(m),
      deleted: false,
      edited: m.editedAt !== null && m.editedAt !== undefined,
      pinned: Boolean(m.pinnedAt),
      reactions: reactionPills(m.reactions),
      previews: options.previews === false ? [] : previewCards(m.previews),
      vaultSaved: vaultSavedRows(m.vaultSaved),
      turnFailed: failed,
      display: m.card ? cardDisplayHere(m.card, inThread) : null,
      line: m.card?.kind === 'run' ? null : settledLine(m.card, ctx, m.authorId),
      report,
      inside: (folds.inside.get(m.id) ?? []).flatMap((n) => subItem(n) ?? []),
      settled: settledRoot,
      ...mark,
    };
  }
}

/**
 * A message's files for its own row: a council's pictures and a delegation task's show in the card, not
 * a second time.
 */
function ownAttachments(m: Message): Attachment[] {
  return attachmentsBesideCard(m.attachments, m.card) as Attachment[];
}

/** How a message's card shows here: a report is whole in its thread (RR-07), a plan by its own rule. */
function cardDisplayHere(card: MessageCard, inThread: boolean): CardDisplay {
  if (card.kind === 'report' && inThread) return 'full';
  if (card.kind === 'automation_plan') return planDisplay(card);
  return cardDisplay(card);
}

/**
 * A conversation's time labels, kept (AP-901): its items are rebuilt with every new message and every step of `now`,
 * and each label is one to three `Intl` calls (`formatToParts`, slow on Hermes). A message's day is its moment's and the
 * zone's alone; its `formatRecent` and day divider depend on `now` only through the day `now` falls on — except
 * `just now`, which is not kept (and needs no `Intl`).
 */
const labelCache = new Map<string, string>();
const LABEL_CACHE_MAX = 5000;

function kept(key: string, make: () => string): string {
  let label = labelCache.get(key);
  if (label === undefined) {
    if (labelCache.size >= LABEL_CACHE_MAX) labelCache.clear();
    label = make();
    labelCache.set(key, label);
  }
  return label;
}

/**
 * `dayKey`, `formatRecent` and `formatDayDivider` at `now`, with the same results, kept by
 * message moment.
 */
export function timeLabels(now: Date, timeZone: string) {
  const at = now.getTime();
  const day = (moment: string) => kept(`d|${timeZone}|${moment}`, () => dayKey(moment, timeZone));
  const today = day(now.toISOString());
  return {
    dayKey: day,
    recent(moment: string): string {
      const age = at - Date.parse(moment);
      if (age >= 0 && age < 60_000) return formatRecent(moment, now, timeZone);
      return kept(`r|${timeZone}|${today}|${moment}`, () => formatRecent(moment, now, timeZone));
    },
    /**
     * The label once the moment's first minute is over: `recent`, except that a moment under a minute old reads as it
     * will a minute after it (its time, not `just now`).
     */
    settled(moment: string): string {
      const sent = Date.parse(moment);
      const age = at - sent;
      if (age < 0 || age >= JUST_NOW_MS) return this.recent(moment);
      return formatRecent(moment, new Date(sent + JUST_NOW_MS), timeZone);
    },
    divider: (moment: string) =>
      kept(`v|${timeZone}|${today}|${moment}`, () => formatDayDivider(moment, now, timeZone)),
  };
}

/** The day `now` falls on in `timeZone` (`dayKey`), asked of `Intl` once per step of the clock. */
export function dayOf(now: Date, timeZone: string): string {
  const moment = now.toISOString();
  return kept(`d|${timeZone}|${moment}`, () => dayKey(moment, timeZone));
}

/** How long a message reads “just now” (core's `formatRecent`). */
export const JUST_NOW_MS = 60_000;

const WEEK_MS = 7 * 24 * 60 * 60_000;

/**
 * What a message's author line says at `now`: `just now` in its first minute, else its kept `settled` label. A row
 * follows the clock only while `sentFollowsClock`.
 */
export function sentLabel(sentAt: string, settled: string, now: Date, timeZone: string): string {
  const age = now.getTime() - Date.parse(sentAt);
  return age >= 0 && age < JUST_NOW_MS ? formatRecent(sentAt, now, timeZone) : settled;
}

/** Whether a message's author line can still change: within its first minute (or sent “later” than the clock). */
export function sentFollowsClock(sentAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(sentAt) < JUST_NOW_MS;
}

/**
 * `Last reply 12 min ago` at `now` (AP-944): no `Intl` within a week; from a week on it is a date, kept like the other
 * labels.
 */
export function lastReplyText(moment: string, now: Date, timeZone: string): string {
  if (lastReplyFollowsClock(moment, now)) return lastReplyLabel(moment, now, timeZone);
  return kept(`l|${timeZone}|${now.getUTCFullYear()}|${moment}`, () => lastReplyLabel(moment, now, timeZone));
}

/** Whether `Last reply …` still changes with the clock: within a week (`12 min ago`, `3 days ago`). */
export function lastReplyFollowsClock(moment: string, now: Date): boolean {
  return now.getTime() - Date.parse(moment) < WEEK_MS;
}

/**
 * The items as they were where nothing changed (AP-901): an item deep-equal to the one before with its id is that
 * object, and the list is the same array when every item is, so the chat's memoised rows re-render only for what
 * changed — not for every new message, step of `now` or older page.
 */
export function keepSameItems(previous: readonly ChatItem[], next: ChatItem[]): ChatItem[] {
  if (!previous.length) return next;
  const before = new Map(previous.map((i) => [i.id, i]));
  let same = previous.length === next.length;
  const items = next.map((item, index) => {
    const old = before.get(item.id);
    const keep = old ? replaceEqualDeep(old, item) : item;
    if (keep !== previous[index]) same = false;
    return keep;
  });
  return same ? (previous as ChatItem[]) : items;
}

/**
 * Why a conversation did not open, and whether trying again can help. The server answers 404 (or 403) for a
 * conversation one is not in, the same as for one that does not exist (no probing), so both read as not
 * being in it; only the connection and the server's own trouble offer Try again.
 */
export function conversationLoadError(error: unknown): { text: string; retry: boolean } {
  const status = error instanceof ApiError ? error.status : null;
  if (status === 403 || status === 404) return { text: 'You’re not in this conversation.', retry: false };
  return { text: 'This conversation didn’t load.', retry: true };
}

/** A thread screen's header: `Thread`, and `#billing-v2 · Collect the merged PRs` (the topic when there is one). */
export function threadHeader(view: { where: string; topic: string | null } | undefined): {
  title: string;
  subtitle: string | null;
} {
  if (!view) return { title: 'Thread', subtitle: null };
  return { title: 'Thread', subtitle: view.topic ? `${view.where} · ${view.topic}` : view.where };
}
