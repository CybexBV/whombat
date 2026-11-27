/**
 * The council card on the phone (Whombat docs/decisions/council.md), in the cards' one layout (`cardFrame.tsx`,
 * docs/decisions/chat-threads-cards.md) and drawn from the shared view so the web says the same. The head: Done, Stopped,
 * Working or Waiting for you · Council and its time, the title, how it came out in words (“All three agree.”) and where
 * it is now.
 *
 * While it works the card is open on its work: the council's steps under the title (Look · Plan · Go-ahead · Build ·
 * Check, the current one marked), then the council's room: each member an elder at one table (`@whombat/avatars`
 * `elderSvg`), an elder thinking breathing slowly (still with Remove animations), and in front of each its plaque — its
 * model, its provider's mark and name, what it does now, its score and verdict or its state and how long, and once it
 * answered “Read its answer”, which opens that answer under the table. Stop is a quiet word at the bottom right,
 * and in the ⋯ on the status line with Council settings; both ask first. Details keeps the rest: the earlier rounds
 * in small lines, the plan folded under its heading.
 *
 * Once it ended the elders stay at the table, still, with their scores, and “Read the answers” opens Details, with every round's scores (scrolling sideways
 * when they don't fit), the members whose answers can still be read, the plan and the pictures of what changed with
 * their numbered notes (a picture opens the image viewer). Its tasks are on the delegation card under it while it builds.
 */
import { ELDER_VIEWBOX, elderSvg } from '@whombat/avatars';
import {
  type CouncilMemberView,
  type CouncilScoreTable,
  cardFrameWords,
  councilFrame,
  councilStepIndex,
  councilSteps,
  councilWords,
} from '@whombat/client';
import { type CouncilKind, type CouncilMark, type CouncilStage, formatClock } from '@whombat/core';
import { type ReactNode, useContext, useEffect, useId, useRef, useState } from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Rect, Stop, SvgXml } from 'react-native-svg';
import type { CouncilItem } from '../data/council';
import type { FileAccess } from '../data/fileAccess';
import type { MessageFileActions } from '../data/useFiles';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BrandMark } from './BrandMark';
import { CardButtons, CardFrameView, type CardHead, CardSection, CardStillContext } from './cardFrame';
import { CardPictures } from './cardPictures';
import { CardCornerMenu, CardStopButton } from './cardStop';
import { useReducedMotion } from './chat';
import { ChevronDown, ChevronUp } from './icons';
import { Button } from './primitives';
import { RichText } from './rich';
import { Touchable } from './Touchable';

/** The mark's round slot, and the ring's box around it. */
const SLOT = 24;
const RING = 32;
const RING_STROKE = 2;
/** One turn of the working ring. */
const TURN_MS = 1200;
/** Where a member's words start, past its mark's ring and the gap: its answer lines up under its name. */
const INDENT = RING + 10;
/** The plan's and a member's answer's text. */
const TEXT_SIZE = 14;
const TEXT_LH = 1.45;

/** A provider's mark in its 24pt round slot: Claude's and OpenAI's own, any other its first letter (CNL-44). */
export function CouncilMarkSlot({
  mark,
  letter,
  size = SLOT,
}: {
  mark: CouncilMark | null;
  letter: string;
  size?: number;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: theme.colors.sf2,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {mark ? (
        <BrandMark mark={mark} size={Math.round(size * 0.6)} />
      ) : (
        <Text size={Math.round(size * 0.5)} weight={700} color={theme.colors.ink2}>
          {letter}
        </Text>
      )}
    </View>
  );
}

/**
 * The mark with the waiting animation (John: “the provider icons with a nice waiting animation”): while the member
 * works a thin arc in the working colour turns round it once every 1.2 s and the mark breathes very slightly; with
 * Remove animations the ring is whole and still. Done: the mark alone.
 */
function WorkingMark({ member }: { member: CouncilMemberView }) {
  return (
    <WorkingRing working={member.working}>
      <CouncilMarkSlot mark={member.mark} letter={member.letter} />
    </WorkingRing>
  );
}

