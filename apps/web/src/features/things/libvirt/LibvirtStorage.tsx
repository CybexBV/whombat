/**
 * A QEMU/KVM server's Storage (Whombat incus-unraid.md IU-13; AP-1656, AP-1657): libvirt's storage pools with how full
 * they are, a pool's volumes (New volume…, Grow…, Delete… for one no VM uses, which VMs use the others) and the ISO
 * images of every pool (Download from a link…, Delete… for one no VM has in its drive) — then the server's filesystems
 * and disks as every server shows them. `LvImagesCard` also serves an Unraid server's ISO folder (no pools there).
 * Creating pools and networks stays in virt-manager (IU-10).
 */
import {
  DASH,
  diskUsedLevel,
  downloadUrlError,
  filenameFromUrl,
  formatBytesBinary,
  hostTone,
  isIsoName,
  isoNameError,
  isoTargets,
  type LibvirtVolume,
  libvirtVolumes,
  plural,
  poolRows,
  storageWord,
  volumeNameError,
} from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostGuest, HostServerDetail } from '@whombat/core/domain';
import { Download, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { FormDialog, SelectField, TextField } from '../manage/fields';
import { Card, Empty, ErrorLine, StateCell } from '../parts';
import { useThingSearch } from '../search';
import styles from '../Things.module.css';
import { StorageTab } from '../tabs/StorageTab';
import wq from './Libvirt.module.css';
import { libvirtGuests } from './LibvirtBackups';
import { useLibvirtAccess, useLibvirtManage } from './useLibvirt';

export function UseBar({ pct }: { pct: number | null }) {
  const tone = hostTone(diskUsedLevel(pct));
  return (
    <div
      className={cx(styles.bar, tone === 'warn' && styles.barWarn, tone === 'bad' && styles.barBad)}
      aria-hidden="true"
    >
      <i style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }} />
    </div>
  );
}

export function LibvirtStorage({ burrow, detail }: { burrow: string; detail: HostServerDetail }) {
  const access = useLibvirtAccess(burrow, detail);
  const manage = detail.server.remoteControl.manage === true;
  const rows = poolRows(detail.libvirt);
  return (
    <>
      <Card title="Storage pools" meta={rows.length ? plural(rows.length, 'pool') : undefined}>
        {rows.length ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Pool</th>
                <th scope="col">State</th>
                <th scope="col">Where</th>
                <th scope="col">Used</th>
                <th scope="col">Volumes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.pool.name}>
                  <td>
                    <span className={styles.mono}>{r.pool.name}</span>{' '}
                    <span className={styles.kind}>{r.pool.type}</span>
                  </td>
                  <td>
                    <StateCell tone={r.state} text={r.stateText} />
                  </td>
                  <td className={`${styles.mono} ${styles.muted}`} style={{ fontSize: 12.5 }}>
                    {r.pool.path ?? DASH}
                  </td>
                  <td style={{ minWidth: 180 }}>
                    <span className={styles.num}>{r.usedText}</span>
                    <UseBar pct={r.usedPct} />
                  </td>
                  <td className={styles.num}>{r.pool.volumes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>libvirt has no storage pools on this server.</Empty>
        )}
        <div className={styles.cardNote}>Make or remove pools with virsh or virt-manager.</div>
      </Card>
      {rows.length && manage ? <VolumesCard burrow={burrow} detail={detail} canChange={access.can} /> : null}
      {manage ? <LvImagesCard burrow={burrow} detail={detail} canChange={access.can} /> : null}
      <StorageTab burrow={burrow} detail={detail} />
    </>
  );
}

const usedByWords = (ids: readonly string[], guests: readonly HostGuest[]) =>
  ids.map((id) => guests.find((g) => g.id === id)?.name ?? id.replace(/^libvirt:/, ''));

type VolDialog = { kind: 'new' } | { kind: 'grow' | 'delete'; vol: LibvirtVolume } | null;

