/**
 * Whombat mobile. Providers from the outside in: safe area, theme (system light/dark until the user picks one), fonts,
 * then the managed app (cloud sign-in, Whombats over end-to-end sessions) — or, in a demo build
 * (`EXPO_PUBLIC_WHOMBAT_MODE=fixtures`), the demo world on an in-memory box (hermes-engine-app.md AP-5370). Android's
 * launch screen stays until the first screen is drawn (one-layout-android.md AP-2643): the placeholders on the way are
 * `StartHold`s.
 */
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { markFaceActivity } from './avatars/faceActivity';
import { DEMO } from './data/config';
import { noteEndingsAfterFirstFrame } from './errors/nativeErrorNotes';
import { sharedFiles } from './lib/sharedCache';
import { secureStore } from './lib/storage';
import { PageBoundary } from './navigation/PageBoundary';
import { useAppFonts } from './theme/fonts';
import { ThemeProvider, useTheme } from './theme/theme';
import { LAUNCH, StartHold, useLaunchSettle } from './ui/StartHold';
import { AppFrame } from './ui/screenShape';

LAUNCH.start();

// Builds made with EXPO_PUBLIC_WHOMBAT_HARNESS_URL (never a shipped build) run the on-device secure-session
// harness instead of the app (AP-25).
const HARNESS_URL = process.env.EXPO_PUBLIC_WHOMBAT_HARNESS_URL;
const Harness = HARNESS_URL ? require('./managed/DeviceHarness').DeviceHarness : null;
// The demo build never loads the managed app, and the managed app never the demo world.
const Demo =
  DEMO && !Harness ? (require('./demo/DemoRoot') as typeof import('./demo/DemoRoot')).DemoRoot : null;
const managedApp =
  !DEMO && !Harness ? (require('./managed/ManagedApp') as typeof import('./managed/ManagedApp')) : null;
const Managed = managedApp?.ManagedApp ?? null;
const UpdatePrompt = managedApp?.ManagedUpdatePrompt ?? null;
// What its first screen needs starts loading now, while the fonts load (AP-920).
managedApp?.startManagedApp();

function Root() {
  useLaunchSettle();
  const theme = useTheme();
  const fontsReady = useAppFonts();
  // Downloaded copies of shared files go once they are a day old (BP-A21), and at sign-out.
  useEffect(() => {
    sharedFiles.sweep().catch(() => {});
  }, []);
  // How Android says the earlier runs ended, once the first screen is drawn.
  useEffect(() => noteEndingsAfterFirstFrame(), []);
  const Body = Demo ?? Managed;
  // The frame keeps every screen clear of the iPhone Duo's clock and knows the window's shape (iphone-duo.md).
  return (
    <AppFrame>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      {fontsReady && Body ? (
        // The last resort, around everything the app draws that no page's own boundary is around (the tab bar, the
        // bridges, the sign-in screens): “This page didn’t load.” with Try again, instead of the app closing.
        <>
          <PageBoundary>
            <Body />
          </PageBoundary>
          {/* A newer Android app, said once per version over whatever screen is open (update-check.md). */}
          {UpdatePrompt ? <UpdatePrompt /> : null}
        </>
      ) : (
        <StartHold>
          <View style={{ flex: 1, backgroundColor: theme.colors.bg }} />
        </StartHold>
      )}
    </AppFrame>
  );
}

export function App() {
  if (Harness && HARNESS_URL)
    return (
      <ThemeProvider store={secureStore}>
        <Harness url={HARNESS_URL} />
      </ThemeProvider>
    );
  // Swipes and drags run on the display thread (react-native-gesture-handler, docs/app/decisions/native-feel.md), and
  // so does following the keyboard: its frame is read there as it moves, also when the window changes size under it
  // (unfolding with the keyboard up). The app already draws under Android's system bars, so the provider leaves them.
  return (
    // Any touch wakes the faces' blinking; they go still after two quiet minutes.
    <GestureHandlerRootView style={{ flex: 1 }} onTouchStart={markFaceActivity}>
      <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
        <SafeAreaProvider>
          <ThemeProvider store={secureStore}>
            <Root />
          </ThemeProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
