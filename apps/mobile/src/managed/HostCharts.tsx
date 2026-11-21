/**
 * The charts of “How it’s doing” on the phone (Whombat box-status.md BS-11, BS-12; AP-1152): the app's own SVG, no
 * chart library — 2 px lines with the theme's area wash, hairline grid, columns with 4 px rounded tops and a 2 px gap
 * between stacked parts, a tile's sparkline and meter, the disk's stacked bar. A finger on a chart (a tap, or a drag
 * along it) picks the nearest point: a crosshair and dots mark it and the readout row above the chart says its values
 * (the web's tooltip); without a finger the readout says the latest. TalkBack reads a chart as one adjustable element:
 * its name and what it covers, the readout as its value, swipe up and down to move along it. A Summary's chart card
 * (Whombat dashboards.md DS-06; dashboards-mobile.md AP-2124) adds a fixed bottom (`min`), the limit's words, a dashed
 * forecast into room after the last point (`slots`) and a fourth colour; figures add a small line with its wash
 * (`SmallLine`) and a meter in a tone. Colours only from the theme (`theme.chart`, `theme.colors`).
 */
import { type ReactNode, useState } from 'react';
import { type AccessibilityActionEvent, type GestureResponderEvent, View } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import { fitTicks } from '../data/dashboard';
import {
  areaPath,
  bandAtX,
  type ChartSwatch,
  columnPath,
  columnStack,
  type HostReadout,
  type HostSwatch,
  indexAtX,
  linePath,
  readoutText,
  sparkline,
} from '../data/hostStatus';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';

const AXIS_FONT = textMetrics({ size: 11, family: 'mono' }).fontFamily;
/** An axis letter's width (11 DM Mono, 0.6em). */
const AXIS_CHAR = 6.6;

type Theme = ReturnType<typeof useTheme>;

/** A swatch's colour in this theme: a chart colour, or the warning, serious or muted ink; none is muted. */
export function swatchColor(theme: Theme, swatch: HostSwatch): string {
  switch (swatch) {
    case 'warn':
      return theme.colors.warn;
    case 'bad':
      return theme.colors.bad;
    case 'mut':
    case null:
      return theme.colors.mut;
    default:
      return theme.chart[swatch];
  }
}

/** A swatch's colour in this theme. */
function useSwatch(): (swatch: HostSwatch) => string {
  const theme = useTheme();
  return (swatch) => swatchColor(theme, swatch);
}

/** The room left of a chart for its side words: the longest one and a gap, at least `least`. */
function gutter(words: readonly string[], least: number): number {
  return Math.max(least, Math.ceil(Math.max(0, ...words.map((w) => w.length)) * AXIS_CHAR + 8));
}

/** The element's width once laid out (charts draw to it). */
function useWidth(): [number, (e: { nativeEvent: { layout: { width: number } } }) => void] {
  const [width, setWidth] = useState(0);
  return [width, (e) => setWidth(Math.round(e.nativeEvent.layout.width))];
}

/* Tiles ------------------------------------------------------------------------------------------------------------ */

