/**
 * Where a thread's list stands (docs/app/decisions/thread-scroll.md): it opens at its latest reply, or at the reply a
 * link points at, and a reader at the end stays there while the replies settle. A long thread's rows start at a
 * guessed height (`content-visibility`, WX-02) and cards, previews and images grow after their message, so one jump to
 * the bottom at open lands well above the end; the list follows the end as its height changes until the reader scrolls
 * up. A new reply or someone starting to work moves the list only for a reader at the end, or one who just sent it; further
 * up they stay where they read. Further up than half a screen, or with something new below, “Scroll to the end” shows.
 */
import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from 'react';

/** Closer to the end than this counts as at the end, as in the room. */
const NEAR_END = 120;
/** “Scroll to the end” shows further up than this, or half the list's height when that is more. */
const AWAY_FROM_END = 240;
/** How long after the reader's wheel, key or touch a scroll is still theirs (a smooth or flung scroll goes on). */
const READER_SCROLL_MS = 250;

export const SCROLL_TO_END = 'Scroll to the end';

/** A card at the end that waits for the person and is taller than this share of the list opens at its top. */
const TALL_CARD = 0.75;
/** How long after opening the list keeps that card's top in place while the rows above take their real size. */
const PIN_MS = 1500;
/** Room above the card's top, so its status line isn't against the list's edge. */
const PIN_GAP = 12;

/**
 * Where the list opens when its newest message holds a tall card that waits for the person (a Tasks card to hand over):
 * at the card's top, so its title and list come before its buttons. Null when there is none or it fits.
 */
export function waitingCardTop(el: HTMLElement): number | null {
  const rows = el.querySelectorAll<HTMLElement>('[data-message-id]');
  const card = rows[rows.length - 1]?.querySelector<HTMLElement>('[data-card][data-mark="waiting"]');
  if (!card) return null;
  const box = card.getBoundingClientRect();
  if (box.height < el.clientHeight * TALL_CARD) return null;
  return Math.max(0, box.top - el.getBoundingClientRect().top + el.scrollTop - PIN_GAP);
}

type Seen = { rootId: string | null; count: number; newest: string | null; typing: number; height: number };

