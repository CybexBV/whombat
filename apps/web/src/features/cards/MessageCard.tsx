import { useQueryClient } from '@tanstack/react-query';
import {
  AGENT_FALLBACK_NAME,
  ApiError,
  appPath,
  approvalLine,
  approveToastFor,
  assessmentLine,
  automationAsker,
  cardDisplay,
  DEPLOYS_PATH,
  decidedLine,
  deploySettledLine,
  deviceSkillLine,
  FIND_MY_WATCH_WORDS,
  findMyWatchLine,
  namesWithAsker,
  nextAt,
  planLine,
  reportLine,
  runChips,
  runControls,
  runDisplay,
  runShowsAsLine,
  SCHEDULE_TEXT,
  scheduleLine,
  taskCardView,
  taskLine,
  theAgentOf,
  thingWatchLine,
  turnFailedLine,
} from '@whombat/client';
import { findCachedMessage, queryKeys } from '@whombat/client/query';
import {
  useApiMutation,
  useBootstrapSelect,
  useChangeWindow,
  useDecideApproval,
  useFindMyWatchCancel,
  useRetryTurn,
  useScheduleAction,
  useThingWatchCancel,
  useUndoApproval,
} from '@whombat/client/react';
import {
  type Approval,
  type AssessmentCard as AssessmentCardData,
  type Attachment,
  type Bootstrap,
  canRetryTurn,
  type DeployCard,
  type FindMyWatchCard as FindMyWatchCardData,
  findMyWatchCardLines,
  type Message,
  type MessageCard as MessageCardData,
  type ReportCard as ReportCardData,
  type Run,
  SCHEDULE_COPY,
  type ScheduleCard as ScheduleCardData,
  scheduleActions,
  scheduleCardTitle,
  scheduleCopy,
  shortNameOf,
  type ThingWatchCard as ThingWatchCardData,
  type TurnFailedCard as TurnFailedCardData,
  thingWatchCardLines,
  turnFailureRetryable,
} from '@whombat/core';
import { approvalAnswer, approvalView, type Decider, isEverydayAsk } from '@whombat/core/approvals';
import type { CommandScope } from '@whombat/core/commands';
import { api } from '@whombat/core/contracts';
import { formatClock } from '@whombat/core/text';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { writeProblem } from '../../app/problem';
import { useHereHref, useNavigateHref, useSearchUpdate } from '../../app/routing/navigation';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import { markIfUnknown, useAskToCheck, useUnknownAnswer } from '../approvals/unknownAnswer';
import { usePrHref } from '../branch/usePrHref';
import { errorText, settle } from '../feedback/copy';
import { ReportDetails } from '../feedback/ReportDetails';
import { MessageAttachments } from '../messaging/MessageAttachments';
import { useNow } from '../messaging/useRoom';
import { useRunControl } from '../runs/useRunControl';
import { ScheduleCard } from '../schedules/ScheduleCard';
import { ApprovalCard } from './ApprovalCard';
import { AssessmentCard } from './AssessmentCard';
import assessmentStyles from './AssessmentCard.module.css';
import { AutomationPlanCardContainer } from './AutomationPlanCardContainer';
import { CouncilCard } from './CouncilCard';
import { CardTimeZoneContext, useCardLook, useCardStill, useCardTimeZone } from './cardLook';
import { DelegationCard } from './DelegationCard';
import { DeviceSkillCardContainer } from './DeviceSkillCardContainer';
import { DigestCard } from './DigestCard';
import { FeatureRequestCardContainer } from './FeatureRequestCardContainer';
import { GuideCardContainer } from './GuideCardContainer';
import { AnswerCard, CommitsCard, PillCard } from './ListCards';
import { LookPlanCardContainer } from './LookPlanCard';
import { PlanCardContainer } from './PlanCardContainer';
import { CardLink, nameLookup, type PrincipalLookup, principalLookup } from './parts';
import { ReportCard } from './ReportCard';
import { ReportLine } from './ReportLine';
import { ResearchCard } from './ResearchCard';
import { ReviewCard } from './ReviewCard';
import { RunCard } from './RunCard';
import { RunLine } from './RunLine';
import lineStyles from './RunLine.module.css';
import { RunLiveCard } from './RunLiveCard';
import { SettledLine } from './SettledLine';
import { TaskCard } from './TaskCard';
import { TurnFailedCard } from './TurnFailedCard';
import turnStyles from './TurnFailedCard.module.css';
import { retryFailureText, turnFailureFix } from './turnFailed';
import { WatchCard } from './WatchCard';

