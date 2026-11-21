/**
 * Chat and Feedback as a mail inbox (Whombat chat-inbox.md CIB-01…CIB-10; app chat-inbox-phone.md): the room's open
 * threads, newest activity first. Each row starts with an icon that says what the thread is about (a repository's, a
 * server's, else the assistant's face), with a blue dot on it when something is new and a small turning ring while the
 * assistant works; then the title and the time, and up to two lines of the newest reply (“You: …”, a reporter's name;
 * none before the assistant's own) with “Waiting for you” in front when something waits, and a count of what is new.
 * Above the list: light chips All · Unread · Waiting, and Settled at the end. A row opens its thread; swiped left it
 * settles (Undo in the toast), swiped right it is marked unread or read, as in a mail app; a long press has the same and
 * the thread's link. The list has no message box: one round New chat button floats over its lower right corner and
 * opens the new chat (`newChat`); the rows scroll under it and the last one clear of it.
 *
 * The rows are the shared `inboxRows` over `chats.threads` (`state: open`, paged) and `chats.unread`; settling is the
 * phone's own (`useSettleThread`), marking the shared hooks'. Over old rows the quiet “Updating…” or “Couldn’t update ·
 * Try again” floats as over a conversation (`ReadStatePill`); a pull spins until its reads have answered.
 */
import { useQueryClient } from '@tanstack/react-query';
import {
  INBOX_WORDS,
  type InboxFilter,
  type InboxRow,
  inboxCounts,
  inboxFiltered,
  inboxRows,
  SETTLE_WORDS,
} from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import {
  useChatThreads,
  useMarkThreadUnread,
  useReadThread,
  useThreadUnread,
  useWhombat,
} from '@whombat/client/react';
import { api, type ChatRoom, type ConversationLink, type ThreadView } from '@whombat/core';
import { memo, type ReactNode, useCallback, useMemo, useState } from 'react';
import { AccessibilityInfo, FlatList, Platform, RefreshControl, View } from 'react-native';
import { useBurrowBase, useNow } from '../data/BurrowProvider';
import {
  type InboxActionId,
  type InboxSwipe,
  inboxActions,
  inboxEmpty,
  inboxRowLabel,
  inboxSwipe,
  parseInboxAction,
} from '../data/chatInbox';
import { CHAT_COPY } from '../data/chatRoom';
import { COPIED_TEXT, messageLinkPath } from '../data/messageActions';
import { type NativeMenuSpec, plainMenu } from '../data/nativeMenu';
import { threadQuery } from '../data/threadPages';
import { SETTLE_COPY } from '../data/threadSettle';
import { showToast } from '../data/toast';
import { useAgentWords } from '../data/useAgent';
import { usePrefetchThread } from '../data/useThreadOpening';
import { useSettleThread } from '../data/useThreadSettle';
import { useWebUrl } from '../data/useWebUrl';
import { useManaged } from '../managed/context';
import { useAppNavigation } from '../navigation/hooks';
import { isBesideThread, useBeside } from '../navigation/panes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { copyToClipboard } from '../ui/clipboard';
import { Check, ChevronRight, Mail, MailOpen } from '../ui/icons';
import { hasNativeMenu, MenuSheet, NativeMenu } from '../ui/nativeMenu';
import { NEW_CHAT_BUTTON, NEW_CHAT_BUTTON_EDGE, NewChatButton } from '../ui/newChatButton';
import { ErrorState, SkeletonRows } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { closeSwipeRows, type SwipeAction, SwipeRow } from '../ui/swipeRow';
import { Touchable } from '../ui/Touchable';
import { THREAD_ICON, ThreadIcon } from '../ui/threadIcon';
import { hitSlopFor } from '../ui/touchTarget';
import { ReadStatePill } from '../ui/updatingPill';
import { errorText } from './feedback';

