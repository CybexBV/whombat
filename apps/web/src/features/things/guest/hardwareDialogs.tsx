/**
 * The Hardware tab's dialogs (ported from Rackoon's `features/guest/hardwareDialogs.tsx`): typed fields for memory,
 * processors, firmware and display, disks and their options, CD/DVD drives, the cloud-init drive, EFI disk, TPM,
 * network devices, mount points, DNS and the boot order, each sent through the review (`EditDialog`). Values are
 * changed item by item (`@whombat/client/hosts` config rules), so options without a field stay as they are. Growing and
 * moving a disk start a task on the server instead of a configuration change.
 */
import {
  attachValue,
  BUS_WORDS,
  bootOrder,
  busOf,
  busOffers,
  cdromValue,
  checkNumber,
  cloudInitDriveValue,
  cpuType,
  currentValue,
  DISK_CACHES,
  DISK_RE,
  type DiskOpts,
  diskFile,
  diskSize,
  dnsServerList,
  dnsServersError,
  domainError,
  draftOf,
  efiDiskValue,
  flagValue,
  formatBytesBinary,
  freeKey,
  getProp,
  type IpConfig,
  ipErrors,
  isCdrom,
  isOn,
  keysOf,
  mibText,
  mountPathError,
  moveBlocked,
  NET_RE,
  NEW_DISK,
  NEW_MOUNT,
  NIC_MODEL_WORDS,
  NIC_MODELS,
  type NicFields,
  newDiskValue,
  newMountValue,
  newNic,
  nicErrors,
  parseProps,
  readDiskOpts,
  readMount,
  readNic,
  storagesFor,
  tpmValue,
  VM_BUSES,
  type VmBus,
  volumeStorage,
  withBootOrder,
  withCdromFile,
  withCpuType,
  writeDiskOpts,
  writeMount,
  writeNic,
} from '@whombat/client/hosts';
import type { HostChoices } from '@whombat/core/domain';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { Check, FormDialog, SelectField, TextField } from '../manage/fields';
import { useManage } from '../manage/useManage';
import styles from '../Things.module.css';
import { type EditCtx, EditDialog } from './EditDialog';
import { BridgeSelect, IsoPicker, KeyErrors, StorageSelect } from './editParts';
import wa from './GuestEdit.module.css';

export interface DialogProps {
  ctx: EditCtx;
  onClose: () => void;
  choices?: HostChoices;
}

const nameOf = (ctx: EditCtx) => ctx.guest.name;
const hint = (label: string, more: string): ReactNode => (
  <span>
    {label} <span className={styles.muted}>· {more}</span>
  </span>
);

/* Memory and processors ----------------------------------------------------------------------------- */

export function VmMemoryDialog({ ctx, onClose }: DialogProps) {
  const cfg = ctx.config;
  const balloon0 = currentValue(cfg, 'balloon');
  const [memory, setMemory] = useState(currentValue(cfg, 'memory') ?? '512');
  const [ballooning, setBallooning] = useState(balloon0 !== '0');
  const [min, setMin] = useState(balloon0 && balloon0 !== '0' ? balloon0 : '');
  const m = checkNumber(memory, { min: 16 });
  const b = ballooning
    ? checkNumber(min, { min: 16, max: m.n ?? undefined, optional: true })
    : { n: null, error: null };
  // Shrinking on without a floor: the key goes (the floor is the memory); off: balloon=0.
  const balloon = !ballooning ? '0' : b.n == null ? undefined : String(b.n);
  return (
    <EditDialog
      ctx={ctx}
      title={`Memory of ${nameOf(ctx)}`}
      draft={
        m.error || b.error
          ? null
          : draftOf({ memory: memory.trim(), ...(balloon !== balloon0 ? { balloon } : {}) })
      }
      onClose={onClose}
    >
      {(errors) => (
        <>
          <TextField
            label="Memory (MiB)"
            inputMode="numeric"
            value={memory}
            autoFocus
            error={m.error ?? errors.memory}
            hint={m.n ? mibText(m.n) : undefined}
            onChange={(e) => setMemory(e.target.value)}
          />
          <Check
            label={hint(
              'Can shrink',
              'Proxmox takes back memory the guest doesn’t use when the server needs it',
            )}
            checked={ballooning}
            onChange={setBallooning}
          />
          {ballooning ? (
            <TextField
              label="At least (MiB)"
              inputMode="numeric"
              value={min}
              placeholder={m.n ? String(m.n) : ''}
              error={b.error ?? errors.balloon}
              hint={b.n ? mibText(b.n) : 'Empty: the same as its memory.'}
              onChange={(e) => setMin(e.target.value)}
            />
          ) : null}
        </>
      )}
    </EditDialog>
  );
}

