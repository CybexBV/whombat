/**
 * The root stack, in every shape of the window (docs/app/decisions/iphone-duo.md). It is React Navigation's native
 * stack — the same routes, the same state — drawn three ways:
 *
 * - a phone: the stack as it always was, the tabs along the bottom;
 * - tabs down the side (the iPhone Duo closed, a medium window): the same stack beside a `SideBar`;
 * - two pages (the Duo open, an unfolded Android foldable): the tabs, the stack's first route, as the list on the left,
 *   and the routes above it as a stack of their own on the right, the wider one. The person drags the line between them;
 *   the phone keeps where it was left.
 *
 * Because the state is one stack throughout, folding and unfolding keep the place: a thread open on the closed phone
 * shows beside Chat when it opens, and on top of Chat again when it closes. `splitRouter` decides what opening
 * something does with two pages; `EmptyPage` is the right page while nothing is open there (beside Chat a new chat,
 * which the list's New chat brings back, `RestingPageContext`). The person can hide the list so the right page takes
 * the whole width (`ListToggleContext`), beside Chat always and beside the other tabs while something is open there;
 * the side bar stays.
 */
import {
  CommonActions,
  createNavigatorFactory,
  type NavigationState,
  type ParamListBase,
  type PartialState,
  type StackActionHelpers,
  StackActions,
  type StackNavigationState,
  StackRouter,
  type StackRouterOptions,
  useNavigationBuilder,
} from '@react-navigation/native';
import {
  type createNativeStackNavigator,
  type NativeStackNavigationEventMap,
  type NativeStackNavigationOptions,
  type NativeStackNavigatorProps,
  NativeStackView,
} from '@react-navigation/native-stack';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { I18nManager, Keyboard, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { type SharedValue, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { listHiding, parseFullWidthTabs, withFullWidth, writeFullWidthTabs } from '../data/fullWidth';
import { dividerAt, listWidthFor, parseShare, type ScreenShape, shareOf } from '../data/screenShape';
import { HOME_TAB, type Tab } from '../data/shell';
import { STORAGE_KEYS } from '../lib/kv';
import { secureStore } from '../lib/storage';
import { useTheme } from '../theme/theme';
import { PageSideContext, pageLine, useScreenShape, useSideBarHere } from '../ui/screenShape';
import { EmptyPage } from './EmptyPage';
import {
  BesideContext,
  ComposerLineContext,
  type HeaderLine,
  HeaderLineContext,
  LastTabContext,
  ListToggleContext,
  type PaneRole,
  PaneRoleContext,
  type RestingPage,
  RestingPageContext,
} from './panes';
import { LIST_ROUTE, splitRouter } from './splitRouter';
import { SideBar } from './TabBar';

type State = StackNavigationState<ParamListBase>;
type Helpers = Parameters<typeof NativeStackView>[0]['navigation'];
type Descriptors = Parameters<typeof NativeStackView>[0]['descriptors'];
type Describe = Parameters<typeof NativeStackView>[0]['describe'];

/** The tab the tabs' own state shows; undefined while they have none (not mounted yet, or mounting anew). */
function stateTab(list: State['routes'][number] | undefined): Tab | undefined {
  const nested = list?.state as NavigationState | PartialState<NavigationState> | undefined;
  return nested?.routes[nested.index ?? 0]?.name as Tab | undefined;
}

/**
 * The tab the list shows: the tabs' own state once they have one, else the one they showed last (while they mount
 * anew, AP-6340), else the tab their route asks for.
 */
function activeTab(list: State['routes'][number] | undefined, last: Tab | null): Tab {
  const fromParams = (list?.params as { screen?: string } | undefined)?.screen;
  return ((stateTab(list) ?? last ?? fromParams ?? HOME_TAB) as Tab) || HOME_TAB;
}

function SplitStackNavigator({
  id,
  initialRouteName,
  UNSTABLE_routeNamesChangeBehavior,
  children,
  layout,
  screenListeners,
  screenOptions,
  screenLayout,
  UNSTABLE_router,
  ...rest
}: NativeStackNavigatorProps) {
  const shape = useScreenShape();
  const [share, keepShare] = usePageShare();
  const [fullWidth, keepFullWidth] = useChatFullWidth();
  const [fullTabs, keepFullTabs] = useFullWidthTabs();
  const two = useRef(false);
  two.current = shape.pages === 2;
  // The router is made once; it reads whether there are two pages at the time of each action.
  const [router] = useState(
    () => (original: Parameters<NonNullable<NativeStackNavigatorProps['UNSTABLE_router']>>[0]) => ({
      ...UNSTABLE_router?.(original),
      ...splitRouter(original, () => two.current),
    }),
  );
  const { state, describe, descriptors, navigation, render } = useNavigationBuilder<
    State,
    StackRouterOptions,
    StackActionHelpers<ParamListBase>,
    NativeStackNavigationOptions,
    NativeStackNavigationEventMap
  >(StackRouter, {
    id,
    initialRouteName,
    UNSTABLE_routeNamesChangeBehavior,
    children,
    layout,
    screenListeners,
    screenOptions,
    screenLayout,
    UNSTABLE_router: router as NativeStackNavigatorProps['UNSTABLE_router'],
  });
  const side = shape.tabs !== 'bottom';
  useSideBarHere(side);
  const list = state.routes[0];
  // The tab the list showed last outlives the tabs themselves: one page to two or back mounts them anew.
  const lastTab = useRef<Tab | null>(null);
  const shown = stateTab(list);
  if (shown) lastTab.current = shown;
  const tab = activeTab(list, lastTab.current);
  const select = (next: Tab) => {
    // A box left with the cursor in it would get it back when its tab shows again (the native screen restores what
    // had focus), raising the keyboard nobody asked for: the keyboard goes with the tab.
    Keyboard.dismiss();
    navigation.dispatch(CommonActions.navigate({ name: LIST_ROUTE, params: { screen: next }, pop: true }));
  };
  const stack = (
    <NativeStackView
      {...rest}
      state={state}
      navigation={navigation}
      descriptors={descriptors}
      describe={describe}
    />
  );
  const body =
    shape.pages === 2 && list?.name === LIST_ROUTE ? (
      // Until the phone says where the line was left and which lists were hidden, the pages wait (a moment at launch)
      // instead of drawing at the default width and jumping.
      share === undefined || fullWidth === undefined || fullTabs === undefined ? null : (
        <TwoPages
          shape={shape}
          share={share}
          onShare={keepShare}
          fullWidth={fullWidth}
          onFullWidth={keepFullWidth}
          fullTabs={fullTabs}
          onFullTabs={keepFullTabs}
          state={state}
          navigation={navigation}
          descriptors={descriptors}
          describe={describe}
          tab={tab}
        />
      )
    ) : (
      stack
    );
  const bar = side ? <SideBar shape={shape} active={tab} onSelect={select} /> : null;
  return render(
    <LastTabContext.Provider value={lastTab}>
      <Frame shape={shape} bar={bar} body={body} />
    </LastTabContext.Provider>,
  );
}

/**
 * The bar and the content side by side. The content has its own safe area, measured inside the frame, so a screen no
 * longer counts the edge the side bar covers.
 */
function Frame({ shape, bar, body }: { shape: ScreenShape; bar: ReactNode; body: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: theme.colors.bg }}>
      {shape.tabs === 'left' ? bar : null}
      <SafeAreaProvider style={{ flex: 1 }}>{body}</SafeAreaProvider>
      {shape.tabs === 'right' ? bar : null}
    </View>
  );
}

