/**
 * High availability of a Proxmox guest in a cluster (ported from Rackoon's `HARow`, docs/MANAGE.md “HA”): its
 * requested state, what happens when its server fails, and Add / Change (through a review of
 * `key  old → new`) and Remove (asked first). `ha.set` / `ha.remove`; shown only on a cluster.
 */
import { HA_STATES, type HaForm, haErrors, haForm, haParams, haReviewRows } from '@whombat/client/hosts';
import { useHostsChange } from '@whombat/client/hosts/react';
import { api } from '@whombat/core/contracts';
import { useId, useState } from 'react';
import { Button } from '../../../components/Button';
import { Modal, ModalTitle } from '../../../components/Modal';
import { SelectField, TextField } from '../manage/fields';
import { Card, ConfirmDialog, useChangeRunner } from '../parts';
import styles from '../Things.module.css';
import { type EditCtx, ReviewList } from './EditDialog';
import { EditBtn, useChoices } from './editParts';
import wa from './GuestEdit.module.css';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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
  const choices = useChoices(ctx);
  const [open, setOpen] = useState<'edit' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useHaChange(ctx);
  const ha = ctx.config.ha;
  const name = ctx.guest.name;
  if (ctx.config.platform !== 'pve' || !(choices?.cluster || ha)) return null;
  return (
    <Card
      title="High availability"
      link={
        <span className={wa.waActs} style={{ marginLeft: 'auto' }}>
          <EditBtn
            label="high availability"
            text={ha ? 'Change…' : 'Set up…'}
            onClick={() => setOpen('edit')}
          />
          {ha ? (
            <EditBtn label="high availability" text="Remove…" serious onClick={() => setOpen('remove')} />
          ) : null}
        </span>
      }
    >
      {ha ? (
        <dl className={wa.waKv}>
          <dt>Asked for</dt>
          <dd>{HA_STATES.find((s) => s.value === ha.state)?.label ?? ha.state}</dd>
          {ha.status ? (
            <>
              <dt>Now</dt>
              <dd>{ha.status.charAt(0).toUpperCase() + ha.status.slice(1)}</dd>
            </>
          ) : null}
          <dt>When its server fails</dt>
          <dd>
            {plural(ha.maxRestart ?? 1, 'restart', 'restarts')} there, then{' '}
            {plural(ha.maxRelocate ?? 1, 'move to another server', 'moves to another server')}
          </dd>
          {ha.comment ? (
            <>
              <dt>Note</dt>
              <dd>{ha.comment}</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p className={styles.cardBody} style={{ margin: 0, color: 'var(--ink2)' }}>
          Not set up: when its server fails, {name} stays down until that server is back.
        </p>
      )}
      {open === 'edit' ? <HaDialog ctx={ctx} onClose={() => setOpen(null)} /> : null}
      {open === 'remove' ? (
        <ConfirmDialog
          open
          serious
          title={`Take ${name} out of high availability?`}
          body="It keeps running as it is; nothing restarts or moves it when its server fails."
          confirm="Remove"
          busy={busy}
          error={error}
          onClose={() => {
            setOpen(null);
            setError(null);
          }}
          onConfirm={() =>
            void (async () => {
              const out = await send('ha.remove', {}, `${name} no longer has high availability.`);
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
        {ha ? `High availability of ${name}` : `Set up high availability for ${name}`}
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
            label="Keep it"
            options={HA_STATES.map((s) => ({ value: s.value, label: s.label }))}
            value={f.state}
            autoFocus
            hint={HA_STATES.find((s) => s.value === f.state)?.hint}
            onChange={(x) => setF({ ...f, state: x.target.value as HaForm['state'] })}
          />
          <div className={styles.formRow}>
            <TextField
              label="Restarts on its server"
              inputMode="numeric"
              value={f.maxRestart}
              error={e.maxRestart}
              onChange={(x) => setF({ ...f, maxRestart: x.target.value })}
            />
            <TextField
              label="Moves to another server"
              inputMode="numeric"
              value={f.maxRelocate}
              error={e.maxRelocate}
              onChange={(x) => setF({ ...f, maxRelocate: x.target.value })}
            />
          </div>
          <TextField
            label="Note"
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
              <span className={`${styles.lbl} ${styles.spacer}`}>Nothing changed yet</span>
            ) : null}
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" form={formId} variant="primary" disabled={bad || !rows.length}>
              Review
            </Button>
          </>
        ) : (
          <>
            <Button disabled={busy} onClick={() => setStep('edit')}>
              Back
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={() =>
                void (async () => {
                  setError(null);
                  const out = await send('ha.set', haParams(f), `Saved high availability for ${name}.`);
                  if (out.ok) onClose();
                  else setError(out.message);
                })()
              }
            >
              {busy ? 'Applying…' : 'Apply'}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
