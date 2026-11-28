import { useProtectedSupported } from '@whombat/client/react';
import { protectedPageWords } from '@whombat/core';
import { View } from 'react-native';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { RowChevron } from './ListRow';
import { Touchable } from './Touchable';

/**
 * The way to What's protected (backup-trust.md) under This Whombat's backups, on a Whombat that has it (nothing on an
 * older one). Under the servers it is a row of the list instead.
 */
export function ProtectedLink({ onPress, inset = 8 }: { onPress: () => void; inset?: number }) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const supported = useProtectedSupported();
  if (!supported) return null;
  const words = protectedPageWords(rawLocale);
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      accessibilityRole="button"
      accessibilityLabel={`${words.link}. ${words.linkHint}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        marginHorizontal: inset,
        marginTop: inset ? 12 : 0,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderWidth: 1,
        borderColor: theme.colors.line,
        borderRadius: 16,
        backgroundColor: theme.colors.sf,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text size={15.5} weight={600}>
          {words.link}
        </Text>
        <Text size={13} lh={1.4} color={theme.colors.mut}>
          {words.linkHint}
        </Text>
      </View>
      <RowChevron />
    </Touchable>
  );
}
