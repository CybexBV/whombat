/**
 * Small parts the parity screens share (mobile-parity.md MQ-01…MQ-06), in the list rows' language: facts as the web's
 * settings rows show them (a mono label, the value beside it), a quiet or `bad` note inside a grouped card, and a row of
 * buttons under a row's text. Colours through the theme only; the buttons are the audited 44dp `Button`.
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';

/** SIZE · Container · 2 CPUs …, NEXT · Thu 24 Sep at 08:30: a mono label column and the value. */
export function Facts({ facts }: { facts: readonly { label: string; value: string }[] }) {
  const theme = useTheme();
  if (!facts.length) return null;
  return (
    <View style={{ gap: 4 }}>
      {facts.map((f) => (
        <View
          key={f.label}
          accessible
          accessibilityLabel={`${f.label}: ${f.value}`}
          style={{ flexDirection: 'row', gap: 10, alignItems: 'baseline' }}
        >
          <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut} style={{ minWidth: 76 }}>
            {f.label}
          </Text>
          <Text size={13.5} lh={1.4} color={theme.colors.ink2} style={{ flex: 1 }}>
            {f.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** A note inside a grouped card: quiet, or `bad` and read out when it appears (a refusal). */
export function CardLine({ text, tone }: { text: string | null | undefined; tone?: 'bad' }) {
  const theme = useTheme();
  if (!text) return null;
  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      <Text
        size={13.5}
        lh={1.45}
        color={tone === 'bad' ? theme.colors.bad : theme.colors.mut}
        accessibilityLiveRegion={tone === 'bad' ? 'polite' : undefined}
      >
        {text}
      </Text>
    </View>
  );
}

/** Buttons under a row's text (Pause · Remove, Start · Reset…), wrapping on a narrow phone. */
export function RowButtons({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 8 }}>{children}</View>;
}
