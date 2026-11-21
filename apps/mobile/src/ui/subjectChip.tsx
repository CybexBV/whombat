/**
 * What a thread in Chat is about (Whombat chat-channel.md CHT-05; chat-channel.md AP-2459): the mockup's chip — the
 * thing's status dot (from Connections' read, already cached by the tab bar) and its name in mono, on a hairline pill.
 * On a thread's first message in the room, and at the right of the thread screen's header.
 */
import { STATUS_LEVEL_WORDS, thingStatusLevel } from '@whombat/client';
import { useHomeOverview } from '@whombat/client/react';
import { type ChatSubject, type ThingStatus, thingId } from '@whombat/core';
import type { StyleProp, ViewStyle } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { openHref } from '../navigation/hooks';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ThingDot } from './assistant';
import { Touchable } from './Touchable';
import { hitSlopFor } from './touchTarget';

/**
 * What a screen reader hears for the chip: the thing and how it is (“pve-02, Needs a look”), or “About pve-02” while
 * its status isn't known.
 */
export function subjectLabel(subject: Pick<ChatSubject, 'name'>, status?: ThingStatus | null): string {
  if (!status || status === 'unknown') return `About ${subject.name}`;
  return `${subject.name}, ${STATUS_LEVEL_WORDS[thingStatusLevel(status)]}`;
}

export function SubjectChip({ subject, style }: { subject: ChatSubject; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const home = useHomeOverview({ params: { burrow: slug } }, { retry: false });
  const id = thingId(subject.kind, subject.id);
  const thing = home.data?.things.find((t) => t.id === id);
  const status = thing?.status;
  const href = thing?.href ?? null;
  // A button to the thing's page once Whombat knows where that is.
  return (
    <Touchable
      onPress={href ? () => openHref(href) : undefined}
      disabled={!href}
      feedback="wash"
      accessibilityRole="button"
      accessibilityLabel={subjectLabel(subject, status)}
      ringRadius={999}
      hitSlop={hitSlopFor(22)}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          alignSelf: 'flex-start',
          gap: 6,
          maxWidth: '100%',
          paddingHorizontal: 8,
          paddingVertical: 2,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: theme.colors.line2,
        },
        style,
      ]}
    >
      {status && status !== 'unknown' ? <ThingDot status={status} /> : null}
      <Text size={11} weight={500} mono color={theme.colors.ink2} numberOfLines={1} style={{ flexShrink: 1 }}>
        {subject.name}
      </Text>
    </Touchable>
  );
}
