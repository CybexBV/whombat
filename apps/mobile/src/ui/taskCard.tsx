/**
 * A server task Whombat follows, while it runs (contracts 0.116, CT-880; docs/decisions/task-feedback.md AP-4305): the
 * live run card's frame on the phone — the breathing dot, what it does (“Installing 23 updates on Home Assistant”) and
 * how long it has run (ticking on the app clock), a thin track whose sheen sweeps across (a task says nothing about how
 * far it is), and the server it runs on, a 44dp link to its page. Nothing moves with “Remove animations”: the dot is
 * still and there is no track. Once it ended the message shows its line (`SettledLineView`), which opens the card.
 */
import type { MarkLike } from '@whombat/brand';
import { formatTaskDuration, taskCardElapsedMs } from '@whombat/core';
import { useEffect, useRef, useState } from 'react';
import { Animated, View } from 'react-native';
import type { TaskCardModel } from '../data/messages';
import { TASK_SECONDS_BELOW_MS } from '../lib/elapsed';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ThingIcon } from './assistant';
import { useElapsedClock, useReducedMotion } from './chat';
import { Touchable } from './Touchable';

/** The 3dp track while a task runs: no fill, only the sheen sweeping across every 1.6 s. */
function TaskSweep() {
  const theme = useTheme();
  const sweep = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(sweep, { toValue: 1, duration: 1600, useNativeDriver: true }));
    loop.start();
    return () => {
      loop.stop();
      sweep.setValue(0);
    };
  }, [sweep]);
  const part = width * 0.4;
  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ height: 3, borderRadius: 1.5, backgroundColor: theme.colors.sf2, overflow: 'hidden' }}
    >
      {part > 0 ? (
        <Animated.View
          style={{
            width: part,
            height: '100%',
            borderRadius: 1.5,
            backgroundColor: theme.colors.progress,
            opacity: 0.8,
            transform: [
              { translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [-part, width] }) },
            ],
          }}
        />
      ) : null}
    </View>
  );
}

export function LiveTaskCardView({
  task,
  clock,
  mark = null,
  onOpenServer,
}: {
  task: TaskCardModel;
  /** The app clock (ms). */
  clock: () => number;
  /** The server's mark, when the app knows what it runs (Home's things); else the server glyph. */
  mark?: MarkLike | null;
  onOpenServer: () => void;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const nowMs = useElapsedClock(clock, task.startedAt, TASK_SECONDS_BELOW_MS);
  const elapsed = formatTaskDuration(taskCardElapsedMs({ startedAt: task.startedAt, endedAt: null }, nowMs));
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1400, useNativeDriver: true }));
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(0);
    };
  }, [reduced, pulse]);
  return (
    <View
      style={{
        alignSelf: 'stretch',
        gap: 6,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        paddingTop: 12,
        paddingBottom: 2,
        paddingHorizontal: 14,
      }}
    >
      <View
        accessible
        accessibilityLabel={`${task.label}, ${task.state}, ${elapsed} so far`}
        style={{ gap: 8 }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Animated.View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: theme.colors.progress,
              opacity: reduced
                ? 1
                : pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.35, 1] }),
            }}
          />
          <Text size={14.5} weight={600} numberOfLines={1} style={{ flex: 1 }}>
            {task.title}
          </Text>
          <Text size={12} weight={500} mono color={theme.colors.mut}>
            {elapsed}
          </Text>
        </View>
        {reduced ? null : <TaskSweep />}
      </View>
      <Touchable
        onPress={onOpenServer}
        feedback="wash"
        accessibilityRole="link"
        accessibilityLabel={`Open ${task.server}`}
        ringRadius={10}
        style={{
          alignSelf: 'flex-start',
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          // The 44dp target reaches into the card's padding rather than spacing the card out.
          marginLeft: -8,
          marginTop: -4,
          paddingHorizontal: 8,
          borderRadius: 10,
        }}
      >
        <ThingIcon glyph="server" mark={mark} size={14} />
        <Text size={13.5} weight={500} color={theme.colors.ink2} numberOfLines={1}>
          {task.server}
        </Text>
      </Touchable>
    </View>
  );
}
