/**
 * A server's System (ported from Rackoon's `SystemTab`, `Health` SystemCard and ProxmoxActivity, `Virtualization` and
 * `Proxmox` ClusterSection): updates, restarts and failed services; Proxmox's failed tasks of the last 48 hours and
 * replication; a look inside asked from the agent now (processes, ports, services, updates); its network (on the
 * Network tab instead where the server has one, less-is-more.md AP-1765); how much of it guests were given; its
 * cluster, each added node a link; its agent: whether Whombat asks before its risky actions there (Whombat
 * server-asks.md SA-08; AP-1717), then the switches that decide what Whombat may do there folded behind one line
 * (open by themselves when the server itself blocks one, which shows the one command that allows it, PX-04; AP-1767)
 * with Remove at their end; and how its agent keeps up to date (agent-updates-app.md AP-2981).
 */
import {
  AGENT_UPDATE_POLL_MS,
  AGENT_UPDATE_WORDS,
  type AgentUpdatesView,
  agentSwitchesLine,
  agentUpdateNeed,
  agentUpdatesView,
  agentUpdating,
  allowCommand,
  DASH,
  detailGuests,
  formatAgo,
  formatAgoIso,
  formatBytesBinary,
  formatNetRate,
  formatNum,
  formatPct,
  formatPct1,
  hostsThisWhombat,
  hostTone,
  incusWarnings,
  isIncusServer,
  isRebootHint,
  isUpdatesHint,
  memoryAssignedLevel,
  overcommitLevel,
  plural,
  pveActivity,
  serverHasNetworkTab,
  serverHref,
  serverNoticeOptions,
  serverWatch,
  taskWord,
  updateCommand,
} from '@whombat/client/hosts';
import {
  useHostAgentSettings,
  useHostInspect,
  useHostServerSettings,
  useHostsChange,
  useHostsStatus,
  useRefreshHosts,
} from '@whombat/client/hosts/react';
import { CONNECTIONS_HREF, thingId } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import {
  HOST_ASKS_FIRST,
  HOST_ASKS_FIRST_DEFAULT,
  HOST_ASKS_FIRST_WORDS,
  type HostAsksFirst,
  type HostInspectResult,
  type HostRemoteToggles,
  type HostServerDetail,
} from '@whombat/core/domain';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useNavigateHref } from '../../../app/routing/navigation';
import { Button } from '../../../components/Button';
import { CopyButton } from '../../../components/CopyButton';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { Toggle } from '../../../components/Toggle';
import { TechnicalDetails } from '../dashboard/Verdict';
import wc from '../HostFleet.module.css';
import { IncusSystem } from '../incus/IncusSystem';
import { LibvirtActivity } from '../libvirt/LibvirtSystem';
import { AppLink, Card, ConfirmDialog, Empty, ErrorLine, StateCell, useChangeRunner } from '../parts';
import { useServerQuiet } from '../quiet/useQuiet';
import { WatchSettings } from '../quiet/WatchSettings';
import styles from '../Things.module.css';
import { ServerNetwork } from './ServerNetwork';
import {
  InstallUpdatesButton,
  RestartRow,
  type ServerUpdates,
  UpdatesDialogs,
  UpdatesRow,
  useServerUpdates,
} from './ServerUpdates';
import type { TabProps } from './tabProps';
import { WatchNotices } from './WatchNotices';

type Look = 'processes' | 'ports' | 'services' | 'updates';

