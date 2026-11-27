/**
 * The tabs as iOS's own tab bar on an iPhone (docs/app/decisions/native-feel.md): UIKit's tab bar controller
 * through react-native-screens' `Tabs`, the Liquid Glass bar on iOS 26 and later, as T3 Code's iPhone app has it. The
 * same five tabs, words and badges as our bar (`TabBar.tsx`), SF Symbols for its icons (`systemTabs.ts`).
 *
 * It is a navigator of React Navigation's tab router, so the state, the links into the app and the place kept across a
 * killed process are the same as with our bar: only the drawing is iOS's. iOS picks the tab when it is tapped and says
 * so (`onTabSelected`); a tab opened from the app (a link, a push, Places) goes to iOS as a request, with the
 * last selection iOS confirmed so a request older than a tap is turned down (`navStateRequest`, `provenance`).
 *
 * Each tab's screen runs to the bottom of the window, under the glass; `GlassBarRoomContext` says how much of it the bar
 * covers, measured in the tab (`SafeAreaListener`), so lists scroll on under it and Chat's reply box sits on it.
 */
import type { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import {
  CommonActions,
  createNavigatorFactory,
  type DefaultNavigatorOptions,
  type EventMapBase,
  type ParamListBase,
  type TabActionHelpers,
  type TabNavigationState,
  TabRouter,
  type TabRouterOptions,
  useNavigationBuilder,
} from '@react-navigation/native';
import { type ReactNode, useMemo, useState } from 'react';
import { type NativeSyntheticEvent, processColor } from 'react-native';
import { SafeAreaListener, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  type TabSelectedEvent,
  type TabSelectionRejectedEvent,
  Tabs,
  type TabsScreenAppearanceIOS,
  type TabsScreenItemStateAppearanceIOS,
} from 'react-native-screens';
import { type Tab, tabWords } from '../data/shell';
import { useI18n } from '../i18n';
import { useTheme } from '../theme/theme';
import { GlassBarRoomContext } from './panes';
import { systemBadgeValue, systemTabLabel, TAB_SYMBOLS } from './systemTabs';
import { useBadges } from './TabBar';

type State = TabNavigationState<ParamListBase>;

type Props = DefaultNavigatorOptions<
  ParamListBase,
  string | undefined,
  State,
  object,
  EventMapBase,
  unknown
> &
  TabRouterOptions;

/** The bar's room as last measured: a tab drawn later starts with it instead of the home indicator's alone. */
let keptRoom: number | null = null;

/** A tab's screen, told how much of its bottom the bar covers. */
function BarRoom({ children }: { children: ReactNode }) {
  const outer = useSafeAreaInsets();
  const [room, setRoom] = useState(() => keptRoom ?? outer.bottom);
  return (
    <SafeAreaListener
      onChange={({ insets }) => {
        keptRoom = insets.bottom;
        setRoom(insets.bottom);
      }}
    >
      <GlassBarRoomContext.Provider value={room}>{children}</GlassBarRoomContext.Provider>
    </SafeAreaListener>
  );
}

function GlassTabNavigator({
  id,
  initialRouteName,
  backBehavior,
  children,
  layout,
  screenListeners,
  screenOptions,
  screenLayout,
  UNSTABLE_router,
  UNSTABLE_routeNamesChangeBehavior,
}: Props) {
  const { state, navigation, descriptors, NavigationContent } = useNavigationBuilder<
    State,
    TabRouterOptions,
    TabActionHelpers<ParamListBase>,
    object,
    EventMapBase
  >(TabRouter, {
    id,
    initialRouteName,
    backBehavior,
    children,
    layout,
    screenListeners,
    screenOptions,
    screenLayout,
    UNSTABLE_router,
    UNSTABLE_routeNamesChangeBehavior,
  });
  const focused = state.routes[state.index]?.key ?? '';
  // A tab draws its screen once it has shown, and keeps it (as our bar: Chat alone at the start).
  const [shown, setShown] = useState<readonly string[]>(() => [focused]);
  if (!shown.includes(focused)) setShown([...shown, focused]);
  const scenes = state.routes.map((route) =>
    shown.includes(route.key) ? <BarRoom key={route.key}>{descriptors[route.key]?.render()}</BarRoom> : null,
  );
  const follow = (key: string) => {
    const route = state.routes.find((r) => r.key === key);
    if (route && key !== focused)
      navigation.dispatch({ ...CommonActions.navigate(route.name, route.params), target: state.key });
  };
  return (
    <NavigationContent>
      <GlassBar routes={state.routes} focused={focused} scenes={scenes} follow={follow} />
    </NavigationContent>
  );
}

/**
 * iOS's bar over the tabs' screens. The badges and iOS's selection change here alone, so a new count doesn't draw the
 * screens again: they come in drawn (`scenes`).
 */
function GlassBar({
  routes,
  focused,
  scenes,
  follow,
}: {
  routes: State['routes'];
  focused: string;
  scenes: readonly ReactNode[];
  follow: (key: string) => void;
}) {
  const theme = useTheme();
  const badges = useBadges();
  const { rawLocale } = useI18n();
  const labels = tabWords(rawLocale);
  const appearance = useMemo(() => badgeAppearance(theme.colors.btn, theme.colors.btnfg), [theme]);
  // The last selection iOS confirmed; a request from the app is based on it.
  const [provenance, setProvenance] = useState(0);
  const onSelected = ({ nativeEvent }: NativeSyntheticEvent<TabSelectedEvent>) => {
    setProvenance(nativeEvent.provenance);
    if (nativeEvent.actionOrigin !== 'programmatic-js') follow(nativeEvent.selectedScreenKey);
  };
  // iOS turned a request down (a tap came first): the app follows iOS.
  const onRejected = ({ nativeEvent }: NativeSyntheticEvent<TabSelectionRejectedEvent>) => {
    setProvenance(nativeEvent.provenance);
    follow(nativeEvent.selectedScreenKey);
  };
  return (
    <Tabs.Host
      navStateRequest={{ selectedScreenKey: focused, baseProvenance: provenance }}
      rejectStaleNavStateUpdates
      onTabSelected={onSelected}
      onTabSelectionRejected={onRejected}
      colorScheme={theme.dark ? 'dark' : 'light'}
      nativeContainerStyle={{ backgroundColor: theme.colors.bg }}
      ios={{
        tabBarControllerMode: 'tabBar',
        // Five named tabs stay readable: the bar doesn't shrink while a list scrolls.
        tabBarMinimizeBehavior: 'never',
        tabBarTintColor: theme.colors.brand,
      }}
    >
      {routes.map((route, i) => {
        const name = route.name as Tab;
        const badge = badges[name];
        return (
          <Tabs.Screen
            key={route.key}
            screenKey={route.key}
            title={labels[name]}
            badgeValue={systemBadgeValue(badge)}
            tabBarItemAccessibilityLabel={systemTabLabel(labels[name], badge, rawLocale)}
            nativeContainerStyle={{ backgroundColor: theme.colors.bg }}
            // Tapping the open tab again does nothing, as with our bar: Chat would jump to its first message.
            specialEffects={{ repeatedTabSelection: { popToRoot: false, scrollToTop: false } }}
            ios={{
              icon: { type: 'sfSymbol', name: TAB_SYMBOLS[name] },
              standardAppearance: appearance,
              scrollEdgeAppearance: appearance,
              // Each screen keeps its own top inset; only the bottom is the bar's (`BarRoom`).
              overrideScrollViewContentInsetAdjustmentBehavior: false,
            }}
          >
            {scenes[i]}
          </Tabs.Screen>
        );
      })}
    </Tabs.Host>
  );
}

/**
 * The badges in the tokens' colours, readable in both themes (phone-shell-final.md): the unread pill's `btnfg` on `btn`
 * (dark on light in dark mode), not iOS's red with white words. UIKit draws every badge in the look of the selected
 * tab, so each tab carries the same one; what a count means is in the tab's name for VoiceOver. The words' colour goes
 * through our patch of react-native-screens (`tabBarItemBadgeTextColor`), already converted, as it passes it on as is.
 */
function badgeAppearance(fill: string, text: string): TabsScreenAppearanceIOS {
  const state = {
    tabBarItemBadgeBackgroundColor: fill,
    tabBarItemBadgeTextColor: processColor(text),
  } as TabsScreenItemStateAppearanceIOS;
  const item = { normal: state, selected: state };
  return { stacked: item, inline: item, compactInline: item };
}

/**
 * A tab navigator drawn as iOS's own tab bar; only for iOS (`tabBarKind`). Typed as our bar's navigator, so both take
 * the same screens; the options of our bar it leaves alone.
 */
export function createGlassTabNavigator<ParamList extends ParamListBase>(): ReturnType<
  typeof createBottomTabNavigator<ParamList>
> {
  return createNavigatorFactory(GlassTabNavigator)() as unknown as ReturnType<
    typeof createBottomTabNavigator<ParamList>
  >;
}
