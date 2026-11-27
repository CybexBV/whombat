/**
 * A thread (not mocked on mobile): its root and replies in the conversation's bubbles, answered in the thread; “N
 * replies” under a root in a branch room lands here. The header says where it is (“feat/invoice-pdf”) and what about. A
 * link to a reply opens it at that reply (`anchor`, MX-03).
 *
 * A thread in Chat or Feedback (Whombat chat-channel.md CHT-02, CHT-22; chat-channel.md AP-2453) is the Chat channel
 * mockup's screen: “‹ Chat” and what the thread is about (its chip) in the header, “Reply…” in the composer. In Chat its
 * reply box has the “what answers” button for the thread, and the replies say what answered them (chat-runtime.md
 * AP-2715…AP-2728). Its header has ✓ Settle after the chip, which puts the thread away and goes back to the room, unless
 * the agent works on it or it waits for the person's answer; a settled thread says so under the header with Open again,
 * and “A reply opens it again.” under the reply box (chat-settle.md AP-6150, AP-6154, AP-6157).
 *
 * A thread whose work the agent handed to T3 Code shows that job (docs/app/decisions/job-view.md): the stage track
 * folded under the header, and at the thread's end the job's parts (the receipt, a question's options, the plan, the
 * changes, the checks, the field that steers it). An ended job keeps its receipt while the Whombat still lists it.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { chatWords, jobPartsAfter, roomOfConversation, rootTitle } from '@whombat/client';
import { useChatRooms, useChatThreads, useHandoffs, useThread, useTyping } from '@whombat/client/react';
import type { ChatSubject } from '@whombat/core';
import { useCallback, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import { useBurrowBase, useNow } from '../data/BurrowProvider';
import { jobParts, threadJob } from '../data/job';
import { conversationLoadError, threadHeader } from '../data/messages';
import { threadQuery } from '../data/threadPages';
import { settleCopy, settledWhen, settleOffer } from '../data/threadSettle';
import { useThreadPlaceholder } from '../data/useThreadOpening';
import { useSettleThread } from '../data/useThreadSettle';
import { useI18n, useMobileT } from '../i18n';
import { useManaged } from '../managed/context';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import {
  BackButton,
  ChatHeader,
  LinedHeader,
  ListToggleButton,
  ROOM_HEADER_HEIGHT,
  Screen,
} from '../ui/headers';
import { JobPanel } from '../ui/job';
import { ErrorState, SkeletonRows } from '../ui/primitives';
import { SubjectChip } from '../ui/subjectChip';
import { SettleButton, SettledThreadLine, ShareThreadButton } from '../ui/threadSettle';
import { ChatView } from './ChatView';

type Props = NativeStackScreenProps<RootStackParamList, 'Thread'>;

export function ThreadScreen({ route, navigation }: Props) {
  const { rawLocale } = useI18n();
  const chatWordsHere = chatWords(rawLocale);
  const { t: tMobile } = useMobileT();
  const { slug, timeZone } = useBurrowBase();
  const now = useNow();
  const { messageId } = route.params;
  // The same page `ChatView` shows (one request): the newest replies where threads are paged (MX-09).
  // Until it is there: the root as the room already has it (`useThreadPlaceholder`), not grey rows.
  const placeholderData = useThreadPlaceholder(slug, messageId);
  const query = useThread({ params: { burrow: slug, messageId }, query: threadQuery() }, { placeholderData });
  const rooms = useChatRooms(slug);
  const room = roomOfConversation(rooms, query.data?.conversationId);
  // Whether it can settle now: the room's threads (the list Chat already reads) say whether the agent works on it or it
  // waits for the person; a turn going on in it now says the first.
  const conversationId = query.data?.conversationId ?? null;
  const threads = useChatThreads(slug, room ?? 'chat', { conversationId, enabled: !!room });
  const listed = threads.threads.find((t) => t.rootId === messageId);
  const { typing } = useTyping(room ? conversationId : null, messageId);
  const settle = useSettleThread();
  const managed = useManaged();
  const settled = query.data?.root.settled ?? null;
  // Nor while T3 Code still works on what the agent handed it from here (t3code-handoff.md AP-6615).
  const handoffs = useHandoffs(slug, room ? conversationId : null);
  const handedOver = handoffs.some((h) => h.rootId === messageId && h.state !== 'ended');
  const offer = room
    ? settleOffer({
        settled,
        working: !!listed?.working || typing.length > 0,
        waiting: !!listed?.waiting,
        // A council or a delegation at work from here too, as the server says (delegate.md).
        handedOver: handedOver || !!listed?.handedOver,
      })
    : null;
  const back =
    route.params.back ??
    (room === 'feedback'
      ? chatWordsHere.feedback
      : room
        ? chatWordsHere.chat
        : tMobile('screens2.common.back'));
  const goBack = () =>
    navigation.canGoBack()
      ? navigation.goBack()
      : room === 'feedback'
        ? navigation.navigate('Feedback')
        : navigation.navigate('Tabs', room ? { screen: 'ChatRoom' } : undefined);
  // Where it is and what about come with the thread itself.
  const header = threadHeader(query.isPlaceholderData ? undefined : query.data, rawLocale);
  // Whether the thread's first message is on screen: once it scrolls away its question becomes the header's title.
  const [rootInView, setRootInView] = useState(true);
  // The job it handed to T3 Code, ended ones too (their receipt): the track under the header, its parts at the end.
  const jobHandoff = useMemo(() => threadJob(handoffs, messageId), [handoffs, messageId]);
  // An ended job whose result is a message in the thread has no parts: no footer at all, not an empty one.
  const jobPanel = useMemo(
    () =>
      jobHandoff && conversationId && jobParts(jobHandoff).length ? (
        <JobPanel slug={slug} conversationId={conversationId} handoff={jobHandoff} />
      ) : null,
    [jobHandoff, conversationId, slug],
  );
  // Once the chat went on after the job ended, its parts stay where it finished (job-view.md AP-8945).
  const jobPanelAfter = useCallback(
    (rows: readonly { id: string; at: string }[]) =>
      jobHandoff && jobPanel ? jobPartsAfter(jobHandoff, rows) : null,
    [jobHandoff, jobPanel],
  );
  // Settling the open thread goes back to the room (AP-6150); Undo is in the toast there.
  const settleHere = () => {
    settle({ rootId: messageId, room }, true);
    goBack();
  };

  if (!query.data) {
    const failure = query.error ? conversationLoadError(query.error, rawLocale) : null;
    return (
      <Screen>
        <ChatHeader onBack={goBack} backLabel={back} title={header.title} />
        {failure ? (
          <ErrorState
            text={failure.text}
            {...(failure.retry ? { onRetry: () => void query.refetch() } : {})}
          />
        ) : (
          <SkeletonRows count={4} avatarSize={24} lines={1} label={tMobile('screens.loading-the-thread')} />
        )}
      </Screen>
    );
  }

  return (
    <Screen>
      {room ? (
        <RoomThreadHeader
          back={back}
          onBack={goBack}
          question={rootTitle(query.data.root)}
          showQuestion={!rootInView}
          subject={query.data.root.subject ?? null}
          onSettle={offer === 'settle' ? settleHere : null}
          onShare={
            room === 'chat' && managed && !query.data.root.deletedAt
              ? () => navigation.navigate('ShareLink', { rootId: messageId })
              : null
          }
        />
      ) : (
        <ChatHeader onBack={goBack} backLabel={back} title={header.title} subtitle={header.subtitle} />
      )}
      {room && settled ? (
        <SettledThreadLine
          when={settledWhen(settled, now, timeZone, rawLocale)}
          onOpenAgain={() => settle({ rootId: messageId, room }, false)}
        />
      ) : null}
      <ChatView
        conversationId={query.data.conversationId}
        threadRootId={messageId}
        authors
        placeholder={room ? chatWordsHere.reply : tMobile('screens.reply-in-thread')}
        backLabel={tMobile('screens2.thread.thread')}
        ownRoom={!!room}
        chatRoom={room}
        anchor={route.params.anchor ?? null}
        onAnchorDone={() => navigation.setParams({ anchor: undefined })}
        composerNote={room && settled ? settleCopy(rawLocale).replyOpens : null}
        onRootInView={room ? setRootInView : undefined}
        footer={jobPanel}
        footerAfter={jobPanelAfter}
      />
    </Screen>
  );
}

/**
 * A room's thread header (the mockup's phone): the back button at the left (the chevron and the room's name on iPhone,
 * the arrow on Android), the thread's question as its title once the first message has scrolled out of view (before
 * that it is read but not drawn; iPhone's back button keeps only its chevron while it shows), the subject's chip at the
 * right, then ✓ Settle where the thread can settle now.
 */
