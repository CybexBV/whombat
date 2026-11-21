/**
 * Our tabs: along the bottom on an Android phone, or down the side (`SideBar`) where the system keeps its own vertical
 * bar (the iPhone Duo) and on wide windows (docs/app/decisions/iphone-duo.md). An iPhone has iOS's own tab bar instead
 * (`GlassTabs`, native-feel.md), with these badges.
 *
 * The bottom tab bar (mock 4; one-whombat-mobile.md AP-1350, AP-1375; chat-channel.md AP-2450, AP-2452;
 * connections-page.md AP-2550, AP-2552; one-layout-android.md AP-2640; needs-you-list.md NYL-05; automations-tab.md
 * AP-6310, AP-6311): **Chat · Inbox · Overview · Automations · Settings** (a speech bubble, an inbox, a grid, a lightning
 * bolt, a gear) on `bg`, 24dp icons over 11/500 words (600 on the open tab, `tabBarFit` on the narrowest phones); ink
 * when open, mut otherwise. Automations has no badge: what waits there counts on the Inbox.
 *
 * Badges: the Inbox counts what needs the viewer, the one count (the app icon follows it), Chat what is unread in Chat
 * and Feedback — an `ink` pill with a mono count; the Inbox's `warn`, `bad` only when something isn't working — ringed
 * in the bar's background so it reads over the icon. Settings has a dot in `warn`/`bad` when AI or This Whombat needs
 * the viewer, else in `ok` while a newer app is ready.
 */
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useQuery } from '@tanstack/react-query';
import { chatRoomsOf } from '@whombat/client';
import { useWhombat } from '@whombat/client/react';
import { api, type ChatsListResponse, type HomeOverview } from '@whombat/core';
import * as Notifications from 'expo-notifications';
import { useEffect, useMemo } from 'react';
import { Keyboard, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBurrowBase } from '../data/BurrowProvider';
import { chatTabCount } from '../data/chatRoom';
import { badgeText, tabBadgeLabel } from '../data/inbox';
import { needsYouTabBadge } from '../data/needsYou';
import type { ScreenShape } from '../data/screenShape';
import { TAB_WORDS } from '../data/shell';
import { SETTINGS_TEXT } from '../settings/list';
import { useSettingsTabDot } from '../settings/useSettingsFacts';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import {
  Inbox,
  LayoutGrid,
  type LucideIcon,
  MessageCircle,
  Settings as SettingsIcon,
  Zap,
} from '../ui/icons';
import { tabBarBottomPadding } from '../ui/insets';
import { useScreenShape } from '../ui/screenShape';
import { Touchable } from '../ui/Touchable';
import type { TabParamList } from './routes';
import type { TabBadge } from './systemTabs';
import { tabBarFit } from './tabBarFit';

type TabSpec = { name: keyof TabParamList; label: string; icon: LucideIcon };

/** The bar's tabs (`data/shell.ts` `TABS`), with their icons. */
const TAB_SPECS: readonly TabSpec[] = [
  { name: 'ChatRoom', label: TAB_WORDS.ChatRoom, icon: MessageCircle },
  { name: 'NeedsYou', label: TAB_WORDS.NeedsYou, icon: Inbox },
  { name: 'Dashboard', label: TAB_WORDS.Dashboard, icon: LayoutGrid },
  { name: 'Automations', label: TAB_WORDS.Automations, icon: Zap },
  { name: 'Settings', label: TAB_WORDS.Settings, icon: SettingsIcon },
];

/** What the Needs you badge needs of Home's overview: the bar draws again only when it changes. */
const needsYouBadgeOf = (overview: HomeOverview) => needsYouTabBadge(overview);
/** What the Chat badge needs of the chats list. */
const chatCountOf = (list: ChatsListResponse) => chatTabCount(chatRoomsOf(list.chats));

/**
 * The badges: the same reads as Needs you and Chat (one fetch each, live by `home.changed` and the rooms' messages); iOS's
 * own bar shows them too (`GlassTabs`). Only the counts are taken from them, so a refetch that changes something else
 * in Home doesn't draw the bar again, and the same object comes back until a badge changes. They stay live while a page
 * covers the tabs (TanStack Query's own hook, not a screen's): the app icon's count follows Needs you.
 */
export function useBadges(): Partial<Record<keyof TabParamList, TabBadge>> {
  const { slug } = useBurrowBase();
  const { queries } = useWhombat();
  const params = { params: { burrow: slug } };
  const needs =
    useQuery({ ...queries.endpoint(api.home.overview, params), retry: false, select: needsYouBadgeOf })
      .data ?? NO_NEEDS;
  const chatCount =
    useQuery({ ...queries.endpoint(api.chats.list, params), retry: false, select: chatCountOf }).data ?? 0;
  // The one count (needs-you-list.md NYL-04): amber, red only when something that needs the person isn't working.
  const needsYou = needs.count;
  useEffect(() => {
    Notifications.setBadgeCountAsync(needsYou).catch(() => {});
  }, [needsYou]);
  const settings = useSettingsTabDot();
  const tone = needs.tone;
  return useMemo(
    () => ({
      NeedsYou: {
        count: needsYou,
        dot: false,
        ...(tone === 'bad' || tone === 'warn' ? { tone } : {}),
      },
      ChatRoom: { count: chatCount, dot: false },
      Settings: settings
        ? {
            count: 0,
            dot: true,
            tone: settings,
            spoken: settings === 'ok' ? SETTINGS_TEXT.updateReady : SETTINGS_TEXT.needsYou,
          }
        : { count: 0, dot: false },
    }),
    [needsYou, tone, chatCount, settings],
  );
}

const NO_NEEDS = needsYouTabBadge(undefined);

