import { forwardRef, type HTMLAttributes, useEffect, useImperativeHandle, useRef } from 'react';
import { cx } from '../cx';
import styles from './SidePane.module.css';

/**
 * Pane widths: thread 400px, branch room 340px; `full` takes the main column's place (thread
 * focus mode, docs/decisions/ui-improvements.md AP-304).
 */
export type SidePaneWidth = 'thread' | 'branch' | 'full';

export interface SidePaneProps extends HTMLAttributes<HTMLElement> {
  width: SidePaneWidth;
  /** Background: `bg` (thread) or `side` (branch room). */
  surface?: 'bg' | 'side';
  /** Scroll the pane itself (branch room) instead of an inner region (thread). */
  scroll?: boolean;
  /** Accessible name of the complementary region, e.g. "Thread". */
  'aria-label': string;
  /**
   * Opened by someone (a link, a row, a shortcut): its heading takes focus, and focus goes back to the opener when
   * the pane closes (docs/decisions/web-efficiency.md WE-13). Off for a pane that is part of its page (branch room).
   */
  takeFocus?: boolean;
}

/** The heading a pane focuses on open; marked so its programmatic focus draws no ring (it isn't a control). */
export const PANE_FOCUS_ATTR = 'data-pane-focus';
const HEADING = 'h1, h2, h3';
/** How long a pane waits for its heading (content still loading) before it gives up on focusing it. */
const HEADING_WAIT_MS = 3000;

/**
 * Right-hand pane. At viewport ≥ 1240px it sits inline and pushes the main column; below that it
 * overlays (absolute, right/top/bottom 0, narrow-pane shadow). Its positioned ancestor must be the
 * app frame (the shell's root is `position: relative`).
 */
export const SidePane = forwardRef<HTMLElement, SidePaneProps>(function SidePane(
  { width, surface = 'bg', scroll = false, takeFocus = true, className, children, ...rest },
  ref,
) {
  const own = useRef<HTMLElement>(null);
  useImperativeHandle(ref, () => own.current as HTMLElement);
  useEffect(() => {
    const pane = own.current;
    if (!takeFocus || !pane) return;
    return paneFocus(pane);
  }, [takeFocus]);
  return (
    <aside
      ref={own}
      className={cx(styles.pane, styles[width], styles[surface], scroll && styles.scroll, className)}
      {...rest}
    >
      {children}
    </aside>
  );
});

/**
 * Moves focus into a pane that just opened (its first heading, once its content shows one) and returns a cleanup that
 * gives focus back to what had it before, if focus was in the pane (or fell to the page when the pane went away). A
 * focus someone moves elsewhere in the meantime is left alone, so is a control in the pane that took focus itself.
 */
export function paneFocus(pane: HTMLElement): () => void {
  const before = document.activeElement;
  const opener =
    before instanceof HTMLElement && before !== document.body && !pane.contains(before) ? before : null;
  const focusHeading = (): boolean => {
    const active = document.activeElement;
    if (active && active !== document.body && active !== opener) return true;
    const heading = pane.querySelector<HTMLElement>(HEADING);
    if (!heading) return false;
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.setAttribute(PANE_FOCUS_ATTR, '');
    heading.focus({ preventScroll: true });
    return true;
  };
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!focusHeading()) {
    observer = new MutationObserver(() => {
      if (focusHeading()) observer?.disconnect();
    });
    observer.observe(pane, { childList: true, subtree: true });
    timer = setTimeout(() => observer?.disconnect(), HEADING_WAIT_MS);
  }
  return () => {
    observer?.disconnect();
    clearTimeout(timer);
    const active = document.activeElement;
    const lost = !active || active === document.body || pane.contains(active);
    if (lost && opener?.isConnected) opener.focus({ preventScroll: true });
  };
}
