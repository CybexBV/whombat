/**
 * A libvirt VM's Hardware dialogs (Whombat incus-unraid.md IU-13; AP-1651): memory with its maximum, processors with
 * the CPU mode, a disk (a new one on a pool or Unraid's VM folder, or a volume or file that exists), a CD/DVD drive's
 * disc (in or out at once, even while it runs), a network card on a libvirt network or a host bridge with its cable
 * plugged in or not, and the boot order. Each goes through the Proxmox review (`EditDialog`, `key old → new`) and
 * changes only the sub-keys it has a field for (`@whombat/client/hosts` libvirt rules).
 */
import {
  BOOT_DEVICES,
  CPU_MODES,
  checkNumber,
  currentValue,
  draftOf,
  existingLvDiskValue,
  formatBytesBinary,
  isIsoName,
  LV_DISK_BUSES,
  LV_NIC_MODELS,
  libvirtIsos,
  libvirtVolumes,
  lvBootOrder,
  lvCdromSource,
  lvFreeKey,
  lvLinkOptions,
  lvMacError,
  lvPathError,
  mibText,
  newLvCdrom,
  newLvDiskValue,
  newLvNic,
  newLvNicValue,
  readLvNic,
  storageWord,
  withLvCdrom,
  writeLvNic,
} from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostChoices } from '@whombat/core/domain';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { type EditCtx, EditDialog } from '../guest/EditDialog';
import { KeyErrors } from '../guest/editParts';
import wa from '../guest/GuestEdit.module.css';
import { Check, SelectField, TextField } from '../manage/fields';
import styles from '../Things.module.css';

export interface LvDialogProps {
  ctx: EditCtx;
  choices?: HostChoices;
  onClose: () => void;
}

const nameOf = (ctx: EditCtx) => ctx.guest.name;

const muted = (label: string, more: string): ReactNode => (
  <span>
    {label} <span className={styles.muted}>· {more}</span>
  </span>
);

/* Memory and processors ----------------------------------------------------------------------------- */

export function LvMemoryDialog({ ctx, onClose }: LvDialogProps) {
  const cfg = ctx.config;
  const mem0 = currentValue(cfg, 'memory_mb') ?? '1024';
  const [mem, setMem] = useState(mem0);
  const [max, setMax] = useState(currentValue(cfg, 'memory_max_mb') ?? mem0);
  const m = checkNumber(mem, { min: 128 });
  const x = checkNumber(max, { min: m.n ?? 128, optional: true });
  return (
    <EditDialog
      ctx={ctx}
      title={`Memory of ${nameOf(ctx)}`}
      description={
        cfg.running
          ? `${nameOf(ctx)} runs: it grows or shrinks at once up to its maximum; a new maximum waits for its next start.`
          : undefined
      }
      draft={
        m.error || x.error
          ? null
          : draftOf({ memory_mb: mem.trim(), memory_max_mb: max.trim() || mem.trim() })
      }
      onClose={onClose}
    >
      {(errors) => (
        <div className={styles.formRow}>
          <TextField
            label="Memory (MiB)"
            inputMode="numeric"
            value={mem}
            autoFocus
            error={m.error ?? errors.memory_mb}
            hint={m.n ? mibText(m.n) : undefined}
            onChange={(e) => setMem(e.target.value)}
          />
          <TextField
            label="At most (MiB)"
            inputMode="numeric"
            value={max}
            placeholder={mem}
            error={x.error ?? errors.memory_max_mb}
            hint={x.n ? mibText(x.n) : 'Empty: the same as its memory.'}
            onChange={(e) => setMax(e.target.value)}
          />
        </div>
      )}
    </EditDialog>
  );
}