function VolumesCard({
  burrow,
  detail,
  canChange,
}: {
  burrow: string;
  detail: HostServerDetail;
  canChange: boolean;
}) {
  const [, set] = useThingSearch();
  const pools = (detail.libvirt?.pools ?? []).filter((p) => p.active);
  const [picked, setPicked] = useState('');
  const pool = picked || pools[0]?.name || '';
  const [dialog, setDialog] = useState<VolDialog>(null);
  const list = useHostManageRead(
    pool
      ? {
          params: { burrow, serverId: detail.server.id },
          query: { op: 'content.list', platform: 'libvirt', storage: pool },
        }
      : null,
  );
  const vols = libvirtVolumes(list.data).filter((v) => !isIsoName(v.name));
  const guests = libvirtGuests(detail);
  return (
    <Card
      title="Volumes"
      meta={list.data ? `${plural(vols.length, 'volume')} on ${pool}` : undefined}
      link={
        canChange ? (
          <Button
            size="sm"
            style={{ marginLeft: 'auto' }}
            iconStart={<Icon icon={Plus} size={14} />}
            onClick={() => setDialog({ kind: 'new' })}
          >
            New volume
          </Button>
        ) : undefined
      }
    >
      {pools.length > 1 ? (
        <div className={styles.toolbar}>
          <SegmentedControl
            options={pools.map((p) => ({ value: p.name, label: p.name }))}
            value={pool}
            onChange={setPicked}
            label="Pool"
            variant="soft"
          />
        </div>
      ) : null}
      {list.error ? (
        <ErrorLine error={list.error} onRetry={() => void list.refetch()} />
      ) : vols.length ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Volume</th>
              <th scope="col">Size</th>
              <th scope="col">On disk</th>
              <th scope="col">Used by</th>
              <th scope="col">
                <span className={styles.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {vols.map((v) => {
              const users = usedByWords(v.usedBy, guests);
              return (
                <tr key={v.volid}>
                  <td>
                    <span className={styles.mono}>{v.name}</span>{' '}
                    <span className={styles.kind}>{v.format}</span>
                  </td>
                  <td className={styles.num}>{formatBytesBinary(v.sizeBytes)}</td>
                  <td className={styles.num}>{formatBytesBinary(v.usedBytes)}</td>
                  <td>
                    {v.usedBy.length ? (
                      v.usedBy.map((id, i) => {
                        const g = guests.find((x) => x.id === id);
                        return (
                          <span key={id}>
                            {i ? ', ' : ''}
                            {g ? (
                              <button
                                type="button"
                                className={styles.name}
                                onClick={() => set({ guest: g.id, gtab: 'hardware' })}
                              >
                                {g.name}
                              </button>
                            ) : (
                              <span className={styles.mono}>{users[i]}</span>
                            )}
                          </span>
                        );
                      })
                    ) : (
                      <span className={styles.muted}>Nothing</span>
                    )}
                  </td>
                  <td>
                    {canChange ? (
                      <span className={wq.wqTools}>
                        <button
                          type="button"
                          className={styles.cardLink}
                          onClick={() => setDialog({ kind: 'grow', vol: v })}
                        >
                          Grow…<span className={styles.srOnly}> {v.name}</span>
                        </button>
                        <button
                          type="button"
                          className={`${styles.iconBtn} ${wq.wqOff}`}
                          aria-label={`Delete ${v.name}`}
                          title={v.usedBy.length ? `Used by ${users.join(', ')}` : 'Delete'}
                          disabled={v.usedBy.length > 0}
                          onClick={() => setDialog({ kind: 'delete', vol: v })}
                        >
                          <Icon icon={Trash2} size={14} />
                        </button>
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <Empty>{list.isLoading ? 'Looking…' : `No volumes on ${pool} yet.`}</Empty>
      )}
      {dialog?.kind === 'new' ? (
        <NewVolumeDialog
          burrow={burrow}
          serverId={detail.server.id}
          pool={pool}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'grow' ? (
        <GrowVolumeDialog
          burrow={burrow}
          serverId={detail.server.id}
          pool={pool}
          vol={dialog.vol}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <DeleteVolumeDialog
          burrow={burrow}
          serverId={detail.server.id}
          pool={pool}
          vol={dialog.vol}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </Card>
  );
}

function NewVolumeDialog({
  burrow,
  serverId,
  pool,
  onClose,
}: {
  burrow: string;
  serverId: string;
  pool: string;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [size, setSize] = useState('20');
  const [format, setFormat] = useState('qcow2');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { send, busy } = useLibvirtManage(burrow, serverId);
  const full =
    name.trim() && !/\.(qcow2|img|raw)$/i.test(name.trim())
      ? `${name.trim()}.${format === 'raw' ? 'img' : 'qcow2'}`
      : name.trim();
  const bad = name ? volumeNameError(full) : undefined;
  const sizeBad = /^\d+$/.test(size.trim()) && Number(size) >= 1 ? undefined : 'Whole GiB, at least 1.';
  return (
    <FormDialog
      title={`New volume on ${pool}`}
      description="An empty disk image you can attach to a VM on its Hardware tab."
      action={busy ? 'Making…' : 'Make it'}
      busy={busy}
      disabled={!name.trim() || !!bad || !!sizeBad}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          setFields({});
          const out = await send({
            op: 'volume.create',
            params: { pool, name: full, size: `${size.trim()}GiB`, format },
            name: full,
            done: `Made ${full} on ${pool}.`,
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
        placeholder="web-data"
        error={bad ?? fields.name}
        hint={full && full !== name.trim() ? `Saved as ${full}.` : undefined}
        onChange={(e) => setName(e.target.value)}
      />
      <div className={styles.formRow}>
        <TextField
          label="Size (GiB)"
          inputMode="numeric"
          value={size}
          error={sizeBad ?? fields.size}
          onChange={(e) => setSize(e.target.value)}
        />
        <SelectField
          label="Format"
          options={[
            { value: 'qcow2', label: 'qcow2 (snapshots, grows as it fills)' },
            { value: 'raw', label: 'raw (takes its whole size now)' },
          ]}
          value={format}
          onChange={(e) => setFormat(e.target.value)}
        />
      </div>
    </FormDialog>
  );
}

function GrowVolumeDialog({
  burrow,
  serverId,
  pool,
  vol,
  onClose,
}: {
  burrow: string;
  serverId: string;
  pool: string;
  vol: LibvirtVolume;
  onClose: () => void;
}) {
  const now = Math.ceil((vol.sizeBytes ?? 0) / 1024 ** 3);
  const [size, setSize] = useState(String(now + 10));
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useLibvirtManage(burrow, serverId);
  const n = Number(size);
  const bad = !/^\d+$/.test(size.trim())
    ? 'Whole GiB.'
    : n <= now
      ? `More than ${now} GiB: volumes only grow.`
      : undefined;
  return (
    <FormDialog
      title={`Grow ${vol.name}`}
      description={`It’s ${formatBytesBinary(vol.sizeBytes)} now. The VM using it sees the new size; its system then extends its partition.`}
      action={busy ? 'Growing…' : 'Grow'}
      busy={busy}
      disabled={!!bad}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'volume.resize',
            params: { pool, volume: vol.name, size: `${size.trim()}GiB` },
            name: vol.name,
            done: `${vol.name} is ${size.trim()} GiB now.`,
          });
          if (out.ok) onClose();
          else setError(out.fields.size ?? out.message);
        })()
      }
    >
      <TextField
        label="New size (GiB)"
        inputMode="numeric"
        value={size}
        autoFocus
        error={bad}
        onChange={(e) => setSize(e.target.value)}
      />
    </FormDialog>
  );
}

function DeleteVolumeDialog({
  burrow,
  serverId,
  pool,
  vol,
  onClose,
}: {
  burrow: string;
  serverId: string;
  pool: string;
  vol: LibvirtVolume;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useLibvirtManage(burrow, serverId);
  return (
    <FormDialog
      title={`Delete ${vol.name}?`}
      description={`It’s removed from ${pool} with everything on it. This can’t be undone.`}
      action={busy ? 'Deleting…' : 'Delete volume'}
      serious
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'volume.delete',
            params: { pool, volume: vol.name },
            confirm: true,
            name: vol.name,
            done: `Deleted ${vol.name}.`,
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    />
  );
}

/* ISO images ------------------------------------------------------------------------------------------ */

/** The ISO images of every pool and of Unraid's ISO folder, with Download from a link… and Delete…. */
export function LvImagesCard({
  burrow,
  detail,
  canChange,
}: {
  burrow: string;
  detail: HostServerDetail;
  canChange: boolean;
}) {
  const [, set] = useThingSearch();
  const lv = detail.libvirt;
  const places = isoTargets(lv);
  const [download, setDownload] = useState(false);
  const [remove, setRemove] = useState<LibvirtVolume | null>(null);
  const guests = libvirtGuests(detail);
  return (
    <Card
      title="ISO images"
      meta="For installing VMs from a CD/DVD"
      link={
        canChange && places.length ? (
          <Button
            size="sm"
            style={{ marginLeft: 'auto' }}
            iconStart={<Icon icon={Download} size={14} />}
            onClick={() => setDownload(true)}
          >
            Download from a link
          </Button>
        ) : undefined
      }
    >
      <ImagesTable
        burrow={burrow}
        serverId={detail.server.id}
        places={places.map((p) => p.value)}
        guests={guests}
        canChange={canChange}
        onOpen={(id) => set({ guest: id, gtab: 'hardware' })}
        onDelete={setRemove}
      />
      {download ? (
        <IsoDownloadDialog
          burrow={burrow}
          serverId={detail.server.id}
          detail={detail}
          onClose={() => setDownload(false)}
        />
      ) : null}
      {remove ? (
        <DeleteIsoDialog
          burrow={burrow}
          serverId={detail.server.id}
          iso={remove}
          onClose={() => setRemove(null)}
        />
      ) : null}
    </Card>
  );
}

/** One `content.list` per pool (and the ISO folder): each place's images in one table. */
function ImagesTable({
  burrow,
  serverId,
  places,
  guests,
  canChange,
  onOpen,
  onDelete,
}: {
  burrow: string;
  serverId: string;
  places: string[];
  guests: readonly HostGuest[];
  canChange: boolean;
  onOpen: (guestId: string) => void;
  onDelete: (v: LibvirtVolume) => void;
}) {
  if (!places.length) return <Empty>libvirt has nowhere to keep ISO images on this server.</Empty>;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th scope="col" className={styles.cellMain}>
            Image
          </th>
          <th scope="col" className={styles.dropM}>
            Where
          </th>
          <th scope="col" className={styles.dropS}>
            Size
          </th>
          <th scope="col" className={styles.dropXs}>
            In the drive of
          </th>
          <th scope="col">
            <span className={styles.srOnly}>Actions</span>
          </th>
        </tr>
      </thead>
      {places.map((p) => (
        <ImageRows
          key={p}
          burrow={burrow}
          serverId={serverId}
          place={p}
          guests={guests}
          canChange={canChange}
          onOpen={onOpen}
          onDelete={onDelete}
        />
      ))}
    </table>
  );
}

function ImageRows({
  burrow,
  serverId,
  place,
  guests,
  canChange,
  onOpen,
  onDelete,
}: {
  burrow: string;
  serverId: string;
  place: string;
  guests: readonly HostGuest[];
  canChange: boolean;
  onOpen: (guestId: string) => void;
  onDelete: (v: LibvirtVolume) => void;
}) {
  const list = useHostManageRead({
    params: { burrow, serverId },
    query: { op: 'content.list', platform: 'libvirt', storage: place, content: 'iso' },
  });
  const isos = libvirtVolumes(list.data).filter((v) => place.startsWith('folder:') || isIsoName(v.name));
  return (
    <tbody>
      {list.error ? (
        <tr>
          <td colSpan={5}>
            <ErrorLine error={list.error} onRetry={() => void list.refetch()} />
          </td>
        </tr>
      ) : !list.data ? (
        <tr>
          <td colSpan={5} className={styles.muted}>
            Looking on {storageWord(place)}…
          </td>
        </tr>
      ) : !isos.length ? (
        <tr>
          <td colSpan={5} className={styles.muted}>
            No ISO images on {storageWord(place)} yet.
          </td>
        </tr>
      ) : (
        isos.map((v) => (
          <tr key={v.volid}>
            <td className={styles.cellMain}>
              <span className={styles.mono} title={v.name}>
                {v.name}
              </span>
            </td>
            <td className={cx(styles.kind, styles.dropM)}>{storageWord(place)}</td>
            <td className={cx(styles.num, styles.dropS)}>{formatBytesBinary(v.sizeBytes)}</td>
            <td className={styles.dropXs}>
              {v.usedBy.length ? (
                v.usedBy.map((id, i) => {
                  const g = guests.find((x) => x.id === id);
                  return (
                    <span key={id}>
                      {i ? ', ' : ''}
                      {g ? (
                        <button type="button" className={styles.name} onClick={() => onOpen(g.id)}>
                          {g.name}
                        </button>
                      ) : (
                        <span className={styles.mono}>{id.replace(/^libvirt:/, '')}</span>
                      )}
                    </span>
                  );
                })
              ) : (
                <span className={styles.muted}>No VM</span>
              )}
            </td>
            <td>
              {canChange ? (
                <button
                  type="button"
                  className={`${styles.iconBtn} ${wq.wqOff}`}
                  aria-label={`Delete ${v.name}`}
                  title={v.usedBy.length ? 'Take it out of the drive first' : 'Delete'}
                  disabled={v.usedBy.length > 0}
                  onClick={() => onDelete(v)}
                >
                  <Icon icon={Trash2} size={14} />
                </button>
              ) : null}
            </td>
          </tr>
        ))
      )}
    </tbody>
  );
}

/** Download an ISO image from a link into a pool or Unraid's ISO folder (the server fetches it; a task). */
export function IsoDownloadDialog({
  burrow,
  serverId,
  detail,
  onClose,
}: {
  burrow: string;
  serverId: string;
  detail: Pick<HostServerDetail, 'libvirt'>;
  onClose: () => void;
}) {
  const places = isoTargets(detail.libvirt);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false);
  const [storage, setStorage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { send, busy } = useLibvirtManage(burrow, serverId);
  const filename = named ? name : filenameFromUrl(url);
  const target = storage || places[0]?.value || '';
  const urlBad = url ? downloadUrlError(url) : undefined;
  const nameBad = filename ? isoNameError(filename) : url ? 'Give the file a name.' : undefined;
  return (
    <FormDialog
      title="Download an ISO image"
      description={`${serverId} fetches the file itself; you can leave this page while it does.`}
      action={busy ? 'Starting…' : 'Download'}
      busy={busy}
      disabled={!url.trim() || !!urlBad || !!nameBad || !target}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          setFields({});
          const out = await send({
            op: 'content.download',
            params: { url: url.trim(), filename: filename.trim(), storage: target },
            name: filename.trim(),
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
        label="Link"
        mono
        value={url}
        autoFocus
        placeholder="https://cdimage.debian.org/…/debian-13.1.0-amd64-netinst.iso"
        error={urlBad ?? fields.url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <div className={styles.formRow}>
        <TextField
          label="Save as"
          mono
          value={filename}
          error={(filename || url ? nameBad : undefined) ?? fields.filename}
          onChange={(e) => {
            setNamed(true);
            setName(e.target.value);
          }}
        />
        <SelectField
          label="On"
          options={places.length ? places : [{ value: '', label: 'Nowhere to save it' }]}
          value={target}
          error={fields.storage}
          onChange={(e) => setStorage(e.target.value)}
        />
      </div>
    </FormDialog>
  );
}

function DeleteIsoDialog({
  burrow,
  serverId,
  iso,
  onClose,
}: {
  burrow: string;
  serverId: string;
  iso: LibvirtVolume;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useLibvirtManage(burrow, serverId);
  return (
    <FormDialog
      title={`Delete ${iso.name}?`}
      description="The image is removed from the server. Download it again if you need it later."
      action={busy ? 'Deleting…' : 'Delete'}
      serious
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'content.delete',
            params: { volume: iso.volid },
            confirm: true,
            name: iso.name,
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    />
  );
}
