import { Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { useTheme } from './theme';
import { type FontFamily, type FontWeight, textMetrics } from './type';

export interface TextProps extends RNTextProps {
  /** Font size in dp (the mock's px). Default 15. */
  size?: number;
  weight?: FontWeight;
  mono?: boolean;
  /** Unitless line height (CSS); omitted = `normal`. */
  lh?: number;
  /** Letter-spacing in em. */
  tracking?: number;
  color?: string;
  uppercase?: boolean;
}

/** Text in the Whombat type system: tokens fonts by weight, CSS line boxes, `ink` by default. */
export function Text({
  size = 15,
  weight = 400,
  mono = false,
  lh,
  tracking,
  color,
  uppercase,
  style,
  ...rest
}: TextProps) {
  const theme = useTheme();
  const family: FontFamily = mono ? 'mono' : 'sans';
  return (
    <RNText
      maxFontSizeMultiplier={1.6}
      {...rest}
      style={[
        textMetrics({ size, weight, family, lineHeight: lh, tracking }),
        {
          color: color ?? theme.colors.ink,
          includeFontPadding: false,
          ...(uppercase ? { textTransform: 'uppercase' as const } : null),
        },
        style,
      ]}
    />
  );
}
