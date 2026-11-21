// Edit dialogs of the Hardware (VM) and Resources (container) tabs: typed
// fields for memory, processors, disks, CD/DVD drives, network devices,
// EFI disk, TPM and mount points. Property strings are edited item by
// item (props.ts), so options Rackoon has no field for stay as they are.
// Resize and Move start a task on the host instead of a config change.

import { type FormEvent, useState } from 'react';
import { type Choices, manageApi } from '../../api/manage';
import { InlineError, SelectField, TextField } from '../../components/forms';
import { Modal } from '../../components/Modal';
import { t, tx } from '../../lib/i18n';
import {
  checkNumber,
  current,
  diskFile,
  diskSize,
  draftOf,
  flagValue,
  formatIpConfig,
  formatSize,
  freeKey,
  type IpConfig,
  mibText,
  NIC_MODELS,
  nicModel,
  parseIpConfig,
  cidr4Error,
  cidr6Error,
  ip4Error,
  VM_BUSES,
  type VmBus,
  volumeStorage,
  withNicModel,
} from './config';
import { type DialogProps, KeyErrors } from './dialogs';
import { EditDialog, type EditCtx } from './EditDialog';
import { BridgeSelect, CheckRow, IsoSelect, StorageSelect } from './parts';
import { editProps, getProp, isOn, parseProps } from './props';
import { useManageChange } from './useConfigChange';

export interface ChoicesProps extends DialogProps {
  choices: Choices | undefined;
}

const name = (ctx: EditCtx) => ctx.guest.name;
const num = (s: string) => s.trim();

// ---------------------------------------------------------------- memory, processors

export function VmMemoryDialog({ ctx, onClose }: DialogProps) {
  const cfg = ctx.config;
  const memory0 = current(cfg, 'memory') ?? '512';
  const balloon0 = current(cfg, 'balloon');
  const [mem, setMem] = useState(memory0);
  const [ballooning, setBallooning] = useState(balloon0 !== '0');
  const [min, setMin] = useState(balloon0 && balloon0 !== '0' ? balloon0 : '');
  const m = checkNumber(mem, { min: 16 });
  const b = ballooning ? checkNumber(min, { min: 16, max: m.n ?? undefined, optional: true }) : { n: null, error: null };
  // Ballooning on with no minimum: the key goes (the minimum is the memory); off: balloon=0.
  const balloon = !ballooning ? '0' : b.n == null ? undefined : String(b.n);
  const draft = m.error || b.error ? null : draftOf({ memory: num(mem), ...(balloon !== balloon0 ? { balloon } : {}) });
  return (
    <EditDialog ctx={ctx} title={t('Edit memory')} label={t('Memory of {name}', { name: name(ctx) })} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          <TextField label={t('Memory (MiB)')} inputMode="numeric" value={mem} onChange={(e) => setMem(e.target.value)} hint={m.n ? mibText(m.n) : undefined} error={errors.memory ?? m.error ?? undefined} autoFocus />
          <CheckRow label={t('Ballooning device')} hint={t('lets the guest hand back memory it does not use')} checked={ballooning} onChange={setBallooning} />
          {ballooning && (
            <TextField
              label={t('Minimum memory (MiB)')}
              inputMode="numeric"
              value={min}
              placeholder={m.n ? String(m.n) : ''}
              onChange={(e) => setMin(e.target.value)}
              hint={b.n ? mibText(b.n) : t('Empty: the same as the memory')}
              error={errors.balloon ?? b.error ?? undefined}
            />
          )}
        </>
      )}
    </EditDialog>
  );
}