/**
 * A setting of the pages kept on the phone: undefined until the phone has said, then what it kept (`parse(null)` when
 * nothing). Read as the app starts, so it is usually there before the pages are drawn.
 */
function keptSetting<T>(
  key: string,
  parse: (raw: string | null) => T,
  write: (value: T) => string,
): () => [T | undefined, (next: T) => void] {
  let kept: T | undefined;
  const read: Promise<void> = secureStore.get(key).then(
    (raw) => {
      kept = parse(raw);
    },
    () => {
      kept = parse(null);
    },
  );
  return function useKeptSetting() {
    const [value, setValue] = useState<T | undefined>(kept);
    useEffect(() => {
      if (value !== undefined) return;
      let alive = true;
      void read.then(() => {
        if (alive) setValue(kept);
      });
      return () => {
        alive = false;
      };
    }, [value]);
    const keep = useCallback((next: T) => {
      kept = next;
      setValue(next);
      void secureStore.set(key, write(next)).catch(() => {});
    }, []);
    return [value, keep];
  };
}

/** Where the person left the line between the pages, as a share of the window; null when they never moved it. */
const usePageShare = keptSetting<number | null>(STORAGE_KEYS.pageSplit, parseShare, String);

/** Whether the person hid Chat's list, so what is beside it takes the whole width. */
const useChatFullWidth = keptSetting<boolean>(
  STORAGE_KEYS.chatFullWidth,
  (raw) => raw === '1',
  (on) => (on ? '1' : '0'),
);

