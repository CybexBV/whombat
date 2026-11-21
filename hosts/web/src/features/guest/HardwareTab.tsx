// Hardware (Proxmox VM) and Resources (Proxmox container): every device
// and resource as a row with Edit, Add for disks, drives, network devices,
// EFI disk, TPM and mount points, disk actions (resize, move, detach,
// delete unused), the pending-changes banner and the settings only
// Proxmox itself may change (docs/MANAGE.md, Editing).

import { type ReactNode, useState } from 'react';
import { type GuestConfig, useChoices, useGuestConfig } from '../../api/manage';
import { Skeleton } from '../../components/common';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { Menu, type MenuItem } from '../../components/Menu';
import { t, tn } from '../../lib/i18n';
import { bootOrder, DISK_RE, diskFile, diskSize, formatSize, isCdrom, keysOf, mibText, nicModel, parseIpConfig, rowValue } from './config';
import { SelectDialog } from './dialogs';
import type { EditCtx } from './EditDialog';
import type { GuestTabProps } from './GuestPage';
import {
  AddDiskDialog,
  CloudInitDriveDialog,
  AttachDialog,
  CdromDialog,
  CtCoresDialog,
  CtMemoryDialog,
  CtNicDialog,
  DnsDialog,
  EditDiskDialog,
  EfiDiskDialog,
  MountPointDialog,
  MoveDialog,
  RemoveDialog,
  ResizeDialog,
  TpmDialog,
  VmMemoryDialog,
  VmNicDialog,
  VmProcessorsDialog,
} from './hardwareDialogs';
import { CfgCard, CfgRow, EditButton, RestrictedCard } from './parts';
import { PendingBanner } from './PendingBanner';
import { editProps, getProp, isOn, parseProps } from './props';

type Open =
  | { kind: 'memory' | 'cpu' | 'bios' | 'vga' | 'machine' | 'scsihw' | 'addDisk' | 'addCd' | 'addCloudInit' | 'addNic' | 'efi' | 'tpm' | 'addMp' | 'dns' }
  | { kind: 'disk' | 'cd' | 'nic' | 'mp' | 'resize' | 'move' | 'detach' | 'remove' | 'deleteUnused' | 'attach'; key: string };

