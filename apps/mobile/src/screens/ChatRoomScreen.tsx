/**
 * Chat and Feedback on the phone (Whombat chat-channel.md CHT-01…CHT-03, CHT-22, chat-inbox.md; chat-channel.md
 * AP-2453, chat-inbox-phone.md): the person's private room with the agent, threaded, shown as a mail inbox of its open
 * threads (`ChatInbox`) with one New chat button floating over it. Chat is the first tab, its
 * top row has Feedback beside its title (with its unread badge, once the room exists); Settled is at the end of the
 * list's filters. Feedback is a screen of its own above it, with the same list. The rooms
 * (`useChatRooms`), the threads and the words are shared with the web. Each person has only these rooms with the agent
 * (Whombat one-agent.md OA-04; app one-agent.md AP-4980).
 *
 * A new thread starts in the new chat (`NewChatPage`): the room's box alone, with the cursor in it, and what is sent
 * opens as its thread. The button opens it as a page of its own (`NewChatScreen`); with two pages Chat's new chat is
 * the right page while nothing is open there (iphone-duo.md AP-6301), and the button brings it back.
 *
 * While the app is open, a job the agent handed to T3 Code from one of the room's threads says in a toast when it starts
 * to need the person, is done or failed (`useJobToasts`).
 */

import { StackActions } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { agentFaceOf, CHAT_WORDS } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { useChatRooms, useHandoffs } from '@whombat/client/react';
import type { ChatRoom } from '@whombat/core';
import { type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { Platform, useWindowDimensions, View } from 'react-native';
import { WhombatAvatar } from '../avatars/Avatars';
import { LiveFace } from '../avatars/LiveFace';
import { useBurrowBase } from '../data/BurrowProvider';
import { chatCopy } from '../data/chatRoom';
import { fitHeaderButtons, HEADER_GAP, type HeaderButtonSpec } from '../data/headerFit';
import type { NativeMenuSpec } from '../data/nativeMenu';
import { useAgentWords, useTheAgentHere } from '../data/useAgent';
import { useI18n, useMobileT } from '../i18n';
import { useAppNavigation } from '../navigation/hooks';
import { ListToggleContext, RestingPageContext, useBeside, usePaneRole } from '../navigation/panes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import {
  BackButton,
  ChatHeader,
  LARGE_TITLE_LEFT,
  LinedHeader,
  ListToggleButton,
  ROOM_HEADER_HEIGHT,
  Screen,
} from '../ui/headers';
import { Ellipsis } from '../ui/icons';
import { useJobToasts } from '../ui/job';
import { CountBadge } from '../ui/ListRow';
import { hasNativeMenu, MenuSheet, NativeMenu } from '../ui/nativeMenu';
import { SHELL_TARGET } from '../ui/places';
import { ErrorState, QuietText, SkeletonRows } from '../ui/primitives';
import { usePageFrame } from '../ui/screenShape';
import { Touchable } from '../ui/Touchable';
import { TabTop } from '../ui/topRow';
import { ChatInbox } from './ChatInbox';
import { ChatView } from './ChatView';

