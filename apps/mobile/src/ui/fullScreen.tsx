/**
 * A full-screen viewer over the app (a picture, a page, the camera): React Native's `Modal` with its own safe area.
 * The screens' safe area is measured inside the frame beside the side tabs, which hides the iPhone Duo's strip under
 * the clock (right: 0); a modal covers the whole window, so it measures again and keeps its buttons out of the strip.
 */
import type { ReactNode } from 'react';
import { Modal, View } from 'react-native';
import { type EdgeInsets, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/theme';

export function FullScreenModal({
  visible = true,
  onClose,
  animationType = 'fade',
  children,
}: {
  visible?: boolean;
  onClose: () => void;
  animationType?: 'fade' | 'slide';
  /** What fills it, inside its safe area; a function gets the insets for sizing what it shows. */
  children: ReactNode | ((insets: EdgeInsets) => ReactNode);
}) {
  const theme = useTheme();
  return (
    <Modal visible={visible} animationType={animationType} onRequestClose={onClose} statusBarTranslucent>
      <SafeAreaProvider style={{ flex: 1, backgroundColor: theme.colors.bg }}>
        <SafeBody>{children}</SafeBody>
      </SafeAreaProvider>
    </Modal>
  );
}

function SafeBody({ children }: { children: ReactNode | ((insets: EdgeInsets) => ReactNode) }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.bg,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      {typeof children === 'function' ? children(insets) : children}
    </View>
  );
}