export function LvCpuDialog({ ctx, onClose }: LvDialogProps) {
  const cfg = ctx.config;
  const n0 = currentValue(cfg, 'vcpus') ?? '1';
  const mode0 = currentValue(cfg, 'cpu_mode') ?? 'host-passthrough';
  const [n, setN] = useState(n0);
  const [max, setMax] = useState(currentValue(cfg, 'vcpus_max') ?? n0);
  const [mode, setMode] = useState(mode0.startsWith('custom:') ? 'custom' : mode0);
  const [model, setModel] = useState(mode0.startsWith('custom:') ? mode0.slice(7) : '');
  const c = checkNumber(n, { min: 1, max: 512 });
  const x = checkNumber(max, { min: c.n ?? 1, max: 512, optional: true });
  const modelBad = mode === 'custom' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(model.trim());
  const options = CPU_MODES.some((o) => o.value === mode)
    ? CPU_MODES
    : [{ value: mode, label: mode }, ...CPU_MODES];
  return (
    <EditDialog
      ctx={ctx}
      title={`Processors of ${nameOf(ctx)}`}
      draft={
        c.error || x.error || modelBad
          ? null
          : draftOf({
              vcpus: n.trim(),
              vcpus_max: max.trim() || n.trim(),
              cpu_mode: mode === 'custom' ? `custom:${model.trim()}` : mode,
            })
      }
      onClose={onClose}
    >
      {(errors) => (
        <>
          <div className={styles.formRow}>
            <TextField
              label="vCPUs"
              inputMode="numeric"
              value={n}
              autoFocus
              error={c.error ?? errors.vcpus}
              onChange={(e) => setN(e.target.value)}
            />
            <TextField
              label="At most"
              inputMode="numeric"
              value={max}
              placeholder={n}
              error={x.error ?? errors.vcpus_max}
              hint="A running VM can get more vCPUs up to this."
              onChange={(e) => setMax(e.target.value)}
            />
          </div>
          <SelectField
            label="CPU"
            options={options}
            value={mode}
            error={errors.cpu_mode}
            hint={
              mode === 'host-passthrough'
                ? 'The VM sees this server’s own CPU: fastest, but it can only move to the same kind of CPU.'
                : undefined
            }
            onChange={(e) => setMode(e.target.value)}
          />
          {mode === 'custom' ? (
            <TextField
              label="CPU model"
              mono
              value={model}
              placeholder="Skylake-Client-v4"
              error={modelBad && model ? 'A model name QEMU knows, like EPYC-v4.' : null}
              onChange={(e) => setModel(e.target.value)}
            />
          ) : null}
        </>
      )}
    </EditDialog>
  );
}

/* Disks ---------------------------------------------------------------------------------------------- */

const free = (s: HostChoices['storages'][number]) =>
  s.availBytes != null ? ` · ${formatBytesBinary(s.availBytes)} free` : '';

/** Where new disks go: the pools, or Unraid's VM folder. */
export function storageOptions(choices: HostChoices | undefined, none = 'Nowhere to put it') {
  const list = choices?.storages ?? [];
  if (!choices) return [{ value: '', label: 'Loading…' }];
  return list.length
    ? list.map((s) => ({ value: s.id, label: `${storageWord(s.id)}${free(s)}` }))
    : [{ value: '', label: none }];
}

