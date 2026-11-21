import { PROMPT_WORDS, promptProjectRows, promptRanWord } from '@whombat/client';
import type { Prompt, PromptProject } from '@whombat/core';
import { ArrowLeft } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import c from '../messaging/Composer.module.css';
import styles from './PromptPicker.module.css';
import { PROMPT_WEB_WORDS } from './promptsModel';
import type { PromptProjectsState } from './usePrompts';

export interface PromptPickerProps {
  prompt: Prompt;
  projects: PromptProjectsState;
  /** Escape or Back: the `/` list again. */
  onBack: () => void;
  /** T3 Code can't list its projects: the prompt's words go in the draft instead. */
  onInstead: () => void;
  /** A repository chosen; resolves true once the prompt is used there. */
  onChoose: (project: PromptProject) => Promise<boolean>;
  now?: Date;
}

/**
 * The `/` list after a prompt for a repository was chosen (docs/app/decisions/prompts-web.md): “Which repository?”, a
 * search field that keeps the keyboard (↑/↓ move, Enter chooses, Escape goes back), and T3 Code's projects, the ones the
 * prompt ran on first with when. Without T3 Code it says why and offers to put the words in the message.
 */
export function PromptPicker({ prompt, projects, onBack, onInstead, onChoose, now }: PromptPickerProps) {
  const ids = useId();
  const listId = `${ids}-projects`;
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const rows = useMemo(
    () => promptProjectRows(prompt, projects.projects ?? [], search),
    [prompt, projects.projects, search],
  );
  const ready = projects.t3 === 'ready' && projects.projects !== null;
  const unavailable = projects.t3 === 'not_connected' || projects.t3 === 'unreachable' ? projects.t3 : null;
  const activeIndex = rows.length ? Math.min(active, rows.length - 1) : -1;

  useEffect(() => searchRef.current?.focus(), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: back to the top for every search
  useEffect(() => setActive(0), [search]);
  useEffect(() => {
    if (activeIndex >= 0)
      document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, listId]);

  const choose = async (row: PromptProject | undefined) => {
    if (!row || busy) return;
    setBusy(true);
    try {
      await onChoose(row);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onBack();
      return;
    }
    if (!rows.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((activeIndex + step + rows.length) % rows.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      void choose(rows[activeIndex]);
    }
  };

  const optionId = (i: number) => `${listId}-${i}`;
  return (
    <div className={styles.picker} aria-busy={busy || undefined}>
      <div className={styles.head}>
        <button
          type="button"
          className={styles.back}
          aria-label={PROMPT_WEB_WORDS.back}
          title={PROMPT_WEB_WORDS.back}
          onClick={onBack}
        >
          <Icon icon={ArrowLeft} size={15} />
        </button>
        <span className={styles.titles}>
          <span className={styles.title} id={`${ids}-title`}>
            {PROMPT_WORDS.pickTitle}
          </span>
          <span className={styles.prompt}>{prompt.title}</span>
        </span>
      </div>
      {unavailable ? (
        <div className={styles.note} data-prompt-t3={unavailable}>
          <p className={c.empty} role="status">
            {PROMPT_WORDS.t3[unavailable]}
          </p>
          <Button variant="secondary" size="sm" onClick={onInstead} className={styles.instead}>
            {PROMPT_WORDS.pickInstead}
          </Button>
        </div>
      ) : (
        <>
          <input
            ref={searchRef}
            className={styles.search}
            type="text"
            value={search}
            placeholder={PROMPT_WORDS.pickSearch}
            aria-label={PROMPT_WORDS.pickSearch}
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {!ready ? (
            <p className={c.empty} role="status">
              {PROMPT_WORDS.pickLoading}
            </p>
          ) : rows.length === 0 ? (
            <p className={c.empty} role="status">
              {(projects.projects ?? []).length === 0 ? PROMPT_WORDS.pickEmpty : PROMPT_WORDS.pickNone}
            </p>
          ) : (
            <div className={c.options} role="listbox" id={listId} aria-labelledby={`${ids}-title`}>
              {rows.map((row, i) => (
                <div
                  key={row.id}
                  id={optionId(i)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === activeIndex}
                  aria-disabled={busy || undefined}
                  className={cx(c.option, i === activeIndex && c.optionActive, styles.row)}
                  data-project={row.id}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => void choose(row)}
                  onKeyDown={() => {}}
                >
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle}>{row.title || row.id}</span>
                    {row.folder && <span className={styles.folder}>{row.folder}</span>}
                  </span>
                  {row.ranAt && <span className={styles.ran}>{promptRanWord(row.ranAt, now)}</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
