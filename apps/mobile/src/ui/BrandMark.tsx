/**
 * Another company's mark (docs/decisions/assistant-guides.md AG-16) for React Native: `@whombat/brand`'s node tree
 * drawn with react-native-svg. Fixed colours as the owner publishes them; marks published in flat black or white
 * (OpenAI, GitHub) and the generic envelope follow the text colour, or `color` (the muted OpenAI mark after a reply's
 * time, chat-runtime-android.md AP-2726). Always decorative: the provider is named in the text beside it.
 */
import { buildBrandMark, type MarkLike } from '@whombat/brand';
import { memo, useMemo } from 'react';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../theme/theme';

export const BrandMark = memo(function BrandMark({
  mark,
  size,
  color,
}: {
  mark: MarkLike;
  size: number;
  /** What a mark in the text colour is drawn in; `ink` when absent. */
  color?: string;
}) {
  const theme = useTheme();
  const ink = color ?? theme.colors.ink;
  return useMemo(() => {
    const tree = buildBrandMark(mark, size);
    return (
      <Svg
        {...(tree.attrs as { viewBox: string; width: number; height: number })}
        color={ink}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {tree.children.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a mark's shapes never reorder
          <Path key={i} {...(c.attrs as { d: string })} />
        ))}
      </Svg>
    );
  }, [mark, size, ink]);
});
