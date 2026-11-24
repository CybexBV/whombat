/**
 * The Overview arranged by the person on the phone, its small parts (docs/decisions/overview-arranged.md; the
 * mock `docs/design-handoff/overview-arranged/overview.html` at phone width): Arrange beside the
 * title (the gear alone, Done with a check while arranging), the dashed note that says the page is being arranged, the
 * gear on a tile, a figure or a pinned chart (34 drawn, 44 to the finger), a small chart (a line, its wash and a dot at
 * the newest reading) and the bar of parts under Whombat's own counts.
 */
import { ARRANGE_WORDS, type FigureTone } from '@whombat/client';
import { useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { sparkPaths } from '../../data/overviewArranged';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { Check, Settings } from '../../ui/icons';
import { Touchable } from '../../ui/Touchable';
import { hitSlopFor } from '../../ui/touchTarget';

/** The gear's drawn size; its hit area is 44. */
const GEAR = 34;

/** Arrange at the end of the title's row: a round gear, or while arranging a filled “✓ Done”. */
export function ArrangeToggle({ arranging, onPress }: { arranging: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="fade"
      ringRadius={20}
      accessibilityRole="button"
      accessibilityLabel={arranging ? ARRANGE_WORDS.doneLabel : ARRANGE_WORDS.arrangeLabel}
      accessibilityState={{ selected: arranging }}
      hitSlop={hitSlopFor(40)}
      style={{
        height: 40,
        minWidth: 40,
        borderRadius: 20,
        paddingHorizontal: arranging ? 14 : 0,
        marginRight: 4,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        borderWidth: 1,
        borderColor: arranging ? theme.colors.btn : theme.colors.line2,
        backgroundColor: arranging ? theme.colors.btn : 'transparent',
      }}
    >
      {arranging ? (
        <>
          <Check size={16} color={theme.colors.btnfg} strokeWidth={2} />
          <Text size={14} weight={500} color={theme.colors.btnfg}>
            {ARRANGE_WORDS.done}
          </Text>
        </>
      ) : (
        <Settings size={18} color={theme.colors.ink2} strokeWidth={1.75} />
      )}
    </Touchable>
  );
}

/** “Arranging the Overview.” and what to do, in a dashed box under the title; what couldn't be saved under it. */
export function ArrangeBar({ failed }: { failed: boolean }) {
  const theme = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        borderRadius: 14,
        borderWidth: 1.5,
        borderStyle: 'dashed',
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sel,
        paddingVertical: 12,
        paddingHorizontal: 16,
        gap: 6,
      }}
    >
      <Text size={14.5} lh={1.45} color={theme.colors.ink2}>
        <Text size={14.5} weight={600} color={theme.colors.ink}>
          {ARRANGE_WORDS.barTitle}
        </Text>{' '}
        {ARRANGE_WORDS.barBodyPhone}
      </Text>
      {failed ? (
        <Text size={14} weight={500} lh={1.45} color={theme.colors.bad}>
          {ARRANGE_WORDS.couldntSave}
        </Text>
      ) : null}
    </View>
  );
}

/** A gear on a tile, a figure or a pinned chart while arranging: 34 drawn on `sf` with a hairline ring, 44 to touch. */
export function GearButton({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={10}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={hitSlopFor(GEAR)}
      style={{
        width: GEAR,
        height: GEAR,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Settings size={17} color={theme.colors.ink2} strokeWidth={1.75} />
    </Touchable>
  );
}

/** A figure's tone as a colour: what is wrong in `bad`, what needs a look in `warnText`, else none. */
export function useToneColor() {
  const theme = useTheme();
  return (tone: FigureTone | 'mut' | null | undefined, fallback: string) =>
    tone === 'bad'
      ? theme.colors.bad
      : tone === 'warn'
        ? theme.colors.warnText
        : tone === 'mut'
          ? theme.colors.mut
          : fallback;
}

/**
 * A small chart (the mock's `.sp`): the line 1.75 in `chart1` over its wash, a dot at the newest reading with a ring
 * of the card's colour. Decorative: the figure beside it says it.
 */
export function Spark({
  points,
  height,
  color,
}: {
  points: readonly number[];
  height: number;
  color?: string;
}) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  // Room at the right for the newest reading's dot.
  const paths = width > 8 ? sparkPaths(points, width - 4, height) : null;
  if (points.length < 2) return null;
  const stroke = color ?? theme.chart.chart1;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ height }}
    >
      {paths ? (
        <Svg width={width} height={height}>
          <Path d={paths.area} fill={stroke} fillOpacity={Number(theme.chart.chartWash) * 1.6} />
          <Path
            d={paths.line}
            fill="none"
            stroke={stroke}
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <Circle cx={paths.end.x} cy={paths.end.y} r={5} fill={theme.colors.sf} />
          <Circle cx={paths.end.x} cy={paths.end.y} r={3.5} fill={stroke} />
        </Svg>
      ) : null}
    </View>
  );
}

/** Whombat's own counts as a bar of parts (the mock's `.stack`): fine in `ok`, a look in `warn`, wrong in `bad`. */
export function PartsBar({ parts }: { parts: readonly { tone: FigureTone; n: number }[] }) {
  const theme = useTheme();
  const total = parts.reduce((s, p) => s + p.n, 0);
  if (!total) return null;
  const color = (tone: FigureTone) =>
    tone === 'ok'
      ? theme.colors.ok
      : tone === 'warn'
        ? theme.colors.warn
        : tone === 'bad'
          ? theme.colors.bad
          : theme.colors.line2;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', gap: 2, marginTop: 12 }}
    >
      {parts
        .filter((p) => p.n > 0)
        .map((p) => (
          <View key={p.tone} style={{ flex: p.n, backgroundColor: color(p.tone) }} />
        ))}
    </View>
  );
}
