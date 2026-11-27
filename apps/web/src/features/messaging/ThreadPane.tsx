import {
  canSettle,
  composerMentionTargets,
  jobHandoffs,
  jobInMessage,
  jobPartsAfter,
  SHARE_TEXT,
  settledLine,
  threadHandoffs,
  threadStage,
  threadStageWord,
  threadWorkLine,
} from '@whombat/client';
import {
  useChatThreads,
  useConversation,
  useHandoffs,
  useSubscription,
  useTheAgent,
  useThreadUnread,
} from '@whombat/client/react';
import {
  type ChatSubject,
  canAskForMore,
  conversationLinkPreviewsOn,
  isDeletedMessage,
  type Message,
  replySuggestions,
  shortNameOf,
  suggestionMessage,
  topics,
} from '@whombat/core';
import { CircleCheck, Mail, Share } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { useHereHref, useNavigateHref, useSearchUpdate } from '../../app/routing/navigation';
import { IconButton } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { ErrorNote, SkeletonRows } from '../../components/ListState';
import { CHAT_WORDS, INBOX_WORDS, SETTLE_WORDS } from '../../i18n/shared';
import { MessageCard } from '../cards';
import { CardLookContext } from '../cards/cardLook';
import { inboxNextAfter, useInboxSplit } from '../chats/inboxNav';
import { RanOnMarkedProvider } from '../chats/runtime/RanOn';
import { useThreadRuntimeTool } from '../chats/runtime/useChatRuntimeTool';
import { useSettle } from '../chats/useSettle';
import { useThreadMarks } from '../chats/useThreadMarks';
import { CreatePlanModal, type CreatePlanSource } from '../plans';
import { useComposerPrompts } from '../prompts/useComposerPrompts';
import { useSaveAsPrompt } from '../prompts/useSaveAsPrompt';
import { ShareDialog } from '../shares/ShareDialog';
import roomStyles from './ConversationRoom.module.css';
import { draftKey, readDraft, useDraft } from './drafts';
import { HandoffLines } from './Handoff';
import { JobDetails } from './JobView';
import { LinkPreviewsShown, MessageEditor } from './MessageParts';
import { MoreDetail } from './MoreDetail';
import { useMessageUrl } from './messageLink';
import { foldMessages } from './model';
import { usePendingDeletes } from './pendingDeletes';
import { QuickReplies } from './QuickReplies';
import { takeCardFocus, takeReplyFocus } from './replyFocus';
import { useTypingStop } from './StopTurnButton';
import { type ThreadBack, ThreadView } from './ThreadView';
import viewStyles from './ThreadView.module.css';
import { useMessageActions } from './useMessageActions';
import { useReadOpenThread } from './useReadOpenThread';
import { useBurrowContext, useNow, useSend, useTypingLines } from './useRoom';
import { useSkillCommands } from './useSkillCommands';
import { LOAD_EARLIER_REPLIES, useThreadPages } from './useThreadPages';
import { useUploads } from './useUploads';

export interface ThreadPaneProps {
  burrow: string;
  /** Root message id (`?thread=`). */
  threadId: string;
  /** Removes `?thread=` (the × button; Esc is handled by the shell). */
  onClose: () => void;
  /** Full width instead of the conversation (`&focus=1`, docs/decisions/ui-improvements.md AP-304). */
  focus?: boolean;
  /** Sets or clears `&focus=1` (the expand and collapse buttons, the back link). */
  onFocusChange?: (focus: boolean) => void;
  /**
   * A thread of Chat or Feedback (chat-channel.md AP-2409): its subject chip in the head instead of where it lives,
   * “4 replies” under the first message, “Reply…” in the box.
   */
  chatRoom?: 'chat' | 'feedback';
  /** The subject chip for a Chat thread's head (`chatRoom`); null for none. */
  renderSubject?: (subject: ChatSubject) => ReactNode;
  /** The whole head instead of “Thread” and its buttons (a thing page's Ask pane, AP-2412). */
  header?: ReactNode;
  /** The reply box's words (default: “Reply in thread”, or “Reply to {assistant}…” in a room). */
  replyPlaceholder?: string;
  /** A room thread's one way out (“← Chat”, “← Inbox”): its head is then the room thread's (`ThreadView` `back`). */
  back?: ThreadBack | null;
}