export interface MessageCardProps {
  burrow: string;
  /** The resolved card on a message (`message.card`). */
  card: MessageCardData;
  /** The message the card belongs to. */
  messageId: string;
  conversationId: string;
  /** Who wrote the message: a delegation card says a question to its author by name (“Asked Dusty”). */
  authorId?: string;
  /**
   * `thread` renders receipts as the thread pane's compact list, and a report as its whole card (the root of its
   * thread, docs/decisions/report-rows.md RR-07). Default `message`.
   */
  variant?: 'message' | 'thread';
  /**
   * The message's files, where the card shows them instead of the message: a report's screenshots open with its
   * details (RR-05).
   */
  attachments?: readonly Attachment[];
  /**
   * What a run did (docs/decisions/card-settle.md AP-732): the messages of turns it scheduled and deploys it did,
   * shown as smaller lines under the run (`foldIntoRuns`; the list leaves those messages out).
   */
  nested?: readonly Pick<Message, 'id' | 'card'>[];
  /** `sm`: a line inside its run. */
  size?: 'md' | 'sm';
  /** The message id on a line inside its run, so links and jumps to that message land on it. */
  anchorId?: string;
  /** A guide card was answered: its next step is in the card's thread (the room opens it). */
  onGuideActed?: () => void;
}

/** The parts of the burrow's bootstrap cards read: names, the viewer and the time zone. */
type CardBoot = Pick<Bootstrap, 'burrow' | 'preferences' | 'principals' | 'me'>;

// Only these parts: a card doesn't render again when the sidebar or an unread count changes.
const cardBootOf = (b: Bootstrap): CardBoot => ({
  burrow: b.burrow,
  preferences: b.preferences,
  principals: b.principals,
  me: b.me,
});

/** What the card containers share: names, links and the burrow's bootstrap. */
interface CardContext {
  burrow: string;
  boot: CardBoot | undefined;
  principals: PrincipalLookup;
  onNavigate: (href: string) => void;
}

/**
 * Card renderer for the message list: plan, research, run, review, approval, commits, pill, answer
 * (TODO 6), digest, Whombat Feedback report, guide, automation plan and tracker feature request cards. Plan, run and approval cards embed live objects that the client's realtime reducers
 * patch (`run.updated`, `plan.updated`, `approval.updated`), so a card re-renders as the run streams.
 * Names come from the cached bootstrap; links navigate in-app.
 */
export function MessageCard(props: MessageCardProps) {
  // A card's own time (its status line) in the person's time zone.
  const timeZone = useBootstrapSelect(props.burrow, cardTimeZoneOf) ?? 'Europe/Amsterdam';
  return (
    <CardTimeZoneContext.Provider value={timeZone}>
      <MessageCardBody {...props} />
    </CardTimeZoneContext.Provider>
  );
}

const cardTimeZoneOf = (b: Bootstrap): string => b.preferences.timeZone ?? b.burrow.timeZone;

