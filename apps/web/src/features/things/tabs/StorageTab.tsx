/**
 * A server's Storage (ported from Rackoon's `features/server/Storage.tsx`): first a few tiles in words (how full, when
 * it fills up, the disks to watch) and what uses the space (the machines' and apps' own disks, then the rest; Whombat
 * service-settings.md SST-11, mock service-dash-v2 screen 5), then Proxmox storages with how full they are and
 * Contents… on those with ISO images, container templates or imports (Manage on: the files, Download from a
 * link where the server allows it, Get templates, Delete), pools and filesystems with health and scrubs, disk arrays,
 * and the disks with SMART and wear. Every level is `@whombat/client/hosts`' (`diskUsedLevel`, `wearLevel`).
 */
import {
  commitOutcomeText,
  DASH,
  detailGuests,
  diskHealth,
  diskUsedLevel,
  formatAgoIso,
  formatGb,
  formatInt,
  formatPct,
  formatTemp,
  hasContents,
  hostErrorInfo,
  hostTone,
  type SpacePart,
  type SpaceTile,
  sensorLevel,
  serverGuestHref,
  spaceTiles,
  spaceUse,
  spaceVolumes,
} from '@whombat/client/hosts';
import { useHostManageRead, useHostsChange } from '@whombat/client/hosts/react';
import { api } from '@whombat/core/contracts';
import type { HostDisk, HostServerDetail, HostStorage } from '@whombat/core/domain';
import { type CSSProperties, useMemo, useState } from 'react';
import { cx } from '../../../components/cx';
import { useBurrowContext, useNow } from '../../messaging/useRoom';
import dash from '../dashboard/Dashboard.module.css';
import { StorageContentDialog } from '../manage/StorageContentDialog';
import { AppLink, Badge, Card, Empty, StateCell } from '../parts';
import styles from '../Things.module.css';
import space from './StorageTab.module.css';

const TYPE_WORD: Record<NonNullable<HostDisk['type']>, string> = { nvme: 'NVMe', hdd: 'HDD', ssd: 'SSD' };

