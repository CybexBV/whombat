/**
 * A room's settled threads (Whombat chat-settle.md CHS-10; app chat-settle.md AP-6153, AP-6157, AP-6250, AP-6252): Chat's
 * (or Feedback's) “Settled”, since the room itself shows only open threads. The latest settled first, ten at a time with
 * Show more. A row shows who started it, the start of its first message and how it settled; it opens its thread. Swiped
 * left it shows ↶ Open again at the edge (a full swipe runs it, the success haptic), which puts it back in the room, and
 * More beside it; a long press opens the same menu (Open again, Reply in thread, Copy link; iOS's own on iPhone, a sheet
 * elsewhere; ios-native.md AP-6271, AP-6274). Both sit on the right: on an iPhone a pull to the right goes back. TalkBack
 * gets the menu's choices as the row's actions. Live on the room (`useChatThreads`), and an Open again changes it at once
 * (`useThreadSettle`). At its foot, when threads settle by themselves (Whombat chat-inbox.md CIB-09).
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { chatWords, SETTLED_PAGE, settleWords, threadIconFields, threadRows } from '@whombat/client';
import { useChatRooms, useChatThreads } from '@whombat/client/react';
import type { ChatThread, ConversationLink } from '@whombat/core';
import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useBurrow, useNow } from '../data/BurrowProvider';
import { chatCopy, phoneThreadRows } from '../data/chatRoom';
import { copiedText, messageLinkPath } from '../data/messageActions';
import { type NativeMenuSpec, parseSettledPick, settledThreadMenu } from '../data/nativeMenu';
import { chatPreferencesOf, settleCopy, settledRowLine, settledShelf } from '../data/threadSettle';
import { useAgentWords } from '../data/useAgent';
import { useSettleThread } from '../data/useThreadSettle';
import { useWebUrl } from '../data/useWebUrl';
import { useI18n, useMobileT } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { QuietChoiceRow } from '../settings/ChatSettleSection';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { copyToClipboard } from '../ui/clipboard';
import { ChatHeader, Screen } from '../ui/headers';
import { Ellipsis, Undo2 } from '../ui/icons';
import { hasNativeMenu, MenuSheet, NativeMenu } from '../ui/nativeMenu';
import { ErrorState, QuietText, SkeletonRows } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { closeSwipeRows, type SwipeAction, SwipeRow } from '../ui/swipeRow';
import { Touchable } from '../ui/Touchable';
import { ThreadIcon } from '../ui/threadIcon';

type Props = NativeStackScreenProps<RootStackParamList, 'Settled'>;

interface ListRow {
  thread: ChatThread;
  title: string;
  meta: string;
  label: string;
}

export function SettledScreen({ route, navigation }: Props) {
  const { rawLocale } = useI18n();
  const chatWordsHere = chatWords(rawLocale);
  const settleWordsHere = settleWords(rawLocale);
  const chatCopyHere = chatCopy(rawLocale);
  const settleCopyHere = settleCopy(rawLocale);

  const { t: tMobile } = useMobileT();
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const room = route.params?.room ?? 'chat';
  const { slug, people, timeZone, bootstrap, mode } = useBurrow();
  const now = useNow();
  const words = useAgentWords();
  const rooms = useChatRooms(slug);
  const conversationId = rooms[room]?.id ?? null;
  // Live on the room's conversation: a thread settled on another device comes in at the top.
  const shelf = useChatThreads(slug, room, { state: 'settled', limit: SETTLED_PAGE, conversationId });
  const settle = useSettleThread();
  const quietDays = chatPreferencesOf(bootstrap.preferences).settleQuietDays;

  const rows = useMemo((): ListRow[] => {
    const threads = settledShelf(shelf.threads);
    const base = phoneThreadRows(threadRows(threads, now, timeZone), people, words, rawLocale);
    return threads.map((thread, i) => {
      const title = base[i]?.title ?? '…';
      const meta = settledRowLine(thread.settled, now, timeZone, quietDays, rawLocale);
      const about = thread.subject ? `about ${thread.subject.name}` : null;
      // The icon shows the repository; a screen reader hears its name unless the title says it.
      const repo =
        thread.repo && !title.toLocaleLowerCase().includes(thread.repo.name.toLocaleLowerCase())
          ? thread.repo.name
          : null;
      return { thread, title, meta, label: [title, repo, about, meta].filter(Boolean).join(', ') };
    });
  }, [shelf.threads, now, timeZone, people, words, quietDays, rawLocale]);

  const back = room === 'chat' ? chatWordsHere.chat : chatWordsHere.feedback;
  const goBack = () =>
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs', { screen: 'ChatRoom' });
  const openThread = (rootId: string) =>
    navigation.navigate('Thread', { messageId: rootId, back: settleWordsHere.settled });
  const openAgain = (t: ChatThread): SwipeAction => ({
    label: settleCopyHere.openAgain,
    icon: Undo2,
    leaves: true,
    run: () => settle({ rootId: t.rootId, room }, false),
  });
  // Copy link: the thread's web address on this Whombat, as its first message's menu copies it (not in the demo world).
  const webUrl = useWebUrl();
  const where: ConversationLink = room === 'feedback' ? { type: 'dm', room: 'feedback' } : { type: 'dm' };
  const linkOf = (t: ChatThread) =>
    webUrl(messageLinkPath({ id: t.rootId, threadRootId: null }, where, slug));
  const menu = settledThreadMenu(mode !== 'fixtures' && webUrl('/') !== null, rawLocale);
  const pick = (t: ChatThread, id: string) => {
    switch (parseSettledPick(id)) {
      case 'open_again':
        return settle({ rootId: t.rootId, room }, false);
      case 'reply_thread':
        return openThread(t.rootId);
      case 'copy_link': {
        const url = linkOf(t);
        if (url) void copyToClipboard(url, copiedText(rawLocale).link, rawLocale);
        return;
      }
    }
  };
  // Elsewhere than iPhone the menu is a sheet, for the row it was opened on.
  const [menuFor, setMenuFor] = useState<ChatThread | null>(null);
  const [quietProblem, setQuietProblem] = useState<string | null>(null);
  const more = (t: ChatThread): SwipeAction => ({
    label: settleCopyHere.more,
    icon: Ellipsis,
    tone: 'neutral',
    run: () => setMenuFor(t),
    menu: { spec: menu, onPick: (id) => pick(t, id) },
  });

  return (
    <Screen>
      <ChatHeader onBack={goBack} backLabel={back} title={settleWordsHere.settled} subtitle={back} />
      <ScrollView
        onScrollBeginDrag={closeSwipeRows}
        contentContainerStyle={{ paddingTop: 2, paddingBottom: 24 + bottomRoom }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={shelf.refetch}
            colors={[theme.colors.ink]}
            tintColor={theme.colors.mut}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        {shelf.isLoading ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 14 }}>
            <SkeletonRows count={6} lines={2} label={tMobile('screens.loading-the-settled-threads')} />
          </View>
        ) : shelf.error && rows.length === 0 ? (
          <ErrorState text={chatCopyHere.settledFailed} onRetry={shelf.refetch} />
        ) : rows.length === 0 ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 14 }}>
            <QuietText>{settleWordsHere.noneSettled}</QuietText>
          </View>
        ) : (
          <>
            {rows.map((r) => (
              <SettledRow
                key={r.thread.rootId}
                row={r}
                swipe={openAgain(r.thread)}
                more={more(r.thread)}
                menu={menu}
                onPick={(id) => pick(r.thread, id)}
                onOpen={() => openThread(r.thread.rootId)}
              />
            ))}
            {shelf.hasMore ? (
              <MoreButton label={settleCopyHere.showMore} busy={shelf.loadingMore} onPress={shelf.loadMore} />
            ) : null}
          </>
        )}
        {/* When threads come here by themselves, chosen where they arrive (as in Settings → Profile). */}
        <View style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: theme.colors.line }}>
          <QuietChoiceRow onProblem={setQuietProblem} />
          {quietProblem ? (
            <Text
              size={13.5}
              lh={1.45}
              color={theme.colors.bad}
              accessibilityLiveRegion="polite"
              style={{ paddingHorizontal: 16 }}
            >
              {quietProblem}
            </Text>
          ) : null}
        </View>
      </ScrollView>
      {hasNativeMenu ? null : (
        <MenuSheet
          spec={menuFor ? menu : null}
          visible={menuFor !== null}
          label={tMobile('screens2.chat.threadActions')}
          onClose={() => setMenuFor(null)}
          onPick={(id) => menuFor && pick(menuFor, id)}
        />
      )}
    </Screen>
  );
}

