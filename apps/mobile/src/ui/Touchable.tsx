/**
 * Pressable with the app's feedback: a faint `sel` wash (or opacity for filled buttons) while pressed and
 * a visible focus ring (2dp brand outline) when focused from a keyboard or switch access.
 */
import { forwardRef, useState } from 'react';
import { Pressable, type PressableProps, type StyleProp, type View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/theme';

export interface TouchableProps extends Omit<PressableProps, 'style'> {
  style?: StyleProp<ViewStyle>;
  /** `wash` tints the background while pressed (rows); `fade` lowers opacity (filled buttons). */
  feedback?: 'wash' | 'fade' | 'none';
  /** Corner radius of the focus ring (match the element's radius). */
  ringRadius?: number;
}

export const Touchable = forwardRef<View, TouchableProps>(function Touchable(
  { style, feedback = 'fade', ringRadius, onFocus, onBlur, disabled, ...rest },
  ref,
) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      {...rest}
      ref={ref}
      accessibilityRole={rest.accessibilityRole ?? 'button'}
      accessibilityState={{ disabled: !!disabled, ...rest.accessibilityState }}
      disabled={disabled}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      style={({ pressed }) => [
        style,
        pressed && feedback === 'wash' ? { backgroundColor: theme.colors.sel } : null,
        pressed && feedback === 'fade' ? { opacity: 0.72 } : null,
        focused
          ? {
              outlineColor: theme.colors.brand,
              outlineWidth: 2,
              outlineStyle: 'solid' as const,
              outlineOffset: 2,
              ...(ringRadius !== undefined ? { borderRadius: ringRadius } : null),
            }
          : null,
      ]}
    />
  );
});
