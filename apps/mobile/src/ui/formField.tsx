/**
 * A labelled text field for the phone's forms (AP-718: Add to Vault, Replace, a plan's new step): 13/500 ink2 label,
 * a 44dp-min `sf` input with a 12dp radius (`bad` border on a problem), the problem under it as a polite live region,
 * then a quiet hint. `secret` makes it a write-only password field: masked, no autofill, autocorrect or suggestions.
 * `kicker` draws the label as the sheets' mono labels (11/500 `mut`, “REPLY” beside “ALSO SET THE STATUS”).
 */
import type { ComponentProps } from 'react';
import { TextInput, View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';

export function FormField({
  label,
  value,
  onChangeText,
  error,
  hint,
  mono,
  secret,
  multiline,
  kicker,
  ...input
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  error?: string | null | undefined;
  hint?: string | null | undefined;
  mono?: boolean;
  secret?: boolean;
  multiline?: boolean;
  /** The label as a mono kicker, for a sheet whose other labels are (Reply to the reporter). */
  kicker?: boolean;
} & Omit<ComponentProps<typeof TextInput>, 'value' | 'onChangeText' | 'secureTextEntry' | 'multiline'>) {
  const theme = useTheme();
  const metrics = textMetrics({ size: 15.5, family: mono ? 'mono' : 'sans', lineHeight: 1.4 });
  return (
    <View style={{ gap: 6 }}>
      {kicker ? (
        <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
          {label}
        </Text>
      ) : (
        <Text size={13} weight={500} color={theme.colors.ink2}>
          {label}
        </Text>
      )}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        accessibilityLabel={label}
        accessibilityHint={error ?? hint ?? undefined}
        placeholderTextColor={theme.colors.placeholder}
        selectionColor={theme.colors.brand}
        cursorColor={theme.colors.ink}
        multiline={multiline}
        {...(secret
          ? {
              secureTextEntry: true,
              autoComplete: 'off' as const,
              importantForAutofill: 'no' as const,
              autoCorrect: false,
              autoCapitalize: 'none' as const,
              spellCheck: false,
              textContentType: 'none' as const,
            }
          : null)}
        {...input}
        style={{
          minHeight: multiline ? 88 : 44,
          paddingVertical: 10,
          paddingHorizontal: 12,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: error ? theme.colors.bad : theme.colors.line2,
          backgroundColor: theme.colors.sf,
          color: theme.colors.ink,
          fontFamily: metrics.fontFamily,
          fontSize: metrics.fontSize,
          includeFontPadding: false,
          textAlignVertical: multiline ? 'top' : 'center',
        }}
      />
      {error ? (
        <Text size={12.5} lh={1.4} color={theme.colors.bad} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      {hint ? (
        <Text size={12.5} lh={1.4} color={theme.colors.mut}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/** A form's message that isn't one field's: in `bad`, read out when it appears. */
export function FormMessage({ text }: { text: string | null | undefined }) {
  const theme = useTheme();
  if (!text) return null;
  return (
    <Text size={13.5} lh={1.45} color={theme.colors.bad} accessibilityLiveRegion="polite">
      {text}
    </Text>
  );
}
