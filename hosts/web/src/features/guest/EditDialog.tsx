// The edit dialog of the configuration tabs (docs/MANAGE.md, Editing):
// typed fields, then a review step listing `key: old → new`, then Apply.
// A change made meanwhile (409) reloads the configuration and the review
// shows the new old values; field errors from the hub go back to the
// fields. Dialogs without fields (detach, remove) start at the review.

import { type FormEvent, type ReactNode, useId, useState } from 'react';
import type { GuestConfig } from '../../api/manage';
import type { Guest } from '../../api/types';
import { InlineError } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { t, tx } from '../../lib/i18n';
import { type ConfigDraft, isEmptyDraft, type ReviewRow, reviewRows, SECRET_KEYS, shownValue, trimDraft } from './config';
import { useConfigChange } from './useConfigChange';

/** What every edit dialog works on. */
export interface EditCtx {
  serverId: string;
  guest: Guest;
  config: GuestConfig;
}

interface EditDialogProps {
  ctx: EditCtx;
  title: ReactNode;
  description?: ReactNode;
  /** Names the change in toasts ("Memory of web-01"). */
  label: string;
  /** The change the fields describe; null while a field is invalid (the field says why). */
  draft: ConfigDraft | null;
  /** Fields; `errors` are the hub's field errors by config key. None: the dialog opens at the review. */
  children?: (errors: Record<string, string>) => ReactNode;
  onClose: () => void;
  /** Destroys data (an unused disk): sends confirm: true, serious colors. */
  destructive?: boolean;
  wide?: boolean;
}

export function EditDialog({ ctx, title, description, label, draft, children, onClose, destructive, wide }: EditDialogProps) {
  const change = useConfigChange(ctx.serverId, ctx.guest, ctx.config);
  const formId = useId();
  const [step, setStep] = useState<'edit' | 'review'>(children ? 'edit' : 'review');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const d = draft ? trimDraft(ctx.config, { ...draft, ...(destructive ? { confirm: true } : {}) }) : null;
  const rows = d ? reviewRows(ctx.config, d) : [];
  const empty = !d || isEmptyDraft(d);

  const review = (e: FormEvent) => {
    e.preventDefault();
    if (empty) return;
    setErrors({});
    setError(null);
    setNotice(null);
    setStep('review');
  };

  const apply = async () => {
    if (!d || empty || change.busy) return;
    setError(null);
    setNotice(null);
    const out = await change.apply(label, d, { inline: true });
    if (out.ok) return onClose();
    if (out.conflict) setNotice(out.message);
    else if (out.fieldErrors && children) {
      setErrors(out.fieldErrors);
      setStep('edit');
    } else setError(out.fieldErrors ? Object.entries(out.fieldErrors).map(([k, v]) => `${k}: ${v}`).join('; ') : out.message);
  };

  return (
    <Modal
      open
      onClose={onClose}
      busy={change.busy}
      wide={wide}
      tone={destructive ? 'serious' : 'default'}
      title={title}
      description={step === 'edit' || !children ? description : undefined}
      actions={
        step === 'edit' ? (
          <>
            {empty && <span className="lbl spacer">{draft ? t('Nothing changed yet.') : ''}</span>}
            <button type="button" className="btn-ghost" onClick={onClose}>
              {t('Cancel')}
            </button>
            <button type="submit" form={formId} className="btn-primary btn-sm" aria-disabled={empty || undefined}>
              {t('Review')}
            </button>
          </>
        ) : (
          <>
            {children ? (
              <button type="button" className="btn-ghost" disabled={change.busy} onClick={() => setStep('edit')}>
                {t('Back')}
              </button>
            ) : (
              <button type="button" className="btn-ghost" disabled={change.busy} onClick={onClose}>
                {t('Cancel')}
              </button>
            )}
            <button type="button" className={`btn-primary btn-sm${destructive ? ' is-serious' : ''}`} autoFocus aria-disabled={empty || change.busy || undefined} onClick={() => void apply()}>
              {change.busy && <span className="spinner spinner-sm on-primary" aria-hidden="true" />}
              {t('Apply')}
            </button>
          </>
        )
      }
    >
      {step === 'edit' && children ? (
        <form id={formId} className="form-stack" onSubmit={review} noValidate>
          {children(errors)}
        </form>
      ) : (
        <div className="form-stack">
          {notice && (
            <div className="warn-line" role="alert">
              <span className="warn-ic">
                <Icon name="warning" size={16} />
              </span>
              <span>{notice}</span>
            </div>
          )}
          <ReviewList rows={rows} restartNote={ctx.config.platform === 'pve' && ctx.config.running} />
          <InlineError>{error}</InlineError>
        </div>
      )}
    </Modal>
  );
}

/** The `key: old → new` list of the review step; `restartNote` for a running Proxmox guest (Incus applies everything at once). */
export function ReviewList({ rows, restartNote }: { rows: ReviewRow[]; restartNote: boolean }) {
  if (!rows.length) return <p className="ink-2">{t('Nothing to change: the configuration already has these values.')}</p>;
  return (
    <div className="form-stack-sm">
      <h3 className="lbl">{t('Review the change')}</h3>
      <ul className="plain-list review-list" aria-label={t('Changes')}>
        {rows.map((r) => (
          <li key={`${r.op}-${r.key}`} className="review-row">
            <span className="mono strong">{r.key}</span>
            <span className="review-vals">
              {r.op === 'delete' ? (
                tx('{old} → removed', { old: <span className="mono review-old">{shownValue(r.key, r.old)}</span> })
              ) : r.op === 'revert' ? (
                tx('{old} → {new} (revert)', { old: <span className="mono review-old">{shownValue(r.key, r.old)}</span>, new: <span className="mono">{shownValue(r.key, r.new)}</span> })
              ) : (
                <>
                  <span className="mono review-old">{shownValue(r.key, r.old)}</span>
                  {' → '}
                  <span className="mono ink">{SECRET_KEYS.has(r.key) ? t('(new value)') : shownValue(r.key, r.new)}</span>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      {restartNote && <p className="lbl">{t('The guest is running: changes it cannot take live apply at the next restart.')}</p>}
    </div>
  );
}