export function VmProcessorsDialog({ ctx, choices, onClose }: ChoicesProps) {
  const cfg = ctx.config;
  const cpu0 = current(cfg, 'cpu');
  const type0 = cpu0 ? (getProp(parseProps(cpu0, 'cputype'), 'cputype') ?? '') : '';
  const numa0 = isOn(current(cfg, 'numa'));
  const [sockets, setSockets] = useState(current(cfg, 'sockets') ?? '1');
  const [cores, setCores] = useState(current(cfg, 'cores') ?? '1');
  const [type, setType] = useState(type0);
  const [vcpus, setVcpus] = useState(current(cfg, 'vcpus') ?? '');
  const [limit, setLimit] = useState(current(cfg, 'cpulimit') ?? '');
  const [units, setUnits] = useState(current(cfg, 'cpuunits') ?? '');
  const [numa, setNuma] = useState(numa0);
  const s = checkNumber(sockets, { min: 1, max: 4 });
  const c = checkNumber(cores, { min: 1, max: 1024 });
  const total = (s.n ?? 0) * (c.n ?? 0);
  const v = checkNumber(vcpus, { min: 1, max: total || undefined, optional: true });
  const l = checkNumber(limit, { min: 0, max: 128, optional: true, decimal: true });
  const u = checkNumber(units, { min: 1, max: 262144, optional: true });
  const types = [...new Set([...(type0 ? [type0] : []), ...(choices?.cpu_types ?? [])])];
  const invalid = s.error || c.error || v.error || l.error || u.error;
  const draft = invalid
    ? null
    : draftOf({
        sockets: num(sockets),
        cores: num(cores),
        ...(type !== type0 ? { cpu: type ? (cpu0 ? editProps(cpu0, { cputype: type }, 'cputype') : type) : undefined } : {}),
        vcpus: num(vcpus) || undefined,
        cpulimit: num(limit) || undefined,
        cpuunits: num(units) || undefined,
        ...(numa !== numa0 ? { numa: flagValue(numa) } : {}),
      });
  return (
    <EditDialog ctx={ctx} title={t('Edit processors')} label={t('Processors of {name}', { name: name(ctx) })} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          <div className="form-grid">
            <TextField label={t('Sockets')} inputMode="numeric" value={sockets} onChange={(e) => setSockets(e.target.value)} error={errors.sockets ?? s.error ?? undefined} autoFocus />
            <TextField label={t('Cores per socket')} inputMode="numeric" value={cores} onChange={(e) => setCores(e.target.value)} error={errors.cores ?? c.error ?? undefined} hint={total ? t('{n} cores in total', { n: total }) : undefined} />
          </div>
          <SelectField label={t('CPU type')} value={type} onChange={(e) => setType(e.target.value)} error={errors.cpu}>
            <option value="">{t('Default (kvm64)')}</option>
            {types.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </SelectField>
          <div className="form-grid">
            <TextField label={t('vCPUs')} inputMode="numeric" value={vcpus} placeholder={total ? String(total) : ''} onChange={(e) => setVcpus(e.target.value)} hint={t('Empty: all cores')} error={errors.vcpus ?? v.error ?? undefined} />
            <TextField label={t('CPU limit')} inputMode="decimal" value={limit} placeholder={t('unlimited')} onChange={(e) => setLimit(e.target.value)} hint={t('In cores, e.g. 1.5')} error={errors.cpulimit ?? l.error ?? undefined} />
            <TextField label={t('CPU units')} inputMode="numeric" value={units} placeholder="100" onChange={(e) => setUnits(e.target.value)} hint={t('Weight against other guests')} error={errors.cpuunits ?? u.error ?? undefined} />
          </div>
          <CheckRow label={t('NUMA')} checked={numa} onChange={setNuma} />
          <KeyErrors errors={errors} keys={['numa']} />
        </>
      )}
    </EditDialog>
  );
}

export function CtMemoryDialog({ ctx, onClose }: DialogProps) {
  const [mem, setMem] = useState(current(ctx.config, 'memory') ?? '512');
  const [swap, setSwap] = useState(current(ctx.config, 'swap') ?? '512');
  const m = checkNumber(mem, { min: 16 });
  const s = checkNumber(swap, { min: 0 });
  const draft = m.error || s.error ? null : draftOf({ memory: num(mem), swap: num(swap) });
  return (
    <EditDialog ctx={ctx} title={t('Edit memory')} label={t('Memory of {name}', { name: name(ctx) })} draft={draft} onClose={onClose}>
      {(errors) => (
        <div className="form-grid">
          <TextField label={t('Memory (MiB)')} inputMode="numeric" value={mem} onChange={(e) => setMem(e.target.value)} hint={m.n ? mibText(m.n) : undefined} error={errors.memory ?? m.error ?? undefined} autoFocus />
          <TextField label={t('Swap (MiB)')} inputMode="numeric" value={swap} onChange={(e) => setSwap(e.target.value)} hint={s.n ? mibText(s.n) : undefined} error={errors.swap ?? s.error ?? undefined} />
        </div>
      )}
    </EditDialog>
  );
}

export function CtCoresDialog({ ctx, onClose }: DialogProps) {
  const [cores, setCores] = useState(current(ctx.config, 'cores') ?? '');
  const [limit, setLimit] = useState(current(ctx.config, 'cpulimit') ?? '');
  const [units, setUnits] = useState(current(ctx.config, 'cpuunits') ?? '');
  const c = checkNumber(cores, { min: 1, max: 8192, optional: true });
  const l = checkNumber(limit, { min: 0, max: 8192, optional: true, decimal: true });
  const u = checkNumber(units, { min: 0, max: 500000, optional: true });
  const draft = c.error || l.error || u.error ? null : draftOf({ cores: num(cores) || undefined, cpulimit: num(limit) || undefined, cpuunits: num(units) || undefined });
  return (
    <EditDialog ctx={ctx} title={t('Edit cores')} label={t('Cores of {name}', { name: name(ctx) })} draft={draft} onClose={onClose}>
      {(errors) => (
        <div className="form-grid">
          <TextField label={t('Cores')} inputMode="numeric" value={cores} placeholder={t('all')} onChange={(e) => setCores(e.target.value)} hint={t('Empty: every core of the host')} error={errors.cores ?? c.error ?? undefined} autoFocus />
          <TextField label={t('CPU limit')} inputMode="decimal" value={limit} placeholder={t('unlimited')} onChange={(e) => setLimit(e.target.value)} hint={t('In cores, e.g. 1.5')} error={errors.cpulimit ?? l.error ?? undefined} />
          <TextField label={t('CPU units')} inputMode="numeric" value={units} placeholder="100" onChange={(e) => setUnits(e.target.value)} hint={t('Weight against other guests')} error={errors.cpuunits ?? u.error ?? undefined} />
        </div>
      )}
    </EditDialog>
  );
}

