/**
 * Pieces of a guest's screen on the phone (proxmox-mobile.md AP-1485…): a settings row (a mono label, the value, a
 * quiet line, and its Change or Grow button), the review step's lines “Memory  4 GiB → 8 GiB”, a labelled switch row,
 * a row of choices (storages, how to back up), a figure tile and the small header tags. Colours only from the theme;
 * every control is 44dp or more, and every row is read as one sentence.
 */

import type { ReviewLine } from '@whombat/client/hosts/mobile';
import type { ReactNode } from 'react';
import { Switch, View } from 'react-native';
import { useMobileT } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { MonoLabel } from '../../ui/assistant';
import { Chip } from '../../ui/primitives';
import { switchColors } from '../../ui/switchColors';
import { Touchable } from '../../ui/Touchable';

/** A card's settings row: label over value (and a quiet line), with its action at the end. */
export function SettingLine({
  label,
  value,
  sub,
  mono,
  action,
  first,
}: {
  label: string;
  value: string;
  sub?: string | null;
  mono?: boolean;
  action?: ReactNode;
  first?: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 11,
        paddingHorizontal: 14,
        minHeight: 52,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View
        accessible
        accessibilityLabel={[label, value || null, sub].filter(Boolean).join(', ')}
        style={{ flex: 1, minWidth: 0, gap: 2 }}
      >
        <Text size={12.5} color={theme.colors.mut}>
          {label}
        </Text>
        {value ? (
          <Text size={mono ? 14 : 15} weight={500} mono={mono} numberOfLines={4}>
            {value}
          </Text>
        ) : null}
        {sub ? (
          <Text size={12.5} mono={mono} color={theme.colors.mut} numberOfLines={2}>
            {sub}
          </Text>
        ) : null}
      </View>
      {action}
    </View>
  );
}

/** A row's small action (Change, Grow): 44dp, outlined, named for TalkBack with what it changes (“Change memory”). */
export function RowAction({
  label,
  spoken,
  onPress,
}: {
  label: string;
  spoken: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={12}
      accessibilityLabel={spoken}
      style={{
        minHeight: 44,
        minWidth: 64,
        paddingHorizontal: 14,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text size={14} weight={500}>
        {label}
      </Text>
    </Touchable>
  );
}

/** The review: each change `label  old → new`, then what a running guest takes later. */
export function ReviewList({ lines, note }: { lines: readonly ReviewLine[]; note?: string | null }) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  if (!lines.length)
    return (
      <Text size={14.5} lh={1.45} color={theme.colors.ink2} style={{ marginTop: 12 }}>
        {tMobile('screens.nothing-to-change-it-already-is-like-this')}
      </Text>
    );
  return (
    <View style={{ marginTop: 14, gap: 8 }}>
      <MonoLabel>{tMobile('screens.review-the-change')}</MonoLabel>
      {lines.map((l) => (
        <View
          key={l.key}
          accessible
          accessibilityLabel={`${l.label}: ${l.old}, becomes ${l.new}`}
          style={{
            gap: 2,
            paddingVertical: 10,
            paddingHorizontal: 12,
            borderRadius: 12,
            backgroundColor: theme.colors.sf2,
          }}
        >
          <Text size={12.5} color={theme.colors.mut}>
            {l.label}
          </Text>
          <Text size={14.5} lh={1.4}>
            <Text size={14.5} color={theme.colors.mut} style={{ textDecorationLine: 'line-through' }}>
              {l.old}
            </Text>
            {'  →  '}
            <Text size={14.5} weight={600}>
              {l.new}
            </Text>
          </Text>
        </View>
      ))}
      {note ? (
        <Text size={13} lh={1.45} color={theme.colors.mut}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/** A switch with its words, the whole 52dp row one control. */
export function SwitchLine({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52 }}>
      <Text size={15} lh={1.35} style={{ flex: 1 }}>
        {label}
      </Text>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        accessibilityLabel={label}
        style={{ minHeight: 44 }}
        {...switchColors(theme, value)}
      />
    </View>
  );
}

/** One of a few choices (a storage, how to back up), as chips that wrap. */
export function Choices<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text size={13} weight={500} color={theme.colors.ink2}>
        {label}
      </Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
      >
        {options.map((o) => (
          <Chip key={o.value} label={o.label} active={o.value === value} onPress={() => onChange(o.value)} />
        ))}
      </View>
    </View>
  );
}

/** A figure: a mono label, the value, a quiet note (the Summary's four, two by two). */
export function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}${note ? `, ${note}` : ''}`}
      style={{
        flexBasis: '47%',
        flexGrow: 1,
        gap: 4,
        padding: 12,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
      }}
    >
      <MonoLabel>{label}</MonoLabel>
      <Text
        size={19}
        weight={700}
        tracking={-0.01}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.8}
      >
        {value}
      </Text>
      <Text size={12.5} color={theme.colors.mut} numberOfLines={1}>
        {note}
      </Text>
    </View>
  );
}

/** A guest's tags under its name: small mono pills on `sf2`. Decorative (the header's label reads them). */
export function Tags({ tags }: { tags: readonly string[] }) {
  const theme = useTheme();
  if (!tags.length) return null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}
    >
      {tags.map((t) => (
        <View
          key={t}
          style={{
            borderRadius: 999,
            paddingVertical: 2,
            paddingHorizontal: 9,
            backgroundColor: theme.colors.sf2,
          }}
        >
          <Text size={11.5} weight={500} mono color={theme.colors.ink2}>
            {t}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** A quiet sentence inside a card (an empty list, why something isn't here). */
export function CardQuiet({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <Text
      size={14}
      lh={1.45}
      color={theme.colors.mut}
      style={{ paddingHorizontal: 14, paddingBottom: 14, paddingTop: 2 }}
    >
      {children}
    </Text>
  );
}