/** The other tabs whose list the person hid, so what is open beside it takes the whole width. */
const useFullWidthTabs = keptSetting<ReadonlySet<Tab>>(
  STORAGE_KEYS.fullWidthTabs,
  parseFullWidthTabs,
  writeFullWidthTabs,
);

/** The headers' line across both pages: the tallest header's height, as they report it. */
function useHeaderLine(): HeaderLine {
  const heights = useRef(new Map<string, number>());
  const [height, setHeight] = useState(0);
  const report = useCallback((id: string, h: number | null) => {
    if (h === null) heights.current.delete(id);
    else heights.current.set(id, h);
    const tallest = Math.max(0, ...heights.current.values());
    setHeight((old) => (old === tallest ? old : tallest));
  }, []);
  return useMemo(() => ({ height, report }), [height, report]);
}

function TwoPages({
  shape,
  share,
  onShare,
  fullWidth,
  onFullWidth,
  fullTabs,
  onFullTabs,
  state,
  navigation,
  descriptors,
  describe,
  tab,
}: {
  shape: ScreenShape;
  share: number | null;
  onShare: (share: number) => void;
  fullWidth: boolean;
  onFullWidth: (on: boolean) => void;
  fullTabs: ReadonlySet<Tab>;
  onFullTabs: (tabs: ReadonlySet<Tab>) => void;
  state: State;
  navigation: Helpers;
  descriptors: Descriptors;
  describe: Describe;
  tab: Tab;
}) {
  const theme = useTheme();
  const headerLine = useHeaderLine();
  const composerLine = useHeaderLine();
  const listWidth = listWidthFor(shape, share);
  // The list hidden: it stays mounted (where it was scrolled, what was typed) but takes no room, and the right page has
  // the whole width. Chat's whenever the person hid it; another tab's only while something is open beside it, since
  // its right page shows nothing without the list.
  const chat = tab === 'ChatRoom';
  const kept = chat ? fullWidth : fullTabs.has(tab);
  const open = state.routes.length > 1;
  const { hidden: hideList, offered } = listHiding({ chat, kept, open });
  // A drag moves the line through this value on the UI thread without drawing the pages again; the window and the
  // kept share set it before the frame is drawn.
  const width = useSharedValue(listWidth);
  useLayoutEffect(() => {
    width.value = listWidth;
    pageLine.set(hideList ? 0 : listWidth);
  }, [width, listWidth, hideList]);
  useEffect(() => () => pageLine.set(null), []);
  const listStyle = useAnimatedStyle(() => ({ width: width.value }));
  const moved = useCallback((at: number) => onShare(shareOf(shape, at)), [onShare, shape]);
  const pan = useDividerPan(shape, width, moved, !hideList);
  const listToggle = useMemo(
    () =>
      offered
        ? {
            hidden: hideList,
            chat,
            toggle: () => (chat ? onFullWidth(!fullWidth) : onFullTabs(withFullWidth(fullTabs, tab, !kept))),
          }
        : null,
    [offered, hideList, chat, fullWidth, onFullWidth, fullTabs, onFullTabs, tab, kept],
  );
  const list = state.routes[0];
  const besideState = useMemo<State | null>(
    () =>
      state.routes.length > 1
        ? { ...state, routes: state.routes.slice(1), index: Math.max(0, state.index - 1) }
        : null,
    [state],
  );
  // The right page's first screen closes instead of going back; the ones on top of it go back.
  const besideDescriptors = useMemo(() => {
    const out: Descriptors = { ...descriptors };
    besideState?.routes.forEach((route, i) => {
      const d = descriptors[route.key];
      if (!d) return;
      const role: PaneRole = i === 0 ? 'beside-first' : 'beside';
      out[route.key] = {
        ...d,
        render: () => <PaneRoleContext.Provider value={role}>{d.render()}</PaneRoleContext.Provider>,
      };
    });
    return out;
  }, [descriptors, besideState]);
  const first = besideState?.routes[0];
  const besideRoute = useMemo(() => (first ? { name: first.name, params: first.params } : null), [first]);
  const resting = useRestingPage(besideState !== null, navigation);
  if (!list) return null;
  return (
    <BesideContext.Provider value={besideRoute}>
      <RestingPageContext.Provider value={resting}>
        <HeaderLineContext.Provider value={headerLine}>
          <ComposerLineContext.Provider value={composerLine}>
            <ListToggleContext.Provider value={listToggle}>
              <GestureDetector gesture={pan.gesture}>
                <View style={{ flex: 1, flexDirection: 'row' }}>
                  <Reanimated.View
                    style={[listStyle, hideList ? { display: 'none' } : null]}
                    accessibilityElementsHidden={hideList}
                    importantForAccessibility={hideList ? 'no-hide-descendants' : 'auto'}
                  >
                    <PageSideContext.Provider value="list">
                      <PaneRoleContext.Provider value="list">
                        {descriptors[list.key]?.render()}
                      </PaneRoleContext.Provider>
                    </PageSideContext.Provider>
                  </Reanimated.View>
                  {hideList ? null : (
                    <Divider
                      shape={shape}
                      at={listWidth}
                      dragging={pan.dragging}
                      onMoved={moved}
                      color={theme.colors.line2}
                      grip={theme.colors.mut}
                    />
                  )}
                  <View style={{ flex: 1 }}>
                    <PageSideContext.Provider value="beside">
                      {besideState ? (
                        <NativeStackView
                          state={besideState}
                          navigation={navigation}
                          descriptors={besideDescriptors}
                          describe={describe}
                        />
                      ) : (
                        <EmptyPage tab={tab} />
                      )}
                    </PageSideContext.Provider>
                  </View>
                </View>
              </GestureDetector>
            </ListToggleContext.Provider>
          </ComposerLineContext.Provider>
        </HeaderLineContext.Provider>
      </RestingPageContext.Provider>
    </BesideContext.Provider>
  );
}

