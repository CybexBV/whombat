/**
 * A guest's Hardware (VM) or Resources (container) (ported from Rackoon's `HardwareTab`): every device and resource
 * as a row with what it is now and what it becomes after the next restart, an Add menu (hard disk, CD/DVD drive,
 * Cloud-Init drive, network device, EFI disk, TPM; containers: mount point, network device), disk actions (options,
 * grow, move, detach to an unused disk), unused disks with Attach and Delete, DNS for containers, the boot order, and
 * settings only Proxmox changes shown with its lock. Every change goes through the review (`EditDialog`).
 */
import {
  BIOS_TYPES,
  bootOrder,
  cpuType,
  DISK_RE,
  discName,
  diskFile,
  diskOptsWords,
  diskSize,
  formatBytesBinary,
  isBindMount,
  isCdrom,
  isCloudInitDrive,
  isRestricted,
  keysOf,
  laterWords,
  MACHINE_TYPES,
  MP_RE,
  machineType,
  mibText,
  moveBlocked,
  NET_RE,
  nicDetails,
  nicWords,
  optionLabel,
  parseProps,
  readMount,
  rowValue,
  SCSI_CONTROLLERS,
  typeOf,
  UNUSED_RE,
  VGA_TYPES,
  volumeStorage,
  withMachineType,
  withType,
} from '@whombat/client/hosts';
import type { HostGuestDetail } from '@whombat/core/domain';
import { Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { type ContextMenuItem, useRowMenu } from '../../../app/shell/ContextMenu';
import { Icon } from '../../../components/Icon';
import { Card } from '../parts';
import styles from '../Things.module.css';
import type { EditCtx } from './EditDialog';
import { EditBtn, MoreBtn, OtherSettings, platformName, Row, useChoices } from './editParts';
import wa from './GuestEdit.module.css';
import {
  AddDiskDialog,
  AttachDialog,
  BootDialog,
  CdromDialog,
  CloudInitDriveDialog,
  CtCpuDialog,
  CtMemoryDialog,
  DiskOptionsDialog,
  DnsDialog,
  EfiDiskDialog,
  MountPointDialog,
  MoveDialog,
  NicDialog,
  RemoveDialog,
  ResizeDialog,
  SelectKeyDialog,
  TpmDialog,
  VmCpuDialog,
  VmMemoryDialog,
} from './hardwareDialogs';

export { EditBtn, Row } from './editParts';

type Open =
  | {
      kind:
        | 'memory'
        | 'cpu'
        | 'bios'
        | 'vga'
        | 'machine'
        | 'scsihw'
        | 'addDisk'
        | 'addCd'
        | 'addCloudInit'
        | 'addNic'
        | 'efi'
        | 'tpm'
        | 'addMp'
        | 'dns'
        | 'boot';
    }
  | {
      kind:
        | 'disk'
        | 'cd'
        | 'nic'
        | 'mp'
        | 'resize'
        | 'move'
        | 'detach'
        | 'remove'
        | 'deleteUnused'
        | 'attach';
      key: string;
    };

type SetOpen = (o: Open) => void;

const mib = (s: string | undefined) => mibText(Number(s ?? 512));
const sizeOf = (v: string | undefined) => {
  const n = diskSize(v);
  return n != null ? formatBytesBinary(n) : '';
};
const PROC_KEYS = ['sockets', 'cores', 'cpu', 'vcpus', 'cpulimit', 'cpuunits', 'numa'];

function procWords(v: Record<string, string>): string {
  const sockets = Number(v.sockets ?? 1);
  const cores = Number(v.cores ?? 1);
  return [
    `${sockets > 1 ? `${sockets} sockets × ` : ''}${cores} ${cores === 1 ? 'core' : 'cores'}`,
    cpuType(v.cpu) || 'kvm64',
    v.vcpus ? `${v.vcpus} vCPUs` : '',
    v.cpulimit ? `limit ${v.cpulimit}` : '',
    v.cpuunits ? `weight ${v.cpuunits}` : '',
    v.numa === '1' ? 'NUMA' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function HardwareTab({ ctx }: { ctx: EditCtx; guest: HostGuestDetail }) {
  const choices = useChoices(ctx);
  const [open, setOpen] = useState<Open | null>(null);
  const cfg = ctx.config;
  const vm = cfg.kind === 'vm';
  const close = () => setOpen(null);
  const p = { ctx, choices, onClose: close };
  const name = ctx.guest.name;
  const cloudInitTab = vm && Object.values(cfg.values).some((x) => /cloudinit/.test(x));

  let dialog: ReactNode = null;
  if (open)
    switch (open.kind) {
      case 'memory':
        dialog = vm ? <VmMemoryDialog {...p} /> : <CtMemoryDialog {...p} />;
        break;
      case 'cpu':
        dialog = vm ? <VmCpuDialog {...p} /> : <CtCpuDialog {...p} />;
        break;
      case 'bios':
        dialog = (
          <SelectKeyDialog
            {...p}
            k="bios"
            title={`Firmware of ${name}`}
            label="BIOS"
            options={BIOS_TYPES}
            hint={(x) =>
              x === 'ovmf' && !cfg.values.efidisk0
                ? 'Add an EFI disk too, or its UEFI settings are lost at every start.'
                : undefined
            }
          />
        );
        break;
      case 'vga':
        dialog = (
          <SelectKeyDialog
            {...p}
            k="vga"
            title={`Display of ${name}`}
            label="Graphics card"
            options={VGA_TYPES}
            read={typeOf}
            write={(x, cur) => withType(cur, x)}
          />
        );
        break;
      case 'machine':
        dialog = (
          <SelectKeyDialog
            {...p}
            k="machine"
            title={`Machine type of ${name}`}
            label="Machine"
            options={MACHINE_TYPES}
            read={machineType}
            write={(x, cur) => withMachineType(cur, x)}
            hint={() => 'Changing it can rename devices inside the guest.'}
          />
        );
        break;
      case 'scsihw':
        dialog = (
          <SelectKeyDialog
            {...p}
            k="scsihw"
            title={`SCSI controller of ${name}`}
            label="SCSI controller"
            options={SCSI_CONTROLLERS}
            hint={(x) => (x === 'virtio-scsi-single' ? 'Lets each disk have its own IO thread.' : undefined)}
          />
        );
        break;
      case 'addDisk':
        dialog = <AddDiskDialog {...p} />;
        break;
      case 'addCd':
        dialog = <CdromDialog {...p} />;
        break;
      case 'addCloudInit':
        dialog = <CloudInitDriveDialog {...p} />;
        break;
      case 'addNic':
        dialog = <NicDialog {...p} />;
        break;
      case 'efi':
        dialog = <EfiDiskDialog {...p} />;
        break;
      case 'tpm':
        dialog = <TpmDialog {...p} />;
        break;
      case 'addMp':
        dialog = <MountPointDialog {...p} />;
        break;
      case 'dns':
        dialog = <DnsDialog {...p} />;
        break;
      case 'boot':
        dialog = <BootDialog {...p} />;
        break;
      case 'disk':
        dialog = <DiskOptionsDialog {...p} k={open.key} />;
        break;
      case 'cd':
        dialog = <CdromDialog {...p} k={open.key} />;
        break;
      case 'nic':
        dialog = <NicDialog {...p} k={open.key} />;
        break;
      case 'mp':
        dialog = <MountPointDialog {...p} k={open.key} />;
        break;
      case 'resize':
        dialog = <ResizeDialog {...p} k={open.key} />;
        break;
      case 'move':
        dialog = <MoveDialog {...p} k={open.key} />;
        break;
      case 'attach':
        dialog = <AttachDialog {...p} k={open.key} />;
        break;
      case 'detach':
        dialog = (
          <RemoveDialog
            {...p}
            k={open.key}
            title={`Detach ${open.key} from ${name}?`}
            description={detachWords(cfg.kind, open.key, bootOrder(cfg.values.boot)[0] === open.key)}
          />
        );
        break;
      case 'remove':
        dialog = (
          <RemoveDialog
            {...p}
            k={open.key}
            title={`Remove ${open.key} from ${name}?`}
            description={removeWords(open.key, cfg.values[open.key])}
          />
        );
        break;
      case 'deleteUnused':
        dialog = (
          <RemoveDialog
            {...p}
            k={open.key}
            destructive
            title={`Delete ${open.key}?`}
            description={
              <>
                <span className={styles.mono}>{diskFile(cfg.values[open.key])}</span> is destroyed with
                everything on it. This can’t be undone.
              </>
            }
          />
        );
        break;
    }

  return (
    <>
      {vm ? <VmCards ctx={ctx} setOpen={setOpen} /> : <CtCards ctx={ctx} setOpen={setOpen} />}
      <OtherSettings ctx={ctx} cloudInit={cloudInitTab} />
      {dialog}
    </>
  );
}

function detachWords(kind: string, key: string, boots: boolean): string {
  const what = kind === 'vm' ? 'disk' : 'volume';
  return `The ${what} stays on its storage as an unused disk; nothing is deleted.${boots ? ` It’s the first device ${kind === 'vm' ? 'the VM' : 'it'} starts from.` : ''}${key === 'efidisk0' ? ' Its UEFI settings go with it.' : ''}`;
}

function removeWords(key: string, v: string | undefined): string {
  if (NET_RE.test(key)) return 'The network device is taken out; the guest loses that connection.';
  if (isCloudInitDrive(v))
    return 'The cloud-init drive is taken out; Proxmox makes a new one if you add it again.';
  if (isCdrom(v)) return 'The CD/DVD drive is taken out.';
  return 'It stays on its storage as an unused disk; nothing is deleted.';
}

/** A row's values now and after the next restart, worded. */
function useRows(ctx: EditCtx) {
  const cfg = ctx.config;
  const platform = platformName(cfg);
  return {
    cfg,
    lock: (k: string) => (isRestricted(cfg, k) ? platform : undefined),
    /** What a single key becomes after the next restart, worded; "" when it goes. */
    next: (k: string, fmt: (v: string) => string): string | undefined => {
      const r = rowValue(cfg, k);
      return r.next === undefined ? undefined : r.removed ? '' : fmt(r.next);
    },
    /** A second-line key's “ → then (after restart)”. */
    later: (k: string, fmt: (v: string | undefined) => string): string => {
      const r = rowValue(cfg, k);
      if (r.next === undefined) return '';
      return ` → ${r.removed ? fmt(undefined) : fmt(r.next)} (after restart)`;
    },
  };
}

function AddMenu({ label, items }: { label: string; items: ContextMenuItem[] }) {
  const menu = useRowMenu();
  return (
    <>
      <button
        type="button"
        className={`${styles.cardLink} ${wa.waAdd}`}
        aria-haspopup="menu"
        aria-expanded={menu.openKey === 'add'}
        onClick={(e) => menu.openFrom(e.currentTarget, 'add', label, items, 'end')}
      >
        <Icon icon={Plus} size={14} />
        Add
      </button>
      {menu.element}
    </>
  );
}

function VmCards({ ctx, setOpen }: { ctx: EditCtx; setOpen: SetOpen }) {
  const { cfg, lock, next, later } = useRows(ctx);
  const v = cfg.values;
  const pend = cfg.pending ?? {};
  const has = (k: string) => k in v || k in pend;
  const disks = keysOf(cfg, DISK_RE);
  const drive = (k: string) => pend[k] ?? v[k];
  const cds = disks.filter((k) => isCdrom(drive(k)));
  const hds = disks.filter((k) => !cds.includes(k));
  const ci = cds.find((k) => isCloudInitDrive(drive(k)));
  const boot = bootOrder(pend.boot ?? v.boot);
  const add: ContextMenuItem[] = [
    { label: 'Hard disk', onSelect: () => setOpen({ kind: 'addDisk' }) },
    { label: 'CD/DVD drive', onSelect: () => setOpen({ kind: 'addCd' }) },
    ...(ci ? [] : [{ label: 'Cloud-Init drive', onSelect: () => setOpen({ kind: 'addCloudInit' }) }]),
    { label: 'Network device', onSelect: () => setOpen({ kind: 'addNic' }) },
    ...(has('efidisk0')
      ? []
      : [
          {
            label: 'EFI disk',
            description: v.bios === 'ovmf' ? undefined : 'For OVMF (UEFI) firmware',
            onSelect: () => setOpen({ kind: 'efi' as const }),
          },
        ]),
    ...(has('tpmstate0') ? [] : [{ label: 'TPM', onSelect: () => setOpen({ kind: 'tpm' as const }) }]),
  ];
  const more = (k: string, items: (ContextMenuItem | false)[]) => (
    <MoreBtn label={k} items={items.filter((x): x is ContextMenuItem => !!x)} />
  );
  const balloon = (x: string | undefined) =>
    x === '0' ? 'Fixed' : x ? `Can shrink to ${mib(x)}` : 'Can shrink';
  return (
    <>
      <Card title="Hardware" link={<AddMenu label={`Add hardware to ${ctx.guest.name}`} items={add} />}>
        <div className={styles.rows}>
          <Row
            title="Memory"
            value={mib(v.memory)}
            next={next('memory', mib)}
            sub={
              `${v.balloon !== undefined ? balloon(v.balloon) : ''}${later('balloon', balloon)}` || undefined
            }
            locked={lock('memory')}
            action={<EditBtn label="memory" onClick={() => setOpen({ kind: 'memory' })} />}
          />
          <Row
            title="Processors"
            value={procWords(v)}
            next={laterWords(cfg, PROC_KEYS, procWords)}
            locked={lock('cores') ?? lock('cpu')}
            action={<EditBtn label="processors" onClick={() => setOpen({ kind: 'cpu' })} />}
          />
          <Row
            title="BIOS"
            value={optionLabel(BIOS_TYPES, v.bios ?? 'seabios')}
            next={next('bios', (x) => optionLabel(BIOS_TYPES, x || 'seabios'))}
            sub={
              v.bios === 'ovmf' && !has('efidisk0')
                ? 'Without an EFI disk its UEFI settings are lost at every start.'
                : undefined
            }
            locked={lock('bios')}
            action={<EditBtn label="BIOS" onClick={() => setOpen({ kind: 'bios' })} />}
          />
          <Row
            title="Display"
            value={vgaWords(v.vga)}
            next={next('vga', vgaWords)}
            locked={lock('vga')}
            action={<EditBtn label="display" onClick={() => setOpen({ kind: 'vga' })} />}
          />
          <Row
            title="Machine"
            value={optionLabel(MACHINE_TYPES, machineType(v.machine))}
            next={next('machine', (x) => optionLabel(MACHINE_TYPES, machineType(x)))}
            locked={lock('machine')}
            action={<EditBtn label="machine type" onClick={() => setOpen({ kind: 'machine' })} />}
          />
          <Row
            title="SCSI controller"
            value={optionLabel(SCSI_CONTROLLERS, v.scsihw ?? 'lsi')}
            next={next('scsihw', (x) => optionLabel(SCSI_CONTROLLERS, x || 'lsi'))}
            locked={lock('scsihw')}
            action={<EditBtn label="SCSI controller" onClick={() => setOpen({ kind: 'scsihw' })} />}
          />
        </div>
      </Card>
      <Card title="Disks and drives">
        <div className={styles.rows}>
          {hds.map((k) => {
            const now = v[k];
            return (
              <Row
                key={k}
                title={`Hard disk (${k})`}
                value={now === undefined ? 'New' : sizeOf(now) || diskFile(now)}
                muted={now === undefined}
                next={next(k, diskLine)}
                sub={[diskFile(now ?? pend[k]), boot[0] === k ? 'starts from it' : '', ...diskOptsWords(now)]
                  .filter(Boolean)
                  .join(' · ')}
                locked={lock(k)}
                action={
                  now === undefined ? undefined : (
                    <>
                      <EditBtn label={`${k} options`} onClick={() => setOpen({ kind: 'disk', key: k })} />
                      {more(k, [
                        { label: 'Grow…', onSelect: () => setOpen({ kind: 'resize', key: k }) },
                        {
                          label: 'Move to another storage…',
                          onSelect: () => setOpen({ kind: 'move', key: k }),
                        },
                        {
                          label: 'Detach…',
                          danger: true,
                          onSelect: () => setOpen({ kind: 'detach', key: k }),
                        },
                      ])}
                    </>
                  )
                }
              />
            );
          })}
          {cds.map((k) => {
            const now = v[k];
            const cloud = isCloudInitDrive(drive(k));
            return (
              <Row
                key={k}
                title={cloud ? `Cloud-Init drive (${k})` : `CD/DVD drive (${k})`}
                value={now === undefined ? 'New' : cloud ? diskFile(now) : discName(diskFile(now))}
                mono={cloud && now !== undefined}
                muted={now === undefined}
                next={next(k, (x) => (cloud ? diskFile(x) : discName(diskFile(x))))}
                sub={
                  cloud
                    ? 'Its settings are on the Cloud-Init tab.'
                    : volumeStorage(diskFile(now)) || undefined
                }
                locked={lock(k)}
                action={
                  now === undefined ? undefined : (
                    <>
                      {cloud ? null : <EditBtn label={k} onClick={() => setOpen({ kind: 'cd', key: k })} />}
                      {more(k, [
                        {
                          label: 'Remove…',
                          danger: true,
                          onSelect: () => setOpen({ kind: 'remove', key: k }),
                        },
                      ])}
                    </>
                  )
                }
              />
            );
          })}
          {(['efidisk0', 'tpmstate0'] as const).filter(has).map((k) => {
            const now = v[k];
            const blocked = moveBlocked(cfg, k);
            return (
              <Row
                key={k}
                title={k === 'efidisk0' ? 'EFI disk' : 'TPM'}
                value={now === undefined ? 'New' : diskFile(now)}
                mono={now !== undefined}
                muted={now === undefined}
                next={next(k, diskFile)}
                sub={efiWords(now ?? pend[k]) || undefined}
                locked={lock(k)}
                action={
                  now === undefined
                    ? undefined
                    : more(k, [
                        {
                          label: 'Move to another storage…',
                          description: blocked ? 'Only while the VM is off' : undefined,
                          onSelect: () => setOpen({ kind: 'move', key: k }),
                        },
                        {
                          label: 'Remove…',
                          danger: true,
                          onSelect: () => setOpen({ kind: 'detach', key: k }),
                        },
                      ])
                }
              />
            );
          })}
          <UnusedRows ctx={ctx} setOpen={setOpen} />
          {!hds.length && !cds.length ? <Row title="No disks" value="" /> : null}
        </div>
      </Card>
      <Card title="Network">
        <div className={styles.rows}>
          <NicRows ctx={ctx} setOpen={setOpen} />
        </div>
      </Card>
      <Card title="Boot order">
        <div className={styles.rows}>
          <Row
            title="Starts from"
            value={bootOrder(v.boot).join(' → ') || 'The default order'}
            next={next('boot', (x) => bootOrder(x).join(' → ') || 'the default order')}
            mono
            locked={lock('boot')}
            action={<EditBtn label="boot order" onClick={() => setOpen({ kind: 'boot' })} />}
          />
        </div>
      </Card>
    </>
  );
}

function vgaWords(x: string | undefined): string {
  if (!x) return 'Default';
  const rest = parseProps(x, 'type')
    .filter((i) => i.key !== 'type')
    .map((i) => (i.key === 'memory' ? `${i.value} MiB video memory` : `${i.key}=${i.value}`));
  return [optionLabel(VGA_TYPES, typeOf(x), typeOf(x)), ...rest].join(' · ');
}

function diskLine(x: string): string {
  return [sizeOf(x), volumeStorage(diskFile(x)), ...diskOptsWords(x)].filter(Boolean).join(' · ');
}

function efiWords(x: string | undefined): string {
  return parseProps(x ?? '', 'file')
    .flatMap((i) =>
      i.key === 'pre-enrolled-keys' && i.value === '1'
        ? ['Secure Boot keys enrolled']
        : i.key === 'version'
          ? [`version ${i.value.replace(/^v/, '')}`]
          : [],
    )
    .join(' · ');
}

function UnusedRows({ ctx, setOpen }: { ctx: EditCtx; setOpen: SetOpen }) {
  const cfg = ctx.config;
  const { next } = useRows(ctx);
  return (
    <>
      {keysOf(cfg, UNUSED_RE).map((k) => (
        <Row
          key={k}
          title={`Unused disk (${k})`}
          value={diskFile(cfg.values[k])}
          mono
          next={next(k, diskFile)}
          sub="Not attached: it still takes space on its storage."
          action={
            <>
              <EditBtn label={k} text="Attach…" onClick={() => setOpen({ kind: 'attach', key: k })} />
              <EditBtn
                label={k}
                text="Delete…"
                serious
                onClick={() => setOpen({ kind: 'deleteUnused', key: k })}
              />
            </>
          }
        />
      ))}
    </>
  );
}

function NicRows({ ctx, setOpen }: { ctx: EditCtx; setOpen: SetOpen }) {
  const { cfg, lock, next } = useRows(ctx);
  const kind = cfg.kind;
  const nics = keysOf(cfg, NET_RE);
  return (
    <>
      {nics.map((k) => {
        const now = cfg.values[k];
        return (
          <Row
            key={k}
            title={`Network device (${k})`}
            value={now === undefined ? 'New' : nicWords(now, kind)}
            muted={now === undefined}
            next={next(k, (x) => nicWords(x, kind))}
            sub={nicDetails(now ?? cfg.pending?.[k], kind) || undefined}
            locked={lock(k)}
            action={
              now === undefined ? undefined : (
                <>
                  <EditBtn label={k} onClick={() => setOpen({ kind: 'nic', key: k })} />
                  <MoreBtn
                    label={k}
                    items={[
                      { label: 'Remove…', danger: true, onSelect: () => setOpen({ kind: 'remove', key: k }) },
                    ]}
                  />
                </>
              )
            }
          />
        );
      })}
      {!nics.length ? <Row title="No network device" value="" /> : null}
    </>
  );
}

function CtCards({ ctx, setOpen }: { ctx: EditCtx; setOpen: SetOpen }) {
  const { cfg, lock, next, later } = useRows(ctx);
  const v = cfg.values;
  const blocked = moveBlocked(cfg, 'rootfs');
  const moveItem = (k: string): ContextMenuItem => ({
    label: 'Move to another storage…',
    description: blocked ? 'Only while it’s stopped' : undefined,
    onSelect: () => setOpen({ kind: 'move', key: k }),
  });
  const add: ContextMenuItem[] = [
    { label: 'Mount point', onSelect: () => setOpen({ kind: 'addMp' }) },
    { label: 'Network device', onSelect: () => setOpen({ kind: 'addNic' }) },
  ];
  const cores = (x: string | undefined) =>
    x ? `${x} ${x === '1' ? 'core' : 'cores'}` : 'All the server’s cores';
  const mps = keysOf(cfg, MP_RE);
  return (
    <>
      <Card title="Resources" link={<AddMenu label={`Add to ${ctx.guest.name}`} items={add} />}>
        <div className={styles.rows}>
          <Row
            title="Memory"
            value={mib(v.memory)}
            next={next('memory', mib)}
            sub={`Swap ${mib(v.swap)}${later('swap', mib)}`}
            locked={lock('memory')}
            action={<EditBtn label="memory" onClick={() => setOpen({ kind: 'memory' })} />}
          />
          <Row
            title="Processors"
            value={cores(v.cores)}
            next={rowValue(cfg, 'cores').removed ? cores(undefined) : next('cores', cores)}
            sub={
              [v.cpulimit ? `limit ${v.cpulimit}` : '', v.cpuunits ? `weight ${v.cpuunits}` : '']
                .filter(Boolean)
                .join(' · ') + later('cpulimit', (x) => (x ? `limit ${x}` : 'no limit')) || undefined
            }
            locked={lock('cores')}
            action={<EditBtn label="processors" onClick={() => setOpen({ kind: 'cpu' })} />}
          />
          {'rootfs' in v ? (
            <Row
              title="Root disk"
              value={sizeOf(v.rootfs) || diskFile(v.rootfs)}
              sub={[diskFile(v.rootfs), ...diskOptsWords(v.rootfs)].join(' · ')}
              locked={lock('rootfs')}
              action={
                <MoreBtn
                  label="rootfs"
                  items={[
                    { label: 'Grow…', onSelect: () => setOpen({ kind: 'resize', key: 'rootfs' }) },
                    moveItem('rootfs'),
                  ]}
                />
              }
            />
          ) : null}
          {mps.map((k) => {
            const now = v[k];
            const val = now ?? cfg.pending?.[k];
            const bind = isBindMount(val);
            return (
              <Row
                key={k}
                title={`Mount point (${k})`}
                value={now === undefined ? 'New' : readMount(now).path || diskFile(now)}
                mono={now !== undefined}
                muted={now === undefined}
                next={next(k, (x) => readMount(x).path)}
                sub={[
                  bind ? 'from the server' : sizeOf(val),
                  diskFile(val),
                  readMount(val).backup ? 'in backups' : 'left out of backups',
                  ...diskOptsWords(val, ['mp', 'backup']),
                ]
                  .filter(Boolean)
                  .join(' · ')}
                locked={lock(k) ?? (bind ? platformName(cfg) : undefined)}
                action={
                  now === undefined ? undefined : (
                    <>
                      <EditBtn label={k} onClick={() => setOpen({ kind: 'mp', key: k })} />
                      <MoreBtn
                        label={k}
                        items={[
                          { label: 'Grow…', onSelect: () => setOpen({ kind: 'resize', key: k }) },
                          moveItem(k),
                          {
                            label: 'Detach…',
                            danger: true,
                            onSelect: () => setOpen({ kind: 'detach', key: k }),
                          },
                        ]}
                      />
                    </>
                  )
                }
              />
            );
          })}
          <UnusedRows ctx={ctx} setOpen={setOpen} />
        </div>
      </Card>
      <Card title="Network">
        <div className={styles.rows}>
          <NicRows ctx={ctx} setOpen={setOpen} />
          <Row
            title="DNS"
            value={v.searchdomain ?? (v.nameserver ? 'No domain' : 'The server’s settings')}
            muted={!v.searchdomain && !v.nameserver}
            mono={!!v.searchdomain}
            next={next('searchdomain', (x) => x) ?? next('nameserver', (x) => `servers ${x}`)}
            sub={v.nameserver ? `Servers ${v.nameserver}` : undefined}
            locked={lock('searchdomain') ?? lock('nameserver')}
            action={<EditBtn label="DNS" onClick={() => setOpen({ kind: 'dns' })} />}
          />
        </div>
      </Card>
    </>
  );
}
