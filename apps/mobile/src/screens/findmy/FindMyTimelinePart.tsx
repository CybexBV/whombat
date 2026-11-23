/**
 * The Find My connection's Timeline tab on the phone (docs/implementation/macos/findmy-timeline.md §1.4, the mockup at
 * phone width): the web's parts stacked. Before it's on, one card to tick whose days to keep; when it's on, the day's
 * bar with Day | Week, everyone's strips (avatars only, as the mockup's narrow layout), one person's day on the Mac's
 * map with the stops numbered and as a list whose durations follow the street, the week with its totals, and the
 * timeline's settings. The words and numbers are the web's (`FIND_MY_TIMELINE_WORDS`, `findMyListRows`, …); days are
 * cut in the phone's time zone on the app's clock (the demo world's own in the demo).
 */
import { HUMAN_TONES, initialsFor } from '@whombat/avatars';
import {
  type FindMyAxis,
  findMyAxis,
  findMyDayMeta,
  findMyDayTitle,
  findMyDeviceTimeZone,
  findMyEvery,
  findMyEveryoneMeta,
  findMyFirstDay,
  findMyFirstName,
  findMyKeptSince,
  findMyLegend,
  findMyListRows,
  findMyMapAsk,
  findMyMinutes,
  findMyNowAt,
  findMyNowMark,
  findMyPickedPerson,
  findMyPlaceOrder,
  findMyStopTones,
  findMyStrip,
  findMyTimelineLines,
  findMyTimelineMarks,
  findMyTimelineOn,
  findMyTimelinePace,
  findMyToday,
  findMyTones,
  findMyWeekDay,
  findMyWeekRange,
  findMyWeekTotals,
  findMyWhoseAfter,
  hostErrorInfo,
  FIND_MY_TIMELINE_WORDS as W,
} from '@whombat/client/hosts';
import {
  useFindMyTimeline,
  useFindMyTimelineAssistant,
  useFindMyTimelineChange,
  useFindMyTimelineFresh,
  useFindMyTimelineMap,
  useHostsFleet,
} from '@whombat/client/hosts/react';
import {
  FIND_MY_TIMELINE_SPAN_MAX,
  type FindMyTimeline,
  type FindMyTimelineDay,
  type FindMyTimelinePerson,
  type FindMyTimelineSegment,
  findMyDateAdd,
  findMyTimelinePins,
} from '@whombat/core';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Switch, View } from 'react-native';
import Svg, { Defs, Line, Pattern, Rect } from 'react-native-svg';
import { HumanAvatar } from '../../avatars/Avatars';
import { useBurrowBase, useNow } from '../../data/BurrowProvider';
import { useAgentWords } from '../../data/useAgent';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { OneCard } from '../../ui/assistant';
import { Check, ChevronLeft, ChevronRight } from '../../ui/icons';
import { Button, ErrorState } from '../../ui/primitives';
import { Segmented } from '../../ui/Segmented';
import { switchColors } from '../../ui/switchColors';
import { Touchable } from '../../ui/Touchable';
import { hitSlopFor } from '../../ui/touchTarget';
import { showFailure, showNotice } from '../feedback';
import { CardQuiet } from '../guest/parts';
import { CardSkeletons } from '../home/OverviewParts';

/** The map's height at phone width (the mockup's). */
const MAP_HEIGHT = 210;
/** The card's inner edge, as the mockup's narrow cards. */
const PAD = 14;

type Theme = ReturnType<typeof useTheme>;
type Mode = 'day' | 'week';

/** The places' colours by tone (`findMyPlaceTone`): the chart series, then one more. */
function placeColour(theme: Theme, tone: number): string {
  return (
    [theme.chart.chart1, theme.chart.chart2, theme.chart.chart3, theme.chart.chart4, theme.colors.mut][
      tone
    ] ?? theme.chart.chart1
  );
}

interface Who {
  person: FindMyTimelinePerson;
  first: string;
  tone: string;
}

interface Ctx {
  slug: string;
  connectionId: string;
  tz: string;
  now: number;
  today: string;
  mac: string;
  order: readonly string[];
  who: Who[];
  timeline: FindMyTimeline;
}