// ---------------------------------------------------------------- disks

const CACHE: { value: string; label: string }[] = [
  { value: '', label: t('Default (no cache)') },
  { value: 'directsync', label: t('Direct sync') },
  { value: 'writethrough', label: t('Write through') },
  { value: 'writeback', label: t('Write back') },
  { value: 'unsafe', label: t('Write back (unsafe)') },
  { value: 'none', label: t('No cache') },
];

interface DiskOpts {
  cache: string;
  discard: boolean;
  iothread: boolean;
  ssd: boolean;
  backup: boolean;
}

function readDiskOpts(v: string | undefined): DiskOpts {
  const items = parseProps(v ?? '', 'file');
  return {
    cache: getProp(items, 'cache') ?? '',
    discard: getProp(items, 'discard') === 'on',
    iothread: isOn(getProp(items, 'iothread')),
    ssd: isOn(getProp(items, 'ssd')),
    backup: isOn(getProp(items, 'backup'), true),
  };
}

/** Only the options the user changed are written: a value Proxmox accepted stays byte for byte otherwise. */
function writeDiskOpts(v: string, o: DiskOpts, was: DiskOpts): string {
  const ch: Record<string, string | undefined> = {};
  if (o.cache !== was.cache) ch.cache = o.cache || undefined;
  if (o.discard !== was.discard) ch.discard = o.discard ? 'on' : undefined;
  if (o.iothread !== was.iothread) ch.iothread = flagValue(o.iothread);
  if (o.ssd !== was.ssd) ch.ssd = flagValue(o.ssd);
  if (o.backup !== was.backup) ch.backup = flagValue(o.backup, true);
  return editProps(v, ch, 'file');
}

function DiskOptFields({ o, set, bus }: { o: DiskOpts; set: (o: DiskOpts) => void; bus: string }) {
  return (
    <>
      <SelectField label={t('Cache')} value={o.cache} onChange={(e) => set({ ...o, cache: e.target.value })}>
        {CACHE.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </SelectField>
      <div className="check-grid">
        <CheckRow label={t('Discard')} hint={t('frees space on thin storage')} checked={o.discard} onChange={(v) => set({ ...o, discard: v })} />
        {(bus === 'scsi' || bus === 'virtio') && <CheckRow label={t('IO thread')} checked={o.iothread} onChange={(v) => set({ ...o, iothread: v })} />}
        {bus !== 'virtio' && <CheckRow label={t('SSD emulation')} checked={o.ssd} onChange={(v) => set({ ...o, ssd: v })} />}
        <CheckRow label={t('Include in backups')} checked={o.backup} onChange={(v) => set({ ...o, backup: v })} />
      </div>
    </>
  );
}

const busOf = (key: string) => key.replace(/\d+$/, '');
const BUS_LABEL: Record<VmBus, string> = { scsi: 'SCSI', virtio: 'VirtIO Block', sata: 'SATA', ide: 'IDE' };

function BusSelect({ value, onChange, buses = Object.keys(VM_BUSES) as VmBus[], keyText }: { value: VmBus; onChange: (b: VmBus) => void; buses?: VmBus[]; keyText: string | null }) {
  return (
    <SelectField label={t('Bus')} value={value} onChange={(e) => onChange(e.target.value as VmBus)} hint={keyText ? t('Attached as {key}', { key: keyText }) : t('No free slot on this bus')}>
      {buses.map((b) => (
        <option key={b} value={b}>
          {BUS_LABEL[b]}
        </option>
      ))}
    </SelectField>
  );
}

export function AddDiskDialog({ ctx, choices, onClose }: ChoicesProps) {
  const [bus, setBus] = useState<VmBus>('scsi');
  const images = (choices?.storages ?? []).filter((s) => s.content.includes('images'));
  const [storage, setStorage] = useState('');
  const [size, setSize] = useState('32');
  const fresh: DiskOpts = { cache: '', discard: false, iothread: true, ssd: false, backup: true };
  const [o, setO] = useState(fresh);
  const key = freeKey(ctx.config, bus, VM_BUSES[bus]);
  const st = storage || images[0]?.id || '';
  const sz = checkNumber(size, { min: 1, max: 131072, decimal: true });
  // Options the bus does not have stay off (IO thread: SCSI and VirtIO; SSD emulation: not VirtIO).
  const eff = { ...o, iothread: o.iothread && (bus === 'scsi' || bus === 'virtio'), ssd: o.ssd && bus !== 'virtio' };
  const draft = !key || !st || sz.error ? null : draftOf({ [key]: writeDiskOpts(`${st}:${num(size)}`, eff, { ...fresh, iothread: false }) });
  return (
    <EditDialog ctx={ctx} title={t('Add a hard disk')} label={t('New disk of {name}', { name: name(ctx) })} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          <div className="form-grid">
            <BusSelect value={bus} onChange={setBus} keyText={key} />
            <TextField label={t('Size (GiB)')} inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} error={sz.error ?? undefined} autoFocus />
          </div>
          <StorageSelect choices={choices} content="images" value={st} onChange={setStorage} />
          <DiskOptFields o={o} set={setO} bus={bus} />
          {key && <KeyErrors errors={errors} keys={[key]} />}
        </>
      )}
    </EditDialog>
  );
}

