/**
 * The `HH:MM` field on iPhone: iOS's own compact time picker, drawn by SwiftUI through `@expo/ui`, its label beside it
 * as on Android (Settings → Notifications' quiet hours, the desk screen's quiet hours). A time picked is saved as the
 * same `HH:MM`; iOS shows it in 24 or 12 hours as the phone is set.
 */
import { DatePicker, Host } from '@expo/ui/swift-ui';
import {
  accessibilityLabel,
  datePickerStyle,
  disabled as disabledModifier,
  environment,
} from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { clockDate, dateClock } from './clockDate';
import { useHeldPick } from './heldPick';

export function ClockField({
  label,
  spoken = `${label} time`,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  /** What VoiceOver and TalkBack call the field. */
  spoken?: string;
  value: string;
  onChange: (clock: string) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const { key, pick } = useHeldPick(value, onChange);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text size={13} color={theme.colors.mut}>
        {label}
      </Text>
      <Host matchContents colorScheme={theme.name} seedColor={theme.colors.brand}>
        <DatePicker
          key={key}
          selection={clockDate(value)}
          displayedComponents={['hourAndMinute']}
          onDateChange={(date) => {
            const clock = dateClock(date);
            if (clock !== value) pick(clock);
          }}
          modifiers={[
            datePickerStyle('compact'),
            environment('timeZone', 'UTC'),
            disabledModifier(disabled),
            accessibilityLabel(spoken),
          ]}
        />
      </Host>
    </View>
  );
}