function MessageCardBody({
  burrow,
  card,
  messageId,
  conversationId,
  variant = 'message',
  nested,
  size = 'md',
  anchorId,
  attachments,
  authorId,
  onGuideActed,
}: MessageCardProps) {
  const boot = useBootstrapSelect(burrow, cardBootOf);
  const principals = useMemo(() => principalLookup(boot?.principals), [boot?.principals]);
  const navigate = useNavigateHref();
  const onNavigate = useCallback((href: string) => navigate(href), [navigate]);
  const here = useHereHref();
  const prHref = usePrHref(burrow);
  // The settled line's card, opened in place (AP-730): per message, kept while the card changes state.
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((v) => !v), []);
  const ctx: CardContext = { burrow, boot, principals, onNavigate };

  if (card.kind === 'run') {
    const run = (
      <RunCardContainer
        burrow={burrow}
        run={card.run}
        principals={principals}
        onNavigate={onNavigate}
        branchHref={card.run.prNumber === null ? null : prHref(card.run.prNumber, card.run.repoId)}
        expanded={expanded}
        onToggle={toggle}
      />
    );
    if (!nested?.length) return run;
    return (
      <div className={lineStyles.stack}>
        {run}
        <ul className={lineStyles.inside} aria-label={`What run #${card.run.number} did`}>
          {nested.map(
            (m) =>
              m.card && (
                <li key={m.id}>
                  <MessageCard
                    burrow={burrow}
                    card={m.card}
                    messageId={m.id}
                    conversationId={conversationId}
                    size="sm"
                    anchorId={m.id}
                  />
                </li>
              ),
          )}
        </ul>
      </div>
    );
  }

  // An automation plan: the card while it waits for the person, then a line that opens it.
  if (card.kind === 'automation_plan')
    return (
      <AutomationPlanCardContainer
        burrow={burrow}
        card={card}
        messageId={messageId}
        conversationId={conversationId}
        size={size}
        anchorId={anchorId}
        expanded={expanded}
        onToggle={toggle}
      />
    );
  // A tracker's feature request: the card while it waits for the person, then a line that opens it.
  if (card.kind === 'feature_request')
    return (
      <FeatureRequestCardContainer
        burrow={burrow}
        card={card}
        messageId={messageId}
        conversationId={conversationId}
        principals={principals}
        size={size}
        anchorId={anchorId}
        expanded={expanded}
        onToggle={toggle}
      />
    );
  // A thing's plan (handle-it.md): the card while it waits, is taken or says what was done; a line once not needed.
  if (card.kind === 'look_plan')
    return <LookPlanCardContainer burrow={burrow} card={card} size={size} anchorId={anchorId} />;
  const full = fullCard(card);
  if (cardDisplay(card) !== 'line') return full;
  // In its thread a report is the whole card: that is where the report is read (RR-07).
  if (card.kind === 'report' && variant === 'thread') return full;
  if (card.kind === 'report')
    return (
      <ReportLine line={reportLine(card)} id={anchorId} expanded={expanded} onToggle={toggle}>
        <OpenedReport
          burrow={burrow}
          card={card}
          boot={boot}
          conversationId={conversationId}
          attachments={attachments}
        />
      </ReportLine>
    );
  return (
    <SettledCardLine
      ctx={ctx}
      card={card}
      size={size}
      anchorId={anchorId}
      expanded={expanded}
      onToggle={toggle}
      full={full}
    />
  );

  // The card itself: what every kind but a run shows while active, and what its line opens.
  function fullCard(card: MessageCardData): ReactNode {
    switch (card.kind) {
      case 'plan':
        return (
          <PlanCardContainer
            burrow={burrow}
            plan={card.plan}
            principals={principals}
            onNavigate={onNavigate}
            planHref={here({ plan: card.plan.id, step: undefined, thread: undefined })}
            linkHref={(link) => (link.type === 'approval' ? here({ approval: link.number }) : appPath(link))}
          />
        );
      case 'research':
        return <ResearchCard card={card} />;
      case 'review':
        return <ReviewCard card={card} />;
      case 'approval':
        return (
          <ApprovalCardContainer
            burrow={burrow}
            approval={card.approval}
            boot={boot}
            principals={principals}
          />
        );
      case 'commits':
        return <CommitsCard card={card} principals={principals} />;
      case 'pill':
        return <PillCard card={card} />;
      case 'answer':
        return <AnswerCard card={card} variant={variant} onNavigate={onNavigate} />;
      case 'digest':
        return <DigestCard card={card} />;
      case 'report':
        return (
          <ReportCardContainer burrow={burrow} card={card} boot={boot} conversationId={conversationId} />
        );
      case 'guide':
        return (
          <GuideCardContainer
            burrow={burrow}
            card={card}
            messageId={messageId}
            onNavigate={onNavigate}
            onActed={onGuideActed}
          />
        );
      case 'turn_failed':
        // A failed turn with “Try again” (essentials item 4, AP-480).
        return (
          <TurnFailedCardContainer
            burrow={burrow}
            card={card}
            messageId={messageId}
            boot={boot}
            principals={principals}
            onNavigate={onNavigate}
          />
        );
      case 'assessment':
        // The assessor's verdict, decision and full assessment under its reply (Whombat FB-32).
        return (
          <AssessmentCardContainer burrow={burrow} card={card} boot={boot} conversationId={conversationId} />
        );
      case 'schedule':
        // A turn an agent scheduled for itself, with Cancel (Whombat resourceful-agents.md RA-30, AP-684).
        return <ScheduleCardContainer burrow={burrow} card={card} boot={boot} />;
      case 'device_skill':
        // A device Whombat learned, waiting for your choices and Switch on (one-whombat.md ONE-18; AP-1274).
        return <DeviceSkillCardContainer burrow={burrow} card={card} />;
      case 'task':
        // A server task Whombat follows (task-feedback.md AP-4300): live while it runs, what its line opens once ended.
        return <TaskCard burrow={burrow} card={card} onNavigate={onNavigate} />;
      case 'council':
        // A council the agent leads (council.md CNL-40, CNL-42): live while it works, final under its conclusion; the
        // final card shows its pictures from the message's files.
        return <CouncilCard burrow={burrow} card={card} attachments={attachments} onNavigate={onNavigate} />;
      case 'delegation':
        // Coding tasks the agent hands to T3 Code (delegate.md): the checklist, then each task's progress, with the
        // pictures of what they changed from the message's files. A question a task asks goes to the card's author,
        // the assistant: “Asked Dusty”.
        return (
          <DelegationCard
            burrow={burrow}
            card={card}
            attachments={attachments}
            lead={(authorId ? principals(authorId) : theAgentOf(boot?.principals))?.name ?? null}
          />
        );
      case 'thing_watch':
      case 'findmy_watch':
        return <WatchCardContainer burrow={burrow} card={card} />;
      default:
        // A card kind this client doesn't know yet: the message's own text still shows (FB-16).
        return null;
    }
  }
}

/**
 * A run in a conversation, by its state (docs/decisions/card-settle.md AP-730): until it changes something a line under
 * its message, not a card (AP-668); once it has, the compact live card while it works (AP-733), the card while it
 * needs a person, and a line with its `PR #3` and `+12 −8` chips once it is done or taken over (AP-731) — the live
 * card and that line open the card in place. A failed run, as a line or a card, offers Try again (AP-699): the run page's request, pending state and toasts (`useRunControl`); the line goes live
 * again from the run's own `run.updated`. One component for every form, so a retry in flight survives the line turning
 * into the card.
 */
