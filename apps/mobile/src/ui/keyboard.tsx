/**
 * The software keyboard, as `react-native-keyboard-controller` reads it on the UI thread: where it is while it moves
 * (also when the window changes size under it, as unfolding the iPhone Duo with the keyboard up does), so what sits on
 * it moves with it in the same frame.
 */
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import {
  useKeyboardHandler,
  useReanimatedKeyboardAnimation,
  useWindowDimensions,
} from 'react-native-keyboard-controller';
import Reanimated, {
  measure,
  useAnimatedRef,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { scheduleOnUI } from 'react-native-worklets';
import { keyboardOverlap, keyboardPadding } from './insets';

/**
 * A bar's bottom padding that goes from `rest` (keyboard down) to `open` (keyboard up) with the keyboard's own
 * movement: the room for the gesture area is under the keyboard while it is up.
 */
export function useKeyboardPadding(rest: number, open: number) {
  const { progress } = useReanimatedKeyboardAnimation();
  return useAnimatedStyle(
    () => ({ paddingBottom: keyboardPadding(rest, open, progress.value) }),
    [rest, open],
  );
}

/**
 * A screen that keeps what it holds clear of the keyboard by padding its bottom by the part the keyboard covers.
 *
 * It measures itself in the app's window each time the keyboard starts and stops moving, and when its own layout
 * changes (a folding phone opened with the keyboard up). The library's own view measured once, on the phone's screen
 * rather than in the window, so on some phones it lifted a reply box well above the keyboard.
 */
export function KeyboardAvoidingView({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const ref = useAnimatedRef<Reanimated.View>();
  const { height: windowHeight } = useWindowDimensions();
  const keyboard = useSharedValue(0);
  const bottom = useSharedValue(windowHeight);
  const remeasure = () => {
    'worklet';
    const frame = measure(ref);
    if (frame) bottom.value = frame.pageY + frame.height;
  };
  useKeyboardHandler(
    {
      onStart: () => {
        'worklet';
        remeasure();
      },
      onMove: (e) => {
        'worklet';
        keyboard.value = e.height;
      },
      onInteractive: (e) => {
        'worklet';
        keyboard.value = e.height;
      },
      onEnd: (e) => {
        'worklet';
        keyboard.value = e.height;
        remeasure();
      },
    },
    [windowHeight],
  );
  const padding = useAnimatedStyle(
    () => ({ paddingBottom: keyboardOverlap(keyboard.value, windowHeight, bottom.value) }),
    [windowHeight],
  );
  return (
    <Reanimated.View ref={ref} style={[style, padding]} onLayout={() => scheduleOnUI(remeasure)}>
      {children}
    </Reanimated.View>
  );
}
