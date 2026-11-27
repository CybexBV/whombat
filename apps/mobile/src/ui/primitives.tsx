/**
 * Mobile primitives in the mock's language: buttons (44 / 52dp), filter chips, mono section labels,
 * 20dp grouped lists, status lines and quiet states. Colors come from the theme only.
 */

import type { Tone } from '@whombat/core';
import type { ReactNode } from 'react';
import {
  type AccessibilityState,
  ActivityIndicator,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import { useI18n, useMobileT } from '../i18n';
import { Text } from '../theme/Text';
import { makeStyles, useTheme } from '../theme/theme';
import type { LucideIcon } from './icons';
import { Touchable } from './Touchable';

export function toneColor(theme: ReturnType<typeof useTheme>, tone: Tone | null | undefined): string {
  switch (tone) {
    case 'ok':
      return theme.colors.ok;
    case 'warn':
      return theme.colors.warn;
    case 'bad':
      return theme.colors.bad;
    default:
      return theme.colors.mut;
  }
}

/* Buttons ------------------------------------------------------------------------------------------ */

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'quiet';
  /** `md`: 44dp, radius 12, 15px (inbox). `lg`: 52dp, radius 14, 16px (sticky footers). */
  size?: 'md' | 'lg';
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  /** What TalkBack reads when the word on the button needs its row to make sense (“Check” → “Check for updates”). */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: AccessibilityState;
  /** The label wraps onto more lines instead of being cut (large text). */
  wrap?: boolean;
  /** A small icon before the label, in its colour. */
  icon?: LucideIcon;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled,
  busy,
  style,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  wrap = false,
  icon: Icon,
}: ButtonProps) {
  const theme = useTheme();
  const lg = size === 'lg';
  const primary = variant === 'primary';
  const color = primary ? theme.colors.btnfg : variant === 'quiet' ? theme.colors.mut : theme.colors.ink;
  return (
    <Touchable
      onPress={onPress}
      disabled={disabled || busy}
      feedback={primary ? 'fade' : 'wash'}
      ringRadius={lg ? 14 : 12}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={accessibilityState}
      style={[
        {
          minHeight: lg ? 52 : 44,
          borderRadius: lg ? 14 : 12,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 12,
          backgroundColor: primary ? theme.colors.btn : 'transparent',
          borderWidth: primary ? 0 : 1,
          borderColor: theme.colors.line2,
          opacity: disabled ? 0.45 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={color} />
      ) : Icon ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon size={lg ? 18 : 17} color={color} strokeWidth={1.9} />
          <Text size={lg ? 16 : 15} weight={primary ? 600 : 500} color={color} numberOfLines={1}>
            {label}
          </Text>
        </View>
      ) : (
        <Text
          size={lg ? 16 : 15}
          weight={primary ? 600 : 500}
          color={color}
          numberOfLines={wrap ? undefined : 1}
          style={wrap ? { textAlign: 'center', paddingVertical: 8 } : undefined}
        >
          {label}
        </Text>
      )}
    </Touchable>
  );
}

/* Filter chips ------------------------------------------------------------------------------------- */

export function Chip({
  label,
  active,
  onPress,
  count,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  count?: number;
}) {
  const theme = useTheme();
  const fg = active ? theme.colors.btnfg : theme.colors.ink;
  return (
    <Touchable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={count !== undefined ? `${label}, ${count}` : label}
      feedback={active ? 'fade' : 'wash'}
      ringRadius={999}
      // Content height is ~30.8dp (14px text, normal line-height, 7+7 vertical padding); +7 each edge
      // clears the 44dp minimum with a small margin.
      hitSlop={{ top: 7, bottom: 7 }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 7,
        paddingHorizontal: 13,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? theme.colors.btn : theme.colors.line2,
        backgroundColor: active ? theme.colors.btn : 'transparent',
      }}
    >
      <Text size={14} weight={500} color={fg}>
        {label}
      </Text>
      {count !== undefined ? (
        <Text size={12} mono color={fg} style={{ opacity: 0.7 }}>
          {count}
        </Text>
      ) : null}
    </Touchable>
  );
}

/* Grouped lists ------------------------------------------------------------------------------------ */