export function HardwareTab({ serverId, guest }: GuestTabProps) {
  const config = useGuestConfig(serverId, guest.id);
  const choices = useChoices(serverId, 'pve');
  const [open, setOpen] = useState<Open | null>(null);
  const title = guest.kind === 'vm' ? t('Hardware') : t('Resources');
  if (!config.data) {
    return config.isError ? (
      <div className="card card-body">
        <InlineRetry title={t('Could not load the configuration')} error={config.error} onRetry={() => void config.refetch()} />
      </div>
    ) : (
      <Skeleton height={420} />
    );
  }
  const cfg = config.data;
  const ctx: EditCtx = { serverId, guest, config: cfg };
  const close = () => setOpen(null);
  const c = choices.data;

  let dialog: ReactNode = null;
  if (open) {
    const p = { ctx, onClose: close, choices: c };
    switch (open.kind) {
      case 'memory':
        dialog = cfg.kind === 'vm' ? <VmMemoryDialog {...p} /> : <CtMemoryDialog {...p} />;
        break;
      case 'cpu':
        dialog = cfg.kind === 'vm' ? <VmProcessorsDialog {...p} /> : <CtCoresDialog {...p} />;
        break;
      case 'bios':
        dialog = (
          <SelectDialog
            {...p}
            cfgKey="bios"
            title={t('Edit BIOS')}
            label={t('BIOS of {name}', { name: guest.name })}
            fieldLabel={t('BIOS')}
            options={[
              { value: 'seabios', label: t('SeaBIOS (default)') },
              { value: 'ovmf', label: t('OVMF (UEFI)') },
            ]}
            hint={(v) => (v === 'ovmf' && !cfg.values.efidisk0 ? t('Add an EFI disk too, or UEFI settings are lost at every start.') : undefined)}
          />
        );
        break;
      case 'vga':
        dialog = (
          <SelectDialog
            {...p}
            cfgKey="vga"
            title={t('Edit display')}
            label={t('Display of {name}', { name: guest.name })}
            fieldLabel={t('Graphic card')}
            options={VGA_OPTIONS}
            read={(cur) => (cur ? (getProp(parseProps(cur, 'type'), 'type') ?? '') : '')}
            write={(v, cur) => (v === '' ? undefined : cur ? editType(cur, v) : v)}
          />
        );
        break;
      case 'machine':
        dialog = (
          <SelectDialog
            {...p}
            cfgKey="machine"
            title={t('Edit machine type')}
            label={t('Machine type of {name}', { name: guest.name })}
            fieldLabel={t('Machine')}
            options={[
              { value: '', label: t('Default (i440fx)') },
              { value: 'q35', label: 'q35' },
            ]}
            read={(cur) => machineType(cur)}
            write={(v, cur) => (v === '' ? undefined : cur ? editType(cur, v) : v)}
            hint={() => t('Changing the machine type can change device names inside the guest.')}
          />
        );
        break;
      case 'scsihw':
        dialog = (
          <SelectDialog
            {...p}
            cfgKey="scsihw"
            title={t('Edit SCSI controller')}
            label={t('SCSI controller of {name}', { name: guest.name })}
            fieldLabel={t('SCSI controller')}
            options={SCSI_OPTIONS}
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
        dialog = cfg.kind === 'vm' ? <VmNicDialog {...p} /> : <CtNicDialog {...p} />;
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
      case 'disk':
        dialog = <EditDiskDialog {...p} diskKey={open.key} />;
        break;
      case 'cd':
        dialog = <CdromDialog {...p} diskKey={open.key} />;
        break;
      case 'nic':
        dialog = cfg.kind === 'vm' ? <VmNicDialog {...p} nicKey={open.key} /> : <CtNicDialog {...p} nicKey={open.key} />;
        break;
      case 'mp':
        dialog = <MountPointDialog {...p} mpKey={open.key} />;
        break;
      case 'resize':
        dialog = <ResizeDialog {...p} diskKey={open.key} />;
        break;
      case 'move':
        dialog = <MoveDialog {...p} diskKey={open.key} />;
        break;
      case 'attach':
        dialog = <AttachDialog {...p} cfgKey={open.key} />;
        break;
      case 'detach':
        dialog = (
          <RemoveDialog
            {...p}
            cfgKey={open.key}
            title={t('Detach {key}?', { key: open.key })}
            description={t('The disk is detached from the guest and stays on its storage as an unused disk. Nothing is deleted.')}
          />
        );
        break;
      case 'remove':
        dialog = <RemoveDialog {...p} cfgKey={open.key} title={t('Remove {key}?', { key: open.key })} description={t('The device is removed from the guest’s configuration.')} />;
        break;
      case 'deleteUnused':
        dialog = (
          <RemoveDialog
            {...p}
            destructive
            cfgKey={open.key}
            title={t('Delete {key}?', { key: open.key })}
            description={t('The volume {volume} is destroyed with everything on it. This cannot be undone.', { volume: diskFile(cfg.values[open.key]) })}
          />
        );
        break;
    }
  }

  return (
    <div className="section guest-tab">
      <PendingBanner serverId={serverId} guest={guest} config={cfg} />
      {cfg.kind === 'vm' ? <VmRows cfg={cfg} setOpen={setOpen} title={title} /> : <CtRows cfg={cfg} setOpen={setOpen} title={title} running={cfg.running} />}
      <RestrictedCard cfg={cfg} platform="Proxmox" skip={cfg.kind === 'container' ? ['ostype', 'unprivileged'] : []} />
      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------- values

const VGA_OPTIONS = [
  { value: '', label: t('Default') },
  { value: 'std', label: t('Standard VGA') },
  { value: 'vmware', label: t('VMware compatible') },
  { value: 'qxl', label: 'SPICE (qxl)' },
  { value: 'virtio', label: 'VirtIO-GPU' },
  { value: 'virtio-gl', label: 'VirGL GPU' },
  { value: 'cirrus', label: 'Cirrus Logic' },
  { value: 'serial0', label: t('Serial terminal 0') },
  { value: 'none', label: t('None') },
];

const SCSI_OPTIONS = [
  { value: 'lsi', label: t('LSI 53C895A (default)') },
  { value: 'lsi53c810', label: 'LSI 53C810' },
  { value: 'virtio-scsi-pci', label: 'VirtIO SCSI' },
  { value: 'virtio-scsi-single', label: 'VirtIO SCSI single' },
  { value: 'megasas', label: 'MegaRAID SAS 8708EM2' },
  { value: 'pvscsi', label: 'VMware PVSCSI' },
];

/** Another device type, keeping the value's other options ("qxl,memory=32" -> "std,memory=32"). */
const editType = (cur: string, type: string) => editProps(cur, { type }, 'type');

/** "q35", "" (i440fx) or a pinned version ("pc-q35-9.2+pve1"). */
function machineType(cur: string | undefined): string {
  const type = cur ? (getProp(parseProps(cur, 'type'), 'type') ?? '') : '';
  return type === 'pc' ? '' : type;
}

function machineText(cur: string | undefined): string {
  const type = machineType(cur);
  if (!type) return t('Default (i440fx)');
  return type;
}

const labelOf = (opts: { value: string; label: string }[], v: string | undefined, fallback: string) => opts.find((o) => o.value === (v ?? ''))?.label ?? v ?? fallback;

/** The items of a disk or device value after the volume ("iothread=1, discard=on"). */
function optsText(v: string | undefined, skip: string[] = ['file', 'size']): string {
  return parseProps(v ?? '', 'file')
    .filter((x) => !skip.includes(x.key))
    .map((x) => (x.bare ? x.value : `${x.key}=${x.value}`))
    .join(', ');
}

function diskText(v: string | undefined): string {
  const size = diskSize(v);
  return `${diskFile(v)}${size ? ` · ${formatSize(size)}` : ''}`;
}

const isoName = (file: string) => (file === 'none' || !file ? t('No medium') : file.includes('/') ? file.slice(file.lastIndexOf('/') + 1) : file);

function nicText(v: string | undefined, vm: boolean): string {
  const items = parseProps(v ?? '');
  const tag = getProp(items, 'tag');
  const head = vm ? nicModel(v).model : (getProp(items, 'name') ?? '');
  const ip = vm ? '' : ipText(v);
  return [head, getProp(items, 'bridge'), tag ? t('VLAN {tag}', { tag }) : '', ip].filter(Boolean).join(' · ');
}

function ipText(v: string | undefined): string {
  const c = parseIpConfig(v);
  const v4 = c.v4 === 'dhcp' ? t('IPv4 DHCP') : c.v4 === 'static' ? c.ip : '';
  const v6 = c.v6 === 'auto' ? t('IPv6 SLAAC') : c.v6 === 'dhcp' ? t('IPv6 DHCP') : c.v6 === 'static' ? c.ip6 : '';
  return [v4, v6].filter(Boolean).join(', ');
}

function nicSub(v: string | undefined, vm: boolean): string {
  const items = parseProps(v ?? '');
  const parts = [
    vm ? nicModel(v).mac : (getProp(items, 'hwaddr') ?? ''),
    isOn(getProp(items, 'firewall')) ? t('firewall') : '',
    isOn(getProp(items, 'link_down')) ? t('disconnected') : '',
    getProp(items, 'rate') ? t('{n} MB/s', { n: getProp(items, 'rate')! }) : '',
    getProp(items, 'mtu') ? `MTU ${getProp(items, 'mtu')}` : '',
    !vm && getProp(items, 'gw') ? t('gateway {ip}', { ip: getProp(items, 'gw')! }) : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- rows

interface RowsProps {
  cfg: GuestConfig;
  setOpen: (o: Open) => void;
  title: string;
}

/** Value and pending value of a key, formatted. */
function rowsOf(cfg: GuestConfig) {
  return (key: string, fmt: (v: string | undefined) => string) => {
    const r = rowValue(cfg, key);
    return { value: fmt(r.value), next: r.next === undefined ? undefined : r.removed ? '' : fmt(r.next), unset: r.value === undefined };
  };
}

function RowMenu({ what, items }: { what: string; items: (MenuItem | false)[] }) {
  return <Menu label={t('More for {name}', { name: what })} items={items} buttonClassName="btn-ghost btn-icon row-action" floating />;
}

function VmRows({ cfg, setOpen, title }: RowsProps) {
  const row = rowsOf(cfg);
  const restricted = new Set(cfg.restricted ?? []);
  const v = cfg.values;
  const sockets = Number(v.sockets ?? 1);
  const cores = Number(v.cores ?? 1);
  const cpuType = v.cpu ? (getProp(parseProps(v.cpu, 'cputype'), 'cputype') ?? v.cpu) : t('Default (kvm64)');
  const balloon = v.balloon;
  const disks = keysOf(cfg, DISK_RE).filter((k) => !restricted.has(k));
  const cds = disks.filter((k) => isCdrom(cfg.pending?.[k] ?? v[k]));
  const hds = disks.filter((k) => !cds.includes(k));
  const nets = keysOf(cfg, /^net\d+$/).filter((k) => !restricted.has(k));
  const unused = keysOf(cfg, /^unused\d+$/);
  const boot = bootOrder(v.boot);
  const mem = row('memory', (x) => mibText(Number(x ?? 512)));
  const cpuNext = ['sockets', 'cores', 'cpu'].some((k) => row(k, String).next !== undefined);
  const procs = (s: number, c: number, type: string) =>
    s > 1 ? t('{sockets} sockets × {cores} cores · {type}', { sockets: s, cores: c, type }) : tn(c, '{n} core · {type}', '{n} cores · {type}', { type });
  const pend = cfg.pending ?? {};
  const hasCloudInit = [...Object.values(v), ...Object.values(pend)].some((x) => /(^|[:/-])cloudinit(,|$)/.test(x.split(',')[0] ?? ''));
  const pc = (k: string, fallback: string | undefined) => pend[k] ?? fallback;

  const add: MenuItem[] = [
    { label: t('Hard disk'), icon: 'drive', onSelect: () => setOpen({ kind: 'addDisk' }) },
    { label: t('CD/DVD drive'), icon: 'drive', onSelect: () => setOpen({ kind: 'addCd' }) },
    {
      label: t('Cloud-Init drive'),
      icon: 'drive',
      disabled: hasCloudInit,
      title: hasCloudInit ? t('The guest has one') : undefined,
      onSelect: () => setOpen({ kind: 'addCloudInit' }),
    },
    { label: t('Network device'), icon: 'globe', onSelect: () => setOpen({ kind: 'addNic' }) },
    { label: t('EFI disk'), icon: 'key', disabled: 'efidisk0' in v || 'efidisk0' in pend, title: 'efidisk0' in v ? t('The guest has one') : undefined, onSelect: () => setOpen({ kind: 'efi' }) },
    { label: t('TPM'), icon: 'shield', disabled: 'tpmstate0' in v || 'tpmstate0' in pend, title: 'tpmstate0' in v ? t('The guest has one') : undefined, onSelect: () => setOpen({ kind: 'tpm' }) },
  ];

  return (
    <CfgCard
      title={title}
      id="cfg-hardware"
      actions={
        <Menu label={t('Add hardware')} items={add} buttonClassName="btn-ghost row-action" floating>
          <Icon name="plus" size={14} />
          {t('Add')}
        </Menu>
      }
    >
      <CfgRow
        label={t('Memory')}
        next={mem.next}
        sub={balloon === '0' ? t('Ballooning off') : balloon ? t('Ballooning down to {size}', { size: mibText(Number(balloon)) }) : undefined}
        actions={<EditButton what={t('memory')} onClick={() => setOpen({ kind: 'memory' })} />}
      >
        {mem.value}
      </CfgRow>
      <CfgRow
        label={t('Processors')}
        next={cpuNext ? procs(Number(pc('sockets', v.sockets) ?? 1), Number(pc('cores', v.cores) ?? 1), pc('cpu', v.cpu)?.split(',')[0] ?? t('Default (kvm64)')) : undefined}
        sub={[v.vcpus ? t('{n} vCPUs', { n: v.vcpus }) : '', v.cpulimit ? t('limit {n}', { n: v.cpulimit }) : '', v.cpuunits ? t('units {n}', { n: v.cpuunits }) : '', isOn(v.numa) ? 'NUMA' : ''].filter(Boolean).join(' · ') || undefined}
        actions={<EditButton what={t('processors')} onClick={() => setOpen({ kind: 'cpu' })} />}
      >
        {procs(sockets, cores, cpuType)}
      </CfgRow>
      <SimpleRow cfg={cfg} k="bios" label={t('BIOS')} fmt={(x) => (x === 'ovmf' ? t('OVMF (UEFI)') : t('SeaBIOS (default)'))} onEdit={() => setOpen({ kind: 'bios' })} what={t('BIOS')} />
      <SimpleRow cfg={cfg} k="vga" label={t('Display')} fmt={(x) => (x ? `${labelOf(VGA_OPTIONS, getProp(parseProps(x, 'type'), 'type'), x)}${optsText(x, ['type']) ? ` · ${optsText(x, ['type'])}` : ''}` : t('Default'))} onEdit={() => setOpen({ kind: 'vga' })} what={t('display')} />
      <SimpleRow cfg={cfg} k="machine" label={t('Machine')} fmt={machineText} onEdit={() => setOpen({ kind: 'machine' })} what={t('machine type')} />
      <SimpleRow cfg={cfg} k="scsihw" label={t('SCSI controller')} fmt={(x) => labelOf(SCSI_OPTIONS, x ?? 'lsi', x ?? '')} onEdit={() => setOpen({ kind: 'scsihw' })} what={t('SCSI controller')} />
      {cds.map((k) => {
        const r = row(k, (x) => (/cloudinit/.test(diskFile(x)) ? diskFile(x) : isoName(diskFile(x))));
        const ci = /cloudinit/.test(v[k] ?? '');
        return (
          <CfgRow
            key={k}
            label={ci ? t('Cloud-Init drive ({key})', { key: k }) : t('CD/DVD drive ({key})', { key: k })}
            next={r.next}
            muted={r.unset}
            actions={
              ci ? undefined : (
                <>
                  <EditButton what={k} onClick={() => setOpen({ kind: 'cd', key: k })} />
                  <RowMenu what={k} items={[{ label: t('Remove…'), icon: 'trash', danger: true, onSelect: () => setOpen({ kind: 'remove', key: k }) }]} />
                </>
              )
            }
          >
            <span className="mono">{r.unset ? t('(new)') : r.value}</span>
          </CfgRow>
        );
      })}
      {hds.map((k) => {
        const r = row(k, diskText);
        return (
          <CfgRow
            key={k}
            label={t('Hard disk ({key})', { key: k })}
            next={r.next}
            muted={r.unset}
            sub={[boot.includes(k) ? t('boot') : '', optsText(v[k])].filter(Boolean).join(' · ') || undefined}
            actions={
              <>
                <EditButton what={k} onClick={() => setOpen({ kind: 'disk', key: k })} />
                <RowMenu
                  what={k}
                  items={[
                    { label: t('Resize…'), icon: 'plus', disabled: r.unset, onSelect: () => setOpen({ kind: 'resize', key: k }) },
                    { label: t('Move storage…'), icon: 'swap', disabled: r.unset, onSelect: () => setOpen({ kind: 'move', key: k }) },
                    { label: t('Detach…'), icon: 'close', danger: true, onSelect: () => setOpen({ kind: 'detach', key: k }) },
                  ]}
                />
              </>
            }
          >
            <span className="mono">{r.unset ? t('(new)') : r.value}</span>
          </CfgRow>
        );
      })}
      {nets.map((k) => {
        const r = row(k, (x) => nicText(x, true));
        return (
          <CfgRow
            key={k}
            label={t('Network device ({key})', { key: k })}
            next={r.next}
            muted={r.unset}
            sub={nicSub(v[k], true) || undefined}
            actions={
              <>
                <EditButton what={k} onClick={() => setOpen({ kind: 'nic', key: k })} />
                <RowMenu what={k} items={[{ label: t('Remove…'), icon: 'trash', danger: true, onSelect: () => setOpen({ kind: 'remove', key: k }) }]} />
              </>
            }
          >
            {r.unset ? t('(new)') : r.value}
          </CfgRow>
        );
      })}
      {(['efidisk0', 'tpmstate0'] as const)
        .filter((k) => k in v || k in pend)
        .map((k) => {
          const r = row(k, (x) => diskFile(x));
          return (
            <CfgRow
              key={k}
              label={k === 'efidisk0' ? t('EFI disk') : t('TPM state')}
              next={r.next}
              sub={optsText(v[k]) || undefined}
              actions={
                <RowMenu
                  what={k}
                  items={[
                    { label: t('Move storage…'), icon: 'swap', disabled: r.unset, onSelect: () => setOpen({ kind: 'move', key: k }) },
                    { label: t('Remove…'), icon: 'trash', danger: true, onSelect: () => setOpen({ kind: 'remove', key: k }) },
                  ]}
                />
              }
            >
              <span className="mono">{r.unset ? t('(new)') : r.value}</span>
            </CfgRow>
          );
        })}
      <UnusedRows cfg={cfg} keys={unused} setOpen={setOpen} attach />
    </CfgCard>
  );
}

function UnusedRows({ cfg, keys, setOpen, attach }: { cfg: GuestConfig; keys: string[]; setOpen: (o: Open) => void; attach?: boolean }) {
  return keys.map((k) => (
    <CfgRow
      key={k}
      label={t('Unused disk ({key})', { key: k })}
      next={rowValue(cfg, k).removed ? '' : undefined}
      actions={
        <>
          {attach && <EditButton what={k} text={t('Attach…')} onClick={() => setOpen({ kind: 'attach', key: k })} />}
          <button type="button" className="btn-ghost row-action is-serious" onClick={() => setOpen({ kind: 'deleteUnused', key: k })}>
            {t('Delete…')}
            <span className="sr-only"> {k}</span>
          </button>
        </>
      }
    >
      <span className="mono">{diskFile(cfg.values[k])}</span>
    </CfgRow>
  ));
}

function SimpleRow({ cfg, k, label, fmt, onEdit, what }: { cfg: GuestConfig; k: string; label: string; fmt: (v: string | undefined) => string; onEdit: () => void; what: string }) {
  const r = rowValue(cfg, k);
  return (
    <CfgRow label={label} next={r.next === undefined ? undefined : fmt(r.removed ? undefined : r.next)} actions={<EditButton what={what} onClick={onEdit} />}>
      {fmt(r.value)}
    </CfgRow>
  );
}

function CtRows({ cfg, setOpen, title, running }: RowsProps & { running: boolean }) {
  const row = rowsOf(cfg);
  const restricted = new Set(cfg.restricted ?? []);
  const v = cfg.values;
  const mps = keysOf(cfg, /^mp\d+$/).filter((k) => !restricted.has(k));
  const nets = keysOf(cfg, /^net\d+$/).filter((k) => !restricted.has(k));
  const unused = keysOf(cfg, /^unused\d+$/);
  const mem = row('memory', (x) => mibText(Number(x ?? 512)));
  const cores = row('cores', (x) => (x ? x : t('All host cores')));
  const moveNote = running ? t('Stop the container to move its volumes') : undefined;
  const add: MenuItem[] = [
    { label: t('Mount point'), icon: 'drive', onSelect: () => setOpen({ kind: 'addMp' }) },
    { label: t('Network device'), icon: 'globe', onSelect: () => setOpen({ kind: 'addNic' }) },
  ];
  const diskActions = (k: string, detach: boolean): (MenuItem | false)[] => [
    { label: t('Resize…'), icon: 'plus', onSelect: () => setOpen({ kind: 'resize', key: k }) },
    { label: t('Move storage…'), icon: 'swap', disabled: running, title: moveNote, onSelect: () => setOpen({ kind: 'move', key: k }) },
    detach && { label: t('Detach…'), icon: 'close', danger: true, onSelect: () => setOpen({ kind: 'detach', key: k }) },
  ];
  return (
    <CfgCard
      title={title}
      id="cfg-hardware"
      actions={
        <Menu label={t('Add a resource')} items={add} buttonClassName="btn-ghost row-action" floating>
          <Icon name="plus" size={14} />
          {t('Add')}
        </Menu>
      }
    >
      <CfgRow label={t('Memory')} next={mem.next} sub={t('Swap {size}', { size: mibText(Number(v.swap ?? 512)) })} actions={<EditButton what={t('memory')} onClick={() => setOpen({ kind: 'memory' })} />}>
        {mem.value}
      </CfgRow>
      <CfgRow
        label={t('Cores')}
        next={cores.next}
        sub={[v.cpulimit ? t('limit {n}', { n: v.cpulimit }) : '', v.cpuunits ? t('units {n}', { n: v.cpuunits }) : ''].filter(Boolean).join(' · ') || undefined}
        actions={<EditButton what={t('cores')} onClick={() => setOpen({ kind: 'cpu' })} />}
      >
        {cores.value}
      </CfgRow>
      {'rootfs' in v && (
        <CfgRow label={t('Root disk')} sub={optsText(v.rootfs) || undefined} actions={<RowMenu what="rootfs" items={diskActions('rootfs', false)} />}>
          <span className="mono">{diskText(v.rootfs)}</span>
        </CfgRow>
      )}
      {mps.map((k) => {
        const r = row(k, diskText);
        const path = getProp(parseProps(cfg.pending?.[k] ?? v[k] ?? '', 'file'), 'mp');
        return (
          <CfgRow
            key={k}
            label={t('Mount point ({key})', { key: k })}
            next={r.next}
            muted={r.unset}
            sub={[path ? t('at {path}', { path }) : '', optsText(v[k], ['file', 'size', 'mp'])].filter(Boolean).join(' · ') || undefined}
            actions={
              <>
                <EditButton what={k} onClick={() => setOpen({ kind: 'mp', key: k })} />
                <RowMenu what={k} items={r.unset ? [diskActions(k, true)[2]!] : diskActions(k, true)} />
              </>
            }
          >
            <span className="mono">{r.unset ? t('(new)') : r.value}</span>
          </CfgRow>
        );
      })}
      {nets.map((k) => {
        const r = row(k, (x) => nicText(x, false));
        return (
          <CfgRow
            key={k}
            label={t('Network device ({key})', { key: k })}
            next={r.next}
            muted={r.unset}
            sub={nicSub(v[k], false) || undefined}
            actions={
              <>
                <EditButton what={k} onClick={() => setOpen({ kind: 'nic', key: k })} />
                <RowMenu what={k} items={[{ label: t('Remove…'), icon: 'trash', danger: true, onSelect: () => setOpen({ kind: 'remove', key: k }) }]} />
              </>
            }
          >
            {r.unset ? t('(new)') : r.value}
          </CfgRow>
        );
      })}
      <CfgRow
        label={t('DNS')}
        muted={!v.searchdomain && !v.nameserver}
        actions={<EditButton what={t('DNS')} onClick={() => setOpen({ kind: 'dns' })} />}
        sub={v.nameserver ? t('Servers {list}', { list: v.nameserver }) : undefined}
      >
        {v.searchdomain || v.nameserver ? (v.searchdomain ?? t('No domain')) : t('The host’s settings')}
      </CfgRow>
      <UnusedRows cfg={cfg} keys={unused} setOpen={setOpen} />
    </CfgCard>
  );
}