/** “Show more”: a 44dp brand word. */
function MoreButton({ label, busy, onPress }: { label: string; busy: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      disabled={busy}
      accessibilityState={{ busy }}
      feedback="wash"
      ringRadius={10}
      style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 18 }}
    >
      <Text size={13} weight={500} color={busy ? theme.colors.mut : theme.colors.brand}>
        {label}
      </Text>
    </Touchable>
  );
}

/**
 * A settled thread's row (the mock's `.trow`): its icon as Chat's list draws it (32: the repository's, the thing's or
 * the assistant's face), the first line (14.5/500) and how it settled (12.5). A long press opens its menu (`more`'s), whose choices are the row's accessibility actions too.
 */
function SettledRow({
  row,
  swipe,
  more,
  menu,
  onPick,
  onOpen,
}: {
  row: ListRow;
  swipe: SwipeAction;
  more: SwipeAction;
  menu: NativeMenuSpec;
  onPick: (id: string) => void;
  onOpen: () => void;
}) {
  const theme = useTheme();
  return (
    <SwipeRow trailing={[swipe, more]}>
      <NativeMenu spec={menu} onPick={onPick}>
        <Touchable
          onPress={onOpen}
          {...(hasNativeMenu ? null : { onLongPress: more.run })}
          feedback="wash"
          accessibilityLabel={row.label}
          // Screen readers can't swipe or hold: the menu's choices are the row's own actions.
          accessibilityActions={menu.sections.flat().map((i) => ({ name: i.id, label: i.title }))}
          onAccessibilityAction={(e) => onPick(e.nativeEvent.actionName)}
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 10,
            minHeight: 44,
            paddingVertical: 11,
            paddingHorizontal: 18,
          }}
        >
          <ThreadIcon row={threadIconFields(row.thread)} size={32} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text size={14.5} weight={500} lh={1.35} numberOfLines={1} color={theme.colors.ink}>
              {row.title}
            </Text>
            <Text size={12.5} numberOfLines={1} color={theme.colors.mut} style={{ marginTop: 2 }}>
              {row.meta}
            </Text>
          </View>
        </Touchable>
      </NativeMenu>
    </SwipeRow>
  );
}