export function EditDiskDialog({ ctx, diskKey, onClose }: DialogProps & { diskKey: string }) {
  const v = current(ctx.config, diskKey) ?? '';
  const was = readDiskOpts(v);
  const [o, setO] = useState(was);
  const draft = draftOf({ [diskKey]: writeDiskOpts(v, o, was) });
  return (
    <EditDialog
      ctx={ctx}
      title={t('Edit {key}', { key: diskKey })}
      description={<span className="mono">{diskFile(v)}</span>}
      label={t('{key} of {name}', { key: diskKey, name: name(ctx) })}
      draft={draft}
      onClose={onClose}
    >
      {(errors) => (
        <>
          <DiskOptFields o={o} set={setO} bus={busOf(diskKey)} />
          <KeyErrors errors={errors} keys={[diskKey]} />
        </>
      )}
    </EditDialog>
  );
}

/** Grow a disk (VM disk, container root disk or mount point) by whole GiB: a task on the host. */
export function ResizeDialog({ ctx, diskKey, onClose }: DialogProps & { diskKey: string }) {
  const m = useManageChange(ctx.serverId, ctx.guest);
  const [add, setAdd] = useState('8');
  const [error, setError] = useState<string | null>(null);
  const v = current(ctx.config, diskKey);
  const now = ctx.config.disks?.find((d) => d.key === diskKey)?.size_bytes ?? diskSize(v) ?? 0;
  const a = checkNumber(add, { min: 1, max: 65536 });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (a.error || m.busy) return;
    setError(null);
    const out = await m.run(t('Resize {key} of {name}', { key: diskKey, name: name(ctx) }), () => manageApi.resizeDisk(ctx.serverId, ctx.guest.id, diskKey, `+${a.n}G`), { inline: true });
    if (out.ok) onClose();
    else setError(out.message);
  };
  return (
    <Modal
      open
      onClose={onClose}
      busy={m.busy}
      title={t('Resize {key}', { key: diskKey })}
      description={t('Disks only grow. The guest’s partitions and file systems need to be grown inside the guest afterwards.')}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={m.busy}>
            {t('Cancel')}
          </button>
          <button type="submit" form="resize-form" className="btn-primary btn-sm" aria-disabled={!!a.error || m.busy || undefined}>
            {m.busy && <span className="spinner spinner-sm on-primary" aria-hidden="true" />}
            {t('Resize')}
          </button>
        </>
      }
    >
      <form id="resize-form" className="form-stack" onSubmit={(e) => void submit(e)} noValidate>
        <TextField
          label={t('Add (GiB)')}
          inputMode="numeric"
          value={add}
          onChange={(e) => setAdd(e.target.value)}
          error={a.error ?? undefined}
          hint={a.n && now ? tx('{old} → {new}', { old: formatSize(now), new: <b className="ink">{formatSize(now + a.n * 1024 ** 3)}</b> }) : undefined}
          autoFocus
        />
        <InlineError>{error}</InlineError>
      </form>
    </Modal>
  );
}

/** Move a disk to another storage of the host: a task (the old volume stays as an unused disk unless deleted). */
export function MoveDialog({ ctx, choices, diskKey, onClose }: ChoicesProps & { diskKey: string }) {
  const m = useManageChange(ctx.serverId, ctx.guest);
  const vm = ctx.config.kind === 'vm';
  const from = volumeStorage(diskFile(current(ctx.config, diskKey)));
  const content = vm ? 'images' : 'rootdir';
  const targets = (choices?.storages ?? []).filter((s) => s.content.includes(content) && s.id !== from);
  const [storage, setStorage] = useState('');
  const [del, setDel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const st = storage || targets[0]?.id || '';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!st || m.busy) return;
    setError(null);
    const out = await m.run(t('Move {key} of {name} to {storage}', { key: diskKey, name: name(ctx), storage: st }), () => manageApi.moveDisk(ctx.serverId, ctx.guest.id, diskKey, st, del), { inline: true });
    if (out.ok) onClose();
    else setError(out.message);
  };
  return (
    <Modal
      open
      onClose={onClose}
      busy={m.busy}
      title={t('Move {key} to another storage', { key: diskKey })}
      description={from ? tx('Now on {storage}.', { storage: <span className="mono">{from}</span> }) : undefined}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={m.busy}>
            {t('Cancel')}
          </button>
          <button type="submit" form="move-form" className="btn-primary btn-sm" aria-disabled={!st || m.busy || undefined}>
            {m.busy && <span className="spinner spinner-sm on-primary" aria-hidden="true" />}
            {t('Move')}
          </button>
        </>
      }
    >
      <form id="move-form" className="form-stack" onSubmit={(e) => void submit(e)} noValidate>
        <StorageSelect choices={choices} content={content} value={st} onChange={setStorage} label={t('Target storage')} exclude={from} />
        <CheckRow label={t('Delete the original after copying')} hint={t('otherwise it stays as an unused disk')} checked={del} onChange={setDel} />
        <InlineError>{error}</InlineError>
      </form>
    </Modal>
  );
}

