/**
 * The summary card at the top of the arranged Overview (docs/decisions/overview-arranged.md; the mock's
 * `.pulse` at phone width): Live and the greeting with the date and how long ago it was read; the broken thing with
 * *Look into it* and how many other things need the person, or “Everything’s fine” in green with the status sentence,
 * or the status sentence alone while something needs a look; then the four figures two by two (Whombat's own counts
 * with their bar, a thing's figure with its small chart), each with its gear while the page is arranged.
 */
import {
  ARRANGE_WORDS,
  type FigureFace,
  type HomeThingRow,
  homeGreeting,
  needsYouWords,
  OVERVIEW_WORDS,
  type OverviewHeadline,
  overviewWords,
  ownFace,
  showId,
  viewFace,
} from '@whombat/client';
import type { DeskWidgetView, HomeOverview, NeedsYouItem, OverviewLayoutTop } from '@whombat/core';
import type { HostServer } from '@whombat/core/domain';
import { formatDate, formatWeekday } from '@whombat/core/text';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, View } from 'react-native';
import { useBurrowBase, useNow } from '../../data/BurrowProvider';
import { ARRANGED_PHONE_WORDS } from '../../data/overviewArranged';
import type { PhoneGlyph } from '../../data/thingLook';
import { useAgentWords } from '../../data/useAgent';
import { useI18n } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { ThingIcon } from '../../ui/assistant';
import { CardWash } from '../../ui/cardWash';
import { useReducedMotion } from '../../ui/chat';
import { ChevronRight } from '../../ui/icons';
import { Button } from '../../ui/primitives';
import { Touchable } from '../../ui/Touchable';
import { useNeedsYouPress } from '../NeedsYouSheet';
import { GearButton, PartsBar, Spark, useToneColor } from './ArrangedParts';

const LOOK_INTO_IT = {
  id: 'handle',
  kind: 'handle',
  label: OVERVIEW_WORDS.lookIntoIt,
  look: 'primary',
} as const;

export interface TopFigureInput {
  top: readonly OverviewLayoutTop[];
  views: ReadonlyMap<string, DeskWidgetView> | undefined;
  rows: readonly HomeThingRow[];
  fleet: readonly Pick<HostServer, 'status'>[] | null;
  glyphOf: (thing: string) => { glyph: PhoneGlyph; mark: HomeThingRow['mark']; name: string } | null;
}

export function SummaryCard({
  overview,
  headline,
  item,
  status,
  onOthers,
  figures,
  arranging,
  onGear,
}: {
  overview: HomeOverview;
  headline: OverviewHeadline;
  /** The broken thing's Inbox item, for Look into it. */
  item: NeedsYouItem | null;
  /** The status sentence, as the page draws it, when nothing is broken. */
  status: ReactNode;
  onOthers: () => void;
  figures: TopFigureInput;
  arranging: boolean;
  onGear: (index: number) => void;
}) {
  const { rawLocale } = useI18n();

  const theme = useTheme();
  const { me, timeZone } = useBurrowBase();
  const now = useNow();
  const broken = headline.kind === 'broken' ? headline : null;
  const fine = headline.kind === 'status' && headline.status.tone === 'ok';
  const seconds = (now.getTime() - Date.parse(overview.generatedAt)) / 1000;
  const greet = [
    homeGreeting(me.shortName ?? me.name, now, timeZone, rawLocale),
    `${formatWeekday(now, timeZone, rawLocale)} ${formatDate(now, timeZone, undefined, rawLocale)}`,
    ARRANGED_PHONE_WORDS.readAgo(seconds),
  ].join(' · ');
  return (
    <View
      style={{
        backgroundColor: theme.colors.sf,
        borderWidth: 1,
        borderColor: theme.colors.line,
        borderRadius: 18,
        overflow: 'hidden',
      }}
    >
      {broken || fine ? <CardWash color={broken ? theme.colors.bad : theme.colors.ok} /> : null}
      <View style={{ paddingTop: 18, paddingHorizontal: 18, paddingBottom: 16, gap: 8 }}>
        <View style={{ gap: 8 }}>
          <LiveMark />
          <Text size={14} lh={1.45} color={theme.colors.mut}>
            {greet}
          </Text>
        </View>
        {broken ? (
          <Broken headline={broken} item={item} onOthers={onOthers} />
        ) : (
          <View style={{ gap: 6 }}>
            {fine ? (
              <Text
                size={24}
                weight={700}
                lh={1.1}
                tracking={-0.025}
                color={theme.colors.okText}
                accessibilityRole="header"
              >
                {ARRANGED_PHONE_WORDS.fine}
              </Text>
            ) : null}
            {status}
          </View>
        )}
      </View>
      <TopFigures {...figures} overview={overview} arranging={arranging} onGear={onGear} />
    </View>
  );
}

