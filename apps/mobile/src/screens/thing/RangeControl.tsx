/**
 * The range control of a Summary on the phone (Whombat dashboards.md DS-03, DS-16, connections-page.md CN-05;
 * dashboards-mobile.md AP-2122, connections-page.md AP-2560): at the top, or inside an opened figure when every chart
 * sits behind one — the server page's segmented control with the ranges the page offers (“1h · 6h · 24h · 7d · 30d”, each
 * read as “Last 24 hours”), sharing the width; picking one reads the page again while the charts keep the previous
 * range's lines. A server's says “Live · every 10 s” under it, with a green dot (its figures follow the live events).
 * 38dp tall, padded to 44dp.
 */

import type { HostSeriesRange } from '@whombat/core';
import { View } from 'react-native';
import { dashboardCopy, type RangeOption } from '../../data/dashboard';
import { useI18n } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { Touchable } from '../../ui/Touchable';
import { hitSlopFor } from '../../ui/touchTarget';

export function RangeControl({
  options,
  value,
  onChange,
  live = null,
}: {
  options: readonly RangeOption[];
  value: HostSeriesRange;
  onChange: (range: HostSeriesRange) => void;
  /** “Live · every 10 s” (servers only). */
  live?: string | null;
}) {
  const { rawLocale } = useI18n();
  const dashboardCopyHere = dashboardCopy(rawLocale);

  const theme = useTheme();
  if (!options.length) return null;
  return (
    <View style={{ gap: 6 }}>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={dashboardCopyHere.range}
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
              accessibilityLabel={o.spoken}
              onPress={() => onChange(o.value)}
              feedback={selected ? 'none' : 'wash'}
              ringRadius={8}
              hitSlop={hitSlopFor(38)}
              style={{
                flex: 1,
                minHeight: 38,
                borderRadius: 8,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: selected ? theme.colors.btn : 'transparent',
              }}
            >
              <Text
                size={13.5}
                weight={selected ? 600 : 500}
                mono
                color={selected ? theme.colors.btnfg : theme.colors.ink}
                numberOfLines={1}
              >
                {o.label}
              </Text>
            </Touchable>
          );
        })}
      </View>
      {live ? <LiveLine text={live} /> : null}
    </View>
  );
}

/**
 * “Live · every 10 s” with its green dot: under the range control, or alone at the top of a Summary whose range control
 * moved into an opened figure (connections-page.md AP-2560).
 */
export function LiveLine({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={text}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 2 }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.ok }} />
      <Text size={12} color={theme.colors.mut}>
        {text}
      </Text>
    </View>
  );
}
