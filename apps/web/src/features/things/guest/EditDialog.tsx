/**
 * Editing a guest's configuration (ported from Rackoon's `features/guest/EditDialog.tsx`, docs/MANAGE.md “Editing”):
 * typed fields, then a review that lists `key: old → new`, then Apply with the digest of what was reviewed. A change
 * made meanwhile comes back as “Changed meanwhile — review again.” and the review shows the new old values; field
 * errors go back to their fields. Dialogs without fields (remove a disk) open at the review. Also the banner of
 * changes that wait for a restart, with Revert and Restart now (AP-1312).
 */
import {
  type ConfigDraft,
  incusDraft,
  isEmptyDraft,
  pendingKeys,
  type ReviewRow,
  reviewRows,
  SECRET_KEYS,
  shownValue,
  trimDraft,
} from '@whombat/client/hosts';
import type { HostGuest, HostGuestConfig } from '@whombat/core/domain';
import { Clock } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { Modal, ModalDescription, ModalTitle } from '../../../components/Modal';
import { useManage } from '../manage/useManage';
import styles from '../Things.module.css';

export interface EditCtx {
  burrow: string;
  serverId: string;
  guest: Pick<HostGuest, 'id' | 'name' | 'platform'>;
  config: HostGuestConfig;
}

export interface EditDialogProps {
  ctx: EditCtx;
  title: string;
  description?: ReactNode;
  /** The change the fields describe; null while a field is wrong (the field says why). */
  draft: ConfigDraft | null;
  /** Fields; `errors` are the server's field errors by config key. None: the dialog opens at the review. */
  children?: (errors: Record<string, string>) => ReactNode;
  onClose: () => void;
  /** Destroys data (an unused disk): sent with confirm, serious colours. */
  destructive?: boolean;
  /** Room for side-by-side fields (a disk's options, a network device). */
  wide?: boolean;
}

