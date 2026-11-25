/**
 * Navigation: a native stack over the tabs; the approval, DM, conversation and agent screens push full-screen
 * without the tab bar, as in the mock. On a wide window (the iPhone Duo open) the same stack shows as two pages, the
 * tabs on the left and what they opened on the right, and the tabs go down the side where the system keeps its own
 * bar (`SplitStack`, docs/app/decisions/iphone-duo.md). Along the bottom of an iPhone the bar is iOS's own (`GlassTabs`,
 * native-feel.md). The bar is Chat, Inbox, Overview, Automations and Settings on every Whombat (one-layout-android.md),
 * and the app opens on Chat at every cold start.
 *
 * Only Chat, where the app opens, is imported up front (AP-2644); every other screen's module is required the first
 * time it shows (`getComponent`, AP-932), so the navigator's first render doesn't load ~40 screens. `typeof import(…)`
 * keeps each component typed against its route.
 */
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import {
  DarkTheme,
  DefaultTheme,
  getStateFromPath as getStateFromPathDefault,
  type LinkingOptions,
  NavigationContainer,
  useLinkTo,
} from '@react-navigation/native';
import { leftOut } from '@whombat/client';
import { useHostsLive } from '@whombat/client/hosts/react';
import { type PushOpen, pushKindOf, pushTarget, resolvePushRef } from '@whombat/client/managed';
import { useMarkNotificationsRead, useWhombat } from '@whombat/client/react';
import type { LinkRef } from '@whombat/core';
import {
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { Linking, Platform, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { isShareUrl } from '../data/shareInbox';
import { HOME_TAB, INBOX_TAB, OVERVIEW_TITLE, TABS, type Tab as TabName } from '../data/shell';
import { ChatSettledBridge } from '../data/useThreadSettle';
import { noteRoute } from '../errors/nativeErrorNotes';
import { useBurrowSwitch, useManaged } from '../managed/context';
import { COPY } from '../managed/copy';
import { knownPushRefs } from '../push/knownRefs';
import { NotificationShadeBridge } from '../push/ShadeBridge';
import { initialNotificationUrl, onNotificationTap } from '../push/taps';
import { ChatRoomScreen } from '../screens/ChatRoomScreen';
import { HostTasksBridge } from '../screens/HostTasksBridge';
import { useTheme } from '../theme/theme';
import { TabRootContext } from '../ui/headers';
import { StartHold } from '../ui/StartHold';
import { useScreenShape } from '../ui/screenShape';
import { ToastHost } from '../ui/Toast';
import { ConnectReturnBridge } from './ConnectReturnBridge';
import { createGlassTabNavigator } from './GlassTabs';
import { APP_ORIGINS, navigationRef, openAppUrl } from './hooks';
import { PageBoundary } from './PageBoundary';
import { useLastTab } from './panes';
import {
  appScreenOfLink,
  appUrlForPath,
  burrowOfPath,
  LINKING_PREFIXES,
  LINKING_SCREENS,
  type OpenedNotification,
  type PushTap,
  parseNotificationUrl,
  parsePushTapUrl,
  pushTapFallback,
  type RootStackParamList,
  routeForLink,
  SCREEN_IDS,
  stripLinkedActionParams,
  type TabParamList,
} from './routes';
import { ScreenFocusLayout } from './ScreenFocus';
import { ShareIntentBridge } from './ShareIntentBridge';
import { createSplitStackNavigator } from './SplitStack';
import { tabBarKind } from './systemTabs';
import { TabBar } from './TabBar';
import { useNavigationPersistence } from './useNavigationPersistence';

const Stack = createSplitStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();
const GlassTab = createGlassTabNavigator<TabParamList>();

type LayoutNavigation = ComponentProps<typeof ScreenFocusLayout>['navigation'];

/**
 * A tab that fails to draw says so; the tab bar stays. Out of view its reads wait (`ScreenFocusLayout`).
 */
const tabLayout = ({
  children,
  navigation,
  route,
}: {
  children: ReactNode;
  navigation: LayoutNavigation;
  route: { key: string; name: string };
}) => (
  <ScreenFocusLayout kind="tab" navigation={navigation} routeKey={route.key}>
    {/* Each tab's top row has Places and Search beside its title (`TabTop`). */}
    <TabRootContext.Provider value={route.name as TabName}>
      <PageBoundary>{children}</PageBoundary>
    </TabRootContext.Provider>
  </ScreenFocusLayout>
);

/** A page that fails to draw says so, with Go back to the page under it. Under another page its reads wait. */
const pageLayout = ({
  children,
  navigation,
  route,
}: {
  children: ReactNode;
  navigation: LayoutNavigation & { canGoBack(): boolean; goBack(): void };
  route: { key: string };
}) => (
  <ScreenFocusLayout kind="page" navigation={navigation} routeKey={route.key}>
    <PageBoundary onBack={navigation.canGoBack() ? () => navigation.goBack() : undefined}>
      {children}
    </PageBoundary>
  </ScreenFocusLayout>
);

/** Every tab's screen, by name. `Dashboard` is Connections (`HomeScreen`, AP-2553): Things is folded into it. */
function tabScreens(): Record<TabName, ReactElement> {
  return {
    ChatRoom: <Tab.Screen key="ChatRoom" name="ChatRoom" component={ChatRoomScreen} />,
    Dashboard: (
      <Tab.Screen
        key="Dashboard"
        name="Dashboard"
        getComponent={() =>
          (require('../screens/HomeScreen') as typeof import('../screens/HomeScreen')).HomeScreen
        }
      />
    ),
    NeedsYou: (
      <Tab.Screen
        key="NeedsYou"
        name="NeedsYou"
        getComponent={() =>
          (require('../screens/NeedsYouScreen') as typeof import('../screens/NeedsYouScreen')).NeedsYouScreen
        }
      />
    ),
    Automations: (
      <Tab.Screen
        key="Automations"
        name="Automations"
        getComponent={() =>
          (require('../screens/AutomationsScreen') as typeof import('../screens/AutomationsScreen'))
            .AutomationsScreen
        }
      />
    ),
    Settings: (
      <Tab.Screen
        key="Settings"
        name="Settings"
        getComponent={() =>
          (require('../settings/SettingsScreen') as typeof import('../settings/SettingsScreen'))
            .SettingsScreen
        }
      />
    ),
  };
}

/**
 * Holds the burrow's `hosts` topic while the tabs show (Whombat ONE-DW30): an alert, a server asking to be added or the
 * service starting over read Needs you and Connections again. Those frames, `home.changed`, `widget.updated` and a task
 * chat's messages reach the cache through the shared appliers.
 */
function AssistantLive() {
  const { currentBootstrap } = useBurrowBase();
  useHostsLive(currentBootstrap().burrow.id);
  return null;
}

function Tabs() {
  const theme = useTheme();
  const screens = tabScreens();
  const lastTab = useLastTab();
  // Drawn anew when the window goes from one page to two or back, or to the other bar: on the tab it showed.
  const initialRouteName = (TABS as readonly string[]).includes(lastTab ?? '')
    ? (lastTab as TabName)
    : HOME_TAB;
  // On an iPhone the tabs are iOS's own tab bar (native-feel.md); down the side and on Android, ours.
  const system = tabBarKind(useScreenShape().tabs, Platform.OS) === 'system';
  return (
    <>
      <AssistantLive />
      {system ? (
        <GlassTab.Navigator key="system" initialRouteName={initialRouteName} screenLayout={tabLayout}>
          {TABS.map((name) => screens[name])}
        </GlassTab.Navigator>
      ) : (
        <Tab.Navigator
          key="ours"
          initialRouteName={initialRouteName}
          tabBar={(props) => <TabBar {...props} />}
          screenLayout={tabLayout}
          // A tab out of view doesn't re-render: it catches up when it shows again.
          screenOptions={{
            headerShown: false,
            sceneStyle: { backgroundColor: theme.colors.bg },
            freezeOnBlur: true,
          }}
        >
          {TABS.map((name) => screens[name])}
        </Tab.Navigator>
      )}
    </>
  );
}

/**
 * Deep links, plus tapped notifications: `whombat://open?path=…&notification=…` (Android's native
 * notifications, iOS taps via expo-notifications) opens the screen for the push's path and reports the
 * inbox row so it is marked read. A managed Whombat's content-free push (`whombat://push?kind=…&ref=…`, AP-29)
 * opens nothing here; the managed root resolves it through the session (`usePushTaps`). A screen a link opens has
 * the tabs beneath it (`initialRouteName`, MN-01): back goes to the inbox, not out of the app.
 */
function useLinking(onOpened: (opened: OpenedNotification) => void): LinkingOptions<RootStackParamList> {
  const opened = useRef(onOpened);
  opened.current = onOpened;
  return useMemo(() => {
    const resolve = (url: string | null): string | null => {
      // The iPhone's share extension opening the app: the share screen opens on its own (ShareIntentBridge).
      if (isShareUrl(url)) return null;
      // A managed push opens nothing here: `usePushTaps` asks the Whombat what it is about and opens that, so the
      // person goes straight to the chat or item instead of seeing the inbox first.
      if (parsePushTapUrl(url)) return null;
      const notification = parseNotificationUrl(url);
      if (!notification) return url;
      opened.current(notification);
      return notification.url;
    };
    return {
      prefixes: LINKING_PREFIXES,
      config: {
        initialRouteName: 'Tabs',
        screens: LINKING_SCREENS as unknown as NonNullable<
          LinkingOptions<RootStackParamList>['config']
        >['screens'],
      },
      // A URL may only ever open a screen, never act on it: strip params like `decide` that would make
      // a screen do something (approve, decline, …) the instant it opens, without a tap.
      getStateFromPath: (path, options) => stripLinkedActionParams(getStateFromPathDefault(path, options)),
      async getInitialURL() {
        return resolve((await Linking.getInitialURL()) ?? (await initialNotificationUrl()));
      },
      subscribe(listener) {
        const forward = (url: string) => {
          const next = resolve(url);
          if (next) listener(next);
        };
        const sub = Linking.addEventListener('url', ({ url }) => forward(url));
        const offTaps = onNotificationTap(forward);
        return () => {
          sub.remove();
          offTaps();
        };
      },
    };
  }, []);
}

/**
 * A managed push names only a kind and an opaque ref: once the app is open, the appliance resolves the ref
 * (`push.resolve`, CT-49) and its link opens; `not_found` (gone, or no longer visible) opens the inbox with a quiet
 * note. Only an appliance without `push.resolve` falls back to the kind: the newest unread inbox row of that kind
 * (an approval push opens the approval waiting for the person), This Whombat for news about the appliance itself.
 */
function usePushTaps(navRef: typeof navigationRef) {
  // The sidebar as it is when a tap comes: reading it doesn't draw the navigator again for every message.
  const { slug, currentBootstrap } = useBurrowBase();
  const { client } = useWhombat();
  const managed = useManaged();
  const byKind = useCallback(
    async (tap: PushTap) => {
      const inbox = await client.notifications.inbox({ params: { burrow: slug }, query: { filter: 'all' } });
      const items = inbox.sections.flatMap((section) => section.items);
      const target = pushTarget(pushKindOf(tap.kind), slug, items);
      for (let i = 0; i < 50 && !navRef.isReady(); i++) await new Promise((ok) => setTimeout(ok, 100));
      if (!navRef.isReady()) return;
      if (target.to === 'appliance') {
        navRef.navigate('Whombat');
        return;
      }
      if (target.to === 'inbox') {
        navRef.navigate('Tabs', { screen: INBOX_TAB });
        return;
      }
      const route = routeForLink(target.item.link as LinkRef, currentBootstrap().sidebar, OVERVIEW_TITLE, {
        deployments: true,
      });
      if (route) (navRef.navigate as (name: string, params?: object) => void)(route.name, route.params);
      void client.notifications
        .markRead({ params: { burrow: slug }, body: { ids: [target.item.id] } })
        .catch(() => {});
    },
    [client, slug, currentBootstrap, navRef],
  );
  const session = managed?.session;
  const showNote = managed?.showNote;
  const resolve = useCallback(
    async (tap: PushTap) => {
      if (!session) return byKind(tap);
      // Already looked up (the shade check does it for what is on screen): open it without asking the Whombat again.
      const known = knownPushRefs.get(tap.ref);
      const open: PushOpen =
        known === 'gone'
          ? { to: 'inbox', missing: true }
          : known
            ? { to: 'link', ...known }
            : await resolvePushRef(session, tap.ref);
      if (open.to === 'by_kind') return byKind(tap);
      if (open.to === 'link') knownPushRefs.set(tap.ref, { burrow: open.burrow, link: open.link });
      else if (open.missing) knownPushRefs.set(tap.ref, 'gone');
      for (let i = 0; i < 50 && !navRef.isReady(); i++) await new Promise((ok) => setTimeout(ok, 100));
      if (!navRef.isReady()) return;
      // This app shows one burrow; a link of another opens the inbox (Connections).
      const route =
        open.to === 'link' && open.burrow === slug
          ? routeForLink(open.link, currentBootstrap().sidebar, OVERVIEW_TITLE, { deployments: true })
          : null;
      if (route) {
        (navRef.navigate as (name: string, params?: object) => void)(route.name, route.params);
        return;
      }
      // A page of the app as an external link (`/reports/…` by its path, `/needs-you?item=…`, `/things/…`, `/chats/…` on
      // the web app, AP-1376): its screen here, the item itself where it names one (NYL-09).
      if (open.to === 'link' && open.burrow === slug) {
        const screen = appScreenOfLink(open.link, APP_ORIGINS);
        if (screen && openAppUrl(screen)) return;
      }
      // No screen of its own: a push about the Whombat itself This Whombat (the desk screen asking to unlock,
      // desk-display-android.md AP-3055), the rest the inbox, Needs you.
      const fallback = pushTapFallback(tap.kind);
      if (fallback === 'whombat') {
        navRef.navigate('Whombat');
        return;
      }
      navRef.navigate('Tabs', { screen: INBOX_TAB });
      if (open.to === 'inbox' && open.missing) showNote?.(COPY.push.notFound);
    },
    [session, showNote, byKind, slug, currentBootstrap, navRef],
  );
  // Taps from the managed root: one that opened the app (before this appliance's session was up), then each new one.
  const taps = managed?.taps;
  useEffect(() => {
    if (!taps) return;
    const pending = taps.take();
    if (pending) void resolve(pending).catch(() => {});
    return taps.subscribe((tap) => void resolve(tap).catch(() => {}));
  }, [taps, resolve]);
}

/**
 * Paths from links into the app (taken out by the managed root): links that named this appliance (MR-45:
 * `/appliances/<device>/<path>`) and burrow pages of the hosted UI, in either form (AP-366). Opened the way a
 * notification's path is (`appUrlForPath` → the linking config). A path that names another burrow of this person
 * (the old `/<burrow>/…`, or `?burrow=`) opens that burrow first; one of a burrow they aren't in opens the inbox.
 */
function AppLinks() {
  const managed = useManaged();
  const { slug } = useBurrowBase();
  const switchBurrow = useBurrowSwitch();
  const linkTo = useLinkTo();
  const links = managed?.links;
  useEffect(() => {
    if (!links) return;
    const open = (path: string) => {
      const other = burrowOfPath(path);
      if (other && other !== slug) {
        // The next navigator (the other burrow's) takes the path; this one goes with the switch.
        if (switchBurrow?.(other)) return links.hold(path);
        return linkTo('/inbox');
      }
      const url = appUrlForPath(path);
      linkTo(url.replace(/^whombat:\/\//, '/'));
    };
    const pending = links.take();
    if (pending) open(pending);
    return links.subscribe(open);
  }, [links, linkTo, slug, switchBurrow]);
  return null;
}

/**
 * `persistScope`: the storage scope (`server:<url>`, `managed:<org>/<Whombat>`) the navigation state is kept under across
 * a killed process (MN-01); null keeps nothing (the demo world).
 */
export function RootNavigator({ persistScope = null }: { persistScope?: string | null }) {
  const theme = useTheme();
  // Not the bootstrap: every new message changes it, and this draws the whole navigator.
  const { slug } = useBurrowBase();
  const { client } = useWhombat();
  const managed = useManaged();
  const markRead = useMarkNotificationsRead(slug);
  const navRef = navigationRef;
  usePushTaps(navRef);
  const linking = useLinking(({ burrow, notificationId }) => {
    if (!notificationId) return;
    if (!burrow || burrow === slug) markRead.mutate({ ids: [notificationId] });
    else
      void client.notifications
        .markRead({ params: { burrow }, body: { ids: [notificationId] } })
        .catch(() => {});
  });
  const navTheme = useMemo(() => {
    const base = theme.dark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      dark: theme.dark,
      colors: {
        ...base.colors,
        primary: theme.colors.brand,
        background: theme.colors.bg,
        card: theme.colors.bg,
        text: theme.colors.ink,
        border: theme.colors.line,
        notification: theme.colors.btn,
      },
    };
  }, [theme]);
  const persistence = useNavigationPersistence(persistScope, !!managed);
  const saveState = persistence.onStateChange;
  // A security view the app couldn't read is its screen's (AP-701): leaving that screen clears the notice.
  const focused = useRef<string | undefined>(undefined);
  const onStateChange = useCallback(() => {
    saveState();
    const route = navigationRef.getCurrentRoute();
    noteRoute(route?.name);
    const key = route?.key;
    if (key === focused.current) return;
    focused.current = key;
    leftOut.clearStrict();
  }, [saveState]);
  const restored = persistence.onReady;
  const onReady = useCallback(() => {
    restored();
    noteRoute(navigationRef.getCurrentRoute()?.name);
  }, [restored]);
  // The saved place loads first (at most a second), so the first screen is the right one; then the container asks
  // whether a link opened the app. Both wait with the launch screen up (AP-2643).
  const waiting = (
    <StartHold>
      <View style={{ flex: 1, backgroundColor: theme.colors.bg }} />
    </StartHold>
  );
  if (!persistence.ready) return waiting;
  return (
    <NavigationContainer
      ref={navRef}
      theme={navTheme}
      linking={linking}
      fallback={waiting}
      initialState={persistence.initialState}
      onReady={onReady}
      onStateChange={onStateChange}
    >
      <AppLinks />
      {/* A sign-in started on this phone, back from the provider (phone-connect.md PC-05). */}
      <ConnectReturnBridge />
      <ShareIntentBridge />
      <NotificationShadeBridge />
      <HostTasksBridge />
      {/* A thread settled or opened again on another device, by itself or by a new message (chat-settle.md AP-6158). */}
      <ChatSettledBridge />
      <Stack.Navigator
        screenLayout={pageLayout}
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.bg },
          animation: 'slide_from_right',
          // Screens under the top one don't re-render for every message, typing or presence event (AP-904); their
          // effects stay, and they catch up when they show again (nothing here needs to render while covered).
          freezeOnBlur: true,
        }}
      >
        <Stack.Screen name="Tabs" component={Tabs} />
        <Stack.Screen
          name="Approval"
          getId={SCREEN_IDS.Approval}
          getComponent={() =>
            (require('../screens/ApprovalScreen') as typeof import('../screens/ApprovalScreen'))
              .ApprovalScreen
          }
        />
        <Stack.Screen
          name="Conversation"
          getId={SCREEN_IDS.Conversation}
          getComponent={() =>
            (require('../screens/ConversationScreen') as typeof import('../screens/ConversationScreen'))
              .ConversationScreen
          }
        />
        <Stack.Screen
          name="Run"
          getComponent={() =>
            (require('../screens/RunScreen') as typeof import('../screens/RunScreen')).RunScreen
          }
        />
        <Stack.Screen
          name="Memory"
          getComponent={() =>
            (require('../screens/MemoryScreen') as typeof import('../screens/MemoryScreen')).MemoryScreen
          }
        />
        <Stack.Screen
          name="Automation"
          getComponent={() =>
            (require('../screens/AutomationScreen') as typeof import('../screens/AutomationScreen'))
              .AutomationScreen
          }
        />
        <Stack.Screen
          name="AutomationRun"
          getComponent={() =>
            (require('../screens/AutomationRunScreen') as typeof import('../screens/AutomationRunScreen'))
              .AutomationRunScreen
          }
        />
        <Stack.Screen
          name="Skills"
          getComponent={() =>
            (require('../screens/SkillsScreen') as typeof import('../screens/SkillsScreen')).SkillsScreen
          }
        />
        <Stack.Screen
          name="Skill"
          getComponent={() =>
            (require('../screens/SkillScreen') as typeof import('../screens/SkillScreen')).SkillScreen
          }
        />
        <Stack.Screen
          name="Vault"
          getComponent={() =>
            (require('../screens/VaultScreen') as typeof import('../screens/VaultScreen')).VaultScreen
          }
        />
        <Stack.Screen
          name="VaultEntry"
          getComponent={() =>
            (require('../screens/VaultEntryScreen') as typeof import('../screens/VaultEntryScreen'))
              .VaultEntryScreen
          }
        />
        <Stack.Screen
          name="Connections"
          getComponent={() =>
            (require('../screens/ConnectionsScreen') as typeof import('../screens/ConnectionsScreen'))
              .ConnectionsScreen
          }
        />
        <Stack.Screen
          name="AddConnection"
          getComponent={() =>
            (require('../screens/AddConnectionScreen') as typeof import('../screens/AddConnectionScreen'))
              .AddConnectionScreen
          }
        />
        <Stack.Screen
          name="Connection"
          getComponent={() =>
            (require('../screens/ConnectionScreen') as typeof import('../screens/ConnectionScreen'))
              .ConnectionScreen
          }
        />
        {/* Connecting from the phone (phone-connect.md PC-01…PC-11, AP-2900…): Connect {Name} and a builtin's screen. */}
        <Stack.Screen
          name="Connect"
          getComponent={() =>
            (require('../screens/ConnectScreen') as typeof import('../screens/ConnectScreen')).ConnectScreen
          }
        />
        <Stack.Screen
          name="ConnectAccount"
          getComponent={() =>
            (require('../screens/ConnectAccountScreen') as typeof import('../screens/ConnectAccountScreen'))
              .ConnectAccountScreen
          }
        />
        {/* Files (files-space.md FS-07, AP-772…): the conversations with files, and one conversation's Files. */}
        <Stack.Screen
          name="Files"
          getComponent={() =>
            (require('../screens/FilesScreen') as typeof import('../screens/FilesScreen')).FilesScreen
          }
        />
        <Stack.Screen
          name="ConversationFiles"
          getComponent={() =>
            (
              require('../screens/ConversationFilesScreen') as typeof import('../screens/ConversationFilesScreen')
            ).ConversationFilesScreen
          }
        />
        {/* Search: chats, things, settings and places (phone-shell-final.md). */}
        <Stack.Screen
          name="Search"
          getComponent={() =>
            (require('../screens/SearchScreen') as typeof import('../screens/SearchScreen')).SearchScreen
          }
        />
        <Stack.Screen
          name="Plan"
          getComponent={() =>
            (require('../screens/PlanScreen') as typeof import('../screens/PlanScreen')).PlanScreen
          }
        />
        <Stack.Screen
          name="Plans"
          getComponent={() =>
            (require('../screens/PlansScreen') as typeof import('../screens/PlansScreen')).PlansScreen
          }
        />
        {/* What is live where and every recorded deploy (MQ-07; work-removal-android.md AP-858). */}
        <Stack.Screen
          name="Deploys"
          getComponent={() =>
            (require('../screens/DeploysScreen') as typeof import('../screens/DeploysScreen')).DeploysScreen
          }
        />
        <Stack.Screen
          name="Thread"
          getId={SCREEN_IDS.Thread}
          getComponent={() =>
            (require('../screens/ThreadScreen') as typeof import('../screens/ThreadScreen')).ThreadScreen
          }
        />
        <Stack.Screen
          name="Pins"
          getComponent={() =>
            (require('../screens/PinsScreen') as typeof import('../screens/PinsScreen')).PinsScreen
          }
        />
        <Stack.Screen
          name="Share"
          getComponent={() =>
            (require('../screens/ShareScreen') as typeof import('../screens/ShareScreen')).ShareScreen
          }
        />
        {managed ? (
          <Stack.Screen
            name="Whombat"
            getComponent={() =>
              (require('../managed/WhombatScreen') as typeof import('../managed/WhombatScreen')).WhombatScreen
            }
          />
        ) : null}
        {/* Backups: a Whombat's, or the demo box's in the demo world (backup-options-android.md AP-6864). */}
        <Stack.Screen
          name="WhombatBackups"
          getComponent={() =>
            (require('../managed/WhombatBackupsScreen') as typeof import('../managed/WhombatBackupsScreen'))
              .WhombatBackupsScreen
          }
        />
        <Stack.Screen
          name="BackupOptions"
          getComponent={() =>
            (require('../managed/BackupOptionsScreen') as typeof import('../managed/BackupOptionsScreen'))
              .BackupOptionsScreen
          }
        />
        <Stack.Screen
          name="BackupDetail"
          getComponent={() =>
            (require('../managed/BackupDetailScreen') as typeof import('../managed/BackupDetailScreen'))
              .BackupDetailScreen
          }
        />
        <Stack.Screen
          name="BackupBringBack"
          getComponent={() =>
            (require('../managed/BackupBringBackScreen') as typeof import('../managed/BackupBringBackScreen'))
              .BackupBringBackScreen
          }
        />
        {managed ? (
          <Stack.Screen
            name="Devices"
            getComponent={() =>
              (require('../managed/DevicesScreen') as typeof import('../managed/DevicesScreen')).DevicesScreen
            }
          />
        ) : null}
        {managed ? (
          <Stack.Screen
            name="ShareLink"
            getComponent={() =>
              (require('../screens/ShareLinkScreen') as typeof import('../screens/ShareLinkScreen'))
                .ShareLinkScreen
            }
          />
        ) : null}
        {managed ? (
          <Stack.Screen
            name="SharedLinks"
            getComponent={() =>
              (require('../settings/SharedLinksScreen') as typeof import('../settings/SharedLinksScreen'))
                .SharedLinksScreen
            }
          />
        ) : null}
        {/* Reports to the Whombat Team (team-reports.md): the list, a new one and one report, where its push leads. */}
        <Stack.Screen
          name="TeamReports"
          getComponent={() =>
            (require('../screens/TeamReportsScreen') as typeof import('../screens/TeamReportsScreen'))
              .TeamReportsScreen
          }
        />
        <Stack.Screen
          name="TeamReportNew"
          getComponent={() =>
            (require('../screens/TeamReportNewScreen') as typeof import('../screens/TeamReportNewScreen'))
              .TeamReportNewScreen
          }
        />
        <Stack.Screen
          name="TeamReport"
          getId={SCREEN_IDS.TeamReport}
          getComponent={() =>
            (require('../screens/TeamReportScreen') as typeof import('../screens/TeamReportScreen'))
              .TeamReportScreen
          }
        />
        {managed ? (
          <Stack.Screen
            name="WhombatAbout"
            getComponent={() =>
              (require('../managed/WhombatAboutScreen') as typeof import('../managed/WhombatAboutScreen'))
                .WhombatAboutScreen
            }
          />
        ) : null}
        {managed ? (
          <Stack.Screen
            name="WhombatHardware"
            getComponent={() =>
              (
                require('../managed/WhombatHardwareScreen') as typeof import('../managed/WhombatHardwareScreen')
              ).WhombatHardwareScreen
            }
          />
        ) : null}
        {managed ? (
          <Stack.Screen
            name="WhombatRemoteHelp"
            getComponent={() =>
              (
                require('../managed/WhombatRemoteHelpScreen') as typeof import('../managed/WhombatRemoteHelpScreen')
              ).WhombatRemoteHelpScreen
            }
          />
        ) : null}
        {managed ? (
          <Stack.Screen
            name="BackupFile"
            getComponent={() =>
              (require('../managed/BackupFileScreen') as typeof import('../managed/BackupFileScreen'))
                .BackupFileScreen
            }
          />
        ) : null}
        {/* Stream C (android-work): the agent's settings, a pull request and its files (AP-712, AP-713). */}
        <Stack.Screen
          name="SettingsAgent"
          getComponent={() =>
            (require('../screens/AgentSettingsScreen') as typeof import('../screens/AgentSettingsScreen'))
              .AgentSettingsScreen
          }
        />
        <Stack.Screen
          name="SettingsCouncil"
          getComponent={() =>
            (require('../screens/CouncilSetupScreen') as typeof import('../screens/CouncilSetupScreen'))
              .CouncilSetupScreen
          }
        />
        <Stack.Screen
          name="PullRequest"
          getComponent={() =>
            (require('../screens/PullRequestScreen') as typeof import('../screens/PullRequestScreen'))
              .PullRequestScreen
          }
        />
        <Stack.Screen
          name="PullRequestFile"
          getComponent={() =>
            (require('../screens/PullRequestFileScreen') as typeof import('../screens/PullRequestFileScreen'))
              .PullRequestFileScreen
          }
        />
        {/* Parity screens (mobile-parity.md MQ-01…MQ-06), and a canvas read-only (MQ-05). */}
        <Stack.Screen
          name="Spend"
          getComponent={() =>
            (require('../screens/SpendScreen') as typeof import('../screens/SpendScreen')).SpendScreen
          }
        />
        <Stack.Screen
          name="AuditLog"
          getComponent={() =>
            (require('../screens/AuditLogScreen') as typeof import('../screens/AuditLogScreen'))
              .AuditLogScreen
          }
        />
        {/* The Settings tab's pages (settings-tab-android.md AP-2625). */}
        <Stack.Screen
          name="SettingsProfile"
          getComponent={() =>
            (require('../settings/SettingsPages') as typeof import('../settings/SettingsPages'))
              .SettingsProfileScreen
          }
        />
        {/* Settings → You → Prompts and a prompt being kept or changed (prompts-phone.md). */}
        <Stack.Screen
          name="SettingsPrompts"
          getComponent={() =>
            (require('../settings/PromptsScreen') as typeof import('../settings/PromptsScreen')).PromptsScreen
          }
        />
        <Stack.Screen
          name="PromptEdit"
          getComponent={() =>
            (require('../settings/PromptEditScreen') as typeof import('../settings/PromptEditScreen'))
              .PromptEditScreen
          }
        />
        <Stack.Screen
          name="SettingsNotifications"
          getComponent={() =>
            (require('../settings/SettingsPages') as typeof import('../settings/SettingsPages'))
              .SettingsNotificationsScreen
          }
        />
        <Stack.Screen
          name="SettingsAi"
          getComponent={() =>
            (require('../settings/SettingsPages') as typeof import('../settings/SettingsPages'))
              .SettingsAiScreen
          }
        />
        <Stack.Screen
          name="SettingsWhombat"
          getComponent={() =>
            (require('../settings/SettingsPages') as typeof import('../settings/SettingsPages'))
              .SettingsWhombatScreen
          }
        />
        {/* Settings → Advanced: its list and the pages it draws itself. */}
        <Stack.Screen
          name="SettingsAdvanced"
          getComponent={() =>
            (require('../settings/AdvancedScreens') as typeof import('../settings/AdvancedScreens'))
              .SettingsAdvancedScreen
          }
        />
        <Stack.Screen
          name="SettingsAdvancedPart"
          getComponent={() =>
            (require('../settings/AdvancedScreens') as typeof import('../settings/AdvancedScreens'))
              .SettingsAdvancedPartScreen
          }
        />
        {/* Settings → Screen (desk-display-android.md AP-5860). */}
        <Stack.Screen
          name="SettingsDesk"
          getComponent={() =>
            (require('../settings/DeskScreenPage') as typeof import('../settings/DeskScreenPage'))
              .SettingsDeskScreen
          }
        />
        {/* Settings → Screens: a screen's page and its layout (desk-display-android.md AP-6004, AP-6010). */}
        <Stack.Screen
          name="SettingsScreen"
          getComponent={() =>
            (require('../settings/screens/ScreenPage') as typeof import('../settings/screens/ScreenPage'))
              .SettingsScreenPage
          }
        />
        <Stack.Screen
          name="SettingsScreenLayout"
          getComponent={() =>
            (require('../settings/screens/LayoutEditor') as typeof import('../settings/screens/LayoutEditor'))
              .SettingsScreenLayout
          }
        />
        <Stack.Screen
          name="Canvas"
          getComponent={() =>
            (require('../screens/CanvasScreen') as typeof import('../screens/CanvasScreen')).CanvasScreen
          }
        />
        {/* One Whombat (one-whombat-mobile.md AP-1357, AP-1363): a task chat, and a thing (a server's page). */}
        <Stack.Screen
          name="Chat"
          getComponent={() =>
            (require('../screens/ChatScreen') as typeof import('../screens/ChatScreen')).ChatScreen
          }
        />
        {/* Chat's Feedback room and a room's threads (chat-channel.md AP-2453, AP-2454). */}
        <Stack.Screen
          name="Feedback"
          getComponent={() =>
            (require('../screens/ChatRoomScreen') as typeof import('../screens/ChatRoomScreen'))
              .FeedbackScreen
          }
        />
        <Stack.Screen
          name="NewChat"
          getComponent={() =>
            (require('../screens/ChatRoomScreen') as typeof import('../screens/ChatRoomScreen')).NewChatScreen
          }
        />
        <Stack.Screen
          name="Settled"
          getComponent={() =>
            (require('../screens/SettledScreen') as typeof import('../screens/SettledScreen')).SettledScreen
          }
        />
        {/* A Needs you item beside the list with two pages (iphone-duo.md), and where a push about it lands. */}
        <Stack.Screen
          name="NeedsYouItem"
          getComponent={() =>
            (require('../screens/NeedsYouSheet') as typeof import('../screens/NeedsYouSheet'))
              .NeedsYouItemScreen
          }
        />
        {/* Everything I did (home-redesign-mobile.md AP-2261). */}
        <Stack.Screen
          name="Done"
          getComponent={() =>
            (require('../screens/DoneScreen') as typeof import('../screens/DoneScreen')).DoneScreen
          }
        />
        {/* One screen per thing: a page's “Runs on” or “Also connected” opens another thing on top (AP-1964). */}
        <Stack.Screen
          name="Thing"
          getId={({ params }) => params?.thingId}
          getComponent={() =>
            (require('../screens/ThingScreen') as typeof import('../screens/ThingScreen')).ThingScreen
          }
        />
        {/* Add a server (server-signin-mobile.md AP-1697). */}
        <Stack.Screen
          name="AddServer"
          getComponent={() =>
            (require('../screens/AddServerScreen') as typeof import('../screens/AddServerScreen'))
              .AddServerScreen
          }
        />
        {/* Point them here (backup-file.md AP-4421). */}
        <Stack.Screen
          name="RepointServers"
          getComponent={() =>
            (require('../screens/RepointServersScreen') as typeof import('../screens/RepointServersScreen'))
              .RepointServersScreen
          }
        />
        {/* A guest on a server (proxmox-mobile.md AP-1485). */}
        <Stack.Screen
          name="Guest"
          getComponent={() =>
            (require('../screens/GuestScreen') as typeof import('../screens/GuestScreen')).GuestScreen
          }
        />
        {/* A server's updates (server-updates-app.md AP-2880). */}
        <Stack.Screen
          name="ServerUpdates"
          getComponent={() =>
            (require('../screens/ServerUpdatesScreen') as typeof import('../screens/ServerUpdatesScreen'))
              .ServerUpdatesScreen
          }
        />
      </Stack.Navigator>
      {/* The toast with Undo, over every screen (quiet-notices-mobile.md AP-4864). */}
      <ToastHost />
    </NavigationContainer>
  );
}