/** Detach, remove or delete one key (no fields: the dialog opens at its review). */
export function RemoveDialog({ ctx, cfgKey, title, description, destructive, onClose }: DialogProps & { cfgKey: string; title: string; description: string; destructive?: boolean }) {
  return <EditDialog ctx={ctx} title={title} description={description} label={t('{key} of {name}', { key: cfgKey, name: name(ctx) })} draft={{ delete: [cfgKey] }} destructive={destructive} onClose={onClose} />;
}

/** Re-attach an unused disk on a bus. */
export function AttachDialog({ ctx, cfgKey, onClose }: DialogProps & { cfgKey: string }) {
  const [bus, setBus] = useState<VmBus>('scsi');
  const key = freeKey(ctx.config, bus, VM_BUSES[bus]);
  const vol = current(ctx.config, cfgKey) ?? '';
  const draft = key ? draftOf({ [key]: diskFile(vol) }) : null;
  return (
    <EditDialog ctx={ctx} title={t('Attach {key}', { key: cfgKey })} description={<span className="mono">{diskFile(vol)}</span>} label={t('{key} of {name}', { key: cfgKey, name: name(ctx) })} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          <BusSelect value={bus} onChange={setBus} keyText={key} />
          {key && <KeyErrors errors={errors} keys={[key]} />}
        </>
      )}
    </EditDialog>
  );
}

// ---------------------------------------------------------------- CD/DVD, EFI, TPM

export function CdromDialog({ ctx, choices, diskKey, onClose }: ChoicesProps & { diskKey?: string }) {
  const [bus, setBus] = useState<VmBus>('ide');
  const key = diskKey ?? freeKey(ctx.config, bus, VM_BUSES[bus]);
  const v = diskKey ? (current(ctx.config, diskKey) ?? '') : '';
  const [iso, setIso] = useState(diskKey ? diskFile(v) || 'none' : 'none');
  // A new medium drops the old one's size (Proxmox fills it in).
  const draft = !key ? null : draftOf({ [key]: diskKey ? editProps(v, { file: iso, ...(iso !== diskFile(v) ? { size: undefined } : {}) }, 'file') : `${iso},media=cdrom` });
  return (
    <EditDialog
      ctx={ctx}
      title={diskKey ? t('Edit CD/DVD drive {key}', { key: diskKey }) : t('Add a CD/DVD drive')}
      label={t('CD/DVD drive of {name}', { name: name(ctx) })}
      draft={draft}
      onClose={onClose}
    >
      {(errors) => (
        <>
          {!diskKey && <BusSelect value={bus} onChange={setBus} buses={['ide', 'sata', 'scsi']} keyText={key} />}
          <IsoSelect choices={choices} value={iso} onChange={setIso} />
          {key && <KeyErrors errors={errors} keys={[key]} />}
        </>
      )}
    </EditDialog>
  );
}

export function EfiDiskDialog({ ctx, choices, onClose }: ChoicesProps) {
  const [storage, setStorage] = useState('');
  const [keys, setKeys] = useState(true);
  const st = storage || (choices?.storages ?? []).find((s) => s.content.includes('images'))?.id || '';
  const draft = st ? draftOf({ efidisk0: `${st}:1,efitype=4m${keys ? ',pre-enrolled-keys=1' : ''}` }) : null;
  return (
    <EditDialog ctx={ctx} title={t('Add an EFI disk')} description={t('Keeps the UEFI settings (boot entries, Secure Boot keys) of an OVMF guest.')} label={t('EFI disk of {name}', { name: name(ctx) })} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          <StorageSelect choices={choices} content="images" value={st} onChange={setStorage} />
          <CheckRow label={t('Pre-enroll keys')} hint={t('Secure Boot with Microsoft’s keys')} checked={keys} onChange={setKeys} />
          <KeyErrors errors={errors} keys={['efidisk0']} />
        </>
      )}
    </EditDialog>
  );
}

export function TpmDialog({ ctx, choices, onClose }: ChoicesProps) {
  const [storage, setStorage] = useState('');
  const [version, setVersion] = useState('v2.0');
  const st = storage || (choices?.storages ?? []).find((s) => s.content.includes('images'))?.id || '';
  const draft = st ? draftOf({ tpmstate0: `${st}:1,version=${version}` }) : null;
  return (
    <EditDialog ctx={ctx} title={t('Add a TPM')} description={t('A virtual Trusted Platform Module; Windows 11 needs version 2.0.')} label={t('TPM of {name}', { name: name(ctx) })} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          <StorageSelect choices={choices} content="images" value={st} onChange={setStorage} />
          <SelectField label={t('Version')} value={version} onChange={(e) => setVersion(e.target.value)}>
            <option value="v2.0">2.0</option>
            <option value="v1.2">1.2</option>
          </SelectField>
          <KeyErrors errors={errors} keys={['tpmstate0']} />
        </>
      )}
    </EditDialog>
  );
}

