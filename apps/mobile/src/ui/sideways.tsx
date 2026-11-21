/**
 * Something in a list's row that scrolls sideways itself (a table, a code block, an agent's page) keeps a drag that
 * starts on it: its own scrolling blocks the swipe of the row round it (`ui/swipeRow.tsx`), as the gesture handler
 * relates two gestures. Outside a swipe row it is the scroller as it is.
 */
import { createContext, type ReactElement, useContext, useMemo } from 'react';
import { Gesture, GestureDetector, type PanGesture } from 'react-native-gesture-handler';

/** The swipe of the row a scroller sits in; null outside a swipe row. */
export const SwipeGestureContext = createContext<PanGesture | null>(null);

/** Wraps one scroller (a `ScrollView`, a `WebView`): while it scrolls, the row round it doesn't swipe. */
export function KeepsSideways({ children }: { children: ReactElement }) {
  const swipe = useContext(SwipeGestureContext);
  const own = useMemo(() => (swipe ? Gesture.Native().blocksExternalGesture(swipe) : null), [swipe]);
  return own ? <GestureDetector gesture={own}>{children}</GestureDetector> : children;
}