function RunCardContainer({
  burrow,
  run,
  principals,
  onNavigate,
  branchHref,
  expanded,
  onToggle,
}: {
  burrow: string;
  run: Run;
  principals: PrincipalLookup;
  onNavigate: (href: string) => void;
  branchHref: string | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const control = useRunControl(burrow);
  const retry = {
    retrying: control.pending === 'retry',
    onRetry: () => control.act('retry', run, principals(run.agentId)?.name ?? 'The agent'),
  };
  const card = <RunCard run={run} onNavigate={onNavigate} branchHref={branchHref} {...retry} />;
  switch (runDisplay(run)) {
    case 'full':
      return card;
    case 'live':
      return (
        <div className={lineStyles.stack}>
          <RunLiveCard
            run={run}
            onNavigate={onNavigate}
            prHref={branchHref}
            expanded={expanded}
            onToggle={onToggle}
          />
          {expanded && card}
        </div>
      );
    case 'line': {
      // Pause on a working run's line, Resume on a paused one (WX-10): the run page's controls, where they are.
      const action = runControls(run.status).toggle;
      const toggle = action
        ? {
            action,
            busy: control.pending === action,
            onAct: () => control.act(action, run, principals(run.agentId)?.name ?? 'The agent'),
          }
        : null;
      if (runShowsAsLine(run))
        return <RunLine run={run} onNavigate={onNavigate} {...retry} toggle={toggle} />;
      return (
        <RunLine
          run={run}
          onNavigate={onNavigate}
          {...retry}
          chips={runChips(run)}
          prHref={branchHref}
          expanded={expanded}
          onToggle={onToggle}
        >
          {expanded && <div className={lineStyles.opened}>{card}</div>}
        </RunLine>
      );
    }
  }
}

/**
 * A card that is done, as one line (AP-731) that opens the card in place. An approval keeps Undo while its card would
 * still offer it, a schedule Cancel while it is to come.
 */
function SettledCardLine({
  ctx,
  card,
  size,
  anchorId,
  expanded,
  onToggle,
  full,
}: {
  ctx: CardContext;
  card: MessageCardData;
  size: 'md' | 'sm';
  anchorId?: string;
  expanded: boolean;
  onToggle: () => void;
  full: ReactNode;
}) {
  const opened = expanded ? <div className={lineStyles.opened}>{full}</div> : null;
  const common = { size, id: anchorId, expanded, onToggle };
  const name = (id: string | null | undefined) => (id ? ctx.principals(id) : undefined);
  const timeZone = ctx.boot?.preferences.timeZone ?? ctx.boot?.burrow.timeZone ?? 'Europe/Amsterdam';
  switch (card.kind) {
    case 'approval':
      return <ApprovalLine ctx={ctx} approval={card.approval} common={common} opened={opened} />;
    case 'schedule':
      return <ScheduleLine ctx={ctx} card={card} common={common} opened={opened} />;
    case 'plan':
      return (
        <SettledLine line={planLine(card.plan)} label={`Plan: ${card.plan.title}`} card="plan" {...common}>
          {opened}
        </SettledLine>
      );
    case 'assessment':
      return (
        <SettledLine
          line={assessmentLine(card)}
          label={`Assessment: ${card.reference}`}
          card="assessment"
          {...common}
        >
          {opened}
        </SettledLine>
      );
    case 'deploy':
      return <DeployLine ctx={ctx} card={card} size={size} id={anchorId} />;
    case 'device_skill':
      return (
        <SettledLine
          line={deviceSkillLine(card)}
          label={`Device skill: ${card.name}`}
          card="device_skill"
          {...common}
        >
          {opened}
        </SettledLine>
      );
    case 'task':
      // How it went and how long it took (AP-4301); it opens the card with the runtime's full words.
      return (
        <SettledLine
          line={taskLine(card, Date.now())}
          label={taskCardView(card, 0).label}
          card="task"
          {...common}
        >
          {opened}
        </SettledLine>
      );
    case 'thing_watch':
      return card.watch ? (
        <SettledLine
          line={thingWatchLine(card.watch, timeZone, Date.now())}
          label={thingWatchCardLines(card.watch, timeZone, Date.now()).title}
          card={card.kind}
          size={size}
          id={anchorId}
        />
      ) : null;
    case 'findmy_watch':
      // An ended watch is one line and nothing to open; a watch nobody can read any more leaves the message's words.
      return card.watch ? (
        <SettledLine
          line={findMyWatchLine(card.watch, timeZone, Date.now())}
          label={findMyWatchCardLines(card.watch, timeZone, Date.now()).title}
          card="findmy_watch"
          size={size}
          id={anchorId}
        />
      ) : null;
    case 'turn_failed': {
      const agent = name(card.agentId)?.name ?? 'The agent';
      return (
        <SettledLine
          line={turnFailedLine(card, timeZone)}
          label={`${agent} couldn’t finish`}
          card="turn_failed"
          {...common}
        >
          {opened}
        </SettledLine>
      );
    }
    default:
      return full;
  }
}

/**
 * The `deploy` card (docs/decisions/web-messages.md WX-12; contracts CT-297): always one settled line, `Deployed api to
 * production · 3f9c2a` (ok) or `Deploy of api to production failed · 3f9c2a` (bad), with the deployed address (its host,
 * a new tab) and the Deploys board. Nothing opens under it: the board has the rest.
 */
function DeployLine({
  ctx,
  card,
  size,
  id,
}: {
  ctx: CardContext;
  card: DeployCard;
  size: 'md' | 'sm';
  id?: string;
}) {
  const host = deployHost(card.url);
  return (
    <SettledLine
      line={deploySettledLine(card)}
      label={`Deploy: ${card.service} to ${card.environment}`}
      card="deploy"
      size={size}
      id={id}
      controls={
        <>
          {card.url && host && (
            <a
              className={lineStyles.link}
              href={card.url}
              target="_blank"
              rel="noopener noreferrer"
              title={card.url}
              aria-label={`${host} (opens in a new tab)`}
            >
              {host} ↗
            </a>
          )}
          <CardLink className={lineStyles.link} href={DEPLOYS_PATH} onNavigate={ctx.onNavigate}>
            Deploys
          </CardLink>
        </>
      }
    />
  );
}

/** `api.example.com` from the deployed address; null for anything that isn't http(s). */
export function deployHost(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.host : null;
  } catch {
    return null;
  }
}