/** Live (mono 11/500 in `okText`) with its dot, which pings unless the person asked for less motion. */
function LiveMark() {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const ping = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.timing(ping, {
        toValue: 1,
        duration: 2400,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [ping, reduced]);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
      <View style={{ width: 8, height: 8 }}>
        {reduced ? null : (
          <Animated.View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              marginBottom: -8,
              backgroundColor: theme.colors.ok,
              opacity: ping.interpolate({ inputRange: [0, 0.8, 1], outputRange: [0.6, 0, 0] }),
              transform: [{ scale: ping.interpolate({ inputRange: [0, 0.8, 1], outputRange: [1, 3, 3] }) }],
            }}
          />
        )}
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.ok }} />
      </View>
      <Text size={11} weight={500} mono tracking={0.06} uppercase color={theme.colors.okText}>
        {ARRANGED_PHONE_WORDS.live}
      </Text>
    </View>
  );
}

/** The broken thing: its heading in `bad`, what it means, one *Look into it* across, and the others under it. */
function Broken({
  headline,
  item,
  onOthers,
}: {
  headline: Extract<OverviewHeadline, { kind: 'broken' }>;
  item: NeedsYouItem | null;
  onOthers: () => void;
}) {
  const { rawLocale } = useI18n();
  const needsYouWordsHere = needsYouWords(rawLocale);
  const overviewWordsHere = overviewWords(rawLocale);

  const theme = useTheme();
  const words = useAgentWords();
  const press = useNeedsYouPress();
  const [busy, setBusy] = useState(false);
  const look = () => {
    if (!item) return;
    setBusy(true);
    void press(item, LOOK_INTO_IT).finally(() => setBusy(false));
  };
  return (
    <View style={{ gap: 6 }}>
      <Text
        size={24}
        weight={700}
        lh={1.1}
        tracking={-0.025}
        color={theme.colors.bad}
        accessibilityRole="header"
      >
        {headline.title}
      </Text>
      {headline.detail ? (
        <Text size={15} lh={1.45} color={theme.colors.ink2}>
          {headline.detail}
        </Text>
      ) : null}
      {headline.busy ? (
        <Text size={14} weight={500} color={theme.colors.mut} style={{ marginTop: 6 }}>
          {headline.busy === 'looking' ? needsYouWordsHere.looking(words) : needsYouWordsHere.fixing(words)}
        </Text>
      ) : item ? (
        <Button
          label={overviewWordsHere.lookIntoIt}
          onPress={look}
          busy={busy}
          accessibilityLabel={`${overviewWordsHere.lookIntoIt}: ${headline.title}`}
          style={{ marginTop: 10 }}
        />
      ) : null}
      {headline.others > 0 ? (
        <Touchable
          onPress={onOthers}
          feedback="fade"
          ringRadius={8}
          accessibilityRole="link"
          accessibilityLabel={overviewWordsHere.others(headline.others)}
          style={{
            alignSelf: 'flex-start',
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Text size={14} color={theme.colors.ink2}>
            {overviewWordsHere.others(headline.others)}
          </Text>
          <ChevronRight size={14} color={theme.colors.mut} strokeWidth={1.8} />
        </Touchable>
      ) : null}
    </View>
  );
}

/** What a figure at the top says, and whose it is: Whombat's own, or a thing's (its logo before the label). */
interface TopFace {
  face: FigureFace;
  thing: { glyph: PhoneGlyph; mark: HomeThingRow['mark']; name: string } | null;
}

/** The four figures two by two under a hairline, each cell parted by hairlines (the mock's `.figs` under 720). */
function TopFigures({
  top,
  views,
  rows,
  fleet,
  glyphOf,
  overview,
  arranging,
  onGear,
}: TopFigureInput & { overview: HomeOverview; arranging: boolean; onGear: (index: number) => void }) {
  const theme = useTheme();
  const assistant = useAgentWords();
  const faces = useMemo<TopFace[]>(
    () =>
      top.map((t) => {
        if ('own' in t) return { face: ownFace(t.own, overview, rows, fleet, assistant.name), thing: null };
        const thing = glyphOf(t.thing);
        const view = views?.get(showId(t));
        const face = (view && viewFace(view)) || {
          value: '—',
          unit: null,
          label: thing?.name ?? '',
          line: null,
          tone: null,
          spark: null,
          parts: null,
        };
        return { face, thing };
      }),
    [top, views, rows, fleet, glyphOf, overview, assistant.name],
  );
  if (!faces.length) return null;
  const cells = [faces.slice(0, 2), faces.slice(2, 4)].filter((r) => r.length);
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.line }}>
      {cells.map((row, r) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: two fixed rows
          key={r}
          style={{
            flexDirection: 'row',
            borderTopWidth: r ? 1 : 0,
            borderTopColor: theme.colors.line,
          }}
        >
          {row.map((f, c) => (
            <FigureCell
              // biome-ignore lint/suspicious/noArrayIndexKey: the figures' places are fixed
              key={c}
              face={f.face}
              thing={f.thing}
              first={c === 0}
              arranging={arranging}
              onGear={() => onGear(r * 2 + c)}
            />
          ))}
          {row.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </View>
      ))}
    </View>
  );
}