export function LvAddDiskDialog({ ctx, choices, onClose }: LvDialogProps) {
  const cfg = ctx.config;
  const key = lvFreeKey(cfg, 'disk');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [storage, setStorage] = useState('');
  const [size, setSize] = useState('32');
  const [bus, setBus] = useState('virtio');
  const [format, setFormat] = useState('qcow2');
  const pools = (choices?.storages ?? []).filter((s) => !s.id.startsWith('folder:'));
  const [from, setFrom] = useState('');
  const [volume, setVolume] = useState('');
  const [path, setPath] = useState('');
  const where = storage || choices?.storages[0]?.id || '';
  const pool = from || pools[0]?.id || 'path';
  const list = useHostManageRead(
    mode === 'existing' && pool !== 'path'
      ? {
          params: { burrow: ctx.burrow, serverId: ctx.serverId },
          query: { op: 'content.list', platform: 'libvirt', storage: pool },
        }
      : null,
  );
  const unused = libvirtVolumes(list.data).filter((v) => !v.usedBy.length && !isIsoName(v.name));
  const s = checkNumber(size, { min: 1, max: 65_536 });
  const source = pool === 'path' ? path.trim() : volume || unused[0]?.volid || '';
  const pathBad = mode === 'existing' ? lvPathError(source) : null;
  const draft =
    mode === 'new'
      ? s.error || !where
        ? null
        : draftOf({ [key]: newLvDiskValue(where, size, bus, format) })
      : pathBad
        ? null
        : draftOf({ [key]: existingLvDiskValue(source, bus) });
  return (
    <EditDialog
      ctx={ctx}
      title={`Add a disk to ${nameOf(ctx)}`}
      description={
        cfg.running
          ? `It’s attached when ${nameOf(ctx)} next starts.`
          : `It becomes ${key} of ${nameOf(ctx)}.`
      }
      draft={draft}
      onClose={onClose}
      wide
    >
      {(errors) => (
        <>
          <SegmentedControl
            options={[
              { value: 'new', label: 'A new disk' },
              { value: 'existing', label: 'One that exists' },
            ]}
            value={mode}
            onChange={setMode}
            label="Disk"
            variant="soft"
          />
          {mode === 'new' ? (
            <>
              <div className={styles.formRow}>
                <SelectField
                  label="On"
                  options={storageOptions(choices)}
                  value={where}
                  disabled={!choices?.storages.length}
                  onChange={(e) => setStorage(e.target.value)}
                />
                <TextField
                  label="Size (GiB)"
                  inputMode="numeric"
                  value={size}
                  error={s.error}
                  onChange={(e) => setSize(e.target.value)}
                />
              </div>
              <div className={styles.formRow}>
                <SelectField
                  label="Bus"
                  options={LV_DISK_BUSES}
                  value={bus}
                  onChange={(e) => setBus(e.target.value)}
                />
                <SelectField
                  label="Format"
                  options={[
                    { value: 'qcow2', label: 'qcow2 (snapshots, grows as it fills)' },
                    { value: 'raw', label: 'raw (a little faster, no snapshots)' },
                  ]}
                  value={format}
                  onChange={(e) => setFormat(e.target.value)}
                />
              </div>
            </>
          ) : (
            <>
              <div className={styles.formRow}>
                <SelectField
                  label="From"
                  options={[
                    ...pools.map((p) => ({ value: p.id, label: `The ${p.id} pool` })),
                    { value: 'path', label: 'A file’s path' },
                  ]}
                  value={pool}
                  onChange={(e) => {
                    setFrom(e.target.value);
                    setVolume('');
                  }}
                />
                {pool === 'path' ? (
                  <TextField
                    label="Path"
                    mono
                    value={path}
                    placeholder="/mnt/user/domains/vm/vdisk2.img"
                    error={path ? pathBad : null}
                    onChange={(e) => setPath(e.target.value)}
                  />
                ) : (
                  <SelectField
                    label="Volume"
                    options={
                      unused.length
                        ? unused.map((v) => ({
                            value: v.volid,
                            label: `${v.name}${v.sizeBytes != null ? ` · ${formatBytesBinary(v.sizeBytes)}` : ''}`,
                          }))
                        : [{ value: '', label: list.isLoading ? 'Loading…' : 'No unused volumes there' }]
                    }
                    value={source}
                    disabled={!unused.length}
                    onChange={(e) => setVolume(e.target.value)}
                  />
                )}
              </div>
              <SelectField
                label="Bus"
                options={LV_DISK_BUSES}
                value={bus}
                onChange={(e) => setBus(e.target.value)}
              />
            </>
          )}
          <KeyErrors errors={errors} keys={[key]} />
        </>
      )}
    </EditDialog>
  );
}

/* CD/DVD --------------------------------------------------------------------------------------------- */