export function CtMemoryDialog({ ctx, onClose }: DialogProps) {
  const [memory, setMemory] = useState(currentValue(ctx.config, 'memory') ?? '512');
  const [swap, setSwap] = useState(currentValue(ctx.config, 'swap') ?? '512');
  const m = checkNumber(memory, { min: 16 });
  const s = checkNumber(swap, { min: 0 });
  return (
    <EditDialog
      ctx={ctx}
      title={`Memory of ${nameOf(ctx)}`}
      draft={m.error || s.error ? null : draftOf({ memory: memory.trim(), swap: swap.trim() })}
      onClose={onClose}
    >
      {(errors) => (
        <div className={styles.formRow}>
          <TextField
            label="Memory (MiB)"
            inputMode="numeric"
            value={memory}
            autoFocus
            error={m.error ?? errors.memory}
            hint={m.n ? mibText(m.n) : undefined}
            onChange={(e) => setMemory(e.target.value)}
          />
          <TextField
            label="Swap (MiB)"
            inputMode="numeric"
            value={swap}
            error={s.error ?? errors.swap}
            hint={s.n ? mibText(s.n) : '0 turns it off.'}
            onChange={(e) => setSwap(e.target.value)}
          />
        </div>
      )}
    </EditDialog>
  );
}

export function VmCpuDialog({ ctx, choices, onClose }: DialogProps) {
  const cfg = ctx.config;
  const cpu0 = currentValue(cfg, 'cpu');
  const type0 = cpuType(cpu0);
  const numa0 = isOn(currentValue(cfg, 'numa'));
  const [sockets, setSockets] = useState(currentValue(cfg, 'sockets') ?? '1');
  const [cores, setCores] = useState(currentValue(cfg, 'cores') ?? '1');
  const [type, setType] = useState(type0);
  const [vcpus, setVcpus] = useState(currentValue(cfg, 'vcpus') ?? '');
  const [limit, setLimit] = useState(currentValue(cfg, 'cpulimit') ?? '');
  const [units, setUnits] = useState(currentValue(cfg, 'cpuunits') ?? '');
  const [numa, setNuma] = useState(numa0);
  const s = checkNumber(sockets, { min: 1, max: 4 });
  const c = checkNumber(cores, { min: 1, max: 1024 });
  const total = (s.n ?? 0) * (c.n ?? 0);
  const v = checkNumber(vcpus, { min: 1, max: total || undefined, optional: true });
  const l = checkNumber(limit, { min: 0, max: 128, optional: true, decimal: true });
  const u = checkNumber(units, { min: 1, max: 262_144, optional: true });
  const types = [...new Set([type0, ...(choices?.cpuTypes ?? [])].filter(Boolean))];
  const bad = s.error || c.error || v.error || l.error || u.error;
  return (
    <EditDialog
      ctx={ctx}
      title={`Processors of ${nameOf(ctx)}`}
      draft={
        bad
          ? null
          : draftOf({
              sockets: sockets.trim(),
              cores: cores.trim(),
              ...(type !== type0 ? { cpu: withCpuType(cpu0, type) } : {}),
              vcpus: vcpus.trim() || undefined,
              cpulimit: limit.trim() || undefined,
              cpuunits: units.trim() || undefined,
              ...(numa !== numa0 ? { numa: flagValue(numa) } : {}),
            })
      }
      onClose={onClose}
    >
      {(errors) => (
        <>
          <div className={styles.formRow}>
            <TextField
              label="Sockets"
              inputMode="numeric"
              value={sockets}
              autoFocus
              error={s.error ?? errors.sockets}
              onChange={(e) => setSockets(e.target.value)}
            />
            <TextField
              label="Cores per socket"
              inputMode="numeric"
              value={cores}
              error={c.error ?? errors.cores}
              hint={total ? `${total} ${total === 1 ? 'core' : 'cores'} in all` : undefined}
              onChange={(e) => setCores(e.target.value)}
            />
          </div>
          <SelectField
            label="Type"
            options={[{ value: '', label: 'Default (kvm64)' }, ...types.map((t) => ({ value: t, label: t }))]}
            value={type}
            error={errors.cpu}
            hint="“host” is fastest but can’t move live to a server with another CPU."
            onChange={(e) => setType(e.target.value)}
          />
          <div className={styles.formRow}>
            <TextField
              label="vCPUs"
              inputMode="numeric"
              value={vcpus}
              placeholder={total ? String(total) : ''}
              error={v.error ?? errors.vcpus}
              hint="Empty: all cores."
              onChange={(e) => setVcpus(e.target.value)}
            />
            <TextField
              label="CPU limit"
              inputMode="decimal"
              value={limit}
              placeholder="No limit"
              error={l.error ?? errors.cpulimit}
              hint="In cores, like 1.5."
              onChange={(e) => setLimit(e.target.value)}
            />
            <TextField
              label="CPU weight"
              inputMode="numeric"
              value={units}
              placeholder="100"
              error={u.error ?? errors.cpuunits}
              hint="Against other guests."
              onChange={(e) => setUnits(e.target.value)}
            />
          </div>
          <Check
            label={hint('NUMA', 'for large VMs on servers with several CPUs')}
            checked={numa}
            onChange={setNuma}
          />
          <KeyErrors errors={errors} keys={['numa']} />
        </>
      )}
    </EditDialog>
  );
}

