/**
 * A new guest (ported from Rackoon's `features/manage/CreateGuestDialog.tsx`; Whombat proxmox.md PX-01): a Proxmox VM
 * or container, or an Incus instance, in one dialog with sections — General, OS (or the template), Disk, CPU, Memory,
 * Network, DNS and a collapsed Advanced — and Proxmox's wizard defaults. Picking a Windows OS sets UEFI with an EFI
 * disk, q35 and a TPM. The keys it sets are `@whombat/client/hosts`' `vmCreateParams`, `ctCreateParams` and
 * `incusCreateParams`; the create runs as a task on the server.
 */
import {
  CREATE_NIC_MODELS,
  CREATE_OS_TYPES,
  CT_ERROR_FIELDS,
  type CtCreateForm,
  createFieldErrors,
  ctCreateParams,
  ctDefaults,
  ctErrors,
  type FormErrors,
  formatBytesBinary,
  gibHint,
  hasErrors,
  isWindows,
  preferredIso,
  storagesFor,
  VM_ERROR_FIELDS,
  type VmCreateForm,
  vmCreateParams,
  vmDefaults,
  vmErrors,
  volumeChoices,
  withBios,
  withOsType,
} from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostChoices } from '@whombat/core/domain';
import { type ReactNode, useState } from 'react';
import { Modal, ModalTitle } from '../../../components/Modal';
import { SegmentedControl } from '../../../components/SegmentedControl';
import wc from '../HostFleet.module.css';
import { ErrorLine, Skeleton } from '../parts';
import styles from '../Things.module.css';
import {
  Advanced,
  Check,
  FormDialog,
  Section,
  SelectField,
  type SelectOption,
  TextAreaField,
  TextField,
} from './fields';
import { StorageContentDialog } from './StorageContentDialog';
import { useManage } from './useManage';

export type CreateKind = 'vm' | 'container' | 'incus';

const TITLE: Record<CreateKind, string> = {
  vm: 'New virtual machine',
  container: 'New container',
  incus: 'New instance',
};

interface Props {
  burrow: string;
  serverId: string;
  kind: CreateKind;
  onClose: () => void;
}

export function CreateGuestDialog({ burrow, serverId, kind, onClose }: Props) {
  const platform = kind === 'incus' ? 'incus' : 'pve';
  const read = useHostManageRead({ params: { burrow, serverId }, query: { op: 'choices', platform } });
  const choices = read.data?.op === 'choices' ? read.data.choices : undefined;
  if (!choices)
    return (
      <Modal open onOpenChange={(o) => !o && onClose()} width="lg">
        <ModalTitle className={styles.dialogTitle}>{TITLE[kind]}</ModalTitle>
        {read.error ? (
          <ErrorLine error={read.error} onRetry={() => void read.refetch()} />
        ) : (
          <Skeleton height={320} />
        )}
      </Modal>
    );
  const props = { burrow, serverId, choices, onClose };
  // An Incus instance has a dialog of its own (`incus/IncusCreateDialog.tsx`, AP-1579); CreateMenu opens it.
  return kind === 'vm' ? <VmCreate {...props} /> : <CtCreate {...props} />;
}

interface FormProps {
  burrow: string;
  serverId: string;
  choices: HostChoices;
  onClose: () => void;
}