/**
 * The right page's own page and the list's way back to it: `show` closes whatever the right page shows (the stack goes
 * back to the list alone) and wakes the page that comes, until it says it woke.
 */
function useRestingPage(open: boolean, navigation: Helpers): RestingPage {
  const [waking, setWaking] = useState(false);
  const opened = useRef(open);
  opened.current = open;
  return useMemo(
    () => ({
      waking,
      show: () => {
        if (opened.current) navigation.dispatch(StackActions.popToTop());
        setWaking(true);
      },
      woke: () => setWaking(false),
    }),
    [waking, navigation],
  );
}

/** How near the line a sideways drag may start to move it: half of this over each page's margin. */
const DIVIDER_TOUCH = 24;

/** How far one swipe of a screen reader's adjust gesture moves the line. */
const DIVIDER_STEP = 32;

/**
 * Dragging the line between the pages: a pan over both pages that only starts when the finger goes down near the line
 * and then moves sideways, so taps, vertical scrolls and swipes beside it stay the pages'. It moves the list's width
 * on the UI thread, stops where either page would be narrower than a phone, snaps onto the crease near it, and says
 * where it was left (`onMoved`). Off while Chat's list is hidden: there is no line then.
 */
function useDividerPan(
  shape: ScreenShape,
  width: SharedValue<number>,
  onMoved: (at: number) => void,
  enabled: boolean,
): { gesture: ReturnType<typeof Gesture.Pan>; dragging: SharedValue<boolean> } {
  const dragging = useSharedValue(false);
  const from = useSharedValue(0);
  const rtl = I18nManager.isRTL;
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .activeOffsetX([-8, 8])
        .failOffsetY([-10, 10])
        .onTouchesDown((e, manager) => {
          const touch = e.allTouches[0];
          if (!touch || Math.abs(touch.x - width.value) > DIVIDER_TOUCH / 2) manager.fail();
        })
        .onStart(() => {
          from.value = width.value;
          dragging.value = true;
        })
        .onUpdate((e) => {
          width.value = dividerAt(shape, from.value + (rtl ? -e.translationX : e.translationX));
        })
        .onFinalize((_e, success) => {
          if (!dragging.value) return;
          dragging.value = false;
          if (success && width.value !== from.value) scheduleOnRN(onMoved, width.value);
          else width.value = from.value;
        }),
    [shape, width, onMoved, dragging, from, enabled],
  );
  return { gesture, dragging };
}