export function useThreadScroll(
  listRef: RefObject<HTMLDivElement | null>,
  {
    rootId,
    count,
    newest,
    typing,
    target,
    newestMine = false,
  }: Omit<Seen, 'height'> & {
    target: string | null;
    /** The newest reply is the reader's own (they just sent it): the list goes to the end wherever they were. */
    newestMine?: boolean;
  },
) {
  // Whether the reader is at the end, so the list follows it. Only the reader's own scrolling changes it: rows settling
  // above move the list too (the browser keeps what is on screen in place), and so does following the end.
  const atEnd = useRef(true);
  // Until when a scroll is the reader's (Infinity while they hold the scrollbar or a touch).
  const readerUntil = useRef(0);
  const seen = useRef<Seen>({ rootId: null, count: 0, newest: null, typing: 0, height: 0 });
  // Until when the list keeps a tall waiting card's top in place after opening (0: it doesn't).
  const pinnedUntil = useRef(0);
  const [away, setAway] = useState(false);
  // A reply came in, or someone started work, below a reader further up: the pill shows until they are at the end again.
  const [newBelow, setNewBelow] = useState(false);

  const judge = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAway(gap > Math.max(AWAY_FROM_END, el.clientHeight / 2));
  }, [listRef]);

  const toEnd = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atEnd.current = true;
    pinnedUntil.current = 0;
    readerUntil.current = 0;
    setAway(false);
    setNewBelow(false);
  }, [listRef]);

  useLayoutEffect(() => {
    const el = listRef.current;
    const before = seen.current;
    seen.current = { rootId, count, newest, typing, height: el?.scrollHeight ?? 0 };
    if (!el || count === 0) return;
    const opened = before.count === 0 || before.rootId !== rootId;
    if (opened) setNewBelow(false);
    if (opened && target) {
      const row = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target)}"]`);
      if (row) {
        row.scrollIntoView?.({ block: 'center' });
        row.setAttribute('data-flash', '');
        window.setTimeout(() => row.removeAttribute('data-flash'), 1600);
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END;
        judge();
        return;
      }
    }
    const grew = count > before.count;
    // A new reply at the end, and someone starting to work (a typing line, a hand-over).
    const arrived = grew && newest !== before.newest;
    const working = typing > before.typing;
    if (!opened && grew && newest === before.newest && before.height) {
      // Earlier replies loaded above (WX-11): the reader stays where they were.
      el.scrollTop += el.scrollHeight - before.height;
    } else if (
      opened ||
      (arrived && newestMine) ||
      // Not under a reader's wheel or finger either, as the resize observer below.
      ((arrived || working) && atEnd.current && performance.now() >= readerUntil.current)
    ) {
      el.scrollTop = el.scrollHeight;
      atEnd.current = true;
      pinnedUntil.current = 0;
      setNewBelow(false);
      // A tall card at the end that waits for the person opens at its top: what it is before what to press.
      const top = opened ? waitingCardTop(el) : null;
      if (top !== null) {
        el.scrollTop = top;
        atEnd.current = false;
        pinnedUntil.current = performance.now() + PIN_MS;
      }
    } else if (arrived || working) {
      // The reader reads further up: a reply or a work line pulling them down lost their place. They stay; the pill says
      // there is more below.
      setNewBelow(true);
    }
    seen.current.height = el.scrollHeight;
    judge();
  }, [listRef, judge, rootId, count, newest, typing, target, newestMine]);

  // The rows and the list itself (the reply box grows) change size after they render: at the end, stay there. What the
  // reader does to scroll marks the scrolls that follow as theirs.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const reader = () => {
      readerUntil.current = Math.max(readerUntil.current, performance.now() + READER_SCROLL_MS);
    };
    const hold = () => {
      readerUntil.current = Number.POSITIVE_INFINITY;
    };
    const release = () => {
      if (readerUntil.current !== Number.POSITIVE_INFINITY) return;
      readerUntil.current = 0;
      reader();
    };
    el.addEventListener('wheel', reader, { passive: true });
    el.addEventListener('keydown', reader);
    el.addEventListener('pointerdown', hold);
    el.addEventListener('touchstart', hold, { passive: true });
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('touchend', release);
    let resize: ResizeObserver | null = null;
    let rows: MutationObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        // While the reader scrolls their scroll decides: a resize can come before the scroll event that caused it.
        const now = performance.now();
        if (seen.current.count > 0 && atEnd.current && now >= readerUntil.current)
          el.scrollTop = el.scrollHeight;
        else if (now < pinnedUntil.current && now >= readerUntil.current) {
          const top = waitingCardTop(el);
          if (top !== null) el.scrollTop = top;
        }
        // Earlier replies loading keep the reader in place against the height the rows have now.
        seen.current.height = el.scrollHeight;
        judge();
      });
      const watch = () => {
        observer.disconnect();
        observer.observe(el);
        for (const child of el.children) observer.observe(child);
      };
      watch();
      rows = new MutationObserver(watch);
      rows.observe(el, { childList: true });
      resize = observer;
    }
    return () => {
      el.removeEventListener('wheel', reader);
      el.removeEventListener('keydown', reader);
      el.removeEventListener('pointerdown', hold);
      el.removeEventListener('touchstart', hold);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('touchend', release);
      rows?.disconnect();
      resize?.disconnect();
    };
  }, [listRef, judge]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const now = performance.now();
    if (now < readerUntil.current) {
      // The reader moves the list: a tall card's top is no longer kept in place.
      pinnedUntil.current = 0;
      // A flung or smooth scroll keeps going after its last wheel or touch.
      if (readerUntil.current !== Number.POSITIVE_INFINITY) readerUntil.current = now + READER_SCROLL_MS;
      atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END;
      if (atEnd.current) setNewBelow(false);
    }
    judge();
  }, [listRef, judge]);

  /** Scrolls to a reply of the thread and highlights it a moment, as a link to it does (a moved card's link). */
  const toMessage = useCallback(
    (id: string) => {
      const el = listRef.current;
      const row = el?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
      if (!el || !row) return;
      row.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      row.setAttribute('data-flash', '');
      window.setTimeout(() => row.removeAttribute('data-flash'), 1600);
      // The reader chose where to read: the list follows the end again only once they are back there.
      readerUntil.current = performance.now() + READER_SCROLL_MS * 4;
      atEnd.current = false;
      pinnedUntil.current = 0;
    },
    [listRef],
  );

  return { away: away || newBelow, onScroll, toEnd, toMessage };
}