/** The Chat tab; Files is one of Places (phone-shell-final.md), what needs the person the Inbox tab's alone. */
export function ChatRoomScreen() {
  const navigation = useAppNavigation();
  const { slug } = useBurrowBase();
  const rooms = useChatRooms(slug);
  const feedback = rooms.feedback;
  const page = usePageFrame();
  const { fontScale } = useWindowDimensions();
  const [moreOpen, setMoreOpen] = useState(false);
  // Feedback (its unread count) stands beside the title while it fits; on a narrow page or with large text it goes
  // into ⋯. Settled is at the end of the list's filters.
  const buttons: HeaderButtonSpec[] = feedback
    ? [{ id: 'feedback', label: CHAT_WORDS.feedback, badge: feedback.unread > 0 }]
    : [];
  // The title keeps its room beside Places and Search, which take more of the row than the header's old padding.
  const icons = 2 * SHELL_TARGET + 18 - (LARGE_TITLE_LEFT + 10);
  const fit = fitHeaderButtons(page.right - page.left - icons, CHAT_WORDS.chat, buttons, fontScale);
  const open = (id: string) => {
    if (id === 'feedback') navigation.navigate('Feedback');
  };
  const menu: NativeMenuSpec = {
    title: null,
    reactions: null,
    more: null,
    sections: [fit.more.map((b) => ({ id: b.id, title: b.label }))],
  };
  return (
    <Screen>
      <TabTop
        title={CHAT_WORDS.chat}
        lined={false}
        right={
          <>
            {fit.shown.map((b) => (
              <HeaderButton
                key={b.id}
                label={b.label}
                count={b.id === 'feedback' ? (feedback?.unread ?? 0) : 0}
                onPress={() => open(b.id)}
              />
            ))}
            {fit.more.length ? (
              <HeaderMore menu={menu} onPick={open} onOpen={() => setMoreOpen(true)} />
            ) : null}
          </>
        }
      />
      <MenuSheet
        spec={menu}
        visible={moreOpen}
        label={CHAT_MORE_LABEL}
        onClose={() => setMoreOpen(false)}
        onPick={open}
      />
      <RoomBody
        room="chat"
        conversationId={rooms.chat?.id ?? null}
        known={rooms.known}
        failed={!!rooms.error}
        back={CHAT_WORDS.chat}
      />
    </Screen>
  );
}

/** The Feedback room, above Chat. */
export function FeedbackScreen() {
  const navigation = useAppNavigation();
  const { slug } = useBurrowBase();
  const rooms = useChatRooms(slug);
  const goBack = () =>
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs', { screen: 'ChatRoom' });
  return (
    <Screen>
      <RoomHeader title={CHAT_WORDS.feedback} back={{ label: CHAT_WORDS.chat, onPress: goBack }} />
      <RoomBody
        room="feedback"
        conversationId={rooms.feedback?.id ?? null}
        known={rooms.known}
        failed={!!rooms.error}
        back={CHAT_WORDS.feedback}
      />
    </Screen>
  );
}

/**
 * A room as an inbox of its open threads (`ChatInbox`), with the button that opens its new chat.
 */
