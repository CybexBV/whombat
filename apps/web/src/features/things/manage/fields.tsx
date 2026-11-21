/**
 * Form pieces of the servers' dialogs: a labelled field with its hint and error, a select (with groups), a text area,
 * a tick box, a section of a long form and its collapsed Advanced part, the frame.
 */
import { ChevronRight } from 'lucide-react';
import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from 'react';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { Modal, ModalDescription, ModalTitle } from '../../../components/Modal';
import wc from '../HostFleet.module.css';
import styles from '../Things.module.css';

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (props: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string }) => ReactNode;
}) {
  const id = useId();
  const note = error || hint ? `${id}-note` : undefined;
  return (
    <div className={styles.field}>
      <label htmlFor={id}>
        <span>{label}</span>
      </label>
      {children({
        id,
        ...(error ? { 'aria-invalid': true } : {}),
        ...(note ? { 'aria-describedby': note } : {}),
      })}
      {error ? (
        <span id={note} className={styles.fieldError}>
          {error}
        </span>
      ) : hint ? (
        <small id={note}>{hint}</small>
      ) : null}
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  mono,
  ...rest
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  mono?: boolean;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(p) => (
        <input
          className={styles.input}
          style={mono ? { fontFamily: 'var(--font-mono)', fontSize: 13.5 } : undefined}
          autoComplete="off"
          spellCheck={false}
          {...p}
          {...rest}
        />
      )}
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  /** Options with the same group are listed under it (an ISO image's storage). */
  group?: string;
}

export function SelectField({
  label,
  hint,
  error,
  options,
  ...rest
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  options: readonly SelectOption[];
} & SelectHTMLAttributes<HTMLSelectElement>) {
  const groups = [...new Set(options.map((o) => o.group ?? ''))];
  const list = (os: readonly SelectOption[]) =>
    os.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ));
  return (
    <Field label={label} hint={hint} error={error}>
      {(p) => (
        <select className={styles.input} {...p} {...rest}>
          {groups.length > 1
            ? groups.map((g) =>
                g ? (
                  <optgroup key={g} label={g}>
                    {list(options.filter((o) => o.group === g))}
                  </optgroup>
                ) : (
                  list(options.filter((o) => !o.group))
                ),
              )
            : list(options)}
        </select>
      )}
    </Field>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  ...rest
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
} & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(p) => <textarea className={styles.input} spellCheck={false} {...p} {...rest} />}
    </Field>
  );
}

/** A part of a long form under its heading (General, Disk, Network…). */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className={wc.wcSection}>
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}

/** What most people leave as it is, folded away until opened. */
export function Advanced({ children, label = 'Advanced' }: { children: ReactNode; label?: string }) {
  return (
    <details className={wc.wcAdvanced}>
      <summary>
        <Icon icon={ChevronRight} size={15} />
        {label}
      </summary>
      <div className={wc.wcAdvancedBody}>{children}</div>
    </details>
  );
}

export function Check({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** A muted line after the label (why it's locked). */
  hint?: ReactNode;
}) {
  return (
    <label className={styles.check}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint ? <small className={wc.wcCheckHint}> {hint}</small> : null}
      </span>
    </label>
  );
}

/** A dialog with a form: title, words under it, the fields, a refusal, Cancel and the action. */
export function FormDialog({
  title,
  description,
  children,
  error,
  action,
  busy,
  serious,
  disabled,
  onSubmit,
  onClose,
  width = 'md',
  extra,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  error?: string | null;
  action: string;
  busy?: boolean;
  serious?: boolean;
  disabled?: boolean;
  onSubmit: () => void;
  onClose: () => void;
  width?: 'md' | 'lg';
  /** Something left of Cancel (Back). */
  extra?: ReactNode;
}) {
  const formId = useId();
  return (
    <Modal open onOpenChange={(o) => !o && !busy && onClose()} width={width}>
      <ModalTitle className={styles.dialogTitle}>{title}</ModalTitle>
      {description ? <ModalDescription className={styles.dialogBody}>{description}</ModalDescription> : null}
      <form
        id={formId}
        className={styles.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          // A dialog opened from this one (Get templates) is in its React tree: its submit stops here.
          e.stopPropagation();
          if (!busy && !disabled) onSubmit();
        }}
      >
        {children}
      </form>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.dialogActions}>
        {extra}
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="submit"
          form={formId}
          variant="primary"
          className={serious ? styles.seriousBtn : undefined}
          disabled={busy || disabled}
          aria-busy={busy || undefined}
        >
          {action}
        </Button>
      </div>
    </Modal>
  );
}
