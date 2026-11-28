/**
 * A conversation's messages + composer, shared by the person's Chat and Feedback room and a pull request's branch room:
 * flat full-width rows under author lines, like the web (AP-706), with card summaries, the run line and card (AP-705)
 * and a paperclip that also takes a photo (AP-714). Live: subscribes to the conversation's topic, shows
 * "{name} is thinking" and sends optimistically. With `threadRootId` it shows one thread (the root, then its replies)
 * and answers in it; otherwise a root with replies offers “N replies”, which opens its thread. A `/skill …` message goes
 * as typed: Hermes reads a skill command itself (hermes-engine-app.md AP-5270).
 *
 * The essentials (AP-500…AP-509): a long press opens the message's menu (quick reactions, Reply in thread, Copy text,
 * Copy link, Edit, Pin, Delete), reactions show as pills, links as cards, a failed turn as its card with Try again, a
 * deleted thread root as its tombstone, and edits and pins are marked. One agent (Whombat one-agent.md OA-07; app
 * one-agent.md AP-4982): no `@` list, no “To Banjo” chip, no Ask — a person's message in their room always reaches the
 * agent; `@neo` is still corrected to `@Neo` as it is typed.
 *
 * Mobile chat (MX-01…MX-08): the list follows new content only at the end or after the viewer's own send, else a
 * “New messages ↓” pill (`data/chatScroll`); Return types a new line and the draft is kept per conversation and thread
 * (`useDraft`); a link can open it at a message (`anchor`: pages load until it is there, it is scrolled to and
 * highlighted), and in a thread a message whose council or Tasks card moved to the end links to it the same way
 * (card-moves.md CM-07); day dividers and the “New” line where the viewer had read; light haptics on send and the menu.
 *
 * A threaded room with the agent (`threaded`: Chat or Feedback, Whombat chat-channel.md CHT-02; chat-channel.md
 * AP-2453): every top-level message is a thread the agent answers in, so the work in each thread shows under its root
 * (“Looking into it”, AP-2458), and a top-level message, once sent, opens its thread (`onThreadStarted`).
 *
 * Settled threads (Whombat chat-settle.md CHS-01; chat-settle.md AP-6157, AP-6251): a room leaves them out, they are in
 * Settled (`withoutSettledItems`), and a thread's first message has Settle thread or Open again in its long-press menu,
 * except while the agent works on it or it waits for the person. Swiped left it shows the same at the edge, a full
 * swipe settling it, with More (that menu) beside it; only More when there is nothing to settle.
 *
 * In the Chat room (`chatRoom` 'chat', Whombat chat-runtime.md CR-01…CR-08; chat-runtime-android.md AP-2715…): the
 * composer's “what answers” icon in the pill (a top-level send carries the choice, `messages.send` `runtime`), and
 * the agent's replies say what answered them, with a divider in a thread when that changed.
 *
 * A new chat (the page the list's New chat button opens, and with two pages the right page while nothing is open there)
 * is Chat's top level without its messages (`fresh`): its box starts a thread, which shows there until it opens in its
 * place.
 *
 * Chat and Feedback themselves show their inbox of threads (`inbox`, Whombat chat-inbox.md) in place of the room's
 * messages, without a box: the list's New chat button is the way to a new thread. Inside a thread of theirs the “New” line, in Chat's blue, goes above the first message that was new when
 * it showed.
 */

import { replaceEqualDeep, useQueries, useQueryClient } from '@tanstack/react-query';
import {
  agentWords,
  composerMentionTargets,
  composerText,
  type GuideActInput,
  guideFailureText,
  guideRefusalOf,
  isAutomationPrincipal,
  promptWords,
  thingMark,
  threadHandoffs,
  threadWorkLine,
  type WorkLine,
} from '@whombat/client';
import { newClientId, queryKeys } from '@whombat/client/query';
import {
  cachedThingHead,
  useAgentNow,
  useApiMutation,
  useConversation,
  useDeleteMessage,
  useEditMessage,
  useFindMyWatchCancel,
  useGuideAct,
  useHandoffs,
  useMarkRead,
  useMessagesInfinite,
  usePinMessage,
  useReaction,
  useReadInboxAt,
  useReadThread,
  useRequestMore,
  useRetryTurn,
  useSendMessage,
  useSubscription,
  useThingWatchCancel,
  useThread,
  useThreadUnread,
  useTyping,
  useWhombat,
} from '@whombat/client/react';
import {
  api,
  type ChatRoom,
  type ChatThread,
  canAskForMore,
  conversationLink,
  type Message,
  replySuggestions,
  suggestionMessage,
  type ThreadView,
  thingId,
} from '@whombat/core';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Keyboard,
  Linking,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  View,
  type ViewToken,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeMenuView } from '../../modules/whombat-menu';
import type { ReplyPlace } from '../avatars/ReplyFace';
import { fromDocumentAsset, type PickedFile } from '../data/attachments';
import { useBurrow, useNowLabel, useNowStore } from '../data/BurrowProvider';
import { PROMPTS_ADD, promptsHint, threadReadable, threadReadUpTo } from '../data/chatInbox';
import { roomStage, roomWork } from '../data/chatRoom';
import {
  ANCHOR_FLASH_MS,
  anchorMissingText,
  anchorStep,
  followAction,
  isAtEnd,
  REVEAL_WAIT_MS,
  revealBy,
} from '../data/chatScroll';
import { filesToSend, sendWithFollowUp } from '../data/composerSends';
import { useFileAccess } from '../data/fileAccess';
import type { GuideWeb } from '../data/guides';
import {
  copiedText,
  deleteConfirm,
  type MessageAction,
  messageLinkPath,
  messageMenu,
  messageViewer,
} from '../data/messageActions';
import { type ChatItem, chatItems, dayOf, flattenPages, keepSameItems } from '../data/messages';
import { parseNativeMenuPick } from '../data/nativeMenu';
import { useDraft, useOutboxSend } from '../data/OutboxProvider';
import type { People } from '../data/people';
import { preparePhotos } from '../data/photoUpload';
import { pullRequestTarget } from '../data/pullRequest';
import { quickReactions } from '../data/reactions';
import { readHere } from '../data/readHere';
import { createRowMenus } from '../data/rowMenus';
import { movedCardLinks, threadMessages, threadQuery } from '../data/threadPages';
import { settleOffer, withoutSettledItems } from '../data/threadSettle';
import { isFinalRetryRefusal, offersStop, retriedNotice, retryFailureText, stopConfirm } from '../data/turns';
import { draftAfterSend, type SendEnd } from '../data/unsentDraft';
import { useComposerUploads } from '../data/useComposerUploads';
import { useMessageFiles } from '../data/useFiles';
import { usePrefetchThread, useThreadPlaceholder } from '../data/useThreadOpening';
import { useSettleThread } from '../data/useThreadSettle';
import { useThreadWork } from '../data/useThreadWork';
import { useWebUrl } from '../data/useWebUrl';
import type { ThreadWorkView } from '../data/working';
import { useI18n, useMobileT } from '../i18n';
import { createInViewStore, rowsNearView } from '../lib/inView';
import { UI_ORIGINS } from '../managed/config';
import { useManaged } from '../managed/context';
import { useForeground } from '../managed/useHostStatus';
import { useAppNavigation, useOpenLink, useOpenUrl } from '../navigation/hooks';
import { isBesideThread, useBeside } from '../navigation/panes';
import { type AddChoice, type AttachChoice, attachChoices } from '../ui/attachments';
import { Composer, WorkingBubble } from '../ui/chat';
import { copyToClipboard } from '../ui/clipboard';
import type { GuideActOutcome } from '../ui/guide';
import { ThreadHandoffBar } from '../ui/handoff';
import { haptic } from '../ui/haptics';
import { SquareSlash } from '../ui/icons';
import { CHAT_GUTTER, CHAT_ROW_GAP } from '../ui/insets';
import { InViewStoreContext } from '../ui/inView';
import { NewMessagesPill } from '../ui/jumpPill';
import { KeyboardAvoidingView } from '../ui/keyboard';
import { EmojiSheet, MessageMenuSheet, useRecentEmoji } from '../ui/messageMenu';
import { OutboxRows } from '../ui/outbox';
import { ErrorState, QuietText, SkeletonRows } from '../ui/primitives';
import { type RevealInList, RevealInListContext } from '../ui/revealInList';
import { focusRowSoon, rowAfter } from '../ui/rowFocus';
import { closeSwipeRows } from '../ui/swipeRow';
import { ReadStatePill } from '../ui/updatingPill';
import { useVoiceSource } from '../voice/useComposerVoice';
import { ChatRuntimeControl, useChatRuntimeChoice } from './ChatRuntimeSheet';
import { EditMessageSheet, type EditTarget } from './EditMessageSheet';
import { errorText, showNotice, useDecisionFeedback } from './feedback';
import {
  type ChatRowEnv,
  MessageRow,
  type MessageRowProps,
  type RowHandlers,
  useLatestHandlers,
} from './MessageRow';
import { usePromptsInChat } from './PromptPicker';
import { scrollToRow } from './scrollToRow';

/** The settled cards open in a row, as the row takes them (its own id and those of the cards inside its run, AP-901). */
function openIn(open: ReadonlySet<string>, item: ChatItem): string {
  if (!open.size) return '';
  return [item.id, ...item.inside.map((s) => s.id)].filter((id) => open.has(id)).join(' ');
}

