// Guests tab of a host (UI v2): a platform control, name filter and
// List / Screens toggle above the guests table; the console of a guest opens
// as a side panel next to the table (full width on narrow screens). Table
// columns per platform follow S9; the console lifecycle is in ../console.
// Guest names open the guest page; with the power permission rows get
// checkboxes for bulk actions; admins with Manage get "Create" and, on
// Proxmox, the host's templates under the table (docs/MANAGE.md).

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useAuthState, useGuests } from '../../api/queries';
import type { Guest, ServerDetail } from '../../api/types';
import { Dot, Meter, SegmentedControl } from '../../components/controls';
import { Icon } from '../../components/Icon';
import { ConsolePanel, ScreensWall } from '../console';
import { GuestMenu } from '../guests/GuestMenu';
import { guestStateInfo } from '../guests/guestActions';
import { BulkBar } from '../manage/BulkBar';
import type { CreateKind } from '../manage/CreateGuestDialog';
import { CreateMenu } from '../manage/CreateMenu';
import { TagChips } from '../manage/TagChips';
import { TemplatesList } from '../manage/TemplatesList';
import { useNow } from '../../lib/clock';
import { DASH, formatAgoIso, formatFull, formatMemPair, formatNum, formatPct1, formatTime, formatUptimeShort } from '../../lib/format';
import { t, tn } from '../../lib/i18n';
import { guestPath } from '../../lib/urlState';
import { footerText, type PlatformTab, sortByCpu } from './platforms';

interface Column {
  head: string;
  width: string;
  cell: (g: Guest) => ReactNode;
}

/** Docker "Exited 6 h ago": the fixtures carry display text, the hub an ISO timestamp (CONTRACT 7.1). */
function exitedText(lastExit: string | null | undefined, now: number): string {
  if (!lastExit) return t('Exited');
  return /^\d{4}-\d{2}-\d{2}T/.test(lastExit) ? t('Exited {time}', { time: formatAgoIso(lastExit, now) }) : t('Exited {time}', { time: lastExit });
}

const pair = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? DASH : `${formatNum(a)} / ${formatNum(b)}`);

export function CpuCell({ g }: { g: Guest }) {
  const v = g.cpu_pct;
  return (
    <span className="cpu-cell">
      <Meter pct={v == null ? 0 : Math.min(100, v)} color="var(--series-cpu)" style={{ opacity: v == null ? 0.4 : 1 }} />
      <span className="val">{v == null ? DASH : formatPct1(v)}</span>
    </span>
  );
}

export function StateCell({ g }: { g: Guest }) {
  const s = guestStateInfo(g.state);
  return (
    <span className="state">
      <Dot color={s.color} />
      {s.label}
    </span>
  );
}

function BackupCell({ g, now }: { g: Guest; now: number }) {
  const b = g.last_backup;
  if (!b) return <span className="ink-3">{DASH}</span>;
  const at = Date.parse(b.at);
  const ok = b.result === 'ok';
  const when = now - at < 86_400_000 && new Date(at).toDateString() === new Date(now).toDateString() ? formatTime(at) : formatAgoIso(b.at, now);
  return (
    <span className="state" title={formatFull(at)}>
      <Dot color={ok ? 'var(--good)' : 'var(--critical)'} />
      {ok ? t('OK {time}', { time: when }) : t('Failed {time}', { time: when })}
    </span>
  );
}

/** Restarts below this are not worth a mention (restart policies, host reboots). */
const RESTARTS_SHOWN = 3;

/** "3 d · 5 restarts" while running; "Exited 6 h ago · OOM" / "· 137" when stopped (full text in the title). */
export function dockerUptime(g: Guest, now: number): { text: string; title?: string } {
  if (g.state === 'stopped') {
    const exited = exitedText(g.last_exit, now);
    if (g.oom_killed) return { text: `${exited} · OOM`, title: t('{exited}, killed for running out of memory (exit code {code})', { exited, code: g.exit_code ?? 137 }) };
    if (g.exit_code) return { text: `${exited} · ${g.exit_code}`, title: t('{exited} with exit code {code}', { exited, code: g.exit_code }) };
    return { text: exited };
  }
  const up = formatUptimeShort(g.uptime_s);
  return g.restarts != null && g.restarts >= RESTARTS_SHOWN ? { text: t('{uptime} · {n} restarts', { uptime: up, n: g.restarts }) } : { text: up };
}

