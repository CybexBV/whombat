/**
 * “New messages ↓” (MX-01): floats over the bottom of a conversation's list when something new arrived while the reader
 * is further up; a tap scrolls to the newest message. A 44dp pill on `btn`, the toast's shadow. In the tree it comes
 * right after the list and before the composer — where it shows — so TalkBack reads it in order (talkback-order.test.ts
 * lists it apart from the chat files because it floats).
 */
import { View } from 'react-native';
import { NEW_MESSAGES_PILL } from '../data/chatScroll';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Touchable } from './Touchable';

export function NewMessagesPill({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, right: 0, bottom: 12, alignItems: 'center' }}
    >
      <Touchable
        onPress={onPress}
        accessibilityLabel={NEW_MESSAGES_PILL.spoken}
        accessibilityHint={NEW_MESSAGES_PILL.hint}
        accessibilityLiveRegion="polite"
        feedback="fade"
        ringRadius={22}
        style={{
          minHeight: 44,
          paddingHorizontal: 18,
          borderRadius: 22,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.btn,
          boxShadow: theme.shadows.toast.boxShadow,
        }}
      >
        <Text size={14} weight={600} color={theme.colors.btnfg}>
          {NEW_MESSAGES_PILL.label}
        </Text>
      </Touchable>
    </View>
  );
}