/**
 * The working animation round a 24pt slot, which the delegation card shares: while `working` a thin arc in the working
 * colour turns round it once every 1.2 s and the slot breathes very slightly; with Remove animations the ring is whole
 * and still; otherwise the slot alone.
 */
export function WorkingRing({ working: live, children }: { working: boolean; children: ReactNode }) {
  // A copy of a card as it was (card-moves.md) doesn't turn: it isn't at work now.
  const still = useContext(CardStillContext);
  const working = live && !still;
  const theme = useTheme();
  const reduced = useReducedMotion();
  const turn = useSharedValue(0);
  const breath = useSharedValue(1);
  const moving = working && !reduced;
  useEffect(() => {
    if (!moving) return;
    turn.value = 0;
    turn.value = withRepeat(withTiming(1, { duration: TURN_MS, easing: Easing.linear }), -1, false);
    breath.value = withRepeat(
      withTiming(1.04, { duration: TURN_MS, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(turn);
      cancelAnimation(breath);
      breath.value = 1;
    };
  }, [moving, turn, breath]);
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }));
  const breathe = useAnimatedStyle(() => ({ transform: [{ scale: breath.value }] }));
  const r = (RING - RING_STROKE) / 2;
  const around = 2 * Math.PI * r;
  return (
    <View
      style={{ width: RING, height: RING, alignItems: 'center', justifyContent: 'center' }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {working ? (
        <Animated.View style={[{ position: 'absolute', width: RING, height: RING }, moving ? spin : null]}>
          <Svg width={RING} height={RING}>
            {moving ? (
              <>
                <Circle
                  cx={RING / 2}
                  cy={RING / 2}
                  r={r}
                  stroke={theme.status.working}
                  strokeOpacity={0.18}
                  strokeWidth={RING_STROKE}
                  fill="none"
                />
                <Circle
                  cx={RING / 2}
                  cy={RING / 2}
                  r={r}
                  stroke={theme.status.working}
                  strokeWidth={RING_STROKE}
                  strokeLinecap="round"
                  strokeDasharray={`${around * 0.28} ${around}`}
                  fill="none"
                />
              </>
            ) : (
              <Circle
                cx={RING / 2}
                cy={RING / 2}
                r={r}
                stroke={theme.status.working}
                strokeWidth={RING_STROKE}
                fill="none"
              />
            )}
          </Svg>
        </Animated.View>
      ) : null}
      <Animated.View style={moving ? breathe : null}>{children}</Animated.View>
    </View>
  );
}