/** `NEEDS YOU` — DM Mono 500 11px, .05em, mut; 8 × 6 padding as in the mock. */
export function SectionLabel({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <Text
      size={11}
      weight={500}
      mono
      tracking={0.05}
      color={theme.colors.mut}
      accessibilityRole="header"
      style={{ paddingVertical: 8, paddingHorizontal: 6 }}
    >
      {children}
    </Text>
  );
}

/** A mock "grouped list" section: label + a 20dp-radius card of rows (padding 0 16 14); untitled, the card only. */
export function Section({ title, children }: { title?: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.section}>
      {title ? <SectionLabel>{title}</SectionLabel> : null}
      <View style={styles.group}>{children}</View>
    </View>
  );
}

/** A quiet paragraph inside a grouped-list card (a note under its rows): 13.5/1.45 mut, padding 12 16, bottom hairline. */
export function CardNote({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      <Text size={13.5} lh={1.45} color={theme.colors.mut}>
        {children}
      </Text>
    </View>
  );
}

/* Status line ---------------------------------------------------------------------------------------- */

/** `● Approved · deploying` — 7dp dot + mono 500 12px in the tone color. */
export function StatusLine({ text, tone }: { text: string; tone: Tone | null }) {
  const theme = useTheme();
  const color = toneColor(theme, tone);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 4 }} accessible>
      <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: color }} />
      <Text size={12} weight={500} mono color={color}>
        {text}
      </Text>
    </View>
  );
}

/** Agent status dot (working / waiting / idle) with an accessible label. */
export function StatusDot({ color, label, size = 8 }: { color: string; label: string; size?: number }) {
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }}
    />
  );
}

/* Quiet states --------------------------------------------------------------------------------------- */

export function QuietText({ children, style }: { children: string; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  return (
    <View style={[{ paddingHorizontal: 22, paddingVertical: 28 }, style]}>
      <Text size={15} lh={1.5} color={theme.colors.mut} style={{ textAlign: 'center' }}>
        {children}
      </Text>
    </View>
  );
}

export function Loading({ label: givenLabel }: { label?: string }) {
  const { t: tMobile } = useMobileT();
  const label = givenLabel ?? tMobile('screens2.common.loading');
  const theme = useTheme();
  return (
    <View
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 }}
      accessibilityLabel={label}
    >
      <ActivityIndicator color={theme.colors.mut} />
    </View>
  );
}

/** One quiet block, sized to match a row's geometry (TODO 16.4). */
export function Skeleton({
  width = '100%',
  height = 12,
  radius = 6,
  style,
}: {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return <View style={[{ width, height, borderRadius: radius, backgroundColor: theme.colors.sf2 }, style]} />;
}

/**
 * Skeleton rows matching a list row's geometry, in place of a spinner over the whole screen
 * (README/TODO 16.4): an optional leading avatar circle and one or more text lines, repeated
 * `count` times.
 */
export function SkeletonRows({
  count = 5,
  avatarSize,
  lines = 2,
  label: givenLabel,
}: {
  count?: number;
  avatarSize?: number;
  lines?: number;
  label?: string;
}) {
  const { t: tMobile } = useMobileT();
  const label = givenLabel ?? tMobile('screens2.common.loading');
  const widths: `${number}%`[] = ['62%', '40%', '78%', '52%'];
  return (
    <View style={{ padding: 16, gap: 18 }} accessibilityLabel={label}>
      {Array.from({ length: count }, (_, row) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length, static skeleton list
        <View key={row} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          {avatarSize !== undefined && (
            <Skeleton width={avatarSize} height={avatarSize} radius={avatarSize / 2} />
          )}
          <View style={{ flex: 1, gap: 8 }}>
            {Array.from({ length: lines }, (_, line) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length, static skeleton list
              <Skeleton key={line} height={11} width={widths[(row + line) % widths.length]} />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

export function ErrorState({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const { tClient } = useI18n();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 16 }}>
      <QuietText style={{ paddingVertical: 0 }}>{text}</QuietText>
      {onRetry ? <Button label={tClient('settings.retry')} variant="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

const useStyles = makeStyles((t) =>
  StyleSheet.create({
    section: { paddingHorizontal: 16, paddingBottom: 14 },
    group: {
      borderRadius: 20,
      backgroundColor: t.colors.sf,
      borderWidth: 1,
      borderColor: t.colors.line,
      overflow: 'hidden',
    },
  }),
);