/** Adds a cloud-init drive on the first free IDE (else SATA) slot; PVE creates its volume and CD-ROM. */
export function CloudInitDriveDialog({ ctx, choices, onClose }: ChoicesProps) {
  const [storage, setStorage] = useState('');
  const st = storage || (choices?.storages ?? []).find((s) => s.content.includes('images'))?.id || '';
  const slot = freeKey(ctx.config, 'ide', VM_BUSES.ide) ?? freeKey(ctx.config, 'sata', VM_BUSES.sata);
  const draft = st && slot ? draftOf({ [slot]: `${st}:cloudinit` }) : null;
  return (
    <EditDialog
      ctx={ctx}
      title={t('Add a Cloud-Init drive')}
      description={t('Proxmox writes the user, SSH keys and network settings of the Cloud-Init tab to this drive; the guest reads them at boot.')}
      label={t('Cloud-Init drive of {name}', { name: name(ctx) })}
      draft={draft}
      onClose={onClose}
    >
      {(errors) => (
        <>
          <StorageSelect choices={choices} content="images" value={st} onChange={setStorage} />
          {!slot && <InlineError>{t('Every IDE and SATA slot is taken.')}</InlineError>}
          <KeyErrors errors={errors} keys={slot ? [slot] : []} />
        </>
      )}
    </EditDialog>
  );
}

// ---------------------------------------------------------------- network devices

const MODEL_LABEL: Record<string, string> = { virtio: 'VirtIO (paravirtualized)', e1000: 'Intel E1000', e1000e: 'Intel E1000E', rtl8139: 'Realtek RTL8139', vmxnet3: 'VMware vmxnet3' };

interface NicCommon {
  bridge: string;
  tag: string;
  firewall: boolean;
  linkDown: boolean;
  rate: string;
  mtu: string;
}

function readNicCommon(v: string): NicCommon {
  const items = parseProps(v);
  return {
    bridge: getProp(items, 'bridge') ?? '',
    tag: getProp(items, 'tag') ?? '',
    firewall: isOn(getProp(items, 'firewall')),
    linkDown: isOn(getProp(items, 'link_down')),
    rate: getProp(items, 'rate') ?? '',
    mtu: getProp(items, 'mtu') ?? '',
  };
}

function nicChanges(n: NicCommon, was: NicCommon): Record<string, string | undefined> {
  const ch: Record<string, string | undefined> = {};
  if (n.bridge !== was.bridge) ch.bridge = n.bridge || undefined;
  if (n.tag.trim() !== was.tag) ch.tag = n.tag.trim() || undefined;
  if (n.firewall !== was.firewall) ch.firewall = flagValue(n.firewall);
  if (n.linkDown !== was.linkDown) ch.link_down = flagValue(n.linkDown);
  if (n.rate.trim() !== was.rate) ch.rate = n.rate.trim() || undefined;
  if (n.mtu.trim() !== was.mtu) ch.mtu = n.mtu.trim() || undefined;
  return ch;
}

function NicCommonFields({ n, set, choices, errors }: { n: NicCommon; set: (n: NicCommon) => void; choices: Choices | undefined; errors: { tag: string | null; rate: string | null; mtu: string | null } }) {
  return (
    <>
      <div className="form-grid">
        <BridgeSelect choices={choices} value={n.bridge} onChange={(bridge) => set({ ...n, bridge })} />
        <TextField label={t('VLAN tag')} inputMode="numeric" value={n.tag} placeholder={t('none')} onChange={(e) => set({ ...n, tag: e.target.value })} error={errors.tag ?? undefined} />
      </div>
      <div className="form-grid">
        <TextField label={t('Rate limit (MB/s)')} inputMode="decimal" value={n.rate} placeholder={t('unlimited')} onChange={(e) => set({ ...n, rate: e.target.value })} error={errors.rate ?? undefined} />
        <TextField label={t('MTU')} inputMode="numeric" value={n.mtu} placeholder={t('the bridge’s')} onChange={(e) => set({ ...n, mtu: e.target.value })} error={errors.mtu ?? undefined} />
      </div>
      <div className="check-grid">
        <CheckRow label={t('Firewall')} checked={n.firewall} onChange={(firewall) => set({ ...n, firewall })} />
        <CheckRow label={t('Disconnected')} checked={n.linkDown} onChange={(linkDown) => set({ ...n, linkDown })} />
      </div>
    </>
  );
}

function checkNic(n: NicCommon) {
  return {
    tag: checkNumber(n.tag, { min: 1, max: 4094, optional: true }).error,
    rate: checkNumber(n.rate, { min: 0, optional: true, decimal: true }).error,
    mtu: checkNumber(n.mtu, { min: 1, max: 65520, optional: true }).error,
  };
}

