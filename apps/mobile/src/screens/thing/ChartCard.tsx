/**
 * A chart card on the phone (Whombat dashboards.md DS-06; dashboards-mobile.md AP-2124…AP-2126): the whole width, its
 * title as the card's mono label, the figure now (26/700, “18 %” · “of 16 threads”) with the average and the peak on
 * the right (“Avg **14.2 %**”, “Peak **63 %** Sun 03:10”), the legend for two lines or more (each line's colour, words
 * and latest figure), the chart — lines with their wash, the limit dashed in `warn` with its words, the forecast dashed
 * to its day, or stacked bars per hour — and up to four small facts under a hairline, two by two. A finger on the chart
 * (or TalkBack's swipe) picks a moment: a crosshair, and a small box at the top says its time and every line's figure
 * (the web's tooltip), on the side away from the finger. Colours only from the theme. `inline` draws it without its card
 * inside an opened figure (connections-page.md AP-2559): the figure now is the figure's own, so it shows only for a
 * second chart, and the title only where the figure opens more than one.
 */
import type { HostSeriesRange, ThingLine, ThingPagePanel } from '@whombat/core';
import { Fragment, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { type ChartCardView, chartCard, lineWords } from '../../data/dashboard';
import type { HostReadout } from '../../data/hostStatus';
import { useI18n } from '../../i18n';
import { ColumnChart, LineChart, swatchColor } from '../../managed/HostCharts';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { MonoLabel, OneCard, toneOf } from '../../ui/assistant';
import { Meta } from './parts';

const CHART_HEIGHT = 150;

export function ChartCard({
  panel,
  range,
  inline = null,
}: {
  panel: Extract<ThingPagePanel, { kind: 'chart' }>;
  range: HostSeriesRange;
  /** Inside an opened figure: no card; its title and its figure now only where asked. */
  inline?: { title: boolean; figure: boolean } | null;
}) {
  const { timeZone } = useBurrowBase();
  const { rawLocale } = useI18n();
  const chart = useMemo(
    () => chartCard(panel, range, timeZone, rawLocale),
    [panel, range, timeZone, rawLocale],
  );
  const [selected, setSelected] = useState<number | null>(null);
  if (!chart) return null;
  // A new range or a refresh may have fewer points than the moment picked.
  const picked = selected !== null && selected < chart.count ? selected : null;
  const readout: HostReadout = picked === null ? chart.latest : chart.readout(picked);
  // TalkBack's swipe moves about a 24th of the range.
  const stride = Math.max(1, Math.round(chart.count / 24));
  const step = (delta: number) =>
    setSelected((s) => Math.max(0, Math.min(chart.count - 1, (s ?? chart.count - 1) + delta * stride)));
  const body = (
    <>
      <FigureRow chart={chart} figure={!inline || inline.figure} />
      {chart.legend.length ? <Legend chart={chart} /> : null}
      <View>
        {chart.bars ? (
          <ColumnChart
            columns={chart.columns}
            swatches={chart.lines.map((l) => l.swatch)}
            max={chart.max}
            ticks={chart.ticks}
            tickLabel={chart.tickLabel}
            {...(chart.labels
              ? { axis: chart.labels, accent: chart.labels.length - 1 }
              : { words: chart.timeTicks })}
            height={CHART_HEIGHT}
            label={chart.spoken}
            readout={readout}
            selected={picked}
            onPick={setSelected}
            onStep={step}
          />
        ) : (
          <LineChart
            series={chart.lines.map((l) => ({
              key: l.key,
              values: l.values,
              swatch: l.swatch,
              area: l.fill,
            }))}
            max={chart.max}
            min={chart.min}
            ticks={chart.ticks}
            tickLabel={chart.tickLabel}
            timeTicks={chart.timeTicks}
            slots={chart.slots}
            height={CHART_HEIGHT}
            label={chart.spoken}
            readout={readout}
            selected={picked}
            onPick={setSelected}
            onStep={step}
            mark={chart.mark?.value ?? null}
            markLabel={chart.mark?.label ?? null}
            forecast={
              chart.forecast ? { ...chart.forecast, swatch: chart.lines[0]?.swatch ?? 'chart1' } : null
            }
          />
        )}
        {picked !== null ? <Bubble readout={readout} right={picked < chart.slots / 2} /> : null}
      </View>
      {chart.foot.length ? <Foot chart={chart} /> : null}
    </>
  );
  if (inline)
    return (
      <View style={{ gap: 8, paddingBottom: 8 }}>
        {inline.title ? <MonoLabel>{chart.title}</MonoLabel> : null}
        {chart.meta ? <Meta text={chart.meta} inline /> : null}
        {body}
      </View>
    );
  return (
    <OneCard meta={chart.meta ?? undefined} label={chart.title}>
      <View style={{ paddingHorizontal: 14, paddingBottom: 12, gap: 8 }}>{body}</View>
    </OneCard>
  );
}

/**
 * The figure now on the left, the average and the peak on the right (under it when they don't fit); without the figure
 * (an opened figure's first chart), the average and the peak alone on the left.
 */
function FigureRow({ chart, figure: withFigure }: { chart: ChartCardView; figure: boolean }) {
  const theme = useTheme();
  const { stats } = chart;
  const figure = withFigure ? chart.figure : null;
  if (!figure && !stats.length) return null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        columnGap: 12,
        rowGap: 4,
      }}
    >
      {figure ? (
        <Text numberOfLines={2} style={{ flexShrink: 1 }}>
          <Text
            size={26}
            weight={700}
            tracking={-0.02}
            color={figure.tone && figure.tone !== 'ok' ? toneOf(theme, figure.tone) : theme.colors.ink}
          >
            {figure.value}
          </Text>
          {figure.rest ? (
            <Text size={13.5} color={theme.colors.mut}>
              {` ${figure.rest}`}
            </Text>
          ) : null}
        </Text>
      ) : null}
      {stats.length ? (
        <View style={{ alignItems: figure ? 'flex-end' : 'flex-start', gap: 2, paddingTop: figure ? 4 : 0 }}>
          {stats.map((line) => (
            <StatLine key={lineWords(line)} line={line} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** “Peak **63 %** Sun 03:10”: grey words, the strong ones in `ink`, semibold. */
function StatLine({ line }: { line: ThingLine }) {
  const theme = useTheme();
  return (
    <Text size={12.5} color={theme.colors.mut} numberOfLines={1}>
      {line.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a line's parts in their order
        <Fragment key={i}>
          <Text
            size={p.mono ? 12 : 12.5}
            mono={!!p.mono}
            weight={p.strong ? 600 : 400}
            color={p.strong ? theme.colors.ink : theme.colors.mut}
          >
            {p.text}
          </Text>
        </Fragment>
      ))}
    </Text>
  );
}

/** Each line's colour (a 12 × 2 dash), its words and its latest figure in bold. Decorative: the chart says them. */
function Legend({ chart }: { chart: ChartCardView }) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 4 }}
    >
      {chart.legend.map((l) => (
        <View key={l.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View
            style={{
              width: chart.bars ? 9 : 12,
              height: chart.bars ? 9 : 2,
              borderRadius: chart.bars ? 2 : 1,
              backgroundColor: swatchColor(theme, l.swatch),
            }}
          />
          <Text size={12.5} color={theme.colors.mut}>
            {l.label}
            {l.latest ? (
              <Text size={12.5} weight={600} color={theme.colors.ink}>
                {` ${l.latest}`}
              </Text>
            ) : null}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The picked moment: its time, then each line's figure with its colour, in a small box over the chart's top. */
function Bubble({ readout, right }: { readout: HostReadout; right: boolean }) {
  const theme = useTheme();
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: 'absolute',
        top: 0,
        ...(right ? { right: 4 } : { left: 40 }),
        maxWidth: '72%',
        gap: 2,
        paddingVertical: 6,
        paddingHorizontal: 9,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
      }}
    >
      <Text size={11.5} mono color={theme.colors.mut}>
        {readout.title}
      </Text>
      {readout.lines.map((l) => (
        <View key={l.rest} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 10, height: 2, backgroundColor: swatchColor(theme, l.swatch) }} />
          <Text size={12} color={theme.colors.mut} numberOfLines={1}>
            <Text size={12.5} weight={600} color={theme.colors.ink}>
              {l.value}
            </Text>
            {` ${l.rest}`}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Up to four small facts under a hairline, two by two: a grey word over its figure (in its tone). */
function Foot({ chart }: { chart: ChartCardView }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        rowGap: 10,
        paddingTop: 10,
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
      }}
    >
      {chart.foot.map((f) => (
        <View
          key={f.label}
          accessible
          accessibilityLabel={`${f.label}: ${f.value}`}
          style={{ width: '50%', gap: 2, paddingRight: 8 }}
        >
          <Text size={12} color={theme.colors.mut} numberOfLines={1}>
            {f.label}
          </Text>
          <Text
            size={13.5}
            weight={600}
            color={f.tone && f.tone !== 'ok' ? toneOf(theme, f.tone) : theme.colors.ink}
            numberOfLines={1}
          >
            {f.value}
          </Text>
        </View>
      ))}
    </View>
  );
}