export function CtCpuDialog({ ctx, onClose }: DialogProps) {
  const [cores, setCores] = useState(currentValue(ctx.config, 'cores') ?? '');
  const [limit, setLimit] = useState(currentValue(ctx.config, 'cpulimit') ?? '');
  const [units, setUnits] = useState(currentValue(ctx.config, 'cpuunits') ?? '');
  const c = checkNumber(cores, { min: 1, max: 8192, optional: true });
  const l = checkNumber(limit, { min: 0, max: 8192, optional: true, decimal: true });
  const u = checkNumber(units, { min: 0, max: 500_000, optional: true });
  return (
    <EditDialog
      ctx={ctx}
      title={`Processors of ${nameOf(ctx)}`}
      draft={
        c.error || l.error || u.error
          ? null
          : draftOf({
              cores: cores.trim() || undefined,
              cpulimit: limit.trim() || undefined,
              cpuunits: units.trim() || undefined,
            })
      }
      onClose={onClose}
    >
      {(errors) => (
        <div className={styles.formRow}>
          <TextField
            label="Cores"
            inputMode="numeric"
            value={cores}
            autoFocus
            placeholder="All"
            error={c.error ?? errors.cores}
            hint="Empty: all the server’s cores."
            onChange={(e) => setCores(e.target.value)}
          />
          <TextField
            label="CPU limit"
            inputMode="decimal"
            value={limit}
            placeholder="No limit"
            error={l.error ?? errors.cpulimit}
            hint="In cores, like 1.5."
            onChange={(e) => setLimit(e.target.value)}
          />
          <TextField
            label="CPU weight"
            inputMode="numeric"
            value={units}
            placeholder="100"
            error={u.error ?? errors.cpuunits}
            hint="Against other guests."
            onChange={(e) => setUnits(e.target.value)}
          />
        </div>
      )}
    </EditDialog>
  );
}

/** One key from a list (BIOS, display, machine, SCSI controller); `read` / `write` map the value and the option. */
export function SelectKeyDialog({
  ctx,
  onClose,
  k,
  title,
  label,
  options,
  read,
  write,
  hint: hintOf,
}: DialogProps & {
  k: string;
  title: string;
  label: string;
  options: readonly { value: string; label: string }[];
  read?: (cur: string | undefined) => string;
  /** The value to store (undefined removes the key; default: the first option is “not set”). */
  write?: (v: string, cur: string | undefined) => string | undefined;
  hint?: (v: string) => ReactNode;
}) {
  const cur = currentValue(ctx.config, k);
  const initial = read ? read(cur) : (cur ?? options[0]?.value ?? '');
  const [v, setV] = useState(initial);
  const all = options.some((o) => o.value === initial)
    ? options
    : [{ value: initial, label: initial }, ...options];
  return (
    <EditDialog
      ctx={ctx}
      title={title}
      draft={
        v === initial ? {} : draftOf({ [k]: write ? write(v, cur) : v === options[0]?.value ? undefined : v })
      }
      onClose={onClose}
    >
      {(errors) => (
        <SelectField
          label={label}
          options={all}
          value={v}
          autoFocus
          error={errors[k]}
          hint={hintOf?.(v)}
          onChange={(e) => setV(e.target.value)}
        />
      )}
    </EditDialog>
  );
}

/* Disks --------------------------------------------------------------------------------------------- */

function DiskOptFields({ o, set, bus }: { o: DiskOpts; set: (o: DiskOpts) => void; bus: string }) {
  const offers = busOffers(bus);
  return (
    <>
      <SelectField
        label="Cache"
        options={DISK_CACHES}
        value={o.cache}
        onChange={(e) => set({ ...o, cache: e.target.value })}
      />
      <div className={wa.waChecks}>
        <Check
          label={hint('Discard', 'frees space on thin storage')}
          checked={o.discard}
          onChange={(discard) => set({ ...o, discard })}
        />
        {offers.iothread ? (
          <Check label="IO thread" checked={o.iothread} onChange={(iothread) => set({ ...o, iothread })} />
        ) : null}
        {offers.ssd ? (
          <Check label="Show it as an SSD" checked={o.ssd} onChange={(ssd) => set({ ...o, ssd })} />
        ) : null}
        <Check label="Include in backups" checked={o.backup} onChange={(backup) => set({ ...o, backup })} />
        <Check
          label="Include in replication"
          checked={o.replicate}
          onChange={(replicate) => set({ ...o, replicate })}
        />
      </div>
    </>
  );
}