function RoomBody({
  room,
  conversationId,
  known,
  failed,
  back,
}: {
  room: ChatRoom;
  conversationId: string | null;
  /** `chats.list` has answered. */
  known: boolean;
  failed: boolean;
  back: string;
}) {
  const { rawLocale } = useI18n();
  const chatCopyHere = chatCopy(rawLocale);

  const { t: tMobile } = useMobileT();
  const navigation = useAppNavigation();
  const qc = useQueryClient();
  const { slug } = useBurrowBase();
  const words = useAgentWords();
  const agent = useTheAgentHere();
  // The room's hand-overs to T3 Code: a job that starts to need the person, is done or failed says so while the app
  // is open.
  useJobToasts(useHandoffs(slug, conversationId));
  const threaded = useMemo(
    () => ({
      onThreadStarted: (rootId: string) => navigation.navigate('Thread', { messageId: rootId, back }),
    }),
    [navigation, back],
  );
  // New chat opens the new chat as a page of its own. With two pages Chat's is the right page while nothing is open
  // there, so the button brings that back instead.
  const role = usePaneRole();
  const resting = useContext(RestingPageContext);
  const beside = useBeside();
  const show = room === 'chat' && role === 'list' ? resting?.show : undefined;
  const newChat = useMemo(
    () => ({
      label: newChatTitle(room),
      selected: !!show && beside === null,
      onPress: show ?? (() => navigation.navigate('NewChat', { room })),
    }),
    [room, show, beside, navigation],
  );
  if (!conversationId) {
    if (failed && !known)
      return (
        <ErrorState
          text={room === 'chat' ? chatCopyHere.failed : chatCopyHere.feedbackFailed}
          onRetry={() => void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.list') })}
        />
      );
    if (!known)
      return <SkeletonRows count={6} avatarSize={24} lines={1} label={tMobile('screens.loading-messages')} />;
  }
  const welcome = (
    <RoomEmpty
      avatar={
        agent ? (
          <LiveFace face={agentFaceOf(agent)} size={44} label={agent.name} pokeable />
        ) : (
          <WhombatAvatar size={44} silhouette />
        )
      }
      text={room === 'chat' ? words.chatEmpty : CHAT_WORDS.feedbackEmpty}
    />
  );
  return (
    <ChatView
      conversationId={conversationId}
      authors
      placeholder={words.chatPlaceholder}
      backLabel={back}
      ownRoom
      threaded={threaded}
      chatRoom={room}
      inbox={
        conversationId ? (
          <ChatInbox
            room={room}
            conversationId={conversationId}
            back={back}
            welcome={welcome}
            newChat={newChat}
          />
        ) : (
          welcome
        )
      }
    />
  );
}

/** What a room's new chat is called: its button for a screen reader, and its page's title. */
function newChatTitle(room: ChatRoom): string {
  return room === 'chat' ? CHAT_WORDS.newChat : CHAT_WORDS.newThread;
}

/** The new chat as a page of its own: what a list's New chat button opens (`whombat` route `NewChat`). */
export function NewChatScreen({ route }: { route: { params?: { room?: ChatRoom } } }) {
  return <NewChatPage room={route.params?.room === 'feedback' ? 'feedback' : 'chat'} pushed />;
}

/**
 * A room's new chat: only its box (what answers, files, voice typing, the kept draft) under one line of welcome, so
 * what is sent starts a thread, which opens in its place. `pushed`: a page the New chat button opened, with a way back
 * and the cursor in the box from the start; Back from the thread it becomes goes to the list. Otherwise it is the
 * right page beside Chat while nothing is open there (AP-6301), which Chat's New chat brings back and wakes.
 */
export function NewChatPage({ room = 'chat', pushed = false }: { room?: ChatRoom; pushed?: boolean }) {
  const { rawLocale } = useI18n();
  const chatCopyHere = chatCopy(rawLocale);

  const navigation = useAppNavigation();
  const { slug } = useBurrowBase();
  const rooms = useChatRooms(slug);
  const words = useAgentWords();
  const agent = useTheAgentHere();
  const qc = useQueryClient();
  const resting = useContext(RestingPageContext);
  // The button that hides Chat's list starts the header (it is there whenever this page is beside Chat).
  const toggles = useContext(ListToggleContext) !== null;
  const waking = resting?.waking ?? false;
  const woke = resting?.woke;
  const [focusKey, setFocusKey] = useState(pushed ? 1 : 0);
  useEffect(() => {
    if (pushed || !waking) return;
    setFocusKey((k) => k + 1);
    woke?.();
  }, [pushed, waking, woke]);
  const back = room === 'chat' ? CHAT_WORDS.chat : CHAT_WORDS.feedback;
  const threaded = useMemo(
    () => ({
      onThreadStarted: (rootId: string) => {
        const thread = { messageId: rootId, back };
        // The page it was written on becomes the thread, so Back goes to the list.
        if (pushed) navigation.dispatch(StackActions.replace('Thread', thread));
        else navigation.navigate('Thread', thread);
      },
    }),
    [navigation, back, pushed],
  );
  const goBack = () =>
    navigation.canGoBack()
      ? navigation.goBack()
      : room === 'chat'
        ? navigation.navigate('Tabs', { screen: 'ChatRoom' })
        : navigation.navigate('Feedback');
  const conversationId = (room === 'chat' ? rooms.chat : rooms.feedback)?.id ?? null;
  return (
    <Screen>
      {pushed ? (
        <ChatHeader onBack={goBack} backLabel={back} title={newChatTitle(room)} />
      ) : (
        <LinedHeader
          minHeight={ROOM_HEADER_HEIGHT}
          style={{
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingVertical: 6,
            paddingLeft: toggles ? 10 : LARGE_TITLE_LEFT,
            paddingRight: LARGE_TITLE_LEFT,
          }}
        >
          <ListToggleButton />
          <Text size={16} weight={600} numberOfLines={1} accessibilityRole="header">
            {newChatTitle(room)}
          </Text>
        </LinedHeader>
      )}
      {!conversationId && rooms.error && !rooms.known ? (
        <ErrorState
          text={room === 'chat' ? chatCopyHere.failed : chatCopyHere.feedbackFailed}
          onRetry={() => void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.list') })}
        />
      ) : (
        <ChatView
          conversationId={conversationId}
          authors
          placeholder={words.chatPlaceholder}
          backLabel={back}
          ownRoom
          threaded={threaded}
          chatRoom={room}
          fresh
          focusKey={focusKey}
          renderEmpty={() => (
            <RoomEmpty
              avatar={
                agent ? (
                  <LiveFace face={agentFaceOf(agent)} size={44} label={agent.name} pokeable />
                ) : (
                  <WhombatAvatar size={44} silhouette />
                )
              }
              text={words.chatEmpty}
            />
          )}
        />
      )}
    </Screen>
  );
}

/** An empty room: the agent's face and one line, in the middle. */
function RoomEmpty({ avatar, text }: { avatar: ReactNode; text: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 28 }}>
      {avatar}
      <QuietText>{text}</QuietText>
    </View>
  );
}

