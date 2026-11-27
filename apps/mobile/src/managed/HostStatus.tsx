/**
 * “How it’s doing” on This Whombat's Overview (Whombat box-status.md BS-01, BS-10, BS-12; AP-1150…AP-1154;
 * this-whombat-sections-android.md AP-1245), on a Whombat with `host.metrics`: live while the screen is in front
 * (`useHostStatus`), the range under the section's title as on the web (it scopes the Processor tile and the
 * Processor and Network speed charts), the four tiles in a 2 × 2 grid, then “Show charts”: one chart at a time picked
 * with chips — Processor, Network speed, Data per day, Disk — until “Hide charts”, opened for the rest of the app's
 * session. Without a manager (`not_managed`) nothing; when the measurements can't be read, the contracts' sentence.
 * What the AI used is Spend's, in Settings → Advanced, its one place. On a machine with a battery, the power line
 * under the live line (desk-display-android.md AP-3059). Words and numbers come from the shared model
 * (`@whombat/client` `host/`) and the contracts' copy; the button's are `THIS_WHOMBAT_TEXT`'s.
 */

import {
  HOST_CPU_SCALE,
  type HostPollState,
  hostChartPoints,
  hostDayRows,
  hostDayScale,
  hostDayTick,
  hostDiskBar,
  hostDiskRows,
  hostDiskText,
  hostMeasuringNote,
  hostPeak,
  hostPowerLine,
  hostPowerOf,
  hostSpeedScale,
  hostSpeedTick,
  hostTiles,
  hostTimeTicks,
} from '@whombat/client';
import { thisWhombatText } from '@whombat/client/managed';
import { hostRangeLabels, hostStatusCopy } from '@whombat/core/text';
import type { HostMetrics, HostMetricsRange } from '@whombat/protocol/session';
import { type ReactNode, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import {
  chartLabel,
  cpuMeasured,
  dayReadout,
  type HostChartKey,
  type HostDiskTone,
  hostCharts,
  hostDiskTone,
  hostRangeOptions,
  hostSectionKind,
  nearestMeasured,
  networkReadout,
  processorReadout,
  speedMeasured,
  stepMeasured,
} from '../data/hostStatus';
import { useI18n, useMobileT } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BatteryLow, BatteryMedium, Plug } from '../ui/icons';
import { Chip, SectionLabel, Skeleton } from '../ui/primitives';
import { Segmented } from '../ui/Segmented';
import { Touchable } from '../ui/Touchable';
import { ColumnChart, DiskBar, Legend, LineChart, Meter, Readout, Sparkline } from './HostCharts';
import { useHostStatus } from './useHostStatus';

type Theme = ReturnType<typeof useTheme>;

const cardStyle = (theme: Theme) =>
  ({
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.line,
    backgroundColor: theme.colors.sf,
  }) as const;

/** Whether the charts are open (AP-1245): kept while the app runs, as the web keeps it for the visit. */
let chartsOpen = false;

export function HostStatusSection() {
  const { state, setRange } = useHostStatus();
  return <HostStatusView state={state} onRange={setRange} />;
}