function BusSelect({
  value,
  onChange,
  buses = Object.keys(VM_BUSES) as VmBus[],
  slot,
}: {
  value: VmBus;
  onChange: (b: VmBus) => void;
  buses?: VmBus[];
  slot: string | null;
}) {
  return (
    <SelectField
      label="Bus"
      options={buses.map((b) => ({ value: b, label: BUS_WORDS[b] }))}
      value={value}
      error={slot ? null : 'This bus is full.'}
      hint={slot ? `Attached as ${slot}` : undefined}
      onChange={(e) => onChange(e.target.value as VmBus)}
    />
  );
}

export function AddDiskDialog({ ctx, choices, onClose }: DialogProps) {
  const [bus, setBus] = useState<VmBus>('scsi');
  const [storage, setStorage] = useState('');
  const [size, setSize] = useState('32');
  const [o, setO] = useState<DiskOpts>(NEW_DISK);
  const key = freeKey(ctx.config, bus, VM_BUSES[bus]);
  const st = storage || storagesFor(choices, 'images')[0]?.id || '';
  const sz = checkNumber(size, { min: 1, max: 131_072, decimal: true });
  return (
    <EditDialog
      ctx={ctx}
      title={`Add a hard disk to ${nameOf(ctx)}`}
      draft={!key || !st || sz.error ? null : draftOf({ [key]: newDiskValue(st, size, bus, o) })}
      onClose={onClose}
      wide
    >
      {(errors) => (
        <>
          <div className={styles.formRow}>
            <BusSelect value={bus} onChange={setBus} slot={key} />
            <TextField
              label="Size (GiB)"
              inputMode="decimal"
              value={size}
              autoFocus
              error={sz.error}
              onChange={(e) => setSize(e.target.value)}
            />
          </div>
          <StorageSelect choices={choices} content="images" value={st} onChange={setStorage} />
          <DiskOptFields o={o} set={setO} bus={bus} />
          {key ? <KeyErrors errors={errors} keys={[key]} /> : null}
        </>
      )}
    </EditDialog>
  );
}

export function DiskOptionsDialog({ ctx, k, onClose }: DialogProps & { k: string }) {
  const v = currentValue(ctx.config, k) ?? '';
  const [was] = useState(() => readDiskOpts(v));
  const [o, setO] = useState(was);
  return (
    <EditDialog
      ctx={ctx}
      title={`Options of ${k}`}
      description={<span className={styles.mono}>{diskFile(v)}</span>}
      draft={draftOf({ [k]: writeDiskOpts(v, o, was) })}
      onClose={onClose}
      wide
    >
      {(errors) => (
        <>
          <DiskOptFields o={o} set={setO} bus={busOf(k)} />
          <KeyErrors errors={errors} keys={[k]} />
        </>
      )}
    </EditDialog>
  );
}

/** Grow a disk (a VM's, a container's root disk or mount point) by whole GiB: a task on the server. */
export function ResizeDialog({ ctx, k, onClose }: DialogProps & { k: string }) {
  const [add, setAdd] = useState('8');
  const [error, setError] = useState<string | null>(null);
  const a = checkNumber(add, { min: 1, max: 65_536 });
  const { send, busy } = useManage(ctx.burrow, ctx.serverId);
  const now = diskSize(currentValue(ctx.config, k));
  return (
    <FormDialog
      title={`Grow ${k} of ${nameOf(ctx)}`}
      description={`Disks only grow. ${now != null ? `It’s ${formatBytesBinary(now)} now; ` : ''}the space inside grows when the guest’s system extends its partition.`}
      action={busy ? 'Growing…' : 'Grow'}
      busy={busy}
      disabled={!!a.error}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          const out = await send({
            op: 'disk.resize',
            guestId: ctx.guest.id,
            params: { disk: k, size: `+${add.trim()}G` },
            name: nameOf(ctx),
          });
          if (out.ok) onClose();
          else setError(out.fields.size ?? out.message);
        })()
      }
    >
      <TextField
        label="Add (GiB)"
        inputMode="numeric"
        value={add}
        autoFocus
        error={a.error}
        hint={
          now != null && a.n
            ? `${formatBytesBinary(now)} → ${formatBytesBinary(now + a.n * 1024 ** 3)}`
            : undefined
        }
        onChange={(e) => setAdd(e.target.value)}
      />
    </FormDialog>
  );
}

