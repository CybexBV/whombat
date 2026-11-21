// Guests (UI v2): every VM and container on every host in one list
// (GET /guests, CONTRACT 1) with search, state, platform, tag and host
// filters, sorting and a console side panel. Filters live in the URL. Names
// open the guest page; with the power permission on a listed host, rows get
// checkboxes for bulk actions (docs/MANAGE.md).

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useAuthState, useGuestList, useServer, useServers } from '../../api/queries';
import type { FleetGuest, GuestState, Platform, RemoteControl } from '../../api/types';
import { Skeleton } from '../../components/common';
import { Dot, Meter, SegmentedControl } from '../../components/controls';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { useDebounced } from '../../components/popover';
import { useNow } from '../../lib/clock';
import { DASH, formatAgoIso, formatMemPair, formatPct1, formatUptimeShort, plural } from '../../lib/format';
import { t, tn } from '../../lib/i18n';
import { guestPath, hostPath, useParamSetter } from '../../lib/urlState';
import { useTitle } from '../../lib/useTitle';
import { useOpenEnroll } from '../agents/enrollLink';
import { ConsolePanel } from '../console';
import { BulkBar } from '../manage/BulkBar';
import { TagChips } from '../manage/TagChips';
import { GuestMenu } from './GuestMenu';
import { guestStateInfo } from './guestActions';

const PLATFORMS: { key: Platform; label: string }[] = [
  { key: 'docker', label: 'Docker' },
  { key: 'incus', label: 'Incus' },
  { key: 'pve', label: 'Proxmox' },
  { key: 'libvirt', label: 'libvirt' },
];
const STATES: { value: GuestState | ''; label: string; count: 'all' | 'running' | 'stopped' | 'unhealthy' }[] = [
  { value: '', label: t('All'), count: 'all' },
  { value: 'running', label: t('Running'), count: 'running' },
  { value: 'stopped', label: t('Stopped'), count: 'stopped' },
  { value: 'unhealthy', label: t('Unhealthy'), count: 'unhealthy' },
];
const PAGE = 100;
const SORT_LABEL: Record<string, string> = { cpu: t('CPU'), memory: t('Memory'), name: t('Name'), state: t('State'), server: t('Host') };
/** Keys that sort high to low unless asked otherwise (the hub's defaults). */
const DESC_FIRST = new Set(['cpu', 'memory']);

/** Parses `sort` ("cpu", "-name", "+memory") into key and direction. */
export function parseSort(sort: string): { key: string; desc: boolean } {
  const key = sort.replace(/^[-+]/, '') || 'cpu';
  const desc = sort.startsWith('-') ? true : sort.startsWith('+') ? false : DESC_FIRST.has(key);
  return { key, desc };
}

/** The sort after clicking a column: the same column flips, another starts in its natural direction. */
export function nextSort(current: string, key: string): string {
  const cur = parseSort(current);
  if (cur.key !== key) return key;
  const desc = !cur.desc;
  return desc === DESC_FIRST.has(key) ? key : `${desc ? '-' : '+'}${key}`;
}

function kindText(g: FleetGuest): string {
  switch (g.platform) {
    case 'docker':
      return 'Docker';
    case 'incus':
      return g.kind === 'vm' ? 'Incus VM' : 'Incus CT';
    case 'libvirt':
      return 'libvirt VM';
    default:
      return g.kind === 'vm' ? `VM${g.vmid != null ? ` ${g.vmid}` : ''}` : `LXC${g.vmid != null ? ` ${g.vmid}` : ''}`;
  }
}

/** `?console=<server>/<guestId>` */
export function parseConsoleParam(v: string | null): { server: string; guestId: string } | null {
  if (!v) return null;
  const i = v.indexOf('/');
  if (i <= 0) return null;
  return { server: v.slice(0, i), guestId: v.slice(i + 1) };
}

function ConsoleSide({ guest, protocol, onProtocol, onClose }: { guest: FleetGuest; protocol: string | null; onProtocol: (p: string) => void; onClose: () => void }) {
  const detail = useServer(guest.server, '24h');
  if (!detail.data) {
    return (
      <div className="card con is-compact">
        <div className="con-head">
          <button type="button" className="btn-ghost" onClick={onClose}>
            <Icon name="close" size={15} />
            {t('Close')}
          </button>
          {detail.isError ? (
            <InlineRetry title={t('Could not load {name}', { name: guest.server })} error={detail.error} onRetry={() => void detail.refetch()} />
          ) : (
            <span className="ink-2">{t('Loading {name}…', { name: guest.server })}</span>
          )}
        </div>
      </div>
    );
  }
  return <ConsolePanel compact server={detail.data} guest={guest} guests={[]} listTitle={t('Guests')} protocol={protocol} onProtocolChange={onProtocol} onSelectGuest={() => {}} onClose={onClose} />;
}