export function SystemTab({ burrow, serverId, detail, timeZone }: TabProps) {
  const sys = detail.health?.system ?? null;
  const now = Date.parse(detail.asOf);
  // Incus's own warnings are listed in their card below: the hint that says so isn't repeated above (AP-1752).
  const warningsCard = isIncusServer(detail) && incusWarnings(detail).length > 0;
  // Its lines with the ⋯ menu, quiet ones greyed (quiet-notices.md AP-4828). Waiting updates and a needed restart are
  // the Health card's own lines (with Install and Restart), so they aren't said twice, once as “available” beside
  // “Installing…”.
  const sq = useServerQuiet(burrow, serverId);
  const hints = serverWatch(
    [],
    detail.hints.filter(
      (h) =>
        h.section === 'system' &&
        !isUpdatesHint(h) &&
        !isRebootHint(h) &&
        !(warningsCard && h.kind === 'incus.warning'),
    ),
    serverId,
    serverNoticeOptions(detail, detailGuests(detail), {
      quiet: sq.mayQuiet,
      ...(timeZone ? { timeZone } : {}),
    }),
  );
  // Installing updates, checking for them, restarting after them (SWU-10; AP-2860).
  const updates = useServerUpdates(burrow, serverId, detail);
  return (
    <>
      <WatchNotices burrow={burrow} rows={hints} quiet={sq.actions} />
      <Card title="Health">
        {sys ? (
          <div className={styles.rows}>
            <UpdatesRow u={updates} />
            <RestartRow u={updates} />
            <Line
              title="Background services"
              text={
                sys.failedCount
                  ? `${plural(sys.failedCount, 'background service')} stopped: ${sys.failedUnits
                      .map((u) => u.replace(/\.service$/, ''))
                      .join(', ')}`
                  : 'All running'
              }
              tone={sys.failedCount ? 'bad' : 'ok'}
            />
          </div>
        ) : (
          <Empty>No word from this server about this yet.</Empty>
        )}
      </Card>
      {/* What Whombat watches on it (quiet-notices.md QN-15; AP-4827): a server's settings are here. */}
      <WatchSettings burrow={burrow} thing={thingId('server', serverId)} />
      <AgentCard burrow={burrow} serverId={serverId} detail={detail} />
      {/* The internals only someone who runs the server reads: one fold (Whombat server-pages.md). */}
      <TechnicalDetails
        extra={
          <>
            {sys ? (
              <Card title="Clock and load">
                <div className={styles.rows}>
                  <Line
                    title="Clock"
                    text={
                      sys.timeSynced === false
                        ? 'Not in sync'
                        : `In sync${sys.timeOffsetMs != null ? `, ${formatNum(Math.abs(sys.timeOffsetMs))} ms off` : ''}`
                    }
                    end={sys.timeSource ?? undefined}
                    tone={sys.timeSynced === false ? 'warn' : 'ok'}
                  />
                  <Line
                    title="Load"
                    text={`${formatNum(sys.processes)} processes${sys.pressure ? ` · waiting on CPU ${formatPct1(sys.pressure.cpu)}, memory ${formatPct1(sys.pressure.memory)}, disks ${formatPct1(sys.pressure.io)}` : ''}`}
                    end={sys.oomKills ? `${sys.oomKills} out-of-memory stops` : undefined}
                    tone={sys.oomKills ? 'warn' : 'ok'}
                  />
                </div>
              </Card>
            ) : null}
            {detail.server.platform === 'proxmox' ? <ProxmoxActivity detail={detail} now={now} /> : null}
            {isIncusServer(detail) ? (
              <IncusSystem burrow={burrow} serverId={serverId} detail={detail} />
            ) : null}
            {detail.libvirt &&
            (detail.server.platform === 'libvirt' || (detail.workloads?.libvirt?.guests.length ?? 0) > 0) ? (
              <LibvirtActivity burrow={burrow} detail={detail} />
            ) : null}
            <LookInside
              burrow={burrow}
              serverId={serverId}
              allowed={detail.server.remoteControl.diagnose !== false}
              reason={detail.server.remoteControl.diagnoseReason}
              updates={updates}
            />
            {serverHasNetworkTab(detail) ? null : <ServerNetwork detail={detail} />}
            <Capacity detail={detail} />
            <Cluster detail={detail} />
          </>
        }
      />
      <UpdatesDialogs
        u={updates}
        burrow={burrow}
        serverId={serverId}
        thisWhombat={hostsThisWhombat(detail.server)}
      />
    </>
  );
}

function Line({
  title,
  text,
  end,
  tone,
}: {
  title: string;
  text: ReactNode;
  end?: string;
  tone: 'ok' | 'warn' | 'bad' | 'mut';
}) {
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <b>{title}</b>
        <small>
          <StateCell tone={tone} text={typeof text === 'string' ? text : ''} />
        </small>
      </div>
      {end ? <span className={styles.rowEnd}>{end}</span> : null}
    </div>
  );
}

const LOOK_WORDS: Record<Look, string> = {
  processes: 'Processes',
  ports: 'Ports',
  services: 'Services',
  updates: 'Updates',
};

