/**
 * Today on the arranged Overview (docs/decisions/overview-arranged.md; the mock's `.today` at phone width, where
 * the day's line gives way to its moments one under the other): “Today”, “7 things so far · 2 planned” and *All
 * activity* (the Inbox), then the last three moments — what the assistant finished, the automations that ran or failed
 * (in `bad`), what is still planned (a hollow dot) — each with its time and where it came from, and *Show all*. Nothing
 * today: the card isn't drawn.
 */
import type { HomeOverview } from '@whombat/core';
import { dayKey } from '@whombat/core/text';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useBurrowBase, useNow } from '../../data/BurrowProvider';
import {
  arrangedPhoneWords,
  type TodayMoment,
  todayCounts,
  todayMoments,
  todayShown,
} from '../../data/overviewArranged';
import { useAgentWords } from '../../data/useAgent';
import { useI18n } from '../../i18n';
import { openHref } from '../../navigation/hooks';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { Touchable } from '../../ui/Touchable';

export function TodayCard({
  overview,
  onAll,
}: {
  overview: Pick<HomeOverview, 'doneToday' | 'automationsToday'>;
  /** *All activity*: the Inbox. */
  onAll: () => void;
}) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  const W = arrangedPhoneWords(rawLocale);
  const { timeZone } = useBurrowBase();
  const now = useNow();
  const assistant = useAgentWords();
  const day = dayKey(now, timeZone);
  // The day's moments, read again when the day turns or Home changes (not every second).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `day` stands for `now`
  const moments = useMemo(
    () => todayMoments(overview, now, timeZone, assistant.name, rawLocale),
    [overview, day, timeZone, assistant.name, rawLocale],
  );
  const [all, setAll] = useState(false);
  if (!moments.length) return null;
  const counts = todayCounts(moments);
  const shown = todayShown(moments, all);
  return (
    <View
      style={{
        backgroundColor: theme.colors.sf,
        borderWidth: 1,
        borderColor: theme.colors.line,
        borderRadius: 18,
        paddingTop: 14,
        paddingHorizontal: 14,
        paddingBottom: 8,
        gap: 8,
      }}
    >
      <View style={{ gap: 2, paddingHorizontal: 2 }}>
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel={`${W.today}, ${W.todayCount(counts.done, counts.planned)}`}
          style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 12 }}
        >
          <Text size={19} weight={700} tracking={-0.01}>
            {W.today}
          </Text>
          <Text size={14} color={theme.colors.mut}>
            {W.todayCount(counts.done, counts.planned)}
          </Text>
        </View>
        <Touchable
          onPress={onAll}
          feedback="fade"
          ringRadius={8}
          accessibilityRole="link"
          accessibilityLabel={W.allActivity}
          style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', marginVertical: -6 }}
        >
          <Text size={14} color={theme.colors.brand}>
            {W.allActivity}
          </Text>
        </Touchable>
      </View>
      <View style={{ gap: 8 }}>
        {shown.map((m) => (
          <MomentChip key={m.id} moment={m} />
        ))}
      </View>
      {moments.length > shown.length || all ? (
        <Touchable
          onPress={() => setAll((a) => !a)}
          feedback="fade"
          ringRadius={8}
          accessibilityRole="button"
          accessibilityState={{ expanded: all }}
          accessibilityLabel={all ? W.showLess : W.showAll}
          style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 2 }}
        >
          <Text size={14} color={theme.colors.brand}>
            {all ? W.showLess : W.showAll}
          </Text>
        </Touchable>
      ) : null}
    </View>
  );
}

/**
 * One moment (the mock's `.chip` at phone width): a dot in its tone (hollow and dashed when planned), what happened
 * (14/500; a failure in `bad`) over its time and where it came from (mono 11.5, `mut`), on `bg` in a hairline, radius
 * 12. One element for a screen reader; a link where it has a place to open.
 */
function MomentChip({ moment }: { moment: TodayMoment }) {
  const { rawLocale } = useI18n();
  const W = arrangedPhoneWords(rawLocale);
  const theme = useTheme();
  const plan = moment.tone === 'plan';
  const dot = moment.tone === 'bad' ? theme.colors.bad : theme.colors.ok;
  const spoken = [
    moment.text,
    moment.time,
    moment.from,
    plan ? W.planned : moment.tone === 'bad' ? W.failed : null,
  ]
    .filter(Boolean)
    .join(', ');
  const body = (
    <>
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          ...(plan
            ? { borderWidth: 1.5, borderStyle: 'dashed' as const, borderColor: theme.colors.mut }
            : { backgroundColor: dot }),
        }}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          size={14}
          weight={500}
          numberOfLines={1}
          color={moment.tone === 'bad' ? theme.colors.bad : theme.colors.ink}
        >
          {moment.text}
        </Text>
        <Text size={11.5} mono color={theme.colors.mut} numberOfLines={1}>
          {`${moment.time} · ${moment.from}`}
        </Text>
      </View>
    </>
  );
  const frame = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    minHeight: 44,
    paddingTop: 8,
    paddingBottom: 9,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.line,
    backgroundColor: theme.colors.bg,
  };
  const href = moment.href;
  return href ? (
    <Touchable
      onPress={() => openHref(href)}
      feedback="wash"
      ringRadius={12}
      accessibilityRole="link"
      accessibilityLabel={spoken}
      style={frame}
    >
      {body}
    </Touchable>
  ) : (
    <View accessible accessibilityLabel={spoken} style={frame}>
      {body}
    </View>
  );
}
