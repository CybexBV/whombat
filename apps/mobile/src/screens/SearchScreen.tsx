/**
 * Search (docs/decisions/phone-shell-final.md): a field, then what it finds grouped as Chats, Things, Settings and
 * Places (`data/search.ts`), each a whole row to tap. Before anything is typed it says what it finds and offers a few
 * real names; while the chats and things are read it says so; a read that failed has Try again; nothing found says so.
 * Opened from the Search link above a tab or from Places, with “‹ {that page}” first; a result opens with “‹ Search”,
 * and coming back finds the words, the list and where it was scrolled as they were (the page stays under the result,
 * and the words are kept in its params across a restart). At large text the rows grow and the page scrolls.
 */

import { StackActions } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { threadRows } from '@whombat/client';
import { useChatRooms, useChatThreads, useHomeOverview } from '@whombat/client/react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useBurrowBase, useNow } from '../data/BurrowProvider';
import { placeRoute, placeWords } from '../data/places';
import {
  type SearchEntry,
  type SearchSetting,
  searchCopy,
  searchEntries,
  searchSettings,
  searchSuggestions,
  searchView,
} from '../data/search';
import { useAgentWords } from '../data/useAgent';
import { useI18n } from '../i18n';
import { openHref } from '../navigation/hooks';
import type { RootStackParamList } from '../navigation/routes';
import { advancedRowsOnPhone, youLine, youPartsHere } from '../settings/groups';
import { useSettingsRows } from '../settings/useSettingsFacts';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import { ThingIcon } from '../ui/assistant';
import { BackBar, Screen } from '../ui/headers';
import {
  Bell,
  ChevronRight,
  CircleUser,
  type LucideIcon,
  Monitor,
  Newspaper,
  Plug,
  Search,
  Server,
  SlidersHorizontal,
  Smile,
  SunMoon,
  X,
} from '../ui/icons';
import { PLACE_ICONS, PlacesButton, SHELL_TARGET, useServerFacts } from '../ui/places';
import { Skeleton } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { Touchable } from '../ui/Touchable';

type Props = NativeStackScreenProps<RootStackParamList, 'Search'>;

const SETTING_ICONS: Record<SearchSetting['icon'], LucideIcon> = {
  you: CircleUser,
  bell: Bell,
  theme: SunMoon,
  assistant: Smile,
  connections: Plug,
  box: Server,
  news: Newspaper,
  screen: Monitor,
  advanced: SlidersHorizontal,
  part: SlidersHorizontal,
};

/** What this page is called in the “‹ …” of what it opens. */

