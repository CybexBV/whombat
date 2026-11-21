/** `NEEDS A PERSON` — mono 10.5/500 in the tone, 1dp tone outline, pill. */
import type { Tone } from '@whombat/core';
import { View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { toneColor } from './primitives';

export function StatusPill({ text, tone }: { text: string; tone: Tone }) {
  const theme = useTheme();
  const color = toneColor(theme, tone);
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        paddingVertical: 2,
        paddingHorizontal: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: tone === 'neutral' ? theme.colors.line2 : color,
      }}
    >
      <Text size={10.5} weight={500} mono tracking={0.05} color={color} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}