/** Move a disk to another storage of the server: a task. The old copy stays as an unused disk unless removed. */
export function MoveDialog({ ctx, choices, k, onClose }: DialogProps & { k: string }) {
  const vm = ctx.config.kind === 'vm';
  const from = volumeStorage(diskFile(currentValue(ctx.config, k)));
  const targets = storagesFor(choices, vm ? 'images' : 'rootdir').filter((s) => s.id !== from);
  const blocked = moveBlocked(ctx.config, k);
  const [storage, setStorage] = useState('');
  const [remove, setRemove] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(ctx.burrow, ctx.serverId);
  const to = storage || targets[0]?.id || '';
  return (
    <FormDialog
      title={`Move ${k} of ${nameOf(ctx)}`}
      description={blocked ?? `From ${from || 'its storage'} to another storage on this server.`}
      action={busy ? 'Starting…' : 'Move'}
      busy={busy}
      disabled={!to || !!blocked}
      error={
        error ??
        (choices && !blocked && !targets.length ? 'There’s no other storage for it on this server.' : null)
      }
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          const out = await send({
            op: 'disk.move',
            guestId: ctx.guest.id,
            params: { disk: k, storage: to, deleteSource: remove },
            confirm: remove,
            name: nameOf(ctx),
          });
          if (out.ok) onClose();
          else setError(out.fields.storage ?? out.message);
        })()
      }
    >
      {blocked ? null : (
        <>
          <StorageSelect
            choices={choices}
            content={vm ? 'images' : 'rootdir'}
            value={to}
            label="To"
            exclude={from}
            onChange={setStorage}
          />
          <Check
            label={hint('Remove the old copy afterwards', 'otherwise it stays as an unused disk')}
            checked={remove}
            onChange={setRemove}
          />
        </>
      )}
    </FormDialog>
  );
}

/** Detach, remove or delete one key: no fields, the dialog opens at its review. */
export function RemoveDialog({
  ctx,
  k,
  title,
  description,
  destructive,
  onClose,
}: DialogProps & { k: string; title: string; description: ReactNode; destructive?: boolean }) {
  return (
    <EditDialog
      ctx={ctx}
      title={title}
      description={description}
      draft={{ delete: [k] }}
      destructive={destructive}
      onClose={onClose}
    />
  );
}

/** An unused disk attached again: on a bus (VMs) or at a folder (containers). */
export function AttachDialog({ ctx, k, onClose }: DialogProps & { k: string }) {
  const vm = ctx.config.kind === 'vm';
  const [bus, setBus] = useState<VmBus>('scsi');
  const [path, setPath] = useState('/mnt/data');
  const key = vm ? freeKey(ctx.config, bus, VM_BUSES[bus]) : freeKey(ctx.config, 'mp', 256);
  const vol = attachValue(currentValue(ctx.config, k));
  const pathError = vm ? null : mountPathError(path);
  return (
    <EditDialog
      ctx={ctx}
      title={`Attach ${k} to ${nameOf(ctx)}`}
      description={<span className={styles.mono}>{vol}</span>}
      draft={!key || pathError ? null : draftOf({ [key]: vm ? vol : `${vol},mp=${path.trim()}` })}
      onClose={onClose}
    >
      {(errors) => (
        <>
          {vm ? (
            <BusSelect value={bus} onChange={setBus} slot={key} />
          ) : (
            <TextField
              label="Folder in the container"
              mono
              value={path}
              autoFocus
              error={pathError ?? (key ? errors[key] : null)}
              hint={key ? `Attached as ${key}` : undefined}
              onChange={(e) => setPath(e.target.value)}
            />
          )}
          {vm && key ? <KeyErrors errors={errors} keys={[key]} /> : null}
        </>
      )}
    </EditDialog>
  );
}

/* CD/DVD, cloud-init drive, EFI disk, TPM ------------------------------------------------------------ */

export function CdromDialog({ ctx, choices, k, onClose }: DialogProps & { k?: string }) {
  const [bus, setBus] = useState<VmBus>('ide');
  const key = k ?? freeKey(ctx.config, bus, VM_BUSES[bus]);
  const v = k ? (currentValue(ctx.config, k) ?? '') : '';
  const [file, setFile] = useState(k ? diskFile(v) || 'none' : 'none');
  return (
    <EditDialog
      ctx={ctx}
      title={k ? `CD/DVD drive ${k} of ${nameOf(ctx)}` : `Add a CD/DVD drive to ${nameOf(ctx)}`}
      draft={!key ? null : draftOf({ [key]: k ? withCdromFile(v, file) : cdromValue(file) })}
      onClose={onClose}
    >
      {(errors) => (
        <>
          {k ? null : <BusSelect value={bus} onChange={setBus} buses={['ide', 'sata', 'scsi']} slot={key} />}
          <IsoPicker ctx={ctx} choices={choices} value={file} onChange={setFile} />
          {key ? <KeyErrors errors={errors} keys={[key]} /> : null}
        </>
      )}
    </EditDialog>
  );
}

