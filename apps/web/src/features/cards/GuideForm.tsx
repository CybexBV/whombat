import { GUIDE_VALUE_MAX } from '@whombat/core/contracts';
import type { GuideField, GuideFormBlock } from '@whombat/core/domain';
import { type DragEvent, type FormEvent, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Input } from '../../components/Input';
import c from '../connectors/Connectors.module.css';
import { parseClientSecretFile, redirectMismatchText } from '../connectors/copy';
import { useConnectorsStatus } from '../connectors/useConnectGoogle';
import guide from './GuideCard.module.css';

/** The server's `invalid_values`: its words and the first problem per field id. */
export interface GuideFormProblem {
  message: string;
  fields: Record<string, string>;
}

export interface GuideFormProps {
  block: GuideFormBlock;
  busy: boolean;
  problem: GuideFormProblem | null;
  /** Sends the values (`guides.act` only); resolves true when the server took them. */
  onSubmit: (values: Record<string, string>) => Promise<boolean>;
}

const FILL_IN = 'Fill this in.';
const CHOOSE_FILE = 'Choose the file.';
const TOO_BIG = 'That file is too big.';
const UNREADABLE = 'That file couldn’t be read. Try again.';

/**
 * A guide's secure form (AG-03, AG-06 step 5): text fields, secret fields (masked, never autocompleted) and a JSON
 * file read here in the browser — Google's `client_secret_….json` is checked (a Desktop client is refused, CN-03) and
 * fills the Client ID and secret. The values go only to `guides.act`, never into a message, and are cleared once the
 * server took them.
 */
export function GuideForm({ block, busy, problem, onSubmit }: GuideFormProps) {
  const ids = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [warning, setWarning] = useState<string | null>(null);
  const status = useConnectorsStatus();
  const redirectUri = status.data?.google.setup.redirectUri ?? null;

  const set = (id: string, value: string) => {
    setValues((v) => ({ ...v, [id]: value }));
    setErrors(({ [id]: _gone, ...rest }) => rest);
  };

  async function readFile(field: GuideField, file: File | undefined) {
    if (!file) return;
    setWarning(null);
    // Far bigger than any client file (or a dropped folder): not read at all.
    if (file.size > GUIDE_VALUE_MAX) {
      setErrors((e) => ({ ...e, [field.id]: TOO_BIG }));
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setErrors((e) => ({ ...e, [field.id]: UNREADABLE }));
      return;
    }
    if (text.length > GUIDE_VALUE_MAX) {
      setErrors((e) => ({ ...e, [field.id]: TOO_BIG }));
      return;
    }
    const parsed = parseClientSecretFile(text);
    if (!parsed.ok) {
      setErrors((e) => ({ ...e, [field.id]: parsed.error }));
      return;
    }
    // The file fills the form's Client ID and secret too, as in Settings → Connections.
    const idField = block.fields.find((f) => f.kind === 'text');
    const secretField = block.fields.find((f) => f.kind === 'secret');
    setValues((v) => ({
      ...v,
      [field.id]: text,
      ...(idField && { [idField.id]: parsed.clientId }),
      ...(secretField && { [secretField.id]: parsed.clientSecret }),
    }));
    setFiles((f) => ({ ...f, [field.id]: file.name }));
    setErrors({});
    if (redirectUri && !parsed.redirectUris.includes(redirectUri))
      setWarning(redirectMismatchText(redirectUri));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const missing: Record<string, string> = {};
    for (const f of block.fields)
      if (!f.optional && !(values[f.id] ?? '').trim())
        missing[f.id] = f.kind === 'json_file' ? CHOOSE_FILE : FILL_IN;
    setErrors(missing);
    if (Object.keys(missing).length > 0) return;
    const sent = Object.fromEntries(
      block.fields
        .filter((f) => (values[f.id] ?? '').trim() !== '')
        .map((f) => [
          f.id,
          f.kind === 'json_file' ? (values[f.id] as string) : (values[f.id] as string).trim(),
        ]),
    );
    if (await onSubmit(sent)) {
      setValues({});
      setFiles({});
      setWarning(null);
    }
  }

  const errorOf = (id: string) => errors[id] ?? problem?.fields[id] ?? null;
  const problemText = problem && Object.keys(problem.fields).length === 0 ? problem.message : null;

  return (
    <form className={guide.form} onSubmit={(e) => void submit(e)} noValidate>
      {block.fields.map((field) => {
        const id = `${ids}-${field.id}`;
        const error = errorOf(field.id);
        const errorId = error ? `${id}-error` : undefined;
        return field.kind === 'json_file' ? (
          <JsonFileField
            key={field.id}
            id={id}
            field={field}
            fileName={files[field.id] ?? null}
            error={error}
            errorId={errorId}
            disabled={busy}
            onFile={(file) => void readFile(field, file)}
            onClear={() => {
              set(field.id, '');
              setFiles(({ [field.id]: _gone, ...rest }) => rest);
              setWarning(null);
            }}
          />
        ) : (
          <label key={field.id} className={guide.field} htmlFor={id}>
            <span className={c.fieldLabel}>
              {field.label}
              {field.optional ? <span className={guide.optional}> · optional</span> : null}
            </span>
            <Input
              id={id}
              size="md"
              type={field.kind === 'secret' ? 'password' : 'text'}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              placeholder={field.placeholder ?? undefined}
              value={values[field.id] ?? ''}
              disabled={busy}
              onChange={(e) => set(field.id, e.target.value)}
              invalid={error !== null}
              aria-describedby={errorId}
            />
            {error ? (
              <span id={errorId} className={guide.fieldError}>
                {error}
              </span>
            ) : null}
          </label>
        );
      })}
      {warning ? <p className={guide.warning}>{warning}</p> : null}
      {problemText ? (
        <p className={c.error} role="alert">
          {problemText}
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

function JsonFileField({
  id,
  field,
  fileName,
  error,
  errorId,
  disabled,
  onFile,
  onClear,
}: {
  id: string;
  field: GuideField;
  fileName: string | null;
  error: string | null;
  errorId: string | undefined;
  disabled: boolean;
  onFile: (file: File | undefined) => void;
  onClear: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const labelId = `${id}-label`;
  return (
    <div className={guide.field}>
      <span className={c.fieldLabel} id={labelId}>
        {field.label}
        {field.optional ? <span className={guide.optional}> · optional</span> : null}
      </span>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the button inside is the keyboard way */}
      <div
        className={cx(c.drop, guide.drop)}
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
          if (!disabled) onFile(e.dataTransfer.files[0]);
        }}
      >
        {fileName ? (
          <>
            <span className={guide.fileName}>{fileName}</span>
            <span>Read here in your browser</span>
            <button type="button" className={c.fileButton} disabled={disabled} onClick={onClear}>
              Remove
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={c.fileButton}
              disabled={disabled}
              aria-describedby={[labelId, errorId].filter(Boolean).join(' ')}
              onClick={() => input.current?.click()}
            >
              Choose the JSON file
            </button>
            <span>or drop it here</span>
          </>
        )}
        <input
          ref={input}
          id={id}
          type="file"
          accept="application/json,.json"
          className={c.srOnly}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            onFile(e.target.files?.[0]);
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