/** A form's state with its errors (a field's error clears when it changes). */
function useForm<F extends object>(initial: () => F) {
  const [f, setF] = useState<F>(initial);
  const [errors, setErrors] = useState<FormErrors<F>>({});
  const set = <K extends keyof F>(k: K, v: F[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setErrors((e) => (e[k] ? { ...e, [k]: undefined } : e));
  };
  return { f, setF, errors, setErrors, set };
}

/** Sends the create; field errors from the platform go back to their fields, the rest is said under the form. */
function useCreate<F>(burrow: string, serverId: string, map: Record<string, keyof F>, onDone: () => void) {
  const { send, busy } = useManage(burrow, serverId);
  const [error, setError] = useState<string | null>(null);
  const create = async (
    params: { name: string } & Record<string, unknown>,
    setErrors: (e: FormErrors<F>) => void,
  ) => {
    setError(null);
    const out = await send({ op: 'guest.create', params, name: params.name });
    if (out.ok) return onDone();
    const mapped = createFieldErrors<F>(out.fields, map);
    setErrors(mapped);
    setError(Object.keys(mapped).length ? 'Some fields need a look.' : out.message);
  };
  return { create, busy, error };
}

const storageOptions = (list: HostChoices['storages'], none: string): SelectOption[] =>
  list.length
    ? list.map((s) => ({
        value: s.id,
        label: s.availBytes != null ? `${s.id} · ${formatBytesBinary(s.availBytes)} free` : s.id,
      }))
    : [{ value: '', label: none }];

const bridgeOptions = (c: HostChoices): SelectOption[] =>
  c.bridges.length ? c.bridges.map((b) => ({ value: b, label: b })) : [{ value: '', label: 'None found' }];

/** Fields side by side; `cols` keeps a lone field from taking the whole width. */
function Row({ children, cols }: { children: ReactNode; cols?: number }) {
  return (
    <div
      className={styles.formRow}
      style={cols ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}
    >
      {children}
    </div>
  );
}

function Checks({ children }: { children: ReactNode }) {
  return <div className={wc.wcChecks}>{children}</div>;
}

/* Proxmox VM ------------------------------------------------------------------------------------------- */

function VmCreate({ burrow, serverId, choices, onClose }: FormProps) {
  const { f, setF, errors, setErrors, set } = useForm<VmCreateForm>(() => vmDefaults(choices));
  const { create, busy, error } = useCreate<VmCreateForm>(burrow, serverId, VM_ERROR_FIELDS, onClose);
  const disks = storagesFor(choices, 'images');
  const isos = volumeChoices(choices.isos);
  const cpus = [...new Set([f.cpu, ...(choices.cpuTypes ?? [])])];
  const submit = () => {
    const errs = vmErrors(f);
    setErrors(errs);
    if (!hasErrors(errs)) void create(vmCreateParams(f), setErrors);
  };
  return (
    <FormDialog
      title={TITLE.vm}
      description={`Made on ${serverId}. You can change everything later on its page.`}
      action={busy ? 'Creating…' : 'Create VM'}
      busy={busy}
      error={error}
      onSubmit={submit}
      onClose={onClose}
      width="lg"
    >
      <Section title="General">
        <Row>
          <TextField
            label="Name"
            mono
            value={f.name}
            autoFocus
            placeholder="web-03"
            error={errors.name}
            onChange={(e) => set('name', e.target.value)}
          />
          <TextField
            label="VM ID"
            mono
            inputMode="numeric"
            value={f.vmid}
            placeholder="Next free"
            error={errors.vmid}
            onChange={(e) => set('vmid', e.target.value)}
          />
        </Row>
      </Section>
      <Section title="OS">
        <Row>
          <SelectField
            label="Guest OS"
            value={f.ostype}
            options={CREATE_OS_TYPES.map((o) => ({ value: o.value, label: o.label }))}
            hint={isWindows(f.ostype) ? 'Set up for Windows: UEFI, q35 and a TPM.' : undefined}
            onChange={(e) => {
              const ostype = e.target.value;
              setF((x) => ({ ...withOsType(x, ostype), iso: preferredIso(isos, ostype, x.iso) }));
            }}
          />
          <SelectField
            label="Install from"
            value={f.iso}
            error={errors.iso}
            options={[
              { value: '', label: 'No ISO (an empty drive)' },
              ...isos.map((i) => ({ value: i.volume, label: i.name, group: i.storage })),
            ]}
            hint={isos.length ? undefined : 'No ISO images on this server yet.'}
            onChange={(e) => set('iso', e.target.value)}
          />
        </Row>
      </Section>
      <Section title="Disk">
        <Row>
          <SelectField
            label="Storage"
            value={f.storage}
            error={errors.storage}
            options={storageOptions(disks, 'No storage for VM disks')}
            onChange={(e) => set('storage', e.target.value)}
          />
          <TextField
            label="Size (GiB)"
            inputMode="numeric"
            value={f.diskGb}
            error={errors.diskGb}
            hint="On VirtIO SCSI, with its own IO thread."
            onChange={(e) => set('diskGb', e.target.value)}
          />
        </Row>
      </Section>
      <Section title="CPU">
        <Row>
          <TextField
            label="Cores"
            inputMode="numeric"
            value={f.cores}
            error={errors.cores}
            onChange={(e) => set('cores', e.target.value)}
          />
          <TextField
            label="Sockets"
            inputMode="numeric"
            value={f.sockets}
            error={errors.sockets}
            onChange={(e) => set('sockets', e.target.value)}
          />
          <SelectField
            label="Type"
            value={f.cpu}
            error={errors.cpu}
            options={cpus.map((c) => ({ value: c, label: c }))}
            onChange={(e) => set('cpu', e.target.value)}
          />
        </Row>
      </Section>
      <Section title="Memory">
        <Row cols={2}>
          <TextField
            label="Memory (MiB)"
            inputMode="numeric"
            value={f.memoryMb}
            error={errors.memoryMb}
            hint={gibHint(f.memoryMb)}
            onChange={(e) => set('memoryMb', e.target.value)}
          />
        </Row>
      </Section>
      <Section title="Network">
        <Row>
          <SelectField
            label="Bridge"
            value={f.bridge}
            error={errors.bridge}
            options={bridgeOptions(choices)}
            onChange={(e) => set('bridge', e.target.value)}
          />
          <TextField
            label="VLAN"
            inputMode="numeric"
            value={f.vlan}
            placeholder="None"
            error={errors.vlan}
            onChange={(e) => set('vlan', e.target.value)}
          />
          <SelectField
            label="Model"
            value={f.model}
            options={CREATE_NIC_MODELS}
            onChange={(e) => set('model', e.target.value)}
          />
        </Row>
        <Check
          label="Firewall on this network card"
          checked={f.firewall}
          onChange={(v) => set('firewall', v)}
        />
      </Section>
      <Advanced>
        <Row>
          <SelectField
            label="BIOS"
            value={f.bios}
            options={[
              { value: 'seabios', label: 'SeaBIOS' },
              { value: 'ovmf', label: 'UEFI (OVMF)' },
            ]}
            hint={f.bios === 'ovmf' ? `Adds an EFI disk on ${f.storage || 'the storage'}.` : undefined}
            onChange={(e) => setF((x) => withBios(x, e.target.value as VmCreateForm['bios']))}
          />
          <SelectField
            label="Machine"
            value={f.machine}
            options={[
              { value: 'i440fx', label: 'Default (i440fx)' },
              { value: 'q35', label: 'q35' },
            ]}
            onChange={(e) => set('machine', e.target.value as VmCreateForm['machine'])}
          />
        </Row>
        <Checks>
          <Check
            label="TPM 2.0"
            hint="Windows 11 needs it."
            checked={f.tpm}
            onChange={(v) => set('tpm', v)}
          />
          <Check
            label="QEMU guest agent"
            hint="Install it in the guest too."
            checked={f.agent}
            onChange={(v) => set('agent', v)}
          />
          <Check label="Start when the server starts" checked={f.onboot} onChange={(v) => set('onboot', v)} />
          <Check label="Start it once it’s made" checked={f.start} onChange={(v) => set('start', v)} />
        </Checks>
      </Advanced>
    </FormDialog>
  );
}

/* Proxmox container ------------------------------------------------------------------------------------ */

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className={wc.wcChoice}>
      <span aria-hidden="true">{label}</span>
      <SegmentedControl options={options} value={value} onChange={onChange} label={label} variant="soft" />
    </div>
  );
}