/** The host's ISO images by pool or folder, and “No disc”. */
export function isoOptions(choices: HostChoices | undefined, current = '') {
  const isos = libvirtIsos(choices?.isos);
  const known = !current || isos.some((i) => i.volid === current);
  return [
    { value: '', label: 'No disc' },
    ...(known ? [] : [{ value: current, label: current.split('/').pop() ?? current, group: 'Now' }]),
    ...isos.map((i) => ({ value: i.volid, label: i.name, group: i.place })),
  ];
}

/** Insert or take out a disc (k), or add a drive (no k). */
export function LvCdromDialog({ ctx, choices, k, onClose }: LvDialogProps & { k?: string }) {
  const cfg = ctx.config;
  const key = k ?? lvFreeKey(cfg, 'cdrom');
  const cur = k ? currentValue(cfg, k) : undefined;
  const [source, setSource] = useState(lvCdromSource(cur));
  const [bus, setBus] = useState('sata');
  const isos = libvirtIsos(choices?.isos);
  return (
    <EditDialog
      ctx={ctx}
      title={k ? `The disc in ${k} of ${nameOf(ctx)}` : `Add a CD/DVD drive to ${nameOf(ctx)}`}
      description={
        k
          ? 'A disc goes in or out at once, even while it runs.'
          : cfg.running
            ? `The drive is there when ${nameOf(ctx)} next starts.`
            : undefined
      }
      draft={draftOf({ [key]: k ? withLvCdrom(cur, source) : newLvCdrom(source, bus) })}
      onClose={onClose}
    >
      {(errors) => (
        <>
          <SelectField
            label="Disc"
            options={isoOptions(choices, source)}
            value={source}
            autoFocus
            error={errors[key]}
            hint={
              choices && !isos.length
                ? 'No ISO images on this server yet: download one on Storage.'
                : undefined
            }
            onChange={(e) => setSource(e.target.value)}
          />
          {k ? null : (
            <SelectField
              label="Bus"
              options={[
                { value: 'sata', label: 'SATA' },
                { value: 'scsi', label: 'SCSI' },
              ]}
              value={bus}
              onChange={(e) => setBus(e.target.value)}
            />
          )}
        </>
      )}
    </EditDialog>
  );
}

/** Take the disc out at once (opens at the review). */
export function LvEjectDialog({ ctx, k, onClose }: LvDialogProps & { k: string }) {
  const cur = currentValue(ctx.config, k);
  return (
    <EditDialog
      ctx={ctx}
      title={`Take the disc out of ${k}?`}
      description={`${nameOf(ctx)} sees an empty drive at once.`}
      draft={draftOf({ [k]: withLvCdrom(cur, '') })}
      onClose={onClose}
    />
  );
}

/* Network cards -------------------------------------------------------------------------------------- */

