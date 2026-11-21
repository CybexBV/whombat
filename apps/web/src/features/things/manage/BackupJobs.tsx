/**
 * A Proxmox server's scheduled backup jobs (PX-03, beyond Rackoon; contracts 0.81 `backupjob.*`): the list with when
 * each runs, where it saves, what it covers, what it keeps and when it runs next; New backup job and Edit (a schedule
 * from the presets or typed, a storage for backups, all guests but some, chosen guests or a pool, how, compression,
 * what to keep, notes and a comment), Pause or Resume, Run now (a task) and Delete (asked). A guest no job covers gets
 * “Add to a backup job”: a job of chosen guests takes it in, a job of all guests stops leaving it out, or a new job
 * starts for it. Only on a runtime with `hosts.backup_jobs` (an older one refuses the ops).
 */
import {
  addToBackupJobParams,
  BACKUP_SCHEDULE_PRESETS,
  backupJobCovers,
  backupJobName,
  backupKeepText,
  backupScheduleText,
  DASH,
  detailGuests,
  formatRelativeDay,
  guestKind,
  storagesFor,
} from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostBackupJob, HostGuest, HostServerDetail } from '@whombat/core/domain';
import { Ellipsis, Plus } from 'lucide-react';
import { useState } from 'react';
import { useRowMenu } from '../../../app/shell/ContextMenu';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { GuestKindIcon } from '../GuestName';
import { Card, Empty, ErrorLine, StateCell } from '../parts';
import styles from '../Things.module.css';
import wb from '../wb.module.css';
import { Check, FormDialog, SelectField, TextField } from './fields';
import { storageLabel } from './GuestDialogs';
import { useManage } from './useManage';

type Job = HostBackupJob;

export function useBackupJobs(burrow: string, serverId: string, on: boolean) {
  const q = useHostManageRead(
    on ? { params: { burrow, serverId }, query: { op: 'backupjob.list', platform: 'pve' } } : null,
  );
  return { ...q, jobs: q.data?.op === 'backupjob.list' ? q.data.items : undefined };
}

function useChoices(burrow: string, serverId: string) {
  const r = useHostManageRead({ params: { burrow, serverId }, query: { op: 'choices', platform: 'pve' } });
  return r.data?.op === 'choices' ? r.data.choices : undefined;
}

const nameOfIn = (guests: readonly HostGuest[]) => (id: string) =>
  guests.find((g) => g.id === id)?.name ?? id.replace(/^pve:/, '');

/* The list ------------------------------------------------------------------------------------------ */

