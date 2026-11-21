/**
 * A libvirt VM's Hardware (Whombat incus-unraid.md IU-13; AP-1651): the Proxmox tab's cards (AP-1387) in libvirt's
 * keys — memory and processors with the CPU mode, firmware, TPM, machine and display locked (“Change this in
 * virt-manager” or “in Unraid’s VM page”), disks with Grow and Detach (the file stays), CD/DVD drives with their disc,
 * network cards with their cable, the boot order, passed-through devices (locked) and the settings no row shows. Every
 * row says what it becomes at the VM's next start; every change goes through the review.
 */
import {
  currentValue,
  displayWords,
  firmwareWords,
  hostdevWords,
  isRestricted,
  keysOf,
  LIBVIRT_LATER,
  LV_CDROM_RE,
  LV_DISK_RE,
  LV_HOSTDEV_RE,
  LV_NET_RE,
  laterWords,
  libvirtOtherKeys,
  lvBootOrder,
  lvBootWords,
  lvCdromSource,
  lvCdromWords,
  lvCpuWords,
  lvDiskValue,
  lvDiskWords,
  lvMemoryWords,
  lvNicDetails,
  lvNicWords,
  lvSourcePlace,
  readLvDisk,
  readLvNic,
  rowValue,
  tpmWords,
} from '@whombat/client/hosts';
import { Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { type ContextMenuItem, useRowMenu } from '../../../app/shell/ContextMenu';
import { Icon } from '../../../components/Icon';
import type { EditCtx } from '../guest/EditDialog';
import { EditBtn, LockNote, MoreBtn, Row, useChoices } from '../guest/editParts';
import wa from '../guest/GuestEdit.module.css';
import { RemoveDialog, ResizeDialog } from '../guest/hardwareDialogs';
import { Card } from '../parts';
import styles from '../Things.module.css';
import {
  LvAddDiskDialog,
  LvBootDialog,
  LvCdromDialog,
  LvCpuDialog,
  LvEjectDialog,
  LvLinkDialog,
  LvMemoryDialog,
  LvNicDialog,
} from './LibvirtHardwareDialogs';

type Open =
  | { kind: 'memory' | 'cpu' | 'addDisk' | 'addCd' | 'addNic' | 'boot' }
  | { kind: 'cd' | 'eject' | 'nic' | 'link' | 'resize' | 'detach' | 'remove'; key: string };

export interface LibvirtTabProps {
  ctx: EditCtx;
  /** “virt-manager” or “Unraid’s VM page”: where locked settings are changed. */
  lockPlace: string;
  /** This Whombat itself (IU-02): shown, not changed. */
  readOnly?: boolean;
}

export function LibvirtHardwareTab({ ctx, lockPlace, readOnly }: LibvirtTabProps) {
  const choices = useChoices(ctx);
  const [open, setOpen] = useState<Open | null>(null);
  const cfg = ctx.config;
  const v = cfg.values;
  const pend = cfg.pending ?? {};
  const name = ctx.guest.name;
  const close = () => setOpen(null);
  const p = { ctx, choices, onClose: close };
  const lock = (k: string) => (isRestricted(cfg, k) ? lockPlace : undefined);
  const next = (k: string, fmt: (x: string) => string): string | undefined => {
    const r = rowValue(cfg, k);
    return r.next === undefined ? undefined : r.removed ? '' : fmt(r.next);
  };
  const act = (node: ReactNode) => (readOnly ? undefined : node);
  const disks = keysOf(cfg, LV_DISK_RE);
  const cds = keysOf(cfg, LV_CDROM_RE);
  const nics = keysOf(cfg, LV_NET_RE);
  const hostdevs = keysOf(cfg, LV_HOSTDEV_RE);
  const bootsFromDisk = lvBootOrder(currentValue(cfg, 'boot'))[0] === 'hd';

  let dialog: ReactNode = null;
  if (open)
    switch (open.kind) {
      case 'memory':
        dialog = <LvMemoryDialog {...p} />;
        break;
      case 'cpu':
        dialog = <LvCpuDialog {...p} />;
        break;
      case 'addDisk':
        dialog = <LvAddDiskDialog {...p} />;
        break;
      case 'addCd':
        dialog = <LvCdromDialog {...p} />;
        break;
      case 'addNic':
        dialog = <LvNicDialog {...p} />;
        break;
      case 'boot':
        dialog = <LvBootDialog {...p} />;
        break;
      case 'cd':
        dialog = <LvCdromDialog {...p} k={open.key} />;
        break;
      case 'eject':
        dialog = <LvEjectDialog {...p} k={open.key} />;
        break;
      case 'nic':
        dialog = <LvNicDialog {...p} k={open.key} />;
        break;
      case 'link':
        dialog = <LvLinkDialog {...p} k={open.key} />;
        break;
      case 'resize':
        dialog = <ResizeDialog {...p} k={open.key} />;
        break;
      case 'detach': {
        const src = readLvDisk(currentValue(cfg, open.key)).source;
        dialog = (
          <RemoveDialog
            {...p}
            k={open.key}
            title={`Detach ${open.key} from ${name}?`}
            description={
              <>
                Its file stays where it is (<span className={styles.mono}>{src}</span>); nothing is deleted.
                {cfg.running ? ` ${name} lets go of it when it next starts.` : ''}
              </>
            }
          />
        );
        break;
      }
      case 'remove':
        dialog = (
          <RemoveDialog
            {...p}
            k={open.key}
            title={`Remove ${open.key} from ${name}?`}
            description={
              LV_NET_RE.test(open.key)
                ? `The network card is taken out; ${name} loses that connection${cfg.running ? ' when it next starts' : ''}.`
                : `The CD/DVD drive is taken out${cfg.running ? ` when ${name} next starts` : ''}. The disc’s file stays.`
            }
          />
        );
        break;
    }

  const add: ContextMenuItem[] = [
    { label: 'Hard disk', onSelect: () => setOpen({ kind: 'addDisk' }) },
    { label: 'CD/DVD drive', onSelect: () => setOpen({ kind: 'addCd' }) },
    { label: 'Network device', onSelect: () => setOpen({ kind: 'addNic' }) },
  ];
  const others = libvirtOtherKeys(cfg);

  return (
    <>
      <Card
        title="Hardware"
        link={readOnly ? undefined : <AddMenu label={`Add hardware to ${name}`} items={add} />}
      >
        <div className={styles.rows}>
          <Row
            title="Memory"
            value={lvMemoryWords(v)}
            next={laterWords(cfg, ['memory_mb', 'memory_max_mb'], lvMemoryWords)}
            later={LIBVIRT_LATER}
            locked={lock('memory_mb')}
            action={act(<EditBtn label="memory" onClick={() => setOpen({ kind: 'memory' })} />)}
          />
          <Row
            title="Processors"
            value={lvCpuWords(v)}
            next={laterWords(cfg, ['vcpus', 'vcpus_max', 'cpu_mode'], lvCpuWords)}
            later={LIBVIRT_LATER}
            locked={lock('vcpus') ?? lock('cpu_mode')}
            action={act(<EditBtn label="processors" onClick={() => setOpen({ kind: 'cpu' })} />)}
          />
          <Row title="Firmware" value={firmwareWords(v)} locked={lockPlace} />
          {v.tpm ? <Row title="TPM" value={tpmWords(v.tpm)} locked={lockPlace} /> : null}
          {v.machine ? <Row title="Machine" value={v.machine} locked={lockPlace} /> : null}
          <Row title="Display" value={displayWords(v)} locked={lockPlace} />
        </div>
      </Card>
      <Card title="Disks and drives">
        <div className={styles.rows}>
          {disks.map((k, i) => {
            const now = v[k];
            const d = readLvDisk(now ?? pend[k]);
            return (
              <Row
                key={k}
                title={`Hard disk (${d.target || k})`}
                value={now === undefined ? 'New' : lvDiskValue(now)}
                muted={now === undefined}
                next={next(k, lvDiskValue)}
                later={LIBVIRT_LATER}
                sub={[lvDiskWords(now ?? pend[k]), bootsFromDisk && i === 0 ? 'starts from it' : '']
                  .filter(Boolean)
                  .join(' · ')}
                locked={lock(k)}
                action={
                  now === undefined
                    ? undefined
                    : act(
                        <MoreBtn
                          label={k}
                          items={[
                            { label: 'Grow…', onSelect: () => setOpen({ kind: 'resize', key: k }) },
                            {
                              label: 'Detach…',
                              danger: true,
                              description: 'Its file stays',
                              onSelect: () => setOpen({ kind: 'detach', key: k }),
                            },
                          ]}
                        />,
                      )
                }
              />
            );
          })}
          {cds.map((k) => {
            const now = v[k];
            const src = lvCdromSource(now ?? pend[k]);
            const target = readLvDisk(now ?? pend[k]).target;
            return (
              <Row
                key={k}
                title={`CD/DVD drive (${target || k})`}
                value={now === undefined ? 'New' : lvCdromWords(now)}
                muted={now === undefined || !src}
                next={next(k, lvCdromWords)}
                later={LIBVIRT_LATER}
                sub={src ? lvSourcePlace(src) : 'Empty'}
                locked={lock(k)}
                action={
                  now === undefined
                    ? undefined
                    : act(
                        <>
                          <EditBtn
                            label={k}
                            text={src ? 'Change' : 'Insert…'}
                            onClick={() => setOpen({ kind: 'cd', key: k })}
                          />
                          <MoreBtn
                            label={k}
                            items={[
                              ...(src
                                ? [
                                    {
                                      label: 'Take the disc out',
                                      onSelect: () => setOpen({ kind: 'eject', key: k }),
                                    },
                                  ]
                                : []),
                              {
                                label: 'Remove…',
                                danger: true,
                                onSelect: () => setOpen({ kind: 'remove', key: k }),
                              },
                            ]}
                          />
                        </>,
                      )
                }
              />
            );
          })}
          {!disks.length && !cds.length ? <Row title="No disks" value="" /> : null}
        </div>
      </Card>
      <Card title="Network">
        <div className={styles.rows}>
          {nics.map((k) => {
            const now = v[k];
            const up = readLvNic(now).up;
            return (
              <Row
                key={k}
                title={`Network device (${k})`}
                value={now === undefined ? 'New' : lvNicWords(now)}
                muted={now === undefined}
                next={next(k, lvNicWords)}
                later={LIBVIRT_LATER}
                sub={lvNicDetails(now ?? pend[k]) || undefined}
                locked={lock(k)}
                action={
                  now === undefined
                    ? undefined
                    : act(
                        <>
                          <EditBtn label={k} onClick={() => setOpen({ kind: 'nic', key: k })} />
                          <MoreBtn
                            label={k}
                            items={[
                              {
                                label: up ? 'Unplug the cable' : 'Plug the cable in',
                                onSelect: () => setOpen({ kind: 'link', key: k }),
                              },
                              {
                                label: 'Remove…',
                                danger: true,
                                onSelect: () => setOpen({ kind: 'remove', key: k }),
                              },
                            ]}
                          />
                        </>,
                      )
                }
              />
            );
          })}
          {!nics.length ? <Row title="No network device" value="" /> : null}
        </div>
      </Card>
      <Card title="Boot order">
        <div className={styles.rows}>
          <Row
            title="Starts from"
            value={lvBootWords(v.boot)}
            next={next('boot', lvBootWords)}
            later={LIBVIRT_LATER}
            locked={lock('boot')}
            action={act(<EditBtn label="boot order" onClick={() => setOpen({ kind: 'boot' })} />)}
          />
        </div>
      </Card>
      {hostdevs.length ? (
        <Card title="Passed-through devices" meta="The VM has the host’s device to itself">
          <div className={styles.rows}>
            {hostdevs.map((k) => (
              <Row key={k} title={k} value={hostdevWords(v[k])} locked={lockPlace} />
            ))}
          </div>
        </Card>
      ) : null}
      {others.length ? (
        <Card title="Other settings" meta="Shown as they are">
          <div className={styles.rows}>
            {others.map((k) => (
              <div key={k} className={styles.row}>
                <span className={styles.mono} style={{ width: 150, flex: 'none', fontSize: 13 }}>
                  {k}
                </span>
                <div className={styles.rowMain}>
                  <span className={wa.waRaw}>{v[k] ?? pend[k] ?? ''}</span>
                </div>
                <LockNote platform={lockPlace} />
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      {dialog}
    </>
  );
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