export function EditDialog({
  ctx,
  title,
  description,
  draft,
  children,
  onClose,
  destructive,
  wide,
}: EditDialogProps) {
  const { send, busy } = useManage(ctx.burrow, ctx.serverId);
  const formId = useId();
  const [step, setStep] = useState<'edit' | 'review'>(children ? 'edit' : 'review');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const d = draft ? trimDraft(ctx.config, { ...draft, ...(destructive ? { confirm: true } : {}) }) : null;
  const rows = d ? reviewRows(ctx.config, d) : [];
  const empty = !d || isEmptyDraft(d);

  const apply = async () => {
    if (!d || empty || busy) return;
    setError(null);
    setNotice(null);
    const params = ctx.guest.platform === 'incus' ? incusDraft(d) : d;
    const { confirm, ...rest } = params;
    const out = await send({
      op: 'config.set',
      guestId: ctx.guest.id,
      params: rest as Record<string, unknown>,
      digest: ctx.config.digest,
      ...(confirm ? { confirm: true } : {}),
      name: ctx.guest.name,
    });
    if (out.ok) return onClose();
    if (out.conflict) setNotice(out.message);
    else if (Object.keys(out.fields).length && children) {
      setErrors(out.fields);
      setStep('edit');
    } else
      setError(
        Object.keys(out.fields).length
          ? Object.entries(out.fields)
              .map(([k, v]) => `${k}: ${v}`)
              .join(' ')
          : out.message,
      );
  };

  return (
    <Modal open onOpenChange={(o) => !o && !busy && onClose()} width={wide ? 'lg' : 'md'}>
      <ModalTitle className={styles.dialogTitle}>{title}</ModalTitle>
      {description && (step === 'edit' || !children) ? (
        <ModalDescription className={styles.dialogBody}>{description}</ModalDescription>
      ) : null}
      {step === 'edit' && children ? (
        <form
          id={formId}
          className={styles.form}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (empty) return;
            setErrors({});
            setError(null);
            setNotice(null);
            setStep('review');
          }}
        >
          {children(errors)}
        </form>
      ) : (
        <div className={styles.form}>
          {notice ? (
            <div className={cx(styles.notice, styles.noticeWarn)} role="alert">
              <span>{notice}</span>
            </div>
          ) : null}
          <ReviewList
            rows={rows}
            restartNote={
              (ctx.config.platform === 'pve' || ctx.config.platform === 'libvirt') &&
              ctx.config.running &&
              !destructive
            }
            startNote={ctx.config.platform === 'libvirt'}
          />
        </div>
      )}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.dialogActions}>
        {step === 'edit' && children ? (
          <>
            {empty ? (
              <span className={cx(styles.lbl, styles.spacer)}>{draft ? 'Nothing changed yet' : ''}</span>
            ) : null}
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" form={formId} variant="primary" disabled={empty}>
              Review
            </Button>
          </>
        ) : (
          <>
            <Button disabled={busy} onClick={children ? () => setStep('edit') : onClose}>
              {children ? 'Back' : 'Cancel'}
            </Button>
            <Button
              variant="primary"
              className={destructive ? styles.seriousBtn : undefined}
              disabled={empty || busy}
              aria-busy={busy || undefined}
              onClick={() => void apply()}
            >
              {busy ? 'Applying…' : 'Apply'}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

/** The review: `key  old → new` per change; a running Proxmox guest takes some at the next restart. */
export function ReviewList({
  rows,
  restartNote,
  startNote,
}: {
  rows: readonly ReviewRow[];
  restartNote: boolean;
  /** libvirt keeps a running VM as it is until it's started again (AP-1652). */
  startNote?: boolean;
}) {
  if (!rows.length) return <p className={styles.dialogBody}>Nothing to change: it already is like this.</p>;
  return (
    <div>
      <h3 className={styles.lbl} style={{ margin: '0 0 6px' }}>
        Review the change
      </h3>
      <ul className={styles.review} aria-label="Changes">
        {rows.map((r) => (
          <li key={`${r.op}-${r.key}`}>
            <b>{r.key}</b>
            {r.op === 'delete' ? (
              <span>
                <span className={styles.old}>{shownValue(r.key, r.old)}</span> → removed
              </span>
            ) : (
              <span>
                <span className={styles.old}>{shownValue(r.key, r.old)}</span>
                {' → '}
                <span>{SECRET_KEYS.has(r.key) ? '(new value)' : shownValue(r.key, r.new)}</span>
                {r.op === 'revert' ? ' (back as it was)' : ''}
              </span>
            )}
          </li>
        ))}
      </ul>
      {restartNote ? (
        <p className={styles.dialogBody} style={{ marginTop: 10, fontSize: 13.5 }}>
          {startNote
            ? 'It’s running: what it can’t take live applies when it next starts.'
            : 'It’s running: what it can’t take live applies at the next restart.'}
        </p>
      ) : null}
    </div>
  );
}

/** Changes that wait for a restart: each now → then, Revert, and Restart now. */
export function PendingBanner({ ctx, onRestart }: { ctx: EditCtx; onRestart: () => void }) {
  const { send, busy } = useManage(ctx.burrow, ctx.serverId);
  const keys = pendingKeys(ctx.config);
  if (!keys.length) return null;
  const revert = (ks: string[]) =>
    void send(
      {
        op: 'config.set',
        guestId: ctx.guest.id,
        params: { revert: ks },
        digest: ctx.config.digest,
        name: ctx.guest.name,
      },
      { inline: false },
    );
  return (
    <section className={cx(styles.notice, styles.noticeWarn)} aria-labelledby="pending-title">
      <span className={cx(styles.noticeIcon, styles.noticeIconWarn)} aria-hidden="true">
        <Icon icon={Clock} size={16} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <b id="pending-title">
          {keys.length === 1
            ? 'A change applies at the next restart'
            : `${keys.length} changes apply at the next restart`}
        </b>
        <ul className={styles.review} aria-label="Waiting for a restart" style={{ marginTop: 6 }}>
          {keys.map((k) => {
            const removed = !(k in (ctx.config.pending ?? {}));
            return (
              <li key={k} style={{ alignItems: 'center' }}>
                <b>{k}</b>
                <span style={{ flex: 1 }}>
                  <span className={styles.old}>{shownValue(k, ctx.config.values[k])}</span> →{' '}
                  {removed ? 'removed' : shownValue(k, ctx.config.pending?.[k])}
                </span>
                <button type="button" className={styles.cardLink} disabled={busy} onClick={() => revert([k])}>
                  Revert <span className={styles.srOnly}>{k}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className={styles.noticeActs}>
          <Button size="sm" variant="primary" onClick={onRestart} disabled={busy}>
            Restart now
          </Button>
          {keys.length > 1 ? (
            <Button size="sm" onClick={() => revert(keys)} disabled={busy}>
              Revert all
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