/** The section for a poll state; `onRange` picks another range. */
export function HostStatusView({
  state,
  onRange,
}: {
  state: HostPollState;
  onRange: (range: HostMetricsRange) => void;
}) {
  const { rawLocale } = useI18n();
  const hostStatusCopyHere = hostStatusCopy(rawLocale);

  const theme = useTheme();
  const kind = hostSectionKind(state);
  const [chart, setChart] = useState<HostChartKey>('processor');
  const [open, setOpen] = useState(chartsOpen);
  const toggle = () => {
    chartsOpen = !open;
    setOpen(chartsOpen);
  };
  if (kind === 'none') return null;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ gap: 2 }}>
        <SectionLabel>{hostStatusCopyHere.title.toUpperCase()}</SectionLabel>
        {kind === 'box' || kind === 'loading' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 6 }}>
            <View
              accessibilityElementsHidden
              importantForAccessibility="no"
              style={{
                width: 7,
                height: 7,
                borderRadius: 3.5,
                backgroundColor: theme.colors.presence,
                boxShadow: `0 0 0 3px ${theme.colors.liveHalo}`,
              }}
            />
            <Text size={13.5} color={theme.colors.mut}>
              {hostStatusCopyHere.live}
            </Text>
          </View>
        ) : null}
        {kind === 'box' && state.metrics ? <PowerLine metrics={state.metrics} /> : null}
      </View>

      {kind === 'box' || kind === 'loading' ? (
        <>
          <Segmented
            options={hostRangeOptions(rawLocale)}
            value={state.range}
            onChange={onRange}
            label={hostStatusCopyHere.rangeGroup}
          />
          <View style={{ gap: 10, opacity: state.loading && state.metrics ? 0.55 : 1 }}>
            {state.metrics ? <Tiles metrics={state.metrics} /> : <TileSkeletons />}
            <ChartsToggle open={open} onPress={toggle} />
            {open ? (
              <>
                <ChartChips value={chart} onChange={setChart} />
                {!state.metrics ? (
                  <View style={[cardStyle(theme), { padding: 16, gap: 10 }]}>
                    <Skeleton width="40%" />
                    <Skeleton height={120} radius={8} />
                  </View>
                ) : chart === 'disk' ? (
                  <DiskCard metrics={state.metrics} />
                ) : chart === 'days' ? (
                  <DaysCard metrics={state.metrics} />
                ) : (
                  <LineCard chart={chart} metrics={state.metrics} />
                )}
              </>
            ) : null}
          </View>
        </>
      ) : (
        <Text size={14} lh={1.45} color={theme.colors.ink2} style={{ paddingHorizontal: 6 }}>
          {hostStatusCopyHere.unavailable}
        </Text>
      )}
    </View>
  );
}

/**
 * The box's power under the live line (Whombat desk-display.md DK-10; desk-display-android.md AP-3059): a plug and
 * “Plugged in · battery kept at 80 %” in the meta colour, or a battery and “On battery · 62 % · about 3 h 10 min left”
 * in amber (red, an empty battery, from 15 %), the shared `hostPowerLine`. Nothing on a machine without a battery.
 */
function PowerLine({ metrics }: { metrics: HostMetrics }) {
  const theme = useTheme();
  const line = hostPowerLine(hostPowerOf(metrics.now));
  if (!line) return null;
  const color =
    line.tone === 'bad' ? theme.colors.bad : line.tone === 'warn' ? theme.colors.warn : theme.colors.mut;
  // The web's glyphs (desk-display-web.md AP-3020): the plug, a battery half full, an empty one from 15 %.
  const Icon = line.source === 'ac' ? Plug : line.tone === 'bad' ? BatteryLow : BatteryMedium;
  return (
    <View
      accessible
      accessibilityLabel={line.text}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 6, paddingTop: 4 }}
    >
      <Icon size={15} color={color} strokeWidth={2} />
      <Text size={13.5} weight={line.tone === 'ok' ? 400 : 500} color={color} style={{ flex: 1 }}>
        {line.text}
      </Text>
    </View>
  );
}

/** “Show charts” / “Hide charts” under the tiles (AP-1245): a link-style 44dp button that says whether they're open. */
function ChartsToggle({ open, onPress }: { open: boolean; onPress: () => void }) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const label = open ? thisWhombatText(rawLocale).hideCharts : thisWhombatText(rawLocale).showCharts;
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      feedback="fade"
      ringRadius={8}
      onPress={onPress}
      style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: 6 }}
    >
      <Text
        size={14}
        weight={500}
        color={theme.colors.ink2}
        style={{ textDecorationLine: 'underline', textDecorationColor: theme.colors.line2 }}
      >
        {label}
      </Text>
    </Touchable>
  );
}

