/**
 * Settings → You → **Prompts** (docs/app/decisions/prompts-web.md): the person's prompts in the order `/` offers them,
 * each with its first line, a quiet mark when it is for a repository and where it last ran; New prompt; a row opens the
 * editor. Bring back Whombat’s prompts shows while one of them is missing or changed. Shared links' layout.
 */
import { PROMPT_WORDS, promptPreview } from '@whombat/client';
import type { Prompt } from '@whombat/core';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { SectionLabel } from '../../components/SectionLabel';
import { Tag } from '../../components/Tag';
import { useToast } from '../../components/Toast';
import styles from '../settings/SettingsScreen.module.css';
import links from '../settings/SharedLinks.module.css';
import { PromptEditor } from './PromptEditor';
import own from './PromptsPart.module.css';
import { promptRunLine, restoreOffered } from './promptsModel';
import { usePrompts, usePromptWrites } from './usePrompts';

type Editing = { prompt: Prompt | null } | null;

export function PromptsPart({ burrow, now }: { burrow: string; now?: Date }) {
  const list = usePrompts(burrow);
  const writes = usePromptWrites(burrow);
  const toast = useToast();
  const [editing, setEditing] = useState<Editing>(null);
  const prompts = list.prompts;
  return (
    <section className={styles.section} aria-label={PROMPT_WORDS.title} data-testid="prompts">
      <div className={own.head}>
        <SectionLabel as="h2">{PROMPT_WORDS.title}</SectionLabel>
        {list.available && (
          <Button variant="secondary" size="sm" onClick={() => setEditing({ prompt: null })}>
            {PROMPT_WORDS.add}
          </Button>
        )}
      </div>
      <p className={links.intro}>{PROMPT_WORDS.intro}</p>
      <div className={styles.card}>
        {list.error ? (
          <div className={cx(styles.row, styles.lastRow)}>
            <span className={styles.rowMain}>
              <span className={styles.rowMeta}>{PROMPT_WORDS.failed}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={list.refetch}>
              Try again
            </Button>
          </div>
        ) : !list.known ? (
          <div className={cx(styles.row, styles.lastRow)} aria-busy="true">
            <span className={styles.rowMain}>
              <span className={styles.rowMeta}>Loading…</span>
            </span>
          </div>
        ) : prompts.length === 0 ? (
          <div className={cx(styles.row, styles.lastRow)}>
            <span className={styles.rowMain}>
              <span className={styles.rowMeta}>{PROMPT_WORDS.empty}</span>
            </span>
          </div>
        ) : (
          <ul className={own.list}>
            {prompts.map((p, i) => {
              const ran = promptRunLine(p, now);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    className={cx(styles.row, own.row, i === prompts.length - 1 && styles.lastRow)}
                    onClick={() => setEditing({ prompt: p })}
                    data-prompt-row={p.id}
                  >
                    <span className={styles.rowMain}>
                      <span className={own.titleLine}>
                        <span className={styles.rowTitle}>{p.title}</span>
                        {p.onRepository && <Tag tone="mut">{PROMPT_WORDS.onRepository}</Tag>}
                      </span>
                      <span className={cx(styles.rowMeta, own.preview)}>{promptPreview(p.text, 140)}</span>
                      {ran && <span className={cx(styles.rowMeta, own.ran)}>{ran}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {list.available && restoreOffered(prompts) && (
        <div className={own.restore}>
          <span className={own.restoreHint}>{PROMPT_WORDS.restoreHint}</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={writes.restoring}
            onClick={() => void writes.restore().catch(() => toast.show(PROMPT_WORDS.failed))}
          >
            {PROMPT_WORDS.restore}
          </Button>
        </div>
      )}
      <PromptEditor
        burrow={burrow}
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        prompt={editing?.prompt ?? null}
      />
    </section>
  );
}