interface LineCommon {
  size: 'md' | 'sm';
  id?: string;
  expanded: boolean;
  onToggle: () => void;
}

/** `Approved by John · …`, with Undo while the approval card would still offer it (until the action has run, B-02). */
function ApprovalLine({
  ctx,
  approval,
  common,
  opened,
}: {
  ctx: CardContext;
  approval: Approval;
  common: LineCommon;
  opened: ReactNode;
}) {
  const actions = useApprovalActions(ctx.burrow, approval, ctx.boot, ctx.principals);
  const decider = approval.decidedById ? ctx.principals(approval.decidedById) : undefined;
  // An everyday ask's line says where it is, as its card does: “Scheduled for tonight, 03:00”, Done, “You said no”.
  const answer = isEverydayAsk(approval)
    ? approvalAnswer(approval, {
        names: actions.names,
        viewer: actions.viewer,
        now: actions.now,
        timeZone: actions.timeZone,
      })
    : null;
  return (
    <SettledLine
      line={
        answer
          ? { lead: answer.text, detail: approval.title, tone: answer.tone }
          : approvalLine(approval, decider ? shortNameOf(decider) : null)
      }
      label={`Approval: ${approval.title}`}
      card="approval"
      {...common}
      controls={
        actions.view.canUndo ? (
          <Button
            variant="link"
            className={lineStyles.retry}
            disabled={actions.busy}
            aria-busy={actions.busy || undefined}
            onClick={actions.onUndo}
          >
            Undo
          </Button>
        ) : null
      }
    >
      {opened}
    </SettledLine>
  );
}

/** `Banjo scheduled a turn · Once, Sun 4 Oct at 15:23` · what it will do, with Cancel where the card has it. */
function ScheduleLine({
  ctx,
  card,
  common,
  opened,
}: {
  ctx: CardContext;
  card: ScheduleCardData;
  common: LineCommon;
  opened: ReactNode;
}) {
  const cancel = useScheduleCancel(ctx.burrow, card, ctx.boot);
  const s = card.schedule;
  return (
    <SettledLine
      line={scheduleLine(card, cancel.agentName, cancel.timeZone, Date.now())}
      label={s ? scheduleCardTitle(cancel.agentName, s) : SCHEDULE_TEXT.gone}
      card="schedule"
      {...common}
      controls={
        cancel.canCancel && s && scheduleActions(s).remove ? (
          <Button
            variant="link"
            className={lineStyles.retry}
            disabled={cancel.busy}
            aria-busy={cancel.busy || undefined}
            onClick={cancel.onCancel}
          >
            {SCHEDULE_COPY.cancel}
          </Button>
        ) : null
      }
    >
      {cancel.problem && (
        <p className={lineStyles.problem} role="alert">
          {cancel.problem}
        </p>
      )}
      {opened}
    </SettledLine>
  );
}

/**
 * Cancel on a schedule (`schedules.remove`) where the runtime has `agents.schedules` and the viewer may: the card's and
 * its line's (AP-731).
 */
