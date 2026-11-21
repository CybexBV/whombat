/**
 * Settings → Screen on the phone (Whombat desk-display.md DK-123; desk-display-android.md AP-5860…AP-5870), the web's
 * Screen tab the phone's way: a page of its own from the Settings list, only on a Whombat whose box has a screen (or
 * one is paired). On top the switch *Show Whombat on this screen* with the screen line (and, unpaired, Pair the
 * screen); paired, its parts as tabs — What it shows (where the box lists what can be chosen), Lock and PIN, Night,
 * Talk — and the open part under them. Opening it gives the screen the Whombat's name (DK-119).
 * `whombat://settings/screen?part=night` opens a part; in the demo world `?desk=<state>` starts its screen over.
 *
 * Where the Whombat has screens of widgets (it answers `desk.screens`, 3.6; DK-128, DK-149; AP-6000) the same address
 * is Settings → Screens: every screen and *Add a screen*; a part asked for (`?part=night`) opens the box's own screen's
 * page on it. The older page stays for a Whombat before them.
 */
import { type RouteProp, StackActions, useRoute } from '@react-navigation/native';
import { DESK_SCREENS_TEXT, DESK_TEXT, DESK_WORDS, deskSectionShown } from '@whombat/client/desk';
import { useDesk, useDeskActions, useDeskScreens } from '@whombat/client/desk/react';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useBurrow } from '../data/BurrowProvider';
import { demoDesk, isDeskDemoState } from '../fixtures/desk';
import { DeskLockCard, DeskNightCard, DeskSwitchCard, DeskTalkCard } from '../managed/DeskSection';
import { DeskUnlockCard } from '../managed/DeskUnlockCard';
import { useDeskApi } from '../managed/useDesk';
import { useAppNavigation } from '../navigation/hooks';
import type { RootStackParamList } from '../navigation/routes';
import { ErrorState, Loading } from '../ui/primitives';
import { UnderlineTabs } from '../ui/UnderlineTabs';
import { DeskShowsPart } from './DeskShowsPart';
import {
  DESK_SCREEN_PART_LABELS,
  type DeskScreenPart,
  deskScreenParts,
  resolveDeskScreenPart,
} from './deskScreen';
import { SettingsPage } from './SettingsPages';
import { ScreensList } from './screens/ScreensList';
import { screensOffered } from './screens/screensList';
import { useDeskNameSync } from './useDeskName';

export function SettingsDeskScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'SettingsDesk'>>();
  const navigation = useAppNavigation();
  const { bootstrap, mode } = useBurrow();
  const api = useDeskApi();
  const screens = useDeskScreens(api);
  const offered = screensOffered(screens);
  const state = route.params?.desk;
  useEffect(() => {
    if (mode === 'fixtures' && isDeskDemoState(state)) demoDesk({ me: bootstrap.me }).reset(state);
  }, [mode, state, bootstrap.me]);
  // An older link to one of the box's parts: that part on the box's own screen's page.
  const asked = route.params?.part;
  useEffect(() => {
    if (offered === 'screens' && asked && asked !== 'shows')
      navigation.dispatch(StackActions.replace('SettingsScreen', { screen: 'box', part: asked }));
  }, [offered, asked, navigation]);
  if (offered === 'older') return <OlderDeskScreen />;
  return (
    <SettingsPage title={DESK_SCREENS_TEXT.title}>
      {api && screens.data ? (
        <ScreensList api={api} list={screens.data} />
      ) : offered === 'failed' ? (
        <ErrorState text={DESK_TEXT.errors.failed} onRetry={() => void screens.refetch()} />
      ) : (
        <Loading />
      )}
    </SettingsPage>
  );
}

/** The older Screen page, on a Whombat without screens of widgets (DK-149). */
function OlderDeskScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'SettingsDesk'>>();
  const api = useDeskApi();
  const desk = useDesk(api);
  const actions = useDeskActions(api);
  const screen = desk.data;
  useDeskNameSync(api, screen);
  const parts = screen ? deskScreenParts(screen) : [];
  const [chosen, setChosen] = useState<DeskScreenPart | null>(null);
  const asked = route.params?.part;
  useEffect(() => {
    if (asked) setChosen(null);
  }, [asked]);
  const part = chosen && parts.includes(chosen) ? chosen : resolveDeskScreenPart(asked, parts);
  const [dragging, setDragging] = useState(false);
  return (
    <SettingsPage title={DESK_WORDS.settings.tab} scrollEnabled={!dragging}>
      {api && screen && deskSectionShown(screen) ? (
        <>
          <DeskUnlockCard api={api} />
          <DeskSwitchCard screen={screen} actions={actions} />
          {part ? (
            <View style={{ marginTop: -2 }}>
              <UnderlineTabs<DeskScreenPart>
                tabs={parts.map((key) => ({ key, label: DESK_SCREEN_PART_LABELS[key] }))}
                value={part}
                onChange={setChosen}
                label={DESK_WORDS.settings.tab}
                bleed={16}
              />
            </View>
          ) : null}
          {part === 'shows' && screen.showOptions ? (
            <DeskShowsPart
              api={api}
              screen={screen}
              options={screen.showOptions}
              actions={actions}
              onDragging={setDragging}
            />
          ) : part === 'lock' ? (
            <DeskLockCard screen={screen} actions={actions} />
          ) : part === 'night' ? (
            <DeskNightCard screen={screen} actions={actions} />
          ) : part === 'talk' ? (
            <DeskTalkCard api={api} screen={screen} actions={actions} />
          ) : null}
        </>
      ) : desk.isLoading ? (
        <Loading />
      ) : null}
    </SettingsPage>
  );
}
