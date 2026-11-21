import { EMOJI_GROUP_LABELS, EMOJI_GROUPS, type Emoji, emojiByChar, QUICK_REACTIONS } from '@whombat/core';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { SectionLabel } from '../../../components/SectionLabel';
import styles from './EmojiPicker.module.css';
import { type EmojiCell, emojiLabel, emojiSections, type GridKey, groupIcon, moveInGrid } from './emojiModel';
import { readRecentEmoji } from './recentEmoji';

/** Where the picker opens from: the button's box (it opens under it, or above when there's no room). */
export interface EmojiAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface EmojiPickerProps {
  anchor: EmojiAnchor;
  /** Accessible name: “Add a reaction to Mara’s message”. */
  label: string;
  /** The reactions the viewer already gave (marked; picking one takes it back). */
  mine?: readonly string[];
  onPick: (char: string) => void;
  /** `restoreFocus`: Esc, or a pick from the keyboard — focus goes back to what opened it. */
  onClose: (restoreFocus: boolean) => void;
}

const MARGIN = 8;
const GRID_KEYS = new Set<string>(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/**
 * The reaction picker (AP-444): a popover with a search field, the quick reactions (👍 ❤️ 😂 🎉 👀 ✅), the group
 * buttons, then Recent and every group in a grid; search replaces the grid with its results. Keyboard: typing goes to
 * the search, ↓ (or Enter for the first result) moves into the grid, arrows move there, Enter or Space picks, Esc closes
 * and returns focus. It closes on a click outside, the page scrolling, a resize, focus leaving it or the window losing
 * focus.
 */
export function EmojiPicker({ anchor, label, mine = [], onPick, onClose }: EmojiPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const cells = useRef(new Map<string, HTMLButtonElement>());
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [query, setQuery] = useState('');
  const [recent] = useState(readRecentEmoji);
  const [active, setActive] = useState<EmojiCell>({ section: 0, index: 0 });
  const [shown, setShown] = useState<Emoji | null>(null);
  const [visibleGroup, setVisibleGroup] = useState<string | null>(null);
  const ids = useId();
  const sections = useMemo(() => emojiSections(query, recent), [query, recent]);
  const mineSet = useMemo(() => new Set(mine), [mine]);

  // A new list starts at its first emoji.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the list changes
  useEffect(() => setActive({ section: 0, index: 0 }), [query]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const below = anchor.bottom + 6;
    const top = below + height + MARGIN > window.innerHeight ? anchor.top - height - 6 : below;
    setPosition({
      left: Math.max(MARGIN, Math.min(anchor.right - width, window.innerWidth - width - MARGIN)),
      top: Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN)),
    });
    searchRef.current?.focus();
  }, [anchor]);

  useEffect(() => {
    const close = () => onClose(false);
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    // The page scrolling moves what it opened from; its own list scrolling doesn't.
    const onScroll = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);

  const pick = useCallback(
    (char: string, restoreFocus: boolean) => {
      onPick(char);
      onClose(restoreFocus);
    },
    [onPick, onClose],
  );

  const focusCell = (cell: EmojiCell) => {
    setActive(cell);
    const el = cells.current.get(`${cell.section}:${cell.index}`);
    el?.focus();
    el?.scrollIntoView?.({ block: 'nearest' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    }
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const first = sections[0]?.emoji[0];
    if (event.key === 'ArrowDown' && first) {
      event.preventDefault();
      focusCell({ section: 0, index: 0 });
    } else if (event.key === 'Enter' && query.trim() && first) {
      event.preventDefault();
      pick(first.char, true);
    }
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!GRID_KEYS.has(event.key)) return;
    event.preventDefault();
    const next = moveInGrid(sections, active, event.key as GridKey);
    if (next) focusCell(next);
    else searchRef.current?.focus();
  };

  const jumpTo = (group: string) => {
    const body = bodyRef.current;
    const section = sectionRefs.current.get(group);
    if (!body || !section) return;
    body.scrollTop = section.offsetTop - body.offsetTop;
    setVisibleGroup(group);
    const index = sections.findIndex((s) => s.id === group);
    if (index >= 0) setActive({ section: index, index: 0 });
  };

  const onScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    let current: string | null = null;
    for (const s of sections) {
      const el = sectionRefs.current.get(s.id);
      if (el && el.offsetTop - body.offsetTop <= body.scrollTop + 4) current = s.id;
    }
    setVisibleGroup(current);
  };

  const searching = query.trim().length > 0;
  const preview = shown ?? null;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={styles.picker}
      style={position ?? { left: -9999, top: -9999 }}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        // Tabbing out of the picker closes it (focus has gone somewhere else on purpose).
        const next = event.relatedTarget as Node | null;
        if (next && !ref.current?.contains(next)) onClose(false);
      }}
      data-emoji-picker=""
    >
      <label className={styles.search}>
        <Icon name="search" size={15} />
        <input
          ref={searchRef}
          className={styles.searchInput}
          value={query}
          placeholder="Search emoji"
          aria-label="Search emoji"
          aria-describedby={`${ids}-hint`}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <span id={`${ids}-hint`} className={styles.srOnly}>
        Down arrow moves into the emoji. Enter picks the first result.
      </span>
      {!searching && (
        // biome-ignore lint/a11y/useSemanticElements: a set of buttons, not form fields
        <div className={styles.quick} role="group" aria-label="Quick reactions">
          {QUICK_REACTIONS.map((char) => {
            const e = emojiByChar(char);
            return (
              <button
                key={char}
                type="button"
                className={styles.quickCell}
                aria-label={emojiLabel(e ?? { name: char }, mineSet.has(char))}
                aria-pressed={mineSet.has(char)}
                title={e?.name}
                onClick={(event) => pick(char, event.detail === 0)}
                onMouseEnter={() => setShown(e ?? null)}
              >
                {char}
              </button>
            );
          })}
        </div>
      )}
      {!searching && (
        // biome-ignore lint/a11y/useSemanticElements: a set of buttons, not form fields
        <div className={styles.groups} role="group" aria-label="Emoji groups">
          {EMOJI_GROUPS.map((group) => (
            <button
              key={group}
              type="button"
              className={cx(styles.groupButton, visibleGroup === group && styles.groupCurrent)}
              aria-label={EMOJI_GROUP_LABELS[group]}
              title={EMOJI_GROUP_LABELS[group]}
              onClick={() => jumpTo(group)}
            >
              <span aria-hidden="true">{groupIcon(group)}</span>
            </button>
          ))}
        </div>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the emoji buttons inside */}
      <div
        ref={bodyRef}
        className={cx(styles.body, searching && styles.bodySearching)}
        onKeyDown={onGridKeyDown}
        onScroll={onScroll}
      >
        {sections.length === 0 && <p className={styles.empty}>No emoji match “{query.trim()}”.</p>}
        {sections.map((section, s) => (
          <section
            key={section.id}
            ref={(el) => {
              if (el) sectionRefs.current.set(section.id, el);
              else sectionRefs.current.delete(section.id);
            }}
            aria-label={section.label}
          >
            <SectionLabel as="h3" className={styles.sectionLabel}>
              {section.label}
            </SectionLabel>
            <div className={styles.grid}>
              {section.emoji.map((e, i) => {
                const isActive = active.section === s && active.index === i;
                return (
                  <button
                    key={e.char}
                    ref={(el) => {
                      const k = `${s}:${i}`;
                      if (el) cells.current.set(k, el);
                      else cells.current.delete(k);
                    }}
                    type="button"
                    className={styles.cell}
                    tabIndex={isActive ? 0 : -1}
                    aria-label={emojiLabel(e, mineSet.has(e.char))}
                    aria-pressed={mineSet.has(e.char)}
                    onClick={(event) => pick(e.char, event.detail === 0)}
                    onFocus={() => {
                      setActive({ section: s, index: i });
                      setShown(e);
                    }}
                    onMouseEnter={() => setShown(e)}
                  >
                    {e.char}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <div className={styles.footer} aria-hidden="true">
        {preview ? (
          <>
            <span className={styles.previewChar}>{preview.char}</span>
            <span className={styles.previewName}>{preview.name}</span>
          </>
        ) : (
          <span className={styles.previewName}>Pick a reaction</span>
        )}
      </div>
    </div>,
    document.body,
  );
}
