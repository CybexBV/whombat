import type { Meta, StoryObj } from '@storybook/react-vite';
import { reportLine, runShowsAsLine } from '@whombat/client';
import type { Decider } from '@whombat/core/approvals';
import type { MessageCard } from '@whombat/core/domain';
import { mara, PRINCIPALS, SEED_NOW, SEED_TIME_ZONE } from '@whombat/fixtures';
import { ApprovalCard } from './ApprovalCard';
import { CARD_STATES, type CardStateName } from './cardStates';
import { DigestCard } from './DigestCard';
import { AnswerCard, CommitsCard, PillCard } from './ListCards';
import { PlanCard } from './PlanCard';
import { nameLookup, principalLookup } from './parts';
import { ReportCard } from './ReportCard';
import { ReportLine } from './ReportLine';
import { ResearchCard } from './ResearchCard';
import { ReviewCard } from './ReviewCard';
import { RunCard } from './RunCard';
import { RunLine } from './RunLine';

const principals = principalLookup(PRINCIPALS);
const names = nameLookup(principals);
const viewer: Decider = { id: mara.id, kind: 'person' };
const log = (what: string) => () => console.info(what);

/**
 * The presentational card for a state (the app renders these through `<MessageCard>`). `retry`: the card has
 * Try again's handler, so a failed run offers it (AP-699).
 */
function Card({ card, thread, retry = false }: { card: MessageCard; thread?: boolean; retry?: boolean }) {
  const onNavigate = (href: string) => console.info('navigate', href);
  const retryProps = retry ? { onRetry: log('retry') } : {};
  switch (card.kind) {
    case 'plan':
      return (
        <PlanCard
          plan={card.plan}
          principals={principals}
          onNavigate={onNavigate}
          onGoAhead={log('go ahead')}
        />
      );
    case 'research':
      return <ResearchCard card={card} />;
    case 'run':
      if (runShowsAsLine(card.run)) return <RunLine run={card.run} onNavigate={onNavigate} {...retryProps} />;
      return <RunCard run={card.run} onNavigate={onNavigate} {...retryProps} />;
    case 'review':
      return <ReviewCard card={card} />;
    case 'approval':
      return (
        <ApprovalCard
          approval={card.approval}
          names={names}
          viewer={viewer}
          now={SEED_NOW}
          timeZone={SEED_TIME_ZONE}
          onApprove={log('approve')}
          onDetails={log('details')}
          onUndo={log('undo')}
        />
      );
    case 'commits':
      return <CommitsCard card={card} principals={principals} />;
    case 'pill':
      return <PillCard card={card} />;
    case 'answer':
      return <AnswerCard card={card} variant={thread ? 'thread' : 'message'} onNavigate={onNavigate} />;
    case 'digest':
      return <DigestCard card={card} />;
    case 'report':
      // Its row in the conversation (report-rows.md RR-02) over the card it opens.
      return (
        <>
          <ReportLine line={reportLine(card)} onToggle={log('details')} />
          <ReportCard card={card} now={SEED_NOW} timeZone={SEED_TIME_ZONE} onToggleDetails={log('details')} />
        </>
      );
  }
}

/** One state in light and dark side by side (each panel forces its theme with `data-theme`). */
function CardState({ state, retry }: { state: CardStateName; retry?: boolean }) {
  const thread = state === 'answer-thread';
  return (
    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
      {(['light', 'dark'] as const).map((theme) => (
        <div
          key={theme}
          data-theme={theme}
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: thread ? 308 : 640,
            padding: 24,
            background: 'var(--bg)',
            color: 'var(--ink)',
          }}
        >
          <Card card={CARD_STATES[state] as MessageCard} thread={thread} retry={retry} />
        </div>
      ))}
    </div>
  );
}

const meta = {
  title: 'Cards/Chat cards',
  component: CardState,
  parameters: { layout: 'padded' },
  argTypes: {
    state: { control: 'select', options: Object.keys(CARD_STATES) },
    retry: { control: 'boolean' },
  },
} satisfies Meta<typeof CardState>;

export default meta;
type Story = StoryObj<typeof meta>;

const story = (state: CardStateName, name: string, args: { retry?: boolean } = {}): Story => ({
  name,
  args: { state, ...args },
});

export const Plan = story('plan', 'Plan · 11:22 (done, active, gate)');
export const PlanAllMarkers = story('plan-all-markers', 'Plan · every marker (done, active, queued, gate)');
export const PlanDeployed = story('plan-deployed', 'Plan · finished');
export const PlanGoAhead = story('plan-go-ahead', 'Plan · a step waiting for your go (WS-55)');
export const Research = story('research', 'Research');
export const RunLive = story('run', 'Run · live');
export const RunDone = story('run-done', 'Run · done');
export const RunPaused = story('run-paused', 'Run · paused');
export const RunFailed = story('run-failed', 'Run · failed');
export const RunFailedRetry = story('run-failed', 'Run · failed, Try again (AP-699)', { retry: true });
export const RunTakenOver = story('run-taken-over', 'Run · taken over');
export const RunLineLive = story('run-line', 'Run line · checking (AP-668)');
export const RunLineDone = story('run-line-done', 'Run line · done');
export const RunLineAttention = story('run-line-attention', 'Run line · needs attention');
export const RunLineFailed = story('run-line-failed', 'Run line · failed, Try again (AP-699)', {
  retry: true,
});
export const Review = story('review', 'Review');
export const ApprovalNeedsPerson = story('approval', 'Approval · NEEDS A PERSON');
export const ApprovalReady = story('approval-ready', 'Approval · NEEDS A PERSON (Approve and deploy)');
export const ApprovalWaiting = story('approval-waiting', 'Approval · APPROVED · WAITING FOR CHECKS');
export const ApprovalWaitingReview = story(
  'approval-waiting-review',
  'Approval · APPROVED · WAITING FOR REVIEW',
);
export const ApprovalDeploying = story('approval-deploying', 'Approval · APPROVED · DEPLOYING');
export const ApprovalDeployed = story('approval-deployed', 'Approval · DEPLOYED');
export const ApprovalFailed = story('approval-failed', 'Approval · DEPLOY FAILED');
export const ApprovalDeclined = story('approval-declined', 'Approval · DECLINED');
export const Commits = story('commits', 'Commits');
export const Pill = story('pill', 'Status pill');
export const Receipts = story('answer', 'Receipts · from a search');
export const ReceiptsDm = story('answer-dm', 'Receipts · deep links');
export const ReceiptsThread = story('answer-thread', 'Receipts · thread pane');
export const ReceiptsLong = story('answer-long', 'Receipts · long details wrap');
export const Digest = story('digest', 'Digest · inbox');
export const ReportAssessed = story('report', 'Report · assessed, likely bug');
export const ReportQueued = story('report-queued', 'Report · assessment queued');
export const ReportFailed = story('report-failed', 'Report · assessment failed');
export const ReportRemoved = story('report-removed', 'Report · content removed');
export const ReportFeature = story('report-feature', 'Report · feature request');
