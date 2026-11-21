/**
 * The pieces of settling threads on the phone (chat-settle.md AP-6154, AP-6157, AP-6251; the mock's phone): “Settled”
 * after the time of a settled thread still in its room, the thread screen's ✓ Settle in the `ok` tone, and a settled
 * thread's line under its head (✓ “Settled 2 hours ago” and Open again, on the `ok` tint). Colours from the theme only.
 */
import { Platform, View } from 'react-native';
import { SETTLE_COPY } from '../data/threadSettle';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { tint } from './glanceColors';
import { CircleCheck, Share, Share2 } from './icons';
import { Touchable } from './Touchable';
import { hitSlopFor } from './touchTarget';

/** “Settled” after the time of a settled thread still in its room (AP-6251): the time's mono, in the `ok` tone. */
export function SettledMark() {
  const theme = useTheme();
  return (
    <Text size={11.5} mono color={theme.colors.ok}>
      {SETTLE_COPY.mark}
    </Text>
  );
}

/** The thread screen's Settle (the mock's `.hbtn.ok`): ✓ and the word in `ok`, on an `ok` hairline, 44dp. */
export function SettleButton({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={9}
      accessibilityLabel={SETTLE_COPY.settleThread}
      accessibilityHint={SETTLE_COPY.settleHint}
      hitSlop={hitSlopFor(34)}
      style={{
        height: 34,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 11,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: tint(theme.colors.ok, 0.35),
      }}
    >
      <CircleCheck size={15} color={theme.colors.ok} strokeWidth={1.7} />
      <Text size={13} weight={500} color={theme.colors.ok}>
        {SETTLE_COPY.settle}
      </Text>
    </Touchable>
  );
}

/**
 * Share this thread (share-links.md): the platform's own share mark (the box and arrow on iPhone, the three dots on
 * Android) in a Chat thread's header, before Settle.
 */
export function ShareThreadButton({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  const Mark = Platform.OS === 'ios' ? Share : Share2;
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={9}
      accessibilityLabel="Share this thread"
      accessibilityHint="Makes a link to a copy of this thread"
      hitSlop={hitSlopFor(34)}
      style={{ width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 9 }}
    >
      <Mark size={18} color={theme.colors.ink2} strokeWidth={1.7} />
    </Touchable>
  );
}

/** A settled thread, opened (AP-6154; the mock's `.state`): ✓ “Settled 2 hours ago” and Open again, on the `ok` tint. */
export function SettledThreadLine({ when, onOpenAgain }: { when: string; onOpenAgain: () => void }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginTop: 8,
        marginHorizontal: 16,
        paddingLeft: 12,
        paddingRight: 6,
        paddingVertical: 4,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: tint(theme.colors.ok, 0.22),
        backgroundColor: tint(theme.colors.ok, 0.08),
      }}
    >
      <CircleCheck size={15} color={theme.colors.ok} strokeWidth={1.7} />
      <Text
        size={13.5}
        color={theme.colors.ink2}
        accessibilityLiveRegion="polite"
        numberOfLines={1}
        style={{ flex: 1, minWidth: 0 }}
      >
        {when}
      </Text>
      <Touchable
        onPress={onOpenAgain}
        feedback="wash"
        ringRadius={8}
        accessibilityHint={SETTLE_COPY.openAgainHint}
        hitSlop={hitSlopFor(32)}
        style={{
          height: 32,
          justifyContent: 'center',
          paddingHorizontal: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: theme.colors.line2,
        }}
      >
        <Text size={13} weight={600}>
          {SETTLE_COPY.openAgain}
        </Text>
      </Touchable>
    </View>
  );
}
