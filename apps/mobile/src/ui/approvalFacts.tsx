/**
 * The one approval card's facts on the phone (approval-card.md), shared by the approval screen, the Inbox's approval
 * row and its sheet: a labelled fact (“PERMISSION USED” over its key) and the box saying the exact moment *Yes,
 * tonight* means. Text wraps and grows with the system's size (the app's 1.6× cap); nothing is clamped.
 */
import type { ApprovalTonightView } from '@whombat/core/approvals';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';

/** A labelled fact before the answers. */
export function ApprovalFact({ label, children }: { label: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 5 }}>
      <Text size={11} weight={500} mono tracking={0.045} uppercase color={theme.colors.mut}>
        {label}
      </Text>
      {typeof children === 'string' ? (
        <Text size={15.5} lh={1.5} color={theme.colors.ink2}>
          {children}
        </Text>
      ) : (
        children
      )}
    </View>
  );
}

/** “**Yes, tonight** means Thursday, 24 September 2026 at 03:00 · Europe/Amsterdam.” */
export function TonightBox({ tonight }: { tonight: ApprovalTonightView }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${tonight.label} ${tonight.means} ${tonight.at}.`}
      style={{
        borderRadius: 10,
        backgroundColor: theme.colors.sf2,
        paddingVertical: 12,
        paddingHorizontal: 14,
      }}
    >
      <Text size={14} lh={1.55} color={theme.colors.ink2}>
        <Text size={14} weight={600} lh={1.55} color={theme.colors.ink2}>
          {tonight.label}
        </Text>{' '}
        {tonight.means}
        {'\n'}
        {tonight.at}.
      </Text>
    </View>
  );
}