export function SearchScreen({ navigation, route }: Props) {
  const { rawLocale } = useI18n();
  const searchCopyHere = searchCopy(rawLocale);

  const theme = useTheme();
  const bottomRoom = useBottomRoom();
  const { slug, timeZone, mode } = useBurrowBase();
  const now = useNow();
  const words = useAgentWords();
  const [query, setQuery] = useState(route.params?.q ?? '');
  const input = useRef<TextInput>(null);

  // The words stay in the route, so a restart or a link back finds them (a short pause, not every key).
  useEffect(() => {
    const t = setTimeout(() => navigation.setParams({ q: query }), 300);
    return () => clearTimeout(t);
  }, [query, navigation]);

  const rooms = useChatRooms(slug);
  const chat = useChatThreads(slug, 'chat', { conversationId: rooms.chat?.id, enabled: !!rooms.chat?.id });
  const feedback = useChatThreads(slug, 'feedback', {
    conversationId: rooms.feedback?.id,
    enabled: !!rooms.feedback?.id,
  });
  const overview = useHomeOverview({ params: { burrow: slug } });
  const servers = useServerFacts();
  const settingsRows = useSettingsRows();
  const screenRow = settingsRows.find((r) => r.key === 'screen')?.title ?? null;
  const newsRow = settingsRows.some((r) => r.key === 'news');
  const managed = mode === 'managed';

  const settings = useMemo(
    () =>
      searchSettings({
        assistant: words.Name,
        locale: rawLocale,
        managed,
        you: youLine(youPartsHere({ mode }), rawLocale),
        screen: screenRow,
        news: newsRow,
        advanced: advancedRowsOnPhone(words.name, { mode }),
      }),
    [words.Name, words.name, managed, mode, screenRow, newsRow, rawLocale],
  );
  const threads = useMemo(
    () => threadRows([...chat.threads, ...feedback.threads], now, timeZone),
    [chat.threads, feedback.threads, now, timeZone],
  );
  const entries = useMemo(
    () =>
      searchEntries({
        threads,
        things: overview.data?.things,
        settings,
        assistant: words.Name,
        servers,
        locale: rawLocale,
      }),
    [threads, overview.data?.things, settings, words.Name, servers, rawLocale],
  );
  const loading = !rooms.known || chat.isLoading || feedback.isLoading || overview.isLoading;
  const failed =
    (!!rooms.error && !rooms.known) ||
    (!!chat.error && chat.threads.length === 0) ||
    (!!feedback.error && feedback.threads.length === 0) ||
    (!!overview.error && !overview.data);
  const view = searchView({ query, entries, loading: loading && !failed, failed, locale: rawLocale });
  const retry = () => {
    chat.refetch();
    feedback.refetch();
    void overview.refetch();
  };

  const open = (entry: SearchEntry) => {
    const o = entry.open;
    switch (o.kind) {
      case 'thread':
        return navigation.navigate('Thread', { messageId: o.rootId, back: searchCopyHere.title });
      case 'thing':
        if (o.href) return void openHref(o.href);
        return navigation.navigate('Thing', {
          thingId: o.thingId,
          title: o.title,
          back: searchCopyHere.title,
        });
      case 'setting':
        if (o.target.kind === 'tab')
          return navigation.dispatch(StackActions.popTo('Tabs', { screen: 'Settings' }));
        return (navigation.navigate as (name: string, params?: object) => void)(
          o.target.name,
          o.target.params,
        );
      case 'place': {
        const r = placeRoute(o.place, searchCopyHere.title);
        if (r.kind === 'tab') return navigation.dispatch(StackActions.popTo('Tabs', { screen: r.tab }));
        return (navigation.navigate as (name: string, params: object) => void)(r.name, r.params);
      }
    }
  };
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));
  const status =
    view.kind === 'results'
      ? searchCopyHere.count(view.count)
      : view.kind === 'none'
        ? searchCopyHere.count(0)
        : view.kind === 'loading'
          ? searchCopyHere.searching
          : view.kind === 'failed'
            ? searchCopyHere.failedStatus
            : '';
  const field = textMetrics({ size: 16, family: 'sans', lineHeight: 1.3 });

  return (
    <Screen>
      <BackBar
        label={route.params?.back ?? placeWords(rawLocale).chat}
        onPress={goBack}
        right={<PlacesButton current="search" here={searchCopyHere.title} />}
      />
      <ScrollView
        style={{ flex: 1, borderTopWidth: 1, borderTopColor: theme.colors.line }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 20,
          paddingBottom: 28 + bottomRoom,
          gap: 12,
        }}
      >
        <View style={{ gap: 6 }}>
          <Text size={28} weight={700} tracking={-0.02} accessibilityRole="header">
            {searchCopyHere.title}
          </Text>
          <Text size={15} lh={1.4} color={theme.colors.ink2}>
            {searchCopyHere.intro}
          </Text>
        </View>
        <View
          style={{
            minHeight: 52,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingLeft: 14,
            paddingRight: 4,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: theme.colors.line2,
            backgroundColor: theme.colors.sf,
          }}
        >
          <Search size={20} color={theme.colors.ink2} strokeWidth={1.75} />
          <TextInput
            ref={input}
            value={query}
            onChangeText={setQuery}
            autoFocus={!route.params?.q}
            placeholder={searchCopyHere.field}
            accessibilityLabel={searchCopyHere.field}
            placeholderTextColor={theme.colors.placeholder}
            selectionColor={theme.colors.brand}
            cursorColor={theme.colors.ink}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            style={{
              flex: 1,
              minHeight: SHELL_TARGET,
              paddingVertical: 10,
              color: theme.colors.ink,
              fontFamily: field.fontFamily,
              fontSize: field.fontSize,
              includeFontPadding: false,
            }}
          />
          {query ? (
            <Touchable
              onPress={() => {
                setQuery('');
                input.current?.focus();
              }}
              feedback="wash"
              ringRadius={SHELL_TARGET / 2}
              accessibilityRole="button"
              accessibilityLabel={searchCopyHere.clear}
              style={{
                width: SHELL_TARGET,
                height: SHELL_TARGET,
                borderRadius: SHELL_TARGET / 2,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <X size={18} color={theme.colors.ink2} strokeWidth={1.75} />
            </Touchable>
          ) : null}
        </View>
        <Text size={13} color={theme.colors.mut} accessibilityLiveRegion="polite">
          {status}
        </Text>
        {view.kind === 'empty' ? (
          <StateCard
            icon
            title={searchCopyHere.emptyTitle}
            body={searchCopyHere.emptyBody}
            actions={searchSuggestions(entries, rawLocale).map((word) => (
              <SmallButton key={word} label={word} onPress={() => setQuery(word)} />
            ))}
          />
        ) : view.kind === 'loading' ? (
          <View accessibilityState={{ busy: true }} style={{ gap: 12 }}>
            <StateCard title={searchCopyHere.looking(view.query)} />
            <Skeleton height={64} radius={14} />
            <Skeleton height={64} radius={14} width="70%" />
          </View>
        ) : view.kind === 'failed' ? (
          <StateCard
            title={searchCopyHere.failedTitle}
            body={searchCopyHere.failedBody}
            actions={[<SmallButton key="retry" label={searchCopyHere.retry} onPress={retry} />]}
          />
        ) : view.kind === 'none' ? (
          <StateCard
            icon
            title={searchCopyHere.noneTitle(view.query)}
            body={searchCopyHere.noneBody}
            actions={[<SmallButton key="clear" label={searchCopyHere.clear} onPress={() => setQuery('')} />]}
          />
        ) : (
          view.groups.map((g) => (
            <View key={g.group} style={{ gap: 8, marginTop: 8 }}>
              <Text size={15} weight={600} accessibilityRole="header">
                {g.title}
              </Text>
              <View
                style={{
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: theme.colors.line,
                  backgroundColor: theme.colors.sf,
                  overflow: 'hidden',
                }}
              >
                {g.rows.map((row, i) => (
                  <ResultRow key={row.key} entry={row} first={i === 0} onPress={() => open(row)} />
                ))}
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}

/** A result, the whole row a button: its icon or logo, its name over its line, a chevron. */
function ResultRow({ entry, first, onPress }: { entry: SearchEntry; first: boolean; onPress: () => void }) {
  const theme = useTheme();
  const Icon =
    entry.group === 'chats'
      ? PLACE_ICONS.chat
      : entry.group === 'settings' && entry.icon
        ? SETTING_ICONS[entry.icon]
        : entry.open.kind === 'place'
          ? PLACE_ICONS[entry.open.place]
          : null;
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={0}
      accessibilityRole="button"
      accessibilityLabel={`${entry.title}, ${entry.line}`}
      style={{
        minHeight: Math.max(60, SHELL_TARGET),
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        paddingVertical: 12,
        paddingLeft: 16,
        paddingRight: 12,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View style={{ width: 22, alignItems: 'center' }}>
        {entry.glyph ? (
          <ThingIcon glyph={entry.glyph} mark={entry.mark} size={20} color={theme.colors.ink2} />
        ) : Icon ? (
          <Icon size={20} color={theme.colors.ink2} strokeWidth={1.75} />
        ) : null}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text size={16} weight={600} lh={1.3}>
          {entry.title}
        </Text>
        {entry.line ? (
          <Text size={13} lh={1.35} color={theme.colors.mut}>
            {entry.line}
          </Text>
        ) : null}
      </View>
      <ChevronRight size={16} color={theme.colors.mut} strokeWidth={1.75} />
    </Touchable>
  );
}

/** The card of a state with no results: the magnifier, a title, a line and its buttons. */
function StateCard({
  title,
  body,
  icon = false,
  actions,
}: {
  title: string;
  body?: string;
  icon?: boolean;
  actions?: ReactNode[];
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        marginTop: 12,
        padding: 22,
        gap: 10,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
      }}
    >
      {icon ? <Search size={28} color={theme.colors.ink2} strokeWidth={1.5} /> : null}
      <Text size={20} weight={700} lh={1.25} accessibilityRole="header">
        {title}
      </Text>
      {body ? (
        <Text size={15} lh={1.45} color={theme.colors.ink2}>
          {body}
        </Text>
      ) : null}
      {actions?.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>{actions}</View>
      ) : null}
    </View>
  );
}

/** A small outlined button (a suggestion, Try again, Clear search), as tall as a target. */
function SmallButton({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={10}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        minHeight: SHELL_TARGET,
        paddingHorizontal: 14,
        justifyContent: 'center',
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.bg,
      }}
    >
      <Text size={14} color={theme.colors.ink}>
        {label}
      </Text>
    </Touchable>
  );
}