export function BackupJobsCard({
  burrow,
  serverId,
  detail,
  timeZone,
}: {
  burrow: string;
  serverId: string;
  detail: HostServerDetail;
  timeZone?: string;
}) {
  const q = useBackupJobs(burrow, serverId, true);
  const { send, busy } = useManage(burrow, serverId);
  const menu = useRowMenu();
  const [dialog, setDialog] = useState<
    { kind: 'edit'; job: Job | null } | { kind: 'delete' | 'run'; job: Job } | null
  >(null);
  const guests = detailGuests(detail);
  const nameOf = nameOfIn(guests);
  const now = Date.parse(detail.asOf);
  const jobs = q.jobs ?? [];
  const pause = (job: Job) =>
    void send(
      {
        op: 'backupjob.update',
        params: { jobId: job.id, enabled: !job.enabled },
        ...(job.digest ? { digest: job.digest } : {}),
        name: backupJobName(job),
        done: job.enabled ? 'The backup plan is paused.' : 'The backup plan runs again.',
      },
      { inline: false },
    );
  return (
    <Card
      title="Backup jobs"
      meta={jobs.length ? 'Proxmox runs these on a schedule' : undefined}
      link={
        <Button
          size="sm"
          style={{ marginLeft: 'auto' }}
          iconStart={<Icon icon={Plus} size={14} />}
          onClick={() => setDialog({ kind: 'edit', job: null })}
        >
          New backup job
        </Button>
      }
    >
      {q.error ? (
        <ErrorLine error={q.error} onRetry={() => void q.refetch()} />
      ) : jobs.length ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.cellMain}>
                Job
              </th>
              <th scope="col" className={styles.dropM}>
                Saves to
              </th>
              <th scope="col" className={styles.dropS}>
                Covers
              </th>
              <th scope="col" className={styles.dropL}>
                Keeps
              </th>
              <th scope="col" className={styles.dropXs}>
                Next run
              </th>
              <th scope="col">
                <span className={styles.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const name = backupJobName(job);
              const schedule = backupScheduleText(job.schedule);
              return (
                <tr key={job.id} className={job.enabled ? undefined : wb.wbOff}>
                  <td className={cx(wb.wbTd, styles.cellMain)}>
                    <div className={wb.wbJobName}>
                      <b>{name}</b>
                      {name !== schedule ? <small>{schedule}</small> : null}
                    </div>
                  </td>
                  <td className={cx(styles.mono, styles.dropM)}>{job.storage}</td>
                  <td className={cx(wb.wbTd, styles.dropS)}>{backupJobCovers(job, nameOf)}</td>
                  <td className={cx(styles.muted, wb.wbTd, styles.dropL)}>{backupKeepText(job.keep)}</td>
                  <td className={cx(styles.num, styles.dropXs)}>
                    {!job.enabled ? (
                      <StateCell tone="mut" text="Paused" />
                    ) : job.nextRun ? (
                      formatRelativeDay(Date.parse(job.nextRun), now, timeZone)
                    ) : (
                      DASH
                    )}
                  </td>
                  <td>
                    <span className={wb.wbTools}>
                      <button
                        type="button"
                        className={styles.cardLink}
                        disabled={busy}
                        onClick={() => setDialog({ kind: 'run', job })}
                      >
                        Run now<span className={styles.srOnly}> {name}</span>
                      </button>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        aria-label={`More for ${name}`}
                        aria-haspopup="menu"
                        disabled={busy}
                        onClick={(e) =>
                          menu.openFrom(
                            e.currentTarget,
                            `job:${job.id}`,
                            name,
                            [
                              { label: 'Edit…', onSelect: () => setDialog({ kind: 'edit', job }) },
                              { label: job.enabled ? 'Pause' : 'Resume', onSelect: () => pause(job) },
                              {
                                label: 'Delete…',
                                danger: true,
                                separated: true,
                                onSelect: () => setDialog({ kind: 'delete', job }),
                              },
                            ],
                            'end',
                          )
                        }
                      >
                        <Icon icon={Ellipsis} size={15} />
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <Empty>
          {q.isLoading
            ? 'Looking…'
            : 'No backup plans: Proxmox backs nothing up on its own. Add one to back the guests up every night.'}
        </Empty>
      )}
      {menu.element}
      {dialog?.kind === 'edit' ? (
        <JobDialog
          burrow={burrow}
          serverId={serverId}
          guests={guests}
          job={dialog.job}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <DeleteJobDialog
          burrow={burrow}
          serverId={serverId}
          job={dialog.job}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </Card>
  );
}

function DeleteJobDialog({
  burrow,
  serverId,
  job,
  onClose,
}: {
  burrow: string;
  serverId: string;
  job: Job;
  onClose: () => void;
}) {
  const { send, busy } = useManage(burrow, serverId);
  const [error, setError] = useState<string | null>(null);
  const name = backupJobName(job);
  return (
    <FormDialog
      title={`Delete “${name}”?`}
      description="Proxmox stops making these backups. The backups it made stay."
      action={busy ? 'Deleting…' : 'Delete job'}
      serious
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'backupjob.delete',
            params: { jobId: job.id },
            confirm: true,
            name,
            done: 'Deleted the backup plan.',
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    />
  );
}

/* New or Edit --------------------------------------------------------------------------------------- */

const MODES = [
  { value: 'snapshot', label: 'While it runs' },
  { value: 'suspend', label: 'Paused' },
  { value: 'stop', label: 'Stopped' },
] as const;
type Mode = (typeof MODES)[number]['value'];
type Selection = Job['selection'];
type Compress = 'zstd' | 'lzo' | 'gzip' | '0';
const KEEPS = ['last', 'daily', 'weekly', 'monthly'] as const;
type KeepKey = (typeof KEEPS)[number];

export function JobDialog({
  burrow,
  serverId,
  guests,
  job,
  only,
  onClose,
}: {
  burrow: string;
  serverId: string;
  /** The server's guests, to pick from. */
  guests: readonly HostGuest[];
  /** null: a new job. */
  job: Job | null;
  /** A new job for this guest only (Add to a backup job). */
  only?: HostGuest;
  onClose: () => void;
}) {
  const choices = useChoices(burrow, serverId);
  const stores = storagesFor(choices, 'backup');
  const nodes = choices?.cluster ? [choices.node, ...(choices.nodes ?? [])].filter(Boolean) : [];
  const preset = job
    ? BACKUP_SCHEDULE_PRESETS.some((p) => p.value === job.schedule)
      ? job.schedule
      : 'custom'
    : '02:00';
  const [when, setWhen] = useState(preset);
  const [custom, setCustom] = useState(job && preset === 'custom' ? job.schedule : '');
  const [storage, setStorage] = useState(job?.storage ?? '');
  const [node, setNode] = useState(job?.node ?? '');
  const [selection, setSelection] = useState<Selection>(job?.selection ?? (only ? 'guests' : 'all'));
  const [picked, setPicked] = useState<string[]>(job?.guests ?? (only ? [only.id] : []));
  const [exclude, setExclude] = useState<string[]>(job?.exclude ?? []);
  const [pool, setPool] = useState(job?.pool ?? '');
  const [mode, setMode] = useState<Mode>(job?.mode ?? 'snapshot');
  const [compress, setCompress] = useState<Compress>(
    (['zstd', 'lzo', 'gzip', '0'] as const).find((c) => c === job?.compress) ?? 'zstd',
  );
  const [keep, setKeep] = useState<Record<KeepKey, string>>(() => ({
    last: job ? String(job.keep?.last ?? '') : '3',
    daily: job ? String(job.keep?.daily ?? '') : '7',
    weekly: job ? String(job.keep?.weekly ?? '') : '4',
    monthly: job ? String(job.keep?.monthly ?? '') : '6',
  }));
  const [notes, setNotes] = useState(job ? (job.notesTemplate ?? '') : '{{guestname}}');
  const [comment, setComment] = useState(job?.comment ?? '');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { send, busy } = useManage(burrow, serverId);

  const target = storage || (stores.find((s) => s.type === 'pbs') ?? stores[0])?.id || '';
  const pbs = stores.find((s) => s.id === target)?.type === 'pbs' || (!stores.length && target === 'pbs');
  const schedule = when === 'custom' ? custom.trim() : when;
  const keepBad = KEEPS.some((k) => keep[k].trim() && !/^\d{1,4}$/.test(keep[k].trim()));
  const keepValue = (() => {
    const out: Partial<Record<KeepKey, number>> = {};
    for (const k of KEEPS) if (keep[k].trim()) out[k] = Number(keep[k]);
    return Object.keys(out).length ? out : null;
  })();
  const missing = !schedule
    ? 'Say when it runs.'
    : !target
      ? 'Pick a storage for backups.'
      : selection === 'guests' && !picked.length
        ? 'Pick the guests it backs up.'
        : selection === 'pool' && !pool.trim()
          ? 'Name the pool.'
          : null;
  const pickable = guests.filter((g) => g.platform === 'pve');

  const params = (): Record<string, unknown> => {
    const all: Record<string, unknown> = {
      schedule,
      storage: target,
      node: node || null,
      selection,
      ...(selection === 'guests' ? { guests: picked } : {}),
      ...(selection === 'all' ? { exclude } : {}),
      pool: selection === 'pool' ? pool.trim() : null,
      mode,
      compress: pbs ? null : compress,
      keep: keepValue,
      notesTemplate: notes.trim() || null,
      comment: comment.trim() || null,
    };
    if (!job) {
      // A new job: only what is set.
      return Object.fromEntries(
        Object.entries({ enabled: true, ...all }).filter(([, v]) => v !== null && v !== undefined),
      );
    }
    const was: Record<string, unknown> = {
      schedule: job.schedule,
      storage: job.storage,
      node: job.node ?? null,
      selection: job.selection,
      guests: job.guests ?? [],
      exclude: job.exclude ?? [],
      pool: job.pool ?? null,
      mode: job.mode,
      compress: job.compress ?? null,
      keep: job.keep ?? null,
      notesTemplate: job.notesTemplate ?? null,
      comment: job.comment ?? null,
    };
    // A pool is never sent as null: the service clears it itself when the selection moves away from a pool.
    const changed = Object.entries(all).filter(
      ([k, v]) => JSON.stringify(v) !== JSON.stringify(was[k]) && !(k === 'pool' && v === null),
    );
    return { jobId: job.id, ...Object.fromEntries(changed) };
  };
  const unchanged = !!job && Object.keys(params()).length === 1;

  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((x) => x !== id);

  return (
    <FormDialog
      title={
        job ? `Edit “${backupJobName(job)}”` : only ? `A backup plan for ${only.name}` : 'New backup plan'
      }
      description={
        job ? undefined : 'Proxmox runs it on the schedule and keeps the newest backups as you say here.'
      }
      action={busy ? 'Saving…' : job ? 'Save' : 'Create job'}
      busy={busy}
      disabled={!!missing || keepBad || unchanged}
      error={error ?? (choices && !stores.length ? 'This server has no storage for backups.' : null)}
      width="lg"
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          setFields({});
          const out = await send({
            op: job ? 'backupjob.update' : 'backupjob.create',
            params: params(),
            ...(job?.digest ? { digest: job.digest } : {}),
            name: job ? backupJobName(job) : 'the backup plan',
            done: job ? 'Saved the backup plan.' : 'Created the backup plan.',
          });
          if (out.ok) onClose();
          else {
            setFields(out.fields);
            setError(out.conflict || !Object.keys(out.fields).length ? out.message : null);
          }
        })()
      }
    >
      <div className={styles.formRow}>
        <SelectField
          label="Runs"
          options={[...BACKUP_SCHEDULE_PRESETS, { value: 'custom', label: 'Custom…' }]}
          value={when}
          error={when === 'custom' ? null : fields.schedule}
          onChange={(e) => setWhen(e.target.value)}
        />
        {when === 'custom' ? (
          <TextField
            label="Schedule"
            mono
            value={custom}
            autoFocus
            placeholder="sat 03:00"
            hint="Like 02:00, sat 03:00 or mon..fri 22:00."
            error={fields.schedule}
            onChange={(e) => setCustom(e.target.value)}
          />
        ) : null}
        <SelectField
          label="Save to"
          options={stores.map((s) => ({ value: s.id, label: storageLabel(s) }))}
          value={target}
          error={fields.storage}
          onChange={(e) => setStorage(e.target.value)}
        />
        {nodes.length ? (
          <SelectField
            label="On"
            options={[
              { value: '', label: 'Every node' },
              ...nodes.map((n) => ({ value: n as string, label: n as string })),
            ]}
            value={node}
            error={fields.node}
            onChange={(e) => setNode(e.target.value)}
          />
        ) : null}
      </div>
      <div className={wb.wbRow}>
        <div className={styles.field}>
          <span>Backs up</span>
          <SegmentedControl
            options={[
              { value: 'all', label: 'All guests' },
              { value: 'guests', label: 'Chosen guests' },
              { value: 'pool', label: 'A pool' },
            ]}
            value={selection}
            onChange={setSelection}
            label="Backs up"
            variant="soft"
          />
        </div>
        <div className={styles.field}>
          <span>How</span>
          <SegmentedControl options={MODES} value={mode} onChange={setMode} label="How" variant="soft" />
        </div>
        {pbs ? null : (
          <div className={wb.wbGrow}>
            <SelectField
              label="Compression"
              options={[
                { value: 'zstd', label: 'ZSTD (fast and small)' },
                { value: 'lzo', label: 'LZO (fastest)' },
                { value: 'gzip', label: 'GZIP (smallest, slow)' },
                { value: '0', label: 'None' },
              ]}
              value={compress}
              onChange={(e) => setCompress(e.target.value as Compress)}
            />
          </div>
        )}
      </div>
      {selection === 'pool' ? (
        <TextField
          label="Pool"
          mono
          value={pool}
          hint="A resource pool in Proxmox; its guests are backed up."
          error={fields.pool}
          onChange={(e) => setPool(e.target.value)}
        />
      ) : (
        <fieldset className={wb.wbFieldset}>
          <legend>{selection === 'all' ? 'Leave out' : 'Guests'}</legend>
          <div className={wb.wbPick}>
            {pickable.length ? (
              pickable.map((g) => {
                const list = selection === 'all' ? exclude : picked;
                return (
                  <Check
                    key={g.id}
                    label={
                      <span className={styles.cellLine}>
                        <GuestKindIcon kind={guestKind(g)} />
                        <span className={styles.mono}>{g.name}</span>
                        {guestKind(g).id ? <span className={styles.gId}>{guestKind(g).id}</span> : null}
                      </span>
                    }
                    checked={list.includes(g.id)}
                    onChange={(v) =>
                      selection === 'all'
                        ? setExclude((l) => toggle(l, g.id, v))
                        : setPicked((l) => toggle(l, g.id, v))
                    }
                  />
                );
              })
            ) : (
              <span className={styles.muted}>No guests on this server.</span>
            )}
          </div>
          {fields.guests || fields.exclude ? (
            <span className={styles.fieldError}>{fields.guests ?? fields.exclude}</span>
          ) : selection === 'all' ? (
            <small>New guests are in it too, unless you leave them out.</small>
          ) : null}
        </fieldset>
      )}
      <fieldset className={wb.wbFieldset}>
        <legend>Keep</legend>
        <div className={wb.wbKeep}>
          {KEEPS.map((k) => (
            <label key={k}>
              <span>{k === 'last' ? 'The newest' : k.charAt(0).toUpperCase() + k.slice(1)}</span>
              <input
                className={styles.input}
                inputMode="numeric"
                value={keep[k]}
                placeholder="0"
                aria-invalid={keep[k].trim() && !/^\d{1,4}$/.test(keep[k].trim()) ? true : undefined}
                onChange={(e) => setKeep((o) => ({ ...o, [k]: e.target.value }))}
              />
            </label>
          ))}
        </div>
        {keepBad || fields.keep ? (
          <span className={styles.fieldError}>
            {keepBad ? 'Whole numbers, or leave a box empty.' : fields.keep}
          </span>
        ) : (
          <small>Empty everywhere: the storage decides. 0 everywhere: every backup is kept.</small>
        )}
      </fieldset>
      <div className={styles.formRow}>
        <TextField
          label="Notes on each backup"
          value={notes}
          maxLength={1000}
          hint="{{guestname}}, {{vmid}} and {{node}} are filled in."
          error={fields.notesTemplate ?? fields.notes_template}
          onChange={(e) => setNotes(e.target.value)}
        />
        <TextField
          label="Comment"
          value={comment}
          maxLength={500}
          hint="Names the job in the list."
          error={fields.comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>
      {missing && !busy ? <small className={styles.muted}>{missing}</small> : null}
    </FormDialog>
  );
}

