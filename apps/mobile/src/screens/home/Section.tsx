/** The Inbox's group labels. */
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';

/**
 * A group's label over its card (the Inbox's groups; mock `.plabel`): mono 11.5/500, .06em, uppercase, `mut`, 4dp in
 * from the card's edge, 8dp above it.
 */
export function Section({ label, children }: { label: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <View style={{ paddingHorizontal: 4, minHeight: 18, justifyContent: 'center' }}>
        <Text
          size={11.5}
          weight={500}
          mono
          tracking={0.06}
          uppercase
          color={theme.colors.mut}
          accessibilityRole="header"
        >
          {label}
        </Text>
      </View>
      {children}
    </View>
  );
}