/** SF Symbols for a row's menu on iPhone. */
const ACTION_SYMBOLS: Record<InboxActionId, string> = {
  settle: 'checkmark.circle',
  mark_unread: 'envelope.badge',
  mark_read: 'envelope.open',
  copy_link: 'link',
  share: 'square.and.arrow.up',
};

/** What TalkBack calls a row's menu sheet. */
const MENU_LABEL = 'Thread actions';

/** A row's sides, and the room between its icon and its words (where the hairline under it starts). */
const ROW_SIDE = 16;
const ICON_GAP = 12;

export function ChatInbox({
  room,
  conversationId,
  back,
  welcome,
  newChat,
}: {
  room: ChatRoom;
  conversationId: string;
  /** The back label on a thread opened from here (“Chat”, “Feedback”). */
  back: string;
  /** A room that never had a thread: the agent's face and its first words. */
  welcome: ReactNode;
  /** The New chat button: what a screen reader calls it, whether the new chat shows beside the list, what it opens. */
  newChat: { label: string; selected: boolean; onPress: () => void };
}) {
  const theme = useTheme();
  const navigation = useAppNavigation();
  // The list runs on under iOS's tab bar or to the window's edge; the button and the last row stay clear of that.
  const bottomRoom = useBottomRoom();
  const qc = useQueryClient();
  const { queries } = useWhombat();
  const { slug, people, timeZone, me, mode } = useBurrowBase();
  const now = useNow();
  const words = useAgentWords();
  const beside = useBeside();
  const threads = useChatThreads(slug, room, { state: 'open', conversationId });
  const unread = useThreadUnread(slug, room);
  const settle = useSettleThread();
  const markUnread = useMarkThreadUnread(slug);
  const readThread = useReadThread(slug);
  const prefetch = usePrefetchThread(slug);
  const [filter, setFilter] = useState<InboxFilter>('all');

  // The thread open beside the list (two pages) is being read: it never shows as new.
  const openRootId =
    beside?.name === 'Thread'
      ? ((beside.params as { messageId?: string } | undefined)?.messageId ?? null)
      : null;
  const rows = useMemo(
    () =>
      inboxRows(threads.threads, unread, {
        me: me.id,
        agentId: people.agent?.id,
        agentName: words.Name,
        nameOf: (id) => people.get(id)?.name,
        now,
        timeZone,
        openRootId,
      }),
    [threads.threads, unread, me.id, people, words.Name, now, timeZone, openRootId],
  );
  const counts = inboxCounts(rows);
  const shown = inboxFiltered(rows, filter);

  // Copy link where the thread has a web address (not in the demo world); Share for Chat on a box.
  const webUrl = useWebUrl();
  const canLink = mode !== 'fixtures' && webUrl('/') !== null;
  const canShare = useManaged() !== null && room === 'chat';
  const where = useMemo<ConversationLink>(
    () => (room === 'feedback' ? { type: 'dm', room: 'feedback' } : { type: 'dm' }),
    [room],
  );

  const open = useCallback(
    (rootId: string) => navigation.navigate('Thread', { messageId: rootId, back }),
    [navigation, back],
  );
  // Read to its end: the thread's newest page (cached, or asked for) says which message that is.
  const markRead = useCallback(
    (rootId: string) => {
      void qc
        .fetchQuery(
          queries.endpoint(api.messages.thread, {
            params: { burrow: slug, messageId: rootId },
            query: threadQuery(),
          }),
        )
        .then((view: ThreadView) => {
          const last = view.replies.at(-1)?.id ?? view.root.id;
          readThread({ conversationId, rootId, messageId: last });
        })
        .catch((error: unknown) => showToast(errorText(error)));
    },
    [qc, queries, slug, readThread, conversationId],
  );
  const act = useCallback(
    (rootId: string, id: InboxActionId) => {
      switch (id) {
        case 'settle':
          settle({ rootId, room }, true);
          return;
        case 'mark_unread':
          markUnread({ conversationId, rootId });
          AccessibilityInfo.announceForAccessibility(INBOX_WORDS.markedUnread);
          return;
        case 'mark_read':
          markRead(rootId);
          return;
        case 'copy_link': {
          const url = webUrl(messageLinkPath({ id: rootId, threadRootId: null }, where, slug));
          if (url) void copyToClipboard(url, COPIED_TEXT.link);
          return;
        }
        case 'share':
          navigation.navigate('ShareLink', { rootId });
          return;
      }
    },
    [settle, room, markUnread, conversationId, markRead, webUrl, where, slug, navigation],
  );
  // Elsewhere than iPhone a row's menu is a sheet, for the row it was opened on.
  const [menuFor, setMenuFor] = useState<{ rootId: string; spec: NativeMenuSpec } | null>(null);
  // A pull spins until the reads it asked for have answered (or failed: the pill then says so).
  const [pulling, setPulling] = useState(false);
  const refresh = () => {
    setPulling(true);
    void Promise.allSettled([
      threads.read.refetch(),
      qc.invalidateQueries({ queryKey: queryKeys.scope('chats.unread') }),
    ]).finally(() => setPulling(false));
  };

  const renderItem = ({ item }: { item: InboxRow }) => {
    const swipe = inboxSwipe(item);
    return (
      <InboxRowView
        row={item}
        swipe={swipe}
        // Marked read in Unread, the row leaves that list.
        marksAway={filter === 'unread'}
        selected={isBesideThread(beside, item.rootId)}
        actions={inboxActions(swipe, { link: canLink, share: canShare })}
        onOpen={open}
        onPressIn={prefetch}
        onAct={act}
        onMenu={(rootId, spec) => setMenuFor({ rootId, spec })}
      />
    );
  };

  let empty: ReactNode = null;
  if (threads.isLoading) empty = <SkeletonRows count={6} lines={2} label="Loading the threads" />;
  else if (threads.error)
    empty = (
      <ErrorState
        text={room === 'chat' ? CHAT_COPY.failed : CHAT_COPY.feedbackFailed}
        onRetry={threads.refetch}
      />
    );
  // A room that never had a thread greets; one whose threads are all settled says so.
  else if (filter === 'all' && !threads.settledCount) empty = welcome;
  else empty = <InboxEmpty filter={filter} />;

  return (
    <View style={{ flex: 1 }}>
      <FilterBar
        filter={filter}
        counts={counts}
        onChange={setFilter}
        onSettled={() => navigation.navigate('Settled', { room })}
      />
      <View style={{ flex: 1 }}>
        <FlatList
          data={shown as InboxRow[]}
          keyExtractor={(r) => r.rootId}
          renderItem={renderItem}
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            paddingBottom: NEW_CHAT_BUTTON + 2 * NEW_CHAT_BUTTON_EDGE + bottomRoom,
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          showsVerticalScrollIndicator={false}
          onScrollBeginDrag={closeSwipeRows}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (threads.hasMore && !threads.loadingMore) threads.loadMore();
          }}
          refreshControl={
            <RefreshControl
              refreshing={pulling}
              onRefresh={refresh}
              colors={[theme.colors.ink]}
              tintColor={theme.colors.mut}
              progressBackgroundColor={theme.colors.sf}
            />
          }
          ListEmptyComponent={<View style={{ flex: 1, justifyContent: 'center' }}>{empty}</View>}
        />
        {/* Over old threads: “Updating…” or “Couldn’t update · Try again”, as over a conversation. A pull has its spinner. */}
        {pulling ? null : <ReadStatePill source={threads.read} />}
        <NewChatButton
          label={newChat.label}
          selected={newChat.selected}
          bottom={NEW_CHAT_BUTTON_EDGE + bottomRoom}
          onPress={newChat.onPress}
        />
      </View>
      {hasNativeMenu ? null : (
        <MenuSheet
          spec={menuFor?.spec ?? null}
          visible={menuFor !== null}
          label={MENU_LABEL}
          onClose={() => setMenuFor(null)}
          onPick={(id) => {
            const target = menuFor;
            setMenuFor(null);
            const action = parseInboxAction(id);
            if (target && action) act(target.rootId, action);
          }}
        />
      )}
    </View>
  );
}