/** A cloud-init drive on the first free IDE (else SATA) slot; Proxmox makes its volume. */
export function CloudInitDriveDialog({ ctx, choices, onClose }: DialogProps) {
  const [storage, setStorage] = useState('');
  const st = storage || storagesFor(choices, 'images')[0]?.id || '';
  const slot = freeKey(ctx.config, 'ide', VM_BUSES.ide) ?? freeKey(ctx.config, 'sata', VM_BUSES.sata);
  return (
    <EditDialog
      ctx={ctx}
      title={`Add a Cloud-Init drive to ${nameOf(ctx)}`}
      description="Proxmox writes the user, SSH keys and addresses from the Cloud-Init tab to it; the guest reads them when it starts."
      draft={st && slot ? draftOf({ [slot]: cloudInitDriveValue(st) }) : null}
      onClose={onClose}
    >
      {(errors) => (
        <>
          <StorageSelect
            choices={choices}
            content="images"
            value={st}
            error={slot ? null : 'Every IDE and SATA slot is taken.'}
            onChange={setStorage}
          />
          {slot ? <KeyErrors errors={errors} keys={[slot]} /> : null}
        </>
      )}
    </EditDialog>
  );
}

export function EfiDiskDialog({ ctx, choices, onClose }: DialogProps) {
  const [storage, setStorage] = useState('');
  const [keys, setKeys] = useState(true);
  const st = storage || storagesFor(choices, 'images')[0]?.id || '';
  const ovmf = currentValue(ctx.config, 'bios') === 'ovmf';
  return (
    <EditDialog
      ctx={ctx}
      title={`Add an EFI disk to ${nameOf(ctx)}`}
      description={`Keeps the UEFI settings (boot entries, Secure Boot keys).${ovmf ? '' : ' It’s used only with OVMF (UEFI) firmware: change the BIOS too.'}`}
      draft={st ? draftOf({ efidisk0: efiDiskValue(st, keys) }) : null}
      onClose={onClose}
    >
      {(errors) => (
        <>
          <StorageSelect choices={choices} content="images" value={st} onChange={setStorage} />
          <Check
            label={hint('Enroll Secure Boot keys', 'Microsoft’s, as Windows expects')}
            checked={keys}
            onChange={setKeys}
          />
          <KeyErrors errors={errors} keys={['efidisk0']} />
        </>
      )}
    </EditDialog>
  );
}

export function TpmDialog({ ctx, choices, onClose }: DialogProps) {
  const [storage, setStorage] = useState('');
  const [version, setVersion] = useState('v2.0');
  const st = storage || storagesFor(choices, 'images')[0]?.id || '';
  return (
    <EditDialog
      ctx={ctx}
      title={`Add a TPM to ${nameOf(ctx)}`}
      description="A virtual security chip. Windows 11 needs version 2.0."
      draft={st ? draftOf({ tpmstate0: tpmValue(st, version) }) : null}
      onClose={onClose}
    >
      {(errors) => (
        <>
          <StorageSelect choices={choices} content="images" value={st} onChange={setStorage} />
          <SelectField
            label="Version"
            options={[
              { value: 'v2.0', label: '2.0' },
              { value: 'v1.2', label: '1.2' },
            ]}
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          />
          <KeyErrors errors={errors} keys={['tpmstate0']} />
        </>
      )}
    </EditDialog>
  );
}

/* Network devices ----------------------------------------------------------------------------------- */

/** IPv4 and IPv6 of a container's network device or a cloud-init config, each checked. */
export function IpFields({
  c,
  set,
  errorFor,
}: {
  c: IpConfig;
  set: (c: IpConfig) => void;
  /** The server's error for the whole value. */
  errorFor?: string;
}) {
  const e = ipErrors(c);
  return (
    <>
      <div className={styles.formRow}>
        <SelectField
          label="IPv4"
          options={[
            { value: 'dhcp', label: 'Automatic (DHCP)' },
            { value: 'static', label: 'Fixed' },
            { value: 'none', label: 'None' },
          ]}
          value={c.v4}
          error={errorFor}
          onChange={(x) => set({ ...c, v4: x.target.value as IpConfig['v4'] })}
        />
        {c.v4 === 'static' ? (
          <>
            <TextField
              label="Address"
              mono
              value={c.ip}
              placeholder="10.0.0.5/24"
              error={e.ip}
              onChange={(x) => set({ ...c, ip: x.target.value })}
            />
            <TextField
              label="Gateway"
              mono
              value={c.gw}
              placeholder="None"
              error={e.gw}
              onChange={(x) => set({ ...c, gw: x.target.value })}
            />
          </>
        ) : null}
      </div>
      <div className={styles.formRow}>
        <SelectField
          label="IPv6"
          options={[
            { value: 'auto', label: 'Automatic (SLAAC)' },
            { value: 'dhcp', label: 'DHCP' },
            { value: 'static', label: 'Fixed' },
            { value: 'none', label: 'None' },
          ]}
          value={c.v6}
          onChange={(x) => set({ ...c, v6: x.target.value as IpConfig['v6'] })}
        />
        {c.v6 === 'static' ? (
          <>
            <TextField
              label="Address"
              mono
              value={c.ip6}
              placeholder="fd00::5/64"
              error={e.ip6}
              onChange={(x) => set({ ...c, ip6: x.target.value })}
            />
            <TextField
              label="Gateway"
              mono
              value={c.gw6}
              placeholder="None"
              error={e.gw6}
              onChange={(x) => set({ ...c, gw6: x.target.value })}
            />
          </>
        ) : null}
      </div>
    </>
  );
}