function RoomThreadHeader({
  back,
  onBack,
  question,
  showQuestion,
  subject,
  onSettle,
  onShare,
}: {
  back: string;
  onBack: () => void;
  /** The thread's question (its first message's first line); empty without one. */
  question: string;
  /** The first message has scrolled out of view: the question shows as the title. */
  showQuestion: boolean;
  subject: ChatSubject | null;
  onSettle: (() => void) | null;
  /** Share this thread by link (Chat on a box, share-links.md). */
  onShare: (() => void) | null;
}) {
  const { t: tMobile } = useMobileT();
  const shown = showQuestion && !!question;
  return (
    <LinedHeader
      minHeight={ROOM_HEADER_HEIGHT}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 6,
        paddingLeft: Platform.OS === 'ios' ? 10 : 4,
        paddingRight: 20,
      }}
    >
      <ListToggleButton />
      <BackButton label={back} onPress={onBack} compact={shown} />
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={question || tMobile('screens2.thread.thread')}
        style={{ flex: 1, minHeight: 44, justifyContent: 'center' }}
      >
        <Text size={16} weight={600} numberOfLines={1} style={{ opacity: shown ? 1 : 0 }}>
          {question}
        </Text>
      </View>
      {subject ? (
        <SubjectChip
          subject={subject}
          style={{ alignSelf: 'center', maxWidth: shown ? '32%' : onSettle ? '40%' : '55%' }}
        />
      ) : null}
      {onShare ? <ShareThreadButton onPress={onShare} /> : null}
      {onSettle ? <SettleButton onPress={onSettle} /> : null}
    </LinedHeader>
  );
}
