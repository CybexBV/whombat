/**
 * A new Incus instance (Whombat incus-unraid.md IU-04; AP-1579), the Guests tab's New instance: the project, a container
 * or a VM, the image — this server's own first, then the common ones of images.linuxcontainers.org, or one typed — its
 * profiles, the storage pool and network, CPUs, memory and disk (left empty: the profiles decide), cloud-init user data
 * for the `/cloud` images, and Start it once it's made. The create is an Incus operation the task tracker follows; the
 * platform's field errors go back to their fields (`INCUS_NEW_ERROR_FIELDS`).
 */
import {
  CLOUD_INIT_EXAMPLE,
  hasErrors,
  INCUS_NEW_ERROR_FIELDS,
  type IncusNewErrors,
  type IncusNewForm,
  incusImageOptions,
  incusNewDefaults,
  incusNewErrors,
  incusNewParams,
  incusProjects,
  incusTaskWhat,
  memoryWords,
} from '@whombat/client/hosts';
import { useState } from 'react';
import { Modal, ModalTitle } from '../../../components/Modal';
import { SegmentedControl } from '../../../components/SegmentedControl';
import wc from '../HostFleet.module.css';
import { Check, FormDialog, Section, SelectField, TextAreaField, TextField } from '../manage/fields';
import { useManage } from '../manage/useManage';
import { Skeleton } from '../parts';
import styles from '../Things.module.css';
import wi from './Incus.module.css';
import { useIncusChoices } from './IncusDialogs';

const TYPED = '__typed__';

export function IncusCreateDialog({
  burrow,
  serverId,
  onClose,
}: {
  burrow: string;
  serverId: string;
  onClose: () => void;
}) {
  const first = useIncusChoices(burrow, serverId);
  if (!first)
    return (
      <Modal open onOpenChange={(o) => !o && onClose()} width="lg">
        <ModalTitle className={styles.dialogTitle}>New instance</ModalTitle>
        <Skeleton height={320} />
      </Modal>
    );
  return <CreateForm burrow={burrow} serverId={serverId} initial={first} onClose={onClose} />;
}