function useScheduleCancel(burrow: string, card: ScheduleCardData, boot: CardBoot | undefined) {
  const toast = useToast();
  const remove = useScheduleAction(api.schedules.remove);
  const [problem, setProblem] = useState<string | null>(null);
  const agent = card.schedule ? boot?.principals.find((p) => p.id === card.schedule?.agentId) : undefined;
  const agentName = agent?.name ?? AGENT_FALLBACK_NAME;
  const timeZone = boot?.preferences.timeZone ?? boot?.burrow.timeZone ?? 'Europe/Amsterdam';
  const onCancel = async () => {
    if (!agent || remove.isPending) return;
    setProblem(null);
    try {
      const result = await remove.mutateAsync({ params: { burrow, scheduleId: card.scheduleId } });
      if (result.status === 'ok') toast.show(scheduleCopy(agentName).cancelled);
      else
        setProblem(result.status === 'blocked' ? result.message : 'That didn’t work. Try again in a moment.');
    } catch (e) {
      setProblem(writeProblem(e));
    }
  };
  return {
    agentName,
    timeZone,
    canCancel: !!agent && !!card.schedule,
    onCancel: () => void onCancel(),
    busy: remove.isPending,
    problem,
  };
}

/** A schedule card with Cancel (`useScheduleCancel`). */
function ScheduleCardContainer({
  burrow,
  card,
  boot,
}: {
  burrow: string;
  card: ScheduleCardData;
  boot: CardBoot | undefined;
}) {
  const cancel = useScheduleCancel(burrow, card, boot);
  return (
    <ScheduleCard
      card={card}
      agentName={cancel.agentName}
      timeZone={cancel.timeZone}
      canCancel={cancel.canCancel}
      onCancel={cancel.onCancel}
      busy={cancel.busy}
      problem={cancel.problem}
    />
  );
}

/**
 * Cancel turns a watch into its settled line. Cards shown as they were earlier have no Cancel.
 */
function WatchCardContainer({
  burrow,
  card,
}: {
  burrow: string;
  card: FindMyWatchCardData | ThingWatchCardData;
}) {
  const timeZone = useCardTimeZone();
  const still = useCardStill();
  const cancelFindMy = useFindMyWatchCancel();
  const cancelThing = useThingWatchCancel();
  const cancel = card.kind === 'thing_watch' ? cancelThing : cancelFindMy;
  const [problem, setProblem] = useState<string | null>(null);
  const watch = card.watch;
  if (!watch) return null;
  const onCancel = async () => {
    if (cancel.isPending) return;
    setProblem(null);
    try {
      const result = await cancel.mutateAsync({ params: { burrow, watchId: card.watchId }, body: {} });
      if (result.status !== 'ok')
        setProblem(result.status === 'blocked' ? result.message : FIND_MY_WATCH_WORDS.failed);
    } catch (e) {
      setProblem(writeProblem(e));
    }
  };
  return (
    <WatchCard
      watch={watch}
      timeZone={timeZone}
      nowMs={Date.now()}
      onCancel={still ? undefined : () => void onCancel()}
      busy={cancel.isPending}
      problem={problem}
    />
  );
}

/** A report card with its details opened in place (`feedback.getReport`). */
function ReportCardContainer({
  burrow,
  card,
  boot,
  conversationId,
}: {
  burrow: string;
  card: ReportCardData;
  boot: CardBoot | undefined;
  conversationId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const now = useNow(30_000);
  const timeZone = boot?.preferences.timeZone ?? boot?.burrow.timeZone ?? 'Europe/Amsterdam';
  return (
    <ReportCard
      card={card}
      now={now}
      timeZone={timeZone}
      expanded={expanded}
      onToggleDetails={() => setExpanded((v) => !v)}
      details={<ReportDetails burrow={burrow} reportId={card.reportId} conversationId={conversationId} />}
    />
  );
}

/**
 * A report's row opened (docs/decisions/report-rows.md RR-05): the whole card — the visitor's words, the assessment,
 * the state line — with its details region open, the screenshots at its top.
 */
function OpenedReport({
  burrow,
  card,
  boot,
  conversationId,
  attachments,
}: {
  burrow: string;
  card: ReportCardData;
  boot: CardBoot | undefined;
  conversationId: string;
  attachments: readonly Attachment[] | undefined;
}) {
  const now = useNow(30_000);
  const timeZone = boot?.preferences.timeZone ?? boot?.burrow.timeZone ?? 'Europe/Amsterdam';
  return (
    <ReportCard
      card={card}
      now={now}
      timeZone={timeZone}
      expanded
      details={
        <>
          {attachments?.length ? (
            <MessageAttachments attachments={attachments} conversationId={conversationId} />
          ) : null}
          <ReportDetails burrow={burrow} reportId={card.reportId} conversationId={conversationId} />
        </>
      }
    />
  );
}

/**
 * The assessor's card with its options for people (on a runtime with `feedback.decisions`). A pick calls
 * `feedback.decide`; the card locks at once and the runtime's `message.updated` brings who picked what for everyone.
 * A refusal (someone else was quicker, the handoff isn't possible) is said under the options.
 */
function AssessmentCardContainer({
  burrow,
  card,
  boot,
  conversationId,
}: {
  burrow: string;
  card: AssessmentCardData;
  boot: CardBoot | undefined;
  conversationId: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const decide = useApiMutation(api.feedback.decide);
  const [deciding, setDeciding] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const timeZone = boot?.preferences.timeZone ?? boot?.burrow.timeZone ?? 'Europe/Amsterdam';
  const who = (id: string) =>
    id === boot?.me.id ? 'You' : (boot?.principals.find((p) => p.id === id)?.name ?? 'Someone');
  const decidedText = card.decided
    ? decidedLine(card.decided, who(card.decided.decidedById), formatClock(card.decided.decidedAt, timeZone))
    : null;

  const onDecide = async (option: number) => {
    if (deciding !== null) return;
    setDeciding(option);
    setProblem(null);
    try {
      const settled = settle(
        await decide.mutateAsync({ params: { burrow, id: card.reportId }, body: { option } }),
      );
      if (settled.ok) toast.show(`“${card.decision?.options[option]?.label ?? ''}” chosen.`);
      else setProblem(settled.text);
    } catch (e) {
      setProblem(errorText(e, { notFound: 'You can’t see this report.' }));
    } finally {
      setDeciding(null);
      void qc.invalidateQueries({ queryKey: queryKeys.scope('messages.list', { conversationId }) });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('messages.thread') });
      void qc.invalidateQueries({ queryKey: queryKeys.scope(api.feedback.getReport, { id: card.reportId }) });
    }
  };

  return (
    <AssessmentCard
      card={card}
      canDecide={!!boot}
      deciding={deciding}
      onDecide={(i) => void onDecide(i)}
      decidedText={decidedText}
      note={problem ? <p className={assessmentStyles.problem}>{problem}</p> : null}
    />
  );
}