/** A guest's name as the link to its page. */
function GuestLink({ serverId, g, mono = true }: { serverId: string; g: Guest; mono?: boolean }) {
  return (
    <Link to={guestPath(serverId, g.id)} className={mono ? 'guest-link mono' : 'guest-link'}>
      {g.name}
    </Link>
  );
}

function columnsFor(serverId: string, tab: PlatformTab, now: number, guests: Guest[] = []): Column[] {
  const text = (v: ReactNode) => <span className="ellipsis ink-2">{v}</span>;
  if (tab.table === 'docker') {
    // The compose project only tells containers apart when there are several.
    const manyProjects = new Set(guests.map((g) => g.project).filter(Boolean)).size > 1;
    return [
      {
        head: t('Name'),
        width: 'minmax(0,1.3fr)',
        cell: (g) => (
          <span className="ellipsis" title={g.project ? t('Compose project {name}', { name: g.project }) : undefined}>
            <GuestLink serverId={serverId} g={g} />
            {g.project && manyProjects && <span className="lbl"> · {g.project}</span>}
          </span>
        ),
      },
      {
        head: t('Image'),
        width: 'minmax(0,1.4fr)',
        cell: (g) => (
          <span className="ellipsis ink-2" title={g.update_available ? t('The registry has a newer image for this tag') : undefined}>
            {g.image}
            {g.update_available && <span className="tone-warn"> · {t('update')}</span>}
          </span>
        ),
      },
      { head: t('State'), width: '110px', cell: (g) => <StateCell g={g} /> },
      { head: t('CPU'), width: '120px', cell: (g) => <CpuCell g={g} /> },
      { head: t('Memory'), width: '130px', cell: (g) => text(formatMemPair(g.memory_used_mb, g.memory_limit_mb)) },
      {
        head: t('Uptime'),
        width: '130px',
        cell: (g) => {
          const u = dockerUptime(g, now);
          return (
            <span className="ellipsis ink-2" title={u.title}>
              {u.text}
            </span>
          );
        },
      },
    ];
  }
  const common: Column[] = [
    { head: t('State'), width: '96px', cell: (g) => <StateCell g={g} /> },
    { head: 'vCPU', width: '44px', cell: (g) => text(g.vcpu ?? DASH) },
    { head: t('CPU'), width: '110px', cell: (g) => <CpuCell g={g} /> },
  ];
  if (tab.table === 'pve') {
    return [
      { head: 'ID', width: '52px', cell: (g) => <span className="mono">{g.vmid ?? g.id.split(':')[1]}</span> },
      {
        head: t('Name'),
        width: 'minmax(120px,1.2fr)',
        cell: (g) => (
          <span className="ellipsis guest-name">
            <GuestLink serverId={serverId} g={g} mono={false} />
            <TagChips tags={g.tags} />
          </span>
        ),
      },
      ...common,
      { head: t('Memory'), width: '110px', cell: (g) => text(formatMemPair(g.memory_used_mb, g.memory_limit_mb)) },
      { head: t('Disk R/W'), width: '90px', cell: (g) => text(pair(g.disk_read_mbs, g.disk_write_mbs)) },
      { head: t('Net rx/tx'), width: '90px', cell: (g) => text(pair(g.net_rx_mbps, g.net_tx_mbps)) },
      { head: t('Backup'), width: '100px', cell: (g) => <BackupCell g={g} now={now} /> },
    ];
  }
  const typeImage = (g: Guest) => (tab.key === 'incus' ? `${g.kind === 'vm' ? 'VM' : 'CT'} · ${g.image}` : g.image);
  return [
    {
      head: t('Name'),
      width: 'minmax(0,1.1fr)',
      cell: (g) => (
        <span className="ellipsis">
          <GuestLink serverId={serverId} g={g} />
        </span>
      ),
    },
    { head: t('Type · image'), width: 'minmax(0,1.2fr)', cell: (g) => text(typeImage(g)) },
    ...common,
    { head: t('Memory'), width: '100px', cell: (g) => text(formatMemPair(g.memory_used_mb, g.memory_limit_mb)) },
    { head: t('Disk R/W'), width: '90px', cell: (g) => text(pair(g.disk_read_mbs, g.disk_write_mbs)) },
    { head: t('Net rx/tx'), width: '90px', cell: (g) => text(pair(g.net_rx_mbps, g.net_tx_mbps)) },
    { head: t('Snaps'), width: '48px', cell: (g) => text(g.snapshots ?? DASH) },
  ];
}

