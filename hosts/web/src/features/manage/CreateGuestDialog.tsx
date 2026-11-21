// Create a guest (admins, Manage on; docs/MANAGE.md, Create): a Proxmox VM
// or container, or an Incus instance, in one dialog with sections and the
// wizard's defaults (createForm.ts). The create starts a task; the caller
// gets its id and the new guest's id (to open it when the task ends).

import { useMutation } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { type Choices, type CreateGuestInput, type ManagePlatform, type ManageResult, manageApi, useChoices } from '../../api/manage';
import { Skeleton } from '../../components/common';
import { SegmentedControl } from '../../components/controls';
import { Field, InlineError, SelectField, TextField } from '../../components/forms';
import { InlineRetry } from '../../components/InlineRetry';
import { Modal } from '../../components/Modal';
import { formatGb } from '../../lib/format';
import { t } from '../../lib/i18n';
import { announceTask } from '../guest/taskEvents';
import {
  type CtForm,
  ctDefaults,
  ctInput,
  type FormErrors,
  hasErrors,
  type IncusForm,
  incusDefaults,
  incusInput,
  NIC_MODELS,
  OS_TYPES,
  storagesWith,
  validateCt,
  validateIncus,
  validateVm,
  type VmForm,
  vmDefaults,
  vmInput,
  withOsType,
} from './createForm';
import { fieldErrors, manageErrorText } from './manageErrors';
import { StorageContentDialog } from './StorageContentDialog';

export type CreateKind = 'vm' | 'container' | 'incus';

interface Props {
  serverId: string;
  kind: CreateKind;
  onClose: () => void;
  /** The create task started: its id and the new guest's hub id. */
  onStarted: (taskId: string | null, newId: string | undefined) => void;
}

const TITLE: Record<CreateKind, () => string> = {
  vm: () => t('Create a virtual machine'),
  container: () => t('Create a container'),
  incus: () => t('Create an instance'),
};

export function CreateGuestDialog({ serverId, kind, onClose, onStarted }: Props) {
  const platform: ManagePlatform = kind === 'incus' ? 'incus' : 'pve';
  const choices = useChoices(serverId, platform);
  if (!choices.data) {
    return (
      <Modal open wide className="lc-create" onClose={onClose} title={TITLE[kind]()}>
        {choices.isError ? <InlineRetry title={t('Could not load the choices of {name}', { name: serverId })} error={choices.error} onRetry={() => void choices.refetch()} /> : <Skeleton height={320} />}
      </Modal>
    );
  }
  const props = { serverId, choices: choices.data, onClose, onStarted };
  return kind === 'vm' ? <VmCreate {...props} /> : kind === 'container' ? <CtCreate {...props} /> : <IncusCreate {...props} />;
}

interface FormProps {
  serverId: string;
  choices: Choices;
  onClose: () => void;
  onStarted: Props['onStarted'];
}

/** The create request; field errors from the platform go back to the form (keys mapped to fields). */
function useCreate(serverId: string, onDone: (r: ManageResult, name: string) => void, setErrors: (e: Record<string, string>) => void) {
  return useMutation({
    mutationFn: (input: CreateGuestInput) => manageApi.create(serverId, input),
    onSuccess: (r, input) => onDone(r, input.name ?? ''),
    onError: (err) => setErrors(fieldErrors(err)),
  });
}

function done(serverId: string, platform: ManagePlatform, props: FormProps) {
  return (r: ManageResult, name: string) => {
    let id: string | null = null;
    if (r.task?.id) {
      id = r.task.id;
      announceTask(serverId, platform, id, t('Create {name}', { name }));
    }
    props.onStarted(id, r.new_id);
    props.onClose();
  };
}

/** Platform keys of a field error -> the form field that shows it. */
function mapErrors<F>(e: Record<string, string>, map: Record<string, keyof F>): FormErrors<F> {
  const out: FormErrors<F> = {};
  for (const [k, v] of Object.entries(e)) {
    const f = map[k] ?? (map[k.replace(/\d+$/, '')] as keyof F | undefined);
    if (f) out[f] = v;
  }
  return out;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="lc-section">
      <legend className="h3">{title}</legend>
      {children}
    </fieldset>
  );
}

