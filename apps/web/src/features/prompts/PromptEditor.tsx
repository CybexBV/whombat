import { PROMPT_WORDS } from '@whombat/client';
import { queryHook } from '@whombat/client/react';
import { PROMPT_TEXT_MAX, PROMPT_TITLE_MAX, type Prompt } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { ChevronDown } from 'lucide-react';
import { type FormEvent, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { Modal, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { Toggle } from '../../components/Toggle';
import { DelegationAiMenu } from '../cards/DelegationAiMenu';
import styles from './PromptEditor.module.css';
import {
  PROMPT_WEB_WORDS,
  type PromptDraft,
  promptAiLine,
  promptDraftOf,
  promptSaveBody,
} from './promptsModel';
import { usePromptWrites } from './usePrompts';

/** What T3 Code runs, for the AI's name on the button (the menu asks again when it opens). */
const useModels = queryHook(api.delegations.models);

export interface PromptEditorProps {
  burrow: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The prompt to change; null: a new one. */
  prompt: Prompt | null;
  /** A new prompt's words (Save as prompt on a message). */
  fromText?: string;
  /** After Save (Save as prompt shows “Saved to your prompts”). */
  onSaved?: (prompt: Prompt) => void;
}

/**
 * Keeping or changing a prompt (docs/app/decisions/prompts-web.md): its title, its words, whether it is for a
 * repository and then whether the AI may reshape the code, whether Whombat merges the work into main and which AI runs
 * it; Save, Cancel and, for one that exists,
 * Remove, which asks first in the same place. In the plan dialog's language (labelled fields, 560px).
 */
export function PromptEditor(props: PromptEditorProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <Modal
      open={props.open}
      onOpenChange={props.onOpenChange}
      width="md"
      onEscapeKeyDown={(e) => {
        // Escape in the AI menu closes the menu only.
        if (menuOpen) e.preventDefault();
      }}
    >
      {props.open && <PromptForm {...props} onMenu={setMenuOpen} />}
    </Modal>
  );
}

function PromptForm({
  burrow,
  onOpenChange,
  prompt,
  fromText,
  onSaved,
  onMenu,
}: PromptEditorProps & { onMenu: (open: boolean) => void }) {
  const ids = useId();
  const writes = usePromptWrites(burrow);
  const models = useModels({ params: { burrow } }, { retry: false, staleTime: 60_000 });
  const [draft, setDraft] = useState<PromptDraft>(() => promptDraftOf(prompt, fromText));
  const [problem, setProblem] = useState<'title' | 'text' | 'failed' | null>(null);
  const [asking, setAsking] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const aiButton = useRef<HTMLButtonElement>(null);
  const set = (patch: Partial<PromptDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const aiLine = promptAiLine(draft.ai, models.data?.options) ?? PROMPT_WORDS.aiDefault;
  const busy = writes.saving || writes.removing;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const made = promptSaveBody(draft);
    if ('problem' in made) {
      setProblem(made.problem);
      return;
    }
    setProblem(null);
    try {
      const saved = await writes.save(prompt?.id ?? null, made.body);
      onOpenChange(false);
      onSaved?.(saved);
    } catch {
      setProblem('failed');
    }
  };

  const remove = async () => {
    if (!prompt) return;
    try {
      await writes.remove(prompt.id);
      onOpenChange(false);
    } catch {
      setProblem('failed');
    }
  };

  const openMenu = (anchor: HTMLButtonElement | null) => {
    setMenuAnchor(anchor);
    onMenu(!!anchor);
  };

  const error =
    problem === 'title'
      ? PROMPT_WEB_WORDS.titleNeeded
      : problem === 'text'
        ? PROMPT_WEB_WORDS.textNeeded
        : problem === 'failed'
          ? PROMPT_WORDS.failed
          : null;

  return (
    <form
      ref={formRef}
      className={styles.form}
      onSubmit={(e) => void submit(e)}
      noValidate
      data-prompt-editor={prompt?.id ?? 'new'}
    >
      <ModalTitle className={styles.title}>{prompt ? PROMPT_WORDS.edit : PROMPT_WORDS.add}</ModalTitle>

      <div className={styles.field}>
        <SectionLabel as="label" htmlFor={`${ids}-title`}>
          {PROMPT_WORDS.fieldTitle}
        </SectionLabel>
        <Input
          id={`${ids}-title`}
          value={draft.title}
          maxLength={PROMPT_TITLE_MAX}
          invalid={problem === 'title'}
          onChange={(e) => set({ title: e.target.value })}
        />
      </div>

      <div className={styles.field}>
        <SectionLabel as="label" htmlFor={`${ids}-text`}>
          {PROMPT_WORDS.fieldText}
        </SectionLabel>
        <textarea
          id={`${ids}-text`}
          className={styles.text}
          value={draft.text}
          rows={9}
          maxLength={PROMPT_TEXT_MAX}
          aria-invalid={problem === 'text' || undefined}
          onChange={(e) => set({ text: e.target.value })}
        />
      </div>

      <div className={styles.switches}>
        <div className={styles.switchRow}>
          <span className={styles.switchText}>
            <label htmlFor={`${ids}-repo`} className={styles.switchTitle}>
              {PROMPT_WORDS.onRepository}
            </label>
            <span id={`${ids}-repo-hint`} className={styles.hint}>
              {PROMPT_WORDS.onRepositoryHint}
            </span>
          </span>
          <Toggle
            id={`${ids}-repo`}
            checked={draft.onRepository}
            aria-describedby={`${ids}-repo-hint`}
            onCheckedChange={(on) => set({ onRepository: on })}
          />
        </div>
        {draft.onRepository && (
          <>
            <div className={styles.switchRow}>
              <span className={styles.switchText}>
                <label htmlFor={`${ids}-own`} className={styles.switchTitle}>
                  {PROMPT_WORDS.ownIt}
                </label>
                <span id={`${ids}-own-hint`} className={styles.hint}>
                  {PROMPT_WORDS.ownItHint}
                </span>
              </span>
              <Toggle
                id={`${ids}-own`}
                checked={draft.ownIt}
                aria-describedby={`${ids}-own-hint`}
                onCheckedChange={(on) => set({ ownIt: on })}
              />
            </div>
            <div className={styles.switchRow}>
              <span className={styles.switchText}>
                <label htmlFor={`${ids}-merge`} className={styles.switchTitle}>
                  {PROMPT_WORDS.merge}
                </label>
                <span id={`${ids}-merge-hint`} className={styles.hint}>
                  {PROMPT_WORDS.mergeHint}
                </span>
              </span>
              <Toggle
                id={`${ids}-merge`}
                checked={draft.merge}
                aria-describedby={`${ids}-merge-hint`}
                onCheckedChange={(on) => set({ merge: on })}
              />
            </div>
            <div className={styles.switchRow}>
              <span className={styles.switchText}>
                <span className={styles.switchTitle} id={`${ids}-ai`}>
                  {PROMPT_WORDS.ai}
                </span>
              </span>
              <button
                ref={aiButton}
                type="button"
                className={styles.aiButton}
                aria-haspopup="dialog"
                aria-expanded={!!menuAnchor}
                aria-label={`${PROMPT_WORDS.ai}: ${aiLine}`}
                onClick={(e) => openMenu(menuAnchor ? null : e.currentTarget)}
                data-prompt-ai=""
              >
                <span>{aiLine}</span>
                <Icon icon={ChevronDown} size={14} />
              </button>
            </div>
          </>
        )}
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {asking && prompt ? (
        <div className={styles.actions} data-prompt-remove-ask="">
          <span className={styles.ask}>{PROMPT_WORDS.removeAsk(prompt.title)}</span>
          <Button type="button" variant="secondary" onClick={() => setAsking(false)}>
            {PROMPT_WORDS.cancel}
          </Button>
          <Button type="button" variant="primary" disabled={busy} onClick={() => void remove()}>
            {PROMPT_WORDS.remove}
          </Button>
        </div>
      ) : (
        <div className={styles.actions}>
          {prompt && (
            <Button
              type="button"
              variant="ghost"
              className={styles.remove}
              disabled={busy}
              onClick={() => setAsking(true)}
            >
              {PROMPT_WORDS.remove}
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {PROMPT_WORDS.cancel}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {PROMPT_WORDS.save}
          </Button>
        </div>
      )}

      {menuAnchor && (
        <DelegationAiMenu
          burrow={burrow}
          title={PROMPT_WORDS.ai}
          current={
            draft.ai
              ? {
                  ...draft.ai,
                  label:
                    promptAiLine({ ...draft.ai, effort: null, fast: null }, models.data?.options) ??
                    draft.ai.model,
                }
              : null
          }
          anchor={menuAnchor}
          container={formRef.current?.parentElement ?? null}
          onPick={(ai) => set({ ai })}
          onChosen={() => {}}
          onClose={(restore) => {
            openMenu(null);
            if (restore) aiButton.current?.focus();
          }}
        />
      )}
    </form>
  );
}