/**
 * The line between the pages, with a grip in its middle; the pan that moves it is the pages' own (`useDividerPan`), so
 * the line takes no touches from what is under it. Screen readers adjust it as a slider.
 */
function Divider({
  shape,
  at,
  dragging,
  onMoved,
  color,
  grip,
}: {
  shape: ScreenShape;
  at: number;
  dragging: SharedValue<boolean>;
  onMoved: (at: number) => void;
  color: string;
  grip: string;
}) {
  const contentWidth = shape.content.right - shape.content.left;
  const percent = Math.round((at / contentWidth) * 100);
  const step = (by: number) => {
    const next = dividerAt(shape, at + by);
    if (next !== at) onMoved(next);
  };
  const tint = useAnimatedStyle(() => ({ backgroundColor: dragging.value ? grip : color }));
  return (
    <View
      pointerEvents="box-none"
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Page widths"
      accessibilityValue={{ text: `Left page ${percent}%`, min: 0, max: 100, now: percent }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) =>
        step(e.nativeEvent.actionName === 'increment' ? DIVIDER_STEP : -DIVIDER_STEP)
      }
      style={{
        width: DIVIDER_TOUCH,
        marginHorizontal: -DIVIDER_TOUCH / 2,
        zIndex: 1,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Reanimated.View
        pointerEvents="none"
        style={[
          {
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: (DIVIDER_TOUCH - StyleSheet.hairlineWidth) / 2,
            width: StyleSheet.hairlineWidth,
          },
          tint,
        ]}
      />
      <Reanimated.View pointerEvents="none" style={[{ width: 4, height: 36, borderRadius: 2 }, tint]} />
    </View>
  );
}

/** A native stack whose routes show as one page or two, by the window's shape. */
export function createSplitStackNavigator<ParamList extends ParamListBase>(): ReturnType<
  typeof createNativeStackNavigator<ParamList>
> {
  return createNavigatorFactory(SplitStackNavigator)() as unknown as ReturnType<
    typeof createNativeStackNavigator<ParamList>
  >;
}
