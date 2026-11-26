/**
 * The pages the Settings list opens (settings-tab-android.md AP-2625, AP-2626), each on a page with “‹ Settings” and its
 * title, over the bar as every pushed screen: **You** — your photo (the agent's name and face are the assistant's),
 * your notifications (Do not disturb, quiet hours, previews and push on this phone), how threads settle by themselves
 * (CHAT, chat-settle.md AP-6156), on a Whombat the way to Devices and Shared links, and Prompts where the Whombat keeps
 * them (prompts-phone.md); **This Whombat** in the demo world — the burrow,
 * the version, a box with a screen and its machine (a Whombat's is its Overview, `Whombat`). The assistant's page is
 * `AgentSettingsScreen`, Advanced's `AdvancedScreens`. The AI sign-in's old page opens the assistant's.
 */
import { type RouteProp, StackActions, useRoute } from '@react-navigation/native';
import {
  type HostMetricsLoader,
  type HostSpend,
  PROMPT_WORDS,
  SETTINGS_GROUP_TEXT,
  TEAM_REPORT_WORDS,
} from '@whombat/client';
import { THIS_WHOMBAT_TEXT } from '@whombat/client/managed';
import { useTeamReportsEntry } from '@whombat/client/react';
import type { HostMetrics } from '@whombat/protocol/session';
import { type ReactNode, useCallback, useEffect } from 'react';
import { ScrollView, View } from 'react-native';
import { useBurrow, useBurrowBase } from '../data/BurrowProvider';
import { usePrompts } from '../data/usePrompts';
import { demoDesk, isDeskDemoState } from '../fixtures/desk';
import { hostMetricsFixture } from '../fixtures/host';
import { demoMachine, isMachineDemoState } from '../fixtures/machine';
import { demoRemoteHelp, isRemoteHelpDemoState } from '../fixtures/remoteHelp';
import { demoVoice, isVoiceDemoWorld } from '../fixtures/voice';
import { BluetoothSection } from '../managed/BluetoothSection';
import { useManaged } from '../managed/context';
import { COPY as MANAGED_COPY } from '../managed/copy';
import { DeskSettingsRow } from '../managed/DeskSection';
import { DeskUnlockCard } from '../managed/DeskUnlockCard';
import { HardwareSection } from '../managed/HardwareSection';
import { HostStatusView } from '../managed/HostStatus';
import { NetworkSection } from '../managed/NetworkSection';
import { NotificationsRow } from '../managed/NotificationsRow';
import { RemoteHelpSection } from '../managed/RemoteHelpSection';
import { TailscaleSection } from '../managed/TailscaleSection';
import { LinkRow, Card as ManagedCard } from '../managed/ui';
import { useDeskApi } from '../managed/useDesk';
import { useHostPoller } from '../managed/useHostStatus';
import { useMachineHere } from '../managed/useMachine';
import { useRemoteHelpHere } from '../managed/useRemoteHelpHere';
import { useTailscaleHere } from '../managed/useTailscale';
import { VoiceSection } from '../managed/VoiceSection';
import { useAppNavigation } from '../navigation/hooks';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackBar, Screen } from '../ui/headers';
import { KeyboardAvoidingView } from '../ui/keyboard';
import { ListRow } from '../ui/ListRow';
import { SectionLabel } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { useVoiceApi } from '../voice/useVoiceApi';
import { AgentUpdatesSwitchCard } from './AgentUpdatesSwitch';
import { ChatSettleSection } from './ChatSettleSection';
import { youPartsHere } from './groups';
import { SETTINGS_TEXT } from './list';
import { NotificationsSection } from './NotificationsSection';
import { PlaceNewsCards } from './PlaceNewsCards';
import { ProfileRow } from './ProfileRow';
import { VersionCard } from './VersionCard';

/**
 * A settings page: “‹ Settings” (or the page it goes back to, `back`), its title (25/700), its parts under it; back to
 * the Settings tab without a stack. `scrollEnabled` false holds it still while something on it is dragged.
 */