/** The tab of the Find My connection `connectionId`, whose Mac is `serverId`. */
export function FindMyTimelinePart({ connectionId, serverId }: { connectionId: string; serverId: string }) {
  const { slug } = useBurrowBase();
  const tz = useMemo(findMyDeviceTimeZone, []);
  const now = useNow().getTime();
  const today = findMyToday(now, tz);
  const [mode, setMode] = useState<Mode>('day');
  const [chosen, setChosen] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const date = mode === 'week' ? today : (chosen ?? today);
  const days = mode === 'week' ? FIND_MY_TIMELINE_SPAN_MAX : 1;
  const read = useFindMyTimeline({ burrow: slug, connectionId, date, days, tz, live: date === today });
  useFindMyTimelineFresh(connectionId, read.data?.readAt);
  const fleet = useHostsFleet({ params: { burrow: slug } }, { retry: false, staleTime: 60_000 });
  const mac = fleet.data?.servers.find((s) => s.id === serverId)?.name ?? serverId;
  // Each place keeps its colour while the tab is open (Home first).
  const order = useRef<string[]>([]);
  if (read.data) order.current = findMyPlaceOrder(order.current, read.data.days);

  const data = read.data;
  if (!data)
    return read.error ? (
      <ErrorState text={hostErrorInfo(read.error).message} onRetry={() => void read.refetch()} />
    ) : (
      <CardSkeletons label={W.everyone} count={2} />
    );

  const tones = findMyTones(data.people.map((p) => p.id));
  const who: Who[] = data.people.map((person, i) => ({
    person,
    first: findMyFirstName(person.name),
    tone: HUMAN_TONES[tones[i] ?? 0] ?? HUMAN_TONES[0],
  }));
  const ctx: Ctx = { slug, connectionId, tz, now, today, mac, order: order.current, who, timeline: data };
  if (!findMyTimelineOn(data.people)) return <BeforeItsOn ctx={ctx} />;

  const person = findMyPickedPerson(data.people, picked);
  const day = data.days.at(-1);
  return (
    <View style={{ gap: 14, opacity: read.isPlaceholderData ? 0.7 : 1 }}>
      <DayBar
        mode={mode}
        date={date}
        today={today}
        onStep={(n) => setChosen(findMyDateAdd(date, n))}
        onMode={(m) => {
          setMode(m);
          if (m === 'week') setChosen(null);
        }}
      />
      {mode === 'day' ? (
        <>
          <Everyone ctx={ctx} day={day} picked={person} onPick={setPicked} />
          {person && day ? <PersonDay ctx={ctx} day={day} id={person} /> : null}
        </>
      ) : (
        <Week
          ctx={ctx}
          picked={person}
          onPick={setPicked}
          onDay={(d) => {
            setMode('day');
            setChosen(d === today ? null : d);
          }}
        />
      )}
      <Settings ctx={ctx} picked={person} />
    </View>
  );
}

/* The bar ---------------------------------------------------------------------------------------------- */

function StepButton({
  label,
  disabled,
  onPress,
  children,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Touchable
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      feedback="wash"
      ringRadius={10}
      hitSlop={hitSlopFor(36)}
      style={{
        width: 36,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
        opacity: disabled ? 0.35 : 1,
      }}
    >
      {children}
    </Touchable>
  );
}

function DayBar({
  mode,
  date,
  today,
  onStep,
  onMode,
}: {
  mode: Mode;
  date: string;
  today: string;
  onStep: (n: number) => void;
  onMode: (m: Mode) => void;
}) {
  const theme = useTheme();
  const week = mode === 'week';
  const title = findMyDayTitle(date, today);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <StepButton
        label={W.dayBefore}
        disabled={week || date <= findMyFirstDay(today)}
        onPress={() => onStep(-1)}
      >
        <ChevronLeft size={18} color={theme.colors.ink} strokeWidth={2} />
      </StepButton>
      <StepButton label={W.dayAfter} disabled={week || date >= today} onPress={() => onStep(1)}>
        <ChevronRight size={18} color={theme.colors.ink} strokeWidth={2} />
      </StepButton>
      <Text
        size={17}
        weight={700}
        tracking={-0.01}
        numberOfLines={1}
        accessibilityLiveRegion="polite"
        accessibilityLabel={week ? W.lastWeek : `${title.title}, ${title.date}`}
        style={{ flex: 1, marginLeft: 4 }}
      >
        {week ? W.lastWeek : title.title}
      </Text>
      <View style={{ width: 132 }}>
        <Segmented<Mode>
          options={[
            { value: 'day', label: W.day },
            { value: 'week', label: W.week },
          ]}
          value={mode}
          onChange={onMode}
          label={W.dayOrWeek}
        />
      </View>
    </View>
  );
}

/* Strips ----------------------------------------------------------------------------------------------- */

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

