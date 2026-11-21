/**
 * The small pieces NETWORK, BLUETOOTH and their sheets share (hardware-support-android.md AP-3253, bluetooth-android.md
 * AP-3752): the signal's four bars, a change's mark (a spinner while it runs, then its dot) and a Bluetooth device's kind
 * icon. Decoration only: the words beside them say it.
 */
import type { BluetoothIcon, WifiSignal } from '@whombat/client';
import type { ComponentType } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useTheme } from '../theme/theme';
import { Bluetooth, Gamepad2, Headphones, Headset, Keyboard, Mouse, Speaker } from '../ui/icons';
import { type Dot, dotColor } from './ui';

/** The shared model's Lucide names (`BLUETOOTH_KIND_ICONS`) as the phone's icons. */
const KIND_ICONS: Record<
  BluetoothIcon,
  ComponentType<{ size: number; color: string; strokeWidth: number }>
> = {
  keyboard: Keyboard,
  mouse: Mouse,
  headphones: Headphones,
  headset: Headset,
  speaker: Speaker,
  'gamepad-2': Gamepad2,
  bluetooth: Bluetooth,
};

/** A device's kind (a keyboard, headphones, the Bluetooth mark for Device) in `ink2`, 20dp; the words say it. */
export function KindIcon({ icon, color }: { icon: BluetoothIcon; color?: string }) {
  const theme = useTheme();
  const Icon = KIND_ICONS[icon] ?? Bluetooth;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ width: 20, alignItems: 'center' }}
    >
      <Icon size={20} color={color ?? theme.colors.ink2} strokeWidth={1.75} />
    </View>
  );
}

/** The change's mark in the dot's place: a small spinner while it runs, else its dot. */
export function ChangeMark({ dot, running }: { dot: Dot; running: boolean }) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ width: 8, alignItems: 'center', justifyContent: 'center', overflow: 'visible' }}
    >
      {running ? (
        <ActivityIndicator size={14} color={theme.colors.mut} />
      ) : (
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor(theme, dot) }} />
      )}
    </View>
  );
}

/** Four rising bars, `signal` of them lit (`ink2`, the rest `line2`); decoration, the words say it. Wi-Fi's and Bluetooth's. */
export function SignalBars({ signal }: { signal: WifiSignal }) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, width: 18, height: 14 }}
    >
      {[1, 2, 3, 4].map((n) => (
        <View
          key={n}
          style={{
            flex: 1,
            height: Math.round((14 * n) / 4),
            borderRadius: 1,
            backgroundColor: n <= signal ? theme.colors.ink2 : theme.colors.line2,
          }}
        />
      ))}
    </View>
  );
}
