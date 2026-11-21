/**
 * A button that opens a menu under it (Create, a guest row's ⋯): the app's context menu, opened at the button so it
 * isn't cut off by the card it sits in; arrow keys, Esc and a click outside work as in every menu.
 */
import { type ReactNode, useRef, useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '../../../app/shell/ContextMenu';
import { Button, type ButtonSize } from '../../../components/Button';

const MENU_WIDTH = 200;

export function MenuButton({
  label,
  items,
  className,
  title,
  disabled,
  size,
  width = MENU_WIDTH,
  children,
}: {
  /** The menu's accessible name, and the button's (“Actions for web-01”). */
  label: string;
  items: ContextMenuItem[];
  className?: string;
  title?: string;
  disabled?: boolean;
  /** A secondary button of this size; without it, a plain button styled by `className` (an icon button). */
  size?: ButtonSize;
  /** The menu's width (200px; wider for items with a line under them). */
  width?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const props = {
    ref,
    className,
    'aria-label': label,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': at !== null,
    title,
    disabled,
    onClick: () => {
      if (at) return setAt(null);
      const r = ref.current?.getBoundingClientRect();
      if (r) setAt({ x: Math.max(8, r.right - width), y: r.bottom + 4 });
    },
  };
  return (
    <>
      {size ? (
        <Button size={size} {...props}>
          {children}
        </Button>
      ) : (
        <button type="button" {...props}>
          {children}
        </button>
      )}
      {at && items.length ? (
        <ContextMenu
          label={label}
          x={at.x}
          y={at.y}
          items={items}
          anchor={ref.current}
          {...(width !== MENU_WIDTH ? { width } : {})}
          onClose={(restore) => {
            setAt(null);
            if (restore) ref.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}