const gib = (mb: string) => (/^\d+$/.test(mb.trim()) ? t('= {n} GiB', { n: Math.round((Number(mb) / 1024) * 100) / 100 }) : undefined);

function storageOption(s: Choices['storages'][number]) {
  return (
    <option key={s.id} value={s.id}>
      {s.avail_bytes != null ? t('{name} · {free} free', { name: s.id, free: formatGb(s.avail_bytes / 1e9) }) : s.id}
    </option>
  );
}

function Actions({ form, busy, label, onClose }: { form: string; busy: boolean; label: string; onClose: () => void }) {
  return (
    <>
      <button type="button" className="btn-ghost" onClick={onClose}>
        {t('Cancel')}
      </button>
      <button type="submit" form={form} className="btn-primary btn-sm" disabled={busy}>
        {label}
      </button>
    </>
  );
}

// ---------------------------------------------------------------- Proxmox VM

function VmCreate(props: FormProps) {
  const { serverId, choices, onClose } = props;
  const [f, setF] = useState<VmForm>(() => vmDefaults(choices));
  const [errors, setErrors] = useState<FormErrors<VmForm>>({});
  const set = <K extends keyof VmForm>(k: K, v: VmForm[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };
  const create = useCreate(serverId, done(serverId, 'pve', props), (e) =>
    setErrors(mapErrors<VmForm>(e, { name: 'name', new_id: 'vmid', vmid: 'vmid', scsi: 'storage', ide: 'iso', net: 'bridge', memory: 'memoryMb', cores: 'cores', sockets: 'sockets', cpu: 'cpu', efidisk: 'storage', tpmstate: 'storage' })),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs = validateVm(f);
    setErrors(errs);
    if (!hasErrors(errs)) create.mutate(vmInput(f));
  };
  const disks = storagesWith(choices, 'images');

  return (
    <Modal open wide className="lc-create" onClose={onClose} busy={create.isPending} title={TITLE.vm()} actions={<Actions form="create-vm" busy={create.isPending} label={t('Create VM')} onClose={onClose} />}>
      <form id="create-vm" className="form-stack" onSubmit={submit} noValidate>
        <Section title={t('General')}>
          <div className="form-grid">
            <TextField label={t('VM ID')} mono inputMode="numeric" value={f.vmid} placeholder={t('Next free')} error={errors.vmid} onChange={(e) => set('vmid', e.target.value)} />
            <TextField label={t('Name')} mono value={f.name} autoFocus autoComplete="off" spellCheck={false} placeholder="web-03" error={errors.name} onChange={(e) => set('name', e.target.value)} />
          </div>
        </Section>
        <Section title={t('OS')}>
          <div className="form-grid">
            <SelectField label={t('ISO image')} value={f.iso} error={errors.iso} onChange={(e) => set('iso', e.target.value)}>
              <option value="">{t('No media')}</option>
              {(choices.isos ?? []).map((i) => (
                <option key={i.volume} value={i.volume}>
                  {i.name}
                </option>
              ))}
            </SelectField>
            <SelectField label={t('Guest OS')} value={f.ostype} onChange={(e) => setF((x) => withOsType(x, e.target.value))}>
              {OS_TYPES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </SelectField>
          </div>
        </Section>
        <Section title={t('Disk')}>
          <div className="form-grid">
            <SelectField label={t('Storage')} value={f.storage} error={errors.storage} onChange={(e) => set('storage', e.target.value)}>
              {!disks.length && <option value="">{t('No storage for VM disks')}</option>}
              {disks.map(storageOption)}
            </SelectField>
            <TextField label={t('Size (GiB)')} inputMode="numeric" value={f.diskGb} hint={t('SCSI disk, VirtIO SCSI single, IO thread')} error={errors.diskGb} onChange={(e) => set('diskGb', e.target.value)} />
          </div>
        </Section>
        <Section title={t('CPU and memory')}>
          <div className="form-grid">
            <TextField label={t('Cores')} inputMode="numeric" value={f.cores} error={errors.cores} onChange={(e) => set('cores', e.target.value)} />
            <TextField label={t('Sockets')} inputMode="numeric" value={f.sockets} error={errors.sockets} onChange={(e) => set('sockets', e.target.value)} />
            <SelectField label={t('CPU type')} value={f.cpu} error={errors.cpu} onChange={(e) => set('cpu', e.target.value)}>
              {[...new Set([f.cpu, ...(choices.cpu_types ?? [])])].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </SelectField>
            <TextField label={t('Memory (MiB)')} inputMode="numeric" value={f.memoryMb} hint={gib(f.memoryMb)} error={errors.memoryMb} onChange={(e) => set('memoryMb', e.target.value)} />
          </div>
        </Section>
        <Section title={t('Network')}>
          <div className="form-grid">
            <SelectField label={t('Bridge')} value={f.bridge} error={errors.bridge} onChange={(e) => set('bridge', e.target.value)}>
              {choices.bridges.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </SelectField>
            <TextField label={t('VLAN tag')} inputMode="numeric" value={f.vlan} placeholder={t('none')} error={errors.vlan} onChange={(e) => set('vlan', e.target.value)} />
            <SelectField label={t('Model')} value={f.model} onChange={(e) => set('model', e.target.value)}>
              {NIC_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m === 'virtio' ? t('VirtIO (paravirtualized)') : m}
                </option>
              ))}
            </SelectField>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={f.firewall} onChange={(e) => set('firewall', e.target.checked)} />
            {t('Firewall on this network device')}
          </label>
        </Section>
        <details className="lc-advanced">
          <summary>{t('Advanced')}</summary>
          <div className="form-stack">
            <div className="form-grid">
              <SelectField label={t('BIOS')} value={f.bios} hint={f.bios === 'ovmf' ? t('Adds an EFI disk on {storage}', { storage: f.storage }) : undefined} onChange={(e) => set('bios', e.target.value as VmForm['bios'])}>
                <option value="seabios">SeaBIOS</option>
                <option value="ovmf">{t('OVMF (UEFI)')}</option>
              </SelectField>
              <SelectField label={t('Machine')} value={f.machine} onChange={(e) => set('machine', e.target.value as VmForm['machine'])}>
                <option value="q35">q35</option>
                <option value="i440fx">i440fx</option>
              </SelectField>
            </div>
            <label className="check-row">
              <input type="checkbox" checked={f.agent} onChange={(e) => set('agent', e.target.checked)} />
              {t('QEMU guest agent (install it in the guest)')}
            </label>
            <label className="check-row">
              <input type="checkbox" checked={f.tpm} onChange={(e) => set('tpm', e.target.checked)} />
              {t('TPM 2.0 (Windows 11 needs it)')}
            </label>
          </div>
        </details>
        <label className="check-row">
          <input type="checkbox" checked={f.start} onChange={(e) => set('start', e.target.checked)} />
          {t('Start after creation')}
        </label>
        {create.isError && <InlineError>{manageErrorText(create.error, ['name', 'new_id', 'scsi0', 'ide2', 'net0', 'memory', 'cores', 'sockets', 'cpu'])}</InlineError>}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Proxmox container

function CtCreate(props: FormProps) {
  const { serverId, choices, onClose } = props;
  const [f, setF] = useState<CtForm>(() => ctDefaults(choices));
  const [errors, setErrors] = useState<FormErrors<CtForm>>({});
  const [getTemplates, setGetTemplates] = useState(false);
  const set = <K extends keyof CtForm>(k: K, v: CtForm[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };
  const create = useCreate(serverId, done(serverId, 'pve', props), (e) =>
    setErrors(mapErrors<CtForm>(e, { name: 'hostname', hostname: 'hostname', new_id: 'vmid', ostemplate: 'template', password: 'password', 'ssh-public-keys': 'sshKeys', rootfs: 'storage', memory: 'memoryMb', swap: 'swapMb', cores: 'cores', net: 'bridge', nameserver: 'nameserver', searchdomain: 'searchdomain' })),
  );
  const disks = storagesWith(choices, 'rootdir');
  const tplStorage = storagesWith(choices, 'vztmpl')[0];
  // A template downloaded meanwhile shows up when the choices reload; pick it if none was chosen.
  const template = f.template || choices.ct_templates?.[0]?.volume || '';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const form = { ...f, template };
    const errs = validateCt(form);
    setErrors(errs);
    if (!hasErrors(errs)) create.mutate(ctInput(form));
  };

  return (
    <Modal open wide className="lc-create" onClose={onClose} busy={create.isPending} title={TITLE.container()} actions={<Actions form="create-ct" busy={create.isPending} label={t('Create container')} onClose={onClose} />}>
      <form id="create-ct" className="form-stack" onSubmit={submit} noValidate>
        <Section title={t('General')}>
          <div className="form-grid">
            <TextField label={t('CT ID')} mono inputMode="numeric" value={f.vmid} placeholder={t('Next free')} error={errors.vmid} onChange={(e) => set('vmid', e.target.value)} />
            <TextField label={t('Host name')} mono value={f.hostname} autoFocus autoComplete="off" spellCheck={false} placeholder="dns-2" error={errors.hostname} onChange={(e) => set('hostname', e.target.value)} />
            <SelectField
              label={t('Template')}
              value={template}
              error={errors.template}
              hint={
                tplStorage ? (
                  <button type="button" className="btn-text lc-link" onClick={() => setGetTemplates(true)}>
                    {t('Get templates…')}
                  </button>
                ) : undefined
              }
              onChange={(e) => set('template', e.target.value)}
            >
              {!choices.ct_templates?.length && <option value="">{t('No templates on this host yet')}</option>}
              {(choices.ct_templates ?? []).map((v) => (
                <option key={v.volume} value={v.volume}>
                  {v.name}
                </option>
              ))}
            </SelectField>
            <TextField label={t('Root password')} type="password" autoComplete="new-password" value={f.password} hint={t('Optional with SSH keys')} error={errors.password} onChange={(e) => set('password', e.target.value)} />
          </div>
          <Field label={t('SSH public keys')} hint={t('One per line; they go to root’s authorized_keys.')} error={errors.sshKeys}>
            {({ id, describedBy, invalid }) => (
              <textarea id={id} className="input mono lc-keys" spellCheck={false} aria-describedby={describedBy} aria-invalid={invalid || undefined} value={f.sshKeys} onChange={(e) => set('sshKeys', e.target.value)} />
            )}
          </Field>
          <p className="lbl lc-note">{t('Unprivileged container: root inside is not root on the host.')}</p>
        </Section>
        <Section title={t('Disk')}>
          <div className="form-grid">
            <SelectField label={t('Storage')} value={f.storage} error={errors.storage} onChange={(e) => set('storage', e.target.value)}>
              {!disks.length && <option value="">{t('No storage for container volumes')}</option>}
              {disks.map(storageOption)}
            </SelectField>
            <TextField label={t('Size (GiB)')} inputMode="numeric" value={f.diskGb} error={errors.diskGb} onChange={(e) => set('diskGb', e.target.value)} />
          </div>
        </Section>
        <Section title={t('CPU and memory')}>
          <div className="form-grid">
            <TextField label={t('Cores')} inputMode="numeric" value={f.cores} error={errors.cores} onChange={(e) => set('cores', e.target.value)} />
            <TextField label={t('Memory (MiB)')} inputMode="numeric" value={f.memoryMb} hint={gib(f.memoryMb)} error={errors.memoryMb} onChange={(e) => set('memoryMb', e.target.value)} />
            <TextField label={t('Swap (MiB)')} inputMode="numeric" value={f.swapMb} error={errors.swapMb} onChange={(e) => set('swapMb', e.target.value)} />
          </div>
        </Section>
        <Section title={t('Network')}>
          <div className="form-grid">
            <SelectField label={t('Bridge')} value={f.bridge} error={errors.bridge} onChange={(e) => set('bridge', e.target.value)}>
              {choices.bridges.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </SelectField>
            <TextField label={t('VLAN tag')} inputMode="numeric" value={f.vlan} placeholder={t('none')} error={errors.vlan} onChange={(e) => set('vlan', e.target.value)} />
          </div>
          <div className="field">
            <span className="field-label">IPv4</span>
            <SegmentedControl
              label="IPv4"
              value={f.ipv4}
              onChange={(v) => set('ipv4', v)}
              options={[
                { value: 'dhcp', label: 'DHCP' },
                { value: 'static', label: t('Static') },
                { value: 'none', label: t('None') },
              ]}
            />
          </div>
          {f.ipv4 === 'static' && (
            <div className="form-grid">
              <TextField label={t('IPv4 address')} mono value={f.ip4} placeholder="10.0.0.5/24" error={errors.ip4} onChange={(e) => set('ip4', e.target.value)} />
              <TextField label={t('Gateway')} mono value={f.gw4} placeholder="10.0.0.1" error={errors.gw4} onChange={(e) => set('gw4', e.target.value)} />
            </div>
          )}
          <div className="field">
            <span className="field-label">IPv6</span>
            <SegmentedControl
              label="IPv6"
              value={f.ipv6}
              onChange={(v) => set('ipv6', v)}
              options={[
                { value: 'auto', label: 'SLAAC' },
                { value: 'dhcp', label: 'DHCP' },
                { value: 'static', label: t('Static') },
                { value: 'none', label: t('None') },
              ]}
            />
          </div>
          {f.ipv6 === 'static' && (
            <div className="form-grid">
              <TextField label={t('IPv6 address')} mono value={f.ip6} placeholder="fd00::5/64" error={errors.ip6} onChange={(e) => set('ip6', e.target.value)} />
              <TextField label={t('IPv6 gateway')} mono value={f.gw6} error={errors.gw6} onChange={(e) => set('gw6', e.target.value)} />
            </div>
          )}
          <label className="check-row">
            <input type="checkbox" checked={f.firewall} onChange={(e) => set('firewall', e.target.checked)} />
            {t('Firewall on this network device')}
          </label>
        </Section>
        <details className="lc-advanced">
          <summary>{t('Advanced')}</summary>
          <div className="form-stack">
            <div className="form-grid">
              <TextField label={t('DNS servers')} mono value={f.nameserver} placeholder={t('From the host')} error={errors.nameserver} onChange={(e) => set('nameserver', e.target.value)} />
              <TextField label={t('Search domain')} mono value={f.searchdomain} placeholder={t('From the host')} error={errors.searchdomain} onChange={(e) => set('searchdomain', e.target.value)} />
            </div>
            <label className="check-row">
              <input type="checkbox" checked={f.nesting} onChange={(e) => set('nesting', e.target.checked)} />
              {t('Nesting (systemd and containers inside need it)')}
            </label>
          </div>
        </details>
        <label className="check-row">
          <input type="checkbox" checked={f.start} onChange={(e) => set('start', e.target.checked)} />
          {t('Start after creation')}
        </label>
        {create.isError && <InlineError>{manageErrorText(create.error, ['name', 'hostname', 'new_id', 'ostemplate', 'password', 'ssh-public-keys', 'rootfs', 'memory', 'swap', 'cores', 'net0'])}</InlineError>}
      </form>
      {getTemplates && tplStorage && <StorageContentDialog serverId={serverId} storage={tplStorage} isAdmin download={!!choices.download} initial="appliances" onClose={() => setGetTemplates(false)} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- Incus instance

const REMOTE_IMAGES = ['images:debian/13', 'images:ubuntu/24.04', 'images:alpine/3.22', 'images:fedora/42', 'images:archlinux', 'images:nixos/26.05'];

function IncusCreate(props: FormProps) {
  const { serverId, choices, onClose } = props;
  const [f, setF] = useState<IncusForm>(() => incusDefaults(choices));
  const [errors, setErrors] = useState<FormErrors<IncusForm>>({});
  const set = <K extends keyof IncusForm>(k: K, v: IncusForm[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };
  const create = useCreate(serverId, done(serverId, 'incus', props), (e) =>
    setErrors(mapErrors<IncusForm>(e, { name: 'name', image: 'image', 'limits.cpu': 'cpu', 'limits.memory': 'memoryMb', 'device.root': 'rootGb' })),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs = validateIncus(f);
    setErrors(errs);
    if (!hasErrors(errs)) create.mutate(incusInput(f));
  };
  const want = f.type === 'vm' ? 'virtual-machine' : 'container';
  const local = (choices.images ?? []).filter((i) => i.type === want);

  return (
    <Modal open wide className="lc-create" onClose={onClose} busy={create.isPending} title={TITLE.incus()} actions={<Actions form="create-incus" busy={create.isPending} label={t('Create instance')} onClose={onClose} />}>
      <form id="create-incus" className="form-stack" onSubmit={submit} noValidate>
        <Section title={t('General')}>
          <div className="form-grid">
            <TextField label={t('Name')} mono value={f.name} autoFocus autoComplete="off" spellCheck={false} placeholder="web-03" error={errors.name} onChange={(e) => set('name', e.target.value)} />
            <TextField
              label={t('Image')}
              mono
              list="incus-images"
              value={f.image}
              autoComplete="off"
              spellCheck={false}
              hint={t('A local image, or images:<name> from images.linuxcontainers.org')}
              error={errors.image}
              onChange={(e) => set('image', e.target.value)}
            />
          </div>
          <datalist id="incus-images">
            {local.map((i) => (
              <option key={i.fingerprint} value={i.aliases?.[0] ?? i.fingerprint}>
                {i.description ?? i.fingerprint}
              </option>
            ))}
            {REMOTE_IMAGES.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <div className="field">
            <span className="field-label">{t('Type')}</span>
            <SegmentedControl
              label={t('Type')}
              value={f.type}
              onChange={(v) => {
                const img = (choices.images ?? []).find((i) => i.type === (v === 'vm' ? 'virtual-machine' : 'container'));
                setF((x) => ({ ...x, type: v, image: img?.aliases?.[0] ?? img?.fingerprint ?? x.image }));
              }}
              options={[
                { value: 'container', label: t('Container') },
                { value: 'vm', label: t('Virtual machine') },
              ]}
            />
          </div>
          {(choices.profiles ?? []).length > 0 && (
            <div className="field">
              <span className="field-label">{t('Profiles')}</span>
              <div className="lc-checks">
                {(choices.profiles ?? []).map((p) => (
                  <label key={p} className="check-row">
                    <input type="checkbox" checked={f.profiles.includes(p)} onChange={(e) => set('profiles', e.target.checked ? [...f.profiles, p] : f.profiles.filter((x) => x !== p))} />
                    <span className="mono">{p}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </Section>
        <Section title={t('Resources')}>
          <div className="form-grid">
            <TextField label={t('CPUs')} inputMode="numeric" value={f.cpu} placeholder={t('From the profiles')} error={errors.cpu} onChange={(e) => set('cpu', e.target.value)} />
            <TextField label={t('Memory (MiB)')} inputMode="numeric" value={f.memoryMb} placeholder={t('From the profiles')} hint={gib(f.memoryMb)} error={errors.memoryMb} onChange={(e) => set('memoryMb', e.target.value)} />
            <TextField label={t('Root disk (GiB)')} inputMode="numeric" value={f.rootGb} placeholder={t('From the profiles')} error={errors.rootGb} onChange={(e) => set('rootGb', e.target.value)} />
            <SelectField label={t('Storage pool')} value={f.pool} onChange={(e) => set('pool', e.target.value)}>
              {choices.storages.map(storageOption)}
            </SelectField>
            <SelectField label={t('Network')} value={f.network} onChange={(e) => set('network', e.target.value)}>
              <option value="">{t('From the profiles')}</option>
              {choices.bridges.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </SelectField>
          </div>
        </Section>
        <label className="check-row">
          <input type="checkbox" checked={f.start} onChange={(e) => set('start', e.target.checked)} />
          {t('Start after creation')}
        </label>
        {create.isError && <InlineError>{manageErrorText(create.error, ['name', 'image', 'limits.cpu', 'limits.memory', 'device.root'])}</InlineError>}
      </form>
    </Modal>
  );
}
