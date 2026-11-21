/**
 * An Incus server's storage (Whombat incus-unraid.md IU-04, IU-08; AP-1574): its pools with how full they are (a pool
 * over 85 % warns, as the hint does), then its custom volumes — what kind, how big, which instances use them — with
 * New volume, Grow and Delete (asked; refused while attached). Attaching one is on an instance's Devices tab. Shown at
 * the top of the Storage tab, above the server's own disks.
 */
import {
  DASH,
  diskUsedLevel,
  formatBytesBinary,
  gibError,
  type HostStorageVolume,
  hostTone,
  incusDetail,
  incusDoneText,
  incusObjectNameError,
  incusRef,
  incusSizeString,
  POOL_FULL_PCT,
  poolPct,
  poolUseText,
  volumeContentWord,
} from '@whombat/client/hosts';
import type { HostServerDetail } from '@whombat/core/domain';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { FormDialog, SelectField, TextField } from '../manage/fields';
import { useManage } from '../manage/useManage';
import { Badge, Card, Empty, StateCell } from '../parts';
import { useThingSearch } from '../search';
import styles from '../Things.module.css';
import wi from './Incus.module.css';

function Bar({ pct }: { pct: number | null }) {
  const tone = pct != null && pct >= POOL_FULL_PCT ? 'warn' : hostTone(diskUsedLevel(pct));
  return (
    <div
      className={cx(styles.bar, tone === 'warn' && styles.barWarn, tone === 'bad' && styles.barBad)}
      aria-hidden="true"
    >
      <i style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }} />
    </div>
  );
}

/** Whether this Incus server's objects can be changed (Manage on). */
export function useIncusCanChange(_burrow: string, detail: HostServerDetail): boolean {
  return detail.server.remoteControl.manage === true;
}