function LookInside({
  burrow,
  serverId,
  allowed,
  reason,
  updates,
}: {
  burrow: string;
  serverId: string;
  allowed: boolean;
  reason?: string | null;
  updates: ServerUpdates;
}) {
  const [look, setLook] = useState<Look | null>(null);
  const q = useHostInspect(look && allowed ? { params: { burrow, serverId, kind: look } } : null, {
    staleTime: 15_000,
  });
  return (
    <Card
      title="Look inside"
      meta={allowed ? undefined : (reason ?? 'Read-only checks are switched off for this server.')}
      link={
        allowed ? (
          <span style={{ marginLeft: 'auto', maxWidth: '100%' }}>
            <SegmentedControl
              options={(Object.keys(LOOK_WORDS) as Look[]).map((k) => ({ value: k, label: LOOK_WORDS[k] }))}
              value={look ?? ('' as Look)}
              onChange={setLook}
              label="Look at"
              size="sm"
              variant="soft"
              className={styles.segWrap}
            />
          </span>
        ) : undefined
      }
    >
      {!look || !allowed ? null : q.error ? (
        <ErrorLine error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data ? (
        <>
          <InspectTable result={q.data} />
          {/* The same Install updates as the Updates line's (SWU-10). */}
          {q.data.kind === 'updates' && q.data.items.length && updates.view.install ? (
            <div className={styles.row}>
              <div className={styles.rowMain} />
              <InstallUpdatesButton u={updates} />
            </div>
          ) : null}
        </>
      ) : (
        <Empty>Asking {serverId}…</Empty>
      )}
    </Card>
  );
}

function InspectTable({ result }: { result: HostInspectResult }) {
  // Each column with the class it drops by (the first is the main one, AP-1754).
  const head = (cols: [string, string?][]) => (
    <thead>
      <tr>
        {cols.map(([c, cls]) => (
          <th key={c} scope="col" className={cls}>
            {c}
          </th>
        ))}
      </tr>
    </thead>
  );
  const note = result.truncated ? <p className={styles.cardNote}>Only the first part is shown.</p> : null;
  switch (result.kind) {
    case 'processes':
      return (
        <>
          <table className={styles.table}>
            {head([['Process', styles.cellMain], ['User', styles.dropM], ['CPU'], ['Memory', styles.dropXs]])}
            <tbody>
              {result.items.map((p) => (
                <tr key={p.pid}>
                  <td title={p.command} className={styles.cellMain}>
                    <span className={styles.mono}>{p.name}</span>{' '}
                    <span className={styles.kind}>{p.container ?? p.pid}</span>
                  </td>
                  <td className={cx(styles.kind, styles.dropM)}>{p.user}</td>
                  <td className={styles.num}>{formatPct1(p.cpuPct)}</td>
                  <td className={cx(styles.num, styles.dropXs)}>{formatBytesBinary(p.rssBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {note}
        </>
      );
    case 'ports':
      return (
        <table className={styles.table}>
          {head([['Port'], ['Listens on', styles.dropS], ['Program', styles.cellMain]])}
          <tbody>
            {result.items.map((p) => (
              <tr key={`${p.proto}${p.address}${p.port}`}>
                <td className={styles.num}>
                  {p.port}/{p.proto}
                </td>
                <td className={cx(styles.kind, styles.dropS)}>{p.address}</td>
                <td className={cx(styles.mono, styles.cellMain)}>{p.process ?? DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'services':
      return (
        <table className={styles.table}>
          {head([['Service', styles.cellMain], ['State'], ['At boot', styles.dropS]])}
          <tbody>
            {result.items.map((s) => (
              <tr key={s.name}>
                <td title={s.description} className={styles.cellMain}>
                  <span className={styles.mono}>{s.name}</span>
                </td>
                <td>
                  <StateCell
                    tone={s.active === 'active' ? 'ok' : s.active === 'failed' ? 'bad' : 'mut'}
                    text={s.sub ?? s.active}
                  />
                </td>
                <td className={cx(styles.kind, styles.dropS)}>{s.enabled ?? DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    default:
      return result.items.length ? (
        <table className={styles.table}>
          {head([['Package', styles.cellMain], ['Now', styles.dropM], ['New']])}
          <tbody>
            {result.items.map((u) => (
              <tr key={u.name}>
                <td className={styles.cellMain}>
                  <span className={styles.mono}>{u.name}</span>{' '}
                  {u.security ? <span className={styles.gtag}>security</span> : null}
                </td>
                <td className={cx(styles.kind, styles.dropM)}>{u.current ?? DASH}</td>
                <td className={styles.mono} style={{ fontSize: 12.5 }}>
                  {u.new}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Nothing to update.</Empty>
      );
  }
}

function Capacity({ detail }: { detail: HostServerDetail }) {
  const v = detail.virtualization;
  if (!v) return null;
  const a = v.allocation;
  const ratio = a.hostThreads ? a.vcpuAllocated / a.hostThreads : a.vcpuOvercommitRatio;
  const memPct = a.hostMemoryGb ? (a.guestMemoryAssignedGb / a.hostMemoryGb) * 100 : null;
  const c = v.capabilities;
  return (
    <Card
      title="Given to machines"
      meta={
        c
          ? [
              c.cpuVirtualization.type,
              c.iommu.enabled ? 'IOMMU on' : null,
              c.nested.enabled ? 'nested on' : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : undefined
      }
    >
      <div className={styles.facts2}>
        <div className={styles.fact}>
          <span className={styles.lbl}>CPU</span>
          <b style={{ color: hostTone(overcommitLevel(ratio)) === 'warn' ? 'var(--warn)' : undefined }}>
            {a.vcpuAllocated} of {a.hostThreads}
          </b>
          <span>{ratio > 1 ? `${formatNum(ratio)}× its threads` : 'threads'}</span>
        </div>
        <div className={styles.fact}>
          <span className={styles.lbl}>Memory</span>
          <b style={{ color: hostTone(memoryAssignedLevel(memPct)) === 'warn' ? 'var(--warn)' : undefined }}>
            {formatNum(a.guestMemoryAssignedGb)} of {formatNum(a.hostMemoryGb)}
            {' '}GB
          </b>
          <span>
            {a.guestMemoryInUseGb != null
              ? `${formatNum(a.guestMemoryInUseGb)} GB in use`
              : formatPct(memPct)}
          </span>
        </div>
        {a.diskIoMbs ? (
          <div className={styles.fact}>
            <span className={styles.lbl}>Disks</span>
            <b>
              {formatNum(a.diskIoMbs.total)}
              {' '}MB/s
            </b>
            <span>by guests now</span>
          </div>
        ) : null}
        {a.networkMbps ? (
          <div className={styles.fact}>
            <span className={styles.lbl}>Network</span>
            <b>{formatNetRate(a.networkMbps.total)}</b>
            <span>by guests now</span>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function Cluster({ detail }: { detail: HostServerDetail }) {
  const c = detail.proxmox?.cluster;
  if (!c) return null;
  return (
    <Card
      title={`Cluster ${c.name}`}
      meta={c.quorate ? `${c.votes.have} of ${c.votes.expected} votes` : 'No quorum'}
    >
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col" className={styles.cellMain}>
              Node
            </th>
            <th scope="col">
              <span className={styles.narrowSr}>State</span>
            </th>
            <th scope="col" className={styles.dropS}>
              CPU
            </th>
            <th scope="col" className={styles.dropS}>
              Memory
            </th>
            <th scope="col" className={styles.dropM}>
              Guests
            </th>
          </tr>
        </thead>
        <tbody>
          {c.nodes.map((n) => (
            <tr key={n.name}>
              <td className={styles.cellMain}>
                {n.serverId && !n.thisNode && n.agent !== 'not_enrolled' ? (
                  <AppLink href={serverHref(n.serverId)} className={styles.name}>
                    {n.name}
                  </AppLink>
                ) : (
                  <span className={styles.mono}>{n.name}</span>
                )}{' '}
                {n.thisNode ? (
                  <span className={styles.kind}>this one</span>
                ) : n.agent === 'not_enrolled' ? (
                  <span className={styles.kind}>not added to Whombat</span>
                ) : null}
              </td>
              <td>
                <StateCell tone={n.status === 'online' ? 'ok' : 'bad'} text={n.status} compact />
              </td>
              <td className={cx(styles.num, styles.dropS)}>{formatPct(n.cpuPct)}</td>
              <td className={cx(styles.num, styles.dropS)}>{formatPct(n.memPct)}</td>
              <td className={cx(styles.num, styles.dropM)}>
                {n.vms} VMs · {n.containers} CTs
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {c.note ? <p className={styles.cardNote}>{c.note}</p> : null}
    </Card>
  );
}

/** Proxmox's failed and running tasks of the last 48 hours, replication and Ceph (Rackoon's ProxmoxActivity). */
function ProxmoxActivity({ detail, now }: { detail: HostServerDetail; now: number }) {
  const tasks = pveActivity(detail, now);
  const replication = detail.health?.pveReplication ?? [];
  const ceph = detail.health?.ceph ?? null;
  const failed = tasks.filter((t) => t.status === 'error').length;
  const guests = new Map(
    [...(detail.proxmox?.guests.vm?.guests ?? []), ...(detail.proxmox?.guests.container?.guests ?? [])].map(
      (g) => [g.id, g.name],
    ),
  );
  const nameOf = (id: string | null | undefined) => (id ? (guests.get(id) ?? id.replace(/^pve:/, '')) : null);
  const ago = (iso: string | null | undefined) => (iso ? formatAgoIso(iso, now) : '');
  // Nothing failed, ran or copies: no card (less-is-more.md AP-1752).
  if (!tasks.length && !replication.length && !ceph) return null;
  return (
    <Card
      title={replication.length || ceph ? 'Tasks and replication' : 'Tasks'}
      meta={failed ? `${plural(failed, 'failed task')} in 48 h` : 'No failed tasks in 48 h'}
    >
      <div className={styles.rows}>
        {ceph ? (
          <div className={styles.row}>
            <div className={styles.rowMain}>
              <b>Ceph</b>
              <small>
                <StateCell
                  tone={ceph.status === 'HEALTH_OK' ? 'ok' : ceph.status === 'HEALTH_ERR' ? 'bad' : 'warn'}
                  text={ceph.status.replace('HEALTH_', '').toLowerCase()}
                />
              </small>
              {ceph.summary.length ? <small>{ceph.summary.join(' · ')}</small> : null}
            </div>
          </div>
        ) : null}
        {tasks.map((t) => {
          const guest = nameOf(t.guestId);
          return (
            <div key={t.id} className={styles.row}>
              <div className={styles.rowMain}>
                <b>
                  {taskWord(t.type)}
                  {guest ? ` of ${guest}` : ''}
                </b>
                <small>
                  <StateCell
                    tone={t.status === 'running' ? 'mut' : t.status === 'warning' ? 'warn' : 'bad'}
                    text={
                      t.status === 'running'
                        ? `Running since ${ago(t.started)}`
                        : t.status === 'warning'
                          ? `Finished with warnings ${ago(t.ended)}`
                          : `Failed ${ago(t.ended)}`
                    }
                  />
                </small>
                {t.message ? (
                  <small className={wc.wcTaskMsg} title={t.message}>
                    {t.message}
                  </small>
                ) : null}
              </div>
              <span className={styles.rowEnd}>{[t.node, t.user].filter(Boolean).join(' · ')}</span>
            </div>
          );
        })}
        {replication.map((r) => {
          const bad = !!r.error || r.fails > 0;
          return (
            <div key={r.id} className={styles.row}>
              <div className={styles.rowMain}>
                <b>
                  Copy of {nameOf(r.guest) ?? r.guest} to {r.target}
                </b>
                <small>
                  <StateCell
                    tone={bad ? 'warn' : 'ok'}
                    text={
                      bad
                        ? `Failing${r.fails > 1 ? ` ${r.fails} times in a row` : ''}${r.lastSync ? `, last copied ${ago(r.lastSync)}` : ''}`
                        : r.lastSync
                          ? `Copied ${ago(r.lastSync)}`
                          : 'Waiting for its first copy'
                    }
                  />
                </small>
                {r.error ? (
                  <small className={wc.wcTaskMsg} title={r.error}>
                    {r.error}
                  </small>
                ) : null}
              </div>
              <span className={styles.rowEnd}>replication {r.id}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

const SWITCHES: { key: keyof HostRemoteToggles; label: string; hint: string }[] = [
  { key: 'console', label: 'Consoles', hint: 'Open guests’ screens and shells in the browser.' },
  { key: 'power', label: 'Guests’ power', hint: 'Start, stop and restart guests.' },
  { key: 'manage', label: 'Changes to guests', hint: 'Settings, disks, snapshots, backups, firewall.' },
  { key: 'hostShell', label: 'Shell on the server', hint: 'A root shell on the server itself.' },
  { key: 'hostPower', label: 'Server’s power', hint: 'Restart or shut down the server.' },
  { key: 'diagnose', label: 'Read-only checks', hint: 'Look inside: processes, ports, services.' },
];

function AgentCard({
  burrow,
  serverId,
  detail,
}: { burrow: string; serverId: string } & Pick<TabProps, 'detail'>) {
  const status = useHostsStatus({ params: { burrow } });
  // Read again every few seconds while its agent updates (agent-updates-app.md AP-2985).
  const settings = useHostServerSettings(
    { params: { burrow, serverId } },
    {
      refetchInterval: (q) => (agentUpdating(q.state.data?.agent?.update) ? AGENT_UPDATE_POLL_MS : false),
    },
  );
  // The agent's Updates row (Whombat agent-updates.md AU-08, AU-09).
  const agentSettings = useHostAgentSettings(
    { params: { burrow } },
    {
      retry: false,
    },
  );
  const update = useHostsChange(api.hosts.updateServer);
  const remove = useHostsChange(api.hosts.removeServer);
  const { run, busy } = useChangeRunner();
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Folded or open by hand; `null` follows the line (open when something needs the person).
  const [shut, setShut] = useState<boolean | null>(null);
  const navigate = useNavigateHref();
  const a = detail.server.agent;
  const s = settings.data;
  const host = detail.server.id;
  const install = s?.agent?.install;
  const blocked = s ? SWITCHES.filter((sw) => s.agentPolicy[sw.key] === false) : [];
  const need = agentUpdateNeed({
    agentVersion: s?.agent?.version ?? a.version,
    serviceVersion: status.data?.version,
    updateAvailable: s?.agent?.update?.available,
  });
  // When its update ends, the page (the agent's version in the card's head) is read again.
  const refresh = useRefreshHosts();
  const nowUpdating = agentUpdating(s?.agent?.update);
  const wasUpdating = useRef(false);
  useEffect(() => {
    if (wasUpdating.current && !nowUpdating) refresh(['hosts.getServer', 'hosts.fleet']);
    wasUpdating.current = nowUpdating;
  }, [nowUpdating, refresh]);
  const updates = agentUpdatesView({
    server: detail.server.id,
    update: s?.agent?.update,
    autoUpdate: agentSettings.data?.autoUpdate ?? null,
    connected: a.connected !== false && detail.server.status !== 'offline',
    now: Date.parse(detail.asOf),
  });
  // The switches fold behind one line; they open by themselves when the server blocks one (AP-1767).
  const line = s
    ? agentSwitchesLine(
        SWITCHES.map((sw) => ({
          label: sw.label,
          on: s.remoteControl[sw.key] === true && s.agentPolicy[sw.key] !== false,
          blocked: s.agentPolicy[sw.key] === false,
        })),
        host,
      )
    : null;
  const open = shut === null ? line?.attention === true : !shut;
  const removeRow = (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <small>Removing forgets this server and its history; its helper is no longer accepted.</small>
      </div>
      <Button size="sm" onClick={() => setRemoving(true)}>
        Remove {serverId}
      </Button>
    </div>
  );
  return (
    <Card title="Whombat’s helper">
      <div className={styles.rows}>
        <div className={styles.row}>
          <div className={styles.rowMain}>
            <b>Connection</b>
            <small>
              <StateCell
                tone={a.connected === false ? 'bad' : 'ok'}
                text={
                  a.connected === false
                    ? 'Isn’t checking in'
                    : `Checking in${a.lastSyncSAgo != null ? `, last ${formatAgo(a.lastSyncSAgo)}` : ''}`
                }
              />
            </small>
          </div>
        </div>
        {updates ? (
          // The Updates row says how to get a newer agent, so “Update the agent first” isn't said again (AP-2984).
          <AgentUpdatesRow burrow={burrow} serverId={serverId} host={host} install={install} view={updates} />
        ) : blocked.length && need !== 'no' ? (
          <UpdateFirst burrow={burrow} host={host} install={install} need={need} version={a.version} />
        ) : null}
        {/* “Asks you first” (Whombat server-asks.md SA-01, SA-05; AP-1717). */}
        {s ? (
          <AsksFirstRow
            burrow={burrow}
            serverId={serverId}
            name={host}
            value={s.asksFirst ?? detail.server.asksFirst ?? HOST_ASKS_FIRST_DEFAULT}
            self={detail.server.hostsThisWhombat === true}
          />
        ) : null}
        {s && line ? (
          <details className={styles.fold} open={open} onToggle={(e) => setShut(!e.currentTarget.open)}>
            <summary>
              <span className={styles.rowMain}>
                <b>What Whombat may do here</b>
                <small>
                  <StateCell
                    tone={line.attention ? 'warn' : line.text.startsWith('All') ? 'ok' : 'mut'}
                    text={line.text}
                  />
                </small>
              </span>
              <span className={styles.foldMore}>
                {open ? 'Hide' : 'Details'}
                <Icon icon={ChevronRight} size={14} />
              </span>
            </summary>
            {SWITCHES.map((sw) => {
              const agentOff = s.agentPolicy[sw.key] === false;
              const on = s.remoteControl[sw.key] === true;
              return (
                <div key={sw.key} className={styles.row}>
                  <div className={styles.rowMain}>
                    <b id={`sw-${sw.key}`}>{sw.label}</b>
                    <small>{agentOff ? `Switched off on ${host} itself.` : sw.hint}</small>
                    {agentOff ? <AllowCommand host={host} command={allowCommand(sw.key, install)} /> : null}
                  </div>
                  <Toggle
                    aria-labelledby={`sw-${sw.key}`}
                    checked={on && !agentOff}
                    disabled={agentOff || busy}
                    onCheckedChange={(v) =>
                      void run(
                        () =>
                          update.mutateAsync({
                            params: { burrow, serverId },
                            body: { remoteControl: { [sw.key]: v } },
                          }),
                        `${sw.label}: ${v ? 'on' : 'off'}.`,
                      )
                    }
                  />
                </div>
              );
            })}
            {removeRow}
          </details>
        ) : (
          removeRow
        )}
      </div>
      <ConfirmDialog
        open={removing}
        title={`Remove ${serverId}?`}
        body="Whombat forgets the server and its history. The server itself keeps running; remove Whombat’s helper there."
        confirm="Remove"
        serious
        busy={busy}
        error={error}
        onClose={() => {
          setRemoving(false);
          setError(null);
        }}
        onConfirm={() =>
          void (async () => {
            const out = await run(
              () => remove.mutateAsync({ params: { burrow, serverId } }),
              `Removed ${serverId}.`,
              {
                inline: true,
              },
            );
            // Back to Connections, where the servers are (connections-page.md CN-09, AP-2523).
            if (out.ok) navigate(CONNECTIONS_HREF, { replace: true });
            else if (out.error) setError(out.message);
            else setRemoving(false);
          })()
        }
      />
    </Card>
  );
}

/**
 * “Asks you first” (Whombat server-asks.md SA-01, SA-08; AP-1717, AP-1718): Before risky actions · Never, the hint for
 * the choice (and, on the server this Whombat runs on, that it still asks before restarting or shutting it down).
 * Never widens what Whombat does, so it asks first (“Stop asking”); back to Before risky actions saves at once.
 */
function AsksFirstRow({
  burrow,
  serverId,
  name,
  value,
  self,
}: {
  burrow: string;
  serverId: string;
  name: string;
  value: HostAsksFirst;
  self: boolean;
}) {
  const W = HOST_ASKS_FIRST_WORDS;
  const update = useHostsChange(api.hosts.updateServer);
  const { run, busy } = useChangeRunner();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (asksFirst: HostAsksFirst, inline = false) =>
    run(
      () => update.mutateAsync({ params: { burrow, serverId }, body: { asksFirst } }),
      W.changed(name, asksFirst),
      { inline },
    );
  return (
    <div className={styles.row} data-row="asks-first">
      <div className={styles.rowMain}>
        <b id="asks-first">{W.label}</b>
        <small id="asks-first-hint">
          {W.hint[value]}
          {self ? ` ${W.selfNote(name)}` : ''}
        </small>
      </div>
      <SegmentedControl
        options={HOST_ASKS_FIRST.map((v) => ({ value: v, label: W.choices[v] }))}
        value={value}
        onChange={(v) => {
          if (v === value) return;
          if (v === 'never') setConfirming(true);
          else void save(v);
        }}
        label={W.label}
        role="radiogroup"
        describedBy="asks-first-hint"
        size="sm"
        disabled={busy}
      />
      <ConfirmDialog
        open={confirming}
        title={W.confirmTitle(name)}
        body={W.confirmBody(name)}
        confirm={W.confirm}
        busy={busy}
        error={error}
        onClose={() => {
          setConfirming(false);
          setError(null);
        }}
        onConfirm={() =>
          void (async () => {
            const out = await save('never', true);
            if (out.ok) setConfirming(false);
            else if (out.error) setError(out.message);
            else setConfirming(false);
          })()
        }
      />
    </div>
  );
}

/** The command that allows a switch the server blocks (PX-04), to copy and run there. */
function AllowCommand({ host, command }: { host: string; command: string }) {
  return (
    <div className={wc.wcCmd}>
      <div className={wc.wcCmdLine}>
        <code className={styles.code}>{command}</code>
        <CopyButton text={command} copied="Command copied." className={`${styles.cardLink} ${wc.wcCopy}`}>
          Copy
        </CopyButton>
      </div>
      <p className={wc.wcCmdNote}>Run this on {host}, then come back.</p>
    </div>
  );
}

/**
 * The install command as an update (PX-04): the same line without its one-time enrollment, which the installer reads
 * as “update the agent in place”. Asked for on demand: making it starts an enrollment.
 */
function useUpdateCommand(burrow: string, install?: string | null) {
  const create = useHostsChange(api.hosts.createEnrollment);
  const { run, busy } = useChangeRunner();
  const [command, setCommand] = useState<string | null>(null);
  const get = async () => {
    const out = await run(() => create.mutateAsync({ params: { burrow } }), null);
    if (out.ok) setCommand(updateCommand(out.data.installCommand, install));
  };
  return { command, busy, get: () => void get() };
}

/** The command to copy and run on the server, with what it does. */
function UpdateCommandBlock({ command, note }: { command: string; note: string }) {
  return (
    <div className={wc.wcCmd}>
      <div className={wc.wcCmdLine}>
        <code className={styles.code}>{command}</code>
        <CopyButton text={command} copied="Command copied." className={`${styles.cardLink} ${wc.wcCopy}`}>
          Copy
        </CopyButton>
      </div>
      <p className={wc.wcCmdNote}>{note}</p>
    </div>
  );
}

/**
 * Agents older than the `allow` command update first: the install command again (on a Whombat without
 * `hosts.agent_updates`; with it, the Updates row says what to do).
 */
function UpdateFirst({
  burrow,
  host,
  install,
  need,
  version,
}: {
  burrow: string;
  host: string;
  install?: string | null;
  need: 'yes' | 'maybe';
  version: string | null;
}) {
  const { command, busy, get } = useUpdateCommand(burrow, install);
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <b>Update Whombat’s helper first</b>
        <small>
          {need === 'yes'
            ? `Whombat’s helper on ${host}${version ? ` (${version})` : ''} is older than the switches below: run its install command there again first.`
            : `If ${host} says it doesn’t know “allow”, update Whombat’s helper first: run its install command there again.`}
        </small>
        {command ? (
          <UpdateCommandBlock
            command={command}
            note="It updates the helper in place and keeps its settings."
          />
        ) : null}
      </div>
      {command ? null : (
        <Button size="sm" disabled={busy} onClick={get}>
          {busy ? 'Making it…' : 'Show the install command'}
        </Button>
      )}
    </div>
  );
}

/**
 * The agent's Updates row (Whombat agent-updates.md AU-07, AU-08; agent-updates-app.md AP-2981…AP-2985): kept up to
 * date, updating, waiting, couldn't, needs one more install, turned off on the server, automatic updates off — with
 * Try again, Update the agent or Update now (`hosts.updateAgent`), or the install command where Whombat may not run the
 * last install itself. `agentUpdatesView` decides.
 */
function AgentUpdatesRow({
  burrow,
  serverId,
  host,
  install,
  view,
}: {
  burrow: string;
  serverId: string;
  host: string;
  install?: string | null;
  view: AgentUpdatesView;
}) {
  const W = AGENT_UPDATE_WORDS;
  const update = useHostsChange(api.hosts.updateAgent);
  const { run, busy } = useChangeRunner();
  const cmd = useUpdateCommand(burrow, install);
  const press = () =>
    void run(
      () => update.mutateAsync({ params: { burrow, serverId } }),
      (data) => W.started(data.state, host),
    );
  return (
    <div className={styles.row} data-row="agent-updates">
      <div className={styles.rowMain}>
        <b>{W.title}</b>
        <small>
          <StateCell tone={view.tone} text={view.text} />
        </small>
        {view.command && cmd.command ? (
          <UpdateCommandBlock command={cmd.command} note={W.commandNote} />
        ) : null}
      </div>
      {view.updated ? <span className={styles.rowEnd}>{view.updated}</span> : null}
      {view.action ? (
        <Button
          size="sm"
          variant={view.action.kind === 'install' ? 'primary' : undefined}
          disabled={busy}
          onClick={press}
        >
          {view.action.label}
        </Button>
      ) : null}
      {view.command && !cmd.command ? (
        <Button size="sm" disabled={cmd.busy} onClick={cmd.get}>
          {cmd.busy ? W.making : W.showCommand}
        </Button>
      ) : null}
    </div>
  );
}