// Minimum table widths (the table scrolls inside its card below these).
const MIN_WIDTH = { docker: 800, vm: 930, pve: 970 } as const;

/** Shell / Console / Logs button text and accessible name of a row (a stopped Docker container still has its logs). */
function consoleLabel(g: Guest): { text: string; aria: string; icon: 'monitor' | 'terminal'; dim: boolean } {
  if (g.kind === 'vm') return { text: t('Console'), aria: t('Open console for {name}', { name: g.name }), icon: 'monitor', dim: g.state !== 'running' };
  if (g.state === 'stopped' && g.console.protocols?.includes('logs')) return { text: t('Logs'), aria: t('Open logs for {name}', { name: g.name }), icon: 'terminal', dim: false };
  return { text: t('Shell'), aria: t('Open shell for {name}', { name: g.name }), icon: 'terminal', dim: g.state !== 'running' };
}

interface GuestsProps {
  serverId: string;
  detail: ServerDetail;
  tabs: PlatformTab[];
  tab: PlatformTab;
  onSelectTab: (key: PlatformTab['key']) => void;
  view: 'list' | 'screens';
  onView: (v: 'list' | 'screens') => void;
  query: string;
  onQuery: (q: string) => void;
  consoleGuestId: string | null;
  protocol: string | null;
  onProtocolChange: (p: string) => void;
  onOpenConsole: (guestId: string) => void;
  onCloseConsole: () => void;
}

