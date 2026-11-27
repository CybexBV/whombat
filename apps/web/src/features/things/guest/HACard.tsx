/**
 * High availability of a Proxmox guest in a cluster (ported from Rackoon's `HARow`, docs/MANAGE.md “HA”): its
 * requested state, what happens when its server fails, and Add / Change (through a review of
 * `key  old → new`) and Remove (asked first). `ha.set` / `ha.remove`; shown only on a cluster.
 */
import {
  HA_STATES,
  type HaForm,
  type HaState,
  haErrors,
  haForm,
  haParams,
  haReviewRows,
} from '@whombat/client/hosts';
import { useHostsChange } from '@whombat/client/hosts/react';
import { api } from '@whombat/core/contracts';
import { useId, useState } from 'react';
import { Button } from '../../../components/Button';
import { Modal, ModalTitle } from '../../../components/Modal';
import { useWebI18n, type WebTranslator } from '../../../i18n/provider';
import { SelectField, TextField } from '../manage/fields';
import { Card, ConfirmDialog, useChangeRunner } from '../parts';
import styles from '../Things.module.css';
import { type EditCtx, ReviewList } from './EditDialog';
import { EditBtn, useChoices } from './editParts';
import wa from './GuestEdit.module.css';

/** Each requested state's name and what it means, in the page's language. */
function haStates(t: WebTranslator['t']): readonly { value: HaState; label: string; hint: string }[] {
  const words: Record<HaState, { label: string; hint: string }> = {
    started: { label: t('ha.state.started'), hint: t('ha.state.startedHint') },
    stopped: { label: t('ha.state.stopped'), hint: t('ha.state.stoppedHint') },
    disabled: { label: t('ha.state.disabled'), hint: t('ha.state.disabledHint') },
    ignored: { label: t('ha.state.ignored'), hint: t('ha.state.ignoredHint') },
  };
  return HA_STATES.map((s) => ({ value: s.value, ...(words[s.value] ?? { label: s.label, hint: s.hint }) }));
}

function useHaChange(ctx: EditCtx) {
  const change = useHostsChange(api.hosts.manage);
  const { run, busy } = useChangeRunner();
  const send = (op: 'ha.set' | 'ha.remove', params: Record<string, unknown>, done: string) =>
    run(
      () =>
        change.mutateAsync({
          params: { burrow: ctx.burrow, serverId: ctx.serverId },
          body: { op, guestId: ctx.guest.id, params: params as never },
        }),
      done,
      { inline: true },
    );
  return { send, busy };
}

