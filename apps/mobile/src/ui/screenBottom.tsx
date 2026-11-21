/**
 * The bottom of a screen: whether our tab bar, iOS's tab bar or the window's edge is under it, and how much of it that
 * covers. Lists run on to the edge and pad their end by this much, so nothing opaque cuts them off and the last row
 * still scrolls clear of the home indicator or the gesture area.
 */
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';
import { useContext } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassBarRoomContext } from '../navigation/panes';
import { type BelowScreen, screenBottomRoom } from './insets';
import { useScreenShape } from './screenShape';

/** What is under this screen's bottom edge. */
export function useBelowScreen(): BelowScreen {
  const inTab = useContext(BottomTabBarHeightContext) !== undefined;
  const glass = useContext(GlassBarRoomContext);
  const tabs = useScreenShape().tabs;
  if (glass !== undefined) return 'glass-bar';
  return inTab && tabs === 'bottom' ? 'tab-bar' : 'edge';
}

/** How much of this screen's bottom the system or a tab bar covers: add it to a list's bottom padding. */
export function useBottomRoom(): number {
  const insets = useSafeAreaInsets();
  const below = useBelowScreen();
  const glass = useContext(GlassBarRoomContext);
  return screenBottomRoom(insets.bottom, below, glass ?? 0);
}