export function NicDialog({ ctx, choices, k, onClose }: DialogProps & { k?: string }) {
  const kind = ctx.config.kind;
  const vm = kind === 'vm';
  const key = k ?? freeKey(ctx.config, 'net', 32);
  const v = k ? (currentValue(ctx.config, k) ?? '') : '';
  const [was] = useState<NicFields>(() => readNic(v, kind));
  const [n, setN] = useState<NicFields>(() => (k ? was : newNic(kind, key ?? 'net0', '')));
  const bridge = n.bridge || choices?.bridges[0] || '';
  const fields = { ...n, bridge };
  const e = nicErrors(fields, kind);
  const bad = Object.values(e).some(Boolean);
  const set = (p: Partial<NicFields>) => setN({ ...n, ...p });
  return (
    <EditDialog
      ctx={ctx}
      title={k ? `${k} of ${nameOf(ctx)}` : `Add a network device to ${nameOf(ctx)}`}
      draft={!key || !bridge || bad ? null : draftOf({ [key]: writeNic(v, fields, was, kind) })}
      onClose={onClose}
      wide
    >
      {(errors) => (
        <>
          <div className={styles.formRow}>
            {vm ? (
              <SelectField
                label="Model"
                options={[...new Set([...NIC_MODELS, n.model].filter(Boolean))].map((m) => ({
                  value: m,
                  label: NIC_MODEL_WORDS[m] ?? m,
                }))}
                value={n.model}
                autoFocus
                onChange={(x) => set({ model: x.target.value })}
              />
            ) : (
              <TextField
                label="Name in the container"
                mono
                value={n.name}
                autoFocus
                error={e.name}
                onChange={(x) => set({ name: x.target.value })}
              />
            )}
            <TextField
              label="MAC address"
              mono
              value={n.mac}
              placeholder="Proxmox picks one"
              error={e.mac}
              onChange={(x) => set({ mac: x.target.value })}
            />
          </div>
          <div className={styles.formRow}>
            <BridgeSelect
              choices={choices}
              value={bridge}
              error={key ? errors[key] : null}
              onChange={(b) => set({ bridge: b })}
            />
            <TextField
              label="VLAN"
              inputMode="numeric"
              value={n.tag}
              placeholder="None"
              error={e.tag}
              onChange={(x) => set({ tag: x.target.value })}
            />
          </div>
          <div className={styles.formRow}>
            <TextField
              label="Speed limit (MB/s)"
              inputMode="decimal"
              value={n.rate}
              placeholder="No limit"
              error={e.rate}
              onChange={(x) => set({ rate: x.target.value })}
            />
            <TextField
              label="MTU"
              inputMode="numeric"
              value={n.mtu}
              placeholder="The network’s"
              error={e.mtu}
              onChange={(x) => set({ mtu: x.target.value })}
            />
          </div>
          {vm ? null : <IpFields c={n.ip} set={(ip) => set({ ip })} />}
          <div className={wa.waChecks}>
            <Check label="Firewall" checked={n.firewall} onChange={(firewall) => set({ firewall })} />
            <Check label="Disconnected" checked={n.linkDown} onChange={(linkDown) => set({ linkDown })} />
          </div>
        </>
      )}
    </EditDialog>
  );
}

/* Mount points, DNS --------------------------------------------------------------------------------- */

export function MountPointDialog({ ctx, choices, k, onClose }: DialogProps & { k?: string }) {
  const key = k ?? freeKey(ctx.config, 'mp', 256);
  const v = k ? (currentValue(ctx.config, k) ?? '') : '';
  const [was] = useState(() => readMount(v));
  const [m, setM] = useState(() => (k ? was : NEW_MOUNT));
  const [storage, setStorage] = useState('');
  const [size, setSize] = useState('8');
  const st = storage || storagesFor(choices, 'rootdir')[0]?.id || '';
  const sz = checkNumber(size, { min: 1, max: 131_072, decimal: true });
  const pathError = mountPathError(m.path);
  return (
    <EditDialog
      ctx={ctx}
      title={k ? `${k} of ${nameOf(ctx)}` : `Add a mount point to ${nameOf(ctx)}`}
      description={k ? <span className={styles.mono}>{diskFile(v)}</span> : undefined}
      draft={
        !key || pathError || (!k && (!st || sz.error))
          ? null
          : draftOf({ [key]: k ? writeMount(v, m, was) : newMountValue(st, size, m) })
      }
      onClose={onClose}
    >
      {(errors) => (
        <>
          {k ? null : (
            <div className={styles.formRow}>
              <StorageSelect choices={choices} content="rootdir" value={st} onChange={setStorage} />
              <TextField
                label="Size (GiB)"
                inputMode="decimal"
                value={size}
                error={sz.error}
                onChange={(e) => setSize(e.target.value)}
              />
            </div>
          )}
          <TextField
            label="Folder in the container"
            mono
            value={m.path}
            autoFocus
            error={pathError ?? (key ? errors[key] : null)}
            hint={k ? 'Its size changes with Grow.' : key ? `Attached as ${key}` : undefined}
            onChange={(e) => setM({ ...m, path: e.target.value })}
          />
          <div className={wa.waChecks}>
            <Check
              label="Include in backups"
              checked={m.backup}
              onChange={(backup) => setM({ ...m, backup })}
            />
            <Check label="Read-only" checked={m.ro} onChange={(ro) => setM({ ...m, ro })} />
            <Check
              label="Include in replication"
              checked={m.replicate}
              onChange={(replicate) => setM({ ...m, replicate })}
            />
          </div>
        </>
      )}
    </EditDialog>
  );
}