export function GuestsPage() {
  useTitle(t('Guests'));
  const [params, setParam] = useParamSetter();
  const q = params.get('q') ?? '';
  const state = (params.get('state') ?? '') as GuestState | '';
  const platform = (params.get('platform') ?? '') as Platform | '';
  const server = params.get('server') ?? '';
  const tag = params.get('tag') ?? '';
  const sort = params.get('sort') ?? 'cpu';
  const con = parseConsoleParam(params.get('console'));
  const [text, setText] = useState(q);
  const debounced = useDebounced(text, 200);
  useEffect(() => {
    if (debounced !== q) setParam('q', debounced || null);
    // Only the debounced text drives the URL.
  }, [debounced]);
  useEffect(() => setText(q), [q]);
  // Pages: a stack of cursors (Back pops one).
  const [cursors, setCursors] = useState<string[]>([]);
  useEffect(() => setCursors([]), [q, state, platform, server, tag, sort]);
  const cursor = cursors[cursors.length - 1];

  const list = useGuestList({ q, state, platform, server, tag, sort, limit: PAGE, ...(cursor ? { cursor } : {}) });
  const servers = useServers();
  const auth = useAuthState();
  const isAdmin = auth.data?.user?.role === 'admin';
  const openEnroll = useOpenEnroll();
  const now = useNow();
  const d = list.data;
  const guests = d?.guests ?? [];
  const offlineHosts = useMemo(() => new Set((servers.data ?? []).filter((s) => s.status === 'offline').map((s) => s.id)), [servers.data]);
  const perms = useMemo(() => new Map<string, RemoteControl | undefined>((servers.data ?? []).map((s) => [s.id, s.remote_control])), [servers.data]);
  // Bulk selection: "server/guestId" of the rows on this page whose host allows power actions.
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  useEffect(() => setChosen(new Set()), [q, state, platform, server, tag, sort, cursor]);
  const keyOf = (g: FleetGuest) => `${g.server}/${g.id}`;
  const canPower = (g: FleetGuest) => !!perms.get(g.server)?.power && g.server_online && !offlineHosts.has(g.server);
  const selectable = guests.filter(canPower);
  const picked = selectable.filter((g) => chosen.has(keyOf(g)));
  const allPicked = selectable.length > 0 && picked.length === selectable.length;
  const withSelect = selectable.length > 0;
  const tags = Object.entries(d?.tags ?? {}).sort(([a], [b]) => a.localeCompare(b));
  // The console's guest stays open when filters or paging hide it from the list.
  const inPage = con ? (guests.find((g) => g.server === con.server && g.id === con.guestId) ?? null) : null;
  const pin = useGuestList({ server: con?.server ?? '', q: con?.guestId.split(':').slice(1).join(':') ?? '', limit: 20 }, !!con && !inPage && !!d);
  const conGuest = inPage ?? pin.data?.guests.find((g) => g.server === con?.server && g.id === con?.guestId) ?? null;
  const sortState = parseSort(sort);
  const sortHead = (key: string, label: string, className?: string) => {
    const active = sortState.key === key;
    return (
      <th scope="col" className={className} aria-sort={active ? (sortState.desc ? 'descending' : 'ascending') : undefined}>
        <button type="button" className="th-sort" onClick={() => setParam('sort', nextSort(sort, key) === 'cpu' ? null : nextSort(sort, key))}>
          {label}
          {active && <span aria-hidden="true">{sortState.desc ? ' ↓' : ' ↑'}</span>}
        </button>
      </th>
    );
  };

  const open = (g: FleetGuest) => setParam('console', `${g.server}/${g.id}`, { drop: ['protocol'] });
  const close = () => setParam('console', null, { drop: ['protocol'] });
  const hostsText = plural(new Set(guests.map((g) => g.server)).size, 'host');

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t('Guests')}</h1>
          <p className="page-sub">{d ? t('{running} running of {total} · every VM and container the agents can see', { running: d.counts.running + d.counts.unhealthy, total: d.counts.all }) : ' '}</p>
        </div>
        <div className="page-controls">
          {isAdmin && (
            <button type="button" className="btn-ghost" onClick={() => openEnroll()}>
              <Icon name="plus" size={15} />
              {t('Add server')}
            </button>
          )}
        </div>
      </header>

      <div className="gp-filters" role="search" aria-label={t('Guest filters')}>
        <div className="input-search">
          <Icon name="search" size={15} />
          <input type="search" aria-label={t('Filter guests by name, image or VMID')} placeholder={t('Filter by name, image or VMID…')} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <SegmentedControl
          label={t('State')}
          value={state}
          onChange={(v) => setParam('state', v || null)}
          options={STATES.map((s) => ({ value: s.value, label: s.label, count: d ? d.counts[s.count] : undefined }))}
        />
        <div className="gp-chips" role="group" aria-label={t('Platform')}>
          {PLATFORMS.filter((p) => !d || (d.platforms[p.key] ?? 0) > 0 || platform === p.key).map((p) => (
            <button key={p.key} type="button" className="gp-chip" aria-pressed={platform === p.key} onClick={() => setParam('platform', platform === p.key ? null : p.key)}>
              {p.label}
              {d && <span className="c">{d.platforms[p.key] ?? 0}</span>}
            </button>
          ))}
        </div>
        {(tags.length > 0 || tag) && (
          <label className="gp-select">
            <span className="lbl">{t('Tag')}</span>
            <select aria-label={t('Tag')} value={tags.find(([name]) => name.toLowerCase() === tag.toLowerCase())?.[0] ?? tag} onChange={(e) => setParam('tag', e.target.value || null)}>
              <option value="">{t('all')}</option>
              {tags.map(([name, n]) => (
                <option key={name} value={name}>
                  {name} ({n})
                </option>
              ))}
              {tag && !tags.some(([name]) => name.toLowerCase() === tag.toLowerCase()) && <option value={tag}>{tag}</option>}
            </select>
          </label>
        )}
        <label className="gp-select">
          <span className="lbl">{t('Host')}</span>
          <select aria-label={t('Host')} value={server} onChange={(e) => setParam('server', e.target.value || null)}>
            <option value="">{t('all')}</option>
            {(servers.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={con ? 'guests-split has-console' : 'guests-split'}>
        <section className="card guests-card" aria-label={t('Guests')}>
          {list.isError && !d ? (
            <div className="card-body">
              <InlineRetry title={t('Could not load the guests')} error={list.error} onRetry={() => void list.refetch()} />
            </div>
          ) : !d ? (
            <div className="card-body form-stack" aria-busy="true" aria-label={t('Loading guests')}>
              <Skeleton height={40} />
              <Skeleton height={40} />
              <Skeleton height={40} />
            </div>
          ) : guests.length === 0 ? (
            <div className="guests-empty">{q || state || platform || server || tag ? t('No guests match these filters.') : t('No guests reported yet.')}</div>
          ) : (
            <>
              <BulkBar
                withServer
                items={picked.map((g) => ({ server: g.server, guest: g, power: true }))}
                onClear={() => setChosen(new Set())}
              />
              <div className="gt-scroll">
                <table className={withSelect ? 'gt has-select' : 'gt'}>
                  <thead>
                    <tr>
                      {withSelect && (
                        <th className="sel" scope="col">
                          <input
                            type="checkbox"
                            className="lc-check"
                            aria-label={t('Select all guests on this page')}
                            checked={allPicked}
                            ref={(el) => {
                              if (el) el.indeterminate = picked.length > 0 && !allPicked;
                            }}
                            onChange={(e) => setChosen(e.target.checked ? new Set(selectable.map(keyOf)) : new Set())}
                          />
                        </th>
                      )}
                      <th className="first" scope="col">
                        <span className="sr-only">{t('State')}</span>
                      </th>
                      {sortHead('name', t('Guest'))}
                      {sortHead('server', t('Host'))}
                      {sortHead('cpu', t('CPU'))}
                      {sortHead('memory', t('Memory'))}
                      <th scope="col">{t('Uptime')}</th>
                      <th className="last" scope="col">
                        <span className="sr-only">{t('Console')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {guests.map((g) => {
                      const stopped = g.state === 'stopped';
                      const hasConsole = g.console.available !== false && (g.console.protocols?.length ?? 0) > 0;
                      const logsOnly = stopped && g.kind === 'container' && !!g.console.protocols?.includes('logs');
                      const conText = g.kind === 'vm' ? t('Console') : logsOnly ? t('Logs') : t('Shell');
                      const conAria =
                        g.kind === 'vm'
                          ? t('Open console for {name} on {server}', { name: g.name, server: g.server })
                          : logsOnly
                            ? t('Open logs for {name} on {server}', { name: g.name, server: g.server })
                            : t('Open shell for {name} on {server}', { name: g.name, server: g.server });
                      const selected = con?.server === g.server && con?.guestId === g.id;
                      const offline = !g.server_online || offlineHosts.has(g.server);
                      return (
                        <tr key={`${g.server}/${g.id}`} className={`${stopped ? 'is-stopped' : ''}${selected ? ' is-selected' : ''}`} aria-selected={con ? selected : undefined}>
                          {withSelect && (
                            <td className="sel">
                              {canPower(g) && (
                                <input
                                  type="checkbox"
                                  className="lc-check"
                                  aria-label={t('Select {name} on {server}', { name: g.name, server: g.server })}
                                  checked={picked.includes(g)}
                                  onChange={(e) =>
                                    setChosen((s) => {
                                      const n = new Set(s);
                                      if (e.target.checked) n.add(keyOf(g));
                                      else n.delete(keyOf(g));
                                      return n;
                                    })
                                  }
                                />
                              )}
                            </td>
                          )}
                          <td className="first">
                            <Dot color={guestStateInfo(g.state).color} />
                            <span className="sr-only">{guestStateInfo(g.state).label}</span>
                          </td>
                          <td>
                            <div className="n">
                              <Link to={guestPath(g.server, g.id)} className="guest-link">
                                {g.name}
                              </Link>
                              <TagChips tags={g.tags} />
                              <small>
                                {kindText(g)}
                                {g.image ? ` · ${g.image}` : ''}
                              </small>
                            </div>
                          </td>
                          <td className={offline ? 'host is-offline' : 'host'} title={offline ? t('Host offline: last report') : undefined}>
                            <Link to={hostPath(g.server)} className="link">
                              {g.server}
                            </Link>
                          </td>
                          <td>
                            <span className="cpu-cell">
                              <Meter pct={Math.min(100, g.cpu_pct ?? 0)} color="var(--series-cpu)" style={{ opacity: g.cpu_pct == null ? 0.4 : 1 }} />
                              <span className="val">{formatPct1(g.cpu_pct)}</span>
                            </span>
                          </td>
                          <td className="mem">{formatMemPair(g.memory_used_mb, g.memory_limit_mb)}</td>
                          <td className="ink-2">{stopped ? (g.last_exit && /^\d{4}-/.test(g.last_exit) ? t('Exited {time}', { time: formatAgoIso(g.last_exit, now) }) : DASH) : formatUptimeShort(g.uptime_s)}</td>
                          <td className="last">
                            <span className="row-tools">
                              {hasConsole ? (
                                <button
                                  type="button"
                                  className={`btn-ghost row-action${stopped && !logsOnly ? ' is-dim' : ''}`}
                                  aria-label={conAria}
                                  onClick={() => open(g)}
                                >
                                  <Icon name={g.kind === 'vm' ? 'monitor' : 'terminal'} size={14} />
                                  <span className="btn-label">{conText}</span>
                                </button>
                              ) : (
                                <span className="lbl">{DASH}</span>
                              )}
                              <GuestMenu serverId={g.server} guest={g} rc={offline ? undefined : perms.get(g.server)} withServer />
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="lbl guests-foot" aria-live="polite">
                {tn(d.total, '{from}–{to} of {n} guest on {hosts}, by {sort}', '{from}–{to} of {n} guests on {hosts}, by {sort}', {
                  from: cursors.length * PAGE + 1,
                  to: cursors.length * PAGE + guests.length,
                  hosts: hostsText,
                  sort: SORT_LABEL[sortState.key]?.toLowerCase() ?? sortState.key,
                })}{' '}
                · {t("CPU is percent of the guest's vCPUs (Docker: one core = 100%)")}
                {cursors.length > 0 && (
                  <>
                    {' · '}
                    <button type="button" className="btn-text" onClick={() => setCursors((c) => c.slice(0, -1))}>
                      {t('‹ previous')}
                    </button>
                  </>
                )}
                {d.next_cursor && (
                  <>
                    {' · '}
                    <button type="button" className="btn-text" onClick={() => setCursors((c) => [...c, d.next_cursor!])}>
                      {t('next ›')}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </section>
        {con &&
          (conGuest ? (
            <ConsoleSide guest={conGuest} protocol={params.get('protocol')} onProtocol={(p) => setParam('protocol', p)} onClose={close} />
          ) : (
            <div className="card con is-compact">
              <div className="con-head">
                <button type="button" className="btn-ghost" onClick={close}>
                  <Icon name="close" size={15} />
                  {t('Close')}
                </button>
                <span className="ink-2">{d ? t('{guest} on {server} is not in this list.', { guest: con.guestId, server: con.server }) : t('Loading…')}</span>
              </div>
            </div>
          ))}
      </div>
    </>
  );
}