export function HACard({ ctx }: { ctx: EditCtx }) {
  const { t, tp } = useWebI18n();
  const choices = useChoices(ctx);
  const [open, setOpen] = useState<'edit' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useHaChange(ctx);
  const ha = ctx.config.ha;
  const name = ctx.guest.name;
  if (ctx.config.platform !== 'pve' || !(choices?.cluster || ha)) return null;
  return (
    <Card
      title={t('ha.title')}
      link={
        <span className={wa.waActs} style={{ marginLeft: 'auto' }}>
          <EditBtn
            label={t('ha.editLabel')}
            text={t(ha ? 'ha.change' : 'ha.setUp')}
            onClick={() => setOpen('edit')}
          />
          {ha ? (
            <EditBtn
              label={t('ha.editLabel')}
              text={t('ha.removeEllipsis')}
              serious
              onClick={() => setOpen('remove')}
            />
          ) : null}
        </span>
      }
    >
      {ha ? (
        <dl className={wa.waKv}>
          <dt>{t('ha.askedFor')}</dt>
          <dd>{haStates(t).find((s) => s.value === ha.state)?.label ?? ha.state}</dd>
          {ha.status ? (
            <>
              <dt>{t('ha.now')}</dt>
              <dd>{ha.status.charAt(0).toUpperCase() + ha.status.slice(1)}</dd>
            </>
          ) : null}
          <dt>{t('ha.whenFails')}</dt>
          <dd>
            {t('ha.thenMoves', {
              restarts: tp('ha.restarts', ha.maxRestart ?? 1),
              moves: tp('ha.moves', ha.maxRelocate ?? 1),
            })}
          </dd>
          {ha.comment ? (
            <>
              <dt>{t('ha.note')}</dt>
              <dd>{ha.comment}</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p className={styles.cardBody} style={{ margin: 0, color: 'var(--ink2)' }}>
          {t('ha.notSetUp', { name })}
        </p>
      )}
      {open === 'edit' ? <HaDialog ctx={ctx} onClose={() => setOpen(null)} /> : null}
      {open === 'remove' ? (
        <ConfirmDialog
          open
          serious
          title={t('ha.removeTitle', { name })}
          body={t('ha.removeBody')}
          confirm={t('ha.remove')}
          busy={busy}
          error={error}
          onClose={() => {
            setOpen(null);
            setError(null);
          }}
          onConfirm={() =>
            void (async () => {
              const out = await send('ha.remove', {}, t('ha.removed', { name }));
              if (out.ok) setOpen(null);
              else setError(out.message);
            })()
          }
        />
      ) : null}
    </Card>
  );
}

function HaDialog({ ctx, onClose }: { ctx: EditCtx; onClose: () => void }) {
  const { t } = useWebI18n();
  const states = haStates(t);
  const ha = ctx.config.ha;
  const name = ctx.guest.name;
  const formId = useId();
  const [f, setF] = useState<HaForm>(() => haForm(ha));
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useHaChange(ctx);
  const e = haErrors(f);
  const rows = haReviewRows(ha, f);
  const bad = !!(e.maxRestart || e.maxRelocate);
  return (
    <Modal open onOpenChange={(o) => !o && !busy && onClose()}>
      <ModalTitle className={styles.dialogTitle}>
        {t(ha ? 'ha.dialogTitle' : 'ha.dialogSetUp', { name })}
      </ModalTitle>
      {step === 'edit' ? (
        <form
          id={formId}
          className={styles.form}
          noValidate
          onSubmit={(x) => {
            x.preventDefault();
            if (!bad && rows.length) setStep('review');
          }}
        >
          <SelectField
            label={t('ha.keepIt')}
            options={states.map((s) => ({ value: s.value, label: s.label }))}
            value={f.state}
            autoFocus
            hint={states.find((s) => s.value === f.state)?.hint}
            onChange={(x) => setF({ ...f, state: x.target.value as HaForm['state'] })}
          />
          <div className={styles.formRow}>
            <TextField
              label={t('ha.restartsField')}
              inputMode="numeric"
              value={f.maxRestart}
              error={e.maxRestart}
              onChange={(x) => setF({ ...f, maxRestart: x.target.value })}
            />
            <TextField
              label={t('ha.movesField')}
              inputMode="numeric"
              value={f.maxRelocate}
              error={e.maxRelocate}
              onChange={(x) => setF({ ...f, maxRelocate: x.target.value })}
            />
          </div>
          <TextField
            label={t('ha.note')}
            value={f.comment}
            maxLength={200}
            onChange={(x) => setF({ ...f, comment: x.target.value })}
          />
        </form>
      ) : (
        <div className={styles.form}>
          <ReviewList rows={rows} restartNote={false} />
        </div>
      )}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.dialogActions}>
        {step === 'edit' ? (
          <>
            {!rows.length ? (
              <span className={`${styles.lbl} ${styles.spacer}`}>{t('ha.nothingChanged')}</span>
            ) : null}
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" form={formId} variant="primary" disabled={bad || !rows.length}>
              {t('ha.review')}
            </Button>
          </>
        ) : (
          <>
            <Button disabled={busy} onClick={() => setStep('edit')}>
              {t('common.back')}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={() =>
                void (async () => {
                  setError(null);
                  const out = await send('ha.set', haParams(f), t('ha.saved', { name }));
                  if (out.ok) onClose();
                  else setError(out.message);
                })()
              }
            >
              {t(busy ? 'ha.applying' : 'ha.apply')}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