/**
 * One figure (the mock's `.fig` at phone width): its label mono 11 uppercase in `mut` (a thing's logo before it), the
 * value 24/700 with its unit 15/500 in `mut`, its line 13.5 in `mut`, then a small chart or Whombat's bar of parts. One
 * element for a screen reader, the gear after it while arranging.
 */
function FigureCell({
  face,
  thing,
  first,
  arranging,
  onGear,
}: {
  face: FigureFace;
  thing: TopFace['thing'];
  first: boolean;
  arranging: boolean;
  onGear: () => void;
}) {
  const theme = useTheme();
  const toneColor = useToneColor();
  const spoken = [thing?.name, face.label, `${face.value}${face.unit ? ` ${face.unit}` : ''}`, face.line]
    .filter(Boolean)
    .join(', ');
  return (
    <View
      style={{
        flex: 1,
        minWidth: 0,
        borderLeftWidth: first ? 0 : 1,
        borderLeftColor: theme.colors.line,
        paddingTop: 14,
        paddingHorizontal: 16,
        paddingBottom: 16,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
        <View accessible accessibilityLabel={spoken} style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {thing ? (
              <ThingIcon glyph={thing.glyph} mark={thing.mark} size={13} color={theme.colors.ink2} />
            ) : null}
            <Text
              size={11}
              weight={500}
              mono
              tracking={0.06}
              uppercase
              color={theme.colors.mut}
              numberOfLines={1}
              style={{ flexShrink: 1 }}
            >
              {face.label}
            </Text>
          </View>
          <Text size={24} weight={700} tracking={-0.02} lh={1.15} numberOfLines={1}>
            {face.value}
            {face.unit ? (
              <Text size={15} weight={500} color={theme.colors.mut}>
                {` ${face.unit}`}
              </Text>
            ) : null}
          </Text>
          {face.line ? (
            <Text
              size={13.5}
              lh={1.4}
              color={toneColor(face.tone === 'ok' ? null : face.tone, theme.colors.mut)}
              numberOfLines={2}
            >
              {face.line}
            </Text>
          ) : null}
        </View>
        {arranging ? <GearButton label={ARRANGE_WORDS.changeFigure} onPress={onGear} /> : null}
      </View>
      {face.parts ? <PartsBar parts={face.parts} /> : null}
      {face.spark ? (
        <View style={{ marginTop: 8 }}>
          <Spark points={face.spark} height={34} />
        </View>
      ) : null}
    </View>
  );
}
