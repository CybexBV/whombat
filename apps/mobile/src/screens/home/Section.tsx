/**
 * Overview's sections and the Inbox's group labels. A section of Overview (docs/decisions/overview-one-page.md OVP-01, OVP-10; the mock's `.sech` at phone width): its
 * heading (19/700) with its count (mono 12/500, `mut`), the link that adds to it on a line of its own
 * (14, `brand`, 18 apart), then its summary line (14, `mut`), 12 above what it holds.
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { Plus } from '../../ui/icons';
import { Touchable } from '../../ui/Touchable';

export function OverviewSection({
  label,
  count,
  summary,
  links,
  children,
}: {
  label: string;
  /** The number beside the heading; null leaves it out. */
  count: number | null;
  /** The line under the links (“5 running · 1 not working”); empty leaves it out. */
  summary: string;
  links?: ReactNode;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: 12 }}>
      <View style={{ gap: 6 }}>
        {/* One header for a screen reader: “Servers, 6”. */}
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel={count !== null ? `${label}, ${count}` : label}
          style={{ flexDirection: 'row', alignItems: 'baseline', gap: 12 }}
        >
          <Text size={19} weight={700} tracking={-0.01}>
            {label}
          </Text>
          {count !== null ? (
            <Text size={12} weight={500} mono color={theme.colors.mut}>
              {count}
            </Text>
          ) : null}
        </View>
        {links ? (
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              alignItems: 'center',
              columnGap: 18,
              marginTop: 6,
            }}
          >
            {links}
          </View>
        ) : null}
        {summary ? (
          <Text size={14} lh={1.45} color={theme.colors.mut}>
            {summary}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/** A heading's link (the mock's `.sech .links a`): “+ Add a server”, 14 in `brand`, 44dp tall for the finger. */
export function SectionLink({ label, onPress, hint }: { label: string; onPress: () => void; hint?: string }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="fade"
      ringRadius={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 4, marginVertical: -8 }}
    >
      <Plus size={14} color={theme.colors.brand} strokeWidth={1.75} />
      <Text size={14} color={theme.colors.brand}>
        {label}
      </Text>
    </Touchable>
  );
}

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