function Strip({
  segments,
  day,
  ctx,
  label,
}: {
  segments: readonly FindMyTimelineSegment[];
  day: Pick<FindMyTimelineDay, 'from' | 'to'>;
  ctx: Ctx;
  label: string;
}) {
  const theme = useTheme();
  const parts = findMyStrip(segments, day, ctx.order, ctx.tz);
  const nowAt = findMyNowAt(day, ctx.now);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{ flex: 1, height: 22, borderRadius: 6, overflow: 'hidden', backgroundColor: theme.colors.sf2 }}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern id="trip" patternUnits="userSpaceOnUse" width={5} height={5}>
            <Line x1={0} y1={5} x2={5} y2={0} stroke={theme.colors.mut} strokeWidth={1.5} opacity={0.7} />
          </Pattern>
        </Defs>
        {parts.map((p, i) => {
          const common = { x: pct(p.at), y: 0, height: '100%', width: pct(Math.max(p.width, 0.002)) };
          if (p.kind === 'stay')
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one strip, in order
            return <Rect key={i} {...common} fill={placeColour(theme, p.tone)} />;
          if (p.kind === 'trip')
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one strip, in order
            return <Rect key={i} {...common} fill="url(#trip)" />;
          return (
            <Rect
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one strip, in order
              key={i}
              x={pct(p.at)}
              y={0.5}
              width={pct(Math.max(p.width, 0.002))}
              height={21}
              rx={3}
              fill={theme.colors.sf}
              stroke={theme.colors.line2}
              strokeDasharray="3 2"
            />
          );
        })}
        {nowAt !== null ? (
          <Rect x={pct(nowAt)} y={0} width={2} height="100%" fill={theme.colors.ink} />
        ) : null}
      </Svg>
    </View>
  );
}

/** The axis under the strips: 00:00, 06:00, 12:00, 24:00 and now (a tick near now gives way). */
function Axis({ axis, lead }: { axis: FindMyAxis; lead: number }) {
  const theme = useTheme();
  const [w, setW] = useState(0);
  return (
    <View
      style={{ flexDirection: 'row', gap: 10, paddingTop: 4 }}
      importantForAccessibility="no-hide-descendants"
    >
      <View style={{ width: lead }} />
      <View style={{ flex: 1, height: 18 }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
        {w > 0
          ? axis.ticks
              .filter((t) => !t.near)
              .map((t, i, all) => (
                <Text
                  key={t.label}
                  size={10.5}
                  mono
                  color={theme.colors.mut}
                  style={{
                    position: 'absolute',
                    left: t.at * w,
                    width: 44,
                    textAlign: i === 0 ? 'left' : i === all.length - 1 ? 'right' : 'center',
                    transform: [{ translateX: i === 0 ? 0 : i === all.length - 1 ? -44 : -22 }],
                  }}
                >
                  {t.label}
                </Text>
              ))
          : null}
        {w > 0 && axis.now ? (
          <Text
            size={10.5}
            mono
            weight={500}
            style={{
              position: 'absolute',
              left: axis.now.at * w,
              width: 44,
              textAlign: 'center',
              transform: [{ translateX: -22 }],
              backgroundColor: theme.colors.sf,
            }}
          >
            {axis.now.label}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Swatch({ kind, tone, size = 12 }: { kind: 'stay' | 'trip' | 'gap'; tone?: number; size?: number }) {
  const theme = useTheme();
  if (kind === 'stay')
    return (
      <View
        style={{ width: size, height: size, borderRadius: 3, backgroundColor: placeColour(theme, tone ?? 0) }}
      />
    );
  if (kind === 'gap')
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: 3,
          borderWidth: 1,
          borderStyle: 'dashed',
          borderColor: theme.colors.line2,
        }}
      />
    );
  return (
    <Svg width={size} height={size}>
      <Defs>
        <Pattern id="swatch-trip" patternUnits="userSpaceOnUse" width={4} height={4}>
          <Line x1={0} y1={4} x2={4} y2={0} stroke={theme.colors.mut} strokeWidth={1.5} />
        </Pattern>
      </Defs>
      <Rect x={0} y={0} width={size} height={size} rx={3} fill="url(#swatch-trip)" />
    </Svg>
  );
}

function Avatar({ who, size = 30, label }: { who: Who; size?: number; label?: boolean }) {
  return (
    <HumanAvatar
      initials={initialsFor(who.person.name)}
      tone={who.tone}
      size={size}
      label={label ? who.person.name : undefined}
    />
  );
}

/* Everyone --------------------------------------------------------------------------------------------- */

function Everyone({
  ctx,
  day,
  picked,
  onPick,
}: {
  ctx: Ctx;
  day: FindMyTimelineDay | undefined;
  picked: string | null;
  onPick: (id: string) => void;
}) {
  const theme = useTheme();
  const change = useFindMyTimelineChange(ctx.slug, ctx.connectionId);
  if (!day) return null;
  const isToday = day.date === ctx.today;
  const title = findMyDayTitle(day.date, ctx.today).title;
  const segmentsOf = (id: string) => day.people.find((p) => p.person === id)?.segments ?? [];
  const legend = findMyLegend(
    ctx.order,
    ctx.who.filter((w) => w.person.kept).map((w) => segmentsOf(w.person.id)),
  );
  const legendItem = (key: string, swatch: ReactNode, label: string) => (
    <View key={key} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {swatch}
      <Text size={12.5} color={theme.colors.ink2}>
        {label}
      </Text>
    </View>
  );
  return (
    <OneCard label={W.everyone} meta={findMyEveryoneMeta(ctx.timeline, isToday, ctx.tz)}>
      <View style={{ paddingHorizontal: PAD - 6 }}>
        {ctx.who.map((w) => {
          if (!w.person.kept)
            return (
              <View
                key={w.person.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  minHeight: 44,
                  paddingHorizontal: 6,
                }}
              >
                <Avatar who={w} label />
                <View
                  style={{
                    flex: 1,
                    minHeight: 24,
                    flexDirection: 'row',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    paddingHorizontal: 10,
                    borderRadius: 6,
                    borderWidth: 1,
                    borderStyle: 'dashed',
                    borderColor: theme.colors.line2,
                  }}
                >
                  <Text size={12.5} color={theme.colors.mut}>
                    {`${W.notKept} · `}
                  </Text>
                  <Touchable
                    feedback="none"
                    disabled={change.pending}
                    hitSlop={hitSlopFor(20)}
                    accessibilityLabel={W.keepToo(w.first)}
                    onPress={() =>
                      void change
                        .change({
                          kind: 'set',
                          people: findMyWhoseAfter(ctx.timeline.people, w.person.id, true),
                        })
                        .then((problem) => problem && showFailure(problem))
                    }
                  >
                    <Text size={12.5} weight={500} color={theme.colors.brand}>
                      {W.keepToo(w.first)}
                    </Text>
                  </Touchable>
                </View>
              </View>
            );
          const selected = picked === w.person.id;
          return (
            <Touchable
              key={w.person.id}
              feedback="wash"
              ringRadius={10}
              accessibilityState={{ selected }}
              accessibilityLabel={[w.person.name, isToday ? w.person.now?.place : null]
                .filter(Boolean)
                .join(', ')}
              onPress={() => onPick(w.person.id)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                minHeight: 44,
                paddingHorizontal: 6,
                paddingVertical: 7,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: selected ? theme.colors.line2 : 'transparent',
                backgroundColor: selected ? theme.colors.sel : 'transparent',
              }}
            >
              <Avatar who={w} />
              <Strip
                segments={segmentsOf(w.person.id)}
                day={day}
                ctx={ctx}
                label={W.stripLabel(w.first, title)}
              />
            </Touchable>
          );
        })}
        <View style={{ paddingHorizontal: 6 }}>
          <Axis axis={findMyAxis(day, ctx.tz, isToday ? ctx.now : null)} lead={30} />
        </View>
      </View>
      <View
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, columnGap: 14, padding: PAD, paddingTop: 8 }}
      >
        {legend.map((l) => legendItem(l.key, <Swatch kind="stay" tone={l.tone} />, l.label))}
        {legendItem('trip', <Swatch kind="trip" />, W.onTheWay)}
        {legendItem('gap', <Swatch kind="gap" />, W.notRead)}
      </View>
    </OneCard>
  );
}