export function IncusStorage({ burrow, detail }: { burrow: string; detail: HostServerDetail }) {
  const [, set] = useThingSearch();
  const inc = incusDetail(detail);
  const canChange = useIncusCanChange(burrow, detail);
  const [open, setOpen] = useState<
    { kind: 'new' } | { kind: 'grow' | 'delete'; vol: HostStorageVolume } | null
  >(null);
  if (!inc) return null;
  const close = () => setOpen(null);
  const serverId = detail.server.id;
  return (
    <>
      <Card title="Incus pools">
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.cellMain}>
                Pool
              </th>
              <th scope="col">
                <span className={styles.narrowSr}>State</span>
              </th>
              <th scope="col" className={styles.dropM}>
                Volumes
              </th>
              <th scope="col">Used</th>
            </tr>
          </thead>
          <tbody>
            {inc.pools.map((p) => {
              const pct = poolPct(p);
              return (
                <tr key={p.name}>
                  <td className={styles.cellMain}>
                    <span className={styles.mono}>{p.name}</span>{' '}
                    <span className={styles.kind}>{p.driver}</span>
                    {p.description ? <span className={wi.wiSub}>{p.description}</span> : null}
                  </td>
                  <td>
                    <StateCell
                      tone={/created|ok/i.test(p.status) ? 'ok' : 'bad'}
                      text={/created/i.test(p.status) ? 'Ready' : p.status.toLowerCase()}
                      compact
                    />
                  </td>
                  <td className={cx(styles.num, styles.dropM)}>{p.volumes}</td>
                  <td className={styles.usedCell}>
                    <span className={styles.num}>{poolUseText(p)}</span>
                    {pct != null && pct >= POOL_FULL_PCT ? (
                      <>
                        {' '}
                        <Badge tone="warn">{Math.round(pct)}&nbsp;% full</Badge>
                      </>
                    ) : null}
                    <Bar pct={pct} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <Card
        title="Custom volumes"
        meta={inc.volumes.length ? `${inc.volumes.length} on its pools` : undefined}
        link={
          canChange ? (
            <Button
              size="sm"
              style={{ marginLeft: 'auto' }}
              iconStart={<Icon icon={Plus} size={14} />}
              onClick={() => setOpen({ kind: 'new' })}
            >
              New volume
            </Button>
          ) : undefined
        }
      >
        {inc.volumes.length ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.cellMain}>
                  Volume
                </th>
                <th scope="col" className={styles.dropL}>
                  Pool
                </th>
                <th scope="col" className={styles.dropM}>
                  Kind
                </th>
                <th scope="col" className={styles.dropS}>
                  Size
                </th>
                <th scope="col" className={styles.dropS}>
                  Used by
                </th>
                <th scope="col">
                  <span className={styles.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {inc.volumes.map((v) => (
                <tr key={`${v.pool}/${v.project}/${v.name}`}>
                  <td className={styles.cellMain}>
                    <span className={styles.mono} title={v.name}>
                      {v.name}
                    </span>
                    {v.project !== 'default' ? <span className={styles.kind}> {v.project}</span> : null}
                    {v.description ? <span className={wi.wiSub}>{v.description}</span> : null}
                  </td>
                  <td className={styles.dropL}>
                    <span className={styles.mono}>{v.pool}</span>
                  </td>
                  <td className={cx(styles.muted, styles.dropM)}>{volumeContentWord(v.contentType)}</td>
                  <td className={cx(styles.num, styles.dropS)}>
                    {v.sizeBytes != null ? formatBytesBinary(v.sizeBytes) : DASH}
                    {v.usedBytes != null && v.sizeBytes ? (
                      <span className={wi.wiSub}>{formatBytesBinary(v.usedBytes)} used</span>
                    ) : null}
                  </td>
                  <td className={styles.dropS}>
                    {v.usedBy.length ? (
                      v.usedBy.map((id, i) => (
                        <span key={id}>
                          {i ? ', ' : ''}
                          <button
                            type="button"
                            className={styles.name}
                            onClick={() => set({ guest: id, gtab: 'devices' })}
                          >
                            {incusRef(id).name}
                          </button>
                        </span>
                      ))
                    ) : (
                      <span className={styles.muted}>Not attached</span>
                    )}
                  </td>
                  <td>
                    {canChange ? (
                      <span className={wi.wiActs}>
                        {v.contentType !== 'iso' ? (
                          <button
                            type="button"
                            className={styles.cardLink}
                            style={{ marginLeft: 0 }}
                            onClick={() => setOpen({ kind: 'grow', vol: v })}
                          >
                            Grow… <span className={styles.srOnly}>{v.name}</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={`${styles.cardLink} ${wi.wiSerious}`}
                          style={{ marginLeft: 0 }}
                          onClick={() => setOpen({ kind: 'delete', vol: v })}
                        >
                          Delete… <span className={styles.srOnly}>{v.name}</span>
                        </button>
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No custom volumes yet: a volume keeps data apart from an instance’s own disk.</Empty>
        )}
        {inc.volumes.length ? (
          <p className={styles.cardNote}>Attach a volume from an instance’s Devices tab.</p>
        ) : null}
      </Card>
      {open?.kind === 'new' ? (
        <NewVolumeDialog burrow={burrow} serverId={serverId} detail={detail} onClose={close} />
      ) : null}
      {open?.kind === 'grow' ? (
        <GrowVolumeDialog burrow={burrow} serverId={serverId} vol={open.vol} onClose={close} />
      ) : null}
      {open?.kind === 'delete' ? (
        <DeleteVolumeDialog burrow={burrow} serverId={serverId} vol={open.vol} onClose={close} />
      ) : null}
    </>
  );
}

interface Base {
  burrow: string;
  serverId: string;
  onClose: () => void;
}

function NewVolumeDialog({ burrow, serverId, detail, onClose }: Base & { detail: HostServerDetail }) {
  const inc = incusDetail(detail);
  const pools = inc?.pools ?? [];
  const projects = inc?.projects.map((p) => p.name) ?? ['default'];
  const [pool, setPool] = useState(pools[0]?.name ?? '');
  const [name, setName] = useState('');
  const [size, setSize] = useState('10');
  const [kind, setKind] = useState<'filesystem' | 'block'>('filesystem');
  const [project, setProject] = useState('default');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { send, busy } = useManage(burrow, serverId);
  const nameErr = name.trim() ? incusObjectNameError(name) : null;
  const sizeErr = gibError(size);
  return (
    <FormDialog
      title="New volume"
      description="Space on a pool for data that should outlive an instance; attach it from an instance’s Devices tab."
      action={busy ? 'Making…' : 'Make the volume'}
      busy={busy}
      disabled={!name.trim() || !!nameErr || !!sizeErr}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          setFields({});
          const out = await send({
            op: 'volume.create',
            params: {
              pool,
              name: name.trim(),
              size: `${size.trim()}GiB`,
              contentType: kind,
              ...(project !== 'default' ? { project } : {}),
              ...(description.trim() ? { description: description.trim() } : {}),
            },
            name: name.trim(),
            done: incusDoneText('volume.create', name.trim()),
          });
          if (out.ok) onClose();
          else {
            setFields(out.fields);
            setError(Object.keys(out.fields).length ? null : out.message);
          }
        })()
      }
    >
      <div className={styles.formRow}>
        <TextField
          label="Name"
          mono
          value={name}
          autoFocus
          placeholder="media"
          error={nameErr ?? fields.name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label="Size (GiB)"
          inputMode="numeric"
          value={size}
          error={sizeErr ?? fields.size}
          onChange={(e) => setSize(e.target.value)}
        />
      </div>
      <div className={styles.formRow}>
        <SelectField
          label="Pool"
          options={pools.map((p) => ({
            value: p.name,
            label: `${p.name}${p.totalBytes && p.usedBytes != null ? ` · ${formatBytesBinary(p.totalBytes - p.usedBytes)} free` : ''}`,
          }))}
          value={pool}
          error={fields.pool}
          onChange={(e) => setPool(e.target.value)}
        />
        <SelectField
          label="Kind"
          options={[
            { value: 'filesystem', label: 'A folder (containers and VMs)' },
            { value: 'block', label: 'A raw disk (VMs only)' },
          ]}
          value={kind}
          onChange={(e) => setKind(e.target.value as 'filesystem' | 'block')}
        />
      </div>
      {projects.length > 1 ? (
        <SelectField
          label="Project"
          options={projects.map((p) => ({ value: p, label: p }))}
          value={project}
          onChange={(e) => setProject(e.target.value)}
        />
      ) : null}
      <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
    </FormDialog>
  );
}

function GrowVolumeDialog({ burrow, serverId, vol, onClose }: Base & { vol: HostStorageVolume }) {
  const [add, setAdd] = useState('10');
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  const bad = gibError(add);
  const now = vol.sizeBytes ?? 0;
  const next = now + Number(add) * 1024 ** 3;
  return (
    <FormDialog
      title={`Grow ${vol.name}`}
      description={`Volumes only grow. It’s ${formatBytesBinary(now)} now.`}
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
            params: {
              pool: vol.pool,
              volume: vol.name,
              size: incusSizeString(next),
              ...(vol.project !== 'default' ? { project: vol.project } : {}),
            },
            name: vol.name,
            done: incusDoneText('volume.resize', vol.name),
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
        hint={bad ? undefined : `${formatBytesBinary(now)} → ${formatBytesBinary(next)}`}
        onChange={(e) => setAdd(e.target.value)}
      />
    </FormDialog>
  );
}

function DeleteVolumeDialog({ burrow, serverId, vol, onClose }: Base & { vol: HostStorageVolume }) {
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  const used = vol.usedBy.map((id) => incusRef(id).name);
  return (
    <FormDialog
      title={`Delete ${vol.name}?`}
      description={
        used.length
          ? `${used.join(' and ')} ${used.length === 1 ? 'uses' : 'use'} it. Detach it on their Devices tab first.`
          : `The volume and everything on it are removed from ${vol.pool} for good.`
      }
      action={busy ? 'Deleting…' : 'Delete volume'}
      serious
      busy={busy}
      disabled={used.length > 0}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'volume.delete',
            params: {
              pool: vol.pool,
              volume: vol.name,
              ...(vol.project !== 'default' ? { project: vol.project } : {}),
            },
            confirm: true,
            name: vol.name,
            done: incusDoneText('volume.delete', vol.name),
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    />
  );
}
