// Form building blocks in the design language: labeled fields (12 px label,
// 40 px inputs on --bg with a --line-strong border, like the filter input),
// a toggle switch (role="switch"), a copyable code block and inline errors.

import { type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, useId, useState } from 'react';
import { t } from '../lib/i18n';
import { Icon } from './Icon';

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
  className?: string;
}

export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : '', error ? errId : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={className ? `field ${className}` : 'field'}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children({ id, describedBy, invalid: !!error })}
      {hint && (
        <div className="field-hint" id={hintId}>
          {hint}
        </div>
      )}
      {error && (
        <div className="field-error" id={errId}>
          {error}
        </div>
      )}
    </div>
  );
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & { label: ReactNode; hint?: ReactNode; error?: ReactNode; mono?: boolean; ref?: Ref<HTMLInputElement> };

export function TextField({ label, hint, error, mono, className, ...rest }: InputProps) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      {({ id, describedBy, invalid }) => (
        <input id={id} className={mono ? 'input mono' : 'input'} aria-describedby={describedBy} aria-invalid={invalid || undefined} {...rest} />
      )}
    </Field>
  );
}

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> & { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode };

export function SelectField({ label, hint, error, className, children, ...rest }: SelectProps) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      {({ id, describedBy, invalid }) => (
        <span className="select-wrap">
          <select id={id} className="input" aria-describedby={describedBy} aria-invalid={invalid || undefined} {...rest}>
            {children}
          </select>
          <Icon name="chevronDown" size={16} />
        </span>
      )}
    </Field>
  );
}

interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  /** Visible description below the label. */
  description?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
}

/** Toggle switch: a button with role="switch" and aria-checked; the label is its name. */
export function Switch({ checked, onChange, label, description, disabled, busy }: SwitchProps) {
  const id = useId();
  return (
    <div className="switch-row">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={description ? `${id}-d` : undefined}
        aria-busy={busy || undefined}
        disabled={disabled}
        className="switch"
        onClick={() => onChange(!checked)}
      >
        <span className="switch-knob" aria-hidden="true" />
      </button>
      <div className="switch-text">
        <span id={`${id}-l`} className="switch-label">
          {label}
        </span>
        {description && (
          <span id={`${id}-d`} className="lbl">
            {description}
          </span>
        )}
      </div>
    </div>
  );
}

/** Monospace block with a Copy button (install command). */
export function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
    setTimeout(() => setCopied('idle'), 2500);
  };
  return (
    <div className="copy-block">
      <code className="mono" aria-label={label}>
        {text}
      </code>
      <button type="button" className="btn-ghost" onClick={() => void copy()}>
        <Icon name={copied === 'ok' ? 'check' : 'copy'} size={16} />
        {copied === 'ok' ? t('Copied') : t('Copy')}
      </button>
      <span className="sr-only" role="status">
        {copied === 'ok' ? t('Copied to the clipboard') : copied === 'fail' ? t('Copy failed; select the text and copy it manually') : ''}
      </span>
    </div>
  );
}

export function InlineError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="inline-error" role="alert">
      <span style={{ color: 'var(--critical-text)', display: 'inline-flex' }}>
        <Icon name="critical" size={16} />
      </span>
      <span>{children}</span>
    </div>
  );
}

/** Message of an API error for display (problem detail, else the title). */
export function errorText(err: unknown): string {
  if (!err) return '';
  if (err instanceof Error) return err.message;
  return String(err);
}
