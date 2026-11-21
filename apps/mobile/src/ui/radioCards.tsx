/**
 * Radio cards (phone-connect.md PC-11, AP-2911): one bordered card of rows, each a 20dp ring, a title (with a
 * “Recommended” tag where it is) and a line under it — Add a server's key rows, for choosing whose a connection is, what
 * agents may do and how Whombat signs in. One radio group for TalkBack; a disabled row says why in its line. Rows are
 * at least 52dp.
 */
import { View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Touchable } from './Touchable';

export interface RadioCard<T extends string | number> {
  value: T;
  title: string;
  line?: string | null;
  /** “Recommended” (the web's brand tag). */
  tag?: string | null;
  disabled?: boolean;
}

export function RadioCards<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  /** The group's name for TalkBack (“How Whombat signs in”). */
  label: string;
  options: readonly RadioCard<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        const off = disabled || !!o.disabled;
        return (
          <Touchable
            key={String(o.value)}
            onPress={() => onChange(o.value)}
            disabled={off}
            feedback="wash"
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, selected, disabled: off }}
            accessibilityLabel={[o.title, o.tag, o.line].filter(Boolean).join('. ')}
            style={{
              minHeight: 52,
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: 12,
              paddingVertical: 11,
              paddingHorizontal: 12,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: theme.colors.line,
              opacity: o.disabled ? 0.55 : 1,
            }}
          >
            <View
              style={{
                width: 20,
                height: 20,
                marginTop: 1,
                borderRadius: 10,
                borderWidth: selected ? 6 : 1.5,
                borderColor: selected ? theme.colors.btn : theme.colors.line2,
              }}
            />
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Text size={15} weight={600}>
                  {o.title}
                </Text>
                {o.tag ? (
                  <View
                    style={{
                      paddingVertical: 1,
                      paddingHorizontal: 7,
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: theme.colors.brand,
                    }}
                  >
                    <Text size={10.5} weight={500} mono tracking={0.05} color={theme.colors.brand}>
                      {o.tag}
                    </Text>
                  </View>
                ) : null}
              </View>
              {o.line ? (
                <Text size={13} lh={1.4} color={theme.colors.mut}>
                  {o.line}
                </Text>
              ) : null}
            </View>
          </Touchable>
        );
      })}
    </View>
  );
}
