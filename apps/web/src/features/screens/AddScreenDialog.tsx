/**
 * *Add a screen* (Whombat desk-display.md DK-146; the mockups' `f-add`): the six letters a tablet or computer shows
 * after *Use as a screen*, its name, what pops up on it (*Problems only* first: a screen elsewhere is seen by more
 * people, DK-137) and whether it starts as a copy of the box's screen or an empty page. `desk.screen.add`; wrong or
 * gone letters are the letters' problem, a full Whombat the dialog's.
 */
import {
  DESK_POPUPS,
  DESK_SCREEN_CODE_RE,
  DESK_SCREENS_TEXT,
  type DeskApi,
  type DeskPopups,
  deskErrorCode,
  fillDeskWords,
  screensErrorText,
} from '@whombat/client/desk';
import { useDeskScreenActions } from '@whombat/client/desk/react';
import { useTheAgent } from '@whombat/client/react';
import { deskScreenWords } from '@whombat/core';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Input } from '../../components/Input';
import { Modal, ModalTitle } from '../../components/Modal';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/Toast';
import { useLocaleWords } from '../../i18n/words';
import s from './Screens.module.css';

const T = DESK_SCREENS_TEXT.addDialog;

/** What the six boxes take: letters without I or O (as the contract's), upper case, six at most. */
export function screenLettersInput(typed: string): string {
  return typed
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z]/g, '')
    .slice(0, 6);
}

export function AddScreenDialog({
  burrow,
  api,
  open,
  onClose,
  onAdded,
}: {
  burrow: string;
  api: DeskApi;
  open: boolean;
  onClose: () => void;
  onAdded: (screen: string) => void;
}) {
  const DESK_SCREEN_WORDS = useLocaleWords(deskScreenWords);
  const { words } = useTheAgent(burrow);
  const actions = useDeskScreenActions(api);
  const toast = useToast();
  const id = useId();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [popups, setPopups] = useState<DeskPopups>('problems');
  const [start, setStart] = useState<'copy' | 'empty'>('copy');
  const [problem, setProblem] = useState<{ field: 'code' | 'name' | 'form'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCode('');
    setName('');
    setPopups('problems');
    setStart('copy');
    setProblem(null);
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!DESK_SCREEN_CODE_RE.test(code)) return setProblem({ field: 'code', text: T.needLetters });
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!clean) return setProblem({ field: 'name', text: T.needName });
    setBusy(true);
    setProblem(null);
    void actions
      .add({ code, name: clean, popups, start })
      .then((detail) => {
        toast.show(fillDeskWords(T.added, { name: detail.name }));
        onAdded(detail.id);
      })
      .catch((error) => {
        const c = deskErrorCode(error);
        setProblem({
          field: c === 'wrong_code' || c === 'pairing_expired' ? 'code' : 'form',
          text: screensErrorText(error),
        });
      })
      .finally(() => setBusy(false));
  };

  return (
    <Modal open={open} onOpenChange={(next) => (next ? undefined : onClose())} width="md">
      <form className={s.addForm} onSubmit={submit} noValidate>
        <ModalTitle className={s.dialogTitle}>{T.title}</ModalTitle>
        <p className={s.dialogLine}>
          {T.intro1}
          <b className={s.strong}>{T.useAsScreen}</b>
          {T.intro2}
        </p>
        <SixLetters
          id={`${id}-code`}
          value={code}
          onChange={(v) => {
            setCode(v);
            if (problem?.field === 'code') setProblem(null);
          }}
          invalid={problem?.field === 'code'}
          describedBy={problem?.field === 'code' ? `${id}-problem` : undefined}
        />
        {problem?.field === 'code' ? (
          <p className={s.problem} id={`${id}-problem`} role="alert">
            {problem.text}
          </p>
        ) : null}

        <div className={s.field}>
          <label className={s.fieldLabel} htmlFor={`${id}-name`}>
            {T.name}
          </label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={40}
            placeholder={T.namePlaceholder}
            invalid={problem?.field === 'name'}
            onChange={(e) => setName(e.target.value)}
            {...(problem?.field === 'name' ? { 'aria-describedby': `${id}-name-problem` } : {})}
          />
          {problem?.field === 'name' ? (
            <p className={s.problem} id={`${id}-name-problem`} role="alert">
              {problem.text}
            </p>
          ) : null}
        </div>

        <div className={s.field}>
          <span className={s.fieldLabel} id={`${id}-popups`}>
            {T.popups}
          </span>
          <SegmentedControl
            variant="soft"
            size="sm"
            role="radiogroup"
            label={T.popups}
            describedBy={`${id}-popups-hint`}
            value={popups}
            onChange={setPopups}
            options={DESK_POPUPS.map((p) => ({ value: p, label: DESK_SCREEN_WORDS.popups[p] }))}
          />
          <p className={s.fieldHint} id={`${id}-popups-hint`}>
            {fillDeskWords(T.popupsHint, { assistant: words.name })}
          </p>
        </div>

        <div className={s.field}>
          <span className={s.fieldLabel}>{T.start}</span>
          <SegmentedControl
            variant="soft"
            size="sm"
            role="radiogroup"
            label={T.start}
            value={start}
            onChange={setStart}
            options={[
              { value: 'copy', label: T.copy },
              { value: 'empty', label: T.empty },
            ]}
          />
        </div>

        {problem?.field === 'form' ? (
          <p className={s.problem} role="alert">
            {problem.text}
          </p>
        ) : null}
        <div className={s.dialogButtons}>
          <Button variant="ghost" onClick={onClose}>
            {T.cancel}
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? T.adding : T.submit}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Six letter boxes over one real input (so typing, pasting, the keyboard and a screen reader work as for any field):
 * the boxes show what's typed and where the next letter goes.
 */
export function SixLetters({
  id,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  describedBy?: string | undefined;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div className={cx(s.letters, invalid && s.lettersInvalid)}>
      {Array.from({ length: 6 }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: the six boxes are places, not items
          key={i}
          className={cx(s.letter, focused && i === Math.min(value.length, 5) && s.letterCur)}
          aria-hidden="true"
        >
          {value[i] ?? ''}
        </span>
      ))}
      <input
        id={id}
        className={s.lettersInput}
        value={value}
        onChange={(e) => onChange(screenLettersInput(e.target.value))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-label={T.letters}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        inputMode="text"
        maxLength={12}
      />
    </div>
  );
}
