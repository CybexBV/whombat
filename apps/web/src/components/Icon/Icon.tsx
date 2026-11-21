import type { LucideIcon, LucideProps } from 'lucide-react';
import { forwardRef } from 'react';
import { type IconName, iconSlots } from './icons';

/** Stroke width in CSS px at any size (README: Lucide, 1.75px stroke). */
export const ICON_STROKE = 1.75;

export type IconProps = Omit<LucideProps, 'ref'> & {
  /** Size in px; 16–18 in the UI. */
  size?: number;
  /** Accessible label. Without it the icon is decorative (`aria-hidden`). */
  label?: string;
} & ({ name: IconName; icon?: never } | { icon: LucideIcon; name?: never });

/** Line icon wrapper: a named slot from `iconSlots` (or any Lucide icon), 1.75px stroke, currentColor. */
export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
  { name, icon, size = 16, label, ...rest },
  ref,
) {
  const Glyph = icon ?? iconSlots[name as IconName];
  return (
    <Glyph
      ref={ref}
      size={size}
      strokeWidth={ICON_STROKE}
      absoluteStrokeWidth
      focusable="false"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      {...rest}
    />
  );
});