/* Add to a backup job ------------------------------------------------------------------------------- */

export function AddToJobDialog({
  burrow,
  serverId,
  guest,
  guests,
  onClose,
}: {
  burrow: string;
  serverId: string;
  guest: HostGuest;
  /** The server's guests (a new job's list). */
  guests: readonly HostGuest[];
  onClose: () => void;
}) {
  const q = useBackupJobs(burrow, serverId, true);
  const { send, busy } = useManage(burrow, serverId);
  const [pick, setPick] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jobs = q.jobs ?? [];
  const nameOf = nameOfIn(guests);
  const usable = jobs.filter((j) => addToBackupJobParams(j, guest.id, guest.node));
  const chosen = pick || usable[0]?.id || (q.jobs ? 'new' : '');
  if (creating)
    return (
      <JobDialog
        burrow={burrow}
        serverId={serverId}
        guests={guests}
        job={null}
        only={guest}
        onClose={onClose}
      />
    );
  const job = jobs.find((j) => j.id === chosen);
  return (
    <FormDialog
      title={`Add ${guest.name} to a backup plan`}
      description="Proxmox backs it up with the job from its next run on."
      action={busy ? 'Adding…' : chosen === 'new' ? 'Set up a new job…' : 'Add to the job'}
      busy={busy}
      disabled={!chosen}
      error={error ?? (q.error ? 'The backup plans can’t be read right now.' : null)}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          if (chosen === 'new') return setCreating(true);
          const p = job ? addToBackupJobParams(job, guest.id, guest.node) : null;
          if (!job || !p) return;
          setError(null);
          const out = await send({
            op: 'backupjob.update',
            params: p,
            ...(job.digest ? { digest: job.digest } : {}),
            name: backupJobName(job),
            done: `${guest.name} is in “${backupJobName(job)}” now.`,
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    >
      <div className={wb.wbChoices} role="radiogroup" aria-label="Backup job">
        {jobs.map((j) => {
          const ok = !!addToBackupJobParams(j, guest.id, guest.node);
          return (
            <label key={j.id} className={styles.check} aria-disabled={!ok || undefined}>
              <input
                type="radio"
                name="wb-job"
                value={j.id}
                checked={chosen === j.id}
                disabled={!ok}
                onChange={() => setPick(j.id)}
              />
              <span className={wb.wbChoice}>
                <b>{backupJobName(j)}</b>
                <small>
                  {ok
                    ? `${backupJobCovers(j, nameOf)} · to ${j.storage}${j.enabled ? '' : ' · paused'}`
                    : j.selection === 'pool'
                      ? `Backs up the pool ${j.pool ?? ''}: add ${guest.name} to the pool in Proxmox.`
                      : `Runs on ${j.node} only.`}
                </small>
              </span>
            </label>
          );
        })}
        <label className={styles.check}>
          <input
            type="radio"
            name="wb-job"
            value="new"
            checked={chosen === 'new'}
            onChange={() => setPick('new')}
          />
          <span className={wb.wbChoice}>
            <b>A new job for {guest.name}</b>
            <small>Its own schedule and storage.</small>
          </span>
        </label>
      </div>
    </FormDialog>
  );
}