/* One person's day ------------------------------------------------------------------------------------- */

function PersonDay({ ctx, day, id }: { ctx: Ctx; day: FindMyTimelineDay; id: string }) {
  const theme = useTheme();
  const w = ctx.who.find((x) => x.person.id === id);
  if (!w) return null;
  const segments = day.people.find((p) => p.person === id)?.segments ?? [];
  const rows = findMyListRows(segments, {
    tz: ctx.tz,
    day,
    person: w.person,
    mac: ctx.mac,
    order: ctx.order,
  });
  const pace = findMyTimelinePace(ctx.timeline.paceMinutes);
  return (
    <View
      style={{
        backgroundColor: theme.colors.sf,
        borderWidth: 1,
        borderColor: theme.colors.line,
        borderRadius: 16,
        overflow: 'hidden',
      }}
    >
      <View style={{ padding: PAD, paddingBottom: 10, gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Avatar who={w} />
          <Text
            size={16.5}
            weight={700}
            tracking={-0.01}
            accessibilityRole="header"
            style={{ flexShrink: 1 }}
          >
            {w.person.name}
          </Text>
        </View>
        <Text size={13} color={theme.colors.mut}>
          {findMyDayMeta(segments, w.person)}
        </Text>
      </View>
      <DayMap ctx={ctx} who={w} date={day.date} segments={segments} />
      <View style={{ paddingHorizontal: PAD, paddingVertical: 10, gap: 2 }}>
        <Text size={12.5} lh={1.45} color={theme.colors.mut}>
          {W.linesNote(w.first)}
        </Text>
        <Text size={12.5} lh={1.45} color={theme.colors.mut}>
          {W.spotsNote(findMyMinutes(pace))}
        </Text>
      </View>
      {rows.length === 0 ? (
        <CardQuiet>{W.nothingKept(w.first)}</CardQuiet>
      ) : (
        <View style={{ paddingHorizontal: PAD, paddingTop: 8, paddingBottom: 10 }}>
          {rows.map((r, i) => {
            const first = i === 0;
            const last = i === rows.length - 1;
            const rail =
              r.kind === 'trip'
                ? { borderStyle: 'dashed' as const, borderColor: theme.colors.line2 }
                : r.kind === 'gap'
                  ? { borderStyle: 'dotted' as const, borderColor: theme.colors.mut, opacity: 0.6 }
                  : { borderStyle: 'solid' as const, borderColor: theme.colors.line2 };
            const title = r.kind === 'stay' ? r.place : r.title;
            const sub = r.sub ? `${r.sub} · ${r.duration}` : r.duration;
            return (
              <View
                key={r.key}
                accessible
                accessibilityLabel={[
                  r.time,
                  r.kind === 'stay' ? `${r.n}. ${title}` : title,
                  r.kind === 'stay' && r.ongoing ? W.now : null,
                  sub,
                  ...(r.kind === 'stay' ? r.holes : []),
                ]
                  .filter(Boolean)
                  .join(', ')}
                style={{ flexDirection: 'row', gap: 8, minHeight: 46 }}
              >
                <Text size={12} mono color={theme.colors.ink2} style={{ width: 40, paddingTop: 11 }}>
                  {r.time}
                </Text>
                <View style={{ width: 22, alignItems: 'center' }}>
                  <View
                    style={{
                      position: 'absolute',
                      left: 10,
                      top: first ? 21 : 0,
                      bottom: last ? undefined : 0,
                      height: last ? 21 - (first ? 21 : 0) : undefined,
                      borderLeftWidth: 2,
                      ...rail,
                    }}
                  />
                  {r.kind === 'stay' ? (
                    <View
                      style={{
                        marginTop: 7,
                        minWidth: 28,
                        height: 28,
                        paddingHorizontal: 6,
                        borderRadius: 14,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: placeColour(theme, r.tone),
                        borderWidth: 3,
                        borderColor: theme.colors.sf,
                      }}
                    >
                      <Text size={11} mono weight={500} color={theme.colors.onSolid}>
                        {String(r.n)}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <View style={{ flex: 1, minWidth: 0, paddingVertical: 9, gap: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                    <Text
                      size={r.kind === 'stay' ? 14.5 : 13.5}
                      weight={r.kind === 'stay' ? 600 : 500}
                      color={r.kind === 'stay' ? theme.colors.ink : theme.colors.ink2}
                    >
                      {title}
                    </Text>
                    {r.kind === 'stay' && r.ongoing ? (
                      <View
                        style={{
                          paddingHorizontal: 8,
                          paddingVertical: 1,
                          borderRadius: 999,
                          backgroundColor: theme.colors.btn,
                        }}
                      >
                        <Text size={11} mono weight={500} color={theme.colors.btnfg}>
                          {W.now}
                        </Text>
                      </View>
                    ) : null}
                    {r.kind === 'stay' && r.nearby ? (
                      <View
                        style={{
                          paddingHorizontal: 8,
                          paddingVertical: 1,
                          borderRadius: 999,
                          backgroundColor: theme.colors.sf2,
                        }}
                      >
                        <Text size={11} mono weight={500} color={theme.colors.okText}>
                          {W.nearby}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  <Text size={12.5} lh={1.45} color={theme.colors.mut}>
                    {sub}
                  </Text>
                  {r.kind === 'stay'
                    ? r.holes.map((h) => (
                        <Text key={h} size={12.5} lh={1.45} color={theme.colors.mut}>
                          {h}
                        </Text>
                      ))
                    : null}
                </View>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

/**
 * The person's day on the Mac's map: each distinct spot numbered, dashed lines between the stops in order, dotted where
 * Whombat didn't read in between, and the person over the stop they're at now; a calm line while it draws or when the
 * day has no spot.
 */
function DayMap({
  ctx,
  who,
  date,
  segments,
}: {
  ctx: Ctx;
  who: Who;
  date: string;
  segments: readonly FindMyTimelineSegment[];
}) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const box = { w: width, h: MAP_HEIGHT };
  const spots = findMyTimelinePins(segments).length > 0;
  const map = useFindMyTimelineMap({
    burrow: ctx.slug,
    connectionId: ctx.connectionId,
    person: who.person.id,
    date,
    tz: ctx.tz,
    ask: findMyMapAsk(box),
    dark: theme.dark,
    enabled: spots,
  });
  const shown = spots ? map.shown : null;
  const marks = shown
    ? findMyTimelineMarks(shown.map.points, shown.ask, box, findMyStopTones(segments, ctx.order))
    : [];
  const lines = findMyTimelineLines(segments, marks);
  const here = findMyNowMark(segments, marks);
  const quiet =
    !spots || map.noSpots ? W.noSpots(who.first) : map.error ? hostErrorInfo(map.error).message : null;
  return (
    <View
      onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}
      style={{
        height: MAP_HEIGHT,
        overflow: 'hidden',
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf2,
      }}
    >
      {shown ? (
        <>
          <Image
            source={{ uri: `data:image/${shown.map.format};base64,${shown.map.imageB64}` }}
            resizeMode="cover"
            accessible
            accessibilityLabel={W.mapAlt(who.first)}
            style={{ width: '100%', height: '100%', opacity: map.drawing ? 0.75 : 1 }}
          />
          <Svg
            width={box.w}
            height={box.h}
            style={{ position: 'absolute', left: 0, top: 0 }}
            pointerEvents="none"
          >
            {lines.map((l) => (
              <Line
                key={`${l.x1},${l.y1},${l.x2},${l.y2}`}
                x1={l.x1}
                y1={l.y1}
                x2={l.x2}
                y2={l.y2}
                stroke={theme.colors.ink2}
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeDasharray={l.dotted ? '0.1 5' : '7 5'}
                opacity={l.dotted ? 0.55 : 1}
              />
            ))}
          </Svg>
          {marks.map((m) => (
            <View
              key={m.label}
              pointerEvents="none"
              importantForAccessibility="no-hide-descendants"
              style={{
                position: 'absolute',
                left: m.x - 40,
                top: m.y - 13,
                width: 80,
                alignItems: 'center',
              }}
            >
              <View
                style={{
                  minWidth: 26,
                  height: 26,
                  paddingHorizontal: 7,
                  borderRadius: 13,
                  borderWidth: 2,
                  borderColor: theme.colors.sf,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: placeColour(theme, m.tone),
                }}
              >
                <Text size={11} mono weight={500} color={theme.colors.onSolid}>
                  {m.label}
                </Text>
              </View>
            </View>
          ))}
          {here ? (
            <View
              pointerEvents="none"
              importantForAccessibility="no-hide-descendants"
              style={{
                position: 'absolute',
                left: here.x - 17,
                top: here.y - 13 - 6 - 34,
                width: 34,
                alignItems: 'center',
              }}
            >
              <View style={{ borderRadius: 17, borderWidth: 2, borderColor: theme.colors.sf }}>
                <HumanAvatar initials={initialsFor(who.person.name)} tone={who.tone} size={30} />
              </View>
              <View style={{ width: 1.5, height: 6, backgroundColor: theme.colors.ink2 }} />
            </View>
          ) : null}
        </>
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
          {quiet ? (
            <Text
              size={13.5}
              lh={1.45}
              color={theme.colors.mut}
              accessibilityLiveRegion="polite"
              style={{ textAlign: 'center' }}
            >
              {quiet}
            </Text>
          ) : (
            <ActivityIndicator color={theme.colors.mut} accessibilityLabel={W.drawing} />
          )}
        </View>
      )}
    </View>
  );
}

/* The week --------------------------------------------------------------------------------------------- */

function Week({
  ctx,
  picked,
  onPick,
  onDay,
}: {
  ctx: Ctx;
  picked: string | null;
  onPick: (id: string) => void;
  onDay: (date: string) => void;
}) {
  const theme = useTheme();
  const kept = ctx.who.filter((w) => w.person.kept);
  const w = kept.find((x) => x.person.id === picked) ?? kept[0];
  if (!w) return null;
  const days = ctx.timeline.days;
  const segmentsOf = (d: FindMyTimelineDay) => d.people.find((p) => p.person === w.person.id)?.segments ?? [];
  const totals = findMyWeekTotals(days.map(segmentsOf), ctx.order);
  const first = days[0];
  const last = days.at(-1);
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {kept.map((k) => {
          const on = k.person.id === w.person.id;
          return (
            <Touchable
              key={k.person.id}
              feedback={on ? 'none' : 'wash'}
              ringRadius={999}
              accessibilityState={{ selected: on }}
              accessibilityLabel={k.person.name}
              onPress={() => onPick(k.person.id)}
              hitSlop={hitSlopFor(38)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                minHeight: 38,
                paddingLeft: 4,
                paddingRight: 12,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: on ? theme.colors.btn : theme.colors.line2,
                backgroundColor: on ? theme.colors.btn : theme.colors.sf,
              }}
            >
              <Avatar who={k} size={28} />
              <Text size={13.5} weight={500} color={on ? theme.colors.btnfg : theme.colors.ink}>
                {k.first}
              </Text>
            </Touchable>
          );
        })}
      </View>
      <OneCard
        label={W.weekTitle(w.first)}
        meta={first && last ? findMyWeekRange(first.date, last.date) : null}
      >
        <View style={{ paddingHorizontal: PAD - 6 }}>
          {days.map((d) => {
            const isToday = d.date === ctx.today;
            const name = isToday ? W.today : findMyWeekDay(d.date);
            return (
              <Touchable
                key={d.date}
                feedback="wash"
                ringRadius={10}
                accessibilityLabel={`${name}, ${W.weekTitle(w.first)}`}
                onPress={() => onDay(d.date)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  minHeight: 44,
                  paddingHorizontal: 6,
                  borderRadius: 10,
                }}
              >
                <Text
                  size={13.5}
                  weight={isToday ? 600 : 400}
                  color={isToday ? theme.colors.ink : theme.colors.ink2}
                  style={{ width: 52 }}
                >
                  {name}
                </Text>
                <Strip segments={segmentsOf(d)} day={d} ctx={ctx} label={W.stripLabel(w.first, name)} />
              </Touchable>
            );
          })}
          {last ? (
            <View style={{ paddingHorizontal: 6 }}>
              <Axis axis={findMyAxis(last, ctx.tz, null)} lead={52} />
            </View>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: PAD, paddingTop: 10 }}>
          {totals.map((t) => (
            <View
              key={t.key}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 9,
                paddingVertical: 4,
                borderRadius: 8,
                backgroundColor: theme.colors.sf2,
              }}
            >
              <Swatch
                kind={t.tone === 'trip' ? 'trip' : t.tone === 'gap' ? 'gap' : 'stay'}
                tone={typeof t.tone === 'number' ? t.tone : undefined}
                size={9}
              />
              <Text size={12.5} color={theme.colors.ink2}>
                {`${t.label} `}
              </Text>
              <Text size={12} mono weight={500}>
                {t.value}
              </Text>
            </View>
          ))}
        </View>
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
            paddingHorizontal: PAD,
            paddingVertical: 10,
          }}
        >
          <Text size={12.5} color={theme.colors.mut}>
            {W.pickDay}
          </Text>
        </View>
      </OneCard>
    </>
  );
}

/* Tick boxes ------------------------------------------------------------------------------------------- */

function TickRow({
  who,
  checked,
  note,
  disabled,
  onChange,
}: {
  who: Who;
  checked: boolean;
  note?: string | null;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      feedback="wash"
      ringRadius={10}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={W.keepLabel(who.first)}
      accessibilityHint={note ?? undefined}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingVertical: 4 }}
    >
      <Avatar who={who} size={28} />
      <Text size={14.5} numberOfLines={1} style={{ flex: 1 }}>
        {who.person.name}
      </Text>
      {note ? (
        <Text size={12.5} color={theme.colors.mut}>
          {note}
        </Text>
      ) : null}
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          borderWidth: 1.5,
          borderColor: checked ? theme.colors.btn : theme.colors.line2,
          backgroundColor: checked ? theme.colors.btn : theme.colors.sf,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked ? <Check size={15} color={theme.colors.btnfg} strokeWidth={2.5} /> : null}
      </View>
    </Touchable>
  );
}

/* Before it's on --------------------------------------------------------------------------------------- */

function BeforeItsOn({ ctx }: { ctx: Ctx }) {
  const theme = useTheme();
  const change = useFindMyTimelineChange(ctx.slug, ctx.connectionId);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const every = findMyEvery(findMyTimelinePace(ctx.timeline.paceMinutes));
  return (
    <View
      style={{
        backgroundColor: theme.colors.sf,
        borderWidth: 1,
        borderColor: theme.colors.line,
        borderRadius: 16,
        paddingHorizontal: 16,
        paddingVertical: 20,
        gap: 14,
      }}
    >
      <Text size={21} weight={700} tracking={-0.01} accessibilityRole="header">
        {W.introTitle}
      </Text>
      <Text size={14.5} lh={1.45} color={theme.colors.ink2}>
        {W.introBody}
      </Text>
      <View style={{ gap: 8 }}>
        {[W.introPlaces(every), W.introOnly, W.introDays].map((line) => (
          <View key={line} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
            <Check size={16} color={theme.colors.ok} strokeWidth={2} style={{ marginTop: 2 }} />
            <Text size={13.5} lh={1.45} color={theme.colors.ink2} style={{ flex: 1 }}>
              {line}
            </Text>
          </View>
        ))}
      </View>
      {ctx.who.length === 0 ? (
        <Text size={13.5} lh={1.45} color={theme.colors.mut}>
          {W.noRead}
        </Text>
      ) : (
        <View>
          {ctx.who.map((w) => (
            <TickRow
              key={w.person.id}
              who={w}
              checked={ticked.has(w.person.id)}
              onChange={(on) => {
                const next = new Set(ticked);
                if (on) next.add(w.person.id);
                else next.delete(w.person.id);
                setTicked(next);
              }}
            />
          ))}
        </View>
      )}
      <Button
        label={W.keep}
        disabled={ticked.size === 0}
        busy={change.pending}
        onPress={() =>
          void change
            .change({
              kind: 'set',
              people: ctx.who.filter((w) => ticked.has(w.person.id)).map((w) => w.person.id),
            })
            .then((problem) => problem && showFailure(problem))
        }
      />
      <Text size={13} color={theme.colors.mut}>
        {W.shouldKnow}
      </Text>
    </View>
  );
}

/* Settings --------------------------------------------------------------------------------------------- */

function Settings({ ctx, picked }: { ctx: Ctx; picked: string | null }) {
  const theme = useTheme();
  const change = useFindMyTimelineChange(ctx.slug, ctx.connectionId);
  const assistant = useFindMyTimelineAssistant(ctx.slug, ctx.connectionId);
  const words = useAgentWords();
  const example =
    ctx.who.find((w) => w.person.id === picked)?.first ??
    ctx.who.find((w) => w.person.kept)?.first ??
    'Ruben';
  const reads = assistant.asked ?? ctx.timeline.assistantReads;
  const keptCount = ctx.timeline.people.filter((p) => p.kept).length;

  const ask = (
    title: string,
    body: string,
    confirm: string,
    go: () => Promise<string | null>,
    done: string | null,
  ) =>
    Alert.alert(title, body, [
      { text: W.cancel, style: 'cancel' },
      {
        text: confirm,
        style: 'destructive',
        onPress: () =>
          void go().then((problem) => {
            if (problem) showFailure(problem);
            else if (done) showNotice(done);
          }),
      },
    ]);
  const stop = () =>
    ask(W.stopAsk, W.stopBody, W.stopConfirm, () => change.change({ kind: 'set', people: [] }), W.stopped);

  const section = (first: boolean, children: ReactNode) => (
    <View
      style={{
        paddingHorizontal: PAD,
        paddingVertical: 12,
        gap: 8,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      {children}
    </View>
  );
  const label = (title: string, hint: string) => (
    <View style={{ gap: 2 }}>
      <Text size={15} weight={600}>
        {title}
      </Text>
      <Text size={12.5} lh={1.4} color={theme.colors.mut}>
        {hint}
      </Text>
    </View>
  );

  return (
    <OneCard label={W.settings}>
      {section(
        true,
        <>
          {label(W.whose, W.whoseHint)}
          <View>
            {ctx.who.map((w) => {
              const asked = change.asked?.kind === 'set' ? change.asked.people.includes(w.person.id) : null;
              return (
                <TickRow
                  key={w.person.id}
                  who={w}
                  checked={asked ?? w.person.kept}
                  note={w.person.keptSince ? findMyKeptSince(w.person.keptSince, ctx.tz) : null}
                  disabled={change.pending}
                  onChange={(on) => {
                    if (on)
                      return void change
                        .change({
                          kind: 'set',
                          people: findMyWhoseAfter(ctx.timeline.people, w.person.id, true),
                        })
                        .then((problem) => problem && showFailure(problem));
                    if (keptCount <= 1) return stop();
                    ask(
                      W.untickAsk(w.first),
                      W.untickBody(w.person.name),
                      W.untickConfirm(w.first),
                      () =>
                        change.change({
                          kind: 'set',
                          people: findMyWhoseAfter(ctx.timeline.people, w.person.id, false),
                        }),
                      null,
                    );
                  }}
                />
              );
            })}
          </View>
        </>,
      )}
      {section(false, label(W.keptDays, W.keptDaysHint))}
      {section(
        false,
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ flex: 1 }}>{label(W.assistantReads(words.Name), W.assistantHint(example))}</View>
            <Switch
              value={reads}
              disabled={assistant.pending}
              accessibilityLabel={W.assistantLabel(words.Name)}
              onValueChange={(on) =>
                void assistant.set(on).then((problem) => problem && showFailure(problem))
              }
              {...switchColors(theme, reads)}
            />
          </View>
          <View style={{ padding: 12, borderRadius: 10, backgroundColor: theme.colors.sf2 }}>
            <Text size={13} lh={1.45} color={theme.colors.ink2}>
              {W.onlyYou(words.name)}
            </Text>
          </View>
        </>,
      )}
      {section(
        false,
        <>
          {label(W.deleteTitle, W.deleteHint)}
          <Button
            label={W.deleteButton}
            variant="secondary"
            accessibilityLabel={W.deleteTitle}
            onPress={() =>
              ask(
                W.deleteAsk,
                W.deleteBody,
                W.deleteConfirm,
                () => change.change({ kind: 'delete' }),
                W.deleted,
              )
            }
          />
        </>,
      )}
      {section(
        false,
        <>
          {label(W.stopTitle, W.stopHint)}
          <Button label={W.stopButton} variant="secondary" accessibilityLabel={W.stopTitle} onPress={stop} />
        </>,
      )}
    </OneCard>
  );
}