/** The chart switcher: the charts' names as chips in a row that scrolls, the picked one scrolled into view. */
function ChartChips({ value, onChange }: { value: HostChartKey; onChange: (chart: HostChartKey) => void }) {
  const scroller = useRef<ScrollView>(null);
  const lefts = useRef(new Map<HostChartKey, number>());
  const { rawLocale } = useI18n();
  return (
    <ScrollView
      ref={scroller}
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      // The chips' 7dp hit slop stays inside the row.
      contentContainerStyle={{ gap: 8, paddingVertical: 7 }}
    >
      {hostCharts(rawLocale).map((c) => (
        <View key={c.value} onLayout={(e) => lefts.current.set(c.value, e.nativeEvent.layout.x)}>
          <Chip
            label={c.label}
            active={value === c.value}
            onPress={() => {
              onChange(c.value);
              scroller.current?.scrollTo({
                x: Math.max(0, (lefts.current.get(c.value) ?? 0) - 24),
                animated: true,
              });
            }}
          />
        </View>
      ))}
    </ScrollView>
  );
}

/* Tiles ------------------------------------------------------------------------------------------------------------ */

function Tile({
  label,
  value,
  unit,
  line,
  meter,
  spark,
}: {
  label: string;
  value: string;
  unit?: string | null;
  line: string | null;
  meter?: number;
  spark?: readonly (number | null)[];
}) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={[label, unit ? `${value} ${unit}` : value, line].filter(Boolean).join(', ')}
      style={[
        cardStyle(theme),
        { flex: 1, minWidth: 0, paddingTop: 13, paddingHorizontal: 14, paddingBottom: 12, gap: 4 },
      ]}
    >
      <Text size={13} weight={500} color={theme.colors.mut}>
        {label}
      </Text>
      <Text size={22} weight={600} tracking={-0.01} numberOfLines={1}>
        {value}
        {unit ? (
          <Text size={13} weight={500} color={theme.colors.mut}>
            {` ${unit}`}
          </Text>
        ) : null}
      </Text>
      {meter !== undefined ? <Meter pct={meter} /> : null}
      {line ? (
        <Text size={12.5} color={theme.colors.mut} numberOfLines={1}>
          {line}
        </Text>
      ) : null}
      {spark ? <Sparkline values={spark} color={theme.chart.chart1} /> : null}
    </View>
  );
}

/** Processor and Memory, then Disk and Today (BS-10, BS-12). */
function Tiles({ metrics }: { metrics: HostMetrics }) {
  const { rawLocale } = useI18n();
  const hostStatusCopyHere = hostStatusCopy(rawLocale);

  const t = hostTiles(metrics, rawLocale);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Tile
          label={hostStatusCopyHere.processor}
          value={t.processor.value}
          line={t.processor.line}
          spark={t.processor.spark}
        />
        <Tile
          label={hostStatusCopyHere.memory}
          value={t.memory.value}
          unit={t.memory.unit}
          meter={t.memory.pct}
          line={t.memory.line}
        />
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Tile
          label={hostStatusCopyHere.disk}
          value={t.disk.value}
          unit={t.disk.unit}
          meter={t.disk.pct}
          line={t.disk.line}
        />
        <Tile
          label={hostStatusCopyHere.today}
          value={t.today.value}
          unit={t.today.unit}
          line={t.today.line}
          spark={t.today.spark}
        />
      </View>
    </View>
  );
}

/** Before the first answer: the tiles' frames, quiet. */
function TileSkeletons() {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const tile = (key: string) => (
    <View key={key} style={[cardStyle(theme), { flex: 1, padding: 14, gap: 10 }]}>
      <Skeleton width="50%" />
      <Skeleton width="70%" height={20} />
      <Skeleton width="60%" />
    </View>
  );
  return (
    <View style={{ gap: 10 }} accessibilityLabel={tMobile('managed.loading')}>
      <View style={{ flexDirection: 'row', gap: 10 }}>{['a', 'b'].map(tile)}</View>
      <View style={{ flexDirection: 'row', gap: 10 }}>{['c', 'd'].map(tile)}</View>
    </View>
  );
}

/* Charts ----------------------------------------------------------------------------------------------------------- */

