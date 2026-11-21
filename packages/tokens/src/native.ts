/**
 * React Native theme object built from the same tokens as `tokens.css`. No React Native import:
 * values are plain numbers/strings that fit `StyleSheet` (letter-spacing converted from em to px,
 * line heights to px, fonts to the per-weight family names registered with `@expo-google-fonts`).
 */
import {
  type AgentStatus,
  type ChartColors,
  type CouncilRoomColors,
  chartColors,
  codeColors,
  councilRoomColors,
  fixedColors,
  humanTones,
  type StatusTextColors,
  statusColors,
  statusTextColors,
  type ThemeColors,
  themeColors,
} from './colors.js';
import { type Face, facePalettes } from './faces.js';
import { durations, layout, radii, type Spacing, shadows, spacing } from './scale.js';
import type { ThemeName } from './themes.js';
import { type TypeStyle, type TypeStyleName, typeScale } from './typography.js';

/** Family names as registered by `@expo-google-fonts/bricolage-grotesque` and `@expo-google-fonts/dm-mono`. */
export const nativeFontFamilies = {
  sans: {
    400: 'BricolageGrotesque_400Regular',
    500: 'BricolageGrotesque_500Medium',
    600: 'BricolageGrotesque_600SemiBold',
    700: 'BricolageGrotesque_700Bold',
  },
  mono: {
    400: 'DMMono_400Regular',
    500: 'DMMono_500Medium',
    // DM Mono ships 300/400/500 only; heavier mono weights fall back to Medium.
    600: 'DMMono_500Medium',
    700: 'DMMono_500Medium',
  },
} as const;

export interface NativeTextStyle {
  fontFamily: string;
  fontSize: number;
  lineHeight?: number;
  letterSpacing?: number;
  textTransform?: 'uppercase';
}

export function nativeTextStyle(style: TypeStyle): NativeTextStyle {
  const out: NativeTextStyle = {
    fontFamily: nativeFontFamilies[style.family][style.weight],
    fontSize: style.size,
  };
  if (style.lineHeight !== undefined) out.lineHeight = Math.round(style.size * style.lineHeight * 10) / 10;
  if (style.tracking !== undefined) out.letterSpacing = Math.round(style.size * style.tracking * 100) / 100;
  if (style.uppercase) out.textTransform = 'uppercase';
  return out;
}

export interface NativeShadow {
  /** CSS box-shadow string (React Native ≥ 0.76, new architecture). */
  boxShadow: string;
  /** Android elevation fallback. */
  elevation: number;
}

export interface NativeTheme {
  name: ThemeName;
  dark: boolean;
  /** The theme's colours, the fixed ones and the status words' (`warnText`, `okText`: 4.5:1 as text on every surface). */
  colors: ThemeColors & typeof fixedColors & StatusTextColors;
  /** Chart series and their area wash (box-status.md). */
  chart: ChartColors;
  /** The council's room: its burrow, table and plaques. */
  room: CouncilRoomColors;
  code: typeof codeColors;
  status: Record<AgentStatus, string>;
  tones: readonly string[];
  faces: Record<Face, { name: string; accent: string; deep: string }>;
  type: Record<TypeStyleName, NativeTextStyle>;
  radii: typeof radii;
  /** The spacing rhythm as a lookup: `spacing[16] === 16`. */
  spacing: Record<Spacing, number>;
  shadows: Record<keyof typeof shadows, NativeShadow>;
  layout: typeof layout;
  durations: typeof durations;
}

const elevation: Record<keyof typeof shadows, number> = { modal: 24, toast: 12, pane: 16, liveHalo: 0 };

export function createNativeTheme(name: ThemeName): NativeTheme {
  const type = Object.fromEntries(
    (Object.entries(typeScale) as [TypeStyleName, TypeStyle][]).map(([k, s]) => [k, nativeTextStyle(s)]),
  ) as Record<TypeStyleName, NativeTextStyle>;
  const faces = Object.fromEntries(
    (Object.entries(facePalettes) as [Face, (typeof facePalettes)[Face]][]).map(([k, p]) => [
      k,
      { name: p.name, accent: p.accent, deep: p.deep },
    ]),
  ) as NativeTheme['faces'];
  const nativeShadows = Object.fromEntries(
    (Object.keys(shadows) as (keyof typeof shadows)[]).map((k) => [
      k,
      { boxShadow: shadows[k], elevation: elevation[k] },
    ]),
  ) as NativeTheme['shadows'];

  return {
    name,
    dark: name === 'dark',
    colors: { ...themeColors[name], ...fixedColors, ...statusTextColors[name] },
    chart: chartColors[name],
    room: councilRoomColors[name],
    code: codeColors,
    status: statusColors,
    tones: humanTones,
    faces,
    type,
    radii,
    spacing: Object.fromEntries(spacing.map((n) => [n, n])) as Record<Spacing, number>,
    shadows: nativeShadows,
    layout,
    durations,
  };
}

export const nativeThemes: Record<ThemeName, NativeTheme> = {
  light: createNativeTheme('light'),
  dark: createNativeTheme('dark'),
};
