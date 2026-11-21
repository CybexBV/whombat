/**
 * An Incus instance's Devices (Whombat incus-unraid.md IU-04; AP-1565): its root disk with its size (Grow), network
 * cards on an Incus network or a host bridge (add, change the network, remove), custom volumes of a pool (attach,
 * detach), and every other device as it is with the lock (a macvlan card, a host folder, a GPU, a proxy: only the incus
 * command changes those). Devices that come from a profile say so and can't be removed here. Every change goes through
 * the review, as `device.<name>` keys (`hosts/docs/MANAGE.md` §2.5).
 */
import {
  deviceWords,
  formatBytesBinary,
  freeDeviceName,
  gibError,
  type IncusDevice,
  incusDevices,
  incusPathError,
  incusRef,
  isRootDisk,
  isSelfGuest,
  nicValue,
  rootDiskBytes,
  volumeContentWord,
  volumeDiskValue,
} from '@whombat/client/hosts';
import type { HostGuestDetail, HostServerDetail } from '@whombat/core/domain';
import { ChevronDown, Plus } from 'lucide-react';
import { useState } from 'react';
import { Icon } from '../../../components/Icon';
import { type EditCtx, EditDialog } from '../guest/EditDialog';
import { EditBtn } from '../guest/editParts';
import { FormDialog, SelectField, TextField } from '../manage/fields';
import { MenuButton } from '../manage/MenuButton';
import { useManage } from '../manage/useManage';
import { Card, Empty } from '../parts';
import styles from '../Things.module.css';
import wi from './Incus.module.css';
import { IncusLock } from './IncusConfigTab';
import { useIncusChoices } from './IncusDialogs';

type Open =
  | { kind: 'nic'; device?: IncusDevice }
  | { kind: 'volume' }
  | { kind: 'grow'; device: IncusDevice }
  | { kind: 'remove'; device: IncusDevice }
  | null;