function CreateForm({
  burrow,
  serverId,
  initial,
  onClose,
}: {
  burrow: string;
  serverId: string;
  initial: NonNullable<ReturnType<typeof useIncusChoices>>;
  onClose: () => void;
}) {
  const [f, setF] = useState<IncusNewForm>(() => incusNewDefaults(initial));
  const [errors, setErrors] = useState<IncusNewErrors>({});
  const [typed, setTyped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  // Another project has its own pools, networks and profiles.
  const choices = useIncusChoices(burrow, serverId, f.project) ?? initial;
  const images = incusImageOptions(choices, f.type);
  const picked = images.find((o) => o.value === f.image);
  const cloud = typed ? /\/cloud$/.test(f.image.trim()) : !!picked?.cloud;
  const set = <K extends keyof IncusNewForm>(k: K, v: IncusNewForm[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setErrors((e) => (e[k] ? { ...e, [k]: undefined } : e));
  };
  const submit = async () => {
    const errs = incusNewErrors(f);
    setErrors(errs);
    if (hasErrors(errs)) return;
    setError(null);
    const params = incusNewParams(f, cloud);
    const out = await send({
      op: 'guest.create',
      params,
      name: params.name,
      what: incusTaskWhat('guest.create', params.name),
    });
    if (out.ok) return onClose();
    const mapped: IncusNewErrors = {};
    for (const [k, v] of Object.entries(out.fields)) {
      const field = INCUS_NEW_ERROR_FIELDS[k];
      if (field) mapped[field] = v;
    }
    setErrors(mapped);
    setError(Object.keys(mapped).length ? 'Some fields need a look.' : out.message);
  };
  const projects = incusProjects(choices);
  return (
    <FormDialog
      title="New instance"
      description={`Made on ${serverId}. What you leave empty comes from its profiles.`}
      action={busy ? 'Creating…' : 'Create instance'}
      busy={busy}
      error={error}
      onSubmit={() => void submit()}
      onClose={onClose}
      width="lg"
    >
      <Section title="General">
        <div className={styles.formRow}>
          <TextField
            label="Name"
            mono
            value={f.name}
            autoFocus
            placeholder="web-03"
            error={errors.name}
            onChange={(e) => set('name', e.target.value)}
          />
          <SelectField
            label="Project"
            options={projects.map((p) => ({ value: p, label: p }))}
            value={f.project}
            error={errors.project}
            onChange={(e) => set('project', e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <span>Type</span>
          <SegmentedControl
            options={[
              { value: 'container', label: 'Container' },
              { value: 'vm', label: 'Virtual machine' },
            ]}
            value={f.type}
            onChange={(v) => {
              const next = incusImageOptions(choices, v);
              setF((x) => ({
                ...x,
                type: v,
                image: typed
                  ? x.image
                  : (next.find((o) => o.value === x.image)?.value ?? next[0]?.value ?? x.image),
              }));
            }}
            label="Type"
            variant="soft"
          />
          <small>
            {f.type === 'container'
              ? 'Shares the server’s kernel: starts in a second and uses little memory.'
              : 'Its own kernel and firmware: for other systems, or what needs its own kernel.'}
          </small>
        </div>
      </Section>
      <Section title="Image">
        <SelectField
          label="Start from"
          options={[
            ...images.map((o) => ({ value: o.value, label: o.label, group: o.group })),
            { value: TYPED, label: 'Another image…', group: 'From images.linuxcontainers.org' },
          ]}
          value={typed ? TYPED : f.image}
          error={typed ? undefined : errors.image}
          onChange={(e) => {
            if (e.target.value === TYPED) {
              setTyped(true);
              set('image', 'images:');
            } else {
              setTyped(false);
              set('image', e.target.value);
            }
          }}
        />
        {typed ? (
          <TextField
            label="Image"
            mono
            value={f.image}
            error={errors.image}
            hint="images:<name>, like images:opensuse/tumbleweed, or an alias on this server."
            onChange={(e) => set('image', e.target.value)}
          />
        ) : null}
        {(choices.profiles ?? []).length ? (
          <div className={wc.wcChoice}>
            <span>Profiles</span>
            <div className={wi.wiImages}>
              {(choices.profiles ?? []).map((p) => (
                <Check
                  key={p}
                  label={<span className={styles.mono}>{p}</span>}
                  checked={f.profiles.includes(p)}
                  onChange={(v) =>
                    set('profiles', v ? [...f.profiles, p] : f.profiles.filter((x) => x !== p))
                  }
                />
              ))}
            </div>
          </div>
        ) : null}
      </Section>
      <Section title="Resources">
        <div className={styles.formRow} style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
          <TextField
            label="CPUs"
            inputMode="numeric"
            value={f.cpu}
            placeholder="From the profiles"
            error={errors.cpu}
            onChange={(e) => set('cpu', e.target.value)}
          />
          <TextField
            label="Memory"
            value={f.memory}
            placeholder="From the profiles"
            error={errors.memory}
            hint={f.memory.trim() && !errors.memory ? memoryWords(f.memory) : 'Like 2GiB or 512MiB.'}
            onChange={(e) => set('memory', e.target.value)}
          />
          <TextField
            label="Disk (GiB)"
            inputMode="numeric"
            value={f.diskGb}
            placeholder={f.type === 'vm' ? '10 (Incus’s)' : 'The pool’s'}
            error={errors.diskGb}
            onChange={(e) => set('diskGb', e.target.value)}
          />
        </div>
        <div className={styles.formRow}>
          <SelectField
            label="Storage pool"
            value={f.pool}
            error={errors.pool}
            options={choices.storages.map((s) => ({ value: s.id, label: s.id }))}
            onChange={(e) => set('pool', e.target.value)}
          />
          <SelectField
            label="Network"
            value={f.network}
            error={errors.network}
            options={[
              { value: '', label: 'From the profiles' },
              ...choices.bridges.map((b) => ({ value: b, label: b })),
            ]}
            onChange={(e) => set('network', e.target.value)}
          />
        </div>
      </Section>
      {cloud ? (
        <Section title="Cloud-init">
          <TextAreaField
            label="User data"
            rows={6}
            value={f.cloudInit}
            placeholder={CLOUD_INIT_EXAMPLE}
            error={errors.cloudInit}
            hint="Runs once at its first start: users, packages, files. Starts with #cloud-config."
            style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
            onChange={(e) => set('cloudInit', e.target.value)}
          />
        </Section>
      ) : null}
      <Check label="Start it once it’s made" checked={f.start} onChange={(v) => set('start', v)} />
    </FormDialog>
  );
}
