/**
 * The long-press menu on a message and the emoji sheet (Whombat essentials items 8, 11, 14; not mocked; AP-502,
 * AP-507): six quick reactions and “More reactions” on top, then Settle thread or Open again on a room's thread
 * (chat-settle.md AP-6157), Reply in thread, Copy text, Copy link (MX-04), Edit,
 * Pin / Unpin and Delete as 52dp rows (Delete in the bad tone, last). The menu sheet is Android's: iPhone shows the
 * same as iOS's own context menu (`modules/whombat-menu`, ios-message-menu.md). The emoji sheet searches core's list
 * (`searchEmoji`) and shows the recent ones first, then every group; the recent list stays on the phone.
 */

import type { Emoji } from '@whombat/core';
import { type ComponentType, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, TextInput, View } from 'react-native';
import type { MessageAction, MessageActionKind } from '../data/messageActions';
import {
  EMOJI_SHEET_INSET,
  type EmojiLine,
  emojiLines,
  emojiPerRow,
  emojiSections,
  parseRecentEmoji,
  recentAfter,
} from '../data/reactions';
import { useMobileT } from '../i18n';
import { STORAGE_KEYS } from '../lib/kv';
import { secureStore } from '../lib/storage';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import {
  BookmarkPlus,
  CircleCheck,
  Copy,
  LinkIcon,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Reply,
  Search,
  Share2,
  Trash,
  Undo2,
} from './icons';
import { usePageFrame } from './screenShape';
import { SHEET_MAX_WIDTH, Sheet } from './sheet';
import { Touchable } from './Touchable';

/** A row's icon: Lucide's at the rows' 1.75 stroke. */
const ICONS: Record<
  MessageActionKind,
  ComponentType<{ size: number; color: string; strokeWidth: number }>
> = {
  settle: CircleCheck,
  open_again: Undo2,
  reply_thread: Reply,
  copy_text: Copy,
  copy_link: LinkIcon,
  save_prompt: BookmarkPlus,
  share: Share2,
  share_from: Share2,
  edit: Pencil,
  pin: Pin,
  unpin: PinOff,
  delete: Trash,
};

export function MessageMenuSheet({
  visible,
  onClose,
  preview,
  detail = null,
  quick,
  onReact,
  onMoreReactions,
  actions,
  onAction,
}: {
  visible: boolean;
  onClose: () => void;
  /** A line of the message, so it's clear which one the menu is for. */
  preview: string;
  /**
   * Under it, quietly: what answered an assistant's reply in Chat, “Claude · Opus · High effort · Fast” (the long press of
   * chat-runtime-android.md AP-2726).
   */
  detail?: string | null;
  /** The quick row; null when the message takes no reactions (a tombstone). */
  quick: readonly { value: string; mine: boolean }[] | null;
  onReact: (value: string, on: boolean) => void;
  onMoreReactions: () => void;
  actions: readonly MessageAction[];
  onAction: (action: MessageAction) => void;
}) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  return (
    <Sheet visible={visible} onClose={onClose} label={tMobile('ui.message-actions')}>
      {preview ? (
        <Text
          size={13.5}
          lh={1.4}
          color={theme.colors.mut}
          numberOfLines={2}
          style={{ paddingHorizontal: 22, paddingBottom: 12 }}
        >
          {preview}
        </Text>
      ) : null}
      {detail ? (
        <Text
          size={11.5}
          mono
          color={theme.colors.mut}
          numberOfLines={1}
          style={{ paddingHorizontal: 22, marginTop: preview ? -6 : 0, paddingBottom: 12 }}
        >
          {detail}
        </Text>
      ) : null}
      {quick ? (
        <View
          accessibilityLabel={tMobile('ui.quick-reactions')}
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            paddingHorizontal: 18,
            paddingBottom: 12,
          }}
        >
          {quick.map((q) => (
            <Touchable
              key={q.value}
              onPress={() => onReact(q.value, !q.mine)}
              feedback="wash"
              ringRadius={22}
              accessibilityLabel={q.mine ? `Take back ${q.value}` : `React with ${q.value}`}
              accessibilityState={{ selected: q.mine }}
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: q.mine ? theme.colors.sel : theme.colors.sf,
                borderWidth: 1,
                borderColor: q.mine ? theme.colors.brand : theme.colors.line,
              }}
            >
              <Text size={21}>{q.value}</Text>
            </Touchable>
          ))}
          <Touchable
            onPress={onMoreReactions}
            feedback="wash"
            ringRadius={22}
            accessibilityLabel={tMobile('ui.more-reactions')}
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.colors.sf,
              borderWidth: 1,
              borderColor: theme.colors.line,
            }}
          >
            <Plus size={20} color={theme.colors.ink2} strokeWidth={2} />
          </Touchable>
        </View>
      ) : null}
      {actions.map((a) => {
        const Icon = ICONS[a.kind];
        const color = a.destructive ? theme.colors.bad : a.disabled ? theme.colors.mut : theme.colors.ink;
        const iconColor = a.destructive
          ? theme.colors.bad
          : a.disabled
            ? theme.colors.mut
            : theme.colors.ink2;
        return (
          <Touchable
            key={a.kind}
            onPress={() => onAction(a)}
            disabled={!!a.disabled}
            feedback={a.disabled ? 'none' : 'wash'}
            accessibilityLabel={a.label}
            accessibilityHint={a.accessibilityHint}
            style={{
              minHeight: 52,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 14,
              paddingHorizontal: 22,
              borderTopWidth: 1,
              borderTopColor: theme.colors.line,
            }}
          >
            <Icon size={19} color={iconColor} strokeWidth={1.75} />
            <Text size={16} weight={500} color={color} numberOfLines={1} style={{ flexShrink: 1 }}>
              {a.label}
            </Text>
          </Touchable>
        );
      })}
    </Sheet>
  );
}