/**
 * The count (or dot) over a tab's icon, in the tokens' colours: Chat's unread `ink`, the Inbox's `warn`, `bad` only when
 * something isn't working; TalkBack hears it in the tab's label instead. iPhone's bar draws its badges in the unread pill's colours (`GlassTabs`).
 */
function Badge({ badge, under, left = 13 }: { badge: TabBadge | undefined; under: string; left?: number }) {
  const theme = useTheme();
  if (!badge || (badge.count === 0 && !badge.dot)) return null;
  const fill = badge?.tone ? theme.colors[badge.tone] : theme.colors.ink;
  const ring = { borderWidth: 2, borderColor: under, backgroundColor: fill };
  if (badge.count === 0)
    return (
      <View
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        style={{ position: 'absolute', top: -2, right: -5, width: 12, height: 12, borderRadius: 6, ...ring }}
      />
    );
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{
        position: 'absolute',
        top: -6,
        left,
        minWidth: 20,
        height: 20,
        paddingHorizontal: 5,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        ...ring,
      }}
    >
      <Text size={11} weight={500} mono color={theme.colors.btnfg}>
        {badgeText(badge.count)}
      </Text>
    </View>
  );
}

export function TabBar(props: BottomTabBarProps) {
  const shape = useScreenShape();
  // With the tabs down the side a tab's screen runs on to the window's bottom, under the home indicator, and pads
  // its own end (`useBottomRoom`), so nothing opaque cuts the list off there.
  return shape.tabs === 'bottom' ? <BottomBar {...props} /> : null;
}

function BottomBar(props: BottomTabBarProps) {
  return <Bar {...props} badges={useBadges()} />;
}

/**
 * The tabs down one side: in the strip under the clock on the iPhone Duo, where iOS keeps its own buttons, and on the
 * left of a wide window. The bottom bar's icons, badges and words, stacked in the middle of the space below the clock.
 */
export function SideBar({
  shape,
  active,
  onSelect,
}: {
  shape: ScreenShape;
  active: keyof TabParamList;
  onSelect: (tab: keyof TabParamList) => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const badges = useBadges();
  return (
    <View
      accessibilityRole="tablist"
      style={{
        width: shape.barWidth,
        paddingTop: shape.barTop + 8,
        paddingBottom: insets.bottom + 8,
        justifyContent: 'center',
        gap: 6,
        backgroundColor: theme.colors.bg,
        borderColor: theme.colors.line,
        ...(shape.tabs === 'right' ? { borderLeftWidth: 1 } : { borderRightWidth: 1 }),
      }}
    >
      {TAB_SPECS.map((tab) => {
        const selected = tab.name === active;
        const color = selected ? theme.colors.ink : theme.colors.mut;
        const Icon = tab.icon;
        const badge = badges[tab.name];
        return (
          <Touchable
            key={tab.name}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={
              badge?.dot && badge.spoken
                ? `${tab.label}, ${badge.spoken}`
                : tabBadgeLabel(tab.label, badge?.count ?? 0, badge?.dot)
            }
            feedback="fade"
            ringRadius={12}
            onPress={() => onSelect(tab.name)}
            style={{
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              minHeight: 60,
              paddingHorizontal: 2,
            }}
          >
            <View>
              <Icon size={24} color={color} strokeWidth={selected ? 2 : 1.7} />
              <Badge badge={badge} under={theme.colors.bg} left={17} />
            </View>
            {/* “Automations” has 72 points; larger text shrinks it to fit instead of cutting it off. */}
            <Text
              size={11}
              weight={selected ? 600 : 500}
              color={color}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
              maxFontSizeMultiplier={1.6}
            >
              {tab.label}
            </Text>
          </Touchable>
        );
      })}
    </View>
  );
}

function Bar({
  state,
  navigation,
  badges,
}: BottomTabBarProps & { badges: Partial<Record<keyof TabParamList, TabBadge>> }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const fit = tabBarFit(width, TAB_SPECS.length);
  const active = state.routes[state.index]?.name;
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        // The Connections mockup's bar (`.ptabs`: 9 10 14 on `bg`), clear of the system's area below (AP-2750).
        paddingTop: 9,
        paddingHorizontal: fit.margin,
        paddingBottom: tabBarBottomPadding(insets.bottom),
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
        backgroundColor: theme.colors.bg,
      }}
    >
      {TAB_SPECS.map((tab) => {
        const selected = tab.name === active;
        const color = selected ? theme.colors.ink : theme.colors.mut;
        const Icon = tab.icon;
        const route = state.routes.find((r) => r.name === tab.name);
        const badge = badges[tab.name];
        return (
          <Touchable
            key={tab.name}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={
              badge?.dot && badge.spoken
                ? `${tab.label}, ${badge.spoken}`
                : tabBadgeLabel(tab.label, badge?.count ?? 0, badge?.dot)
            }
            feedback="fade"
            ringRadius={12}
            onPress={() => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route?.key ?? '',
                canPreventDefault: true,
              });
              if (selected || event.defaultPrevented) return;
              // The box with the cursor would get it back when its tab shows again: the keyboard goes with the tab.
              Keyboard.dismiss();
              navigation.navigate(tab.name);
            }}
            // 48dp, Android's smallest target (phone-shell-final.md).
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 48 }}
          >
            <View>
              <Icon size={24} color={color} strokeWidth={selected ? 2 : 1.7} />
              <Badge badge={badge} under={theme.colors.bg} left={17} />
            </View>
            <Text
              size={fit.size}
              weight={selected ? 600 : 500}
              color={color}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
            >
              {tab.label}
            </Text>
          </Touchable>
        );
      })}
    </View>
  );
}
