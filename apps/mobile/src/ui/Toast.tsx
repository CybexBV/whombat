/**
 * The toast with Undo (quiet-notices-mobile.md AP-4864; the store is `data/toast.ts`): bottom-centre over the page
 * it is about (`toastPlacement`: with two pages the one beside the list, never over the side tabs or the crease), clear
 * of the tab bar and above the keyboard, on `btn` with the toast's shadow and a 14dp radius (README “Toast”), the words in
 * `btnfg` and a 44dp **Undo** in bold after them. Polite live region, so TalkBack says the words when it shows (VoiceOver
 * is told them); it stays twice as long while a screen reader is on, and with VoiceOver one with Undo stays until its ✕. Mounted once, after the navigator, so it floats over the screens (and so TalkBack
 * reaches it last, after the screen it is about).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform, useWindowDimensions, View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toastPlacement } from '../data/screenShape';
import { ACTION_TOAST_MS, TOAST_COPY, toasts } from '../data/toast';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { X } from './icons';
import { tabBarBottomPadding } from './insets';
import { useListWidth, useScreenShape } from './screenShape';
import { Touchable } from './Touchable';

/** The tab bar's height over its bottom padding (9 on top, the 44dp tabs, a little air): the toast sits above it. */
const ABOVE_TAB_BAR = 64;

export function ToastHost() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useSyncExternalStore(toasts.subscribe, toasts.get, toasts.get);
  const shape = useScreenShape();
  const window = useWindowDimensions();
  const listWidth = useListWidth();
  const keyboard = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  useEffect(() => {
    let alive = true;
    const reader = (on: boolean) => {
      if (!alive) return;
      toasts.setSlow(on);
      // VoiceOver may take a while to reach Undo: it stays until dismissed there.
      toasts.setStay(on && Platform.OS === 'ios');
    };
    void AccessibilityInfo.isScreenReaderEnabled().then(reader);
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', reader);
    // Android's accessibility timeout for controls (Settings → Accessibility → Time to take action).
    if (Platform.OS === 'android')
      void AccessibilityInfo.getRecommendedTimeoutMillis(ACTION_TOAST_MS).then((ms) => {
        if (alive) toasts.setActionFloor(ms);
      });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  // VoiceOver doesn't follow live regions: the toast's words are announced when it shows.
  useEffect(() => {
    if (toast && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(toast.spoken);
  }, [toast]);
  const stays = !!toast?.action && toasts.stays();
  if (!toast) return null;
  const at = toastPlacement({
    shape,
    window,
    listWidth,
    bottomInset: insets.bottom,
    aboveTabs: tabBarBottomPadding(insets.bottom) + ABOVE_TAB_BAR,
    keyboard,
  });
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        ...at,
        alignItems: 'center',
        paddingHorizontal: 16,
      }}
    >
      <View
        accessibilityLiveRegion="polite"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          maxWidth: 520,
          minHeight: 48,
          paddingLeft: 16,
          paddingRight: toast.action ? 4 : 16,
          borderRadius: theme.radii.panel,
          backgroundColor: theme.colors.btn,
          boxShadow: theme.shadows.toast.boxShadow,
        }}
      >
        <Text
          size={14}
          lh={1.4}
          color={theme.colors.btnfg}
          accessibilityLabel={toast.spoken}
          style={{ flexShrink: 1, paddingVertical: 12 }}
        >
          {toast.text}
        </Text>
        {toast.action ? (
          <Touchable
            onPress={() => toasts.press(toast.id)}
            feedback="fade"
            ringRadius={10}
            accessibilityLabel={toast.action.label}
            accessibilityHint={TOAST_COPY.undoHint(toast.text)}
            style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 12, justifyContent: 'center' }}
          >
            <Text size={14} weight={700} color={theme.colors.btnfg}>
              {toast.action.label}
            </Text>
          </Touchable>
        ) : null}
        {stays ? (
          <Touchable
            onPress={() => toasts.dismiss(toast.id)}
            feedback="fade"
            ringRadius={10}
            accessibilityLabel={TOAST_COPY.dismiss}
            style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <X size={16} color={theme.colors.btnfg} strokeWidth={2} />
          </Touchable>
        ) : null}
      </View>
    </View>
  );
}
