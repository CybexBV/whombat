/**
 * `whombat-sheet` — the app's sheets as iOS draws its own (docs/app/decisions/ios-native.md): the panel inside a
 * `Modal` presented as a form sheet, which it sizes to itself, with the system's grabber and the app's colour. Swift
 * only; on Android, in tests and in a build from before it `SheetPanel` is null and `ui/sheet.tsx` draws its own sheet.
 */
import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ComponentType, ReactNode } from 'react';
import type { StyleProp, ViewProps, ViewStyle } from 'react-native';

export interface SheetPanelProps extends Pick<ViewProps, 'accessibilityLabel' | 'accessibilityViewIsModal'> {
  /** The sheet's surface. */
  color: string;
  /** The app's theme is dark. */
  dark: boolean;
  /** The card's width where the window is wide. */
  width: number;
  /** How much of the sheet's sides the system's own things cover: the panel keeps clear of them. */
  onSides?: (event: { nativeEvent: { left: number; right: number } }) => void;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

export const SheetPanel: ComponentType<SheetPanelProps> | null = requireOptionalNativeModule('WhombatSheet')
  ? requireNativeView<SheetPanelProps>('WhombatSheet')
  : null;