/**
 * Contents of the 400px thread pane (TODO 5.4). The shell renders the pane frame (`SidePane
 * width="thread"`); this renders the root, the replies (live through `conv:<id>`) and the reply box.
 */
export function ThreadPane({
  burrow,
  threadId,
  onClose,
  focus = false,
  onFocusChange,
  chatRoom,
  renderSubject,
  header,
  replyPlaceholder,
  back = null,
}: ThreadPaneProps) {
  // A long thread opens at its newest replies, with “Load earlier replies” above them (WX-11).
  const pages = useThreadPages(burrow, threadId);
  const { data, error, refetch } = pages;
  const { lookup, principals, me, timeZone } = useBurrowContext(burrow);
  const conversationId = data?.conversationId;
  useSubscription(conversationId ? topics.conversation(conversationId) : null);
  const { lines: typing } = useTypingLines(conversationId, threadId, lookup);
  // Stop after “Neo is thinking” in the thread too (WX-10).
  const typingAction = useTypingStop(burrow, conversationId, lookup, me);
  const { data: room } = useConversation(conversationId ? { params: { burrow, conversationId } } : null);
  // In the person's own rooms (Chat, Feedback) the agent is addressed without a mention (OA-07).
  const { agent, words } = useTheAgent(burrow);
  const ownRoom = room?.conversation.kind === 'dm';
  const [skillsAsked, setSkillsAsked] = useState(false);
  const { skills } = useSkillCommands(burrow, skillsAsked);
  const sender = useSend({
    burrow,
    conversationId,
    threadRootId: threadId,
    principals,
    meId: me?.id,
    skills,
    agentId: ownRoom ? (agent?.id ?? null) : null,
  });
  // The person's prompts after `/` and “Save as prompt” in a thread of their Chat (prompts-web.md): a prompt used here
  // is a reply in the thread.
  const promptsHere = chatRoom === 'chat' && ownRoom;
  const offer = useComposerPrompts({
    burrow,
    conversationId: promptsHere ? conversationId : null,
    rootId: threadId,
  });
  const saveAsPrompt = useSaveAsPrompt(burrow, me?.id, promptsHere && offer.available);
  // The thread's own chips: files attached here go with the reply, not with the conversation's next message (WX-04).
  const uploads = useUploads(burrow, conversationId ?? '', threadId);
  const navigateHref = useNavigateHref();
  const updateSearch = useSearchUpdate();
  const here = useHereHref();
  // The reply's draft is kept per thread, across reloads (WX-05), under its root (known before the thread loads); the
  // pane is keyed by thread, so nothing else leaks between threads.
  const key = draftKey(burrow, 'thread', threadId);
  const [draft, setDraft] = useDraft(key);
  const mentionTargets = useMemo(() => composerMentionTargets(principals, me?.id), [principals, me?.id]);
  // Who `@Name` can mean, for its case (AP-607): the active people and the agent.
  const mentionables = useMemo(() => principals.filter((p) => p.kind !== 'system'), [principals]);
  // “Make a plan” from a reply's menu (AP-87): the plan remembers the reply and its card goes into this thread.
  const [planFrom, setPlanFrom] = useState<CreatePlanSource | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  // Sharing by link (share-links.md): a thread of the person's Chat, on a box (a link needs Whombat's servers).
  const { managed } = useAppServices();
  const shareable = chatRoom === 'chat' && managed !== null;
  const [shareScope, setShareScope] = useState<{ rootId: string; fromMessageId?: string } | null>(null);
  // “Reply in thread” focuses the reply box (AP-443); after an edit it goes back there too.
  const [replyFocusKey, setReplyFocusKey] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (takeReplyFocus(threadId)) setReplyFocusKey(Date.now());
  }, [threadId]);
  // Answer under a question that waits opens the thread at the card that waits.
  const [focusCard] = useState(() => takeCardFocus(threadId));
  // Reactions, edit, pin and delete in the thread too (docs/decisions/essentials-messages.md AP-440…).
  const actions = useMessageActions({
    burrow,
    where: data?.where ?? '',
    place: 'thread',
    onEditDone: () => setReplyFocusKey(Date.now()),
    linkOf: useMessageUrl(burrow, room, lookup),
    // The root is gone (it had no replies left): there is no thread to show.
    onRemoved: (m) => {
      if (m.id === threadId) onClose();
    },
    extraItems: (m) => [
      {
        label: 'Make a plan',
        onSelect: () => {
          setPlanFrom({ messageId: m.id, text: m.text });
          setPlanOpen(true);
        },
      },
      ...[saveAsPrompt.item(m)].filter((item) => item !== null),
      ...(shareable && !isDeletedMessage(m)
        ? [
            {
              label: m.id === threadId ? SHARE_TEXT.shareMenu : SHARE_TEXT.shareFromMenu,
              onSelect: () =>
                setShareScope(
                  m.id === threadId ? { rootId: threadId } : { rootId: threadId, fromMessageId: m.id },
                ),
            },
          ]
        : []),
    ],
  });

  // A reply deleted with Undo waiting is out already (WX-09).
  const hidden = usePendingDeletes();
  const messages = useMemo(
    () => (data ? [data.root, ...pages.replies].filter((m) => !hidden.has(m.id)) : []),
    [data, pages.replies, hidden],
  );
  // What the agent handed to T3 Code from this thread, at its end until its answer came (t3code-handoff.md AP-6613).
  const allHandoffs = useHandoffs(burrow, conversationId);
  const lastAt = messages.at(-1)?.createdAt ?? null;
  const handoffs = useMemo(
    // An ended job stays listed for days with its receipt (job-view.md); its line here goes after half an hour, and at
    // once when its result is a message in the thread.
    () => threadHandoffs(allHandoffs, threadId, lastAt, Date.now()).filter((h) => !jobInMessage(h)),
    [allHandoffs, threadId, lastAt],
  );
  const handedBy = handoffs[0] ? lookup(handoffs[0].agentId) : undefined;
  // The latest job handed to T3 Code from here, ended too while the box still lists it (its receipt): its parts at the
  // thread's end.
  // An ended job whose result is a message in the thread draws nothing here: the message says how it went.
  const jobHandoff = useMemo(() => {
    const last = jobHandoffs(allHandoffs, threadId).at(-1) ?? null;
    return last && !jobInMessage(last) ? last : null;
  }, [allHandoffs, threadId]);
  // Once the chat went on after the job ended, its parts stay under the last message from before its end instead of
  // following the newest one down (job-view.md AP-8944). Rows folded into a run aren't drawn, so they can't hold them.
  const jobAfter = useMemo(() => {
    if (jobHandoff?.state !== 'ended') return null;
    const [root, ...rest] = messages;
    if (!root) return null;
    const drawn = [root, ...foldMessages(rest).visible].map((m) => ({ id: m.id, at: m.createdAt }));
    return jobPartsAfter(jobHandoff, drawn);
  }, [jobHandoff, messages]);
  const jobDetails =
    jobHandoff && conversationId ? (
      <JobDetails burrow={burrow} conversationId={conversationId} handoff={jobHandoff} />
    ) : null;
  const jobAtEnd = !!jobHandoff && !jobAfter;
  // How much was new when it opened, before it reads itself: the “New” line goes above the first of those messages,
  // decided once, as the thread first shows (replies after that are read where they appear).
  const unreadCounts = useThreadUnread(burrow, chatRoom ?? 'chat', !!chatRoom);
  const [newFrom, setNewFrom] = useState<string | null | undefined>(undefined);
  if (newFrom === undefined && data)
    setNewFrom(chatRoom ? firstNew(messages, unreadCounts.get(threadId) ?? 0, me?.id) : null);
  // Read while it is open (thread-unread.md): its dot in the room goes, and the badge with it.
  useReadOpenThread({
    burrow,
    room: chatRoom,
    conversationId,
    rootId: threadId,
    newestId: messages.at(-1)?.id,
  });
  // Settling a Chat or Feedback thread (chat-settle.md AP-6150, AP-6154): Settle in the head while it may (the open
  // threads say whether the assistant works on it or it waits), and a settled one's line, Open again and the hint.
  const open = useChatThreads(burrow, chatRoom ?? 'chat', { state: 'open', enabled: !!chatRoom });
  const { settle, openAgain } = useSettle(burrow);
  const marks = useThreadMarks(burrow);
  const split = useInboxSplit();
  // Mark as unread needs a message from someone else in it (the server leaves it as it is otherwise).
  const markable = !!chatRoom && messages.some((m) => m.authorId !== me?.id && !isDeletedMessage(m));
  const now = useNow(60_000);
  const settled = chatRoom ? (data?.root.settled ?? null) : null;
  const listed = open.threads.find((t) => t.rootId === threadId);
  const settleable =
    !!chatRoom &&
    !!data &&
    !settled &&
    !isDeletedMessage(data.root) &&
    !open.isLoading &&
    (listed ? canSettle(listed) : true) &&
    // Not while T3 Code still works on what the agent handed it from here (t3code-handoff.md AP-6615).
    !handoffs.some((h) => h.state !== 'ended');
  // Where the thread stands, from its flags, after the number of replies in its head (“3 replies · Waiting for you”).
  const stage = chatRoom
    ? threadStage({
        ...listed,
        handedOver: !!listed?.handedOver || handoffs.some((h) => h.state !== 'ended'),
        settled,
      })
    : null;
  const workLine = chatRoom ? threadWorkLine(listed ?? {}, handoffs, now.valueOf()) : null;
  // What answers in a Chat thread (chat-runtime.md CR-01, CR-02; AP-2682, AP-2690): its button in the reply box.
  const replies = useMemo(() => messages.slice(1), [messages]);
  const runtimeTool = useThreadRuntimeTool(burrow, threadId, replies, chatRoom === 'chat');
  // A copied reply link (`?thread=<root>#msg_…`, WX-06) opens the thread at that reply.
  const [target] = useState(() =>
    typeof window !== 'undefined' && window.location.hash.startsWith('#msg_')
      ? window.location.hash.slice(1)
      : null,
  );
  const send = async (typed: string) => {
    const text = typed.trim();
    const files = uploads.readyIds;
    if (!text && !files.length) return;
    setDraft('');
    const ok = await sender.submit(text, files);
    if (ok) uploads.clearSent(files);
    else if (!readDraft(key)) setDraft(text);
  };

  // Quick replies (RM-05) on the thread's newest message; in the person's own rooms without a mention.
  const quick = replySuggestions(messages, me?.id, (id) => lookup(id)?.kind === 'agent');
  const pick = (text: string) => {
    if (!quick) return;
    const author = lookup(quick.authorId);
    void sender.submit(suggestionMessage(text, author?.name ?? '', ownRoom || !author));
  };

  return (
    <>
      {actions.elements}
      {saveAsPrompt.element}
      <ShareDialog burrow={burrow} scope={shareScope} onClose={() => setShareScope(null)} />
      {conversationId && (
        <CreatePlanModal
          burrow={burrow}
          conversationId={conversationId}
          open={planOpen}
          onOpenChange={setPlanOpen}
          source={planFrom}
          onCreated={(plan) =>
            void updateSearch((s) => ({
              ...s,
              plan: plan.id,
              step: undefined,
              thread: undefined,
              plans: undefined,
            }))
          }
        />
      )}
      <LinkPreviewsShown.Provider value={conversationLinkPreviewsOn(room?.conversation)}>
        {/* A Chat thread's cards as in a chat with the assistant (“Tonight at 03:00”, AP-1280, AP-2409). */}
        <CardLookContext.Provider value={chatRoom ? 'chat' : 'room'}>
          <RanOnMarkedProvider burrow={burrow} enabled={chatRoom === 'chat'}>
            <ThreadView
              burrow={burrow}
              onMenu={actions.onMenu}
              menuOpenId={actions.menuOpenId}
              onReact={actions.toggleReaction}
              pickerOpenId={actions.pickerOpenId}
              renderEditor={(m) =>
                m.id === actions.editingId ? (
                  <MessageEditor
                    compact
                    initial={m.text}
                    mentionTargets={mentionTargets}
                    allowEmpty={m.attachments.length > 0}
                    pending={actions.editPending}
                    error={actions.editError}
                    onSave={(text) => actions.saveEdit(m, text)}
                    onCancel={actions.cancelEdit}
                  />
                ) : null
              }
              onEditLast={() => actions.editLast(messages)}
              replyFocusKey={replyFocusKey}
              header={header}
              headExtra={
                chatRoom
                  ? data?.root.subject && renderSubject
                    ? renderSubject(data.root.subject)
                    : null
                  : undefined
              }
              repliesLine={!!chatRoom}
              stageWord={
                // What goes on from it says more than “Handed over”: the same line as its row's; a list waiting for
                // Hand over has only that line to say.
                (stage === 'handedOver' || !stage) && workLine
                  ? `${workLine.who} · ${workLine.text}`
                  : stage
                    ? threadStageWord(stage, words.name)
                    : null
              }
              headAction={
                <>
                  {shareable && data && !isDeletedMessage(data.root) && (
                    <IconButton
                      label="Share this thread"
                      onClick={() => setShareScope({ rootId: threadId })}
                      data-thread-share=""
                    >
                      <Icon icon={Share} size={16} />
                    </IconButton>
                  )}
                  {chatRoom && markable && conversationId ? (
                    <IconButton
                      label={INBOX_WORDS.markUnread}
                      onClick={() => {
                        // An open thread reads itself: it closes, so it stays unread.
                        marks.markUnread({ conversationId, rootId: threadId });
                        onClose();
                      }}
                      data-thread-unread=""
                    >
                      <Icon icon={Mail} size={16} />
                    </IconButton>
                  ) : null}
                  {chatRoom && settleable ? (
                    <button
                      type="button"
                      className={viewStyles.settleButton}
                      onClick={() => {
                        // Beside the list the next thread opens, as archiving mail does; otherwise back to the room.
                        const next = split ? inboxNextAfter(chatRoom, threadId) : null;
                        settle(chatRoom, threadId);
                        if (next) void updateSearch((s) => ({ ...s, thread: next, focus: undefined }));
                        else onClose();
                      }}
                      data-thread-settle=""
                    >
                      <Icon icon={CircleCheck} size={15} />
                      {SETTLE_WORDS.settle}
                    </button>
                  ) : null}
                </>
              }
              stateLine={
                chatRoom && settled ? (
                  <div className={viewStyles.settledLine} data-settled-line="">
                    <Icon icon={CircleCheck} size={15} />
                    <span className={viewStyles.settledWhen}>{settledLine(settled.at, now, timeZone)}</span>
                    <button
                      type="button"
                      className={viewStyles.openAgain}
                      onClick={() => openAgain(chatRoom, threadId)}
                    >
                      {SETTLE_WORDS.openAgain}
                    </button>
                  </div>
                ) : null
              }
              replyHint={settled ? SETTLE_WORDS.replyOpens : null}
              focusCard={focusCard}
              newFrom={newFrom ?? null}
              rootCard={!!chatRoom}
              back={back}
              replyPlaceholder={replyPlaceholder ?? (chatRoom ? CHAT_WORDS.replyTo(words.name) : undefined)}
              messages={messages}
              where={data?.where ?? ''}
              topic={data?.topic ?? null}
              lookup={lookup}
              timeZone={timeZone}
              onClose={onClose}
              layout={focus ? 'focus' : 'pane'}
              onFocusChange={onFocusChange}
              // A Chat or Feedback thread is always full width: no collapse, its back link goes to the room (AP-2415).
              collapsible={!chatRoom}
              splitHref={
                chatRoom ? here({ thread: undefined, focus: undefined }) : here({ focus: undefined })
              }
              renderCard={(m, inside) =>
                m.card ? (
                  <MessageCard
                    burrow={burrow}
                    card={m.card}
                    messageId={m.id}
                    conversationId={m.conversationId}
                    nested={inside}
                    variant="thread"
                    attachments={m.attachments}
                    authorId={m.authorId}
                  />
                ) : null
              }
              renderAfter={(m) => (
                <>
                  {canAskForMore(m, lookup(m.authorId), me) && (
                    <MoreDetail burrow={burrow} messageId={m.id} />
                  )}
                  {quick && m.id === quick.messageId && (
                    <QuickReplies suggestions={quick.suggestions} onPick={pick} disabled={sender.sending} />
                  )}
                  {m.id === jobAfter && jobDetails}
                </>
              )}
              typing={typing}
              typingAction={typingAction}
              handoffs={
                handoffs.length || jobAtEnd ? (
                  <>
                    {handoffs.length ? (
                      <HandoffLines
                        handoffs={handoffs}
                        agentName={handedBy ? shortNameOf(handedBy) : (agent?.name ?? 'the agent')}
                      />
                    ) : null}
                    {jobAtEnd && jobDetails}
                  </>
                ) : null
              }
              handoffCount={handoffs.length + (jobAtEnd ? 1 : 0)}
              earlier={
                pages.more ? (
                  <button
                    type="button"
                    className={roomStyles.older}
                    disabled={pages.loadingEarlier}
                    onClick={pages.loadEarlier}
                    data-thread-earlier=""
                  >
                    {pages.loadingEarlier ? 'Loading…' : LOAD_EARLIER_REPLIES}
                  </button>
                ) : null
              }
              target={target}
              draft={draft}
              onDraftChange={(value) => {
                setDraft(value);
                if (sender.notice) sender.clearNotice();
                if (offer.notice) offer.clearNotice();
                if (!skillsAsked && value.startsWith('/')) setSkillsAsked(true);
              }}
              onSend={(text) => void send(text)}
              onPickFiles={conversationId ? uploads.pick : null}
              attachments={uploads.attachments}
              onRemoveAttachment={uploads.remove}
              onRetryAttachment={uploads.retry}
              skills={skills}
              prompts={offer.prompts}
              mentionables={mentionables}
              viewerId={me?.id}
              plainOwn={ownRoom || !!chatRoom}
              runtimeTool={runtimeTool}
              notice={sender.notice ?? offer.notice}
              onNavigate={(href) => navigateHref(href)}
              status={
                data ? undefined : error ? (
                  <ErrorNote
                    message="This thread is gone, or you’re not in its conversation."
                    onRetry={() => void refetch()}
                  />
                ) : (
                  <SkeletonRows count={5} avatarSize={32} lines={2} />
                )
              }
            />
          </RanOnMarkedProvider>
        </CardLookContext.Provider>
      </LinkPreviewsShown.Provider>
    </>
  );
}

/**
 * The first of the last `count` messages someone else wrote (not deleted, not still on its way): where the “New” line
 * goes in a thread that opened with `count` new messages. Null with nothing new or nothing of someone else's.
 */
export function firstNew(
  messages: readonly Pick<Message, 'id' | 'authorId' | 'deletedAt'>[],
  count: number,
  meId: string | undefined,
): string | null {
  if (count <= 0) return null;
  let left = count;
  let first: string | null = null;
  for (let i = messages.length - 1; i >= 0 && left > 0; i--) {
    const m = messages[i];
    if (!m || m.authorId === meId || m.id.startsWith('msg_local-') || isDeletedMessage(m)) continue;
    first = m.id;
    left--;
  }
  return first;
}
