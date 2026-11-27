/**
 * One message in a conversation (AP-901), as `ChatView` showed it inline: the author line, the text with its receipts,
 * digest, guide, device skill, automation plan, feature request and cards, quick replies, link previews, files,
 * reactions and the replies row, under a day divider or the “New” line. Memoised: its props are the item (kept the same object while it says the same, `keepSameItems`), this
 * row's share of the screen's state as plain values, and `env` — the screen's handlers, stable through a ref — so typing,
 * an agent's activity, presence or another row's state don't re-render it. A thread's first message in Chat and Feedback
 * swipes left to Settle (or Open again) and More (`swipe`).
 */

import type { MarkLike } from '@whombat/brand';
import type { GuideActInput, ThreadStage, WorkLine } from '@whombat/client';
import { authorStatus, findMyWatchWords, jobResultView, wordsUnderCard } from '@whombat/client';
import type { Message, Principal, Receipt } from '@whombat/core';
import { Children, memo, type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { type AccessibilityActionEvent, Pressable, View } from 'react-native';
import { NativeMenuView } from '../../modules/whombat-menu';
import { ReplyFace, type ReplyPlace } from '../avatars/ReplyFace';
import { useBurrowBase, useNowLabel } from '../data/BurrowProvider';
import type { FileAccess } from '../data/fileAccess';
import type { GuideWeb } from '../data/guides';
import { messageA11y, messageA11yWords } from '../data/messageA11y';
import type { MessageSwipe } from '../data/messageActions';
import {
  type AssessmentCardModel,
  type CardSummary,
  type ChatItem,
  sentFollowsClock,
  sentLabel,
  unreadMarkerText,
} from '../data/messages';
import type { NativeMenuSpec } from '../data/nativeMenu';
import { loadEarlierReplies, type MovedCardLink, THREAD_PAGE_SIZE } from '../data/threadPages';
import { settleCopy } from '../data/threadSettle';
import type { MessageFileActions } from '../data/useFiles';
import type { ThreadWorkView } from '../data/working';
import { useI18n, useMobileT } from '../i18n';
import { openHref } from '../navigation/hooks';
import { useTheme } from '../theme/theme';
import { MessageAttachmentsView } from '../ui/attachments';
import { AutomationPlanCardView } from '../ui/automationPlanCard';
import { CardStillContext } from '../ui/cardFrame';
import {
  AuthorLine,
  CardSummaryView,
  DayDivider,
  DigestCardView,
  EarlierCardView,
  HideCardButton,
  LiveRunCardView,
  LoadEarlierRow,
  MessageBody,
  MovedCardLinkView,
  QuickReplies,
  ReceiptsCard,
  ReportLineView,
  RunLineView,
  SettledLineView,
  ThreadRepliesRow,
  UnreadLine,
} from '../ui/chat';
import { RanOnMark, RanOnNote, RunSwitchDivider } from '../ui/chatRuntime';
import { DeviceSkillCardView } from '../ui/deviceSkillCard';
import { FeatureRequestCardView } from '../ui/featureRequestCard';
import { type GuideActOutcome, GuideCardView } from '../ui/guide';
import { Check, Ellipsis, Undo2 } from '../ui/icons';
import { CHAT_GUTTER, CHAT_ROW_GAP } from '../ui/insets';
import { RowIdContext } from '../ui/inView';
import { JobResultMessage } from '../ui/jobResult';
import { LookPlanCard } from '../ui/lookPlanCard';
import {
  EditedMark,
  LinkPreviews,
  PinnedMark,
  ReactionRow,
  Tombstone,
  TurnFailedCardView,
  VaultSavedLines,
} from '../ui/messageParts';
import { textSelectionShowing } from '../ui/rich';
import { registerRowFocus } from '../ui/rowFocus';
import { SubjectChip } from '../ui/subjectChip';
import { type SwipeAction, SwipeRow } from '../ui/swipeRow';
import { LiveTaskCardView } from '../ui/taskCard';
import { SettledMark } from '../ui/threadSettle';
import { CouncilCard } from './CouncilCard';
import { DelegationCard } from './DelegationCard';

/** What a row asks of its screen. Stable for the screen's life (`useLatestHandlers`): they run its latest render's. */
export interface RowHandlers {
  openMenu(message: Message): void;
  /** A pick in iOS's own menu (`parseNativeMenuPick`), or a swipe's panel doing what the menu would. */
  menuAction(message: Message, id: string): void;
  addReaction(message: Message): void;
  react(messageId: string, value: string, on: boolean): void;
  toggleCard(id: string): void;
  openThread(messageId: string): void;
  /** A finger came down on something that opens a thread: its replies can start loading before it opens. */
  prefetchThread(messageId: string): void;
  openReceipt(receipt: Receipt): void;
  actOnGuide(messageId: string, input: GuideActInput): Promise<GuideActOutcome>;
  retryTurn(dispatchId: string, agentName: string): void;
  askMore(messageId: string): void;
  pickQuick(text: string): void;
  openRun(runNumber: number): void;
  tryRunAgain(runNumber: number, agentName: string): void;
  openApproval(approvalNumber: number): void;
  openPlan(planId: string): void;
  openPullRequest(prNumber: number): void;
  openConversation(conversationId: string): void;
  openUrl(url: string): void;
  openDeploys(): void;
  /** A server task's card (task-feedback.md AP-4305): the server's page, `name` its title while it loads. */
  openServer(serverId: string, name: string): void;
  /** A “Saved to your Vault · Plex” line under a message (VS-07; AP-4037): the entry, `name` its title while it loads. */
  openVaultEntry(entryId: string, name: string): void;
  decideReport(reportId: string, option: number): void;
  /** A Find My watch card's Cancel (findmy-watch.md). */
  cancelFindMyWatch(watchId: string): void;
  cancelThingWatch(watchId: string): void;
  /** A council's or a delegation's Change something (council.md CNL-20): the cursor in the message's thread's reply box. */
  replyHere(message: Message): void;
  loadEarlier(): void;
  /** A moved card's link (card-moves.md CM-07): the thread scrolls to the message and highlights it, as an anchor. */
  showMessage(messageId: string): void;
}

/**
 * Handlers that stay the same object while calling the latest ones given: a memoised child gets them once and still
 * acts on the screen's current state (AP-901).
 */
export function useLatestHandlers<T extends object>(handlers: T): T {
  const latest = useRef(handlers);
  latest.current = handlers;
  // biome-ignore lint/correctness/useExhaustiveDependencies: built once; the handlers are read through the ref
  return useMemo(() => {
    const stable = {} as Record<string, unknown>;
    for (const key of Object.keys(handlers))
      stable[key] = (...args: unknown[]) =>
        (Reflect.get(latest.current, key) as (...a: unknown[]) => unknown)(...args);
    return stable as T;
  }, []);
}

/** What every row shares: the handlers and what changes about as rarely (the screen's features and file access). */
export interface ChatRowEnv {
  on: RowHandlers;
  /** The screen shows one thread (its root, then the replies). */
  inThread: boolean;
  /** Chat or Feedback's own list, where every message is a thread: a tap on a message opens it. */
  opensThreads: boolean;
  guideWeb: GuideWeb;
  access: FileAccess | null;
  files: MessageFileActions | null;
  /** The app clock (ms), for a live run's ticking time. */
  clock: () => number;
  /** A server's mark when the app knows what it runs (Home's things, AP-4305); null draws the server glyph. */
  serverMark: (serverId: string) => MarkLike | null;
  /**
   * Chat or Feedback, the room or one of its threads: the person's own messages show their face and the time, no name
   * (docs/decisions/chat-threads-cards.md).
   */
  ownBare: boolean;
  /** The assistant's name, for a thread's “Neo is working”. */
  assistant: string;
  /** The “New” line's colour: the blue of Chat's inbox in Chat and Feedback, the brand elsewhere. */
  newTone: 'brand' | 'new';
}

export interface MessageRowProps {
  env: ChatRowEnv;
  item: ChatItem;
  /** The message behind the item; absent for an item without one (none today). */
  message: Message | undefined;
  author: Principal | undefined;
  /** A long press opens the message's menu. */
  menu: boolean;
  /** On iOS the menu as the system draws it (`nativeMenuSpec`, JSON); null where the app's sheet opens instead. */
  menuSpec?: string | null;
  /** The message a link opened at, highlighted for a moment (MX-03). */
  flashed: boolean;
  /** Its thread is open in the right page, with two pages (docs/app/decisions/iphone-duo.md). */
  selected?: boolean;
  /** The settled cards opened in place in this row (its own, the ones inside its run): ids, space-separated (AP-730). */
  open: string;
  /** “More detail” under an agent's short reply, and whether one is being asked for. */
  offersMore: boolean;
  moreBusy: boolean;
  /** Quick replies on the agent's newest message (RM-05). */
  quick: readonly string[] | null;
  quickBusy: boolean;
  /** Its failed turn's Try again: running, and what went wrong with it. */
  retryBusy: boolean;
  retryProblem: { text: string; final: boolean } | null;
  reactBusy: boolean;
  /** Work in its thread (AP-735). */
  work: ThreadWorkView | null;
  /** Its run's Try again is running. */
  runRetrying: boolean;
  reportBusy: boolean;
  /** Its Find My watch's Cancel is running. */
  watchCancelling?: boolean;
  /** Its run's pull request's branch room. */
  branchRoomId: string | null;
  /** “Load earlier replies” under a thread's root (MX-09). */
  earlier: 'none' | 'idle' | 'busy';
  /** What a thread's first message in Chat or Feedback swipes left to (`messageSwipe`); absent: no swipe. */
  swipe?: MessageSwipe;
  /** Its thread has something new to the person: a dot on its replies row (Whombat thread-unread.md). */
  threadNew?: boolean;
  /**
   * Where its thread stands by its flags (`threadStage`: Waiting for you, the assistant is working, Handed over,
   * Settled), on its replies row; null: nothing goes on.
   */
  stage?: ThreadStage | null;
  /** Who is at work from its thread and how far along (a council, a checklist, T3 Code), under its replies. */
  jobLine?: WorkLine | null;
  /** In a thread: its council or Tasks card moved down (`movedCardLinks`); a quiet link to it under its words. */
  movedCard?: MovedCardLink | null;
  /** Under the message, outside its long press: an ended T3 Code job's parts that stay where it finished. */
  below?: ReactNode;
  /** The assistant's newest message in Chat: its face shows what the assistant does about the next reply. */
  liveFace?: ReplyPlace | null;
}

export const MessageRow = memo(function MessageRow({
  env,
  item,
  message,
  author,
  menu,
  menuSpec = null,
  flashed,
  selected,
  open,
  offersMore,
  moreBusy,
  quick,
  quickBusy,
  retryBusy,
  retryProblem,
  reactBusy,
  work,
  runRetrying,
  reportBusy,
  watchCancelling = false,
  branchRoomId,
  earlier,
  swipe = null,
  threadNew = false,
  stage = null,
  jobLine = null,
  movedCard = null,
  below = null,
  liveFace = null,
}: MessageRowProps) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const { timeZone } = useBurrowBase();
  const { rawLocale } = useI18n();
  const findMyWatchWordsHere = findMyWatchWords(rawLocale);
  const settleCopyHere = useMemo(() => settleCopy(rawLocale), [rawLocale]);
  // “just now” for its first minute, then its time: the row follows the clock only until then.
  const time = useNowLabel(
    (now) => sentLabel(item.sentAt, item.time, now, timeZone, rawLocale),
    (now) => item.showAuthor && sentFollowsClock(item.sentAt, now),
  );
  /** A selection of words was showing when this tap began (`textSelectionShowing`). */
  const tappedSelection = useRef(false);
  const wordsRef = useRef<View>(null);
  useEffect(() => registerRowFocus(item.id, wordsRef), [item.id]);
  const { on } = env;
  const isOpen = (id: string) => open !== '' && open.split(' ').includes(id);
  const id = item.id;
  const openMenu = useCallback(() => {
    if (message) on.openMenu(message);
  }, [on, message]);
  const actOnGuide = useCallback((input: GuideActInput) => on.actOnGuide(id, input), [on, id]);
  // Swiped left: Settle (or Open again) at the edge, which a full swipe does, and More, the long press's menu, beside it.
  const swipeActions = useMemo((): SwipeAction[] | null => {
    if (!swipe || !message) return null;
    const spec = menuSpec ? (JSON.parse(menuSpec) as NativeMenuSpec) : null;
    const more: SwipeAction = {
      label: settleCopyHere.more,
      icon: Ellipsis,
      tone: 'neutral',
      run: () => on.openMenu(message),
      menu: spec ? { spec, onPick: (pick) => on.menuAction(message, pick) } : null,
    };
    if (swipe === 'more') return [more];
    const edge: SwipeAction =
      swipe === 'settle'
        ? {
            label: settleCopyHere.swipe,
            icon: Check,
            leaves: true,
            run: () => on.menuAction(message, 'settle'),
          }
        : { label: settleCopyHere.openAgain, icon: Undo2, run: () => on.menuAction(message, 'open_again') };
    return [edge, more];
  }, [swipe, message, menuSpec, on, settleCopyHere]);

  // The assessor's card: its options while undecided (on a runtime with `feedback.decisions`), the full assessment folded.
  const assessmentCardProps = (card: AssessmentCardModel | undefined) => {
    if (!card) return {};
    const details = { title: tMobile('screens.full-assessment'), rows: card.rows, items: card.evidence };
    if (!card.options) return { details };
    return {
      details,
      busy: reportBusy,
      buttons: card.options.map((o, option) => ({
        label: o.label,
        variant: o.recommended ? ('primary' as const) : ('secondary' as const),
        onPress: () => on.decideReport(card.reportId, option),
        accessibilityHint: o.recommended ? tMobile('screens2.message.recommended', { hint: o.hint }) : o.hint,
      })),
    };
  };

  // The run card (AP-705), as the web's: Watch run, Branch room once its pull request has one, Try again on a failed run.
  const runCardProps = (card: CardSummary) => {
    const run = card.run;
    if (!run) return {};
    return {
      actions: [
        { label: tMobile('screens2.message.watchRun'), onPress: () => on.openRun(run.runNumber) },
        ...(run.prNumber !== null
          ? [
              {
                // The run's pull request (AP-712).
                label: `PR #${run.prNumber}`,
                onPress: () => on.openPullRequest(run.prNumber ?? 0),
              },
            ]
          : []),
        ...(branchRoomId
          ? [
              {
                label: tMobile('screens2.message.branchRoom'),
                onPress: () => on.openConversation(branchRoomId),
              },
            ]
          : []),
      ],
      ...(run.retry
        ? {
            buttons: [
              {
                label: tMobile('screens2.common.tryAgain'),
                variant: 'secondary' as const,
                busy: runRetrying,
                onPress: () => on.tryRunAgain(run.runNumber, run.agentName),
                accessibilityHint: tMobile('screens2.chat.retryRunHint', { name: run.agentName }),
              },
            ],
          }
        : {}),
    };
  };

  // A recorded deploy (contracts 0.55, MX-09): its site, and the Deploys screen (work-removal-android.md AP-858).
  const deployCardProps = (card: CardSummary) => {
    const deploy = card.deploy;
    if (!deploy) return {};
    const url = deploy.url;
    return {
      actions: [
        ...(url ? [{ label: tMobile('screens2.message.openSite'), onPress: () => on.openUrl(url) }] : []),
        { label: tMobile('screens2.message.deploys'), onPress: on.openDeploys },
      ],
    };
  };

  // A server task (task-feedback.md AP-4305): its server's page, under the full words its line opens.
  const taskCardProps = (card: CardSummary) => {
    const task = card.task;
    if (!task) return {};
    return {
      actions: [
        {
          label: tMobile('screens2.common.openName', { name: task.server }),
          onPress: () => on.openServer(task.serverId, task.server),
        },
      ],
    };
  };

  // A running watch has a 44dp Cancel button.
  const watchCardProps = (card: CardSummary) => {
    const watch = card.thingWatch ?? card.findMyWatch;
    if (!watch) return {};
    return {
      buttons: [
        {
          label: findMyWatchWordsHere.cancel,
          variant: 'secondary' as const,
          busy: watchCancelling,
          onPress: () =>
            card.thingWatch ? on.cancelThingWatch(watch.watchId) : on.cancelFindMyWatch(watch.watchId),
        },
      ],
    };
  };

  /** A message's card as the card: tapping opens what it is about (an approval, a run), its links and buttons. */
  const fullCard = (card: CardSummary, collapse?: () => void) => (
    <CardSummaryView
      card={card}
      onPress={
        card.approvalNumber !== null
          ? () => on.openApproval(card.approvalNumber ?? 0)
          : card.run
            ? () => on.openRun(card.run?.runNumber ?? 0)
            : undefined
      }
      action={
        card.planId
          ? {
              label: tMobile('screens2.message.openPlan'),
              onPress: () => on.openPlan(card.planId ?? ''),
            }
          : undefined
      }
      {...assessmentCardProps(card.assessment)}
      {...runCardProps(card)}
      {...deployCardProps(card)}
      {...taskCardProps(card)}
      {...watchCardProps(card)}
      {...(collapse ? { collapse } : {})}
      door={
        card.approvalDoor?.waiting && card.approvalNumber !== null
          ? {
              label: tMobile('screens2.message.reviewAnswer'),
              onPress: () => on.openApproval(card.approvalNumber ?? 0),
            }
          : null
      }
    />
  );

  /**
   * A message's card by its state (AP-730): the card, the compact live card of a run at work (AP-733), or its line,
   * which opens the card in place; then what its run did, as lines inside it (AP-732).
   */
  const settledCard = () => {
    const card = item.card;
    if (!card) return null;
    const opened = isOpen(id);
    const collapse = () => on.toggleCard(id);
    if (item.report)
      // A report is a row; Details opens the whole report under it (docs/decisions/report-rows.md RR-02, RR-05).
      return (
        <ReportLineView line={item.report} expanded={opened} onToggle={collapse}>
          {fullCard(card)}
        </ReportLineView>
      );
    let shown: ReactNode;
    if (card.runLine)
      // A run that changed nothing yet is a line, not a card (AP-668).
      shown = (
        <RunLineView
          line={card.runLine}
          onPress={() => on.openRun(card.runLine?.runNumber ?? 0)}
          onRetry={() => {
            const line = card.runLine;
            if (line) on.tryRunAgain(line.runNumber, line.agentName);
          }}
          retrying={runRetrying}
        />
      );
    else if (opened && item.display !== 'full') shown = fullCard(card, collapse);
    else if (item.display === 'live' && card.task) {
      // A server task at work (AP-4305): the live card; its line once it ended.
      const task = card.task;
      shown = (
        <LiveTaskCardView
          task={task}
          clock={env.clock}
          mark={env.serverMark(task.serverId)}
          onOpenServer={() => on.openServer(task.serverId, task.server)}
        />
      );
    } else if (item.display === 'live' && card.runSettled) {
      const run = card.runSettled;
      shown = (
        <LiveRunCardView
          run={run}
          clock={env.clock}
          onWatch={() => on.openRun(run.runNumber)}
          onOpen={collapse}
        />
      );
    } else if (item.display === 'line' && card.runSettled) {
      const run = card.runSettled;
      shown = (
        <SettledLineView
          line={run.line}
          chips={run.chips}
          link={{ label: run.link, onPress: () => on.openRun(run.runNumber) }}
          onOpen={collapse}
        />
      );
    } else if (item.display === 'line' && item.line)
      // A server task's outcome is the line's point: two lines, so the phone doesn't cut it before its time (AP-4305).
      // An ended Find My watch is the line and nothing more: its card would only say it again.
      shown = (
        <SettledLineView
          line={item.line}
          onOpen={card.kind === 'findmy_watch' || card.kind === 'thing_watch' ? undefined : collapse}
          lines={card.task ? 2 : 1}
        />
      );
    else shown = fullCard(card);
    if (!item.inside.length) return shown;
    return (
      <View style={{ alignSelf: 'stretch', gap: 2 }}>
        {shown}
        {item.inside.map((sub) =>
          isOpen(sub.id) && sub.card ? (
            <View key={sub.id} style={{ marginLeft: 18, marginVertical: 4 }}>
              {fullCard(sub.card, () => on.toggleCard(sub.id))}
            </View>
          ) : (
            <SettledLineView key={sub.id} line={sub.line} indent onOpen={() => on.toggleCard(sub.id)} />
          ),
        )}
      </View>
    );
  };

  // A job's result (job-result.md): T3 Code's report laid out under its name, in place of the words and their cards.
  const result = useMemo(
    () => (message && !item.deleted ? jobResultView(message, rawLocale) : null),
    [message, item.deleted, rawLocale],
  );
  const failed = item.turnFailed;
  const opensThread = env.opensThreads && !!message && !item.sending;
  const bodyText = item.card && !item.text ? '' : item.text;
  // What sits under the words: receipts, cards, quick replies, each its own element; none on a deleted message.
  const under = (
    <>
      {item.receipts ? <ReceiptsCard receipts={item.receipts} onOpen={on.openReceipt} /> : null}
      {item.digest ? <DigestCardView card={item.digest} /> : null}
      {item.council ? (
        <CouncilCard
          item={item.council}
          clock={env.clock}
          access={env.access}
          files={env.files}
          openUrl={on.openUrl}
        />
      ) : null}
      {/* A council's thoughts and conclusion read as the message's own words, under its card (CNL-40, CNL-42). */}
      {item.council && wordsUnderCard(item.council.card) ? (
        <MessageBody text={wordsUnderCard(item.council.card) as string} selectable />
      ) : null}
      {item.delegation ? (
        <DelegationCard
          item={item.delegation}
          clock={env.clock}
          access={env.access}
          files={env.files}
          onChange={() => {
            if (message) on.replyHere(message);
          }}
          openUrl={on.openUrl}
        />
      ) : null}
      {/* A delegation's latest words, then its summary, read as the message's own words under its card (delegate.md). */}
      {item.delegation?.card.note ? <MessageBody text={item.delegation.card.note} selectable /> : null}
      {item.guide ? <GuideCardView card={item.guide} onAct={actOnGuide} web={env.guideWeb} /> : null}
      {item.deviceSkill ? <DeviceSkillCardView card={item.deviceSkill} /> : null}
      {item.automationPlan ? (
        // A plan waiting for a yes is the card; decided, its line, which opens the card in place.
        item.display === 'line' && item.line && !isOpen(id) ? (
          <SettledLineView line={item.line} onOpen={() => on.toggleCard(id)} />
        ) : (
          <AutomationPlanCardView
            view={item.automationPlan}
            collapse={item.display === 'line' ? () => on.toggleCard(id) : undefined}
          />
        )
      ) : null}
      {item.featureRequest ? (
        // A feature request waiting for the person is the card; decided, replaced or stopped, its line, which opens
        // the card in place.
        item.display === 'line' && item.line && !isOpen(id) ? (
          <SettledLineView line={item.line} onOpen={() => on.toggleCard(id)} />
        ) : (
          <FeatureRequestCardView
            view={item.featureRequest}
            collapse={item.display === 'line' ? () => on.toggleCard(id) : undefined}
          />
        )
      ) : null}
      {item.lookPlan ? (
        // A thing's plan (handle-it.md): the card; once no longer needed, its line.
        item.display === 'line' && item.line && !isOpen(id) ? (
          <SettledLineView line={item.line} onOpen={() => on.toggleCard(id)} />
        ) : (
          <LookPlanCard
            view={item.lookPlan.view}
            research={item.lookPlan.research}
            variant="thread"
            onChange={() => {
              if (item.lookPlan?.thread) openHref(item.lookPlan.thread);
            }}
          />
        )
      ) : null}
      {failed && item.line && !isOpen(id) ? (
        <SettledLineView line={item.line} onOpen={() => on.toggleCard(id)} />
      ) : failed ? (
        <TurnFailedCardView
          view={failed}
          busy={retryBusy}
          problem={retryProblem?.text ?? null}
          onRetry={
            failed.canRetry && !retryProblem?.final
              ? () => on.retryTurn(failed.dispatchId, failed.agentName)
              : null
          }
          hide={item.line ? <HideCardButton onPress={() => on.toggleCard(id)} /> : null}
        />
      ) : null}
      {settledCard()}
      {offersMore ? (
        <QuickReplies
          suggestions={[tMobile('screens2.message.moreDetail')]}
          onPick={() => on.askMore(id)}
          disabled={moreBusy}
        />
      ) : null}
      {quick ? <QuickReplies suggestions={quick} onPick={on.pickQuick} disabled={quickBusy} /> : null}
    </>
  );
  const cards =
    item.deleted || result ? [] : Children.toArray((under.props as { children: ReactNode }).children);
  // The author line and the words as one element (`messageA11y`), and what its actions do.
  const words = item.showAuthor || item.pinned || item.deleted || bodyText !== '';
  // The person's own message in Chat: their face without their name, “Your message” to screen readers.
  const bare = env.ownBare && item.mine && !item.deleted;
  const a11y = messageA11y(
    {
      author: item.showAuthor ? (bare ? messageA11yWords(rawLocale).yours : item.authorName) : null,
      time: item.showAuthor
        ? [item.edited ? `${time} (edited)` : time, item.ranOn?.marked ? item.ranOn.label : null]
            .filter(Boolean)
            .join(', ')
        : null,
      text: item.deleted ? item.text : bodyText,
      deleted: !!item.deleted,
      pinned: !!item.pinned,
    },
    {
      reply: opensThread,
      settle: swipe === 'settle' || swipe === 'open_again' ? swipe : null,
      more: menu && !!message,
      locale: rawLocale,
    },
  );
  const a11yActions = [
    ...(opensThread ? [{ name: 'activate' }] : []),
    ...(menu && message ? [{ name: 'longpress' }] : []),
    ...a11y.actions,
  ];
  const onA11yAction = (e: AccessibilityActionEvent) => {
    const name = e.nativeEvent.actionName;
    if (name === 'activate' || name === 'reply') on.openThread(id);
    else if (name === 'longpress' || name === 'more') openMenu();
    else if (!message) return;
    else if (name === 'settle' || name === 'open_again') on.menuAction(message, name);
    else if (name === 'copy') on.menuAction(message, 'copy_text');
    else if (name.startsWith('link:')) {
      const href = a11y.links[Number(name.slice(5))];
      if (href) on.openUrl(href);
    }
  };
  const row = (
    // A long press anywhere on the message opens its menu (TalkBack: double-tap and hold); on iPhone a hold on its
    // words selects them instead, and the rest of the message opens the menu (ios-native.md). Not a button of its own,
    // so screen readers still reach the cards and links inside (AP-502). In Chat and Feedback a tap opens the
    // message's thread, as its replies row does; links and buttons inside keep their own tap.
    <Pressable
      accessible={false}
      // While words are selected a tap is for them (iOS shows or clears their menu), not for opening the thread.
      onPressIn={() => {
        tappedSelection.current = textSelectionShowing();
        if (opensThread) on.prefetchThread(id);
      }}
      onPress={
        opensThread
          ? () => {
              if (!tappedSelection.current) on.openThread(id);
            }
          : undefined
      }
      // iOS's own menu takes the long press there; the Pressable's still claims it, so letting go isn't a tap.
      onLongPress={NativeMenuView && menuSpec ? ignoreLongPress : menu && message ? openMenu : undefined}
      delayLongPress={350}
      // A touch that turns into a scroll in the first moments doesn't light the row up.
      unstable_pressDelay={opensThread ? PRESS_DELAY_MS : undefined}
      style={({ pressed }) => [
        { gap: 8 },
        // The message a link opened at, highlighted for a moment (MX-03; the web's pins jump, `hi`); the one whose
        // thread shows in the right page, marked as a list marks what it opened (`sel`); in Chat and Feedback the one
        // under the finger, which opens its thread, as a list row shows its press.
        flashed || selected || (pressed && opensThread)
          ? {
              backgroundColor: flashed ? theme.colors.hi : theme.colors.sel,
              borderRadius: 8,
              marginHorizontal: -8,
              paddingHorizontal: 8,
              marginVertical: -6,
              paddingVertical: 6,
            }
          : null,
      ]}
    >
      {result && message ? (
        <JobResultMessage
          messageId={message.id}
          view={result}
          time={item.edited ? `${time} (edited)` : time}
          accessibilityActions={a11yActions}
          onAccessibilityAction={onA11yAction}
        />
      ) : words ? (
        // The author line and the words are one element for screen readers, with the row's actions (Reply, Settle,
        // More, Copy, a link's Open); the cards under them stay their own. The words' own text view is hidden from
        // them so it isn't heard twice, or as a field to edit.
        <View
          ref={wordsRef}
          accessible
          accessibilityLabel={a11y.label}
          accessibilityActions={a11yActions}
          onAccessibilityAction={onA11yAction}
          style={{ gap: 8 }}
        >
          {item.showAuthor ? (
            <AuthorLine
              avatar={
                <ReplyFace principal={author} size={24} live={liveFace} failed={item.turnFailed !== null} />
              }
              name={bare ? null : item.authorName}
              time={item.edited ? `${time} (edited)` : time}
              // An automation posts as itself: “Automation” beside its name, its mark for a face (AP-1000).
              status={author ? authorStatus(author, rawLocale) : null}
              // What answered the agent's reply in Chat (chat-runtime-android.md AP-2726); a settled thread shown in place
              // says so (chat-settle.md AP-6152).
              after={
                item.ranOn?.marked || item.settled ? (
                  <>
                    {item.ranOn?.marked ? (
                      <RanOnMark
                        provider={item.ranOn.provider}
                        label={item.ranOn.label}
                        text={item.ranOn.text}
                      />
                    ) : null}
                    {item.settled ? <SettledMark /> : null}
                  </>
                ) : null
              }
            />
          ) : null}
          {item.pinned ? <PinnedMark /> : null}
          {item.deleted ? (
            <Tombstone text={item.text} />
          ) : bodyText ? (
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <MessageBody text={bodyText} sending={item.sending} selectable />
            </View>
          ) : null}
        </View>
      ) : null}
      {/*
       * Its card moved down the thread with its news: the words above point there (card-moves.md CM-07); where the
       * person talked about it, the card as it was stays here, folded and read-only.
       */}
      {item.earlier && !item.deleted ? (
        <EarlierCardView
          line={movedCard?.earlierLine ?? item.earlier.line}
          spoken={item.earlier.spoken}
          newest={
            movedCard ? { label: movedCard.label, onPress: () => on.showMessage(movedCard.targetId) } : null
          }
        >
          <CardStillContext.Provider value={true}>
            {item.earlier.council ? (
              <CouncilCard
                item={item.earlier.council}
                clock={env.clock}
                access={env.access}
                files={env.files}
                openUrl={on.openUrl}
              />
            ) : null}
            {item.earlier.delegation ? (
              <DelegationCard
                item={item.earlier.delegation}
                clock={env.clock}
                access={env.access}
                files={env.files}
                onChange={() => {}}
                openUrl={on.openUrl}
              />
            ) : null}
          </CardStillContext.Provider>
        </EarlierCardView>
      ) : movedCard && !item.deleted ? (
        <MovedCardLinkView label={movedCard.label} onPress={() => on.showMessage(movedCard.targetId)} />
      ) : null}
      {cards.length ? <View style={{ alignSelf: 'stretch', gap: 8 }}>{cards}</View> : null}
      {/* Whombat blanked a secret in it and saved it to the Vault, or used it once (VS-07, VS-11; AP-4037). */}
      <VaultSavedLines rows={item.vaultSaved} onOpen={(row) => on.openVaultEntry(row.entryId, row.name)} />
      {/* When fast replies or the model asked for didn't happen, one quiet line each (CR-08, AP-2728). */}
      {item.ranOn?.modelSkipped ? <RanOnNote text={item.ranOn.modelSkipped} fast={false} /> : null}
      {item.ranOn?.fastSkipped ? <RanOnNote text={item.ranOn.fastSkipped} fast /> : null}
      {item.edited && !item.showAuthor ? <EditedMark /> : null}
      {/* What a thread in Chat is about (AP-2459). */}
      {item.subject ? <SubjectChip subject={item.subject} /> : null}
      <LinkPreviews cards={item.previews} />
      {/* A report's screenshots open with its details (RR-05). */}
      {item.report && !isOpen(id) ? null : (
        <MessageAttachmentsView attachments={item.attachments} access={env.access} files={env.files} />
      )}
      <ReactionRow
        pills={item.reactions}
        onToggle={(value, add) => on.react(id, value, add)}
        onAdd={message ? () => on.addReaction(message) : undefined}
        disabled={reactBusy}
      />
      {/* In Chat and Feedback every first message has its row, “No replies yet” before the first reply. */}
      {item.replies || (!env.inThread && (work || stage || jobLine || (opensThread && !item.deleted))) ? (
        <ThreadRepliesRow
          replies={item.replies}
          heads={item.replyHeads}
          lastAt={item.lastReplyAt}
          work={work}
          onOpen={() => on.openThread(id)}
          onPressIn={() => on.prefetchThread(id)}
          isNew={threadNew}
          stage={stage}
          assistant={env.assistant}
          room={opensThread}
          jobLine={jobLine}
        />
      ) : null}
    </Pressable>
  );
  // “Load earlier replies” right under a thread's root (MX-09).
  const earlierRow =
    earlier !== 'none' ? (
      <LoadEarlierRow
        label={loadEarlierReplies(rawLocale)}
        busy={earlier === 'busy'}
        onPress={on.loadEarlier}
        pageSize={THREAD_PAGE_SIZE}
      />
    ) : null;
  // The divider when it ran on something else than the thread's reply before (CR-07, AP-2727).
  const switched = item.ranOn?.switched ?? null;
  const held =
    NativeMenuView && menuSpec && message ? (
      <NativeMenuView
        menu={menuSpec}
        mineColor={theme.colors.sel}
        mineRingColor={theme.colors.brand}
        onMenuAction={(e) => on.menuAction(message, e.nativeEvent.id)}
      >
        {row}
      </NativeMenuView>
    ) : (
      row
    );
  // The panels reach through the list's side margins and cover half the gap to the next message.
  const swiped = swipeActions ? (
    <SwipeRow trailing={swipeActions} gutter={CHAT_GUTTER} gap={CHAT_ROW_GAP}>
      {held}
    </SwipeRow>
  ) : (
    held
  );
  // The same author's next message: without its author line it ran into the one before (AP-6144).
  const continues = item.continues && !switched;
  // Its HTML pages start when it comes into view (AP-909, `useRowInView`).
  if (!item.day && !item.unread && !earlierRow && !switched && !continues && !below)
    return <RowIdContext.Provider value={id}>{swiped}</RowIdContext.Provider>;
  // A day divider, the “New” line and the switch's divider sit above the message (MX-05), outside its long press.
  return (
    <RowIdContext.Provider value={id}>
      <View style={{ gap: 14 }}>
        {continues ? <ContinueLine /> : null}
        {item.day ? <DayDivider label={item.day} /> : null}
        {item.unread ? <UnreadLine label={unreadMarkerText(rawLocale)} tone={env.newTone} /> : null}
        {switched && item.ranOn ? <RunSwitchDivider provider={item.ranOn.provider} text={switched} /> : null}
        {swiped}
        {earlierRow}
        {below}
      </View>
    </RowIdContext.Provider>
  );
});

const ignoreLongPress = () => {};

/** How long a finger rests on a row before it shows as pressed: a scroll begins within it. */
const PRESS_DELAY_MS = 70;

/** A faint hairline halfway down the gap above the same author's next message (AP-6144); decoration only. */
function ContinueLine() {
  const theme = useTheme();
  const half = CHAT_ROW_GAP / 2;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="continue-line"
      style={{ height: 1, marginTop: -half, marginBottom: -half, backgroundColor: theme.colors.line }}
    />
  );
}
