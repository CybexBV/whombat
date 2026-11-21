/**
 * A Proxmox guest's storage replication in a cluster (ported from Rackoon's `ReplicationTab`; PX-01): its jobs with
 * the node they copy to, how often, the rate limit, the last copy or its error; Add a job and Delete (asked).
 */
import { formatAgoIso, formatDayTime, replicationScheduleText } from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostGuestConfig, HostGuestDetail } from '@whombat/core/domain';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { FormDialog, SelectField, TextField } from '../manage/fields';
import { useManage } from '../manage/useManage';
import { Card, Empty, StateCell } from '../parts';
import styles from '../Things.module.css';
import wb from '../wb.module.css';
import type { EditCtx } from './EditDialog';

type Job = NonNullable<HostGuestConfig['replication']>[number];

export function ReplicationTab({
  ctx,
  guest,
  timeZone,
}: {
  ctx: EditCtx;
  guest: HostGuestDetail;
  timeZone?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Job | null>(null);
  const jobs = ctx.config.replication ?? [];
  const now = Date.now();
  return (
    <Card
      title="Replication"
      meta="Copies its disks to another node on a schedule (ZFS)"
      link={
        <Button
          size="sm"
          style={{ marginLeft: 'auto' }}
          iconStart={<Icon icon={Plus} size={14} />}
          onClick={() => setAdding(true)}
        >
          Add a job
        </Button>
      }
    >
      {jobs.length ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">To</th>
              <th scope="col">How often</th>
              <th scope="col">Rate limit</th>
              <th scope="col">Last copy</th>
              <th scope="col">
                <span className={styles.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className={j.disabled ? wb.wbOff : undefined}>
                <td className={styles.mono}>{j.id}</td>
                <td className={styles.mono}>{j.target}</td>
                <td>{replicationScheduleText(j.schedule)}</td>
                <td className={styles.muted}>{j.rate ? `${j.rate} MB/s` : 'none'}</td>
                <td className={wb.wbTd}>
                  {j.error ? (
                    <StateCell tone="bad" text={j.error} />
                  ) : j.lastSync ? (
                    <span title={formatDayTime(Date.parse(j.lastSync), timeZone)}>
                      <StateCell tone="ok" text={formatAgoIso(j.lastSync, now)} />
                    </span>
                  ) : (
                    <span className={styles.muted}>{j.disabled ? 'Switched off' : 'Not yet'}</span>
                  )}
                  {j.comment ? <span className={styles.muted}> · {j.comment}</span> : null}
                </td>
                <td>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    aria-label={`Delete replication job ${j.id}`}
                    onClick={() => setRemoving(j)}
                  >
                    <Icon icon={Trash2} size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>
          No replication jobs for {guest.name}. A job keeps a copy on another node, so it can start there if
          this one fails.
        </Empty>
      )}
      {adding ? (
        <AddJobDialog ctx={ctx} taken={jobs.map((j) => j.target)} onClose={() => setAdding(false)} />
      ) : null}
      {removing ? <DeleteJobDialog ctx={ctx} job={removing} onClose={() => setRemoving(null)} /> : null}
    </Card>
  );
}

function AddJobDialog({ ctx, taken, onClose }: { ctx: EditCtx; taken: string[]; onClose: () => void }) {
  const choices = useHostManageRead({
    params: { burrow: ctx.burrow, serverId: ctx.serverId },
    query: { op: 'choices', platform: 'pve' },
  });
  const c = choices.data?.op === 'choices' ? choices.data.choices : undefined;
  const nodes = (c?.nodes ?? []).filter((n) => !taken.includes(n));
  const [target, setTarget] = useState('');
  const [schedule, setSchedule] = useState('*/15');
  const [rate, setRate] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { send, busy } = useManage(ctx.burrow, ctx.serverId);
  const to = target || nodes[0] || '';
  const rateBad =
    rate.trim() && !/^\d+(\.\d+)?$/.test(rate.trim()) ? 'MB/s as a number, or empty for no limit.' : null;
  return (
    <FormDialog
      title={`Replicate ${ctx.guest.name}`}
      description="Its disks are copied to the other node on the schedule; only what changed goes over."
      action={busy ? 'Adding…' : 'Add job'}
      busy={busy}
      disabled={!to || !!rateBad || !schedule.trim()}
      error={error ?? (c && !nodes.length ? 'There is no other node without a job for it.' : null)}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          setFields({});
          const out = await send({
            op: 'replication.add',
            guestId: ctx.guest.id,
            params: {
              target: to,
              schedule: schedule.trim(),
              ...(rate.trim() ? { rate: rate.trim() } : {}),
              ...(comment.trim() ? { comment: comment.trim() } : {}),
            },
            name: ctx.guest.name,
            done: `${ctx.guest.name} is copied to ${to} from now on.`,
          });
          if (out.ok) onClose();
          else {
            setFields(out.fields);
            setError(Object.keys(out.fields).length ? null : out.message);
          }
        })()
      }
    >
      <SelectField
        label="To node"
        options={nodes.map((n) => ({ value: n, label: n }))}
        value={to}
        error={fields.target}
        onChange={(e) => setTarget(e.target.value)}
      />
      <div className={styles.formRow}>
        <TextField
          label="How often"
          mono
          value={schedule}
          hint="*/15 is every 15 minutes, 02:00 every day at 02:00."
          error={fields.schedule}
          onChange={(e) => setSchedule(e.target.value)}
        />
        <TextField
          label="Rate limit (MB/s)"
          inputMode="decimal"
          value={rate}
          placeholder="none"
          error={rateBad ?? fields.rate}
          onChange={(e) => setRate(e.target.value)}
        />
      </div>
      <TextField
        label="Comment"
        value={comment}
        maxLength={200}
        onChange={(e) => setComment(e.target.value)}
      />
    </FormDialog>
  );
}

function DeleteJobDialog({ ctx, job, onClose }: { ctx: EditCtx; job: Job; onClose: () => void }) {
  const { send, busy } = useManage(ctx.burrow, ctx.serverId);
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      title={`Delete replication job ${job.id}?`}
      description={`The copy on ${job.target} goes with the job.`}
      action={busy ? 'Deleting…' : 'Delete job'}
      serious
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'replication.delete',
            guestId: ctx.guest.id,
            params: { job: job.id },
            name: ctx.guest.name,
            done: `Deleted replication job ${job.id}.`,
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    />
  );
}