/** A tile's sparkline (26 high): the line in the meta colour, the latest value as a dot in `color`. Decorative. */
export function Sparkline({ values, color }: { values: readonly (number | null)[]; color: string }) {
  const theme = useTheme();
  const [width, onLayout] = useWidth();
  const height = 26;
  const spark = sparkline(values, width, height);
  return (
    <View
      onLayout={onLayout}
      style={{ height, marginTop: 2 }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {width > 0 ? (
        <Svg width={width} height={height}>
          <Path
            d={spark.path}
            fill="none"
            stroke={theme.colors.mut}
            strokeOpacity={0.55}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
          {spark.dot ? (
            <Circle
              cx={spark.dot.x}
              cy={spark.dot.y}
              r={3}
              fill={color}
              stroke={theme.colors.sf}
              strokeWidth={1.5}
            />
          ) : null}
        </Svg>
      ) : null}
    </View>
  );
}

/**
 * A figure's small line over the page's range (DS-07): 2 px in `color` with its wash under it, scaled to its peak,
 * `height` high. Decorative: the figure says it (and its trend, for TalkBack).
 */
export function SmallLine({
  values,
  color,
  height = 30,
  wash = true,
}: {
  values: readonly (number | null)[];
  color: string;
  height?: number;
  wash?: boolean;
}) {
  const theme = useTheme();
  const [width, onLayout] = useWidth();
  const n = values.length;
  const top = Math.max(0, ...values.map((v) => v ?? 0));
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * (width - 2) + 1 : width / 2);
  const y = (v: number) => height - 1.5 - (top > 0 ? v / top : 0) * (height - 4);
  return (
    <View
      onLayout={onLayout}
      style={{ height }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {width > 0 && n > 1 ? (
        <Svg width={width} height={height}>
          {wash ? (
            <Path
              d={areaPath(values, x, y, height)}
              fill={color}
              fillOpacity={Number(theme.chart.chartWash)}
            />
          ) : null}
          <Path
            d={linePath(values, x, y)}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </Svg>
      ) : null}
    </View>
  );
}

/**
 * A meter: a track (6 high, 3 round) with the used share in `color` (the first chart colour by default). Decorative:
 * what it measures is said beside it. `flush` drops the tile's margins (a bar list's, a table cell's).
 */
export function Meter({
  pct,
  color,
  height = 6,
  flush = false,
}: {
  pct: number;
  color?: string;
  height?: number;
  flush?: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        height,
        borderRadius: height / 2,
        backgroundColor: theme.colors.sf2,
        overflow: 'hidden',
        ...(flush ? {} : { marginTop: 4, marginBottom: 2 }),
      }}
    >
      <View
        style={{
          width: `${Math.max(0, Math.min(100, pct))}%`,
          height: '100%',
          borderRadius: height / 2,
          backgroundColor: color ?? theme.chart.chart1,
        }}
      />
    </View>
  );
}

/* Legend and readout ----------------------------------------------------------------------------------------------- */