export function LvNicDialog({ ctx, choices, k, onClose }: LvDialogProps & { k?: string }) {
  const cfg = ctx.config;
  const key = k ?? lvFreeKey(cfg, 'net');
  const cur = k ? currentValue(cfg, k) : undefined;
  const was = readLvNic(cur);
  const first = lvLinkOptions(choices)[0]?.value ?? '';
  const [n, setN] = useState(() => (k ? was : newLvNic(first)));
  const link = n.link || first;
  const nic = { ...n, link };
  const macBad = lvMacError(n.mac);
  return (
    <EditDialog
      ctx={ctx}
      title={k ? `Network device ${k} of ${nameOf(ctx)}` : `Add a network device to ${nameOf(ctx)}`}
      description={
        cfg.running && (!k || n.model !== was.model || link !== was.link)
          ? `${k ? 'A new network or model' : 'The card'} takes effect when ${nameOf(ctx)} next starts; the cable goes in or out at once.`
          : undefined
      }
      draft={macBad || !link ? null : draftOf({ [key]: k ? writeLvNic(cur, nic, was) : newLvNicValue(nic) })}
      onClose={onClose}
      wide
    >
      {(errors) => (
        <>
          <div className={styles.formRow}>
            <SelectField
              label="Connects to"
              options={lvLinkOptions(choices, k ? was.link : '')}
              value={link}
              autoFocus
              error={errors[key]}
              hint={
                link.startsWith('bridge:')
                  ? 'It joins the host’s network directly and gets an address from your router.'
                  : link.startsWith('network:')
                    ? 'libvirt’s network: libvirt hands out its addresses.'
                    : undefined
              }
              onChange={(e) => setN({ ...n, link: e.target.value })}
            />
            <SelectField
              label="Model"
              options={LV_NIC_MODELS}
              value={n.model}
              onChange={(e) => setN({ ...n, model: e.target.value })}
            />
          </div>
          <TextField
            label="MAC address"
            mono
            value={n.mac}
            placeholder={k ? '' : 'A new one'}
            error={macBad}
            onChange={(e) => setN({ ...n, mac: e.target.value })}
          />
          <Check
            label={muted('Cable plugged in', 'unplugged, the VM keeps the card but has no network')}
            checked={n.up}
            onChange={(up) => setN({ ...n, up })}
          />
        </>
      )}
    </EditDialog>
  );
}

/** Plug the cable in or pull it out at once (opens at the review). */
export function LvLinkDialog({ ctx, k, onClose }: LvDialogProps & { k: string }) {
  const cur = currentValue(ctx.config, k);
  const was = readLvNic(cur);
  return (
    <EditDialog
      ctx={ctx}
      title={was.up ? `Unplug ${k}’s cable?` : `Plug ${k}’s cable in?`}
      description={
        was.up
          ? `${nameOf(ctx)} keeps the network card but loses that connection at once, until you plug it in again.`
          : `${nameOf(ctx)} gets that connection back at once.`
      }
      draft={draftOf({ [k]: writeLvNic(cur, { ...was, up: !was.up }, was) })}
      onClose={onClose}
    />
  );
}

/* Boot order ----------------------------------------------------------------------------------------- */

export function LvBootDialog({ ctx, onClose }: LvDialogProps) {
  const cur = currentValue(ctx.config, 'boot');
  const on0 = lvBootOrder(cur);
  const [list, setList] = useState(() => [
    ...on0.map((key) => ({ key, on: true })),
    ...BOOT_DEVICES.filter((d) => !on0.includes(d.value)).map((d) => ({ key: d.value, on: false })),
  ]);
  const move = (i: number, by: number) => {
    const next = list.slice();
    const [d] = next.splice(i, 1);
    if (d) next.splice(i + by, 0, d);
    setList(next);
  };
  const order = list.filter((x) => x.on).map((x) => x.key);
  const label = (k: string) => BOOT_DEVICES.find((d) => d.value === k)?.label ?? k;
  return (
    <EditDialog
      ctx={ctx}
      title={`Boot order of ${nameOf(ctx)}`}
      description="It tries the ticked devices from the top."
      draft={
        !order.length ? null : order.join(',') === on0.join(',') ? {} : draftOf({ boot: order.join(',') })
      }
      onClose={onClose}
    >
      {(errors) => (
        <>
          <ol className={styles.review} aria-label="Boot devices">
            {list.map((x, i) => (
              <li key={x.key} className={wa.waBoot}>
                <Check
                  label={label(x.key)}
                  checked={x.on}
                  onChange={(on) => setList(list.map((y) => (y.key === x.key ? { ...y, on } : y)))}
                />
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label={`Move ${label(x.key)} up`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <Icon icon={ArrowUp} size={14} />
                </button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label={`Move ${label(x.key)} down`}
                  disabled={i === list.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <Icon icon={ArrowDown} size={14} />
                </button>
              </li>
            ))}
          </ol>
          {!order.length ? <p className={styles.error}>Tick at least one.</p> : null}
          <KeyErrors errors={errors} keys={['boot']} />
        </>
      )}
    </EditDialog>
  );
}
