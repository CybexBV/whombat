/** The Whombat logo for React Native: `@whombat/brand`'s node tree drawn with react-native-svg. */
import { buildLogo, type LogoNode, type LogoTag, type LogoVariant } from '@whombat/brand';
import { type ComponentType, createElement, memo, type ReactElement, useId, useMemo } from 'react';
import Svg, { Circle, G, Mask, Path, Rect } from 'react-native-svg';
import { useTheme } from '../theme/theme';

// biome-ignore lint/suspicious/noExplicitAny: react-native-svg components have per-element prop types.
const COMPONENTS: Record<LogoTag, ComponentType<any>> = {
  svg: Svg,
  g: G,
  mask: Mask,
  path: Path,
  circle: Circle,
  rect: Rect,
};

function render(node: LogoNode, rootProps: Record<string, unknown>, key?: number): ReactElement {
  const props = key === undefined ? { ...node.attrs, ...rootProps } : { key, ...node.attrs };
  return createElement(COMPONENTS[node.tag], props, ...node.children.map((c, i) => render(c, {}, i)));
}

export interface WhombatLogoProps {
  /** `symbol` (the face, default) or `lockup` (face + wordmark). */
  variant?: LogoVariant;
  /** Height in dp; the small symbol is drawn at 32 and below. */
  height: number;
  /** Accessible name ("Whombat"); omit when decorative. */
  label?: string;
}

/** One flat color, the theme's `logo` (burrow ink on light, paper on dark). */
export const WhombatLogo = memo(function WhombatLogo({
  variant = 'symbol',
  height,
  label,
}: WhombatLogoProps) {
  const theme = useTheme();
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '');
  return useMemo(() => {
    const tree = buildLogo({ variant, height, color: theme.colors.logo, idPrefix: `wl${id}` });
    const a11y = label
      ? { accessible: true, accessibilityRole: 'image', accessibilityLabel: label }
      : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' };
    return render(tree, a11y);
  }, [variant, height, label, theme.colors.logo, id]);
});
