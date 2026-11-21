// Small edit dialogs shared by the configuration tabs: one select, one
// switch, one text (or multiline) field, each mapped to one config key
// and sent through the edit dialog's review step.

import { type ReactNode, useState } from 'react';
import { Field, InlineError, SelectField, Switch, TextField } from '../../components/forms';
import { t } from '../../lib/i18n';
import { type ConfigDraft, current, draftOf, flagValue } from './config';
import { isOn } from './props';
import { EditDialog, type EditCtx } from './EditDialog';

export interface DialogProps {
  ctx: EditCtx;
  onClose: () => void;
}

/** The hub's field errors for keys a dialog has no field for. */
export function KeyErrors({ errors, keys }: { errors: Record<string, string>; keys: string[] }) {
  const list = keys.filter((k) => errors[k]).map((k) => `${k}: ${errors[k]}`);
  return list.length ? <InlineError>{list.join('; ')}</InlineError> : null;
}

export interface Option {
  value: string;
  label: string;
}

interface SelectDialogProps extends DialogProps {
  cfgKey: string;
  title: string;
  label: string;
  fieldLabel: string;
  options: Option[];
  /** The option of the current value (default: the value itself, or the first option when unset). */
  read?: (cur: string | undefined) => string;
  /** The value to store (undefined removes the key; default: the first option means "unset"). */
  write?: (v: string, cur: string | undefined) => string | undefined;
  hint?: (v: string) => ReactNode;
}

export function SelectDialog({ ctx, onClose, cfgKey, title, label, fieldLabel, options, read, write, hint }: SelectDialogProps) {
  const cur = current(ctx.config, cfgKey);
  const initial = read ? read(cur) : (cur ?? options[0]?.value ?? '');
  const [v, setV] = useState(initial);
  const all = options.some((o) => o.value === initial) ? options : [{ value: initial, label: initial }, ...options];
  const draft: ConfigDraft = v === initial ? {} : draftOf({ [cfgKey]: write ? write(v, cur) : v === options[0]?.value ? undefined : v });
  return (
    <EditDialog ctx={ctx} title={title} label={label} draft={draft} onClose={onClose}>
      {(errors) => (
        <SelectField label={fieldLabel} value={v} onChange={(e) => setV(e.target.value)} hint={hint?.(v)} error={errors[cfgKey]} autoFocus>
          {all.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
      )}
    </EditDialog>
  );
}

interface FlagDialogProps extends DialogProps {
  cfgKey: string;
  title: string;
  label: string;
  switchLabel: string;
  description?: ReactNode;
  /** The value Proxmox assumes when the key is missing. */
  defaultOn?: boolean;
  /** Always write "true" / "false" (Incus: a missing key may come from a profile). */
  explicit?: boolean;
}

export function FlagDialog({ ctx, onClose, cfgKey, title, label, switchLabel, description, defaultOn = false, explicit }: FlagDialogProps) {
  const initial = isOn(current(ctx.config, cfgKey), defaultOn);
  const [on, setOn] = useState(initial);
  const draft: ConfigDraft = on === initial ? {} : draftOf({ [cfgKey]: explicit ? String(on) : flagValue(on, defaultOn) });
  return (
    <EditDialog ctx={ctx} title={title} label={label} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          <Switch checked={on} onChange={setOn} label={switchLabel} description={description} />
          <KeyErrors errors={errors} keys={[cfgKey]} />
        </>
      )}
    </EditDialog>
  );
}

interface TextDialogProps extends DialogProps {
  cfgKey: string;
  title: string;
  label: string;
  fieldLabel: string;
  hint?: ReactNode;
  multiline?: boolean;
  mono?: boolean;
  /** A message when the text is not acceptable (null: fine). Empty text removes the key unless `required`. */
  validate?: (v: string) => string | null;
  required?: boolean;
  placeholder?: string;
}

export function TextDialog({ ctx, onClose, cfgKey, title, label, fieldLabel, hint, multiline, mono, validate, required, placeholder }: TextDialogProps) {
  const initial = current(ctx.config, cfgKey) ?? '';
  const [v, setV] = useState(initial);
  const text = multiline ? v.replace(/\s+$/, '') : v.trim();
  const err = !text ? (required ? t('Required.') : null) : (validate?.(text) ?? null);
  const draft: ConfigDraft | null = err ? null : text === initial ? {} : draftOf({ [cfgKey]: text || undefined });
  return (
    <EditDialog ctx={ctx} title={title} label={label} draft={draft} onClose={onClose} wide={multiline}>
      {(errors) =>
        multiline ? (
          <Field label={fieldLabel} hint={hint} error={errors[cfgKey] ?? err ?? undefined}>
            {({ id, describedBy, invalid }) => (
              <textarea
                id={id}
                className={mono ? 'input mono' : 'input'}
                rows={8}
                value={v}
                spellCheck={!mono}
                placeholder={placeholder}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                onChange={(e) => setV(e.target.value)}
                autoFocus
              />
            )}
          </Field>
        ) : (
          <TextField
            label={fieldLabel}
            hint={hint}
            mono={mono}
            value={v}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            error={errors[cfgKey] ?? err ?? undefined}
            onChange={(e) => setV(e.target.value)}
            autoFocus
          />
        )
      }
    </EditDialog>
  );
}