export function GuestsTab(p: GuestsProps) {
  const { tab } = p;
  const now = useNow();
  const full = useGuests(p.serverId, tab.api.platform, tab.api.kind, true);
  // The detail body carries the first page; the /guests endpoint the full list.
  const all = full.data?.guests ?? tab.workload.guests;
  const total = Math.max(full.data?.total ?? tab.workload.total, all.length);
  const sorted = useMemo(() => sortByCpu(all), [all]);
  const q = p.query.trim().toLowerCase();
  const shown = q ? sorted.filter((g) => g.name.toLowerCase().includes(q)) : sorted;
  const cols = columnsFor(p.serverId, tab, now, all);
  const rc = p.detail.server.remote_control;
  const auth = useAuthState();
  const isAdmin = auth.data?.user?.role === 'admin';
  // Bulk selection (power permission): guest ids, kept while the rows are listed.
  const selectable = !!rc?.power;
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  useEffect(() => setSelected(new Set()), [p.serverId, tab.key]);
  const picked = shown.filter((g) => selected.has(g.id));
  const allPicked = shown.length > 0 && picked.length === shown.length;
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const createKinds: CreateKind[] = isAdmin && rc?.manage ? [...(p.tabs.some((x) => x.key === 'vm' || x.key === 'ct') ? (['vm', 'container'] as const) : []), ...(p.tabs.some((x) => x.key === 'incus') ? (['incus'] as const) : [])] : [];
  // Docker containers have Shell and Logs (no Screens view); the row menu needs the power permission.
  const consoleCol = tab.hasConsole || tab.table === 'docker';
  const menuCol = true; // History for everyone; power items with the permission
  const grid = [...(selectable ? ['18px'] : []), ...cols.map((c) => c.width), ...(consoleCol || menuCol ? [`${(consoleCol ? 88 : 0) + (menuCol ? 36 : 0)}px`] : [])].join(' ');
  const consoleGuest = p.consoleGuestId ? (all.find((g) => g.id === p.consoleGuestId) ?? null) : null;
  const consoleAllowed = rc?.console ?? true;
  const consoleReason = consoleAllowed ? undefined : (rc?.console_reason ?? t('Remote control is turned off for this server'));
  const titleId = 'guests-title';
  const hasConsole = !!p.consoleGuestId;

  return (
    <section className="section" aria-labelledby={titleId}>
      <div className="guests-tools">
        <SegmentedControl
          label={t('Platform')}
          value={tab.key}
          onChange={p.onSelectTab}
          options={p.tabs.map((pt) => ({ value: pt.key, label: pt.name, count: pt.workload.total }))}
        />
        <div className="input-search">
          <Icon name="search" size={15} />
          <input type="search" aria-label={t('Filter {noun} by name', { noun: tab.noun[1] })} placeholder={t('Filter by name')} value={p.query} onChange={(e) => p.onQuery(e.target.value)} />
        </div>
        <span className="spacer" />
        <CreateMenu serverId={p.serverId} kinds={createKinds} />
        {tab.hasConsole && (
          <SegmentedControl
            label={t('View')}
            value={p.view}
            onChange={p.onView}
            options={[
              { value: 'list', label: t('List') },
              { value: 'screens', label: t('Screens') },
            ]}
          />
        )}
      </div>
      <PlatformWarnings tab={tab} />

      <div className={hasConsole ? 'guests-split has-console' : 'guests-split'}>
        <div id="guests" className="card guests-card">
          <div className="card-head">
            <h2 className="h2" id={titleId}>
              {tab.title}
            </h2>
            <span className="sub">
              {t('{running} running of {total}', { running: tab.workload.running, total })}
            </span>
          </div>
          {p.view === 'screens' && tab.hasConsole ? (
            <>
              <ScreensWall server={p.detail} guests={shown} onOpenConsole={p.onOpenConsole} onClose={() => p.onView('list')} />
              {shown.length === 0 && <div className="guests-empty">{q ? t('No {noun} match “{query}”.', { noun: tab.noun[1], query: p.query.trim() }) : t('No {noun} on this host.', { noun: tab.noun[1] })}</div>}
              <div className="lbl guests-foot" aria-live="polite">
                {footerText(tab, shown.length, q ? sorted.length : total, p.query)}
              </div>
            </>
          ) : (
            <>
              {selectable && (
                <BulkBar
                  items={picked.map((g) => ({ server: p.serverId, guest: g, power: true }))}
                  onClear={() => setSelected(new Set())}
                />
              )}
              <div className="table-scroll">
                <div role="table" aria-labelledby={titleId} aria-rowcount={shown.length + 1} style={{ minWidth: MIN_WIDTH[tab.table] }}>
                  <div className="trow thead" role="row" style={{ gridTemplateColumns: grid }}>
                    {selectable && (
                      <span role="columnheader">
                        <input
                          type="checkbox"
                          className="lc-check"
                          aria-label={t('Select all {noun}', { noun: tab.noun[1] })}
                          checked={allPicked}
                          ref={(el) => {
                            if (el) el.indeterminate = picked.length > 0 && !allPicked;
                          }}
                          onChange={(e) => setSelected(e.target.checked ? new Set(shown.map((g) => g.id)) : new Set())}
                        />
                      </span>
                    )}
                    {cols.map((c) => (
                      <span key={c.head} className="lbl" role="columnheader">
                        {c.head}
                      </span>
                    ))}
                    {(consoleCol || menuCol) && (
                      <span className="lbl" role="columnheader">
                        {consoleCol ? t('Console') : <span className="sr-only">{t('Actions')}</span>}
                      </span>
                    )}
                  </div>
                  {shown.map((g) => (
                    <div
                      key={g.id}
                      className={`trow guest-row${g.state === 'stopped' ? ' is-stopped' : ''}${g.id === p.consoleGuestId ? ' is-selected' : ''}`}
                      role="row"
                      aria-selected={hasConsole ? g.id === p.consoleGuestId : undefined}
                      style={{ gridTemplateColumns: grid }}
                    >
                      {selectable && (
                        <div className="tcell" role="cell">
                          <input type="checkbox" className="lc-check" aria-label={t('Select {name}', { name: g.name })} checked={selected.has(g.id)} onChange={(e) => toggle(g.id, e.target.checked)} />
                        </div>
                      )}
                      {cols.map((c) => (
                        <div key={c.head} className="tcell" role="cell">
                          {c.cell(g)}
                        </div>
                      ))}
                      {(consoleCol || menuCol) && (
                        <div className="tcell row-tools" role="cell">
                          {consoleCol &&
                            (g.console.available !== false && (g.console.protocols?.length ?? 1) > 0 ? (
                              <ConsoleButton g={g} allowed={consoleAllowed} reason={consoleReason} onOpen={() => p.onOpenConsole(g.id)} />
                            ) : (
                              <span className="lbl">{DASH}</span>
                            ))}
                          <GuestMenu serverId={p.serverId} guest={g} rc={rc} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              {!consoleAllowed && consoleCol && (
                <span id="console-disabled-reason" className="sr-only">
                  {consoleReason}
                </span>
              )}
              {shown.length === 0 && <div className="guests-empty">{q ? t('No {noun} match “{query}”.', { noun: tab.noun[1], query: p.query.trim() }) : t('No {noun} on this host.', { noun: tab.noun[1] })}</div>}
              <div className="lbl guests-foot" aria-live="polite">
                {footerText(tab, shown.length, q ? sorted.length : total, p.query)}
              </div>
              {tab.table === 'pve' && rc?.manage && <TemplatesList serverId={p.serverId} kind={tab.key === 'ct' ? 'container' : 'vm'} isAdmin={isAdmin} />}
            </>
          )}
        </div>

        {hasConsole &&
          (consoleGuest ? (
            <ConsolePanel
              compact
              server={p.detail}
              guest={consoleGuest}
              guests={sorted}
              listTitle={tab.railTitle}
              protocol={p.protocol}
              onProtocolChange={p.onProtocolChange}
              onSelectGuest={p.onOpenConsole}
              onClose={p.onCloseConsole}
            />
          ) : (
            <div className="card con is-compact">
              <div className="con-head">
                <button type="button" className="btn-ghost" onClick={p.onCloseConsole}>
                  <Icon name="close" size={15} />
                  {t('Close')}
                </button>
                <span className="ink-2">{full.isPending ? t('Loading guest…') : t('Guest {id} was not found on this host.', { id: p.consoleGuestId ?? '' })}</span>
              </div>
            </div>
          ))}
      </div>
    </section>
  );
}

/** Warnings the platform reports (Incus warnings, Docker daemon warnings): one quiet line, the rest in its title. */
function PlatformWarnings({ tab }: { tab: PlatformTab }) {
  const w = tab.workload.warnings ?? [];
  if (!w.length) return null;
  const first = w[0]!;
  const all = w.map((x) => `${x.message}${x.count > 1 ? ` (${x.count}×)` : ''}`).join('\n');
  return (
    <div className="lbl platform-warnings" title={all}>
      <span className="tone-warn">{tn(w.length, '{platform} reports a warning', '{platform} reports {n} warnings', { platform: tab.name })}</span>
      {': '}
      {first.message}
      {first.count > 1 ? ` (${first.count}×)` : ''}
      {w.length > 1 ? ' …' : ''}
    </div>
  );
}

function ConsoleButton({ g, allowed, reason, onOpen }: { g: Guest; allowed: boolean; reason: string | undefined; onOpen: () => void }) {
  const l = consoleLabel(g);
  return (
    <button
      type="button"
      className={`btn-ghost row-action${l.dim ? ' is-dim' : ''}`}
      aria-label={l.aria}
      aria-disabled={allowed ? undefined : true}
      aria-describedby={allowed ? undefined : 'console-disabled-reason'}
      title={reason}
      onClick={() => allowed && onOpen()}
    >
      <Icon name={l.icon} size={14} />
      {l.text}
    </button>
  );
}
