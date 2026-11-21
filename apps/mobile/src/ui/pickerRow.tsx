/**
 * A choice as a row of a grouped list: what it is on the left, the chosen one on the right with ⌃⌄, opening the app's
 * menu of the choices (`nativeMenu.tsx`): iOS's own menu from the row on iPhone, a sheet with the chosen one ticked
 * elsewhere. 48pt tall, read as one button (“Seat 2, Model: GPT 6.1 Sol”). Without anything to choose it is a plain
 * line. A pick comes back as the menu item's id.
 */
import { useState } from 'react';
import { View } from 'react-native';
import type { NativeMenuSpec } from '../data/nativeMenu';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ChevronsUpDown } from './icons';
import { hasNativeMenu, MenuSheet, NativeMenu } from './nativeMenu';
import { Touchable } from './Touchable';

const ROW = {
  minHeight: 48,
  flexDirection: 'row',
  alignItems: 'center',
  gap: 12,
  paddingVertical: 12,
  paddingHorizontal: 16,
} as const;

export function PickerRow({
  label,
  value,
  menu,
  enabled = true,
  spoken,
  onPick,
  last = false,
}: {
  label: string;
  value: string;
  menu: NativeMenuSpec;
  enabled?: boolean;
  /** What VoiceOver and TalkBack read for the row. */
  spoken: string;
  onPick: (id: string) => void;
  /** The group's last row: no line under it. */
  last?: boolean;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const line = last ? null : { borderBottomWidth: 1, borderBottomColor: theme.colors.line };
  const look = (
    <>
      <Text size={15.5} weight={500} numberOfLines={1} style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Text
        size={15}
        color={enabled ? theme.colors.ink2 : theme.colors.mut}
        numberOfLines={1}
        style={{ flex: 1, minWidth: 0, textAlign: 'right' }}
      >
        {value}
      </Text>
      {enabled ? <ChevronsUpDown size={16} color={theme.colors.mut} strokeWidth={2} /> : null}
    </>
  );
  if (!enabled)
    return (
      <View accessible accessibilityLabel={spoken} style={[ROW, line]}>
        {look}
      </View>
    );
  if (hasNativeMenu)
    return (
      <NativeMenu spec={menu} onPick={onPick} trigger="tap" label={spoken} style={line ?? undefined}>
        <View style={ROW}>{look}</View>
      </NativeMenu>
    );
  return (
    <>
      <Touchable
        onPress={() => setOpen(true)}
        feedback="wash"
        accessibilityLabel={spoken}
        accessibilityState={{ expanded: open }}
        style={[ROW, line]}
      >
        {look}
      </Touchable>
      <MenuSheet spec={menu} visible={open} label={label} onClose={() => setOpen(false)} onPick={onPick} />
    </>
  );
}
