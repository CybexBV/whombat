/** React DOM renderer: `<WhombatLogo>` (symbol or horizontal lockup) in the `logo` theme color. */
import { type CSSProperties, createElement, type ReactElement, useId, useMemo } from 'react';
import {
  buildBrandMark,
  buildLogo,
  type LogoNode,
  type LogoVariant,
  type MarkLike,
  markKey,
} from './index.js';

export interface WhombatLogoProps {
  /** `symbol` (the face, default) or `lockup` (face + wordmark). */
  variant?: LogoVariant;
  /** Height in px; the width follows. At 32 px and below the small symbol is drawn. */
  height: number;
  /** Accessible name ("Whombat"). Omit when decorative, e.g. next to visible text. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

function render(node: LogoNode, rootProps: Record<string, unknown>, key?: number): ReactElement {
  const props = key === undefined ? { ...node.attrs, ...rootProps } : { key, ...node.attrs };
  return createElement(node.tag, props, ...node.children.map((c, i) => render(c, rootProps, i)));
}

/**
 * The Whombat logo, one flat color: `var(--logo)` (burrow ink on light, paper on dark). The brand rules
 * forbid other colors, so there is no color prop.
 */
export function WhombatLogo({
  variant = 'symbol',
  height,
  label,
  className,
  style,
}: WhombatLogoProps): ReactElement {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const tree = useMemo(
    () => buildLogo({ variant, height, color: 'currentColor', idPrefix: `wl${id}` }),
    [variant, height, id],
  );
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  return render(tree, {
    'data-logo': variant,
    focusable: 'false',
    className,
    style: { display: 'block', flex: 'none', ...style, color: 'var(--logo)' },
    ...a11y,
  });
}

export interface BrandMarkProps {
  /** A bundled mark by its name, or a connection's own logo. */
  mark: MarkLike;
  /** Square size in px (guide choices use 24). */
  size: number;
  className?: string;
}

/**
 * Another company's mark (AG-16), drawn as its owner publishes it: fixed colours, or the text colour for marks
 * published in flat black or white. Always decorative: the provider's name is in the text beside it.
 */
export function BrandMark({ mark, size, className }: BrandMarkProps): ReactElement {
  const tree = useMemo(() => buildBrandMark(mark, size), [mark, size]);
  return render(tree, {
    'data-mark': markKey(mark),
    'aria-hidden': true,
    focusable: 'false',
    className,
    style: { display: 'block', flex: 'none' },
  });
}