function MemberRow({ member, openUrl }: { member: CouncilMemberView; openUrl: (url: string) => void }) {
  const { rawLocale } = useI18n();
  const councilWordsHere = councilWords(rawLocale);
  // A copy of the card as it was (card-moves.md) shows no clocks (they would count on from long ago) and opens no
  // answers (the newest card has them).
  const still = useContext(CardStillContext);
  const elapsed = still ? null : member.elapsed;
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  // What it does now, under its name (a builder's step); its provider beside the name.
  const doing = member.step;
  const result =
    member.score || member.verdict ? [member.score, member.verdict].filter(Boolean).join(' · ') : null;
  const row = (
    <View
      accessible
      accessibilityLabel={elapsed ? `${member.label}, ${elapsed}` : member.label}
      style={{
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <WorkingMark member={member} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {/* The name wraps rather than being cut; the provider's word gives way first. */}
          <Text
            size={14.5}
            weight={600}
            numberOfLines={2}
            color={member.muted ? theme.colors.ink2 : theme.colors.ink}
            style={{ flexShrink: 1 }}
          >
            {member.name}
          </Text>
          <Text size={12} color={theme.colors.mut} numberOfLines={1} style={{ flexShrink: 2 }}>
            {member.provider}
          </Text>
          {member.builder ? (
            <View
              style={{
                paddingHorizontal: 6,
                paddingVertical: 1,
                borderRadius: theme.radii.tagLarge,
                backgroundColor: theme.colors.sf2,
              }}
            >
              <Text size={11} weight={600} color={theme.colors.ink2}>
                {councilWordsHere.builder}
              </Text>
            </View>
          ) : null}
        </View>
        {doing ? (
          <Text size={12.5} color={theme.colors.ink2} numberOfLines={1}>
            {doing}
          </Text>
        ) : null}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 1, maxWidth: '42%' }}>
        <Text
          size={13}
          weight={600}
          color={member.muted ? theme.colors.mut : member.working ? theme.colors.ink2 : theme.colors.ink}
          numberOfLines={1}
        >
          {result ?? member.status}
        </Text>
        {elapsed ? (
          <Text size={11.5} mono color={theme.colors.mut}>
            {elapsed}
          </Text>
        ) : null}
      </View>
    </View>
  );
  const answer = still ? null : member.answer;
  if (!answer) return row;
  // Its answer opens on its row: read on the phone without T3 Code, the rest there when it is long.
  return (
    <View>
      {row}
      <Button
        label={open ? councilWordsHere.hideAnswer : councilWordsHere.readAnswer}
        variant="quiet"
        accessibilityLabel={`${open ? councilWordsHere.hideAnswer : councilWordsHere.readAnswer}: ${member.name}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        style={{ alignSelf: 'flex-start', marginLeft: INDENT - 12, marginTop: -6, borderWidth: 0 }}
      />
      {open ? (
        <View style={{ marginLeft: INDENT, gap: 2, paddingBottom: 10 }}>
          <RichText
            text={answer}
            color={theme.colors.ink2}
            accentColor={theme.colors.brand}
            codeBackground={theme.colors.sf2}
            size={TEXT_SIZE}
            lh={TEXT_LH}
            selectable
          />
          {member.cut && member.url ? <RestInT3 url={member.url} open={openUrl} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/** An elder's widest, and the room's arch and its table's lit top and dark edge. */
const ELDER_MAX = 150;
const ARCH = 64;
const WOOD_TOP = 7;
const WOOD_EDGE = 5;
/** Up to this wide the room is a narrow one (a folded phone): closer seats and smaller plaques, as on the web. */
const NARROW_ROOM = 400;
/** A plaque narrower than this puts the time under “Working”: “Working · 22 min” would break before its dot. */
const TIME_BESIDE = 150;

/**
 * The room's seats for its width: the gaps, and each elder's size worked out here rather than from an aspect ratio,
 * which Yoga gets wrong with a maximum width (the drawing then floats in a box taller than itself, off the table).
 */
function roomLayout(width: number, seats: number) {
  const narrow = width <= NARROW_ROOM;
  const gap = narrow ? 5 : 8;
  const side = narrow ? 6 : 12;
  const seat = Math.max(0, (width - 2 * side - gap * Math.max(0, seats - 1)) / Math.max(1, seats));
  const elderWidth = Math.floor(Math.min(seat, ELDER_MAX));
  return {
    narrow,
    timeUnder: narrow || seat < TIME_BESIDE,
    gap,
    side,
    elderWidth,
    elderHeight: Math.round((elderWidth * ELDER_VIEWBOX.height) / ELDER_VIEWBOX.width),
  };
}

/**
 * The council's room: a burrow with a lamp in it, each member an elder at one table, its plaque in front of it. The
 * drawings are hidden from screen readers; each plaque reads as one line (`label`). While the council works a plaque's
 * “Read its answer” opens that answer under the table, one at a time; a finished card reads them under Details.
 */
function CouncilRoom({
  members,
  reading,
  openUrl,
}: {
  members: readonly CouncilMemberView[];
  reading: boolean;
  openUrl: (url: string) => void;
}) {
  const theme = useTheme();
  const still = useContext(CardStillContext);
  // SVG ids take letters and digits only.
  const id = useId().replace(/[^\w-]/g, '');
  const [openId, setOpenId] = useState<string | null>(null);
  // The room's own width, measured: it changes when a foldable opens or folds, or the phone turns. Until it is known,
  // the window's width less the chat's margins stands in, so the card doesn't jump.
  const screen = useWindowDimensions();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const layout = roomLayout(size?.width ?? screen.width - 48, members.length);
  const read = reading && !still;
  const open = read ? members.find((m) => m.id === openId && m.answer) : undefined;
  const room = theme.room;
  return (
    <View style={{ gap: 10 }}>
      <View
        onLayout={(e) => {
          const width = Math.round(e.nativeEvent.layout.width);
          const height = Math.round(e.nativeEvent.layout.height);
          setSize((was) => (was?.width === width && was.height === height ? was : { width, height }));
        }}
        style={{
          overflow: 'hidden',
          borderTopLeftRadius: ARCH,
          borderTopRightRadius: ARCH,
          borderBottomLeftRadius: theme.radii.card,
          borderBottomRightRadius: theme.radii.card,
        }}
      >
        {/* Drawn at the room's measured size and again when it changes: an absolutely placed Svg doesn't follow its
            parent when only the room widens (Hide threads on an opened foldable), not the window. */}
        <Svg
          key={size ? `${size.width}x${size.height}` : 'guess'}
          width={size?.width ?? '100%'}
          height={size?.height ?? '100%'}
          style={{ position: 'absolute', top: 0, left: 0 }}
          preserveAspectRatio="none"
        >
          <Defs>
            <LinearGradient id={`${id}den`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={room.roomTop} />
              <Stop offset="1" stopColor={room.roomBottom} />
            </LinearGradient>
            <RadialGradient id={`${id}lamp`} cx="0.5" cy="0.18" rx="0.6" ry="0.7" fx="0.5" fy="0.18">
              <Stop offset="0" stopColor={room.roomLamp} />
              <Stop offset="1" stopColor={room.roomLamp} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect width="100%" height="100%" fill={`url(#${id}den)`} />
          <Rect width="100%" height="100%" fill={`url(#${id}lamp)`} />
        </Svg>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            flexDirection: 'row',
            alignItems: 'flex-end',
            gap: layout.gap,
            paddingHorizontal: layout.side,
            paddingTop: 16,
          }}
        >
          {members.map((m, i) => (
            <Elder
              key={m.id}
              seat={i}
              member={m}
              idPrefix={`${id}e${i}`}
              still={still}
              width={layout.elderWidth}
              height={layout.elderHeight}
            />
          ))}
        </View>
        <View
          style={{
            flexDirection: 'row',
            gap: layout.gap,
            paddingHorizontal: layout.side,
            paddingTop: 7,
            paddingBottom: 7,
            backgroundColor: room.wood,
            borderTopWidth: WOOD_TOP,
            borderTopColor: room.woodTop,
            borderBottomWidth: WOOD_EDGE,
            borderBottomColor: room.woodEdge,
          }}
        >
          {members.map((m) => (
            <Plaque
              key={m.id}
              member={m}
              narrow={layout.narrow}
              timeUnder={layout.timeUnder}
              still={still}
              reading={read}
              open={open?.id === m.id}
              onRead={() => setOpenId((was) => (was === m.id ? null : m.id))}
            />
          ))}
        </View>
      </View>
      {open?.answer ? (
        <View
          style={{ gap: 2, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: theme.colors.line }}
          accessibilityLiveRegion="polite"
        >
          <Text size={13} weight={600} color={theme.colors.ink}>
            {open.name}
          </Text>
          <RichText
            text={open.answer}
            color={theme.colors.ink2}
            accentColor={theme.colors.brand}
            codeBackground={theme.colors.sf2}
            size={TEXT_SIZE}
            lh={TEXT_LH}
            selectable
          />
          {open.cut && open.url ? <RestInT3 url={open.url} open={openUrl} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/** One elder; while it thinks it breathes slowly (still on a card's copy and with Remove animations). */
function Elder({
  seat,
  member,
  idPrefix,
  still,
  width,
  height,
}: {
  seat: number;
  member: CouncilMemberView;
  idPrefix: string;
  still: boolean;
  /** Its size in points: it sits on the table, as wide as its seat up to `ELDER_MAX`. */
  width: number;
  height: number;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const breath = useSharedValue(0);
  const moving = member.pose === 'thinking' && !still && !reduced;
  useEffect(() => {
    if (!moving) return;
    breath.value = withRepeat(withTiming(1, { duration: 2250, easing: Easing.inOut(Easing.quad) }), -1, true);
    return () => {
      cancelAnimation(breath);
      breath.value = 0;
    };
  }, [moving, breath]);
  const breathe = useAnimatedStyle(() => ({ transform: [{ translateY: breath.value * 1.5 }] }));
  return (
    <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
      <Animated.View style={[{ width, height }, moving ? breathe : null]}>
        <SvgXml
          xml={elderSvg({ seat, pose: member.pose, idPrefix })}
          width={width}
          height={height}
          color={theme.colors.ink2}
        />
      </Animated.View>
    </View>
  );
}

/** A member's plaque: paper in both themes, its words dark on it. */
function Plaque({
  member: m,
  narrow,
  timeUnder,
  still,
  reading,
  open,
  onRead,
}: {
  member: CouncilMemberView;
  /** A narrow room (a folded phone): smaller words. */
  narrow: boolean;
  /** The time under the state, not beside it: a narrow room, or a plaque too narrow for both on one line. */
  timeUnder: boolean;
  still: boolean;
  reading: boolean;
  open: boolean;
  onRead: () => void;
}) {
  const { rawLocale } = useI18n();
  const councilWordsHere = councilWords(rawLocale);
  const theme = useTheme();
  const room = theme.room;
  const elapsed = m.working && !still ? m.elapsed : null;
  // The web's sizes: a wide room's plaque one step larger than a narrow one's.
  const small = narrow ? 11 : 12;
  return (
    <View
      style={{
        flex: 1,
        minWidth: 0,
        alignItems: 'center',
        gap: 2,
        paddingHorizontal: narrow ? 4 : 8,
        paddingTop: narrow ? 6 : 8,
        paddingBottom: reading && m.answer ? 0 : narrow ? 7 : 9,
        borderRadius: theme.radii.tagLarge,
        backgroundColor: m.muted ? room.plaqueQuiet : room.plaque,
      }}
    >
      <View
        accessible
        accessibilityLabel={elapsed ? `${m.label}, ${elapsed}` : m.label}
        style={{ alignItems: 'center', gap: 2, alignSelf: 'stretch' }}
      >
        <Text
          size={narrow ? 12 : 13}
          weight={600}
          color={room.plaqueInk}
          numberOfLines={3}
          style={{ textAlign: 'center' }}
        >
          {m.name}
        </Text>
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 3,
          }}
        >
          {m.mark ? (
            // On paper in both themes: OpenAI's mark takes the plaque's ink, not the theme's.
            <BrandMark mark={m.mark} size={small} color={room.plaqueMut} />
          ) : (
            <Text size={10} weight={700} color={room.plaqueMut}>
              {m.letter}
            </Text>
          )}
          <Text size={small} color={room.plaqueMut} numberOfLines={1} style={{ flexShrink: 1 }}>
            {m.provider}
          </Text>
        </View>
        {m.builder ? (
          <View
            style={{
              paddingHorizontal: 6,
              paddingVertical: 1,
              borderRadius: theme.radii.tag,
              backgroundColor: room.plaqueQuiet,
            }}
          >
            <Text size={10.5} weight={600} color={room.plaqueInk}>
              {councilWordsHere.builder}
            </Text>
          </View>
        ) : null}
        {m.step ? (
          <Text size={small} color={room.plaqueMut} numberOfLines={2} style={{ textAlign: 'center' }}>
            {m.step}
          </Text>
        ) : null}
        {m.score || m.verdict ? (
          <View style={{ alignItems: 'center', marginTop: 2 }}>
            {m.score ? (
              <Text size={narrow ? 16 : 18} mono weight={600} color={room.plaqueInk}>
                {m.score}
              </Text>
            ) : null}
            {m.verdict ? (
              <Text
                size={small}
                weight={600}
                color={m.verdict === councilWordsHere.verdicts.agree ? room.plaqueOk : room.plaqueWarn}
              >
                {m.verdict}
              </Text>
            ) : null}
          </View>
        ) : (
          // “Working · 19 s” on one line where it fits; else the time goes under the word.
          <View
            style={{
              flexDirection: timeUnder ? 'column' : 'row',
              flexWrap: 'wrap',
              justifyContent: 'center',
              alignItems: 'center',
              marginTop: 2,
            }}
          >
            <Text size={small} mono color={room.plaqueMut} style={{ textAlign: 'center' }}>
              {m.status}
            </Text>
            {elapsed ? (
              <Text size={small} mono color={room.plaqueMut}>
                {timeUnder ? elapsed : ` · ${elapsed}`}
              </Text>
            ) : null}
          </View>
        )}
      </View>
      {reading && m.answer ? (
        <Touchable
          onPress={onRead}
          feedback="wash"
          ringRadius={theme.radii.tagLarge}
          accessibilityRole="button"
          accessibilityLabel={`${open ? councilWordsHere.hideAnswer : councilWordsHere.readAnswer}: ${m.name}`}
          accessibilityState={{ expanded: open }}
          style={{ minHeight: 44, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' }}
        >
          <Text
            size={11.5}
            weight={600}
            color={room.plaqueInk}
            style={{ textAlign: 'center', textDecorationLine: 'underline' }}
          >
            {open ? councilWordsHere.hideAnswer : councilWordsHere.readAnswer}
          </Text>
        </Touchable>
      ) : null}
    </View>
  );
}

/** Under an answer cut short: its T3 Code thread, where the rest is. */
function RestInT3({ url, open }: { url: string; open: (url: string) => void }) {
  const { rawLocale } = useI18n();
  const councilWordsHere = councilWords(rawLocale);
  const theme = useTheme();
  return (
    <Touchable
      onPress={() => open(url)}
      feedback="wash"
      ringRadius={theme.radii.button}
      accessibilityRole="link"
      accessibilityLabel={councilWordsHere.restInT3}
      accessibilityHint={url}
      style={{
        alignSelf: 'flex-start',
        minHeight: 44,
        justifyContent: 'center',
        marginHorizontal: -8,
        paddingHorizontal: 8,
        borderRadius: theme.radii.button,
      }}
    >
      <Text size={14} weight={600} color={theme.colors.brand}>
        {councilWordsHere.restInT3}
      </Text>
    </Touchable>
  );
}

/** The plan in the app's message text, folded under “The plan”, which opens it whole. */
function CouncilPlan({ plan }: { plan: string }) {
  const { rawLocale } = useI18n();
  const councilWordsHere = councilWords(rawLocale);
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Touchable
        onPress={() => setOpen((o) => !o)}
        feedback="wash"
        ringRadius={theme.radii.button}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={councilWordsHere.plan}
        style={{
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          marginHorizontal: -8,
          paddingHorizontal: 8,
          borderRadius: theme.radii.button,
        }}
      >
        <Text size={14} weight={600} style={{ flex: 1 }}>
          {councilWordsHere.plan}
        </Text>
        {open ? (
          <ChevronUp size={18} color={theme.colors.mut} strokeWidth={2} />
        ) : (
          <ChevronDown size={18} color={theme.colors.mut} strokeWidth={2} />
        )}
      </Touchable>
      {open ? (
        <RichText
          text={plan}
          color={theme.colors.ink2}
          accentColor={theme.colors.brand}
          codeBackground={theme.colors.sf2}
          size={TEXT_SIZE}
          lh={TEXT_LH}
        />
      ) : null}
    </View>
  );
}

/** The steps' marks: done filled, the current one ringed and filled, the rest open. */
const STEP_DOT = 10;

/**
 * The council's steps under its title, by what it does (Look · Plan · Go-ahead · Build · Check; Research · Agree; none
 * for a review), the current one marked and its word stronger: where it is, without reading.
 */
export function CouncilStepsTrack({ kind, stage }: { kind: CouncilKind; stage: CouncilStage }) {
  const theme = useTheme();
  const steps = councilSteps(kind);
  const at = councilStepIndex(stage, kind);
  if (at < 0 || !steps.length) return null;
  const waiting = stage === 'approve';
  const current = waiting ? theme.status.waiting : theme.status.working;
  return (
    <View
      accessible
      accessibilityLabel={
        at < steps.length ? `${steps[at]}, step ${at + 1} of ${steps.length}` : steps.join(', ')
      }
      style={{ flexDirection: 'row', alignItems: 'flex-start', paddingTop: 4 }}
    >
      {steps.map((step, i) => {
        const done = i < at;
        const now = i === at;
        return (
          <View key={step} style={{ flex: 1, alignItems: 'center', gap: 4 }}>
            <View style={{ height: STEP_DOT + 6, alignSelf: 'stretch', justifyContent: 'center' }}>
              {i > 0 ? (
                <View
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: '50%',
                    marginRight: STEP_DOT / 2 + 4,
                    height: 1,
                    backgroundColor: done || now ? current : theme.colors.line2,
                  }}
                />
              ) : null}
              {i < steps.length - 1 ? (
                <View
                  style={{
                    position: 'absolute',
                    left: '50%',
                    right: 0,
                    marginLeft: STEP_DOT / 2 + 4,
                    height: 1,
                    backgroundColor: done ? current : theme.colors.line2,
                  }}
                />
              ) : null}
              <View
                style={{
                  alignSelf: 'center',
                  width: now ? STEP_DOT + 4 : STEP_DOT,
                  height: now ? STEP_DOT + 4 : STEP_DOT,
                  borderRadius: STEP_DOT,
                  borderWidth: now ? 3 : 1.5,
                  borderColor: done || now ? current : theme.colors.line2,
                  backgroundColor: done ? current : now ? theme.colors.sf : 'transparent',
                }}
              />
            </View>
            <Text
              size={10.5}
              weight={now ? 600 : 400}
              color={now ? theme.colors.ink : theme.colors.mut}
              numberOfLines={1}
              maxFontSizeMultiplier={1.4}
            >
              {step}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** The score table's row heights, the same on both sides of the fixed names. */
const HEAD_H = 24;
const ROW_H = 40;
const NAME_W = 152;
const CELL_W = 60;

/**
 * The final card's scores: a column per round, a row per member with its mark. The names stay put and the rounds
 * scroll sideways when they don't fit, starting at the latest round (the result).
 */
function ScoreTable({ table }: { table: CouncilScoreTable }) {
  const theme = useTheme();
  const scroller = useRef<ScrollView>(null);
  const line = { borderTopWidth: 1, borderTopColor: theme.colors.line };
  return (
    <View style={{ flexDirection: 'row' }}>
      <View style={{ width: NAME_W }}>
        <View style={{ height: HEAD_H }} />
        {table.rows.map((row) => (
          <View
            key={row.name}
            accessible
            accessibilityLabel={`${row.name}: ${table.columns
              .map((c, i) => `${c} ${row.cells[i] || '—'}`)
              .join(', ')}`}
            style={[
              { height: ROW_H, flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 8 },
              line,
            ]}
          >
            <CouncilMarkSlot mark={row.mark} letter={row.letter} size={20} />
            <Text size={13.5} weight={500} numberOfLines={1} style={{ flex: 1 }}>
              {row.name}
            </Text>
          </View>
        ))}
      </View>
      <ScrollView
        ref={scroller}
        horizontal
        showsHorizontalScrollIndicator={false}
        // The latest round in view, also when the room for the rounds changes (a turned or unfolded phone).
        onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}
        onLayout={() => scroller.current?.scrollToEnd({ animated: false })}
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1 }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View style={{ flexGrow: 1 }}>
          <View
            style={{ height: HEAD_H, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' }}
          >
            {table.columns.map((c) => (
              <View key={c} style={{ width: CELL_W, alignItems: 'center' }}>
                <Text size={11} mono color={theme.colors.mut} uppercase numberOfLines={1}>
                  {c}
                </Text>
              </View>
            ))}
          </View>
          {table.rows.map((row) => (
            <View
              key={row.name}
              style={[
                { height: ROW_H, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
                line,
              ]}
            >
              {row.cells.map((c, i) => (
                <View key={table.columns[i]} style={{ width: CELL_W, alignItems: 'center' }}>
                  <Text
                    size={13}
                    weight={600}
                    mono
                    numberOfLines={1}
                    color={c.includes('/10') ? theme.colors.ink : theme.colors.mut}
                  >
                    {c}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

export interface CouncilCardActions {
  stop: () => void;
  /** While it is live: Settings → the assistant → Council, to choose who sits on the next one. */
  changeCouncil: () => void;
  /** A member's T3 Code thread, where the rest of a long answer is. */
  openUrl: (url: string) => void;
  /** Stop is on its way. */
  busy: 'stop' | null;
}

export function CouncilCardPanel({
  item,
  members,
  actions,
  access,
  files,
  timeZone,
}: {
  item: CouncilItem;
  /** The rows on the row's clock (their times tick). */
  members: readonly CouncilMemberView[];
  actions: CouncilCardActions;
  access: FileAccess | null;
  files: MessageFileActions | null;
  /** The person's zone, for the status line's time. */
  timeZone: string;
}) {
  const { rawLocale } = useI18n();
  const cardFrameWordsHere = cardFrameWords(rawLocale);
  const councilWordsHere = councilWords(rawLocale);
  const theme = useTheme();
  const { view } = item;
  const live = item.card.live;
  const head = councilHead(item.card, timeZone, rawLocale);
  const [open, setOpen] = useState(false);
  // Live, every member at the table in the card itself; once it ended, those whose answers can still be read, under
  // Details too.
  const rows = live ? [] : members.filter((m) => m.answer);
  const stoppable = live && view.stoppable;
  const stop = stoppable ? actions.stop : null;
  const details = (
    <>
      {rows.length ? (
        <CardSection title={cardFrameWordsHere.answers}>
          <View style={{ gap: 4 }}>
            {rows.map((m) => (
              <MemberRow key={m.id} member={m} openUrl={actions.openUrl} />
            ))}
          </View>
        </CardSection>
      ) : null}
      {live && view.progress ? (
        <Text size={12} mono color={theme.colors.mut}>
          {view.progress}
        </Text>
      ) : null}
      {live && view.earlier.length ? (
        <View style={{ gap: 2 }}>
          {view.earlier.map((line) => (
            <Text key={line} size={12} mono color={theme.colors.mut}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
      {!live && view.table.columns.length ? <ScoreTable table={view.table} /> : null}
      {item.plan ? <CouncilPlan plan={item.plan} /> : null}
      {item.pictures.length ? (
        <CardSection title={councilWordsHere.pictures}>
          <CardPictures
            pictures={item.pictures}
            hint={councilWordsHere.picturesHint}
            access={access}
            files={files}
          />
        </CardSection>
      ) : null}
    </>
  );
  const hasDetails =
    rows.length > 0 ||
    !!item.plan ||
    item.pictures.length > 0 ||
    (live && (!!view.progress || view.earlier.length > 0)) ||
    view.table.columns.length > 0;
  return (
    <CardFrameView
      head={head}
      loud={head.mark === 'waiting'}
      corner={
        live ? <CardCornerMenu title={head.title} onChange={actions.changeCouncil} onStop={stop} /> : null
      }
      underTitle={live ? <CouncilStepsTrack kind={item.card.what} stage={item.card.stage} /> : null}
      buttons={
        <CardButtons
          main={
            rows.some((m) => m.answer)
              ? {
                  label: open ? cardFrameWordsHere.hideAnswers : cardFrameWordsHere.readAnswers,
                  onPress: () => setOpen((o) => !o),
                }
              : null
          }
        />
      }
      details={hasDetails ? details : undefined}
      detailsOpen={open}
      // A finished card with answers: “Read the answers” opens what Details would, so it is the one way in.
      detailsToggle={live || !rows.some((m) => m.answer)}
      onDetailsOpen={setOpen}
      endAction={
        stop ? (
          <CardStopButton
            label={councilWordsHere.stop}
            spoken={councilWordsHere.stopAsk.title.replace(/\?$/, '')}
            busy={actions.busy === 'stop'}
            disabled={actions.busy !== null}
            onPress={stop}
          />
        ) : null
      }
    >
      {members.length ? <CouncilRoom members={members} reading={live} openUrl={actions.openUrl} /> : null}
    </CardFrameView>
  );
}

/** The council's head with its time in the person's zone. */
export function councilHead(card: CouncilItem['card'], timeZone: string, locale?: string | null): CardHead {
  const frame = councilFrame(card, locale);
  return { ...frame, time: frame.at ? formatClock(frame.at, timeZone) : null };
}