export function VmNicDialog({ ctx, choices, nicKey, onClose }: ChoicesProps & { nicKey?: string }) {
  const key = nicKey ?? freeKey(ctx.config, 'net', 32);
  const v = nicKey ? (current(ctx.config, nicKey) ?? '') : '';
  const was = nicKey ? readNicCommon(v) : { bridge: '', tag: '', firewall: false, linkDown: false, rate: '', mtu: '' };
  const model0 = nicKey ? nicModel(v).model : 'virtio';
  const [model, setModel] = useState(model0);
  const [n, setN] = useState<NicCommon>(nicKey ? was : { ...was, firewall: true });
  const bridge = n.bridge || choices?.bridges[0] || '';
  const errs = checkNic(n);
  const base = nicKey ? (model !== model0 ? withNicModel(v, model) : v) : model;
  const value = editProps(base, nicChanges({ ...n, bridge }, was));
  const draft = !key || !bridge || errs.tag || errs.rate || errs.mtu ? null : draftOf({ [key]: value });
  return (
    <EditDialog
      ctx={ctx}
      title={nicKey ? t('Edit {key}', { key: nicKey }) : t('Add a network device')}
      description={nicKey && nicModel(v).mac ? tx('MAC address {mac}', { mac: <span className="mono">{nicModel(v).mac}</span> }) : undefined}
      label={t('Network device of {name}', { name: name(ctx) })}
      draft={draft}
      onClose={onClose}
    >
      {(errors) => (
        <>
          <SelectField label={t('Model')} value={model} onChange={(e) => setModel(e.target.value)} autoFocus>
            {[...new Set([...NIC_MODELS, model0])].filter(Boolean).map((m) => (
              <option key={m} value={m}>
                {MODEL_LABEL[m] ?? m}
              </option>
            ))}
          </SelectField>
          <NicCommonFields n={{ ...n, bridge }} set={setN} choices={choices} errors={errs} />
          {key && <KeyErrors errors={errors} keys={[key]} />}
        </>
      )}
    </EditDialog>
  );
}

/** IPv4 / IPv6 fields of a container NIC or a cloud-init IP config. */
export function IpFields({ c, set, v6Modes = ['auto', 'dhcp', 'static', 'none'] }: { c: IpConfig; set: (c: IpConfig) => void; v6Modes?: IpConfig['v6'][] }) {
  const e = ipErrors(c);
  const v6Label: Record<IpConfig['v6'], string> = { auto: t('SLAAC'), dhcp: 'DHCP', static: t('Static'), none: t('None') };
  return (
    <>
      <div className="form-grid">
        <SelectField label="IPv4" value={c.v4} onChange={(x) => set({ ...c, v4: x.target.value as IpConfig['v4'] })}>
          <option value="dhcp">DHCP</option>
          <option value="static">{t('Static')}</option>
          <option value="none">{t('None')}</option>
        </SelectField>
        {c.v4 === 'static' && <TextField label={t('IPv4 address')} mono value={c.ip} placeholder="10.0.0.5/24" onChange={(x) => set({ ...c, ip: x.target.value })} error={e.ip ?? undefined} />}
        {c.v4 === 'static' && <TextField label={t('IPv4 gateway')} mono value={c.gw} placeholder={t('none')} onChange={(x) => set({ ...c, gw: x.target.value })} error={e.gw ?? undefined} />}
      </div>
      <div className="form-grid">
        <SelectField label="IPv6" value={c.v6} onChange={(x) => set({ ...c, v6: x.target.value as IpConfig['v6'] })}>
          {v6Modes.map((m) => (
            <option key={m} value={m}>
              {v6Label[m]}
            </option>
          ))}
        </SelectField>
        {c.v6 === 'static' && <TextField label={t('IPv6 address')} mono value={c.ip6} placeholder="fd00::5/64" onChange={(x) => set({ ...c, ip6: x.target.value })} error={e.ip6 ?? undefined} />}
        {c.v6 === 'static' && <TextField label={t('IPv6 gateway')} mono value={c.gw6} placeholder={t('none')} onChange={(x) => set({ ...c, gw6: x.target.value })} />}
      </div>
    </>
  );
}

export function ipErrors(c: IpConfig): { ip: string | null; gw: string | null; ip6: string | null } {
  return {
    ip: c.v4 === 'static' ? cidr4Error(c.ip) : null,
    gw: c.v4 === 'static' && c.gw.trim() ? ip4Error(c.gw) : null,
    ip6: c.v6 === 'static' ? cidr6Error(c.ip6) : null,
  };
}

export function CtNicDialog({ ctx, choices, nicKey, onClose }: ChoicesProps & { nicKey?: string }) {
  const key = nicKey ?? freeKey(ctx.config, 'net', 32);
  const v = nicKey ? (current(ctx.config, nicKey) ?? '') : '';
  const was = nicKey ? readNicCommon(v) : { bridge: '', tag: '', firewall: false, linkDown: false, rate: '', mtu: '' };
  const name0 = nicKey ? (getProp(parseProps(v), 'name') ?? '') : `eth${key?.slice(3) ?? '0'}`;
  const ip0 = nicKey ? parseIpConfig(v) : parseIpConfig('ip=dhcp');
  const [ifname, setIfname] = useState(name0);
  const [n, setN] = useState<NicCommon>(nicKey ? was : { ...was, firewall: true });
  const [ip, setIp] = useState<IpConfig>(ip0);
  const bridge = n.bridge || choices?.bridges[0] || '';
  const errs = checkNic(n);
  const ie = ipErrors(ip);
  const nameErr = /^[A-Za-z][A-Za-z0-9_.-]{0,14}$/.test(ifname.trim()) ? null : t('1 to 15 letters, digits, “_”, “.” or “-”, starting with a letter.');
  const base = nicKey ? v : `name=${ifname.trim()},type=veth`;
  const ipChanged = JSON.stringify(ip) !== JSON.stringify(ip0);
  let value = editProps(base, { ...nicChanges({ ...n, bridge }, was), ...(nicKey && ifname.trim() !== name0 ? { name: ifname.trim() } : {}) });
  if (ipChanged || !nicKey) value = formatIpConfig(ip, value);
  const draft = !key || !bridge || nameErr || errs.tag || errs.rate || errs.mtu || ie.ip || ie.gw || ie.ip6 ? null : draftOf({ [key]: value });
  return (
    <EditDialog ctx={ctx} title={nicKey ? t('Edit {key}', { key: nicKey }) : t('Add a network device')} label={t('Network device of {name}', { name: name(ctx) })} draft={draft} onClose={onClose} wide>
      {(errors) => (
        <>
          <TextField label={t('Name in the container')} mono value={ifname} onChange={(e) => setIfname(e.target.value)} error={nameErr ?? undefined} autoFocus />
          <NicCommonFields n={{ ...n, bridge }} set={setN} choices={choices} errors={errs} />
          <IpFields c={ip} set={setIp} />
          {key && <KeyErrors errors={errors} keys={[key]} />}
        </>
      )}
    </EditDialog>
  );
}