/** A chart's card: its title (and an action), its hint, then what it shows (BS-10). */
function StatusCard({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint: string | null;
  action?: ReactNode;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={[cardStyle(theme), { paddingTop: 14, paddingHorizontal: 16, paddingBottom: 12 }]}>
      <View
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}
      >
        <Text size={15} weight={600} accessibilityRole="header">
          {title}
        </Text>
        {action}
      </View>
      {hint ? (
        <Text size={12.5} lh={1.4} color={theme.colors.mut} style={{ marginTop: 2, marginBottom: 8 }}>
          {hint}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

/**
 * The column a finger picked, by its day (a new day moves the columns along), or null: the readout says today and no
 * column is marked.
 */
function usePickedDay<R extends { date: string }>(rows: readonly R[]) {
  const [date, setDate] = useState<string | null>(null);
  const found = date === null ? -1 : rows.findIndex((r) => r.date === date);
  const picked = found < 0 ? null : found;
  const shown = picked ?? rows.length - 1;
  return {
    picked,
    shown,
    pick: (i: number) => setDate(rows[i]?.date ?? null),
    // TalkBack: one day at a time.
    step: (delta: number) =>
      setDate(rows[Math.max(0, Math.min(rows.length - 1, shown + delta))]?.date ?? null),
  };
}

/** Data per day: 14 days, received and sent stacked. */
function DaysCard({ metrics }: { metrics: HostMetrics }) {
  const { rawLocale } = useI18n();
  const hostStatusCopyHere = hostStatusCopy(rawLocale);

  const rows = hostDayRows(metrics.days, rawLocale);
  const scale = hostDayScale(rows);
  const { picked, shown, pick, step } = usePickedDay(rows);
  const row = rows[shown];
  const readout = row ? dayReadout(row, rawLocale) : null;
  return (
    <StatusCard title={hostStatusCopyHere.perDay} hint={hostStatusCopyHere.perDayHint}>
      <Legend
        box
        items={[
          { swatch: 'chart1', label: hostStatusCopyHere.received },
          { swatch: 'chart2', label: hostStatusCopyHere.sent },
        ]}
      />
      <Readout readout={readout} />
      <ColumnChart
        columns={rows.map((r) => [r.inBytes, r.outBytes])}
        swatches={['chart1', 'chart2']}
        max={scale.max}
        ticks={scale.ticks}
        tickLabel={(v) => hostDayTick(v, scale.max, rawLocale)}
        axis={rows.map((r) => r.axis)}
        height={140}
        label={chartLabel(hostStatusCopyHere.perDay, hostStatusCopyHere.perDayHint)}
        readout={readout}
        selected={picked}
        onPick={pick}
        onStep={step}
      />
    </StatusCard>
  );
}

/**
 * Processor (an area) or Network speed (download and upload) over the range. The picked point is kept by its moment, so
 * a poll moving the points along leaves it where it was; a finger on a gap picks the nearest measured point.
 */
function LineCard({ chart, metrics }: { chart: 'processor' | 'network'; metrics: HostMetrics }) {
  const { rawLocale } = useI18n();
  const hostRangeLabelsHere = hostRangeLabels(rawLocale);
  const hostStatusCopyHere = hostStatusCopy(rawLocale);

  const theme = useTheme();
  const [at, setAt] = useState<number | null>(null);
  const range: HostMetricsRange = metrics.series.range;
  const zone = metrics.timeZone;
  const processor = chart === 'processor';
  const points = hostChartPoints(metrics.series);
  const measured = processor ? cpuMeasured : speedMeasured;
  const found = at === null ? -1 : points.findIndex((p) => p.at === at);
  const picked = found < 0 ? null : found;
  const shown = picked ?? nearestMeasured(points, points.length - 1, measured);
  const point = shown === null ? undefined : points[shown];
  const readout = point
    ? processor
      ? processorReadout(point, range, zone, rawLocale)
      : networkReadout(point, range, zone, rawLocale)
    : null;
  const pickIndex = (i: number | null) => setAt(i === null ? null : (points[i]?.at ?? null));
  const scale = processor ? HOST_CPU_SCALE : hostSpeedScale(points);
  const peak = processor ? hostPeak(metrics.series) : null;
  const note = hostMeasuringNote(metrics, rawLocale);
  const title = processor ? hostStatusCopyHere.processor : hostStatusCopyHere.networkSpeed;
  return (
    <StatusCard
      title={title}
      hint={processor ? hostStatusCopyHere.processorHint(metrics.now.cores) : hostStatusCopyHere.networkHint}
    >
      {processor ? null : (
        <Legend
          items={[
            { swatch: 'chart1', label: hostStatusCopyHere.download },
            { swatch: 'chart2', label: hostStatusCopyHere.upload },
          ]}
        />
      )}
      <Readout readout={readout} />
      <LineChart
        series={
          processor
            ? [{ key: 'cpu', values: points.map((p) => p.cpuPct), swatch: 'chart1', area: true }]
            : [
                { key: 'down', values: points.map((p) => p.downBps), swatch: 'chart1' },
                { key: 'up', values: points.map((p) => p.upBps), swatch: 'chart2' },
              ]
        }
        max={scale.max}
        ticks={scale.ticks}
        tickLabel={processor ? (v) => String(Math.round(v)) : hostSpeedTick}
        timeTicks={hostTimeTicks(points, range, zone, rawLocale)}
        height={processor ? 150 : 140}
        label={chartLabel(
          title,
          hostRangeLabelsHere[range],
          peak
            ? hostStatusCopyHere.peak(peak.pct, peak.at, zone)
            : processor
              ? null
              : hostStatusCopyHere.networkHint,
        )}
        readout={readout}
        selected={picked}
        onPick={(i) => pickIndex(nearestMeasured(points, i, measured))}
        // TalkBack moves about a 24th of the range at a time (an hour of a day's).
        onStep={(d) =>
          shown === null
            ? undefined
            : pickIndex(stepMeasured(points, shown, d, Math.max(1, Math.round(points.length / 24)), measured))
        }
      />
      {note ? (
        <Text size={12} lh={1.4} color={theme.colors.mut} style={{ marginTop: 6 }}>
          {note}
        </Text>
      ) : null}
    </StatusCard>
  );
}

/* The disk --------------------------------------------------------------------------------------------------------- */

function toneColor(theme: Theme, tone: HostDiskTone): string {
  if (tone === 'free') return theme.colors.sf2;
  if (tone === 'mut' || tone === 'line2') return theme.colors[tone];
  return theme.chart[tone];
}

/** The data disk's parts as a bar and a legend with sizes, then the system and backup disks (BS-10). */
function DiskCard({ metrics }: { metrics: HostMetrics }) {
  const { rawLocale } = useI18n();
  const hostStatusCopyHere = hostStatusCopy(rawLocale);

  const theme = useTheme();
  const data = metrics.disks.data;
  const known = data.parts !== null;
  const rows = hostDiskRows(data, rawLocale);
  const text = hostDiskText(metrics.disks, rawLocale);
  return (
    <StatusCard title={hostStatusCopyHere.disk} hint={null}>
      <Text size={12.5} lh={1.4} color={theme.colors.mut} style={{ marginTop: 2 }}>
        {text.used}
      </Text>
      <DiskBar
        parts={hostDiskBar(data, rows, rawLocale).map((r) => ({
          key: r.key,
          bytes: r.bytes,
          color: toneColor(theme, hostDiskTone(r.key, known)),
        }))}
      />
      <View style={{ gap: 6 }}>
        {rows.map((r) => {
          const free = r.key === 'free';
          return (
            <View
              key={r.key}
              accessible
              accessibilityLabel={`${r.label}, ${r.value}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
            >
              <View
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 2,
                  backgroundColor: toneColor(theme, hostDiskTone(r.key, known)),
                  ...(free ? { borderWidth: 1, borderColor: theme.colors.line2 } : null),
                }}
              />
              <Text size={13.5} color={free ? theme.colors.mut : theme.colors.ink} style={{ flex: 1 }}>
                {r.label}
              </Text>
              <Text size={12.5} mono color={theme.colors.mut}>
                {r.value}
              </Text>
            </View>
          );
        })}
      </View>
      {text.others.map((line) => (
        <Text key={line} size={12} color={theme.colors.mut} style={{ marginTop: 6 }}>
          {line}
        </Text>
      ))}
    </StatusCard>
  );
}