/**
 * All · Unread n · Waiting n as light chips (30dp, padded to 44 for the finger), the chosen one on `sf2`; a number only
 * when there is one, Unread's blue and Waiting's in the warning's ink. At the end of the row a quiet “Settled ›” opens
 * the room's settled threads. A hairline under the row.
 */
function FilterBar({
  filter,
  counts,
  onChange,
  onSettled,
}: {
  filter: InboxFilter;
  counts: { unread: number; waiting: number };
  onChange: (f: InboxFilter) => void;
  onSettled: () => void;
}) {
  const theme = useTheme();
  const items: { value: InboxFilter; label: string; n: number | null; tone: string }[] = [
    { value: 'all', label: INBOX_WORDS.all, n: null, tone: theme.colors.mut },
    { value: 'unread', label: INBOX_WORDS.unread, n: counts.unread, tone: theme.chart.chart1 },
    { value: 'waiting', label: INBOX_WORDS.waiting, n: counts.waiting, tone: theme.colors.warnText },
  ];
  return (
    <View
      style={{
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingLeft: ROW_SIDE,
        paddingRight: 6,
        paddingBottom: 4,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      <View
        accessibilityRole="tablist"
        accessibilityLabel={INBOX_WORDS.show}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}
      >
        {items.map((it) => {
          const on = it.value === filter;
          return (
            <Touchable
              key={it.value}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={it.n !== null ? `${it.label}, ${it.n}` : it.label}
              onPress={() => onChange(it.value)}
              feedback={on ? 'none' : 'wash'}
              ringRadius={15}
              hitSlop={hitSlopFor(30)}
              style={{
                minHeight: 30,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 12,
                borderRadius: 15,
                backgroundColor: on ? theme.colors.sf2 : 'transparent',
              }}
            >
              <Text
                size={13}
                weight={on ? 600 : 400}
                color={on ? theme.colors.ink : theme.colors.mut}
                numberOfLines={1}
              >
                {it.label}
              </Text>
              {it.n ? (
                <Text size={11} mono weight={500} color={it.tone} style={{ fontVariant: ['tabular-nums'] }}>
                  {String(it.n)}
                </Text>
              ) : null}
            </Touchable>
          );
        })}
      </View>
      <Touchable
        onPress={onSettled}
        accessibilityRole="button"
        accessibilityLabel={SETTLE_WORDS.settled}
        feedback="wash"
        ringRadius={10}
        style={{
          marginLeft: 'auto',
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 2,
          paddingLeft: 10,
          paddingRight: 8,
          borderRadius: 10,
        }}
      >
        <Text size={13} color={theme.colors.mut} numberOfLines={1}>
          {SETTLE_WORDS.settled}
        </Text>
        <ChevronRight size={14} color={theme.colors.mut} strokeWidth={1.8} />
      </Touchable>
    </View>
  );
}

interface InboxRowProps {
  row: InboxRow;
  swipe: InboxSwipe;
  /** Marking it read takes it out of the list (the Unread filter). */
  marksAway: boolean;
  /** Its thread is open beside the list. */
  selected: boolean;
  actions: readonly { id: InboxActionId; title: string }[];
  onOpen: (rootId: string) => void;
  onPressIn: (rootId: string) => void;
  onAct: (rootId: string, id: InboxActionId) => void;
  onMenu: (rootId: string, spec: NativeMenuSpec) => void;
}

/**
 * One thread's row: 64dp at least, as tall as its words. The icon (40, its state on its corners), then the title (one
 * line, a repository's name at its end quieter) and the time in mono, and under them up to two lines of the newest reply
 * with “Waiting for you” in front when something waits, and the count of what is new. Something new: the title bold
 * in ink, the time and count blue, the reply in ink2; read: the title medium in ink2, the reply muted. The hairline
 * under it starts where the words do. The whole row is the button; swiped left it settles, right it is marked unread
 * or read; held, its menu.
 */
const InboxRowView = memo(function InboxRowView({
  row,
  swipe,
  marksAway,
  selected,
  actions,
  onOpen,
  onPressIn,
  onAct,
  onMenu,
}: InboxRowProps) {
  const theme = useTheme();
  const isNew = row.unread > 0;
  const trailing = useMemo<SwipeAction[]>(
    () =>
      swipe.settle
        ? [{ label: SETTLE_COPY.swipe, icon: Check, leaves: true, run: () => onAct(row.rootId, 'settle') }]
        : [],
    [swipe.settle, onAct, row.rootId],
  );
  const leading = useMemo<SwipeAction[]>(
    () =>
      swipe.mark === 'unread'
        ? [
            {
              label: INBOX_WORDS.markUnread,
              icon: Mail,
              tone: 'new',
              run: () => onAct(row.rootId, 'mark_unread'),
            },
          ]
        : swipe.mark === 'read'
          ? [
              {
                label: INBOX_WORDS.markRead,
                icon: MailOpen,
                tone: 'new',
                leaves: marksAway,
                run: () => onAct(row.rootId, 'mark_read'),
              },
            ]
          : [],
    [swipe.mark, marksAway, onAct, row.rootId],
  );
  const spec = useMemo(
    () => plainMenu([actions.map((a) => ({ id: a.id, title: a.title, icon: ACTION_SYMBOLS[a.id] }))]),
    [actions],
  );
  const pick = (id: string) => {
    const action = parseInboxAction(id);
    if (action) onAct(row.rootId, action);
  };
  const body = (
    <Touchable
      onPress={() => onOpen(row.rootId)}
      onPressIn={() => onPressIn(row.rootId)}
      {...(hasNativeMenu || actions.length === 0 ? null : { onLongPress: () => onMenu(row.rootId, spec) })}
      feedback="wash"
      accessibilityLabel={inboxRowLabel(row)}
      accessibilityState={{ selected }}
      // Screen readers can't swipe or hold: the row's actions carry what the swipes and the menu do.
      accessibilityActions={actions.map((a) => ({ name: a.id, label: a.title }))}
      onAccessibilityAction={(e) => pick(e.nativeEvent.actionName)}
      style={{
        flexDirection: 'row',
        minHeight: 64,
        paddingLeft: ROW_SIDE,
        backgroundColor: selected ? theme.colors.sel : 'transparent',
      }}
    >
      <View style={{ width: THREAD_ICON, marginTop: 12, marginRight: ICON_GAP }}>
        <ThreadIcon row={row} fresh={isNew} working={row.working} />
      </View>
      <View
        style={{
          flex: 1,
          minWidth: 0,
          paddingTop: 11,
          paddingBottom: 12,
          paddingRight: ROW_SIDE,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.line,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text
            size={14}
            weight={isNew ? 700 : 500}
            color={isNew ? theme.colors.ink : theme.colors.ink2}
            numberOfLines={1}
            style={{ flex: 1, minWidth: 0 }}
          >
            {row.titleHead}
            {row.titleTail ? (
              <Text size={14} weight={400} color={theme.colors.mut}>
                {row.titleTail}
              </Text>
            ) : null}
          </Text>
          <Text
            size={11.5}
            mono
            weight={isNew ? 500 : 400}
            color={isNew ? theme.chart.chart1 : theme.colors.mut}
            style={{ fontVariant: ['tabular-nums'] }}
          >
            {row.when}
          </Text>
        </View>
        {row.waiting || row.line ? (
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 3 }}>
            <Text
              size={13}
              lh={1.32}
              color={isNew ? theme.colors.ink2 : theme.colors.mut}
              numberOfLines={2}
              style={{ flex: 1, minWidth: 0 }}
            >
              {row.waiting ? <WaitingChip /> : null}
              {row.waiting && row.line ? ' ' : null}
              {row.shownWho && row.line ? (
                <Text
                  size={13}
                  weight={600}
                  color={isNew ? theme.colors.ink2 : theme.colors.mut}
                >{`${row.shownWho}: `}</Text>
              ) : null}
              {row.line}
            </Text>
            {isNew ? <NewCount n={row.unread} /> : null}
          </View>
        ) : isNew ? (
          <View style={{ alignItems: 'flex-end', marginTop: 3 }}>
            <NewCount n={row.unread} />
          </View>
        ) : null}
      </View>
    </Touchable>
  );
  return (
    <SwipeRow leading={leading} trailing={trailing}>
      {hasNativeMenu && actions.length ? (
        <NativeMenu spec={spec} onPick={pick}>
          {body}
        </NativeMenu>
      ) : (
        body
      )}
    </SwipeRow>
  );
}, sameRow);

function sameRow(a: InboxRowProps, b: InboxRowProps): boolean {
  const keys = Object.keys(a.row) as (keyof InboxRow)[];
  return (
    keys.every((k) => a.row[k] === b.row[k]) &&
    a.swipe.settle === b.swipe.settle &&
    a.swipe.mark === b.swipe.mark &&
    a.marksAway === b.marksAway &&
    a.selected === b.selected &&
    a.actions.length === b.actions.length &&
    a.actions.every((x, i) => x.id === b.actions[i]?.id) &&
    a.onOpen === b.onOpen &&
    a.onPressIn === b.onPressIn &&
    a.onAct === b.onAct
  );
}

/**
 * “Waiting for you” at the start of the reply's words, which wrap under it: `warnText` 12/600 on `sf2`, 19dp, 6 round.
 * The row's label says it.
 */
function WaitingChip() {
  const theme = useTheme();
  return (
    <View
      style={{
        height: 19,
        justifyContent: 'center',
        paddingHorizontal: 6,
        borderRadius: 6,
        backgroundColor: theme.colors.sf2,
        transform: [{ translateY: 4 }],
      }}
    >
      <Text size={12} weight={600} color={theme.colors.warnText}>
        {INBOX_WORDS.waitingForYou}
      </Text>
    </View>
  );
}

/** The count of new messages: a blue pill (18dp, at least 20 wide), its number light. The row's label says it. */
function NewCount({ n }: { n: number }) {
  const theme = useTheme();
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{
        minWidth: 20,
        height: 18,
        marginTop: 1,
        paddingHorizontal: 6,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.chart.chart1,
      }}
    >
      <Text size={11} weight={700} color={theme.colors.onSolid} style={{ fontVariant: ['tabular-nums'] }}>
        {n > 99 ? '99+' : String(n)}
      </Text>
    </View>
  );
}

/** A filter with nothing in it: a tick in a circle, its words and, for some, a line under them. */
function InboxEmpty({ filter }: { filter: InboxFilter }) {
  const theme = useTheme();
  const words = inboxEmpty(filter);
  return (
    <View style={{ alignItems: 'center', gap: 6, paddingHorizontal: 24, paddingVertical: 56 }}>
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          marginBottom: 4,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.sf2,
        }}
      >
        <Check size={18} color={theme.colors.ok} strokeWidth={2} />
      </View>
      <Text size={15} weight={600} style={{ textAlign: 'center' }}>
        {words.title}
      </Text>
      {words.hint ? (
        <Text size={13.5} lh={1.45} color={theme.colors.mut} style={{ textAlign: 'center' }}>
          {words.hint}
        </Text>
      ) : null}
    </View>
  );
}
