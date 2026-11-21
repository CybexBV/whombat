/**
 * KEYS rows on the phone (AP-713), the web's `TierRow` and `ToggleRow` in the list rows' language: a row by risk with
 * its line under it and Off · Ask · On (the settings sheet's segmented control, 44dp with its padding), a switch row
 * (a 44dp switch), and a locked row with its note. Used by Settings → Agent's keys.
 */
import { TIER_SEGMENTS } from '@whombat/client';
import type { Tier } from '@whombat/core/keys';
import type { ReactNode } from 'react';
import { Switch, View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Segmented } from './Segmented';
import { switchColors } from './switchColors';

function RowFrame({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        gap: 8,
        paddingVertical: 13,
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      {children}
    </View>
  );
}

/** “Merge into main”, its line (“Merge pull requests into main.”) and Off · Ask · On. */
export function TierSegmentRow({
  label,
  description,
  hint,
  tier,
  onChange,
  options = TIER_SEGMENTS,
  disabled = false,
}: {
  label: string;
  description?: string | null;
  /** Deploy's “No deploy workflow is set up on this Whombat yet.” */
  hint?: string | null;
  tier: Tier;
  onChange: (tier: Tier) => void;
  /** The choices, Off · Ask · On by default (an account's keys: Allowed · Asks · Off). */
  options?: readonly { value: Tier; label: string }[];
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <RowFrame>
      <View style={{ gap: 3 }}>
        <Text size={15.5} weight={600}>
          {label}
        </Text>
        {description || hint ? (
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {[description, hint].filter(Boolean).join(' ')}
          </Text>
        ) : null}
      </View>
      <Segmented options={options} value={tier} onChange={onChange} label={label} disabled={disabled} />
    </RowFrame>
  );
}

/** A key as a switch, with its note under it (“included with the browser”); a locked one doesn't move. */
export function KeySwitchRow({
  label,
  on,
  note,
  locked,
  onChange,
}: {
  label: string;
  on: boolean;
  note?: string | null;
  locked?: boolean;
  onChange?: (on: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 6,
        paddingHorizontal: 16,
        minHeight: 56,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2, paddingVertical: 6 }}>
        <Text size={15} color={locked ? theme.colors.mut : theme.colors.ink}>
          {label}
        </Text>
        {note ? (
          <Text size={12} mono color={theme.colors.mut}>
            {note}
          </Text>
        ) : null}
      </View>
      <Switch
        value={on}
        disabled={!!locked || !onChange}
        onValueChange={(v) => onChange?.(v)}
        accessibilityLabel={label}
        accessibilityHint={note ?? undefined}
        accessibilityRole="switch"
        {...switchColors(theme, on)}
        style={{ minHeight: 44 }}
      />
    </View>
  );
}