/** The DNS domain and servers (a container's own; a VM's through cloud-init). Empty uses the server's. */
export function DnsDialog({ ctx, onClose }: DialogProps) {
  const [domain, setDomain] = useState(currentValue(ctx.config, 'searchdomain') ?? '');
  const [servers, setServers] = useState(currentValue(ctx.config, 'nameserver') ?? '');
  const de = domain.trim() ? domainError(domain) : null;
  const se = servers.trim() ? dnsServersError(servers) : null;
  return (
    <EditDialog
      ctx={ctx}
      title={`DNS of ${nameOf(ctx)}`}
      description="Empty fields use the server’s own settings."
      draft={
        de || se
          ? null
          : draftOf({
              searchdomain: domain.trim() || undefined,
              nameserver: dnsServerList(servers).join(' ') || undefined,
            })
      }
      onClose={onClose}
    >
      {(errors) => (
        <>
          <TextField
            label="DNS domain"
            mono
            value={domain}
            autoFocus
            placeholder="lab.example"
            error={de ?? errors.searchdomain}
            onChange={(e) => setDomain(e.target.value)}
          />
          <TextField
            label="DNS servers"
            mono
            value={servers}
            placeholder="10.0.0.1 1.1.1.1"
            error={se ?? errors.nameserver}
            hint="Separate them with spaces."
            onChange={(e) => setServers(e.target.value)}
          />
        </>
      )}
    </EditDialog>
  );
}

/** The devices it starts from, in order: ticked ones first, moved with buttons (keyboard and screen readers). */
export function BootDialog({ ctx, onClose }: DialogProps) {
  const cfg = ctx.config;
  const cur = currentValue(cfg, 'boot');
  const enabled0 = bootOrder(cur);
  const devices = [...keysOf(cfg, DISK_RE), ...keysOf(cfg, NET_RE)];
  const [list, setList] = useState(() => [
    ...enabled0.filter((d) => devices.includes(d)).map((key) => ({ key, on: true })),
    ...devices.filter((d) => !enabled0.includes(d)).map((key) => ({ key, on: false })),
  ]);
  const move = (i: number, by: number) => {
    const next = list.slice();
    const [d] = next.splice(i, 1);
    if (d) next.splice(i + by, 0, d);
    setList(next);
  };
  const order = list.filter((x) => x.on).map((x) => x.key);
  const what = (k: string) => {
    const val = currentValue(cfg, k);
    if (NET_RE.test(k)) return getProp(parseProps(val ?? ''), 'bridge') ?? '';
    return isCdrom(val) ? `CD/DVD · ${diskFile(val).split('/').pop()}` : diskFile(val);
  };
  return (
    <EditDialog
      ctx={ctx}
      title={`Boot order of ${nameOf(ctx)}`}
      description="It tries the ticked devices from the top."
      draft={order.join(';') === enabled0.join(';') ? {} : draftOf({ boot: withBootOrder(cur, order) })}
      onClose={onClose}
    >
      {(errors) => (
        <>
          <ol className={styles.review} aria-label="Boot devices">
            {list.map((x, i) => (
              <li key={x.key} className={wa.waBoot}>
                <Check
                  label={
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span className={styles.mono}>{x.key}</span>
                      <span className={wa.waBootWhat}>{what(x.key)}</span>
                    </span>
                  }
                  checked={x.on}
                  onChange={(on) => setList(list.map((y) => (y.key === x.key ? { ...y, on } : y)))}
                />
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label={`Move ${x.key} up`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <Icon icon={ArrowUp} size={14} />
                </button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label={`Move ${x.key} down`}
                  disabled={i === list.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <Icon icon={ArrowDown} size={14} />
                </button>
              </li>
            ))}
          </ol>
          <KeyErrors errors={errors} keys={['boot']} />
        </>
      )}
    </EditDialog>
  );
}
