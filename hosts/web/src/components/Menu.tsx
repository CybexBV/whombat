// Action menu: a button that opens a list of commands (menu button
// pattern: arrow keys, Home/End, Escape returns focus). Used for the host
// header (mute, host power), guest rows (power, snapshots) and alerts.

import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { usePopover } from './popover';

export interface MenuItem {
  label: ReactNode;
  onSelect?: () => void;
  icon?: IconName;
  /** Destructive commands are drawn in the serious color. */
  danger?: boolean;
  disabled?: boolean;
  /** Tooltip, e.g. why an item is disabled. */
  title?: string;
  /** A heading row above the next items (not focusable). */
  heading?: boolean;
}

interface MenuProps {
  /** Accessible name of the button. */
  label: string;
  items: (MenuItem | null | false)[];
  /** Visible button content; defaults to a "more" icon. */
  children?: ReactNode;
  buttonClassName?: string;
  /** Open to the left (end-aligned, default) or right of the button. */
  align?: 'start' | 'end';
  disabled?: boolean;
  /**
   * Position the list against the viewport (above the button when there is
   * no room below): for menus inside scrolling tables and cards that clip.
   * It follows the button when the page scrolls.
   */
  floating?: boolean;
}

export function Menu({ label, items, children, buttonClassName = 'btn-ghost btn-icon', align = 'end', disabled, floating }: MenuProps) {
  const pop = usePopover();
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const list = items.filter(Boolean) as MenuItem[];
  const [place, setPlace] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!floating || !pop.open) {
      setPlace(null);
      return;
    }
    const place = () => {
      const b = pop.trigger.current?.getBoundingClientRect();
      const h = menu.current?.offsetHeight ?? 0;
      const w = menu.current?.offsetWidth ?? 0;
      if (!b) return;
      if (b.bottom < 0 || b.top > window.innerHeight) {
        pop.setOpen(false); // the button scrolled away
        return;
      }
      const below = b.bottom + 4 + h <= window.innerHeight - 8 || b.top - 4 - h < 8;
      // Aligned with the button, kept inside the viewport (a button at the left edge on phones).
      const left = Math.max(8, Math.min(align === 'start' ? b.left : b.right - w, window.innerWidth - w - 8));
      setPlace({ position: 'fixed', top: below ? b.bottom + 4 : b.top - 4 - h, left, right: 'auto' });
    };
    place();
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
    };
  }, [floating, pop.open, align]);

  useEffect(() => {
    if (pop.open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [pop.open]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      pop.close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      els[e.key === 'Home' ? 0 : els.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      pop.setOpen(false);
    }
  };

  return (
    <div className="menu-wrap" ref={pop.root} onBlur={pop.onBlur}>
      <button
        ref={pop.trigger}
        type="button"
        className={buttonClassName}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-controls={pop.open ? id : undefined}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          pop.setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !pop.open) {
            e.preventDefault();
            pop.setOpen(true);
          }
        }}
      >
        {children ?? <Icon name="dots" size={16} />}
      </button>
      {pop.open && (
        <div
          ref={menu}
          id={id}
          className={`menu-pop ${align === 'start' ? 'is-start' : ''}`}
          role="menu"
          aria-label={label}
          onKeyDown={onKey}
          style={floating ? (place ?? { position: 'fixed', top: 0, left: 0, right: 'auto', opacity: 0 }) : undefined}
        >
          {list.map((it, i) =>
            it.heading ? (
              <div key={i} className="menu-head lbl" role="presentation">
                {it.label}
              </div>
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={it.danger ? 'menu-item is-danger' : 'menu-item'}
                disabled={it.disabled}
                title={it.title}
                onClick={(e) => {
                  e.stopPropagation();
                  pop.setOpen(false);
                  it.onSelect?.();
                }}
              >
                {it.icon ? <Icon name={it.icon} size={15} /> : <span className="menu-icon-gap" aria-hidden="true" />}
                <span>{it.label}</span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
