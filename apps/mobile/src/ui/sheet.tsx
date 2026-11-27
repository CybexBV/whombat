/**
 * A bottom sheet in the settings sheet's language (not mocked): the dimmed backdrop closes it, a 22dp-radius `bg`
 * panel with the grab handle, the modal shadow and the safe-area bottom. Used by the message menu, the emoji picker,
 * the editor and the conversation menu (essentials AP-502, AP-507, AP-511). The backdrop comes first in the tree, so
 * TalkBack reads the panel after “Close”. On a wide window (the iPhone Duo open) the panel keeps a phone's width in the
 * middle rather than stretching across the fold (docs/app/decisions/iphone-duo.md).
 *
 * On iPhone it is iOS's own sheet (ios-native.md, `modules/whombat-sheet`): the same panel in a form sheet as tall as it
 * is, with the system's grabber, its slide, its drag down to close and its dimming; a tap beside it closes it too.
 * With two pages (the iPhone Duo open) iOS would float its sheet as a card in the middle of the window, across the
 * fold: there the app draws its own, at the bottom of the page it was opened from, that page's width at most.
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SheetPanel } from '../../modules/whombat-sheet';
import { useMobileT } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { bottomPadding } from './insets';
import { usePageFrame, useScreenShape } from './screenShape';

/** The widest a sheet's panel gets. */
export const SHEET_MAX_WIDTH = 560;

export function Sheet({
  visible,
  onClose,
  title,
  label,
  children,
  maxHeight = '85%',
  closeLabel: givenCloseLabel,
  surface = 'bg',
  onDismissed,
}: {
  visible: boolean;
  onClose: () => void;
  /** Once it is down: a screen it opens waits for that, as iOS shows no new screen under a sheet it still shows. */
  onDismissed?: () => void;
  /** A mono label at the top (“MESSAGE”, “NOTIFICATIONS”); none when the content says it. */
  title?: string;
  /** What TalkBack calls the sheet. */
  label: string;
  children: ReactNode;
  maxHeight?: `${number}%`;
  closeLabel?: string;
  /**
   * `sf`: the one-Whombat shell's sheets (mock 4 right: the approval sheet) — the raised surface, 26dp corners and a
   * 40 × 5 grab handle; `bg` (default) the settings sheet's language.
   */
  surface?: 'bg' | 'sf';
}) {
  const { t: tMobile } = useMobileT();
  const closeLabel = givenCloseLabel ?? tMobile('screens2.common.close');
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const screen = useWindowDimensions();
  const raised = surface === 'sf';
  const twoPages = useScreenShape().pages === 2;
  const page = usePageFrame();
  const pageWidth = page.right - page.left;
  const panelWidth = Math.min(SHEET_MAX_WIDTH, pageWidth);
  // What the system covers of the native sheet's sides (the closed Duo's bar under the clock).
  const [sides, setSides] = useState({ left: 0, right: 0 });
  const heading = title ? (
    <Text
      size={11}
      weight={500}
      mono
      tracking={0.05}
      color={theme.colors.mut}
      accessibilityRole="header"
      style={{ paddingHorizontal: 22, paddingTop: 6, paddingBottom: 8 }}
    >
      {title}
    </Text>
  ) : null;
  if (SheetPanel && !twoPages) {
    const color = raised ? theme.colors.sf : theme.colors.bg;
    return (
      <Modal
        visible={visible}
        presentationStyle="formSheet"
        animationType="slide"
        allowSwipeDismissal
        onRequestClose={onClose}
        onDismiss={onDismissed}
        backdropColor={color}
      >
        <SheetPanel
          color={color}
          dark={theme.dark}
          width={SHEET_MAX_WIDTH}
          accessibilityViewIsModal
          accessibilityLabel={label}
          onSides={(e) => setSides(e.nativeEvent)}
          style={{
            paddingLeft: sides.left,
            paddingRight: sides.right,
            // Of the window, not of the sheet, which is as tall as the panel.
            maxHeight: (screen.height * Number.parseFloat(maxHeight)) / 100,
            // The grabber's room on top, where the drawn handle was; the system keeps the home indicator's under it.
            paddingTop: title ? 17 : 21,
            paddingBottom: 12,
            backgroundColor: color,
          }}
        >
          {heading}
          {children}
        </SheetPanel>
      </Modal>
    );
  }
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      onDismiss={onDismissed}
      statusBarTranslucent
    >
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'flex-end' }}>
        {/* Behind the panel and the whole window: on a wide one the sides of the panel are dimmed too. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
          onPress={onClose}
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.ov }]}
        />
        <View
          accessibilityViewIsModal
          accessibilityLabel={label}
          style={{
            maxHeight,
            // On its page, in the middle of it: never across the fold or under the side bar.
            width: panelWidth,
            marginLeft: page.left + (pageWidth - panelWidth) / 2,
            alignSelf: 'flex-start',
            borderTopLeftRadius: raised ? 26 : 22,
            borderTopRightRadius: raised ? 26 : 22,
            backgroundColor: raised ? theme.colors.sf : theme.colors.bg,
            paddingBottom: bottomPadding(raised ? 34 : 24, insets.bottom, 12),
            boxShadow: theme.shadows.modal.boxShadow,
          }}
        >
          <View style={{ alignItems: 'center', paddingTop: raised ? 10 : 8, paddingBottom: title ? 4 : 8 }}>
            <View
              style={{
                width: raised ? 40 : 36,
                height: 5,
                borderRadius: 3,
                backgroundColor: theme.colors.line2,
              }}
            />
          </View>
          {heading}
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** The longest iOS waits for a sheet to go down when it doesn't say it did. */
const SHEET_DOWN_MS = 600;

/**
 * Runs `run` once a closing sheet no longer stands in the way of what it opens; returns its cancel. iOS shows no new
 * sheet or screen under a sheet it still shows, so there it waits for the sheet to go down (its `onDismissed` usually
 * comes first). On Android a sheet is a dialog of its own that a new sheet or screen can open beside while it leaves,
 * and its `onDismissed` never comes: the next frame, once the close has rendered.
 */
export function whenSheetDown(run: () => void): () => void {
  if (Platform.OS === 'ios') {
    const timer = setTimeout(run, SHEET_DOWN_MS);
    return () => clearTimeout(timer);
  }
  const frame = requestAnimationFrame(() => run());
  return () => cancelAnimationFrame(frame);
}

/** Runs something once the sheet is down: on its `onDismissed` (iOS), else {@link whenSheetDown}. */
export function useAfterSheet() {
  const next = useRef<(() => void) | null>(null);
  const cancel = useRef<(() => void) | undefined>(undefined);
  const go = useCallback(() => {
    cancel.current?.();
    const run = next.current;
    next.current = null;
    run?.();
  }, []);
  const later = useCallback(
    (run: () => void) => {
      next.current = run;
      cancel.current?.();
      cancel.current = whenSheetDown(go);
    },
    [go],
  );
  useEffect(() => () => cancel.current?.(), []);
  return { later, onDismissed: go };
}
