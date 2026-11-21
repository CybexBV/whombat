/**
 * `whombat-menu` — the app's menus as iOS draws its own (docs/app/decisions/ios-message-menu.md,
 * docs/app/decisions/ios-native.md): a native view around what the menu is for. A long press opens the menu where it
 * was held (a message, with its quick reactions in a row on top; a list's row); a tap opens it from the view (a ⋯
 * button). Swift only; on Android, in tests and in a build from before it `NativeMenuView` is null and the
 * app's sheet opens instead (`ui/nativeMenu.tsx`).
 */
import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ComponentType, ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

export interface NativeMenuViewProps {
  /** The menu as `src/data/nativeMenu.ts` writes it (JSON). */
  menu: string;
  /** `longPress` (default): the menu opens where the view is held; `tap`: from the view, as a button's. */
  trigger?: 'longPress' | 'tap';
  /** What VoiceOver calls the button, with a tap. */
  label?: string;
  /** The reaction pills' “yours” fill and ring, on the viewer's own reactions in a message's row. */
  mineColor?: string;
  mineRingColor?: string;
  /** A pick, once the menu has gone: its id. */
  onMenuAction: (event: { nativeEvent: { id: string } }) => void;
  /** The menu is showing: letting go now isn't a tap on what it is for. */
  onMenuOpen?: () => void;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

export const NativeMenuView: ComponentType<NativeMenuViewProps> | null = requireOptionalNativeModule(
  'WhombatMenu',
)
  ? requireNativeView<NativeMenuViewProps>('WhombatMenu')
  : null;
