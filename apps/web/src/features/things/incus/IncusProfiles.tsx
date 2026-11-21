/**
 * An Incus server's profiles (Whombat incus-unraid.md IU-04, IU-06; AP-1573), a card under its guests: each profile with
 * what it's for and how many instances use it; New profile (empty, or a copy of one), Edit (the same groups as an
 * instance's Configuration, its own `user.*` keys, its network cards and disks, the keys only Incus changes locked;
 * reviewed `key  old → new` and sent with the profile's digest) and Delete (asked; only a profile nothing uses, never
 * `default`).
 */
import {
  deviceWords,
  fieldError,
  fieldWords,
  groupFields,
  type HostIncusProfile,
  type HostIncusProfileSummary,
  INCUS_GROUP_KEYS,
  INCUS_GROUPS,
  type IncusDevice,
  incusDetail,
  incusDoneText,
  incusObjectNameError,
  incusOn,
  isRootDisk,
  type ReviewRow,
  userKeyError,
} from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostServerDetail } from '@whombat/core/domain';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { Modal, ModalDescription, ModalTitle } from '../../../components/Modal';
import { ReviewList } from '../guest/EditDialog';
import { FormDialog, Section, SelectField, TextField } from '../manage/fields';
import { useManage } from '../manage/useManage';
import { Card, Empty, ErrorLine, Skeleton } from '../parts';
import styles from '../Things.module.css';
import wi from './Incus.module.css';
import { IncusLock } from './IncusConfigTab';
import { useIncusChoices } from './IncusDialogs';
import { useIncusCanChange } from './IncusStorage';