function Bar({ pct }: { pct: number | null }) {
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

/** The tiles in words over the cards (SST-11): the Summary's figures' look. */
function SpaceTiles({ tiles }: { tiles: readonly SpaceTile[] }) {
  if (!tiles.length) return null;
  return (
    <section className={styles.card} aria-label="Space at a glance">
      <div className={dash.figs} style={{ '--figs': tiles.length } as CSSProperties}>
        {tiles.map((t) => (
          <div
            key={t.key}
            className={cx(dash.fig, t.tone === 'warn' && dash.figWarn, t.tone === 'bad' && dash.figBad)}
            data-tile={t.key}
          >
            <span className={dash.figHead}>
              <span className={styles.lbl}>{t.label}</span>
            </span>
            <b className={cx(dash.figValue, space.tileWord)}>{t.value}</b>
            <span className={dash.figSub}>{t.sub ?? ' '}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const PART_COLORS: Record<SpacePart['kind'], string> = {
  machine: 'var(--chart1)',
  app: 'var(--chart2)',
  category: 'var(--chart3)',
  folder: 'var(--chart4)',
  rest: 'var(--line2)',
};

const PART_WORDS: Record<SpacePart['kind'], string | null> = {
  machine: 'machine',
  app: 'app',
  category: null,
  folder: 'folder',
  rest: null,
};

/**
 * What uses the space: the machines' and apps' own disks, biggest first, each a link to its page, its size and a bar
 * against the biggest. When a recent on-request disk breakdown exists, it replaces “Everything else” with the measured
 * categories and largest folders and shows when it was measured; a person can also run a fresh check on demand.
 */
function SpaceUseCard({
  burrow,
  serverId,
  detail,
  now,
}: {
  burrow: string;
  serverId: string;
  detail: HostServerDetail;
  now: number;
}) {
  const volumes = useMemo(() => spaceVolumes(detail.health?.volumes ?? []), [detail.health?.volumes]);
  const use = useMemo(
    () =>
      spaceUse({
        guests: detailGuests(detail),
        volumes,
        diskUsage: detail.diskUsage,
        now,
      }),
    [detail, volumes, now],
  );
  const measure = useHostsChange(api.hosts.diskUsage);
  const [note, setNote] = useState<string | null>(null);
  const canMeasure =
    detail.server.remoteControl.diagnose !== false &&
    detail.server.agent.connected !== false &&
    volumes.length > 0;

  async function onMeasure() {
    setNote(null);
    try {
      const r = await measure.mutateAsync({ params: { burrow, serverId }, body: {} });
      if (r.status !== 'ok') {
        setNote(commitOutcomeText(r));
        return;
      }
      if (r.data.ok === false || r.data.code) {
        setNote(r.data.message ?? 'Skipped because the backing disk is spun down.');
      }
    } catch (err) {
      setNote(hostErrorInfo(err).message);
    }
  }

  if (!use && !canMeasure) return null;

  const metaParts: string[] = [];
  if (use?.measuredAt) {
    metaParts.push(`Measured ${formatAgoIso(use.measuredAt, now)}`);
    if (use.measuredMount && volumes.length > 1) metaParts.push(use.measuredMount);
    if (use.partial) metaParts.push('partial');
  } else if (use) {
    metaParts.push('Machines’ and apps’ own disks');
  } else {
    metaParts.push('On request');
  }

  const action = canMeasure ? (
    <button
      type="button"
      className={styles.cardLink}
      disabled={measure.isPending}
      onClick={() => void onMeasure()}
    >
      {measure.isPending ? 'Checking…' : use?.measuredAt ? 'Check again' : 'Check what fills it'}
    </button>
  ) : undefined;

  const biggest = use ? Math.max(...use.parts.map((p) => p.gb), 1) : 1;
  return (
    <Card title="What uses the space" meta={metaParts.join(' · ')} link={action}>
      {note ? (
        <p className={space.note} role="status">
          {note}
        </p>
      ) : null}
      {use ? (
        <ul className={space.parts}>
          {use.parts.map((p) => {
            const name = (
              <span className={cx(space.partName, p.kind === 'folder' && styles.mono)} title={p.label}>
                {p.label}
              </span>
            );
            const kind = PART_WORDS[p.kind];
            const sub = p.guestId ? kind : (p.detail ?? kind);
            return (
              <li key={p.id} className={space.part} data-part={p.id}>
                <span className={space.partLabel}>
                  <i
                    className={space.swatch}
                    style={{ background: PART_COLORS[p.kind] }}
                    aria-hidden="true"
                  />
                  {p.guestId ? (
                    <AppLink href={serverGuestHref(serverId, p.guestId)} className={space.partLink}>
                      {name}
                    </AppLink>
                  ) : (
                    name
                  )}
                  {sub ? <span className={space.partKind}>{sub}</span> : null}
                </span>
                <span className={space.partBar} aria-hidden="true">
                  <i style={{ width: `${(p.gb / biggest) * 100}%`, background: PART_COLORS[p.kind] }} />
                </span>
                <span className={space.partSize}>{formatGb(p.gb)}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={space.note}>Check what fills a disk on request without waking sleeping drives.</p>
      )}
    </Card>
  );
}

export function StorageTab({ burrow, detail }: { burrow: string; detail: HostServerDetail }) {
  const { timeZone } = useBurrowContext(burrow);
  const now = useNow(60_000);
  const tiles = useMemo(() => spaceTiles({ detail, now, timeZone }), [detail, now, timeZone]);
  const [contents, setContents] = useState<HostStorage | null>(null);
  const stores = detail.proxmox?.storages ?? [];
  const volumes = detail.health?.volumes ?? [];
  const arrays = detail.health?.arrays ?? [];
  const manage = detail.server.remoteControl.manage === true;
  const choices = useHostManageRead(
    manage && stores.length
      ? { params: { burrow, serverId: detail.server.id }, query: { op: 'choices', platform: 'pve' } }
      : null,
  );
  const download = choices.data?.op === 'choices' && choices.data.choices.download === true;
  return (
    <>
      <SpaceTiles tiles={tiles} />
      {arrays
        .filter((a) => a.failed.length || (a.state !== 'clean' && a.state !== 'active'))
        .map((a) => (
          <div key={a.name} className={cx(styles.notice, styles.noticeBad)} role="alert">
            <div>
              <b>
                The {a.name} array is {a.state}
              </b>
              <p>
                {a.failed.length
                  ? `${a.failed.join(' and ')} dropped out; ${a.active} of ${a.devices} disks are working.`
                  : `${a.active} of ${a.devices} disks are working.`}
                {a.syncPct != null ? ` Rebuilding: ${formatPct(a.syncPct)}.` : ''}
              </p>
            </div>
          </div>
        ))}
      {stores.length ? (
        <Card title="Storages" meta={`${stores.length} on this node`}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.cellMain}>
                  Storage
                </th>
                <th scope="col" className={styles.dropM}>
                  Holds
                </th>
                <th scope="col">Used</th>
                <th scope="col">
                  <span className={styles.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {stores.map((s) => {
                const pct = s.capacityGb ? (s.usedGb / s.capacityGb) * 100 : null;
                const browsable = hasContents(s.content);
                return (
                  <tr key={s.id}>
                    <td className={styles.cellMain}>
                      <span className={styles.mono}>{s.id}</span>{' '}
                      <span className={styles.kind}>{s.type}</span>
                    </td>
                    <td className={cx(styles.muted, styles.dropM)}>{contentWords(s.content)}</td>
                    <td className={styles.usedCell}>
                      <span className={styles.num}>
                        {formatGb(s.usedGb)} / {formatGb(s.capacityGb)}
                      </span>
                      <Bar pct={pct} />
                    </td>
                    <td>
                      {browsable && manage ? (
                        <button
                          type="button"
                          className={styles.cardLink}
                          aria-label={`Contents of ${s.id}`}
                          onClick={() => setContents(s)}
                        >
                          Contents…
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      ) : null}
      {volumes.length ? (
        <Card title={stores.length ? 'Pools and filesystems' : 'Filesystems'}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.cellMain}>
                  Name
                </th>
                <th scope="col">
                  <span className={styles.narrowSr}>Health</span>
                </th>
                <th scope="col">Used</th>
                <th scope="col" className={styles.dropM}>
                  Full in
                </th>
              </tr>
            </thead>
            <tbody>
              {volumes.map((v) => (
                <tr key={v.entity}>
                  <td className={styles.cellMain}>
                    <span className={styles.mono}>{v.label}</span>{' '}
                    <span className={styles.kind}>{v.layout ?? v.fsType ?? v.kind}</span>
                  </td>
                  <td>
                    {v.health ? (
                      <StateCell
                        tone={/ONLINE|ok/i.test(v.health) ? 'ok' : 'bad'}
                        text={v.health.toLowerCase()}
                        compact
                      />
                    ) : v.readOnly ? (
                      <Badge tone="warn">read-only</Badge>
                    ) : (
                      <span className={styles.muted}>{DASH}</span>
                    )}
                    {v.scrub?.errors ? <Badge tone="bad">{v.scrub.errors} scrub errors</Badge> : null}
                  </td>
                  <td className={styles.usedCell}>
                    <span className={styles.num}>
                      {formatGb(v.usedGb)} / {formatGb(v.totalGb)}
                    </span>
                    <Bar pct={v.usedPct} />
                  </td>
                  <td className={cx(styles.num, styles.dropM)}>
                    {v.fullInDays != null ? `${formatInt(v.fullInDays)} days` : DASH}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      <SpaceUseCard burrow={burrow} serverId={detail.server.id} detail={detail} now={now} />
      <Card title="Disks" meta={detail.disks.length ? `${detail.disks.length} in this server` : undefined}>
        {detail.disks.length ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.cellMain}>
                  Disk
                </th>
                <th scope="col">
                  <span className={styles.narrowSr}>Health</span>
                </th>
                <th scope="col" className={styles.dropS}>
                  Size
                </th>
                <th scope="col" className={styles.dropM}>
                  Wear
                </th>
                <th scope="col">Temp</th>
                <th scope="col" className={styles.dropL}>
                  On for
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.disks.map((d) => {
                const h = diskHealth(d);
                return (
                  <tr key={d.device}>
                    <td className={styles.cellMain}>
                      <span className={styles.mono}>{d.device}</span>{' '}
                      <span className={styles.kind}>
                        {d.type ? TYPE_WORD[d.type] : ''}
                        {d.role || d.pool ? ` · ${d.role ?? d.pool}` : ''}
                      </span>
                      <span className={styles.cellSub} title={d.model ?? undefined}>
                        {d.model}
                      </span>
                      {d.healthReason ? <span className={styles.cellSub}>{d.healthReason}</span> : null}
                    </td>
                    <td>
                      <span title={d.healthReason ?? undefined}>
                        <StateCell tone={h.tone} text={h.text} compact />
                      </span>
                    </td>
                    <td className={cx(styles.num, styles.dropS)}>{formatGb(d.capacityGb)}</td>
                    <td className={cx(styles.num, styles.dropM)}>
                      {d.wearPct != null ? formatPct(d.wearPct) : DASH}
                    </td>
                    <td className={styles.num}>
                      <span style={{ color: tempColor(d.tempC) }}>{formatTemp(d.tempC)}</span>
                    </td>
                    <td className={cx(styles.num, styles.dropL)}>
                      {d.powerOnHours != null ? `${formatInt(Math.round(d.powerOnHours / 24))} days` : DASH}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty>No word from this server about its disks yet.</Empty>
        )}
      </Card>
      {contents ? (
        <StorageContentDialog
          burrow={burrow}
          serverId={detail.server.id}
          storage={contents}
          download={download}
          onClose={() => setContents(null)}
        />
      ) : null}
    </>
  );
}

function tempColor(c: number | null | undefined): string | undefined {
  const tone = hostTone(sensorLevel(c, 70));
  return tone === 'warn' ? 'var(--warn)' : tone === 'bad' ? 'var(--bad)' : undefined;
}

function contentWords(content: string): string {
  const words: Record<string, string> = {
    images: 'VM disks',
    rootdir: 'containers',
    iso: 'ISO images',
    vztmpl: 'templates',
    backup: 'backups',
    snippets: 'snippets',
    import: 'imports',
  };
  return content
    .split(',')
    .map((c) => words[c.trim()] ?? c.trim())
    .filter(Boolean)
    .join(', ');
}