function CtCreate({ burrow, serverId, choices, onClose }: FormProps) {
  const { f, errors, setErrors, set } = useForm<CtCreateForm>(() => ctDefaults(choices));
  const { create, busy, error } = useCreate<CtCreateForm>(burrow, serverId, CT_ERROR_FIELDS, onClose);
  const [getTemplates, setGetTemplates] = useState(false);
  const disks = storagesFor(choices, 'rootdir');
  const tplStorage = storagesFor(choices, 'vztmpl')[0];
  const templates = volumeChoices(choices.ctTemplates);
  // A template downloaded meanwhile shows when the choices come back: it is picked if none was.
  const template = f.template || templates[0]?.volume || '';
  const submit = () => {
    const form = { ...f, template };
    const errs = ctErrors(form);
    setErrors(errs);
    if (!hasErrors(errs)) void create(ctCreateParams(form), setErrors);
  };
  return (
    <>
      <FormDialog
        title={TITLE.container}
        description={`Made on ${serverId}. You can change everything later on its page.`}
        action={busy ? 'Creating…' : 'Create container'}
        busy={busy}
        error={error}
        onSubmit={submit}
        onClose={onClose}
        width="lg"
      >
        <Section title="General">
          <Row>
            <TextField
              label="Name"
              mono
              value={f.hostname}
              autoFocus
              placeholder="dns-2"
              error={errors.hostname}
              hint="Also its host name."
              onChange={(e) => set('hostname', e.target.value)}
            />
            <TextField
              label="CT ID"
              mono
              inputMode="numeric"
              value={f.vmid}
              placeholder="Next free"
              error={errors.vmid}
              onChange={(e) => set('vmid', e.target.value)}
            />
          </Row>
        </Section>
        <Section title="Template">
          <SelectField
            label="Made from"
            value={template}
            error={errors.template}
            options={
              templates.length
                ? templates.map((t) => ({ value: t.volume, label: t.name, group: t.storage }))
                : [{ value: '', label: 'No templates on this server yet' }]
            }
            hint={
              tplStorage ? (
                <button type="button" className={wc.wcInlineLink} onClick={() => setGetTemplates(true)}>
                  Get templates…
                </button>
              ) : undefined
            }
            onChange={(e) => set('template', e.target.value)}
          />
        </Section>
        <Section title="Disk">
          <Row>
            <SelectField
              label="Storage"
              value={f.storage}
              error={errors.storage}
              options={storageOptions(disks, 'No storage for containers')}
              onChange={(e) => set('storage', e.target.value)}
            />
            <TextField
              label="Size (GiB)"
              inputMode="numeric"
              value={f.diskGb}
              error={errors.diskGb}
              onChange={(e) => set('diskGb', e.target.value)}
            />
          </Row>
        </Section>
        <Section title="CPU and memory">
          <Row>
            <TextField
              label="Cores"
              inputMode="numeric"
              value={f.cores}
              error={errors.cores}
              onChange={(e) => set('cores', e.target.value)}
            />
            <TextField
              label="Memory (MiB)"
              inputMode="numeric"
              value={f.memoryMb}
              error={errors.memoryMb}
              hint={gibHint(f.memoryMb)}
              onChange={(e) => set('memoryMb', e.target.value)}
            />
            <TextField
              label="Swap (MiB)"
              inputMode="numeric"
              value={f.swapMb}
              error={errors.swapMb}
              onChange={(e) => set('swapMb', e.target.value)}
            />
          </Row>
        </Section>
        <Section title="Network">
          <Row>
            <SelectField
              label="Bridge"
              value={f.bridge}
              error={errors.bridge}
              options={bridgeOptions(choices)}
              onChange={(e) => set('bridge', e.target.value)}
            />
            <TextField
              label="VLAN"
              inputMode="numeric"
              value={f.vlan}
              placeholder="None"
              error={errors.vlan}
              onChange={(e) => set('vlan', e.target.value)}
            />
          </Row>
          <Choice
            label="IPv4"
            value={f.ipv4}
            onChange={(v) => set('ipv4', v)}
            options={[
              { value: 'dhcp', label: 'DHCP' },
              { value: 'static', label: 'Static' },
              { value: 'none', label: 'None' },
            ]}
          />
          {f.ipv4 === 'static' ? (
            <Row>
              <TextField
                label="IPv4 address"
                mono
                value={f.ip4}
                placeholder="10.0.0.5/24"
                error={errors.ip4}
                onChange={(e) => set('ip4', e.target.value)}
              />
              <TextField
                label="Gateway"
                mono
                value={f.gw4}
                placeholder="10.0.0.1"
                error={errors.gw4}
                onChange={(e) => set('gw4', e.target.value)}
              />
            </Row>
          ) : null}
          <Choice
            label="IPv6"
            value={f.ipv6}
            onChange={(v) => set('ipv6', v)}
            options={[
              { value: 'auto', label: 'SLAAC' },
              { value: 'dhcp', label: 'DHCP' },
              { value: 'static', label: 'Static' },
              { value: 'none', label: 'None' },
            ]}
          />
          {f.ipv6 === 'static' ? (
            <Row>
              <TextField
                label="IPv6 address"
                mono
                value={f.ip6}
                placeholder="fd00::5/64"
                error={errors.ip6}
                onChange={(e) => set('ip6', e.target.value)}
              />
              <TextField
                label="IPv6 gateway"
                mono
                value={f.gw6}
                placeholder="fd00::1"
                error={errors.gw6}
                onChange={(e) => set('gw6', e.target.value)}
              />
            </Row>
          ) : null}
          <Check
            label="Firewall on this network card"
            checked={f.firewall}
            onChange={(v) => set('firewall', v)}
          />
        </Section>
        <Section title="DNS">
          <Row>
            <TextField
              label="DNS servers"
              mono
              value={f.nameserver}
              placeholder="From the server"
              error={errors.nameserver}
              onChange={(e) => set('nameserver', e.target.value)}
            />
            <TextField
              label="Search domain"
              mono
              value={f.searchdomain}
              placeholder="From the server"
              error={errors.searchdomain}
              onChange={(e) => set('searchdomain', e.target.value)}
            />
          </Row>
        </Section>
        <Advanced>
          <TextField
            label="Root password"
            type="password"
            autoComplete="new-password"
            value={f.password}
            error={errors.password}
            hint="Optional with SSH keys. Whombat doesn’t keep it."
            onChange={(e) => set('password', e.target.value)}
          />
          <TextAreaField
            label="SSH public keys"
            value={f.sshKeys}
            error={errors.sshKeys}
            placeholder="ssh-ed25519 AAAA… you@laptop"
            hint="One per line. They let you sign in as root."
            onChange={(e) => set('sshKeys', e.target.value)}
          />
          <Checks>
            <Check
              label="Nesting"
              hint="systemd and containers inside need it."
              checked={f.nesting}
              onChange={(v) => set('nesting', v)}
            />
            <Check
              label="Unprivileged"
              hint="Always: root inside isn’t root on the server."
              checked
              disabled
              onChange={() => {}}
            />
            <Check
              label="Start when the server starts"
              checked={f.onboot}
              onChange={(v) => set('onboot', v)}
            />
            <Check label="Start it once it’s made" checked={f.start} onChange={(v) => set('start', v)} />
          </Checks>
        </Advanced>
      </FormDialog>
      {getTemplates && tplStorage ? (
        <StorageContentDialog
          burrow={burrow}
          serverId={serverId}
          storage={tplStorage}
          download={!!choices.download}
          initial="appliances"
          onClose={() => setGetTemplates(false)}
        />
      ) : null}
    </>
  );
}