const NO_ROOTS: ReadonlySet<string> = new Set();
const NO_MESSAGES: readonly Message[] = [];

/** Rows drawn when the list opens: about a screenful at its end. */
const INITIAL_ROWS = 8;
/** Rows drawn per step as the reader scrolls towards them. */
const ROWS_PER_BATCH = 4;
/** Screens' worth of rows kept drawn around the one on screen (half above, half below). */
const WINDOW_SCREENS = 7;
/** How long after the finger lets go the list's movement still counts as the reader's (its fling starts within it). */
const READER_SCROLL_GRACE_MS = 250;

/** A row counts as on screen with any part of it showing (AP-909). */
const VIEWABILITY = { itemVisiblePercentThreshold: 1 };

/** A thread's earlier pages as one value that changes only when a page does (MX-09). */
function earlierPagesOf(results: readonly { data?: ThreadView; isPending: boolean }[]) {
  return { pages: results.map((r) => r.data), loading: results.some((r) => r.isPending) };
}

/** The native ScrollView behind a FlatList (its ref type is a View | ScrollView union). */
function canScrollToEnd(ref: unknown): ref is { scrollToEnd: (options: { animated: boolean }) => void } {
  return typeof ref === 'object' && ref !== null && typeof Reflect.get(ref, 'scrollToEnd') === 'function';
}

export interface ChatViewProps {
  conversationId: string | null;
  /** Author lines above the first of each author's messages, the viewer's too: rows are flat (AP-706). */
  authors: boolean;
  placeholder: string;
  /** Shown when the conversation has no messages yet. */
  emptyText?: string;
  /** "‹ …" label on screens opened from here. */
  backLabel: string;
  /**
   * The person's own room with the agent (Chat, Feedback, a thread in them): the agent's quick replies are sent without
   * `@Name` (RM-05); in a branch room they name it.
   */
  ownRoom?: boolean;
  /** After the newest message, above the thinking rows. */
  footer?: ReactNode;
  /**
   * Given the rows as drawn (oldest first), the message `footer` goes under instead of the end; null: the end. An ended
   * T3 Code job's parts stay where it finished once the chat went on (`jobPartsAfter`).
   */
  footerAfter?: ((rows: readonly { id: string; at: string }[]) => string | null) | null;
  /** Show this thread (root and replies) and reply in it, instead of the conversation's top level. */
  threadRootId?: string | null;
  /** What an empty conversation shows instead of `emptyText`; `fill` puts a suggestion in the composer (AP-231). */
  renderEmpty?: (fill: (text: string) => void) => ReactElement;
  /**
   * Open at this message (MX-03): older pages load until it is there (at most `ANCHOR_MAX_PAGES`), it is scrolled into
   * view and highlighted; `onAnchorDone` then lets the screen drop it (so going back or a restored screen doesn't jump).
   */
  anchor?: string | null;
  onAnchorDone?: () => void;
  /**
   * A threaded room with the agent (Chat or Feedback; AP-2453): `workingRoots` are the threads the server says the
   * agent works on (`ChatThread.working`), `waitingRoots` those waiting for the person (`ChatThread.waiting`, which
   * can't be settled), `handedOverRoots` those whose handed-over work goes on (`ChatThread.handedOver`, which
   * can't be settled either), `onThreadStarted` gets a top-level message's id once it is sent.
   */
  threaded?: {
    workingRoots?: ReadonlySet<string>;
    waitingRoots?: ReadonlySet<string>;
    handedOverRoots?: ReadonlySet<string>;
    onThreadStarted?: (rootId: string) => void;
    /** The room's threads as the server lists them: their work (a council, a checklist) for the rows' work line. */
    threadsById?: ReadonlyMap<string, ChatThread>;
  } | null;
  /**
   * The Chat shell's room this is in (Chat or Feedback; null elsewhere). In Chat the composer has the “what answers”
   * button and the agent's replies say what answered them (chat-runtime-android.md AP-2715…AP-2728).
   */
  chatRoom?: ChatRoom | null;
  /** Under the reply box, quietly (a settled thread's “A reply opens it again.”, AP-6154). */
  composerNote?: string | null;
  /**
   * A new chat (AP-6301): none of the conversation's messages, only `renderEmpty` and what is sent from here until
   * `threaded.onThreadStarted` opens its thread; it marks nothing read.
   */
  fresh?: boolean;
  /** A new number puts the cursor in the reply box. */
  focusKey?: number;
  /** In a thread: told whether its first message is on screen, so the header can show the question once it isn't. */
  onRootInView?: ((inView: boolean) => void) | undefined;
  /**
   * Chat's and Feedback's list of open threads (`ChatInbox`), shown in place of the room's messages, which aren't
   * loaded then. No box under it: a new thread starts in the new chat its button opens.
   */
  inbox?: ReactNode;
}

