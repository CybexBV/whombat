/**
 * A small mono field for `HH:MM` (Settings → Notifications' quiet hours, AP-513; the desk screen's quiet hours,
 * desk-display-android.md AP-3056): its label beside it, 44dp tall, saved when it rests (blur or submit); a time that
 * isn't one (“25:00”, “7”) is put back.
 */
import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { parseClock } from '../data/notify';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';

export function ClockField({
  label,
  spoken = `${label} time`,
  value,
  onChange,
  disabled,
}: {
  label: string;
  /** What VoiceOver and TalkBack call the field. */
  spoken?: string;
  value: string;
  onChange: (clock: string) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const clock = parseClock(draft);
    if (clock && clock !== value) onChange(clock);
    setDraft(null);
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text size={13} color={theme.colors.mut}>
        {label}
      </Text>
      <TextInput
        value={draft ?? value}
        onChangeText={setDraft}
        onBlur={commit}
        onSubmitEditing={commit}
        editable={!disabled}
        accessibilityLabel={spoken}
        keyboardType="numbers-and-punctuation"
        returnKeyType="done"
        maxLength={5}
        cursorColor={theme.colors.ink}
        selectionColor={theme.colors.brand}
        style={{
          minWidth: 72,
          minHeight: 44,
          paddingHorizontal: 10,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: theme.colors.line2,
          backgroundColor: theme.colors.sf,
          color: theme.colors.ink,
          textAlign: 'center',
          ...textMetrics({ size: 14, family: 'mono' }),
          includeFontPadding: false,
          opacity: disabled ? 0.5 : 1,
        }}
      />
    </View>
  );
}