export function IncusProfilesCard({ burrow, detail }: { burrow: string; detail: HostServerDetail }) {
  const inc = incusDetail(detail);
  const canChange = useIncusCanChange(burrow, detail);
  const [open, setOpen] = useState<
    { kind: 'new' } | { kind: 'edit' | 'delete'; p: HostIncusProfileSummary } | null
  >(null);
  if (!inc) return null;
  const serverId = detail.server.id;
  const close = () => setOpen(null);
  return (
    <Card
      title="Profiles"
      meta="Settings and devices instances share"
      link={
        canChange ? (
          <Button
            size="sm"
            style={{ marginLeft: 'auto' }}
            iconStart={<Icon icon={Plus} size={14} />}
            onClick={() => setOpen({ kind: 'new' })}
          >
            New profile
          </Button>
        ) : undefined
      }
    >
      {inc.profiles.length ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.cellMain}>
                Profile
              </th>
              <th scope="col" className={styles.dropXs}>
                Used by
              </th>
              <th scope="col">
                <span className={styles.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {inc.profiles.map((p) => (
              <tr key={`${p.project}/${p.name}`}>
                <td className={styles.cellMain}>
                  <span className={styles.mono} title={p.name}>
                    {p.name}
                  </span>
                  {p.project !== 'default' ? <span className={styles.kind}> {p.project}</span> : null}
                  {p.description ? <span className={wi.wiSub}>{p.description}</span> : null}
                </td>
                <td className={cx(styles.num, styles.dropXs)}>
                  {p.usedBy ? `${p.usedBy} ${p.usedBy === 1 ? 'instance' : 'instances'}` : 'Not used'}
                </td>
                <td>
                  {canChange ? (
                    <span className={wi.wiActs}>
                      <button
                        type="button"
                        className={styles.cardLink}
                        style={{ marginLeft: 0 }}
                        onClick={() => setOpen({ kind: 'edit', p })}
                      >
                        Edit… <span className={styles.srOnly}>{p.name}</span>
                      </button>
                      {p.usedBy === 0 && p.name !== 'default' ? (
                        <button
                          type="button"
                          className={`${styles.cardLink} ${wi.wiSerious}`}
                          style={{ marginLeft: 0 }}
                          onClick={() => setOpen({ kind: 'delete', p })}
                        >
                          Delete… <span className={styles.srOnly}>{p.name}</span>
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No profiles.</Empty>
      )}
      {open?.kind === 'new' ? (
        <NewProfileDialog burrow={burrow} serverId={serverId} profiles={inc.profiles} onClose={close} />
      ) : null}
      {open?.kind === 'edit' ? (
        <EditProfileDialog burrow={burrow} serverId={serverId} summary={open.p} onClose={close} />
      ) : null}
      {open?.kind === 'delete' ? (
        <DeleteProfileDialog burrow={burrow} serverId={serverId} p={open.p} onClose={close} />
      ) : null}
    </Card>
  );
}

interface Base {
  burrow: string;
  serverId: string;
  onClose: () => void;
}

function NewProfileDialog({
  burrow,
  serverId,
  profiles,
  onClose,
}: Base & { profiles: HostIncusProfileSummary[] }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [from, setFrom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { send, busy } = useManage(burrow, serverId);
  const bad = name.trim() ? incusObjectNameError(name) : null;
  const taken = profiles.some((p) => p.name === name.trim()) ? 'There’s a profile with that name.' : null;
  return (
    <FormDialog
      title="New profile"
      description="Instances that use it get its settings and devices. Edit it once it’s made."
      action={busy ? 'Making…' : 'Make the profile'}
      busy={busy}
      disabled={!name.trim() || !!bad || !!taken}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          setFields({});
          const out = await send({
            op: 'profile.create',
            params: {
              name: name.trim(),
              ...(description.trim() ? { description: description.trim() } : {}),
              ...(from ? { copyFrom: from } : {}),
            },
            name: name.trim(),
            done: incusDoneText('profile.create', name.trim()),
          });
          if (out.ok) onClose();
          else {
            setFields(out.fields);
            setError(Object.keys(out.fields).length ? null : out.message);
          }
        })()
      }
    >
      <TextField
        label="Name"
        mono
        value={name}
        autoFocus
        placeholder="gpu"
        error={bad ?? taken ?? fields.name}
        onChange={(e) => setName(e.target.value)}
      />
      <TextField label="What it’s for" value={description} onChange={(e) => setDescription(e.target.value)} />
      <SelectField
        label="Start from"
        options={[
          { value: '', label: 'Nothing (empty)' },
          ...profiles.map((p) => ({ value: p.name, label: `A copy of ${p.name}` })),
        ]}
        value={from}
        onChange={(e) => setFrom(e.target.value)}
      />
    </FormDialog>
  );
}

function DeleteProfileDialog({ burrow, serverId, p, onClose }: Base & { p: HostIncusProfileSummary }) {
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  return (
    <FormDialog
      title={`Delete the profile ${p.name}?`}
      description="No instance uses it; it’s removed for good."
      action={busy ? 'Deleting…' : 'Delete profile'}
      serious
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'profile.delete',
            params: { profile: p.name, ...(p.project !== 'default' ? { project: p.project } : {}) },
            confirm: true,
            name: p.name,
            done: incusDoneText('profile.delete', p.name),
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    />
  );
}

/* Edit a profile ----------------------------------------------------------------------------------------- */

function EditProfileDialog({
  burrow,
  serverId,
  summary,
  onClose,
}: Base & { summary: HostIncusProfileSummary }) {
  const q = useHostManageRead({
    params: { burrow, serverId },
    query: {
      op: 'profile.get',
      platform: 'incus',
      profile: summary.name,
      ...(summary.project !== 'default' ? { project: summary.project } : {}),
    },
  });
  const prof = q.data?.op === 'profile.get' ? q.data.profile : null;
  if (!prof)
    return (
      <Modal open onOpenChange={(o) => !o && onClose()} width="lg">
        <ModalTitle className={styles.dialogTitle}>The profile {summary.name}</ModalTitle>
        {q.error ? <ErrorLine error={q.error} onRetry={() => void q.refetch()} /> : <Skeleton height={320} />}
      </Modal>
    );
  return <ProfileForm burrow={burrow} serverId={serverId} prof={prof} onClose={onClose} />;
}

type Devices = Record<string, Record<string, string> | null>;

function ProfileForm({ burrow, serverId, prof, onClose }: Base & { prof: HostIncusProfile }) {
  const choices = useIncusChoices(burrow, serverId, prof.project);
  const [values, setValues] = useState<Record<string, string>>({ ...prof.config });
  const [description, setDescription] = useState(prof.description);
  const [devices, setDevices] = useState<Devices>({});
  const [newKey, setNewKey] = useState('user.');
  const [newValue, setNewValue] = useState('');
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  const locked = new Set(prof.restricted);
  const fields = INCUS_GROUPS.filter((g) => g.id !== 'notes').flatMap((g) => groupFields(g, 'container'));
  const errors = Object.fromEntries(
    fields
      .map((f) => [f.key, values[f.key] ? fieldError(f, values[f.key] as string) : null])
      .filter(([, e]) => e),
  ) as Record<string, string>;
  const userKeys = Object.keys(values)
    .filter((k) => k.startsWith('user.'))
    .sort();

  // What changes, as the review lists it and `profile.update` sends it.
  const set: Record<string, string> = {};
  const del: string[] = [];
  for (const [k, v] of Object.entries(values)) if (v.trim() && v.trim() !== prof.config[k]) set[k] = v.trim();
  for (const k of Object.keys(prof.config)) if (!values[k]?.trim() && !locked.has(k)) del.push(k);
  const rows: ReviewRow[] = [
    ...Object.entries(set).map(([key, v]) => ({ key, old: prof.config[key], new: v, op: 'set' as const })),
    ...del.map((key) => ({ key, old: prof.config[key], op: 'delete' as const })),
    ...Object.entries(devices).map(([name, d]) =>
      d
        ? { key: `device.${name}`, old: devString(prof.devices[name]), new: devString(d), op: 'set' as const }
        : { key: `device.${name}`, old: devString(prof.devices[name]), op: 'delete' as const },
    ),
    ...(description.trim() !== prof.description
      ? [{ key: 'description', old: prof.description, new: description.trim(), op: 'set' as const }]
      : []),
  ];
  const all: [string, Record<string, string>][] = [
    ...Object.entries(prof.devices).filter(([n]) => devices[n] !== null),
    ...Object.entries(devices).filter(
      (e): e is [string, Record<string, string>] => !!e[1] && !(e[0] in prof.devices),
    ),
  ];
  const net = choices?.bridges?.[0] ?? 'incusbr0';
  const apply = async () => {
    setError(null);
    setNotice(null);
    const out = await send({
      op: 'profile.update',
      params: {
        profile: prof.name,
        ...(prof.project !== 'default' ? { project: prof.project } : {}),
        ...(Object.keys(set).length ? { set } : {}),
        ...(del.length ? { delete: del } : {}),
        ...(Object.keys(devices).length ? { devices } : {}),
        ...(description.trim() !== prof.description ? { description: description.trim() } : {}),
      },
      digest: prof.digest,
      name: prof.name,
      done: incusDoneText('profile.update', prof.name),
    });
    if (out.ok) onClose();
    else if (out.conflict) setNotice(out.message);
    else
      setError(
        Object.keys(out.fields).length
          ? Object.entries(out.fields)
              .map(([k, v]) => `${k}: ${v}`)
              .join(' ')
          : out.message,
      );
  };
  const userErr = newKey.trim() !== 'user.' ? userKeyError(newKey) : null;
  return (
    <Modal open onOpenChange={(o) => !o && !busy && onClose()} width="lg">
      <ModalTitle className={styles.dialogTitle}>The profile {prof.name}</ModalTitle>
      {step === 'edit' ? (
        <ModalDescription className={styles.dialogBody}>
          {prof.usedBy.length
            ? `${prof.usedBy.length === 1 ? '1 instance uses' : `${prof.usedBy.length} instances use`} it: they take a change at once, unless they set their own value.`
            : 'No instance uses it yet.'}
        </ModalDescription>
      ) : null}
      {step === 'edit' ? (
        <form
          className={styles.form}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (rows.length && !Object.keys(errors).length) setStep('review');
          }}
          id="wi-profile-form"
        >
          <TextField
            label="What it’s for"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {INCUS_GROUPS.filter((g) => g.id !== 'notes').map((g) => (
            <Section key={g.id} title={g.title}>
              <div className={styles.formRow}>
                {groupFields(g, 'container').map((f) =>
                  locked.has(f.key) ? (
                    <div key={f.key} className={styles.field}>
                      <span>{f.label}</span>
                      <IncusLock />
                    </div>
                  ) : f.kind === 'bool' ? (
                    <SelectField
                      key={f.key}
                      label={f.label}
                      options={[
                        { value: '', label: 'Not set' },
                        { value: 'true', label: f.on ?? 'Yes' },
                        { value: 'false', label: f.off ?? 'No' },
                      ]}
                      value={values[f.key] ? String(incusOn(values[f.key])) : ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    />
                  ) : (
                    <TextField
                      key={f.key}
                      label={f.label}
                      mono
                      value={values[f.key] ?? ''}
                      placeholder={f.unset}
                      error={errors[f.key]}
                      hint={values[f.key] && !errors[f.key] ? fieldWords(f, values[f.key]) : f.hint}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    />
                  ),
                )}
              </div>
            </Section>
          ))}
          <Section title="Own keys (user.*)">
            {userKeys.map((k) => (
              <div
                key={k}
                className={wi.wiPreset}
                style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr) auto', alignItems: 'end' }}
              >
                <TextField label="Key" mono value={k} disabled />
                <TextField
                  label="Value"
                  mono
                  value={values[k] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
                />
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label={`Remove ${k}`}
                  onClick={() => setValues((v) => ({ ...v, [k]: '' }))}
                >
                  <Icon icon={X} size={14} />
                </button>
              </div>
            ))}
            <div
              className={wi.wiPreset}
              style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr) auto', alignItems: 'end' }}
            >
              <TextField
                label="New key"
                mono
                value={newKey}
                error={userErr}
                onChange={(e) => setNewKey(e.target.value)}
              />
              <TextField label="Value" mono value={newValue} onChange={(e) => setNewValue(e.target.value)} />
              <Button
                size="sm"
                disabled={!!userErr || newKey.trim() === 'user.' || !newValue.trim()}
                onClick={() => {
                  setValues((v) => ({ ...v, [newKey.trim()]: newValue }));
                  setNewKey('user.');
                  setNewValue('');
                }}
              >
                Add
              </Button>
            </div>
          </Section>
          <Section title="Devices">
            {all.length ? (
              <div className={styles.rows} style={{ margin: '0 -20px' }}>
                {all.map(([name, d]) => {
                  const dev: IncusDevice = {
                    name,
                    type: d.type ?? '',
                    props: d,
                    raw: devString(d) ?? '',
                    inherited: false,
                    restricted: locked.has(`device.${name}`),
                  };
                  const w = deviceWords(dev);
                  return (
                    <div key={name} className={styles.row}>
                      <span className={styles.muted} style={{ width: 130, flex: 'none' }}>
                        {w.title}
                      </span>
                      <div className={styles.rowMain}>
                        <b>{w.sub}</b>
                        <small className={wi.wiMono}>{name}</small>
                      </div>
                      {dev.restricted ? (
                        <IncusLock />
                      ) : isRootDisk(dev) ? null : (
                        <button
                          type="button"
                          className={`${styles.cardLink} ${wi.wiSerious}`}
                          style={{ marginLeft: 0 }}
                          onClick={() =>
                            setDevices((x) => {
                              const n = { ...x };
                              if (name in prof.devices) n[name] = null;
                              else delete n[name];
                              return n;
                            })
                          }
                        >
                          Remove <span className={styles.srOnly}>{name}</span>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <span className={styles.muted}>No devices.</span>
            )}
            <div>
              <Button
                size="sm"
                iconStart={<Icon icon={Plus} size={14} />}
                onClick={() => {
                  let i = 0;
                  while (`eth${i}` in prof.devices || devices[`eth${i}`]) i++;
                  setDevices((x) => ({ ...x, [`eth${i}`]: { type: 'nic', name: `eth${i}`, network: net } }));
                }}
              >
                Add a network card on {net}
              </Button>
            </div>
          </Section>
          {[...locked].filter((k) => !INCUS_GROUP_KEYS.has(k) && !k.startsWith('device.')).length ? (
            <Section title="Only with the incus command">
              {[...locked]
                .filter((k) => !INCUS_GROUP_KEYS.has(k) && !k.startsWith('device.'))
                .map((k) => (
                  <div key={k} className={styles.row} style={{ margin: '0 -20px' }}>
                    <span className={wi.wiKey}>{k}</span>
                    <span className={wi.wiRaw}>{prof.config[k]}</span>
                    <IncusLock />
                  </div>
                ))}
            </Section>
          ) : null}
        </form>
      ) : (
        <div className={styles.form}>
          {notice ? (
            <div className={`${styles.notice} ${styles.noticeWarn}`} role="alert">
              <span>{notice}</span>
            </div>
          ) : null}
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
            <Button
              type="submit"
              form="wi-profile-form"
              variant="primary"
              disabled={!rows.length || Object.keys(errors).length > 0}
            >
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

function devString(d: Record<string, string> | null | undefined): string | undefined {
  if (!d) return undefined;
  const keys = Object.keys(d)
    .filter((k) => k !== 'type')
    .sort();
  return [...(d.type ? [`type=${d.type}`] : []), ...keys.map((k) => `${k}=${d[k]}`)].join(',');
}
