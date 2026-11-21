// Host health sections (CONTRACT "Host health"): the System card of the
// summary, the volumes and arrays of the Storage tab, fans on the Sensors
// tab, and the Proxmox task, replication and Ceph cards. Each renders
// nothing when the agent does not report the data, so older agents and
// hosts without the hardware keep the page as it was.

import { memo } from 'react';
import type { Disk, DiskIO, Fan, HostSystem, PveReplication, PveTask, RaidArray, ServerDetail, Volume } from '../../api/types';
import { Dot, Meter } from '../../components/controls';
import { useNow } from '../../lib/clock';
import { DASH, formatDiskRate, formatDuration, formatFull, formatGb, formatInt, formatRelativeDay, plural } from '../../lib/format';
import { t } from '../../lib/i18n';
import { diskUsedLevel, levelBar } from '../../lib/thresholds';

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** formatRelativeDay for running text: "today 14:00", "Oct 2, 14:00". */
function relDay(iso: string, now: number): string {
  const s = formatRelativeDay(Date.parse(iso), now);
  return s.startsWith(t('Today')) || s.startsWith(t('Yesterday')) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** "Full in about 12 days" / "Full within a day". */
export function fullText(days: number): string {
  if (days < 1) return t('Full within a day');
  if (days < 1.5) return t('Full in about a day');
  return t('Full in about {n} days', { n: Math.round(days) });
}

function offsetText(ms: number): string {
  const a = Math.abs(ms);
  return a >= 1000 ? `${(ms / 1000).toFixed(1)} s` : a >= 10 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`;
}

const UPS_STATUS: Record<string, string> = { online: t('Online'), on_battery: t('On battery'), low_battery: t('Battery low'), offline: t('Offline') };

interface Row {
  k: string;
  v: string;
  sub?: string;
  tone?: 'warn' | 'bad';
  title?: string;
}

/** Rows of the System card, only those with data. Exported for tests. */
export function systemRows(d: Pick<ServerDetail, 'system' | 'ups' | 'gpus'>): Row[] {
  const s: HostSystem | null | undefined = d.system;
  const rows: Row[] = [];
  if (s) {
    if (s.updates != null) {
      const sec = s.security_updates ?? 0;
      rows.push({
        k: t('Updates'),
        v: s.updates === 0 ? t('Up to date') : `${t('{n} available', { n: formatInt(s.updates) })}${sec ? ` · ${t('{n} security', { n: formatInt(sec) })}` : ''}`,
        tone: sec > 0 ? 'warn' : undefined,
        title: s.package_manager ? t('From {name}', { name: s.package_manager }) : undefined,
      });
    } else if (s.updates_error) {
      rows.push({ k: t('Updates'), v: t('Unknown'), title: s.updates_error });
    }
    if (s.reboot_required) rows.push({ k: t('Reboot'), v: t('Required'), sub: s.reboot_reason ?? undefined, tone: 'warn' });
    if (s.failed_count > 0) {
      const names = s.failed_units.slice(0, 3).join(', ') + (s.failed_count > 3 ? ', …' : '');
      rows.push({ k: t('Services'), v: t('{n} failed', { n: formatInt(s.failed_count) }), sub: names, tone: 'warn', title: s.failed_units.join('\n') });
    } else if (s.init_system) {
      rows.push({ k: t('Services'), v: t('None failed') });
    }
    if (s.time_synced != null) {
      const off = s.time_offset_ms != null ? ` · ${t('offset {offset}', { offset: offsetText(s.time_offset_ms) })}` : '';
      rows.push(
        s.time_synced
          ? { k: t('Clock'), v: `${t('Synced')}${s.time_source ? ` · ${s.time_source}` : ''}${off}` }
          : { k: t('Clock'), v: `${t('Not synced')}${off}`, tone: 'warn' },
      );
    }
    if (s.pressure) {
      const p = s.pressure;
      rows.push({
        k: t('Pressure'),
        v: t('CPU {cpu}% · memory {memory}% · I/O {io}%', { cpu: Math.round(p.cpu), memory: Math.round(p.memory), io: Math.round(p.io) }),
        tone: p.memory_full >= 10 || p.io_full >= 25 ? 'warn' : undefined,
        title: t('Share of the last 10 seconds that tasks waited for CPU, memory or I/O (Linux PSI)'),
      });
    }
    if (s.steal_pct != null && s.steal_pct >= 1) rows.push({ k: t('CPU steal'), v: `${s.steal_pct.toFixed(1)}%`, tone: s.steal_pct >= 10 ? 'warn' : undefined });
    if (s.oom_kills > 0) rows.push({ k: t('OOM kills'), v: t('{n} since boot', { n: formatInt(s.oom_kills) }) });
  }
  for (const u of d.ups ?? []) {
    const parts = [UPS_STATUS[u.status] ?? cap(u.status)];
    if (u.charge_pct != null) parts.push(`${Math.round(u.charge_pct)}%`);
    if (u.runtime_s != null) parts.push(t('{time} left', { time: formatDuration(u.runtime_s) }));
    if (u.load_pct != null) parts.push(t('load {pct}%', { pct: Math.round(u.load_pct) }));
    rows.push({
      k: `UPS ${u.name}`,
      v: parts.join(' · '),
      tone: u.status === 'low_battery' || u.status === 'offline' ? 'bad' : u.status === 'on_battery' ? 'warn' : undefined,
      title: u.model ?? undefined,
    });
  }
  for (const g of d.gpus ?? []) {
    const parts: string[] = [];
    if (g.util_pct != null) parts.push(`${Math.round(g.util_pct)}%`);
    if (g.mem_used_gb != null && g.mem_total_gb != null) parts.push(t('{used} of {total} GB', { used: g.mem_used_gb.toFixed(1), total: Math.round(g.mem_total_gb) }));
    if (g.temp_c != null) parts.push(`${Math.round(g.temp_c)} °C`);
    if (g.power_w != null) parts.push(`${Math.round(g.power_w)} W`);
    rows.push({ k: (d.gpus?.length ?? 0) > 1 ? `GPU ${g.index}` : 'GPU', v: parts.join(' · ') || DASH, sub: g.name });
  }
  return rows;
}

/** System card of the summary (#system). Memoized: chart hover re-renders the summary. */
export const SystemCard = memo(function SystemCard({ detail }: { detail: ServerDetail }) {
  const rows = systemRows(detail);
  if (rows.length === 0) return null;
  const procs = detail.system?.processes;
  return (
    <section id="system" tabIndex={-1} className="card" aria-labelledby="sum-system-title">
      <div className="card-head">
        <h2 className="h2" id="sum-system-title">
          {t('System')}
        </h2>
        {procs ? <span className="sub">{plural(procs, 'process', 'processes')}</span> : null}
      </div>
      <dl className="kv-list">
        {rows.map((r) => (
          <div key={r.k} className="kv" title={r.title}>
            <dt className="lbl">{r.k}</dt>
            <dd>
              <span className={r.tone === 'bad' ? 'tone-bad' : r.tone === 'warn' ? 'tone-warn' : undefined}>{r.v}</span>
              {r.sub && <small className="ellipsis">{r.sub}</small>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
});

// ---------------------------------------------------------------- storage

function volumeState(v: Volume): { text: string; tone?: 'warn' | 'bad' } | null {
  if (v.read_only) return { text: t('Read-only'), tone: 'bad' };
  if (v.error) return { text: t('Not responding'), tone: 'bad' };
  if (v.health && v.health.toUpperCase() !== 'ONLINE') return { text: cap(v.health.toLowerCase()), tone: 'bad' };
  if (v.errors) return { text: plural(v.errors.read + v.errors.write + v.errors.checksum, 'error'), tone: 'warn' };
  if (v.full_in_days != null && v.full_in_days < 30) return { text: fullText(v.full_in_days), tone: v.full_in_days < 7 ? 'warn' : undefined };
  return null;
}

function scrubText(v: Volume, now: number): string | null {
  const s = v.scrub;
  if (!s) return null;
  if (s.state === 'none') return t('Never scrubbed');
  if (s.state === 'scanning') return t('Scrubbing now');
  if (!s.end) return null;
  return `${t('Scrubbed {time}', { time: relDay(s.end, now) })}${s.errors ? ` · ${t('{errors} found', { errors: plural(s.errors, 'error') })}` : ''}`;
}

/** Volumes: filesystems, pools (and Proxmox storages) with use, inodes, state and forecast. */
export function VolumesCard({ volumes, title = t('Volumes') }: { volumes: Volume[]; title?: string }) {
  const now = useNow(60_000);
  if (volumes.length === 0) return null;
  return (
    <section className="card" aria-labelledby="volumes-title">
      <div className="card-head">
        <h3 className="h2" id="volumes-title">
          {title}
        </h3>
        <span className="sub">{plural(volumes.length, 'volume')}</span>
      </div>
      <ul className="plain-list vol-list">
        {volumes.map((v) => {
          const st = volumeState(v);
          const meta = [
            v.kind === 'pool' ? (v.layout ? `ZFS ${v.layout}` : t('ZFS pool')) : v.kind === 'storage' ? t('Proxmox storage') : v.fs_type,
            v.kind === 'fs' && v.device ? v.device : null,
            v.inodes_pct != null && v.inodes_pct >= 50 ? `inodes ${Math.round(v.inodes_pct)}%` : null,
            scrubText(v, now),
            v.frag_pct != null && v.frag_pct >= 50 ? t('fragmentation {pct}%', { pct: Math.round(v.frag_pct) }) : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <li key={v.entity} className="vol-row">
              <div className="vol-name">
                <span className="mono">{v.label}</span>
                {meta && <span className="lbl ellipsis">{meta}</span>}
              </div>
              <div className="vol-use">
                <Meter pct={v.used_pct} color={levelBar(diskUsedLevel(v.used_pct))} />
                <span className="num">
                  <b>{formatGb(v.used_gb)}</b> <span className="ink-3">{t('of {total} · {pct}%', { total: formatGb(v.total_gb), pct: Math.round(v.used_pct) })}</span>
                </span>
              </div>
              <div className="vol-state">
                {st && (
                  <span className={st.tone === 'bad' ? 'tone-bad' : st.tone === 'warn' ? 'tone-warn' : 'ink-2'} title={v.status ?? undefined}>
                    {st.text}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function arrayTone(a: RaidArray): string {
  const st = a.state.toLowerCase();
  if (st === 'failed' || st === 'inactive' || st === 'degraded' || a.active < a.devices) return 'var(--critical)';
  if (st === 'resyncing' || st === 'recovering' || st === 'checking') return 'var(--warning)';
  return 'var(--good)';
}

/** md / Unraid arrays. */
export function ArraysCard({ arrays }: { arrays: RaidArray[] }) {
  const now = useNow(60_000);
  if (arrays.length === 0) return null;
  return (
    <section className="card" aria-labelledby="arrays-title">
      <div className="card-head">
        <h3 className="h2" id="arrays-title">
          {t('Arrays')}
        </h3>
        <span className="sub">{plural(arrays.length, 'array')}</span>
      </div>
      <ul className="plain-list">
        {arrays.map((a) => (
          <li key={a.name} className="mini-row">
            <span className="n">
              {a.name}
              <small>
                {a.level}
                {a.size_gb != null ? ` · ${formatGb(a.size_gb)}` : ''}
              </small>
            </span>
            <span className="state">
              <Dot color={arrayTone(a)} />
              {cap(a.state)}
              {a.sync_pct != null && a.state !== 'clean' ? ` ${Math.round(a.sync_pct)}%` : ''}
            </span>
            <span className="lbl" style={{ gridColumn: '1 / -1' }}>
              {t('{active} of {total} members active', { active: a.active, total: a.devices })}
              {a.members.length ? ` · ${a.members.join(', ')}` : ''}
              {a.failed.length ? ` · ${t('failed: {list}', { list: a.failed.join(', ') })}` : ''}
              {a.last_check ? ` · ${t('checked {time}', { time: relDay(a.last_check, now) })}${a.check_errors ? `, ${plural(a.check_errors, 'mismatch', 'mismatches')}` : ''}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- sensors

/** Fans with their speed and minimum. */
export function FansCard({ fans }: { fans: Fan[] }) {
  if (fans.length === 0) return null;
  return (
    <section className="card" aria-labelledby="fans-title">
      <div className="card-head">
        <h3 className="h2" id="fans-title">
          {t('Fans')}
        </h3>
        <span className="sub">{plural(fans.length, 'fan')}</span>
      </div>
      <ul className="plain-list">
        {fans.map((f) => {
          const low = f.min_rpm != null && f.rpm < f.min_rpm;
          return (
            <li key={f.source} className="mini-row">
              <span className="n" style={{ fontFamily: 'inherit' }}>
                {f.label}
                <small>{f.source}</small>
              </span>
              <span className={low ? 'tone-warn num' : 'num'}>
                {formatInt(Math.round(f.rpm))} rpm{f.min_rpm != null ? <span className="ink-3"> · {t('min {rpm}', { rpm: formatInt(f.min_rpm) })}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- Proxmox

/** Failed and running tasks of the last 48 h, replication jobs and Ceph. */
export function ProxmoxActivity({ tasks, replication, ceph }: { tasks: PveTask[]; replication: PveReplication[]; ceph: ServerDetail['ceph'] }) {
  const now = useNow(60_000);
  if (tasks.length === 0 && replication.length === 0 && !ceph) return null;
  const failed = tasks.filter((task) => task.end && !task.ok).length;
  return (
    <section className="card" aria-labelledby="pve-activity-title">
      <div className="card-head">
        <h2 className="h2" id="pve-activity-title">
          {replication.length || ceph ? t('Tasks and replication') : t('Tasks')}
        </h2>
        <span className="sub">{tasks.length ? t('{tasks} in 48 h', { tasks: plural(failed, 'failed task') }) : t('No failed tasks in 48 h')}</span>
      </div>
      <ul className="plain-list">
        {ceph && (
          <li className="mini-row">
            <span className="n">Ceph</span>
            <span className="state">
              <Dot color={ceph.status === 'HEALTH_OK' ? 'var(--good)' : ceph.status === 'HEALTH_ERR' ? 'var(--critical)' : 'var(--warning)'} />
              {cap(ceph.status.replace('HEALTH_', '').toLowerCase())}
            </span>
            {ceph.summary.length > 0 && (
              <span className="lbl" style={{ gridColumn: '1 / -1' }}>
                {ceph.summary.join(' · ')}
              </span>
            )}
          </li>
        )}
        {tasks.map((task) => (
          <li key={`${task.type}/${task.start}/${task.id ?? ''}`} className="mini-row">
            <span className="n">
              {task.type}
              {task.id ? ` ${task.id}` : ''}
              <small>
                {task.node}
                {task.user ? ` · ${task.user}` : ''}
              </small>
            </span>
            <span className="state" title={formatFull(Date.parse(task.start))}>
              <Dot color={!task.end ? 'var(--info, var(--ink-3))' : 'var(--critical)'} />
              {!task.end ? t('Running') : t('Failed {time}', { time: relDay(task.end, now) })}
            </span>
            {task.end && (
              <span className="lbl ellipsis" style={{ gridColumn: '1 / -1' }} title={task.status}>
                {task.status}
              </span>
            )}
          </li>
        ))}
        {replication.map((r) => {
          const bad = !!r.error || r.fails > 0;
          return (
            <li key={r.id} className="mini-row">
              <span className="n">
                {t('Replication {id}', { id: r.id })}
                <small>{t('to {target}', { target: r.target })}</small>
              </span>
              <span className="state">
                <Dot color={bad ? 'var(--warning)' : 'var(--good)'} />
                {bad ? t('Failing') : r.last_sync ? t('Synced {time}', { time: relDay(r.last_sync, now) }) : 'OK'}
              </span>
              {r.error && (
                <span className="lbl ellipsis" style={{ gridColumn: '1 / -1' }} title={r.error}>
                  {r.error}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A disk's SMART detail and I/O line (Storage tab). */
export function SmartDetail({ smart, io }: { smart: NonNullable<Disk['smart']>; io?: DiskIO | null }) {
  const parts: { t: string; warn?: boolean }[] = [];
  if (smart.self_test) parts.push({ t: t('Self-test {type}: {result}', { type: smart.self_test.type, result: smart.self_test.result }), warn: smart.self_test.result === 'failed' });
  if (smart.spare_pct != null) parts.push({ t: t('Spare {pct}%', { pct: Math.round(smart.spare_pct) }), warn: smart.spare_threshold != null && smart.spare_pct < smart.spare_threshold });
  if (smart.media_errors) parts.push({ t: plural(smart.media_errors, 'media error'), warn: true });
  if (smart.crc_errors) parts.push({ t: plural(smart.crc_errors, 'CRC error'), warn: true });
  if (smart.unsafe_shutdowns) parts.push({ t: plural(smart.unsafe_shutdowns, 'unsafe shutdown') });
  if (smart.standby) parts.push({ t: t('In standby (values from the last run)') });
  if (io) parts.push({ t: t('Read {read} · write {write} · {pct}% busy', { read: formatDiskRate(io.read_mbs), write: formatDiskRate(io.write_mbs), pct: Math.round(io.util_pct) }) });
  if (parts.length === 0) return null;
  return (
    <div className="lbl disk-more">
      {parts.map((p, i) => (
        <span key={p.t} className={p.warn ? 'tone-warn' : undefined}>
          {i > 0 ? ' · ' : ''}
          {p.t}
        </span>
      ))}
    </div>
  );
}