/**
 * Feedback's header (above Chat): the back button (the chevron or the arrow) back to Chat, then the room's name
 * (24/700). No hairline: the list's filters under it draw one.
 */
function RoomHeader({ title, back }: { title: string; back: { label: string; onPress: () => void } }) {
  return (
    <View
      style={{
        minHeight: 52,
        flexDirection: 'row',
        alignItems: 'center',
        gap: HEADER_GAP,
        paddingVertical: 4,
        paddingLeft: 6,
        paddingRight: 10,
      }}
    >
      <ListToggleButton />
      <BackButton label={back.label} onPress={back.onPress} compact />
      <Text
        size={24}
        weight={700}
        numberOfLines={1}
        accessibilityRole="header"
        style={{ flex: 1, minWidth: 56 }}
      >
        {title}
      </Text>
    </View>
  );
}

/** What VoiceOver and TalkBack call Chat's ⋯ when buttons moved into it. */
const CHAT_MORE_LABEL = 'More in Chat';

/** Chat's ⋯ on a narrow page: iOS's own menu on iPhone, a sheet elsewhere. */
function HeaderMore({
  menu,
  onPick,
  onOpen,
}: {
  menu: NativeMenuSpec;
  onPick: (id: string) => void;
  onOpen: () => void;
}) {
  const theme = useTheme();
  const face = <Ellipsis size={20} color={theme.colors.ink2} strokeWidth={1.75} />;
  const style = {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  } as const;
  return hasNativeMenu ? (
    <NativeMenu spec={menu} onPick={onPick} trigger="tap" label={CHAT_MORE_LABEL} style={style}>
      <View style={style}>{face}</View>
    </NativeMenu>
  ) : (
    <Touchable
      onPress={onOpen}
      feedback="wash"
      ringRadius={22}
      accessibilityLabel={CHAT_MORE_LABEL}
      style={style}
    >
      {face}
    </Touchable>
  );
}

/** “Feedback 2”: an outlined 44pt (48dp on Android) button beside Chat's title (ink2), with an unread count. */
function HeaderButton({ label, count = 0, onPress }: { label: string; count?: number; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={10}
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `${label}, ${count} unread` : label}
      style={{
        minHeight: Platform.OS === 'android' ? 48 : 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.line2,
      }}
    >
      <Text size={15.5} color={theme.colors.ink2}>
        {label}
      </Text>
      {count > 0 ? (
        <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <CountBadge count={count} label={`${count} unread`} />
        </View>
      ) : null}
    </Touchable>
  );
}