export function ChatView({
  conversationId,
  authors,
  placeholder,
  emptyText,
  backLabel,
  ownRoom = false,
  footer = null,
  footerAfter = null,
  threadRootId = null,
  renderEmpty,
  anchor = null,
  onAnchorDone,
  threaded = null,
  chatRoom = null,
  composerNote = null,
  fresh = false,
  focusKey = 0,
  onRootInView,
  inbox = null,
}: ChatViewProps) {
  const { rawLocale } = useI18n();
  const promptWordsHere = promptWords(rawLocale);

  const { t: tMobile } = useMobileT();
  const { slug, people, mode, bootstrap, clock, viewer: decider, timeZone } = useBurrow();
  // The list's time labels change with the day (Today, Yesterday, the dividers); “just now” and “Last reply 12 min ago”
  // follow the clock in their rows, so the 15-second clock doesn't rebuild the whole history here.
  const nowStore = useNowStore();
  const today = useNowLabel((now) => dayOf(now, timeZone));
  const navigation = useAppNavigation();
  const openLink = useOpenLink();
  const feedback = useDecisionFeedback();
  // A room shown as its inbox lists its threads instead: its messages aren't asked for.
  const input =
    conversationId && !threadRootId && !inbox ? { params: { burrow: slug, conversationId } } : null;
  const history = useMessagesInfinite(input);
  // A thread opens at its newest replies (contracts 0.55, MX-09); “Load earlier replies” adds the page before, each a
  // cached query of its own that realtime keeps current.
  // Until it is there the thread shows its root as the room has it.
  const threadPlaceholder = useThreadPlaceholder(slug, threadRootId);
  const thread = useThread(
    threadRootId ? { params: { burrow: slug, messageId: threadRootId }, query: threadQuery() } : null,
    { placeholderData: threadPlaceholder },
  );
  // The root alone, from the room: nothing is read or looked for in it yet.
  const rootOnly = !!threadRootId && thread.isPlaceholderData;
  const prefetchThread = usePrefetchThread(slug);
  const [earlierCursors, setEarlierCursors] = useState<readonly string[]>([]);
  const { queries: endpointQueries } = useWhombat();
  const earlier = useQueries({
    queries: threadRootId
      ? earlierCursors.map((before) =>
          endpointQueries.endpoint(api.messages.thread, {
            params: { burrow: slug, messageId: threadRootId },
            query: threadQuery(before),
          }),
        )
      : [],
    combine: earlierPagesOf,
  });
  const threadView = useMemo(() => threadMessages(thread.data, earlier.pages), [thread.data, earlier.pages]);
  const loadEarlier = useCallback(() => {
    const before = threadView.more?.before;
    if (before) setEarlierCursors((c) => (c.includes(before) ? c : [...c, before]));
  }, [threadView.more?.before]);
  useSubscription(conversationId ? `conv:${conversationId}` : null);
  const clockMs = useMemo(() => () => clock().getTime(), [clock]);
  const outbox = useOutboxSend({ burrow: slug, conversationId, threadRootId });
  // What was typed here and not sent, kept per conversation and thread.
  const draft = useDraft(conversationId, threadRootId);
  // With two pages, the thread shown beside this conversation (iphone-duo.md): its first message is marked.
  const beside = useBeside();
  // Chat's and Feedback's threads with something new (thread-unread.md): read in the thread, a “New” line where it
  // opened. The demo world answers them too.
  const threadUnread = useThreadUnread(slug, chatRoom ?? 'chat', !!chatRoom);
  const readThread = useReadThread(slug);
  const shows = useForeground();
  const send = useSendMessage(
    { burrow: slug, conversationId: conversationId ?? '', threadRootId },
    { onSuccess: feedback.onResult, onError: feedback.onError },
  );
  // “More detail” under an agent's short reply (docs/decisions/concise-replies.md).
  const more = useRequestMore(slug, { onSuccess: feedback.onResult, onError: feedback.onError });
  const markRead = useMarkRead(slug);
  const readInbox = useReadInboxAt(slug);
  const [fill, setFill] = useState<{ text: string; seq: number } | null>(null);

  // The essentials: what the runtime can do, and the message menu's writes (AP-502…AP-509).
  const viewer = useMemo(() => messageViewer(bootstrap.me), [bootstrap.me]);
  // Who `@Name` means as you type and send: `@banjo` is corrected to `@Banjo` (AP-607, Whombat MS-C03).
  const mentionTargets = useMemo(
    () => composerMentionTargets(bootstrap.principals, bootstrap.me.id),
    [bootstrap.principals, bootstrap.me.id],
  );
  // The conversation itself (the screen's own query, cached): its link for Copy link, its link previews, where the
  // viewer had read.
  const room = useConversation(conversationId ? { params: { burrow: slug, conversationId } } : null);
  const roomConversation = room.data?.conversation;
  // Where the viewer had read when this opened (MX-05): the “New” line goes above the first message after it. Taken
  // from a fresh answer (not a cached one from before the last visit), once; a thread has none.
  const [readPoint, setReadPoint] = useState<{ id: string | null } | undefined>(() =>
    threadRootId ? { id: null } : undefined,
  );
  // A thread of Chat or Feedback that has something new: the message before its first new one (`threadReadUpTo`).
  const [newFrom, setNewFrom] = useState<string | null>(null);
  useEffect(() => {
    if (readPoint || !conversationId) return;
    // Fresh: answered within the stale time. Not `isFetchedAfterMount`, which a live update to the copy read back at
    // start sets too, placing the line from where the viewer had read days ago.
    if (room.data && !room.isStale) setReadPoint({ id: room.data.lastReadMessageId ?? null });
    else if (room.isError) setReadPoint({ id: null });
  }, [readPoint, conversationId, room.data, room.isStale, room.isError]);
  // Save to Files on the messages' files (files-space.md AP-840): In Files opens this conversation's Files.
  const messageFiles = useMessageFiles(conversationId, {
    onOpen: (id) => navigation.navigate('ConversationFiles', { conversationId: id }),
    notice: showNotice,
  });
  const react = useReaction(slug, { onError: feedback.onError });
  const edit = useEditMessage(slug);
  const remove = useDeleteMessage(slug, { onSuccess: feedback.onResult, onError: feedback.onError });
  const pin = usePinMessage(slug, { onSuccess: feedback.onResult, onError: feedback.onError });
  const retry = useRetryTurn(slug);
  // Settle thread and Open again from the long press (AP-6157): changed at once, Undo in the toast.
  const settleThread = useSettleThread();
  const [menuFor, setMenuFor] = useState<Message | null>(null);
  const [emojiFor, setEmojiFor] = useState<Message | null>(null);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [retryProblems, setRetryProblems] = useState<ReadonlyMap<string, { text: string; final: boolean }>>(
    () => new Map(),
  );
  const [recentEmoji, rememberEmoji] = useRecentEmoji();
  const reactTo = (m: Pick<Message, 'id'>, value: string, on: boolean) => {
    if (on) rememberEmoji(value);
    react.mutate({ messageId: m.id, value, on });
  };
  const retryTurn = (dispatchId: string, agentName: string) => {
    setRetryProblems((p) => {
      const next = new Map(p);
      next.delete(dispatchId);
      return next;
    });
    const problem = (text: string, final: boolean) =>
      setRetryProblems((p) => new Map(p).set(dispatchId, { text, final }));
    retry.mutate(
      { dispatchId },
      {
        onSuccess: (result) => {
          if (result.status === 'ok') showNotice(retriedNotice(agentName, rawLocale));
          else problem(retryFailureText(result, rawLocale), false);
        },
        onError: (error) => problem(retryFailureText(error, rawLocale), isFinalRetryRefusal(error)),
      },
    );
  };
  // Stop on the thinking line (contracts 0.55, MX-09): asks first, then `dispatches.cancel`; the line clears when the
  // server says the turn ended. A run's turn answers “Pause the run instead.”.
  const cancelTurn = useApiMutation(api.dispatches.cancel);
  const [stopping, setStopping] = useState<string | null>(null);
  const stopViewer = useMemo(() => ({ id: bootstrap.me.id, kind: 'person' as const }), [bootstrap.me.id]);
  const stopTurn = (dispatchId: string, agentName: string) => {
    const confirm = stopConfirm(agentName, rawLocale);
    Alert.alert(confirm.title, confirm.body, [
      { text: tMobile('screens2.common.cancel'), style: 'cancel' },
      {
        text: confirm.cta,
        style: 'destructive',
        onPress: () => {
          setStopping(dispatchId);
          cancelTurn.mutate(
            { params: { burrow: slug, dispatchId } },
            {
              onSuccess: (result) => {
                if (result.status !== 'ok') feedback.onResult(result);
              },
              onError: feedback.onError,
              onSettled: () => setStopping(null),
            },
          );
        },
      },
    ]);
  };
  const latestStop = useRef(stopTurn);
  latestStop.current = stopTurn;
  const onStopTurn = useCallback(
    (dispatchId: string, agentName: string) => latestStop.current(dispatchId, agentName),
    [],
  );
  // Try again on a failed run's line or card (AP-705, the web's AP-699): `runs.retry`. The line goes live again from the run's own `run.updated`, not from the answer.
  const retryRun = useApiMutation(api.runs.retry);
  const [retryingRun, setRetryingRun] = useState<number | null>(null);
  const tryRunAgain = (runNumber: number, agentName: string) => {
    setRetryingRun(runNumber);
    retryRun.mutate(
      { params: { burrow: slug, number: runNumber } },
      {
        onSuccess: (result) => {
          if (result.status === 'ok') showNotice(retriedNotice(agentName, rawLocale));
          else feedback.onResult(result);
        },
        onError: feedback.onError,
        onSettled: () => setRetryingRun(null),
      },
    );
  };
  const saveEdit = (text: string) => {
    if (!editing) return;
    setEditError(null);
    edit.mutate(
      { messageId: editing.messageId, text: composerText(text, mentionTargets) },
      {
        onSuccess: (result) => {
          if (result.status === 'ok') setEditing(null);
          else feedback.onResult(result);
        },
        onError: (error) => setEditError(errorText(error, rawLocale)),
      },
    );
  };
  // The menu's sheet gone, a screen reader's focus goes back to the message it was opened on.
  const closeMenu = () => {
    if (menuFor) focusRowSoon(menuFor.id);
    setMenuFor(null);
  };
  const act = (m: Message, action: MessageAction) => {
    setMenuFor(null);
    switch (action.kind) {
      case 'settle':
      case 'open_again':
        // Settled, it leaves the list: focus moves on to the next message rather than to the top of the screen.
        if (action.kind === 'settle')
          focusRowSoon(
            rowAfter(
              items.map((i) => i.id),
              m.id,
            ),
          );
        else focusRowSoon(m.id);
        settleThread({ rootId: m.id, room: chatRoom }, action.kind === 'settle');
        return;
      case 'reply_thread':
        navigation.navigate('Thread', { messageId: m.id, back: backLabel });
        return;
      case 'copy_text':
        void copyToClipboard(m.text, copiedText(rawLocale).text, rawLocale);
        return;
      case 'share':
      case 'share_from':
        navigation.navigate(
          'ShareLink',
          m.threadRootId ? { rootId: m.threadRootId, fromMessageId: m.id } : { rootId: m.id },
        );
        return;
      case 'save_prompt':
        navigation.navigate('PromptEdit', { fromText: m.text });
        return;
      case 'copy_link': {
        const url = linkOf(m);
        if (url) void copyToClipboard(url, copiedText(rawLocale).link, rawLocale);
        return;
      }
      case 'edit':
        setEditError(null);
        setEditing({ messageId: m.id, text: m.text, hasAttachments: m.attachments.length > 0 });
        return;
      case 'pin':
      case 'unpin':
        pin.mutate({ messageId: m.id, pinned: action.kind === 'pin' });
        return;
      case 'delete': {
        const confirm = deleteConfirm(m, viewer.id, people.name(m.authorId), rawLocale);
        Alert.alert(confirm.title, confirm.body, [
          { text: tMobile('screens2.common.cancel'), style: 'cancel' },
          {
            text: confirm.cta,
            style: 'destructive',
            onPress: () => remove.mutate({ messageId: m.id, conversationId: m.conversationId }),
          },
        ]);
        return;
      }
    }
  };
  // Copy link (MX-04): the message's web address on this Whombat (the web opens it at the message, and so does the phone).
  const webUrl = useWebUrl();
  const linkOf = (m: Pick<Message, 'id' | 'threadRootId'>): string | null => {
    if (!roomConversation) return null;
    return webUrl(messageLinkPath(m, conversationLink(roomConversation), slug));
  };
  const canLink = mode !== 'fixtures' && !!roomConversation && webUrl('/') !== null;
  // Sharing by link (share-links.md): a thread of the person's Chat, on a box (a link needs Whombat's servers).
  const shareable = useManaged() !== null && chatRoom === 'chat';
  const fillComposer = (text: string) => setFill((f) => ({ text, seq: (f?.seq ?? 0) + 1 }));
  // What the box holds now: a send that didn't go puts its words back above it.
  const typed = useRef('');
  // The box's files that went with a message whose answer isn't back yet.
  const filesOnTheirWay = useRef(new Set<string>());
  const giveBack = (end: SendEnd, sent: string) => {
    const next = draftAfterSend(end, sent, typed.current);
    if (next !== null) fillComposer(next);
  };
  // The person's prompts in their Chat (prompts-phone.md): `/` and the Prompts button; a prompt used on a repository
  // shows as a sent message does, a new one opening its thread.
  const promptsHere = usePromptsInChat({
    room: chatRoom,
    conversationId,
    threadRootId,
    fill: fillComposer,
    onUsed: (used) => {
      jumpToEnd();
      for (const id of ['messages.list', 'messages.thread'])
        void qc.invalidateQueries({ queryKey: queryKeys.scope(id, { burrow: slug }) });
      if (!threadRootId) threadStarted.current?.(used.rootId);
    },
  });
  const savePrompt = !!promptsHere?.canSave;
  const menuOptions = useMemo(
    () => ({
      inThread: !!threadRootId,
      features: { edit: true, pins: true, link: canLink },
      share: shareable,
      savePrompt,
      locale: rawLocale,
    }),
    [threadRootId, canLink, shareable, savePrompt, rawLocale],
  );
  // The assessor's decision (Whombat FB-32): a pick runs its action as the viewer; the card follows by `message.updated`.
  const decideReport = useApiMutation(api.feedback.decide, {
    onSuccess: (result) => {
      feedback.onResult(result);
      for (const id of ['messages.list', 'messages.thread'])
        void qc.invalidateQueries({ queryKey: queryKeys.scope(id, { burrow: slug }) });
    },
    onError: feedback.onError,
  });
  // A Find My watch card's Cancel (findmy-watch.md): the answer turns the card into its line at once, as the server's
  // `message.updated` does a moment later.
  const cancelWatch = useFindMyWatchCancel();
  const cancelThingWatch = useThingWatchCancel();
  // A card's Change something puts the cursor in the reply box, as a new `focusKey` from the screen does.
  const [replyFocus, setReplyFocus] = useState(0);
  const qc = useQueryClient();
  const uploads = useComposerUploads(slug, conversationId);
  // Voice typing in the composer (docs/decisions/dictation.md DT-01): a mic where the Whombat offers it.
  const voiceSource = useVoiceSource();
  // Files are on the server (or the managed Whombat): the demo world (fixtures) has no uploads, so no paperclip there.
  const canAttach = mode !== 'fixtures' && !!conversationId;
  // The box's “+”: what the paperclip offered, then the saved prompts.
  const hasPrompts = !!promptsHere;
  const adds = useMemo<AddChoice[]>(
    () => [
      ...(canAttach
        ? attachChoices(rawLocale).map((c) => ({
            id: c.kind,
            label: c.label,
            hint: c.hint,
            Icon: c.Icon,
            symbol: c.symbol,
          }))
        : []),
      ...(hasPrompts
        ? [
            {
              id: PROMPTS_ADD,
              label: promptWordsHere.title,
              hint: promptsHint(rawLocale),
              Icon: SquareSlash,
              symbol: 'slash.circle',
            },
          ]
        : []),
    ],
    [canAttach, hasPrompts, promptWordsHere.title, rawLocale],
  );
  // Files are authorized per request: nothing is requested before the session token is known. A managed
  // Whombat streams them through its session into scoped cache files (AP-27).
  const managed = useManaged();
  const access = useFileAccess();

  // Guide cards in the person's Chat (AG-15): acts through `guides.act`; paths open on the web (SUB-11).
  const guideWeb = useMemo<GuideWeb>(
    () => ({
      applianceId: managed?.applianceId ?? null,
      uiOrigin: UI_ORIGINS[0] ?? 'https://app.whombat.com',
    }),
    [managed?.applianceId],
  );
  const guideAct = useGuideAct(slug);
  const actOnGuide =
    (messageId: string) =>
    async (input: GuideActInput): Promise<GuideActOutcome> => {
      try {
        const result = await guideAct.mutateAsync({ messageId, ...input });
        if (result.status !== 'ok') feedback.onResult(result);
        // A card at the top of Chat answers into its own thread: open it so the next step is in view.
        else if (threaded && !threadRootId) navigation.navigate('Thread', { messageId, back: backLabel });
        return { ok: result.status === 'ok' };
      } catch (error) {
        const fields = guideRefusalOf(error, rawLocale)?.fields;
        // A form's refusal shows under its fields; `guide_closed` shows nothing (the card is as the server has it).
        if (fields && Object.keys(fields).length) return { ok: false, fields };
        const text = guideFailureText(error, rawLocale);
        if (text) feedback.onText(text);
        return { ok: false };
      }
    };

  // A camera photo goes up at most 2048px on its longest side, as JPEG (AP-908, `preparePhotos`); the pickers hand over
  // the file as it is (`quality: 1`), so it is encoded once.
  const addPhotos = async (assets: readonly ImagePicker.ImagePickerAsset[]) => {
    uploads.add(await preparePhotos(assets, new Date(), rawLocale));
  };
  const pickPhotos = async () => {
    // The system photo picker: no library permission, no EXIF or location asked for.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 10,
      exif: false,
      quality: 1,
    });
    if (result.canceled) return;
    await addPhotos(result.assets);
  };
  // “Take photo” (AP-714): the system camera app, the camera asked for on first use; the photo goes up like a picked one.
  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        tMobile('screens.camera-is-off-for-whombat'),
        tMobile('screens.allow-the-camera-in-your-phones-settings-to'),
        permission.canAskAgain
          ? [{ text: 'OK' }]
          : [
              { text: tMobile('screens2.common.cancel'), style: 'cancel' },
              { text: tMobile('screens2.chat.openSettings'), onPress: () => void Linking.openSettings() },
            ],
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      exif: false,
      quality: 1,
    });
    if (result.canceled) return;
    await addPhotos(result.assets);
  };
  const pickFiles = async () => {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return;
    uploads.add(result.assets.map(fromDocumentAsset).filter((f): f is PickedFile => f !== null));
  };
  const attach = (choice: AttachChoice) => {
    const pickers = { camera: takePhoto, photos: pickPhotos, files: pickFiles };
    void pickers[choice]().catch((error: unknown) => feedback.onError(error));
  };

  // What a new chat sent (its client ids): those show there until their thread opens in its place (AP-6301).
  const [sentHere, setSentHere] = useState<ReadonlySet<string>>(NO_ROOTS);
  const messages = useMemo(() => {
    if (threadRootId) return threadView.messages;
    const all = flattenPages(history.data?.pages);
    return fresh ? all.filter((m) => m.clientId !== null && sentHere.has(m.clientId)) : all;
  }, [threadRootId, threadView.messages, history.data, fresh, sentHere]);
  // In a thread, a message whose council or Tasks card moved to the end links to it (card-moves.md CM-07); a room's
  // rows never hold one.
  const cardLinks = useMemo(
    () => movedCardLinks(threadRootId ? messages : NO_MESSAGES, rawLocale),
    [threadRootId, messages, rawLocale],
  );
  // What answers in the Chat (CR-01, AP-2715): the button's state; in a thread its replies say whether it ran fast.
  const threadReplies = useMemo(
    () => (threadRootId ? messages.filter((m) => m.id !== threadRootId) : NO_MESSAGES),
    [threadRootId, messages],
  );
  const runtimeChoice = useChatRuntimeChoice({ room: chatRoom, threadRootId, replies: threadReplies });
  const runtimeView = runtimeChoice?.view ?? null;
  // The agent's reply in Chat says what answered it, with a divider in a thread when that changed (AP-2725…).
  const ranOn = useMemo(
    () => (chatRoom === 'chat' ? { switches: !!threadRootId, view: runtimeView } : null),
    [chatRoom, threadRootId, runtimeView],
  );
  const moreAbove = !threadRootId && !fresh && history.hasNextPage;
  // A room's top level: every message is a thread of its own, each with its author line (AP-2453).
  const roomTop = !!threaded && !threadRootId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `today` rebuilds it when the day turns, reading the clock then
  const chatBuilt = useMemo(
    () =>
      chatItems(
        messages,
        { people, viewer: decider, timeZone, now: nowStore.get(), locale: rawLocale },
        {
          authors,
          everyAuthor: roomTop,
          threads: !threadRootId,
          readUpTo: fresh ? null : threadRootId ? newFrom : (readPoint?.id ?? null),
          moreAbove,
          ranOn,
        },
      ),
    [
      messages,
      people,
      decider,
      timeZone,
      rawLocale,
      nowStore,
      today,
      authors,
      roomTop,
      threadRootId,
      readPoint,
      newFrom,
      moreAbove,
      ranOn,
      fresh,
    ],
  );
  // Settled threads are in Settled, not in the room (AP-6251); a link to one shows it here, and it stays once the link
  // is done with.
  const [linkedSettled, setLinkedSettled] = useState<string | null>(null);
  useEffect(() => {
    if (anchor && chatBuilt.some((i) => i.id === anchor && i.settled)) setLinkedSettled(anchor);
  }, [anchor, chatBuilt]);
  const built = useMemo(
    () => (roomTop ? withoutSettledItems(chatBuilt, anchor ?? linkedSettled) : chatBuilt),
    [roomTop, chatBuilt, anchor, linkedSettled],
  );
  // Rebuilt with every new message and step of `now`; what says the same stays the same object for the rows (AP-901).
  const keptItems = useRef<ChatItem[]>([]);
  const items = useMemo(() => keepSameItems(keptItems.current, built), [built]);
  const footerAt = useMemo(
    () => (footer && footerAfter ? footerAfter(items.map((i) => ({ id: i.id, at: i.sentAt }))) : null),
    [footer, footerAfter, items],
  );
  keptItems.current = items;
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  // In Chat the assistant's newest face shows what it does about the next reply; every older face stays still.
  const replyPlace = useMemo<ReplyPlace | null>(
    () => (chatRoom === 'chat' && conversationId ? { conversationId, threadRootId } : null),
    [chatRoom, conversationId, threadRootId],
  );
  const liveFaceAt = useMemo(() => {
    if (!replyPlace) return null;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (!item?.showAuthor) continue;
      const author = people.get(item.authorId);
      if (author?.kind === 'agent' && !isAutomationPrincipal(author)) return item.id;
    }
    return null;
  }, [replyPlace, items, people]);
  // Work in the threads under this conversation's roots (AP-735): asked for when a root here has replies, and in a
  // threaded room, where the agent answers every top-level message in a thread under it.
  const threadWork = useThreadWork(
    slug,
    conversationId,
    !threadRootId && !inbox && (!!threaded || items.some((i) => i.replies !== null)),
    people,
  );
  // In a room the agent's thinking reads “Looking into it”, also where only the server knows it works (AP-2458).
  const inRoom = roomTop;
  const workingRoots = threaded?.workingRoots ?? NO_ROOTS;
  const waitingRoots = threaded?.waitingRoots ?? NO_ROOTS;
  const handedOverRoots = threaded?.handedOverRoots ?? NO_ROOTS;
  const roomAgent = inRoom ? people.agent : undefined;
  const roomWords = useMemo(() => agentWords(roomAgent?.name, rawLocale), [roomAgent?.name, rawLocale]);
  const roomShown = useRef(new Map<string, ThreadWorkView | null>());
  const threadWorkFor = useMemo(() => {
    if (!inRoom) return threadWork;
    return (rootId: string) => {
      const view = replaceEqualDeep(
        roomShown.current.get(rootId) ?? null,
        roomWork(threadWork(rootId), workingRoots.has(rootId), roomAgent, roomWords, rawLocale),
      );
      roomShown.current.set(rootId, view);
      return view;
    };
  }, [inRoom, threadWork, workingRoots, roomAgent, roomWords, rawLocale]);
  // Who is at work from each thread and how far along (a council, a checklist, T3 Code), under its replies.
  const roomThreads = roomTop ? (threaded?.threadsById ?? null) : null;
  const handoffsHere = useHandoffs(slug, conversationId, !!roomThreads);
  const jobShown = useRef(new Map<string, WorkLine | null>());
  const jobLineFor = useMemo(() => {
    if (!roomThreads) return (_rootId: string): WorkLine | null => null;
    const nowMs = Date.now();
    return (rootId: string) => {
      const t = roomThreads.get(rootId);
      const line = threadWorkLine(
        { work: t?.work ?? null },
        threadHandoffs(handoffsHere, rootId, t?.lastAt ?? null, nowMs),
        nowMs,
      );
      // The clock and the words a screen reader hears follow the app's clock in the row: the rest decides a redraw.
      const kept = replaceEqualDeep(
        jobShown.current.get(rootId) ?? null,
        line ? { ...line, spoken: '' } : null,
      );
      jobShown.current.set(rootId, kept);
      return kept;
    };
  }, [roomThreads, handoffsHere]);
  // A room's thread first message offers Settle thread or Open again; nothing while the agent works on it (the server
  // says so, or something happens in it now), it waits for the person or work handed over from it goes on.
  const roomMenuOptions = useMemo(
    () =>
      roomTop
        ? {
            ...menuOptions,
            settle: (m: Message) =>
              settleOffer({
                settled: m.settled,
                working: workingRoots.has(m.id) || threadWork(m.id) !== null,
                waiting: waitingRoots.has(m.id),
                handedOver: handedOverRoots.has(m.id),
              }),
          }
        : menuOptions,
    [roomTop, menuOptions, workingRoots, waitingRoots, handedOverRoots, threadWork],
  );
  const threadStarted = useRef(threaded?.onThreadStarted);
  threadStarted.current = threaded?.onThreadStarted;
  // Quick replies on the agent's newest message (RM-05); a tap sends like the composer.
  const quick = useMemo(
    () => replySuggestions(messages, decider.id, (id) => people.get(id)?.kind === 'agent'),
    [messages, decider.id, people],
  );
  const pick = (text: string) => {
    if (!quick) return;
    haptic('send');
    jumpToEnd();
    const agent = people.get(quick.authorId);
    send.mutate({ text: suggestionMessage(text, agent?.name ?? '', ownRoom || !agent) });
  };

  // Read up to the newest server message (not in the fixture world, which has no read markers).
  const lastId = [...messages].reverse().find((m) => !m.id.startsWith('msg_local-'))?.id;
  const markReadRef = useRef(markRead.mutate);
  markReadRef.current = markRead.mutate;
  const readInboxRef = useRef(readInbox);
  readInboxRef.current = readInbox;
  const qcRef = useRef(qc);
  qcRef.current = qc;
  const slugRef = useRef(slug);
  slugRef.current = slug;
  const readKnown = readPoint !== undefined;
  const readThreadRef = useRef(readThread);
  readThreadRef.current = readThread;
  // Something new in the thread on screen: read once the app shows it (Chat and Feedback, thread-unread.md).
  const newHere = threadRootId && chatRoom && shows ? (threadUnread.get(threadRootId) ?? 0) : 0;
  // Where the thread had been read when something new showed in it: the “New” line goes above the first new message,
  // and stays there while the thread is open. Taken before the read below clears the count.
  const readable = threadReadable({ rootOnly, fetching: !!threadRootId && thread.isFetching });
  useEffect(() => {
    if (newFrom || !readable || newHere <= 0) return;
    const id = threadReadUpTo(messages, newHere, decider.id);
    if (id) setNewFrom(id);
  }, [newFrom, readable, newHere, messages, decider.id]);
  useEffect(() => {
    const read = readHere({
      shows,
      fresh,
      rootOnly,
      hasConversation: !!conversationId,
      hasLast: !!lastId,
      thread: !!threadRootId,
      newInThread: newHere,
      threadReadable: readable,
      readKnown,
      demo: mode === 'fixtures',
    });
    if (!read || !conversationId || !lastId) return;
    // A thread's replies don't move the conversation's read marker (its top level does); they read the thread's
    // inbox rows (AP-704), and in Chat and Feedback the thread's own marker, which reads them too (the demo world's
    // too: its Chat lists what is new).
    if (read === 'thread' && threadRootId)
      readThreadRef.current({ conversationId, rootId: threadRootId, messageId: lastId });
    else if (read === 'inbox' && threadRootId) readInboxRef.current(conversationId, threadRootId);
    else if (read === 'conversation') {
      // Only once where the viewer had read is known (MX-05): the answer must not already say “read up to here”.
      markReadRef.current({ conversationId, messageId: lastId });
      // The cached conversation says so too, so the next visit's “New” line starts here.
      qcRef.current.setQueriesData<{ conversation: { id: string }; lastReadMessageId: string | null }>(
        { queryKey: queryKeys.scope('conversations.get', { burrow: slugRef.current }) },
        (d) => (d?.conversation.id === conversationId ? { ...d, lastReadMessageId: lastId } : d),
      );
    }
  }, [shows, mode, fresh, rootOnly, readable, conversationId, lastId, threadRootId, readKnown, newHere]);

  const list = useRef<FlatList<ChatItem>>(null);
  const firstIndex = useRef<number | undefined | null>(null);
  // With nothing of the system's above the header (the iPhone Duo keeps its clock down the side), iOS takes a tap on
  // the header's buttons as a tap on the status bar too and would scroll the conversation to its first message.
  const statusBarAbove = useSafeAreaInsets().top > 0;
  // The rows on screen and next to it, for their HTML pages (AP-909): a store the pages read, not state, so the rows
  // don't re-render as they scroll by.
  const inView = useMemo(() => createInViewStore(), []);
  const itemIds = useRef<string[]>([]);
  itemIds.current = items.map((i) => i.id);
  const rootSeen = useRef({ id: threadRootId, tell: onRootInView });
  rootSeen.current = { id: threadRootId, tell: onRootInView };
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken<ChatItem>[] }) => {
    inView.set(
      rowsNearView(
        itemIds.current,
        viewableItems.map((v) => v.index),
      ),
    );
    const root = rootSeen.current;
    if (root.id && root.tell) root.tell(viewableItems.some((v) => v.item?.id === root.id));
  }).current;
  // Follow the newest message only while the reader is at the end (MX-01): new content, the thinking row and the list
  // shrinking for the keyboard keep them there; someone reading further up stays put, and a new message below shows
  // the “New messages ↓” pill. Their own send takes them to the end (`jumpToEnd`).
  const last = items.at(-1)?.id ?? '';
  const lastRef = useRef(last);
  lastRef.current = last;
  const seen = useRef('');
  const atEnd = useRef(true);
  const [newBelow, setNewBelow] = useState(false);
  // An anchor owns the scroll while it is looked for and shown (MX-03).
  const anchoring = useRef(anchor !== null);
  // The native ScrollView's end, not FlatList's: FlatList computes it from the last row's (estimated, when
  // it has not been measured yet) frame and leaves out the content's bottom padding, so a message just sent
  // ended up under the composer (Android verification).
  const scrollToEnd = () => {
    const native: unknown = list.current?.getNativeScrollRef();
    if (canScrollToEnd(native)) native.scrollToEnd({ animated: false });
    else list.current?.scrollToEnd({ animated: false });
  };
  // At most one jump and one follow-up per frame: rows laid out in batches each change the content's size, and each
  // asked for two scrolls to the end.
  const endFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (endFrame.current !== null) cancelAnimationFrame(endFrame.current);
    },
    [],
  );
  const jumpToEnd = () => {
    seen.current = lastRef.current;
    atEnd.current = true;
    anchoring.current = false;
    setNewBelow(false);
    if (endFrame.current !== null) return;
    scrollToEnd();
    // Again after the frame, once: footers (the thinking row) and the frame's other rows finish their layout after the
    // size change.
    endFrame.current = requestAnimationFrame(() => {
      endFrame.current = null;
      scrollToEnd();
    });
  };
  // Whether the list moves because the reader moves it (a drag, its fling): only then can they leave the end. The
  // list also moves by itself — rows above taking their real size, the content growing before its scroll event — and
  // judging those by position pulled a reader who had scrolled up back down, or left one at the end behind.
  const dragging = useRef(false);
  const flinging = useRef(false);
  const handsOffAt = useRef(0);
  const readerScrolls = () => dragging.current || flinging.current || Date.now() < handsOffAt.current;
  // A field in a row: once the keyboard is up and the list has shrunk above it (the list's own following has
  // run by then), the list scrolls just enough that the field's form shows above the composer.
  const listBox = useRef<View>(null);
  // Where the list is: its scroll events are throttled with no last one, so where a scroll ends counts too.
  const scrollY = useRef(0);
  const keepScrollY = ({ nativeEvent: e }: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollY.current = e.contentOffset.y;
  };
  const reveal = useCallback<RevealInList>((node) => {
    const show = () =>
      requestAnimationFrame(() => {
        const box = listBox.current;
        if (!box || !node) return;
        box.measureInWindow((_x, top, _width, height) =>
          node.measureInWindow((_nx, nodeTop, _nodeWidth, nodeHeight) => {
            const by = revealBy(
              { top: nodeTop, bottom: nodeTop + nodeHeight },
              { top, bottom: top + height },
            );
            if (by > 0) list.current?.scrollToOffset({ offset: scrollY.current + by, animated: true });
          }),
        );
      });
    if (Keyboard.isVisible()) {
      show();
      return;
    }
    const shown = Keyboard.addListener('keyboardDidShow', () => {
      shown.remove();
      show();
    });
    // A hardware keyboard raises nothing: stop waiting for it.
    setTimeout(() => shown.remove(), REVEAL_WAIT_MS);
  }, []);
  // What would have taken the list to the end while the reader scrolled: asked again once they let go.
  const followLater = useRef(false);
  const afterReaderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (afterReaderTimer.current !== null) clearTimeout(afterReaderTimer.current);
    },
    [],
  );
  const follow = (shrank = false) => {
    const action = followAction({
      atEnd: atEnd.current,
      seen: seen.current,
      last: lastRef.current,
      anchored: anchoring.current,
      shrank,
      reader: readerScrolls(),
    });
    if (action === 'end') jumpToEnd();
    else if (action === 'pill') setNewBelow(true);
    else if (action === 'later') followLater.current = true;
  };
  // The reader let go (a drag's end, a fling's end): once their scroll is over, what changed meanwhile is followed if
  // they are still at the end, or shows the pill if they left it.
  const afterReader = () => {
    if (afterReaderTimer.current !== null) clearTimeout(afterReaderTimer.current);
    afterReaderTimer.current = setTimeout(() => {
      afterReaderTimer.current = null;
      if (!followLater.current || readerScrolls()) return;
      followLater.current = false;
      follow();
    }, READER_SCROLL_GRACE_MS + 20);
  };
  // The list's height as last laid out: a thread folding away shrinks it frame by frame.
  const contentHeight = useRef(0);
  const followSize = (_width: number, height: number) => {
    const shrank = height < contentHeight.current;
    contentHeight.current = height;
    follow(shrank);
  };

  // Opening at a message (MX-03): load older pages until it is there, then scroll to it and highlight it.
  const [flash, setFlash] = useState<string | null>(null);
  const anchorDone = useRef(onAnchorDone);
  anchorDone.current = onAnchorDone;
  // Older messages: the conversation's next page, or a thread's earlier replies.
  const pagesLoaded = threadRootId ? earlierCursors.length + 1 : (history.data?.pages.length ?? 0);
  const loadingOlder = threadRootId ? earlier.loading : history.isFetchingNextPage;
  const fetchOlder = threadRootId ? loadEarlier : history.fetchNextPage;
  const olderToLoad = threadRootId ? threadView.more !== null : moreAbove;
  const anchorSource = threadRootId ? thread : history;
  const anchorReady = !!conversationId && !anchorSource.isPending && !rootOnly;
  const handledAnchor = useRef<string | null>(null);
  // A moved card's link (card-moves.md CM-07) goes to the card's message the same way, again on every tap; a new
  // message the screen opens at wins over it, and only the screen's own is reported done.
  const [jump, setJump] = useState<{ id: string; tap: number; over: string | null } | null>(null);
  const jumping = jump !== null && jump.over === anchor;
  const target = jumping ? jump.id : anchor;
  const targetKey = jumping ? `${jump.id} ${jump.tap}` : anchor;
  // biome-ignore lint/correctness/useExhaustiveDependencies: jumpToEnd reads refs only
  useEffect(() => {
    if (!target || !anchorReady || handledAnchor.current === targetKey) return;
    anchoring.current = true;
    const step = anchorStep({
      anchor: target,
      items,
      hasMore: olderToLoad,
      loading: loadingOlder,
      pagesLoaded,
    });
    if (step.kind === 'wait') return;
    if (step.kind === 'load') {
      void fetchOlder();
      return;
    }
    handledAnchor.current = targetKey;
    if (!jumping) anchorDone.current?.();
    if (step.kind === 'missing') {
      showNotice(anchorMissingText(rawLocale));
      jumpToEnd();
      return;
    }
    // Shown where it is: the reader is not at the end now, and what arrives later shows the pill.
    seen.current = lastRef.current;
    atEnd.current = false;
    setFlash(step.id);
    // The next frame's may find the list shorter (`scrollToRow`).
    const toIt = () => scrollToRow(list.current, { index: step.index, viewPosition: 0.3, animated: false });
    toIt();
    requestAnimationFrame(toIt);
  }, [
    target,
    targetKey,
    jumping,
    anchorReady,
    items,
    olderToLoad,
    loadingOlder,
    pagesLoaded,
    fetchOlder,
    rawLocale,
  ]);
  // The highlight fades after a moment; then the list follows the end again once the reader gets there.
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => {
      setFlash(null);
      anchoring.current = false;
    }, ANCHOR_FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);
  // Cards that settle into a line (docs/decisions/card-settle.md AP-730): which settled cards the reader opened here.
  const [openCards, setOpenCards] = useState<ReadonlySet<string>>(() => new Set());
  const openRun = (runNumber: number) => navigation.navigate('Run', { number: runNumber, back: backLabel });
  const openUrl = useOpenUrl();

  // What the rows ask of the screen (AP-901): one object for the screen's life, running this render's handlers.
  const on = useLatestHandlers<RowHandlers>({
    openMenu: (message) => {
      haptic('menu');
      setMenuFor(message);
    },
    // iOS's own menu (ios-message-menu.md): the same reactions and actions as the sheet, read again from the message
    // as it is now.
    menuAction: (message, id) => {
      const pick = parseNativeMenuPick(id);
      if (pick?.kind === 'react')
        reactTo(message, pick.value, !message.reactions.some((r) => r.value === pick.value && r.mine));
      else if (pick?.kind === 'more') setEmojiFor(message);
      else if (pick?.kind === 'action') {
        const action = messageMenu(message, viewer, roomMenuOptions)?.actions.find(
          (a) => a.kind === pick.action,
        );
        if (action && !action.disabled) act(message, action);
      }
    },
    addReaction: (message) => setEmojiFor(message),
    react: (messageId, value, add) => reactTo({ id: messageId }, value, add),
    toggleCard: (id) =>
      setOpenCards((open) => {
        const next = new Set(open);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    openThread: (messageId) => navigation.navigate('Thread', { messageId, back: backLabel }),
    prefetchThread,
    openReceipt: (r) => {
      if (r.link) openLink(r.link, backLabel);
    },
    actOnGuide: (messageId, input) => actOnGuide(messageId)(input),
    retryTurn,
    askMore: (messageId) => more.mutate({ messageId }),
    pickQuick: pick,
    openRun,
    tryRunAgain,
    openApproval: (number) => navigation.navigate('Approval', { number, back: backLabel }),
    openPlan: (planId) => navigation.navigate('Plan', { planId, back: backLabel }),
    openPullRequest: (prNumber) =>
      navigation.navigate('PullRequest', {
        ...pullRequestTarget(bootstrap.sidebar.branchRooms, prNumber),
        back: backLabel,
      }),
    openConversation: (id) => navigation.navigate('Conversation', { conversationId: id }),
    openUrl,
    openDeploys: () => navigation.navigate('Deploys', { back: backLabel }),
    openServer: (serverId, name) =>
      navigation.navigate('Thing', { thingId: thingId('server', serverId), title: name, back: backLabel }),
    openVaultEntry: (entryId, name) =>
      navigation.navigate('VaultEntry', { entryId, title: name, back: backLabel }),
    decideReport: (reportId, option) =>
      decideReport.mutate({ params: { burrow: slug, id: reportId }, body: { option } }),
    // A refusal says why, as the other cards' answers do.
    cancelFindMyWatch: (watchId) =>
      cancelWatch.mutate(
        { params: { burrow: slug, watchId }, body: {} },
        { onSuccess: feedback.onResult, onError: feedback.onError },
      ),
    cancelThingWatch: (watchId) =>
      cancelThingWatch.mutate(
        { params: { burrow: slug, watchId }, body: {} },
        { onSuccess: feedback.onResult, onError: feedback.onError },
      ),
    // In its thread the reply box is right here; elsewhere its thread opens.
    replyHere: (message) => {
      if (threadRootId) setReplyFocus((n) => n + 1);
      else navigation.navigate('Thread', { messageId: message.threadRootId ?? message.id, back: backLabel });
    },
    loadEarlier,
    showMessage: (messageId) => setJump((j) => ({ id: messageId, tap: (j?.tap ?? 0) + 1, over: anchor })),
  });
  // A server task's mark (AP-4305): what Home's things say the server runs, read from the cache when the card draws.
  const serverMark = useCallback(
    (serverId: string) => {
      const head = cachedThingHead(qc, slug, thingId('server', serverId));
      return head ? thingMark(head) : null;
    },
    [qc, slug],
  );
  const rowEnv = useMemo<ChatRowEnv>(
    () => ({
      on,
      inThread: !!threadRootId,
      opensThreads: roomTop,
      guideWeb,
      access,
      files: messageFiles,
      clock: clockMs,
      serverMark,
      ownBare: !!chatRoom,
      assistant: roomWords.Name,
      newTone: chatRoom ? 'new' : 'brand',
    }),
    [
      on,
      threadRootId,
      roomTop,
      guideWeb,
      access,
      messageFiles,
      clockMs,
      serverMark,
      chatRoom,
      roomWords.Name,
    ],
  );

  // One row per item (AP-901): the same function until something a row shows changes, and each row memoised on its own
  // share of it, so typing, an agent's activity or presence don't re-render the conversation's rows. A busy button goes
  // only to the row it is on.
  const retryingDispatch = retry.isPending ? (retry.variables?.dispatchId ?? null) : null;
  const reactingTo = react.isPending ? (react.variables?.messageId ?? null) : null;
  const decidingReport = decideReport.isPending ? (decideReport.variables?.params.id ?? null) : null;
  const cancellingWatch = cancelWatch.isPending ? (cancelWatch.variables?.params.watchId ?? null) : null;
  const cancellingThingWatch = cancelThingWatch.isPending
    ? (cancelThingWatch.variables?.params.watchId ?? null)
    : null;
  const branchRooms = bootstrap.sidebar.branchRooms;
  const earlierRow: MessageRowProps['earlier'] = threadView.more ? (loadingOlder ? 'busy' : 'idle') : 'none';
  const moreBusy = more.isPending;
  const sendBusy = send.isPending;
  // Each row's menu, iOS's menu and swipe, kept per message while what decides them is the same.
  const rowMenus = useMemo(() => createRowMenus(!!NativeMenuView), []);
  const renderItem = useCallback(
    ({ item }: { item: ChatItem }) => {
      const message = byId.get(item.id);
      const author = people.get(item.authorId);
      const failed = item.turnFailed;
      const offersMore = !!message && canAskForMore(message, author, decider);
      const runNumber = item.card?.runLine?.runNumber ?? item.card?.run?.runNumber ?? null;
      const prNumber = item.card?.run?.prNumber ?? null;
      const quickHere = quick && item.id === quick.messageId ? quick.suggestions : null;
      // Work in its thread, asked once: its reply row shows it, and while there is some the thread can't settle (CHS-03).
      const work = threadWorkFor(item.id);
      const row = message
        ? rowMenus(message, {
            viewer,
            options: menuOptions,
            offer: roomTop
              ? settleOffer({
                  settled: message.settled,
                  working: work !== null,
                  waiting: waitingRoots.has(message.id),
                  handedOver: handedOverRoots.has(message.id),
                })
              : null,
            ranOn: item.ranOn?.text ?? null,
            roomTop,
          })
        : null;
      const reportHere =
        decidingReport !== null &&
        (item.card?.assessment?.reportId === decidingReport ||
          item.inside.some((sub) => sub.card?.assessment?.reportId === decidingReport));
      return (
        <MessageRow
          env={rowEnv}
          item={item}
          message={message}
          author={author}
          menu={row?.menu != null}
          menuSpec={row?.spec ?? null}
          flashed={flash === item.id}
          selected={isBesideThread(beside, message?.id)}
          open={openIn(openCards, item)}
          offersMore={offersMore}
          moreBusy={offersMore && moreBusy}
          quick={quickHere}
          quickBusy={!!quickHere && sendBusy}
          retryBusy={!!failed && retryingDispatch === failed.dispatchId}
          retryProblem={(failed && retryProblems.get(failed.dispatchId)) ?? null}
          reactBusy={reactingTo === item.id}
          work={work}
          runRetrying={runNumber !== null && retryingRun === runNumber}
          reportBusy={reportHere}
          watchCancelling={
            (cancellingWatch !== null && item.card?.findMyWatch?.watchId === cancellingWatch) ||
            (cancellingThingWatch !== null && item.card?.thingWatch?.watchId === cancellingThingWatch)
          }
          branchRoomId={
            prNumber !== null ? (branchRooms.find((r) => r.prNumber === prNumber)?.id ?? null) : null
          }
          earlier={threadRootId && item.id === threadRootId ? earlierRow : 'none'}
          swipe={row?.swipe ?? null}
          threadNew={roomTop && !isBesideThread(beside, message?.id) && (threadUnread.get(item.id) ?? 0) > 0}
          stage={
            roomTop && message
              ? roomStage(
                  {
                    waiting: waitingRoots.has(item.id),
                    working: workingRoots.has(item.id),
                    handedOver: handedOverRoots.has(item.id),
                    settled: message.settled,
                  },
                  work,
                )
              : null
          }
          jobLine={roomTop ? jobLineFor(item.id) : null}
          movedCard={cardLinks.get(item.id) ?? null}
          below={item.id === footerAt ? footer : null}
          liveFace={item.id === liveFaceAt ? replyPlace : null}
        />
      );
    },
    [
      footer,
      footerAt,
      jobLineFor,
      cardLinks,
      rowEnv,
      byId,
      people,
      decider,
      viewer,
      menuOptions,
      rowMenus,
      waitingRoots,
      workingRoots,
      handedOverRoots,
      flash,
      beside,
      openCards,
      quick,
      moreBusy,
      sendBusy,
      retryingDispatch,
      retryProblems,
      reactingTo,
      threadWorkFor,
      retryingRun,
      decidingReport,
      cancellingWatch,
      cancellingThingWatch,
      branchRooms,
      threadRootId,
      earlierRow,
      roomTop,
      threadUnread,
      liveFaceAt,
      replyPlace,
    ],
  );

  const source = threadRootId ? thread : history;
  const showsList = !!conversationId && !source.isPending && !(source.error && !source.data);
  // Where the list starts, fixed when it mounts: the list reads it only then. A thread showing only its root from the
  // room gets a new list when its replies come, which opens at their end.
  if (!showsList || rootOnly) firstIndex.current = null;
  else if (firstIndex.current === null)
    firstIndex.current = !anchor && items.length > INITIAL_ROWS ? items.length - INITIAL_ROWS : undefined;
  let body: React.ReactNode;
  if (inbox && !threadRootId) body = inbox;
  else if (!conversationId || source.isPending)
    body = <SkeletonRows count={6} avatarSize={24} lines={1} label={tMobile('screens.loading-messages')} />;
  else if (source.error && !source.data)
    body = <ErrorState text={tMobile('screens.messages-didnt-load')} onRetry={() => void source.refetch()} />;
  else
    body = (
      <View ref={listBox} collapsable={false} style={{ flex: 1 }}>
        <InViewStoreContext.Provider value={inView}>
          <FlatList
            key={rootOnly ? 'root' : 'list'}
            ref={list}
            data={items}
            keyExtractor={(m) => m.key ?? m.id}
            renderItem={renderItem}
            style={{ flex: 1 }}
            contentContainerStyle={{
              gap: CHAT_ROW_GAP,
              paddingVertical: 18,
              paddingHorizontal: CHAT_GUTTER,
              flexGrow: 1,
            }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            // Pulling the messages down takes the keyboard with the finger, as in iOS's own chats.
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            onContentSizeChange={followSize}
            // Opens at its newest rows (unless a link opens it at a message): the last screenful is drawn first, then the
            // rows above as the reader nears them, a few at a time, instead of the whole history from its oldest.
            initialScrollIndex={firstIndex.current ?? undefined}
            initialNumToRender={INITIAL_ROWS}
            maxToRenderPerBatch={ROWS_PER_BATCH}
            windowSize={WINDOW_SCREENS}
            onLayout={() => follow()}
            onScroll={({ nativeEvent: e }) => {
              scrollY.current = e.contentOffset.y;
              // Away from the end only by the reader's own scrolling; reaching it counts however it happens.
              if (isAtEnd(e)) atEnd.current = true;
              else if (readerScrolls()) atEnd.current = false;
              // Reaching the end by hand: what was new there is seen.
              if (atEnd.current && !anchoring.current) {
                seen.current = lastRef.current;
                setNewBelow(false);
              }
            }}
            onScrollToIndexFailed={(info) => {
              // The list's own scroll to where it opens, before that row is measured: the end is where it opens.
              if (!anchoring.current) {
                if (atEnd.current) jumpToEnd();
                return;
              }
              // Not laid out that far yet: near it by the average row, then to the row itself (MX-03).
              list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
              setTimeout(
                () => scrollToRow(list.current, { index: info.index, viewPosition: 0.3, animated: false }),
                60,
              );
            }}
            onScrollBeginDrag={() => {
              dragging.current = true;
              // A scroll closes a swiped thread's panels.
              closeSwipeRows();
            }}
            onScrollEndDrag={(e) => {
              dragging.current = false;
              // Its fling, if any, begins just after.
              handsOffAt.current = Date.now() + READER_SCROLL_GRACE_MS;
              keepScrollY(e);
              afterReader();
            }}
            onMomentumScrollBegin={() => {
              flinging.current = true;
            }}
            onMomentumScrollEnd={(e) => {
              flinging.current = false;
              handsOffAt.current = Date.now() + READER_SCROLL_GRACE_MS;
              keepScrollY(e);
              afterReader();
            }}
            // The status bar's tap to the top is the reader's too.
            onScrollToTop={() => {
              atEnd.current = false;
            }}
            scrollEventThrottle={100}
            viewabilityConfig={VIEWABILITY}
            onViewableItemsChanged={onViewableItemsChanged}
            onStartReached={() => {
              if (threadRootId || fresh) return;
              if (history.hasNextPage && !history.isFetchingNextPage) void history.fetchNextPage();
            }}
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            scrollsToTop={statusBarAbove}
            ListEmptyComponent={
              renderEmpty ? renderEmpty(fillComposer) : emptyText ? <QuietText>{emptyText}</QuietText> : null
            }
            ListFooterComponent={
              <ChatFooter
                conversationId={conversationId}
                threadRootId={threadRootId}
                footer={footerAt ? null : footer}
                people={people}
                clock={clockMs}
                stopViewer={stopViewer}
                stopping={stopping}
                onStop={onStopTurn}
              />
            }
          />
        </InViewStoreContext.Provider>
        <ReadStatePill source={source} />
        {newBelow ? <NewMessagesPill onPress={jumpToEnd} /> : null}
      </View>
    );

  const menuModel = menuFor ? messageMenu(menuFor, viewer, roomMenuOptions) : null;
  return (
    // Kept clear of the keyboard as it moves, measured in the window, so a page beside a list or above a tab bar
    // gives up only the part the keyboard covers.
    <KeyboardAvoidingView style={{ flex: 1 }}>
      <RevealInListContext.Provider value={reveal}>{body}</RevealInListContext.Provider>
      <OutboxRows conversationId={conversationId} threadRootId={threadRootId} />
      {threadRootId ? (
        // What the agent handed to T3 Code from this thread, in sight above the reply box (t3code-handoff.md AP-6614).
        <ThreadHandoffBar
          slug={slug}
          conversationId={conversationId}
          rootId={threadRootId}
          lastAt={messages.at(-1)?.createdAt ?? null}
          nameOf={people.name}
        />
      ) : null}
      {inbox && !threadRootId ? null : (
        <Composer
          placeholder={placeholder}
          disabled={!conversationId}
          fill={fill}
          mentionTargets={mentionTargets}
          keptDraft={draft.kept}
          onTextChange={(t) => {
            typed.current = t;
            draft.save(t);
          }}
          tool={runtimeChoice ? <ChatRuntimeControl choice={runtimeChoice} /> : null}
          adds={adds}
          onAdd={(id) => {
            if (id === PROMPTS_ADD) return promptsHere?.open();
            const choice = attachChoices(rawLocale).find((c) => c.kind === id);
            if (choice) attach(choice.kind);
          }}
          {...(promptsHere ? { above: promptsHere.above } : {})}
          voice={voiceSource}
          voiceKey={`${conversationId ?? ''}:${threadRootId ?? ''}`}
          note={composerNote}
          focusKey={focusKey + replyFocus}
          onSend={(sent) => {
            // Your own message: to the end, where it shows (MX-01).
            jumpToEnd();
            // Files already on their way with an earlier message stay with it.
            const attachmentIds = filesToSend(uploads.readyIds, filesOnTheirWay.current);
            // A new thread of the Chat goes with what the box chose for it, then the box follows the default again
            // (CR-02, AP-2719); a thread's own choice is saved with it already.
            const runtime = threadRootId ? undefined : runtimeChoice?.takeForSend();
            const chosen = runtime ? { runtime } : {};
            // Every mention canonical (MS-C02): the optimistic bubble shows what the server stores.
            const text = composerText(sent, mentionTargets);
            if (!text.trim() && !attachmentIds.length) return;
            // Offline (or behind messages still waiting): the outbox keeps it and sends it later.
            if (outbox.hold({ text, attachmentIds, ...chosen })) return uploads.clearSent(attachmentIds);
            // A new chat shows what it sent by the message's client id (AP-6301).
            const clientId = fresh ? newClientId() : undefined;
            if (clientId) setSentHere((ids) => new Set([...ids, clientId]));
            const variables = {
              text,
              ...(attachmentIds.length ? { attachmentIds } : {}),
              ...chosen,
              ...(clientId ? { clientId } : {}),
            };
            // Its own follow-up, even when another message goes before its answer is back.
            sendWithFollowUp(
              send.mutateAsync,
              variables,
              { ids: attachmentIds, onTheirWay: filesOnTheirWay.current },
              {
                done: (result) => {
                  if (result.status !== 'ok') return giveBack({ result }, text);
                  uploads.clearSent(attachmentIds);
                  // A top-level message in a room is a new thread: the screen opens it (CHT-21, AP-2453).
                  if (!threadRootId) threadStarted.current?.(result.data.message.id);
                },
                failed: (error) => giveBack({ error }, text),
              },
            );
          }}
          {...(canAttach
            ? {
                attachments: uploads.items,
                onRemoveAttachment: uploads.remove,
                onRetryAttachment: uploads.retry,
                canRetryAttachment: uploads.canRetry,
              }
            : {})}
        />
      )}
      {promptsHere?.sheets}
      <MessageMenuSheet
        visible={menuFor !== null && menuModel !== null}
        onClose={closeMenu}
        preview={menuFor?.deletedAt ? '' : (menuFor?.text ?? '')}
        detail={menuFor ? (items.find((i) => i.id === menuFor.id)?.ranOn?.text ?? null) : null}
        quick={menuFor && menuModel?.react ? quickReactions(menuFor.reactions) : null}
        onReact={(value, on) => {
          if (menuFor) reactTo(menuFor, value, on);
          setMenuFor(null);
        }}
        onMoreReactions={() => {
          setEmojiFor(menuFor);
          setMenuFor(null);
        }}
        actions={menuModel?.actions ?? []}
        onAction={(action) => menuFor && act(menuFor, action)}
      />
      <EmojiSheet
        visible={emojiFor !== null}
        onClose={() => setEmojiFor(null)}
        recent={recentEmoji}
        onPick={(char) => {
          const target = emojiFor;
          setEmojiFor(null);
          if (!target) return;
          // Picking one the viewer already reacted with takes it back, like its pill.
          const mine = target.reactions.some((r) => r.value === char && r.mine);
          reactTo(target, char, !mine);
        }}
      />
      <EditMessageSheet
        mentionTargets={mentionTargets}
        target={editing}
        busy={edit.isPending}
        error={editError}
        onSave={saveEdit}
        onClose={() => setEditing(null)}
      />
    </KeyboardAvoidingView>
  );
}

/**
 * After the newest message: the screen's footer, then who is thinking here and what they do (AP-734, on the app clock).
 * It follows typing and the agents' activity itself, so those don't re-render the conversation around it.
 */
function ChatFooter({
  conversationId,
  threadRootId,
  footer,
  people,
  clock,
  stopViewer,
  stopping,
  onStop,
}: {
  conversationId: string | null;
  threadRootId: string | null;
  footer: ReactNode;
  people: People;
  clock: () => number;
  stopViewer: { id: string; kind: 'person' };
  stopping: string | null;
  onStop: (dispatchId: string, agentName: string) => void;
}) {
  const { typing } = useTyping(conversationId, threadRootId);
  const agentNow = useAgentNow(conversationId);
  if (!footer && typing.length === 0) return null;
  return (
    <View style={{ gap: 14 }}>
      {footer}
      {typing.map((t) => (
        <WorkingBubble
          key={t.principalId}
          principalId={t.principalId}
          agent={people.get(t.principalId)}
          name={people.name(t.principalId)}
          threadRootId={threadRootId}
          agentNow={agentNow}
          clock={clock}
          {...(t.dispatchId && offersStop({ typing: t, viewer: stopViewer })
            ? {
                onStop: () => onStop(t.dispatchId ?? '', people.name(t.principalId)),
                stopping: stopping === t.dispatchId,
              }
            : {})}
        />
      ))}
    </View>
  );
}