// ---------------------------------------------------------------- mount points, DNS

export function MountPointDialog({ ctx, choices, mpKey, onClose }: ChoicesProps & { mpKey?: string }) {
  const key = mpKey ?? freeKey(ctx.config, 'mp', 256);
  const v = mpKey ? (current(ctx.config, mpKey) ?? '') : '';
  const items = parseProps(v, 'file');
  const path0 = getProp(items, 'mp') ?? '';
  const backup0 = isOn(getProp(items, 'backup'));
  const ro0 = isOn(getProp(items, 'ro'));
  const [path, setPath] = useState(path0 || (mpKey ? '' : '/mnt/data'));
  const [backup, setBackup] = useState(backup0);
  const [ro, setRo] = useState(ro0);
  const [storage, setStorage] = useState('');
  const [size, setSize] = useState('8');
  const st = storage || (choices?.storages ?? []).find((s) => s.content.includes('rootdir'))?.id || '';
  const sz = checkNumber(size, { min: 1, max: 131072, decimal: true });
  const pathErr = /^\/[^\s,]*$/.test(path.trim()) && path.trim() !== '/' ? null : t('An absolute path inside the container, like /mnt/data.');
  const ch: Record<string, string | undefined> = {};
  if (path.trim() !== path0) ch.mp = path.trim();
  if (backup !== backup0) ch.backup = flagValue(backup);
  if (ro !== ro0) ch.ro = flagValue(ro);
  const value = mpKey ? editProps(v, ch, 'file') : editProps(`${st}:${num(size)}`, ch, 'file');
  const draft = !key || pathErr || (!mpKey && (!st || sz.error)) ? null : draftOf({ [key]: value });
  return (
    <EditDialog
      ctx={ctx}
      title={mpKey ? t('Edit {key}', { key: mpKey }) : t('Add a mount point')}
      description={mpKey ? <span className="mono">{diskFile(v)}</span> : undefined}
      label={t('Mount point of {name}', { name: name(ctx) })}
      draft={draft}
      onClose={onClose}
    >
      {(errors) => (
        <>
          {!mpKey && (
            <div className="form-grid">
              <StorageSelect choices={choices} content="rootdir" value={st} onChange={setStorage} />
              <TextField label={t('Size (GiB)')} inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} error={sz.error ?? undefined} />
            </div>
          )}
          <TextField label={t('Path in the container')} mono value={path} onChange={(e) => setPath(e.target.value)} error={pathErr ?? undefined} autoFocus />
          <div className="check-grid">
            <CheckRow label={t('Include in backups')} checked={backup} onChange={setBackup} />
            <CheckRow label={t('Read-only')} checked={ro} onChange={setRo} />
          </div>
          {key && <KeyErrors errors={errors} keys={[key]} />}
        </>
      )}
    </EditDialog>
  );
}

/** DNS domain and servers (containers; VMs through cloud-init). Empty fields use the host's settings. */
export function DnsDialog({ ctx, onClose, title }: DialogProps & { title?: string }) {
  const domain0 = current(ctx.config, 'searchdomain') ?? '';
  const servers0 = current(ctx.config, 'nameserver') ?? '';
  const [domain, setDomain] = useState(domain0);
  const [servers, setServers] = useState(servers0);
  const list = servers.trim().split(/[\s,]+/).filter(Boolean);
  const bad = list.find((s) => ip4Error(s) && !/^[0-9a-f:]+$/i.test(s));
  const draft = bad ? null : draftOf({ searchdomain: domain.trim() || undefined, nameserver: list.join(' ') || undefined });
  return (
    <EditDialog ctx={ctx} title={title ?? t('Edit DNS')} description={t('Empty fields use the host’s settings.')} label={t('DNS of {name}', { name: name(ctx) })} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          <TextField label={t('DNS domain')} mono value={domain} placeholder="lab.example" onChange={(e) => setDomain(e.target.value)} error={errors.searchdomain} autoFocus />
          <TextField
            label={t('DNS servers')}
            mono
            value={servers}
            placeholder="10.0.0.1 1.1.1.1"
            onChange={(e) => setServers(e.target.value)}
            hint={t('Separated by spaces')}
            error={errors.nameserver ?? (bad ? t('{value} is not an IP address.', { value: bad }) : undefined)}
          />
        </>
      )}
    </EditDialog>
  );
}