/**
 * A failed turn's card with Try again for people who may wake that agent here (`canRetryTurn`). Pressing it queues the retry (`dispatches.retry`); the card says “Tried again · 14:32” at once and
 * the runtime's `message.updated` confirms it for everyone. The reason is left out when the message's own text is
 * already that sentence (AP-481).
 */
function TurnFailedCardContainer({
  burrow,
  card,
  messageId,
  boot,
  principals,
  onNavigate,
}: {
  burrow: string;
  card: TurnFailedCardData;
  messageId: string;
  boot: CardBoot | undefined;
  principals: PrincipalLookup;
  onNavigate: (href: string) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const retry = useRetryTurn(burrow);
  const [problem, setProblem] = useState<string | null>(null);
  // The runtime refuses for good (409: the person left): say why, and offer it no more.
  const [refused, setRefused] = useState(false);
  const agent = principals(card.agentId);
  const agentName = agent?.name ?? 'The agent';
  const viewer = boot ? { id: boot.me.id, kind: 'person' as const } : undefined;
  const canRetry = !refused && turnFailureRetryable(card.code) && canRetryTurn(card, viewer);
  const text = findCachedMessage(qc, messageId)?.text.trim() ?? '';
  const timeZone = boot?.preferences.timeZone ?? boot?.burrow.timeZone ?? 'Europe/Amsterdam';

  const onRetry = () => {
    if (retry.isPending) return;
    setProblem(null);
    retry.mutate(
      { dispatchId: card.dispatchId },
      {
        onSuccess: (result) => {
          if (result.status === 'ok') toast.show(`Asked ${agentName} to try again.`);
          else setProblem(retryFailureText(result));
        },
        onError: (error) => {
          setProblem(retryFailureText(error));
          if (error instanceof ApiError && error.status === 409) setRefused(true);
        },
      },
    );
  };

  return (
    <TurnFailedCard
      card={card}
      agentName={agentName}
      showReason={text !== card.reason.trim()}
      canRetry={canRetry}
      retrying={retry.isPending}
      onRetry={onRetry}
      timeZone={timeZone}
      fix={turnFailureFix(card.code)}
      onNavigate={onNavigate}
      note={
        problem ? (
          <p className={turnStyles.problem} role="alert">
            {problem}
          </p>
        ) : null
      }
    />
  );
}

/** What the viewer is told when the server did not take a decision. */
export function decisionFailureText(
  result: { status: 'blocked'; message: string } | { status: 'pending_approval' } | Error,
): string {
  if (result instanceof ApiError) return result.message;
  if (result instanceof Error) return 'Couldn’t reach Whombat. Nothing changed, try again.';
  if (result.status === 'blocked') return result.message;
  return 'That needs a person to approve it first.';
}

interface ApprovalCardContainerProps {
  burrow: string;
  approval: Approval;
  boot: CardBoot | undefined;
  principals: PrincipalLookup;
}

/**
 * Approve / Undo with optimistic updates (`useDecideApproval`, `useUndoApproval`): the card, its line, the modal, plan
 * step and inbox flip at once and roll back on errors or blocked / pending outcomes. Toasts are the mock's copy from
 * `approvalView().toasts`. Details opens the approval modal over the current page.
 */
function useApprovalActions(
  burrow: string,
  approval: Approval,
  boot: CardBoot | undefined,
  principals: PrincipalLookup,
) {
  const toast = useToast();
  const updateSearch = useSearchUpdate();
  const now = useNow(30_000);
  // An automation asking (AP-997): “The automation is waiting for a person to approve.”, not an agent's name.
  const names = useMemo(
    () =>
      namesWithAsker(
        nameLookup(principals),
        approval.requesterId,
        automationAsker(approval, principals(approval.requesterId)),
      ),
    [principals, approval],
  );
  const viewer = useMemo<Decider | undefined>(
    () => (boot ? { id: boot.me.id, kind: 'person' } : undefined),
    [boot],
  );
  const timeZone = boot?.preferences.timeZone ?? boot?.burrow.timeZone ?? 'Europe/Amsterdam';
  const decide = useDecideApproval(burrow);
  const undo = useUndoApproval(burrow);
  const busy = decide.isPending || undo.isPending;
  // What the card offers now (Undo until the action has run, B-02): the line keeps what the card would show.
  const view = useMemo(
    () => approvalView(approval, { names, viewer, now, timeZone }),
    [approval, names, viewer, now, timeZone],
  );

  // Promises, not `mutate` callbacks: the card turns into its line as the decision lands, and the line's toast for a
  // refusal must still show (AP-730).
  type Outcome = { status: 'ok' } | { status: 'blocked'; message: string } | { status: 'pending_approval' };
  const settleDecision = (pending: Promise<Outcome>) => {
    void pending.then(
      (result) => {
        if (result.status !== 'ok') toast.show(decisionFailureText(result));
      },
      (error: unknown) => {
        // It may have gone through: the card says so and offers a check, never the answers again.
        if (markIfUnknown(burrow, approval.number, error)) return;
        toast.show(decisionFailureText(error instanceof Error ? error : new Error(String(error))));
      },
    );
  };
  const mayHaveGoneThrough = useUnknownAnswer(burrow, approval.number);
  const check = useAskToCheck(burrow, view.title);
  const unknown = mayHaveGoneThrough && approval.state === 'pending' ? check : null;

  const onApprove = () => {
    if (busy) return;
    const view = approvalView(approval, { names, viewer, now: Date.now(), timeZone });
    toast.show(view.toasts.approve);
    settleDecision(decide.mutateAsync({ number: approval.number, decision: 'approve' }));
  };

  // A command the agent runs (AC-42, AP-623): a yes goes once, for this task or always; a risk row's “Always
  // allow” (AP-680) approves and sets the row to On. The toast says which.
  const onChoose = (scope: CommandScope) => {
    if (busy) return;
    toast.show(approveToastFor(approval, scope, { names, viewer, now: Date.now(), timeZone }));
    settleDecision(decide.mutateAsync({ number: approval.number, decision: 'approve', scope }));
  };

  const onDecline = () => {
    if (busy) return;
    const view = approvalView(approval, { names, viewer, now: Date.now(), timeZone });
    toast.show(view.toasts.decline);
    settleDecision(decide.mutateAsync({ number: approval.number, decision: 'decline' }));
  };

  const onUndo = () => {
    if (busy) return;
    settleDecision(undo.mutateAsync({ number: approval.number }));
  };

  const onDetails = () => {
    void updateSearch((prev) => ({ ...prev, approval: approval.number }));
  };

  // “Tonight at 03:00” (ONE-10, AP-1280): in a chat with the agent, when the Whombat's quiet hours for changes start
  // (care-plan.md), read in its own time zone.
  const look = useCardLook();
  const quiet = useChangeWindow(look === 'chat' ? burrow : null);
  const burrowZone = boot?.burrow.timeZone ?? timeZone;
  const tonight = nextAt(now, burrowZone, quiet.start);
  const approveLater =
    look === 'chat'
      ? {
          label: `Tonight at ${formatClock(tonight, timeZone)}`,
          at: tonight,
          onSelect: () => {
            if (busy) return;
            const executeAt = nextAt(Date.now(), burrowZone, quiet.start);
            toast.show(`Approved. It runs at ${formatClock(executeAt, timeZone)}.`);
            settleDecision(decide.mutateAsync({ number: approval.number, decision: 'approve', executeAt }));
          },
        }
      : undefined;

  return {
    approval,
    names,
    viewer,
    now,
    timeZone,
    busy,
    view,
    onApprove,
    onChoose,
    onDecline,
    onUndo,
    onDetails,
    approveLater,
    unknown,
  };
}

interface ApprovalCardContainerProps {
  burrow: string;
  approval: Approval;
  boot: CardBoot | undefined;
  principals: PrincipalLookup;
}

/** The approval card with its actions (`useApprovalActions`). */
function ApprovalCardContainer({ burrow, approval, boot, principals }: ApprovalCardContainerProps) {
  const a = useApprovalActions(burrow, approval, boot, principals);
  return (
    <ApprovalCard
      approval={a.approval}
      names={a.names}
      viewer={a.viewer}
      now={a.now}
      timeZone={a.timeZone}
      onApprove={a.onApprove}
      onDetails={a.onDetails}
      approveLater={a.approveLater}
      unknown={a.unknown}
      onUndo={a.onUndo}
      onChoose={a.onChoose}
      onDecline={a.onDecline}
      busy={a.busy}
    />
  );
}