export function IncusDevicesTab({
  ctx,
  guest,
  detail,
}: {
  ctx: EditCtx;
  guest: HostGuestDetail;
  detail: HostServerDetail;
}) {
  const [open, setOpen] = useState<Open>(null);
  const self = isSelfGuest(guest);
  const devices = incusDevices(ctx.config);
  const rootBytes = rootDiskBytes(ctx.config);
  const close = () => setOpen(null);
  return (
    <>
      <Card
        title="Devices"
        meta={`${devices.length} ${devices.length === 1 ? 'device' : 'devices'}`}
        link={
          self ? undefined : (
            <span style={{ marginLeft: 'auto', display: 'inline-flex' }}>
              <MenuButton
                label={`Add a device to ${guest.name}`}
                size="sm"
                items={[
                  { label: 'Network card…', onSelect: () => setOpen({ kind: 'nic' }) },
                  { label: 'Attach a volume…', onSelect: () => setOpen({ kind: 'volume' }) },
                ]}
              >
                <Icon icon={Plus} size={14} />
                Add
                <Icon icon={ChevronDown} size={14} />
              </MenuButton>
            </span>
          )
        }
      >
        {devices.length ? (
          <div className={styles.rows}>
            {devices.map((d) => {
              const w = deviceWords(d, isRootDisk(d) ? rootBytes : null);
              return (
                <div key={d.name} className={styles.row}>
                  <span className={styles.muted} style={{ width: 150, flex: 'none' }}>
                    {w.title}
                  </span>
                  <div className={styles.rowMain}>
                    <b>{w.sub}</b>
                    <small>
                      <span className={wi.wiMono}>{d.name}</span>
                      {d.inherited ? ' · from a profile' : ''}
                    </small>
                  </div>
                  {d.restricted ? (
                    <IncusLock />
                  ) : self ? null : (
                    <span className={wi.wiActs}>
                      {isRootDisk(d) ? (
                        <EditBtn
                          label="the root disk"
                          text="Grow"
                          onClick={() => setOpen({ kind: 'grow', device: d })}
                        />
                      ) : null}
                      {d.type === 'nic' ? (
                        <EditBtn label={d.name} onClick={() => setOpen({ kind: 'nic', device: d })} />
                      ) : null}
                      {!isRootDisk(d) && !d.inherited ? (
                        <button
                          type="button"
                          className={`${styles.cardLink} ${wi.wiSerious}`}
                          style={{ marginLeft: 0 }}
                          onClick={() => setOpen({ kind: 'remove', device: d })}
                        >
                          {d.type === 'disk' ? 'Detach' : 'Remove'}{' '}
                          <span className={styles.srOnly}>{d.name}</span>
                        </button>
                      ) : null}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <Empty>No devices of its own or from its profiles.</Empty>
        )}
        <p className={styles.cardNote}>
          Network cards on an Incus network or a host bridge and volumes of a storage pool are changed here;
          GPUs, host folders and other devices with the incus command.
        </p>
      </Card>
      {open?.kind === 'nic' ? <NicDialog ctx={ctx} device={open.device} onClose={close} /> : null}
      {open?.kind === 'volume' ? <AttachDialog ctx={ctx} detail={detail} onClose={close} /> : null}
      {open?.kind === 'grow' ? (
        <GrowDialog ctx={ctx} device={open.device} bytes={rootBytes} onClose={close} />
      ) : null}
      {open?.kind === 'remove' ? (
        <EditDialog
          ctx={ctx}
          title={`${open.device.type === 'disk' ? 'Detach' : 'Remove'} ${open.device.name} from ${guest.name}?`}
          description={
            open.device.type === 'disk'
              ? 'The volume stays on its pool with everything on it; only this instance stops using it.'
              : 'It loses this network card; a running instance loses it at once.'
          }
          draft={{ delete: [`device.${open.device.name}`] }}
          onClose={close}
        />
      ) : null}
    </>
  );
}

interface DialogProps {
  ctx: EditCtx;
  onClose: () => void;
}

/** A network card: on one of Incus's networks, or bridged to one of the server's bridges. */
function NicDialog({ ctx, device, onClose }: DialogProps & { device?: IncusDevice }) {
  const choices = useIncusChoices(ctx.burrow, ctx.serverId, incusRef(ctx.guest.id).project);
  const networks = choices?.bridges ?? [];
  const p = device?.props ?? {};
  const [mode, setMode] = useState<'network' | 'bridge'>(p.nictype === 'bridged' ? 'bridge' : 'network');
  const [network, setNetwork] = useState(p.network ?? '');
  const [bridge, setBridge] = useState(p.parent ?? '');
  const name = device?.name ?? freeDeviceName(ctx.config.values, 'eth');
  const inside = p.name ?? name;
  const net = network || networks[0] || '';
  const bridgeErr =
    mode === 'bridge' && !/^[A-Za-z0-9_.-]{1,15}$/.test(bridge.trim())
      ? 'The bridge’s name, like br0.'
      : null;
  const value =
    mode === 'network'
      ? net
        ? nicValue({ network: net, name: inside })
        : null
      : bridgeErr
        ? null
        : nicValue({ bridge: bridge.trim(), name: inside });
  // Keep the card's other options (a fixed address, its MAC) when only the network changes.
  const keep = device
    ? Object.entries(p)
        .filter(([k]) => !['type', 'name', 'network', 'nictype', 'parent'].includes(k))
        .map(([k, v]) => `,${k}=${v}`)
        .join('')
    : '';
  return (
    <EditDialog
      ctx={ctx}
      title={device ? `Network card ${name} of ${ctx.guest.name}` : `Add a network card to ${ctx.guest.name}`}
      description={device ? undefined : `It shows up inside as ${inside}.`}
      draft={value ? { set: { [`device.${name}`]: `${value}${keep}` } } : null}
      onClose={onClose}
    >
      {(errors) => (
        <>
          <SelectField
            label="Connect it to"
            options={[
              { value: 'network', label: 'An Incus network' },
              { value: 'bridge', label: 'A bridge of the server' },
            ]}
            value={mode}
            onChange={(e) => setMode(e.target.value as 'network' | 'bridge')}
          />
          {mode === 'network' ? (
            <SelectField
              label="Network"
              options={
                networks.length
                  ? networks.map((n) => ({ value: n, label: n }))
                  : [{ value: '', label: 'Loading…' }]
              }
              value={net}
              error={errors[`device.${name}`]}
              onChange={(e) => setNetwork(e.target.value)}
            />
          ) : (
            <TextField
              label="Bridge"
              mono
              value={bridge}
              placeholder="br0"
              error={bridgeErr ?? errors[`device.${name}`]}
              hint="One of the server’s own bridges (see its Network tab)."
              onChange={(e) => setBridge(e.target.value)}
            />
          )}
        </>
      )}
    </EditDialog>
  );
}

/** A custom volume of a pool: a folder inside a container, a disk inside a VM. */
function AttachDialog({ ctx, detail, onClose }: DialogProps & { detail: HostServerDetail }) {
  const project = incusRef(ctx.guest.id).project;
  const vm = ctx.config.kind === 'vm';
  const free = (detail.incus?.volumes ?? []).filter(
    (v) =>
      v.project === project && !v.usedBy.includes(ctx.guest.id) && (vm || v.contentType === 'filesystem'),
  );
  const [pick, setPick] = useState(free[0] ? `${free[0].pool}/${free[0].name}` : '');
  const vol = free.find((v) => `${v.pool}/${v.name}` === pick);
  const [path, setPath] = useState(vol ? `/mnt/${vol.name}` : '/mnt/data');
  const needsPath = !vm || vol?.contentType === 'filesystem';
  const pathErr = needsPath ? incusPathError(path) : null;
  const name = vol
    ? `device.${vol.name}` in ctx.config.values
      ? freeDeviceName(ctx.config.values, vol.name)
      : vol.name
    : '';
  return (
    <EditDialog
      ctx={ctx}
      title={`Attach a volume to ${ctx.guest.name}`}
      description="Make volumes on the server’s Storage tab. A volume in use by another instance can be attached too."
      draft={
        vol && !pathErr
          ? {
              set: {
                [`device.${name.replace(/[^A-Za-z0-9._-]/g, '-')}`]: volumeDiskValue({
                  pool: vol.pool,
                  volume: vol.name,
                  ...(needsPath ? { path: path.trim() } : {}),
                }),
              },
            }
          : null
      }
      onClose={onClose}
    >
      {(errors) =>
        free.length ? (
          <>
            <SelectField
              label="Volume"
              options={free.map((v) => ({
                value: `${v.pool}/${v.name}`,
                label: `${v.name} · ${v.pool} · ${volumeContentWord(v.contentType)}${v.sizeBytes != null ? ` · ${formatBytesBinary(v.sizeBytes)}` : ''}${v.usedBy.length ? ' · in use' : ''}`,
              }))}
              value={pick}
              autoFocus
              onChange={(e) => {
                setPick(e.target.value);
                const next = free.find((v) => `${v.pool}/${v.name}` === e.target.value);
                if (next) setPath(`/mnt/${next.name}`);
              }}
            />
            {needsPath ? (
              <TextField
                label="Folder inside"
                mono
                value={path}
                error={pathErr ?? errors[`device.${name}`]}
                onChange={(e) => setPath(e.target.value)}
              />
            ) : null}
          </>
        ) : (
          <p className={styles.dialogBody} style={{ margin: 0 }}>
            {vm
              ? 'There’s no volume in this project to attach. Make one on the server’s Storage tab.'
              : 'There’s no folder volume in this project to attach. Make one on the server’s Storage tab.'}
          </p>
        )
      }
    </EditDialog>
  );
}

/** Grow the root disk by whole GiB (Incus disks only grow). */
function GrowDialog({
  ctx,
  device,
  bytes,
  onClose,
}: DialogProps & { device: IncusDevice; bytes: number | null }) {
  const [add, setAdd] = useState('8');
  const [error, setError] = useState<string | null>(null);
  const bad = gibError(add);
  const { send, busy } = useManage(ctx.burrow, ctx.serverId);
  return (
    <FormDialog
      title={`Grow the root disk of ${ctx.guest.name}`}
      description={`Disks only grow. ${bytes != null ? `It’s ${formatBytesBinary(bytes)} now; ` : ''}${ctx.config.kind === 'vm' ? 'the space inside grows when its system extends its partition.' : 'a container sees the space at once.'}`}
      action={busy ? 'Growing…' : 'Grow'}
      busy={busy}
      disabled={!!bad}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          const out = await send({
            op: 'disk.resize',
            guestId: ctx.guest.id,
            params: { disk: device.name, size: `+${add.trim()}G` },
            name: ctx.guest.name,
            done: `Grew ${ctx.guest.name}’s disk.`,
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
        error={bad}
        hint={
          bytes != null && !bad
            ? `${formatBytesBinary(bytes)} → ${formatBytesBinary(bytes + Number(add) * 1024 ** 3)}`
            : undefined
        }
        onChange={(e) => setAdd(e.target.value)}
      />
    </FormDialog>
  );
}