/** The emoji this person reacted with lately (kept on the phone), and a way to add one. */
export function useRecentEmoji(): [string[], (char: string) => void] {
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void secureStore
      .get(STORAGE_KEYS.recentEmoji)
      .then((raw) => alive && setRecent(parseRecentEmoji(raw)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const use = (char: string) =>
    setRecent((r) => {
      const next = recentAfter(r, char);
      void secureStore.set(STORAGE_KEYS.recentEmoji, JSON.stringify(next)).catch(() => {});
      return next;
    });
  return [recent, use];
}

/** One 44dp cell of the emoji sheet (`EMOJI_CELL`). Memoised: a row re-renders only when its emoji do. */
const EmojiCell = memo(function EmojiCell({
  emoji,
  onPick,
}: {
  emoji: Emoji;
  onPick: (char: string) => void;
}) {
  return (
    <Touchable
      onPress={() => onPick(emoji.char)}
      feedback="wash"
      ringRadius={10}
      accessibilityLabel={emoji.name}
      style={{
        width: 44,
        height: 44,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text size={24}>{emoji.char}</Text>
    </Touchable>
  );
});

/**
 * Every emoji core knows, by group, with search; a tap reacts and closes. A virtualised list of the wrapped grid's rows
 * (AP-905): only the rows in view are mounted, not every group's ~390 buttons each time the sheet opens.
 */
export function EmojiSheet({
  visible,
  onClose,
  onPick,
  recent,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (char: string) => void;
  recent: readonly string[];
}) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const sections = useMemo(() => emojiSections(query, recent), [query, recent]);
  // The sheet is its page's width, at most `SHEET_MAX_WIDTH` on a wide one; the grid wrapped across it less its 14dp
  // sides.
  const page = usePageFrame();
  const perRow = emojiPerRow(Math.min(page.right - page.left, SHEET_MAX_WIDTH));
  const lines = useMemo(() => emojiLines(sections, perRow), [sections, perRow]);
  // The cells call the latest `onPick` through one function, so a new one doesn't re-render every row.
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const pick = useCallback((char: string) => pickRef.current(char), []);
  useEffect(() => {
    if (!visible) setQuery('');
  }, [visible]);
  const renderLine = useCallback(
    ({ item }: { item: EmojiLine }) =>
      item.kind === 'title' ? (
        <View style={{ paddingTop: 6 }}>
          <Text
            size={11}
            weight={500}
            mono
            tracking={0.05}
            color={theme.colors.mut}
            accessibilityRole="header"
            style={{ paddingHorizontal: 6, paddingVertical: 6 }}
          >
            {item.title}
          </Text>
        </View>
      ) : (
        <View style={{ flexDirection: 'row' }}>
          {item.emoji.map((e) => (
            <EmojiCell key={`${item.section}:${e.char}`} emoji={e} onPick={pick} />
          ))}
        </View>
      ),
    [theme, pick],
  );
  return (
    <Sheet visible={visible} onClose={onClose} label={tMobile('ui.reactions')} maxHeight="80%">
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          marginHorizontal: 18,
          marginBottom: 8,
          paddingHorizontal: 12,
          minHeight: 44,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: theme.colors.line2,
          backgroundColor: theme.colors.sf,
        }}
      >
        <Search size={16} color={theme.colors.mut} strokeWidth={1.75} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={tMobile('ui.search-emoji')}
          placeholderTextColor={theme.colors.mut}
          accessibilityLabel={tMobile('ui.search-emoji')}
          autoCorrect={false}
          autoCapitalize="none"
          cursorColor={theme.colors.ink}
          selectionColor={theme.colors.brand}
          style={{
            flex: 1,
            minHeight: 44,
            color: theme.colors.ink,
            ...textMetrics({ size: 15 }),
            includeFontPadding: false,
          }}
        />
      </View>
      <FlatList
        data={lines}
        keyExtractor={(line) => line.key}
        renderItem={renderLine}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: EMOJI_SHEET_INSET, paddingBottom: 12 }}
        // The first screenful at once (the sheet opens at its full 80%), the rest as it scrolls.
        initialNumToRender={18}
        maxToRenderPerBatch={12}
        windowSize={7}
        ListEmptyComponent={
          <Text size={14.5} color={theme.colors.mut} style={{ padding: 12, textAlign: 'center' }}>
            {tMobile('ui.no-emoji-match-that')}
          </Text>
        }
      />
    </Sheet>
  );
}
