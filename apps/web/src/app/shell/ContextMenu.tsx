import {
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../components/cx';
import styles from './ContextMenu.module.css';

export interface ContextMenuItem {
  label: ReactNode;
  onSelect: () => void;
  /** A choice of one (the bell's All / Mentions / Nothing, AP-469): a `menuitemradio`, ticked when true. */
  checked?: boolean;
  /** A muted line under the label. */
  description?: ReactNode;
  /** A line above this item (a group of its own). */
  separated?: boolean;
  /** A destructive item (“Delete message”), in the bad tone. */
  danger?: boolean;
}

export interface ContextMenuProps {
  /** Accessible name ("#billing-v2"). */
  label: string;
  /** Where it opens: the pointer, or under the row for the keyboard's context-menu key. */
  x: number;
  y: number;
  items: ContextMenuItem[];
  /** Closes the menu; `restoreFocus` when the row it came from should get focus back (Esc, Tab). */
  onClose: (restoreFocus: boolean) => void;
  /** A menu button: pressing it doesn't count as a click outside (its own click closes the menu). */
  anchor?: HTMLElement | null;
  /** Wider than 200px, for items with a line under them (a notice's ⋯ menu, quiet-notices.md AP-4820). */
  width?: number;
}

const MARGIN = 8;
const MENU_WIDTH = 200;
const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"]';

/**
 * Right-click menu for sidebar rows, in the account menu's look. Opens at the pointer (upwards near the
 * bottom of the window), kept inside it; arrow keys move between items, Esc or Tab closes it, and it closes on any click outside,
 * scroll or resize.
 */
export function ContextMenu({ label, x, y, items, onClose, anchor = null, width }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    // Like a native menu: opens up from the pointer when there's no room below it.
    const top = y + height + MARGIN > window.innerHeight ? y - height : y;
    setPosition({
      left: Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN)),
      top: Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN)),
    });
    // A choice menu opens on the current choice.
    (
      el.querySelector<HTMLElement>('[aria-checked="true"]') ?? el.querySelector<HTMLElement>(ITEM_SELECTOR)
    )?.focus();
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose(false);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !anchor?.contains(target)) close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [onClose, anchor]);

  const onKeyDown = (event: KeyboardEvent) => {
    const all = [...(ref.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(all.length - 1);
    else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    }
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={styles.contextMenu}
      style={width ? { ...position, width } : position}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, i) => (
        <Fragment
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list that never reorders
          key={i}
        >
          {item.separated && <hr className={styles.menuDivider} />}
          {item.checked === undefined ? (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={cx(styles.menuItem, item.danger && styles.menuItemDanger)}
              onClick={() => {
                // Back to the row first, so a dialog the item opens returns focus there when it closes.
                onClose(true);
                item.onSelect();
              }}
            >
              <ItemText item={item} />
            </button>
          ) : (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={item.checked}
              tabIndex={-1}
              className={cx(styles.menuItem, styles.menuItemRadio)}
              onClick={() => {
                onClose(true);
                item.onSelect();
              }}
            >
              <span className={styles.menuCheck} aria-hidden="true">
                {item.checked ? '✓' : ''}
              </span>
              <ItemText item={item} />
            </button>
          )}
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}

/** A menu item's label, and its muted line under it when it has one. */
function ItemText({ item }: { item: ContextMenuItem }) {
  if (!item.description) return <>{item.label}</>;
  return (
    <span className={styles.menuItemText}>
      {item.label}
      <span className={styles.menuItemDescription}>{item.description}</span>
    </span>
  );
}

/** The text the viewer has selected inside `row`, or across it; empty when nothing is selected there. */
export function selectedTextIn(row: HTMLElement): string {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return '';
  if (!selection.getRangeAt(0).intersectsNode(row)) return '';
  const text = selection.toString();
  return text.trim() ? text : '';
}

/** “Copy”: the selected text, taken when the menu opened (focusing the menu may change the selection). */
function copyItem(text: string): ContextMenuItem {
  return { label: 'Copy', onSelect: () => void copyText(text) };
}

/** The clipboard API where the page may use it, else the older copy command on a hidden text area. */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Not allowed here (an insecure origin, an old browser): fall through.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

interface RowMenuState {
  key: string;
  label: string;
  items: ContextMenuItem[];
  x: number;
  y: number;
  row: HTMLElement;
  /** Opened by a menu button (`openFrom`): pressing it again closes the menu. */
  button?: boolean;
}

export interface RowMenu {
  /** Key of the row whose menu is open (the row keeps its hover background meanwhile). */
  openKey: string | null;
  /**
   * `onContextMenu` handler for a row: opens `items` at the pointer, or under the row from the keyboard. With text
   * selected in the row, “Copy” comes first; with nothing to show, no menu opens (and no browser menu either).
   */
  open: (event: MouseEvent<HTMLElement>, key: string, label: string, items: ContextMenuItem[]) => void;
  /**
   * A menu button's click: opens `items` under `anchor` (its right edge on the button's right edge with `align:
   * 'end'`, for buttons at the right of a header). Clicking the button again while its menu is open closes it.
   */
  openFrom: (
    anchor: HTMLElement,
    key: string,
    label: string,
    items: ContextMenuItem[],
    align?: 'start' | 'end',
  ) => void;
  /** The open menu, to render anywhere (it portals to the body). */
  element: ReactNode;
}

/** One right-click menu for a list of rows: at most one is open, and closing it can return focus to its row. */
export function useRowMenu(): RowMenu {
  const [menu, setMenu] = useState<RowMenuState | null>(null);
  const menuRow = useRef<HTMLElement | null>(null);
  menuRow.current = menu?.row ?? null;

  const close = useCallback((restoreFocus: boolean) => {
    if (restoreFocus) menuRow.current?.focus();
    setMenu(null);
  }, []);

  const open = useCallback(
    (event: MouseEvent<HTMLElement>, key: string, label: string, items: ContextMenuItem[]) => {
      event.preventDefault();
      const row = event.currentTarget;
      // Text selected in the row (or across it) is copied from here, as the browser's own menu would (AP-615).
      const selected = selectedTextIn(row);
      if (selected)
        items = [copyItem(selected), ...items.map((it, i) => (i === 0 ? { ...it, separated: true } : it))];
      if (items.length === 0) return;
      // The keyboard's context-menu key reports no pointer position: open under the row instead.
      const fromKeyboard = event.clientX === 0 && event.clientY === 0;
      const rect = row.getBoundingClientRect();
      setMenu({
        key,
        label,
        items,
        row,
        x: fromKeyboard ? rect.left + 28 : event.clientX,
        y: fromKeyboard ? rect.bottom + 4 : event.clientY,
      });
    },
    [],
  );

  const openFrom = useCallback(
    (
      anchor: HTMLElement,
      key: string,
      label: string,
      items: ContextMenuItem[],
      align: 'start' | 'end' = 'start',
    ) => {
      const rect = anchor.getBoundingClientRect();
      setMenu((current) =>
        current?.key === key
          ? null
          : {
              key,
              label,
              items,
              row: anchor,
              button: true,
              // The menu is 200px wide (`.contextMenu`); `ContextMenu` keeps it inside the window either way.
              x: align === 'end' ? rect.right - MENU_WIDTH : rect.left,
              y: rect.bottom + 4,
            },
      );
    },
    [],
  );

  return {
    openKey: menu?.key ?? null,
    open,
    openFrom,
    element: menu && (
      <ContextMenu
        label={menu.label}
        x={menu.x}
        y={menu.y}
        items={menu.items}
        onClose={close}
        anchor={menu.button ? menu.row : null}
      />
    ),
  };
}
