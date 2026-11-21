import { PLACES_WORDS } from '@whombat/client';
import { useRealtimeStatus } from '@whombat/client/react';
import { X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { IconButton } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { ErrorNote, Skeleton, SkeletonRows } from '../../components/ListState';
import styles from './ShellLayout.module.css';

export interface ShellLayoutProps {
  sidebar: ReactNode;
  /** The screen (route outlet). */
  children: ReactNode;
  /** Right pane (thread 400 / agent profile 380), inline ≥ 1240px and overlaid below. */
  pane?: ReactNode;
  /** Route-driven modals (they portal to <body>). */
  modals?: ReactNode;
  /** A burrow-wide notice above the screen (agents can't reply yet). */
  notice?: ReactNode;
  /**
   * Thread focus mode (docs/decisions/ui-improvements.md AP-304): the pane takes the main column's place. The screen
   * stays mounted, hidden, so its scroll position and composer draft are there on the way back.
   */
  paneFocus?: boolean;
  /**
   * Chat's or Feedback's thread beside its list on a wide screen (chat-inbox-web.md): the screen keeps only its list
   * column and the pane takes the rest.
   */
  paneBeside?: boolean;
  /** The current address: a new one closes the Places drawer (below 1024 px, WE-15). */
  navKey?: string;
  /**
   * On the right of the narrow screen's top bar, where the sidebar's badge can't be seen while it is a drawer: what
   * needs the person, as a link to the Inbox.
   */
  barEnd?: ReactNode;
}

/** Small, quiet "Reconnecting…" indicator shown while the burrow socket is down (TODO 16.4). */
function RealtimeIndicator() {
  const status = useRealtimeStatus();
  if (status !== 'reconnecting' && status !== 'closed') return null;
  return (
    <div className={styles.realtimeIndicator} role="status">
      Reconnecting…
    </div>
  );
}

/**
 * App frame (README "App shell"): 256px sidebar + main + optional right pane. The root is
 * `position: relative` so the pane can overlay it below 1240px. Below 1024px the sidebar is the Places drawer (WE-15,
 * final-shell-web.md): a 56px bar above the screen holds Places (☰ and the word) at its left, what needs the person
 * and Search at its right;
 * Places opens the drawer over a scrim as a modal dialog headed Places, its Close Places first; Esc, the scrim, Close,
 * a link in it or the next page close it; while open, focus stays in it, the rest of the frame is inert, and closing it
 * gives focus back to Places.
 */
export function ShellLayout({
  sidebar,
  children,
  pane,
  modals,
  notice,
  paneFocus = false,
  paneBeside = false,
  navKey,
  barEnd,
}: ShellLayoutProps) {
  const drawer = useSidebarDrawer(navKey);
  return (
    <div className={styles.frame}>
      {/* Under the drawer: a tap on it closes the drawer. */}
      {drawer.open && <div className={styles.scrim} aria-hidden="true" onClick={drawer.close} />}
      <div
        id={drawer.id}
        ref={drawer.ref}
        className={styles.sidebarSlot}
        data-open={drawer.open || undefined}
        {...(drawer.open
          ? { role: 'dialog', 'aria-modal': true, 'aria-labelledby': `${drawer.id}-title` }
          : {})}
      >
        {/* First in the drawer, so Close takes the focus when it opens; drawn only below 1024 px. */}
        <div className={styles.drawerHead}>
          <h2 id={`${drawer.id}-title`} className={styles.drawerHeading}>
            {PLACES_WORDS.places}
          </h2>
          <IconButton label={PLACES_WORDS.close} className={styles.drawerClose} onClick={drawer.close}>
            <Icon icon={X} size={20} />
          </IconButton>
        </div>
        {sidebar}
      </div>
      <main
        className={styles.main}
        hidden={paneFocus}
        data-beside={paneBeside || undefined}
        inert={drawer.open || undefined}
      >
        <div className={styles.drawerBar}>
          <button
            ref={drawer.buttonRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={drawer.open}
            aria-controls={drawer.id}
            className={styles.drawerButton}
            onClick={drawer.toggle}
          >
            <Icon name="menu" size={20} />
            <span>{PLACES_WORDS.places}</span>
          </button>
          {barEnd ? <div className={styles.drawerBarEnd}>{barEnd}</div> : null}
        </div>
        {notice}
        {children}
      </main>
      <div className={styles.paneSlot} inert={drawer.open || undefined}>
        {pane}
      </div>
      {modals}
      <RealtimeIndicator />
    </div>
  );
}

/**
 * Below this the sidebar is a drawer (WE-15; ShellLayout.module.css's media query says the same). Not a token: a new
 * token would ship in the Feedback widget's loader too, which has no byte to spare.
 */
export const DRAWER_MEDIA = '(max-width: 1023.98px)';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The sidebar drawer's state and wiring below the drawer breakpoint (WE-15). */
function useSidebarDrawer(navKey: string | undefined) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  // A new page closes it (a sidebar link, a shortcut, the back button).
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on every new address
  useEffect(() => setOpen(false), [navKey]);
  // Wide again: no drawer, nothing inert.
  useEffect(() => {
    if (!open || typeof window.matchMedia !== 'function') return;
    const narrow = window.matchMedia(DRAWER_MEDIA);
    const onChange = () => {
      if (!narrow.matches) setOpen(false);
    };
    narrow.addEventListener('change', onChange);
    return () => narrow.removeEventListener('change', onChange);
  }, [open]);
  // Open: focus goes into the drawer; closed again: back to the menu button, if focus was in the drawer.
  useEffect(() => {
    const slot = ref.current;
    if (!open || !slot) return;
    // Once it shows: a hidden drawer can't take focus, and under reduced motion its contents become visible a few
    // frames later (the global 0.01 ms transitions), so try each frame for a moment.
    let frame = 0;
    let tries = 0;
    const focusFirst = () => {
      const first = slot.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
      if (first && document.activeElement !== first && ++tries < 20)
        frame = requestAnimationFrame(focusFirst);
    };
    frame = requestAnimationFrame(focusFirst);
    return () => {
      cancelAnimationFrame(frame);
      const active = document.activeElement;
      if (!active || active === document.body || slot.contains(active)) buttonRef.current?.focus();
    };
  }, [open]);
  // While open: Esc closes it (before the shell's Esc, modal → pane → search, which skips handled events), Tab stays
  // inside, and a link in it closes it as it navigates (the address may not change: the page you're on).
  useEffect(() => {
    const slot = ref.current;
    if (!open || !slot) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = [...slot.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('a[href]')) setOpen(false);
    };
    slot.addEventListener('keydown', onKeyDown);
    slot.addEventListener('click', onClick);
    return () => {
      slot.removeEventListener('keydown', onKeyDown);
      slot.removeEventListener('click', onClick);
    };
  }, [open]);
  return { id, ref, buttonRef, open, close, toggle };
}

/**
 * Frame shown while the burrow loads: the sidebar column holds skeleton rows matching its own
 * geometry (no spinner), so nothing jumps when the real sidebar arrives (TODO 16.4).
 */
export function ShellPending() {
  return (
    <div className={styles.frame} aria-busy="true">
      <div className={styles.pendingSidebar}>
        <div className={styles.pendingHeader}>
          <Skeleton width={120} height={16} />
        </div>
        <div className={styles.pendingSearch}>
          <Skeleton height={16} />
        </div>
        <SkeletonRows count={4} lines={1} />
        <SkeletonRows count={3} lines={1} />
      </div>
      <main className={styles.main} />
    </div>
  );
}

export interface ShellErrorProps {
  onRetry: () => void;
}

/** Whole-frame quiet error when the burrow itself fails to load (no sidebar, no screen to fall back to). */
export function ShellError({ onRetry }: ShellErrorProps) {
  return (
    <div className={styles.frame}>
      <div className={styles.pendingSidebar} />
      <main className={styles.errorMain}>
        <ErrorNote message="Your Whombat didn’t load. Try again in a moment." onRetry={onRetry} />
      </main>
    </div>
  );
}