export function SettingsPage({
  title,
  children,
  scrollEnabled = true,
  back = SETTINGS_TEXT.title,
}: {
  title: string;
  children: ReactNode;
  scrollEnabled?: boolean;
  back?: string;
}) {
  const bottomRoom = useBottomRoom();
  const navigation = useAppNavigation();
  return (
    <Screen>
      <BackBar
        label={back}
        onPress={() =>
          navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs', { screen: 'Settings' })
        }
      />
      {/* A field stays above the keyboard (AP-1536). */}
      <KeyboardAvoidingView style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 2,
            paddingBottom: 32 + bottomRoom,
            gap: 18,
          }}
          keyboardShouldPersistTaps="handled"
          scrollEnabled={scrollEnabled}
        >
          <Text
            size={25}
            weight={700}
            lh={1.15}
            tracking={-0.02}
            accessibilityRole="header"
            style={{ paddingHorizontal: 6 }}
          >
            {title}
          </Text>
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** The way to Devices on You: this phone, your other devices and passkeys (a Whombat's, AP-1229). */
const DEVICES_LINE = 'This phone, your other devices and passkeys';
const LINKS_LINE = 'Links to copies of your threads, and stopping them';

/**
 * You: who you are and your photo (PA-06), your notifications — Do not disturb and quiet hours where the Whombat keeps
 * them (AP-513), push on this phone (MN-05) — then CHAT: when threads settle by themselves (chat-settle.md AP-6156),
 * and on a Whombat a row to Devices. What the assistant remembers is its own page's (Memory).
 */
export function SettingsProfileScreen() {
  const { bootstrap, mode, slug } = useBurrow();
  const managed = useManaged();
  const navigation = useAppNavigation();
  const theme = useTheme();
  const prompts = usePrompts();
  const parts = youPartsHere({ mode, prompts: prompts.shown });
  const devices = SETTINGS_GROUP_TEXT.you.devices;
  // Reports to the Whombat Team (team-reports.md): only where one can be sent or the person has some.
  const reports = useTeamReportsEntry(slug);
  return (
    <SettingsPage title={SETTINGS_GROUP_TEXT.groups('').you}>
      <ProfileRow me={bootstrap.me} demo={mode === 'fixtures'} />
      {parts.includes('notifications') ? <NotificationsSection /> : null}
      {managed && parts.includes('notifications') ? (
        <NotificationsRow
          push={managed.push}
          label={MANAGED_COPY.notifications.onThisPhone}
          community={managed.community}
        />
      ) : null}
      <ChatSettleSection />
      {parts.includes('devices') ? (
        <View
          style={{
            borderRadius: 20,
            borderWidth: 1,
            borderColor: theme.colors.line,
            backgroundColor: theme.colors.sf,
            overflow: 'hidden',
          }}
        >
          <ListRow
            title={devices}
            body={DEVICES_LINE}
            trailing="›"
            onPress={() => navigation.navigate('Devices')}
            accessibilityLabel={`${devices}. ${DEVICES_LINE}`}
          />
        </View>
      ) : null}
      {parts.includes('links') ? (
        <View
          style={{
            borderRadius: 20,
            borderWidth: 1,
            borderColor: theme.colors.line,
            backgroundColor: theme.colors.sf,
            overflow: 'hidden',
          }}
        >
          <ListRow
            title={SETTINGS_GROUP_TEXT.you.links}
            body={LINKS_LINE}
            trailing="›"
            onPress={() => navigation.navigate('SharedLinks')}
            accessibilityLabel={`${SETTINGS_GROUP_TEXT.you.links}. ${LINKS_LINE}`}
          />
        </View>
      ) : null}
      {parts.includes('prompts') ? (
        <View
          style={{
            borderRadius: 20,
            borderWidth: 1,
            borderColor: theme.colors.line,
            backgroundColor: theme.colors.sf,
            overflow: 'hidden',
          }}
        >
          <ListRow
            title={SETTINGS_GROUP_TEXT.you.prompts}
            body={PROMPT_WORDS.intro}
            trailing="›"
            onPress={() => navigation.navigate('SettingsPrompts')}
            accessibilityLabel={`${SETTINGS_GROUP_TEXT.you.prompts}. ${PROMPT_WORDS.intro}`}
          />
        </View>
      ) : null}
      {reports ? (
        <View
          style={{
            borderRadius: 20,
            borderWidth: 1,
            borderColor: theme.colors.line,
            backgroundColor: theme.colors.sf,
            overflow: 'hidden',
          }}
        >
          <ListRow
            title={TEAM_REPORT_WORDS.entry}
            body={TEAM_REPORT_WORDS.intro}
            trailing="›"
            onPress={() => navigation.navigate('TeamReports', { back: SETTINGS_GROUP_TEXT.groups('').you })}
            accessibilityLabel={`${TEAM_REPORT_WORDS.entry}. ${TEAM_REPORT_WORDS.intro}`}
          />
        </View>
      ) : null}
    </SettingsPage>
  );
}

/** Notifications' old address: You, where they are now. */
export const SettingsNotificationsScreen = SettingsProfileScreen;

/** The AI sign-in's old address: the assistant's AI sign-in, in its place. */
export function SettingsAiScreen() {
  const navigation = useAppNavigation();
  useEffect(() => {
    navigation.dispatch(StackActions.replace('SettingsAgent', { part: 'ai' }));
  }, [navigation]);
  return <Screen>{null}</Screen>;
}

/**
 * This Whombat in the demo world (SS-06, SS-21): the burrow, where it runs and the version (the audit log is
 * Advanced's). A managed Whombat's is its Overview: a link here opens that instead. The demo world also has a box
 * with a screen (desk-display-android.md AP-3061): its unlock request on top, HOW IT’S DOING from the box-status
 * fixture with the power line, and SCREEN, the row that opens Settings → Screen (AP-5861); `?desk=<state>` starts its
 * screen over in another state. VOICE TYPING after
 * SCREEN, its speech service the demo's (`fixtures/voice.ts`); `?voice=<world>` starts it over as another. And a machine
 * (hardware-support-android.md AP-3262): NETWORK after SCREEN, HARDWARE after VERSION (About's place for it is a
 * managed Whombat's) and BLUETOOTH after NETWORK (bluetooth-android.md AP-3759); `?machine=<state>` starts it over as
 * another machine. REMOTE HELP after HARDWARE, as About has it (app remote-help.md AP-4478); `?help=<state>` starts it
 * over in another state.
 */
export function SettingsWhombatScreen() {
  const theme = useTheme();
  const navigation = useAppNavigation();
  const route = useRoute<RouteProp<RootStackParamList, 'SettingsWhombat'>>();
  const { bootstrap, mode } = useBurrow();
  const managed = useManaged();
  const demo = mode === 'fixtures';
  const desk = useDeskApi();
  const voice = useVoiceApi();
  const machine = useMachineHere();
  const tailscale = useTailscaleHere();
  const remoteHelp = useRemoteHelpHere();
  useEffect(() => {
    if (managed) navigation.dispatch(StackActions.replace('Whombat'));
  }, [managed, navigation]);
  const state = route.params?.desk;
  useEffect(() => {
    if (demo && isDeskDemoState(state)) demoDesk({ me: bootstrap.me }).reset(state);
  }, [demo, state, bootstrap.me]);
  const voiceWorld = route.params?.voice;
  useEffect(() => {
    if (demo && isVoiceDemoWorld(voiceWorld)) demoVoice().reset(voiceWorld);
  }, [demo, voiceWorld]);
  const machineState = route.params?.machine;
  useEffect(() => {
    if (demo && isMachineDemoState(machineState)) demoMachine().reset(machineState);
  }, [demo, machineState]);
  const helpState = route.params?.help;
  useEffect(() => {
    if (demo && isRemoteHelpDemoState(helpState)) demoRemoteHelp({ me: bootstrap.me }).reset(helpState);
  }, [demo, helpState, bootstrap.me]);
  return (
    <SettingsPage title={SETTINGS_TEXT.rows.appliance}>
      <DeskUnlockCard api={desk} />
      <View style={{ gap: 2 }}>
        <SectionLabel>BURROW</SectionLabel>
        <Text size={15} color={theme.colors.ink2} style={{ paddingHorizontal: 6 }}>
          {`${bootstrap.burrow.name} · ${bootstrap.burrow.slug}`}
        </Text>
      </View>
      <View style={{ gap: 2 }}>
        <SectionLabel>SERVER</SectionLabel>
        <Text size={15} color={theme.colors.ink2} style={{ paddingHorizontal: 6 }}>
          Demo world on this phone. Nothing leaves the app.
        </Text>
      </View>
      {demo ? <DemoHostStatus /> : null}
      {/* Backups over the demo's box (backup-options-android.md AP-6864). */}
      {demo ? (
        <ManagedCard>
          <LinkRow
            first
            title={THIS_WHOMBAT_TEXT.parts.backups}
            label={THIS_WHOMBAT_TEXT.parts.backups}
            onPress={() => navigation.navigate('WhombatBackups')}
          />
        </ManagedCard>
      ) : null}
      <DeskSettingsRow api={desk} onOpen={() => navigation.navigate('SettingsDesk')} />
      <VoiceSection api={voice} />
      <NetworkSection machine={machine} onRepoint={() => navigation.navigate('RepointServers')} />
      <TailscaleSection here={tailscale} />
      <BluetoothSection machine={machine} />
      <VersionCard />
      {/* Where this Whombat is and the news it reads (weather-news-apps.md), after VERSION as About has them. */}
      <PlaceNewsCards />
      <HardwareSection machine={machine} />
      <RemoteHelpSection here={remoteHelp} />
      {/* “Keep server agents up to date” where servers are (agent-updates-app.md AP-2992). */}
      <AgentUpdatesSwitchCard />
    </SettingsPage>
  );
}

/**
 * HOW IT’S DOING in the demo world (desk-display-android.md AP-3061): the box-status fixture (21:40 on 11 October,
 * `fixtures/host.ts`) with the demo box's power, polled as a real box is.
 */
function DemoHostStatus() {
  const { me } = useBurrowBase();
  const loadMetrics = useCallback<HostMetricsLoader>(
    async (input) => {
      const metrics = hostMetricsFixture(input.range);
      const power = demoDesk({ me }).power();
      return {
        metrics: power ? ({ ...metrics, now: { ...metrics.now, power } } as HostMetrics) : metrics,
        reason: null,
      };
    },
    [me],
  );
  // Spend is Advanced's, in one place: How it’s doing shows the machine.
  const loadSpend = useCallback(async (): Promise<HostSpend> => ({ daily: null, overview: null }), []);
  const { state, setRange } = useHostPoller(loadMetrics, loadSpend);
  return <HostStatusView state={state} onRange={setRange} />;
}