/** The series' names under a chart's hint: a line (14 × 2) or a box (9 × 9) in the series' colour. */
export function Legend({
  items,
  box = false,
}: {
  items: { swatch: HostSwatch; label: string }[];
  box?: boolean;
}) {
  const theme = useTheme();
  const color = useSwatch();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 4, marginBottom: 6 }}>
      {items.map((item) => (
        <View key={item.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View
            style={{
              width: box ? 9 : 14,
              height: box ? 9 : 2,
              borderRadius: box ? 2 : 1,
              backgroundColor: color(item.swatch),
            }}
          />
          <Text size={12.5} color={theme.colors.ink2}>
            {item.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The row above a chart: the point's moment or day, then its values in bold with their words (the web's tooltip). */
export function Readout({ readout }: { readout: HostReadout | null }) {
  const theme = useTheme();
  const color = useSwatch();
  return (
    <View
      style={{ minHeight: 34, marginBottom: 6, gap: 2 }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {readout ? (
        <>
          <Text size={12} color={theme.colors.mut}>
            {readout.title}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 2 }}>
            {readout.lines.map((line) => (
              <View key={line.rest} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {line.swatch ? (
                  <View style={{ width: 10, height: 2, backgroundColor: color(line.swatch) }} />
                ) : null}
                <Text size={12} color={theme.colors.mut}>
                  {line.value ? (
                    <Text size={13} weight={600}>
                      {line.value}
                    </Text>
                  ) : null}
                  {line.value ? ` ${line.rest}` : line.rest}
                </Text>
              </View>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

/* The touch frame -------------------------------------------------------------------------------------------------- */

/**
 * A chart's frame: measures its width, turns a finger's position into a point (`pick`), and is the one adjustable
 * element TalkBack reads (`label`, the readout as its value; `step` moves along it).
 */
function ChartFrame({
  height,
  label,
  readout,
  pick,
  step,
  children,
}: {
  height: number;
  label: string;
  readout: HostReadout | null;
  /** A finger at `x` in the frame, `width` wide. */
  pick: (x: number, width: number) => void;
  /** TalkBack's swipe up (1) or down (−1). */
  step: (delta: number) => void;
  children: (width: number) => ReactNode;
}) {
  const [width, onLayout] = useWidth();
  const touch = (e: GestureResponderEvent) => pick(e.nativeEvent.locationX, width);
  return (
    <View
      onLayout={onLayout}
      style={{ height }}
      onStartShouldSetResponder={() => true}
      onResponderGrant={touch}
      onResponderMove={touch}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={readout ? { text: readoutText(readout) } : undefined}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e: AccessibilityActionEvent) =>
        step(e.nativeEvent.actionName === 'increment' ? 1 : -1)
      }
    >
      {width > 0 ? children(width) : null}
    </View>
  );
}

/* Line charts ------------------------------------------------------------------------------------------------------ */

/** One line of a line chart: its values (null: a gap), its colour, and whether a wash fills under it. */
export interface LineSeries {
  key: string;
  values: readonly (number | null)[];
  swatch: ChartSwatch;
  area?: boolean;
}

/** Where the last value is heading (a disk filling up): a dashed line from a point into the room after the last. */
export interface ChartForecast {
  from: { index: number; value: number };
  to: { index: number; value: number };
  label: string;
  swatch: ChartSwatch;
}

const LINE = { left: 34, right: 6, top: 6, bottom: 20 };

/**
 * A line chart over a range's points (Processor, Network speed): the scale's gridlines with their numbers, the time
 * words under it that fit (the first and the last always), the lines, and the picked point's crosshair and dots. A
 * thing page's chart adds a dashed line in `warn` where it gets serious (`mark`, with its words; AP-1957), and a
 * Summary's chart card a fixed bottom (`min`, a disk from 50 %) and a forecast into `slots` after the last point.
 */
export function LineChart({
  series,
  max,
  min = 0,
  ticks,
  tickLabel,
  timeTicks,
  height,
  label,
  readout,
  selected,
  onPick,
  onStep,
  mark = null,
  markLabel = null,
  slots,
  forecast = null,
}: {
  series: readonly LineSeries[];
  max: number;
  /** The scale's bottom (0 unless the axis starts higher). */
  min?: number;
  ticks: readonly number[];
  tickLabel: (v: number) => string;
  timeTicks: readonly { index: number; label: string }[];
  height: number;
  label: string;
  readout: HostReadout | null;
  /** The picked point, or null (no crosshair). */
  selected: number | null;
  onPick: (index: number) => void;
  onStep: (delta: number) => void;
  /** A value on the scale to mark with a dashed line. */
  mark?: number | null;
  /** Its words above it, at the left (“85 °C limit”). */
  markLabel?: string | null;
  /** Places along the bottom (the points, then a forecast's room); the points' count by default. */
  slots?: number;
  forecast?: ChartForecast | null;
}) {
  const theme = useTheme();
  const count = series[0]?.values.length ?? 0;
  const places = Math.max(count, slots ?? count);
  const left = gutter(ticks.map(tickLabel), LINE.left);
  const span = max - min || 1;
  const plot = (width: number) => ({
    x: (i: number) => left + (places > 1 ? i / (places - 1) : 0) * (width - left - LINE.right),
    y: (v: number) =>
      LINE.top + (1 - (Math.max(min, Math.min(v, max)) - min) / span) * (height - LINE.top - LINE.bottom),
  });
  return (
    <ChartFrame
      height={height}
      label={label}
      readout={readout}
      pick={(x, width) => onPick(Math.min(count - 1, indexAtX(x, left, width - left - LINE.right, places)))}
      step={onStep}
    >
      {(width) => {
        const { x, y } = plot(width);
        const last = places - 1;
        const words = fitTicks(timeTicks, x);
        const inside = (v: number | null) => v !== null && v >= min && v <= max;
        return (
          <Svg width={width} height={height} pointerEvents="none">
            {ticks.map((v) => (
              <Line
                key={`g${v}`}
                x1={left}
                x2={width - LINE.right}
                y1={y(v)}
                y2={y(v)}
                stroke={theme.colors.line}
                strokeWidth={1}
              />
            ))}
            {ticks.map((v) => (
              <SvgText
                key={`t${v}`}
                x={left - 6}
                y={y(v) + 3.5}
                textAnchor="end"
                fontFamily={AXIS_FONT}
                fontSize={11}
                fill={theme.colors.mut}
              >
                {tickLabel(v)}
              </SvgText>
            ))}
            {words.map((t) => (
              <SvgText
                key={`x${t.index}`}
                x={x(t.index)}
                y={height - 5}
                textAnchor={t.index === 0 ? 'start' : t.index === last ? 'end' : 'middle'}
                fontFamily={AXIS_FONT}
                fontSize={11}
                fill={theme.colors.mut}
              >
                {t.label}
              </SvgText>
            ))}
            {inside(mark) ? (
              <>
                <Line
                  x1={left}
                  x2={width - LINE.right}
                  y1={y(mark as number)}
                  y2={y(mark as number)}
                  stroke={theme.colors.warn}
                  strokeWidth={1}
                  strokeDasharray="4 4"
                />
                {markLabel ? (
                  <SvgText
                    x={left + 6}
                    y={Math.max(LINE.top + 9, y(mark as number) - 4)}
                    fontFamily={AXIS_FONT}
                    fontSize={10.5}
                    fill={theme.colors.warn}
                  >
                    {markLabel}
                  </SvgText>
                ) : null}
              </>
            ) : null}
            {series.map((s) =>
              s.area ? (
                <Path
                  key={`a${s.key}`}
                  d={areaPath(s.values, x, y, y(Math.max(min, 0)))}
                  fill={swatchColor(theme, s.swatch)}
                  fillOpacity={Number(theme.chart.chartWash)}
                />
              ) : null,
            )}
            {series.map((s) => (
              <Path
                key={`l${s.key}`}
                d={linePath(s.values, x, y)}
                fill="none"
                stroke={swatchColor(theme, s.swatch)}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {forecast ? (
              <>
                <Line
                  x1={x(forecast.from.index)}
                  y1={y(forecast.from.value)}
                  x2={x(forecast.to.index)}
                  y2={y(forecast.to.value)}
                  stroke={swatchColor(theme, forecast.swatch)}
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                />
                <Circle
                  cx={x(forecast.to.index)}
                  cy={y(forecast.to.value)}
                  r={3}
                  fill={swatchColor(theme, forecast.swatch)}
                />
                <SvgText
                  x={x(forecast.to.index) - 6}
                  y={Math.max(LINE.top + 9, y(forecast.to.value) - 6)}
                  textAnchor="end"
                  fontFamily={AXIS_FONT}
                  fontSize={10.5}
                  fill={swatchColor(theme, forecast.swatch)}
                >
                  {forecast.label}
                </SvgText>
              </>
            ) : null}
            {selected !== null ? (
              <>
                <Line
                  x1={x(selected)}
                  x2={x(selected)}
                  y1={LINE.top}
                  y2={height - LINE.bottom}
                  stroke={theme.colors.line2}
                  strokeWidth={1}
                />
                {series.map((s) => {
                  const v = s.values[selected];
                  return v === null || v === undefined ? null : (
                    <Circle
                      key={`d${s.key}`}
                      cx={x(selected)}
                      cy={y(v)}
                      r={4}
                      fill={swatchColor(theme, s.swatch)}
                      stroke={theme.colors.sf}
                      strokeWidth={2}
                    />
                  );
                })}
              </>
            ) : null}
          </Svg>
        );
      }}
    </ChartFrame>
  );
}

/* Columns ---------------------------------------------------------------------------------------------------------- */

/**
 * Columns (Data per day, Tokens): each column's values stacked bottom up in `swatches`' colours, at most 18 wide; with
 * `axis`, the scale's gridlines and numbers on the left and the columns' words under them. The picked column is drawn
 * full, the others a little lighter.
 */
export function ColumnChart({
  columns,
  swatches,
  max,
  ticks,
  tickLabel,
  axis,
  words,
  height,
  label,
  readout,
  selected,
  onPick,
  onStep,
  accent = null,
}: {
  columns: readonly (readonly number[])[];
  swatches: readonly ChartSwatch[];
  max: number;
  /** Gridlines and their numbers; none without an axis. */
  ticks?: readonly number[];
  tickLabel?: (v: number) => string;
  /** The words under the columns (often empty); no axis when absent. */
  axis?: readonly string[];
  /** Or time words at some columns (a Summary's bars): those that fit, the first and the last always. */
  words?: readonly { index: number; label: string }[];
  height: number;
  label: string;
  readout: HostReadout | null;
  selected: number | null;
  onPick: (index: number) => void;
  onStep: (delta: number) => void;
  /** The column that stands out (today in a week): the others lighter, its word stronger, until a finger picks one. */
  accent?: number | null;
}) {
  const theme = useTheme();
  const withAxis = axis !== undefined || words !== undefined;
  const box = withAxis
    ? {
        left: gutter(
          (ticks ?? []).map((v) => tickLabel?.(v) ?? ''),
          34,
        ),
        right: 2,
        top: 4,
        bottom: 20,
      }
    : { left: 2, right: 2, top: 4, bottom: 4 };
  const n = columns.length;
  return (
    <ChartFrame
      height={height}
      label={label}
      readout={readout}
      pick={(x, width) => onPick(bandAtX(x, box.left, width - box.left - box.right, n))}
      step={onStep}
    >
      {(width) => {
        const band = (width - box.left - box.right) / Math.max(1, n);
        const columnWidth = Math.min(18, band * 0.62);
        const y = (v: number) => box.top + (1 - Math.min(v, max) / max) * (height - box.top - box.bottom);
        return (
          <Svg width={width} height={height} pointerEvents="none">
            {withAxis
              ? (ticks ?? []).map((v) => (
                  <Line
                    key={`g${v}`}
                    x1={box.left}
                    x2={width - box.right}
                    y1={y(v)}
                    y2={y(v)}
                    stroke={theme.colors.line}
                    strokeWidth={1}
                  />
                ))
              : null}
            {withAxis
              ? (ticks ?? []).map((v) => (
                  <SvgText
                    key={`t${v}`}
                    x={box.left - 6}
                    y={y(v) + 3.5}
                    textAnchor="end"
                    fontFamily={AXIS_FONT}
                    fontSize={11}
                    fill={theme.colors.mut}
                  >
                    {tickLabel?.(v) ?? ''}
                  </SvgText>
                ))
              : null}
            {columns.map((values, i) => {
              const cx = box.left + band * i + band / 2;
              const dim = selected !== null ? selected !== i : accent !== null && accent !== i;
              return columnStack(values, y).map((part) => (
                <Path
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns and their parts are positional
                  key={`c${i}-${part.index}`}
                  d={columnPath(cx, columnWidth, part.top, part.height, part.radius)}
                  fill={swatchColor(theme, swatches[part.index] ?? 'chart1')}
                  opacity={dim ? 0.55 : 1}
                />
              ));
            })}
            {words
              ? fitTicks(words, (i) => box.left + band * i + band / 2).map((t) => (
                  <SvgText
                    key={`w${t.index}`}
                    x={box.left + band * t.index + band / 2}
                    y={height - 5}
                    textAnchor={t.index === 0 ? 'start' : t.index === n - 1 ? 'end' : 'middle'}
                    fontFamily={AXIS_FONT}
                    fontSize={11}
                    fill={theme.colors.mut}
                  >
                    {t.label}
                  </SvgText>
                ))
              : null}
            {axis
              ? axis.map((word, i) =>
                  word ? (
                    <SvgText
                      // biome-ignore lint/suspicious/noArrayIndexKey: one word per column, by position
                      key={`x${i}`}
                      x={
                        i === n - 1
                          ? box.left + band * i + band / 2 + columnWidth / 2 + 2
                          : box.left + band * i + band / 2
                      }
                      y={height - 5}
                      textAnchor={i === n - 1 ? 'end' : 'middle'}
                      fontFamily={AXIS_FONT}
                      fontSize={11}
                      fill={i === accent ? theme.colors.ink : theme.colors.mut}
                    >
                      {word}
                    </SvgText>
                  ) : null,
                )
              : null}
          </Svg>
        );
      }}
    </ChartFrame>
  );
}

/* The disk --------------------------------------------------------------------------------------------------------- */

/** The disk's stacked bar (14 high, 2 apart, the ends rounded 4): each part as wide as its share. Decorative. */
export function DiskBar({ parts }: { parts: readonly { key: string; bytes: number; color: string }[] }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', gap: 2, height: 14, marginVertical: 10 }}
    >
      {parts.map((p, i) => (
        <View
          key={p.key}
          style={{
            flex: p.bytes,
            backgroundColor: p.color,
            borderTopLeftRadius: i === 0 ? 4 : 0,
            borderBottomLeftRadius: i === 0 ? 4 : 0,
            borderTopRightRadius: i === parts.length - 1 ? 4 : 0,
            borderBottomRightRadius: i === parts.length - 1 ? 4 : 0,
          }}
        />
      ))}
    </View>
  );
}
