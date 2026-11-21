/**
 * The work line of a thread's row in Chat, from the shared `threadWorkLine`: a council's members as small overlapping provider marks (or a live dot), who
 * is at work a little stronger, what they do now, the clock at the right, and a 3pt hairline under it — segments where
 * there is a count (done filled, the ones at work breathing), a soft sweep where there is none. Amber when it waits for
 * the person. The movement runs on the native driver and stands still with Remove animations.
 */
import { type WorkLine, workClock } from '@whombat/client';
import type { ThreadWorkMember } from '@whombat/core';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, View } from 'react-native';
import { useNowLabel } from '../data/BurrowProvider';
import { workSegments } from '../data/workLine';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BrandMark } from './BrandMark';
import { useReducedMotion } from './chat';

/** The members' marks: a 16pt round slot each, overlapping. */
const MARK = 16;
const BAR = 3;
const BREATH_MS = 1100;
const SWEEP_MS = 1600;

/** The minutes for a screen reader, on the clock: “Council, 2 of 3 answered, 12 minutes”. */
function spokenNow(line: WorkLine, nowMs: number): string {
  const minutes = line.since !== null ? Math.max(1, Math.floor((nowMs - line.since) / 60_000)) : null;
  return [line.who, line.text, minutes ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : null]
    .filter(Boolean)
    .join(', ');
}

/** What a screen reader hears for a work line, kept current by the app's clock. */
export function useWorkLineSpoken(line: WorkLine | null): string | null {
  return useNowLabel(
    (now) => (line ? spokenNow(line, now.getTime()) : null),
    () => line?.since != null,
  );
}

export function WorkLineRow({ line }: { line: WorkLine }) {
  const theme = useTheme();
  const warn = line.tone === 'warn';
  const clock = useNowLabel(
    (now) => (line.since !== null ? workClock(line.since, now.getTime()) : null),
    () => line.since !== null,
  );
  const textColor = warn ? theme.colors.warnText : theme.colors.mut;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ alignSelf: 'stretch', gap: 5, paddingTop: 2 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {line.members.length ? <MemberMarks members={line.members} /> : <LiveDot tone={line.tone} />}
        <Text size={12.5} numberOfLines={1} color={textColor} style={{ flex: 1, minWidth: 0 }}>
          <Text size={12.5} weight={500} color={warn ? theme.colors.warnText : theme.colors.ink}>
            {line.who}
          </Text>
          {` · ${line.text}`}
        </Text>
        {clock ? (
          <Text size={11.5} mono color={theme.colors.mut}>
            {clock}
          </Text>
        ) : null}
      </View>
      {line.progress ? <WorkBar line={line} /> : null}
    </View>
  );
}

/** A council's members, their marks overlapping, each ringed in the background. */
function MemberMarks({ members }: { members: readonly ThreadWorkMember[] }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row' }}>
      {members.slice(0, 4).map((m, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: members have no id here; their order is the council's.
          key={i}
          style={{
            width: MARK + 2,
            height: MARK + 2,
            borderRadius: (MARK + 2) / 2,
            marginLeft: i ? -5 : 0,
            borderWidth: 1,
            borderColor: theme.colors.bg,
            backgroundColor: theme.colors.sf2,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: m.working ? 1 : 0.85,
          }}
        >
          {m.mark ? (
            <BrandMark mark={m.mark} size={10} />
          ) : (
            <Text size={8.5} weight={700} color={theme.colors.ink2} maxFontSizeMultiplier={1.2}>
              {m.letter}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

/** A small dot: the working colour, breathing while it works; amber when it waits for the person; still and quiet else. */
function LiveDot({ tone }: { tone: WorkLine['tone'] }) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const breath = useRef(new Animated.Value(1)).current;
  const moving = tone === 'live' && !reduced;
  useEffect(() => {
    if (!moving) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 0.35,
          duration: BREATH_MS,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 1,
          duration: BREATH_MS,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      breath.setValue(1);
    };
  }, [moving, breath]);
  const color =
    tone === 'warn' ? theme.status.waiting : tone === 'live' ? theme.status.working : theme.colors.mut;
  return (
    <Animated.View
      style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: color, opacity: moving ? breath : 1 }}
    />
  );
}

/** The 3pt hairline: segments for a count, a sweep without one. */
function WorkBar({ line }: { line: WorkLine }) {
  const theme = useTheme();
  const warn = line.tone === 'warn';
  const fill = warn ? theme.status.waiting : theme.status.working;
  const segments = workSegments(line.progress);
  if (line.progress?.kind === 'sweep') return <SweepBar color={fill} />;
  return (
    <View style={{ flexDirection: 'row', gap: 3, height: BAR }}>
      {segments.map((s, i) =>
        s === 'working' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a segment is its place in the bar.
          <BreathingSegment key={i} color={fill} />
        ) : (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: a segment is its place in the bar.
            key={i}
            style={{
              flex: 1,
              borderRadius: BAR / 2,
              backgroundColor: s === 'done' ? fill : theme.colors.line2,
            }}
          />
        ),
      )}
    </View>
  );
}

function BreathingSegment({ color }: { color: string }) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const breath = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, { toValue: 0.15, duration: BREATH_MS, useNativeDriver: true }),
        Animated.timing(breath, { toValue: 0.45, duration: BREATH_MS, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      breath.setValue(0.45);
    };
  }, [reduced, breath]);
  return (
    <View style={{ flex: 1, borderRadius: BAR / 2, backgroundColor: theme.colors.line2, overflow: 'hidden' }}>
      <Animated.View style={{ flex: 1, backgroundColor: color, opacity: breath }} />
    </View>
  );
}

/** A soft stretch of colour moving along the track; with Remove animations a still, faint third of it. */
function SweepBar({ color }: { color: string }) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const sweep = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);
  const moving = !reduced && width > 0;
  useEffect(() => {
    if (!moving) return;
    const loop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: SWEEP_MS,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
      sweep.setValue(0);
    };
  }, [moving, sweep]);
  const part = width * 0.35;
  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ height: BAR, borderRadius: BAR / 2, backgroundColor: theme.colors.line2, overflow: 'hidden' }}
    >
      <Animated.View
        style={{
          width: part,
          height: '100%',
          borderRadius: BAR / 2,
          backgroundColor: color,
          opacity: moving ? 0.8 : 0.5,
          transform: moving
            ? [{ translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [-part, width] }) }]
            : [],
        }}
      />
    </View>
  );
}
