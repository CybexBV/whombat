/**
 * The frame of the phone's managed journeys (AP-22, AP-27; not mocked, B-05): the sign-in screen's language —
 * logo, a mono kicker, a large title, a 15px sub, fields in the 14-radius input style, full-width buttons — with
 * Hazel's tip in a quiet bubble at the bottom (the web's `AuthLayout` aside, on a phone), and settings' grouped
 * cards for lists. Colors only from the theme; every target at least 44dp.
 */
import { type AvatarFace, DEFAULT_AVATAR_FACE } from '@whombat/avatars';
import type { ReactNode } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { WhombatAvatar } from '../avatars/Avatars';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import { BackBar, Screen } from '../ui/headers';
import { KeyboardAvoidingView } from '../ui/keyboard';
import { RowChevron } from '../ui/ListRow';
import { SectionLabel, StatusDot } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { Touchable } from '../ui/Touchable';
import { WhombatLogo } from '../ui/WhombatLogo';

export function Frame({
  kicker,
  title,
  sub,
  tip,
  back,
  hero,
  children,
}: {
  /** The mono line above the title; none on screens drawn without one (bringing a Whombat back). */
  kicker?: string;
  title: string;
  sub?: string | null;
  tip?: string;
  back?: { label: string; onPress: () => void };
  /** A picture between the logo and the kicker (the sign-in screen's, AP-530). */
  hero?: ReactNode;
  children?: ReactNode;
}) {
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 32 + bottomRoom }}
        >
          {back ? (
            <BackBar label={back.label} onPress={back.onPress} />
          ) : (
            <View style={{ flexDirection: 'row', paddingHorizontal: 22, paddingTop: 18 }}>
              <WhombatLogo variant="lockup" height={23} label="Whombat" />
            </View>
          )}
          {hero ? <View style={{ paddingHorizontal: 22, paddingTop: 22 }}>{hero}</View> : null}
          <View style={{ paddingHorizontal: 22, paddingTop: back ? 4 : 22, gap: 6 }}>
            {kicker ? (
              <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
                {kicker}
              </Text>
            ) : null}
            <Text size={30} weight={700} tracking={-0.02} lh={1.15} accessibilityRole="header">
              {title}
            </Text>
            {sub ? (
              <Text size={15} lh={1.5} color={theme.colors.ink2} style={{ paddingTop: 4 }}>
                {sub}
              </Text>
            ) : null}
          </View>
          <View style={{ paddingHorizontal: 22, paddingTop: 18, gap: 16 }}>{children}</View>
          {tip ? <Tip text={tip} /> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * The agent's tip, as on the web's sign-in aside (app one-agent.md AP-4954, AP-4996): Dusty's drawing until a Whombat
 * and its agent exist — these screens come before both. Decorative: the bubble's words say it.
 */
export function Tip({ text, face = DEFAULT_AVATAR_FACE }: { text: string; face?: AvatarFace }) {
  const theme = useTheme();
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingHorizontal: 22, paddingTop: 28 }}
    >
      <WhombatAvatar face={face} size={40} />
      <View
        style={{
          flex: 1,
          paddingVertical: 10,
          paddingHorizontal: 14,
          borderRadius: 16,
          borderBottomLeftRadius: 6,
          backgroundColor: theme.colors.sf2,
        }}
      >
        <Text size={13.5} lh={1.45} color={theme.colors.ink2}>
          {text}
        </Text>
      </View>
    </View>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  mono,
  hint,
  ...input
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  mono?: boolean;
  hint?: string;
  /** The input itself, so a form can move on to its next field. */
  ref?: React.Ref<TextInput>;
} & React.ComponentProps<typeof TextInput>) {
  const theme = useTheme();
  const metrics = textMetrics({ size: 16, family: mono ? 'mono' : 'sans' });
  return (
    <View style={{ gap: 2 }}>
      <SectionLabel>{label.toUpperCase()}</SectionLabel>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        accessibilityLabel={label}
        placeholderTextColor={theme.colors.placeholder}
        selectionColor={theme.colors.brand}
        style={{
          minHeight: 48,
          paddingHorizontal: 14,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: theme.colors.line2,
          backgroundColor: theme.colors.sf,
          color: theme.colors.ink,
          fontFamily: metrics.fontFamily,
          fontSize: metrics.fontSize,
          includeFontPadding: false,
        }}
        {...input}
      />
      {hint ? (
        <Text size={12.5} color={theme.colors.mut} style={{ paddingHorizontal: 6, paddingTop: 4 }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function ErrorLine({ text }: { text: string | null | undefined }) {
  const theme = useTheme();
  if (!text) return null;
  return (
    <Text
      size={14}
      lh={1.45}
      color={theme.colors.bad}
      accessibilityLiveRegion="assertive"
      accessibilityRole="alert"
    >
      {text}
    </Text>
  );
}

export function Note({ text }: { text: string | null | undefined }) {
  const theme = useTheme();
  if (!text) return null;
  return (
    <Text size={14} lh={1.45} color={theme.colors.ink2} accessibilityLiveRegion="polite">
      {text}
    </Text>
  );
}

/** A grouped card of rows (settings' language). */
export function Card({ label, children }: { label?: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View>
      {label ? <SectionLabel>{label}</SectionLabel> : null}
      <View
        style={{
          borderRadius: 20,
          borderWidth: 1,
          borderColor: theme.colors.line,
          backgroundColor: theme.colors.sf,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

export type Dot = 'ok' | 'warn' | 'bad' | 'mut';

export function dotColor(theme: ReturnType<typeof useTheme>, dot: Dot): string {
  return dot === 'ok'
    ? theme.colors.ok
    : dot === 'warn'
      ? theme.colors.warn
      : dot === 'bad'
        ? theme.colors.bad
        : theme.colors.mut;
}

/** A row: optional status dot, title over mono meta, an optional action on the right. */
export function Row({
  dot,
  dotLabel,
  kicker = null,
  title,
  body = null,
  meta,
  action,
  first,
  muted = false,
  children,
}: {
  dot?: Dot;
  /** What the dot means, for TalkBack (defaults to the title). */
  dotLabel?: string;
  /** A small mono line above the title (Reach's “Easy · Whombat Link”). */
  kicker?: string | null;
  title: string;
  /** A plain line under the title, before the mono `meta` (VERSION's “What your assistant runs on”). */
  body?: string | null;
  meta?: string | null;
  action?: ReactNode;
  first?: boolean;
  /** Something that can't be used any more (a retired Whombat, AP-696): its title in the muted color. */
  muted?: boolean;
  /** More under the words, in their column (Reach's “What you get”). */
  children?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      {dot ? <StatusDot color={dotColor(theme, dot)} label={dotLabel ?? title} /> : null}
      <View style={{ flex: 1, gap: 3 }}>
        {kicker ? (
          <Text size={11.5} mono lh={1.4} color={theme.colors.mut}>
            {kicker}
          </Text>
        ) : null}
        <Text size={15} weight={500} lh={1.35} {...(muted && { color: theme.colors.mut })}>
          {title}
        </Text>
        {body ? (
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {body}
          </Text>
        ) : null}
        {meta ? (
          <Text size={12} mono lh={1.45} color={theme.colors.mut}>
            {meta}
          </Text>
        ) : null}
        {children}
      </View>
      {action}
    </View>
  );
}

/**
 * A row that opens a screen (This Whombat's AT A GLANCE, this-whombat-sections-android.md AP-1244): a `Row`'s look with
 * a chevron at the end, the whole 56dp row one button read as `label` (its title and line; the dot is in the words).
 */
export function LinkRow({
  dot,
  title,
  body = null,
  meta,
  label,
  first,
  onPress,
}: {
  dot?: Dot | null;
  title: string;
  /** A plain line under the title, before the mono `meta`, as a `Row` has it. */
  body?: string | null;
  meta?: string | null;
  label: string;
  first?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      feedback="wash"
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      {dot ? (
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor(theme, dot) }} />
      ) : null}
      <View style={{ flex: 1, gap: 3 }}>
        <Text size={15} weight={500} lh={1.35}>
          {title}
        </Text>
        {body ? (
          <Text size={13} lh={1.4} color={theme.colors.mut} numberOfLines={2}>
            {body}
          </Text>
        ) : null}
        {meta ? (
          <Text size={12} mono lh={1.45} color={theme.colors.mut}>
            {meta}
          </Text>
        ) : null}
      </View>
      <RowChevron />
    </Touchable>
  );
}
