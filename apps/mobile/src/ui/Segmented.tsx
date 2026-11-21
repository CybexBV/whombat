/**
 * The segmented control (was the settings sheet's; settings-tab-android.md AP-2621): for picking a value — the theme, a
 * range, Off · Ask · On. Tabs, which say where you are, are `UnderlineTabs` (AP-2630). 3dp padded container, 11 radius,
 * `line2` border; items 8 radius, the chosen one filled with `btn`. On iPhone it is iOS's own (`Segmented.ios.tsx`).
 */
import { View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import type { SegmentedProps } from './segmentedLook';
import { Touchable } from './Touchable';
import { hitSlopFor } from './touchTarget';

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled = false,
  lines = 1,
  fit = false,
}: SegmentedProps<T>) {
  const theme = useTheme();
  const dense = options.length >= 5;
  const sized = dense || fit;
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={{
        flexDirection: 'row',
        padding: 3,
        borderRadius: 11,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
      }}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Touchable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={o.label}
            disabled={disabled}
            onPress={() => onChange(o.value)}
            feedback={selected ? 'none' : 'wash'}
            ringRadius={8}
            hitSlop={hitSlopFor(38)}
            style={{
              // Five or more (a guest's tabs were, AP-1488; they are UnderlineTabs since AP-2633): each as wide as its
              // words, the rest shared, so long words fit a 360dp phone; fewer share the width equally.
              ...(sized
                ? { flexGrow: 1, flexBasis: 'auto', paddingHorizontal: dense ? 4 : 10 }
                : { flex: 1 }),
              minHeight: 38,
              ...(lines > 1 ? { paddingHorizontal: 6, paddingVertical: 4 } : null),
              borderRadius: 8,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: selected ? theme.colors.btn : 'transparent',
            }}
          >
            <Text
              size={dense ? 13 : 14}
              weight={selected ? 600 : 500}
              color={selected ? theme.colors.btnfg : disabled ? theme.colors.mut : theme.colors.ink}
              numberOfLines={lines}
              style={lines > 1 ? { textAlign: 'center' } : undefined}
            >
              {o.label}
            </Text>
          </Touchable>
        );
      })}
    </View>
  );
}
