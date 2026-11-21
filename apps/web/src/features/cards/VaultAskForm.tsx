import {
  VAULT_ASK_FIRST_WAY,
  VAULT_ASK_KEY_IN,
  vaultAskKept,
  vaultAskProblems,
  vaultAskShownFields,
  vaultAskValues,
  vaultAskWays,
} from '@whombat/client';
import { GUIDE_VALUE_MAX } from '@whombat/core/contracts';
import type { GuideField, GuideFormBlock, GuideVaultAsk, GuideVaultServerWay } from '@whombat/core/domain';
import { VAULT_ASK_FIELDS } from '@whombat/core/vault';
import { type DragEvent, type FormEvent, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import c from '../connectors/Connectors.module.css';
import guide from './GuideCard.module.css';
import type { GuideFormProblem } from './GuideForm';

export interface VaultAskFormProps {
  ask: GuideVaultAsk;
  block: GuideFormBlock;
  /** The assistant's name for the ways' words (“Use the password once to put Dusty’s key on it”). */
  assistant: string;
  busy: boolean;
  problem: GuideFormProblem | null;
  /** Sends the values (`guides.act` only); resolves true when the server took them. */
  onSubmit: (values: Record<string, string>) => Promise<boolean>;
}

/**
 * Password managers keep out: none offers to save or fill what goes to the Vault (`autocomplete` alone isn't heeded by
 * the extensions).
 */
const NO_MANAGERS = {
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-bwignore': true,
  'data-form-type': 'other',
};

/**
 * The sign-in card's form (Whombat vault-simplify.md VLT-40…VLT-44; AP-6650…): a `server` card's three ways as a
 * choice (the key put on first and chosen) with only the chosen way's fields, a website login's optional
 * authenticator key, a code's one field. Every secret is write-only: masked, kept out of the browser's and password
 * managers' storage, never shown again, and dropped from the form as soon as it was sent, whatever the answer. The
 * words are core's.
 */
export function VaultAskForm({ ask, block, assistant, busy, problem, onSubmit }: VaultAskFormProps) {
  const ids = useId();
  const [way, setWay] = useState<GuideVaultServerWay>(VAULT_ASK_FIRST_WAY);
  const [values, setValues] = useState<Record<string, string>>({});
  const [keyIn, setKeyIn] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sentWith, setSentWith] = useState<GuideFormProblem | null>(null);
  const shown = vaultAskShownFields(ask, block, way);

  const set = (id: string, value: string) => {
    setValues((v) => ({ ...v, [id]: value }));
    setErrors(({ [id]: _gone, ...rest }) => rest);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const local = vaultAskProblems(ask, shown, values);
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    const sent = vaultAskValues(ask, shown, values, way);
    // Nothing secret stays in the page once it went: a wrong password is typed again.
    setValues(vaultAskKept(shown, values));
    setKeyIn(null);
    setSentWith(problem);
    await onSubmit(sent);
  }

  // The server's words for the last send show on their field until it is typed into again.
  const serverProblem = problem && problem !== sentWith ? problem : null;
  const errorOf = (id: string) => errors[id] ?? serverProblem?.fields[id] ?? null;
  const shownIds = new Set(shown.map((f) => f.id));
  const elsewhere =
    serverProblem &&
    (Object.keys(serverProblem.fields).length === 0 ||
      Object.keys(serverProblem.fields).every((id) => !shownIds.has(id)))
      ? serverProblem.message
      : null;

  return (
    <form className={guide.form} onSubmit={(e) => void submit(e)} noValidate autoComplete="off">
      {ask.kind === 'server' ? (
        <WayChoice
          name={`${ids}-way`}
          assistant={assistant}
          way={way}
          disabled={busy}
          onWay={(next) => {
            setWay(next);
            setErrors({});
            setSentWith(problem);
          }}
        />
      ) : null}
      {shown.map((field) => {
        const id = `${ids}-${field.id}`;
        const error = errorOf(field.id);
        const errorId = error ? `${id}-error` : undefined;
        if (field.kind === 'key_file')
          return (
            <KeyFileField
              key={field.id}
              id={id}
              field={field}
              keyIn={keyIn}
              error={error}
              errorId={errorId}
              disabled={busy}
              onKey={(text, label) => {
                set(field.id, text);
                setKeyIn(label);
              }}
              onProblem={(text) => setErrors((e) => ({ ...e, [field.id]: text }))}
              onClear={() => {
                set(field.id, '');
                setKeyIn(null);
              }}
            />
          );
        const code = field.id === VAULT_ASK_FIELDS.code;
        return (
          <label key={field.id} className={guide.field} htmlFor={id}>
            <span className={c.fieldLabel}>
              {field.label}
              {field.optional ? <span className={guide.optional}> · optional</span> : null}
            </span>
            <Input
              id={id}
              name={`${ids}-${field.id}`}
              size="md"
              type={field.kind === 'secret' ? 'password' : 'text'}
              spellCheck={false}
              autoComplete={code ? 'one-time-code' : field.kind === 'secret' ? 'new-password' : 'off'}
              autoCapitalize="off"
              autoCorrect="off"
              inputMode={code ? 'text' : undefined}
              placeholder={field.placeholder ?? undefined}
              value={values[field.id] ?? ''}
              disabled={busy}
              onChange={(e) => set(field.id, e.target.value)}
              invalid={error !== null}
              aria-describedby={errorId}
              {...NO_MANAGERS}
            />
            {error ? (
              <span id={errorId} className={guide.fieldError}>
                {error}
              </span>
            ) : null}
          </label>
        );
      })}
      {elsewhere ? (
        <p className={c.error} role="alert">
          {elsewhere}
        </p>
      ) : null}
      <div className={guide.actions}>
        <Button type="submit" variant="primary" size="lg" disabled={busy}>
          {block.submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** The three ways as radio tiles: the guide's option tiles with a real radio each. */
function WayChoice({
  name,
  assistant,
  way,
  disabled,
  onWay,
}: {
  name: string;
  assistant: string;
  way: GuideVaultServerWay;
  disabled: boolean;
  onWay: (way: GuideVaultServerWay) => void;
}) {
  return (
    <fieldset className={guide.ways} disabled={disabled}>
      <legend className={c.srOnly}>How to sign in</legend>
      {vaultAskWays(assistant).map((w) => {
        const selected = w.id === way;
        return (
          <label key={w.id} className={cx(guide.option, guide.way)} data-selected={selected || undefined}>
            <input
              type="radio"
              className={guide.wayRadio}
              name={name}
              value={w.id}
              checked={selected}
              onChange={() => onWay(w.id)}
            />
            <span className={guide.optionText}>
              <span className={guide.optionTitle}>{w.label}</span>
              <span className={guide.optionDescription}>{w.detail}</span>
            </span>
            {selected ? (
              <span className={guide.check} aria-hidden="true">
                <Icon name="can" size={12} />
              </span>
            ) : null}
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * A private key, pasted or picked as a file (or dropped): read here, never drawn — once in, only “Private key pasted”
 * or the file's name shows, with Remove. The paste box keeps nothing in it.
 */
function KeyFileField({
  id,
  field,
  keyIn,
  error,
  errorId,
  disabled,
  onKey,
  onProblem,
  onClear,
}: {
  id: string;
  field: GuideField;
  keyIn: string | null;
  error: string | null;
  errorId: string | undefined;
  disabled: boolean;
  onKey: (text: string, label: string) => void;
  onProblem: (text: string) => void;
  onClear: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const labelId = `${id}-label`;

  async function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > GUIDE_VALUE_MAX) return onProblem(VAULT_ASK_KEY_IN.tooBig);
    let text: string;
    try {
      text = await file.text();
    } catch {
      return onProblem(VAULT_ASK_KEY_IN.unreadable);
    }
    if (text.length > GUIDE_VALUE_MAX) return onProblem(VAULT_ASK_KEY_IN.tooBig);
    if (!text.trim()) return onProblem(VAULT_ASK_KEY_IN.unreadable);
    onKey(text, VAULT_ASK_KEY_IN.file(file.name));
  }

  function paste(text: string) {
    if (!text.trim()) return onProblem(VAULT_ASK_KEY_IN.nothing);
    if (text.length > GUIDE_VALUE_MAX) return onProblem(VAULT_ASK_KEY_IN.tooBig);
    onKey(text, VAULT_ASK_KEY_IN.pasted);
  }

  return (
    <div className={guide.field}>
      <span className={c.fieldLabel} id={labelId}>
        {field.label}
        {field.optional ? <span className={guide.optional}> · optional</span> : null}
      </span>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the box and the button inside are the keyboard's ways */}
      <div
        className={cx(c.drop, guide.drop, guide.keyDrop)}
        data-over={over || undefined}
        data-invalid={error ? true : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e: DragEvent) => {
          e.preventDefault();
          setOver(false);
          if (disabled) return;
          const file = e.dataTransfer.files[0];
          if (file) void readFile(file);
          else paste(e.dataTransfer.getData('text/plain'));
        }}
      >
        {keyIn ? (
          <>
            <Icon name="can" size={14} className={guide.answerCheck} />
            <span className={guide.fileName}>{keyIn}</span>
            <button type="button" className={c.fileButton} disabled={disabled} onClick={onClear}>
              {VAULT_ASK_KEY_IN.remove}
            </button>
          </>
        ) : (
          <>
            <textarea
              id={id}
              className={guide.keyPaste}
              rows={1}
              value=""
              placeholder={field.placeholder ?? undefined}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              aria-labelledby={labelId}
              aria-describedby={errorId}
              aria-invalid={error ? true : undefined}
              onPaste={(e) => {
                e.preventDefault();
                paste(e.clipboardData.getData('text/plain'));
              }}
              // Typing a key by hand isn't a thing: only a paste or a file goes in, so nothing shows as typed.
              onChange={() => {}}
              {...NO_MANAGERS}
            />
            <button
              type="button"
              className={c.fileButton}
              disabled={disabled}
              aria-describedby={labelId}
              onClick={() => input.current?.click()}
            >
              {VAULT_ASK_KEY_IN.pick}
            </button>
          </>
        )}
        <input
          ref={input}
          type="file"
          className={c.srOnly}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            void readFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      {error ? (
        <span id={errorId} className={guide.fieldError}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
