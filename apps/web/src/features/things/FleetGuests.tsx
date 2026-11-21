/**
 * Every guest of every server in one list (ported from Rackoon's `features/guests/GuestsPage.tsx`; Whombat proxmox.md
 * PX-01): a search, the state, server and tag filters (the tag facet), sortable columns, pages of 100, the console and
 * a ⋯ menu per row, and row checkboxes with the bulk bar on servers with power on. The Servers page's
 * “Guests” view (`/things/servers?view=guests`); its filters are in the address (`q`, `state`, `server`, `tag`,
 * `sort`), and a row opens its guest on its server's page.
 */
import { useRouterState } from '@tanstack/react-router';
import {
  type BulkGuest,
  fleetFootText,
  fleetGuestQuery,
  GUEST_STATE_WORDS,
  type GuestSortKey,
  guestRow,
  isSelfGuest,
  nextGuestSort,
  parseGuestSort,
  serverHref,
  shownGuests,
  tagFacet,
} from '@whombat/client/hosts';
import { useHostGuests } from '@whombat/client/hosts/react';
import type { HostGuest, HostServer } from '@whombat/core/domain';
import { SquareTerminal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigateHref, useSearchUpdate } from '../../app/routing/navigation';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { SegmentedControl } from '../../components/SegmentedControl';
import { GuestName } from './GuestName';
import wc from './HostFleet.module.css';
import { BulkBar } from './manage/BulkBar';
import { type GuestPlace, GuestRowMenu } from './manage/GuestRowMenu';
import { AppLink, Card, Empty, ErrorLine, Skeleton, StateCell, Tags } from './parts';
import { TemporaryRow } from './TemporaryRow';
import styles from './Things.module.css';
import { hasConsole } from './tabs/GuestsTab';

const STATES = [
  { value: '', label: 'All', count: 'all' },
  { value: 'running', label: 'Running', count: 'running' },
  { value: 'stopped', label: 'Stopped', count: 'stopped' },
  { value: 'unhealthy', label: 'Unhealthy', count: 'unhealthy' },
] as const;

const KEYS = ['q', 'state', 'server', 'tag', 'sort'] as const;
type Filters = Partial<Record<(typeof KEYS)[number], string>>;

/** The list's filters from the address, and a way to change them (in place, without a new history entry). */
function useFleetFilters(): [Filters, (patch: Filters) => void] {
  const raw = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;
  const update = useSearchUpdate();
  const filters = useMemo(() => {
    const out: Filters = {};
    for (const k of KEYS) {
      const v = raw[k];
      if (typeof v === 'string' && v) out[k] = v.slice(0, 200);
    }
    return out;
  }, [raw]);
  const set = (patch: Filters) =>
    void update(
      (prev) => {
        const next: Record<string, unknown> = { ...prev };
        for (const [k, v] of Object.entries(patch)) {
          if (!v) delete next[k];
          else next[k] = v;
        }
        return next;
      },
      { replace: true },
    );
  return [filters, set];
}

export function FleetGuests({ burrow, servers }: { burrow: string; servers: readonly HostServer[] }) {
  const [f, set] = useFleetFilters();
  const navigate = useNavigateHref();
  // The search box follows typing; the address (and the request) a moment later.
  const [text, setText] = useState(f.q ?? '');
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the typed text drives the address
  useEffect(() => {
    const t = setTimeout(() => {
      if ((f.q ?? '') !== text.trim()) set({ q: text.trim() });
    }, 250);
    return () => clearTimeout(t);
  }, [text]);
  // Pages: a stack of cursors (Previous pops one); a new filter starts at the first.
  const [cursors, setCursors] = useState<string[]>([]);
  const key = KEYS.map((k) => f[k] ?? '').join('\u0000');
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when a filter changes
  useEffect(() => setCursors([]), [key]);
  const cursor = cursors[cursors.length - 1];
  const list = useHostGuests({ params: { burrow }, query: fleetGuestQuery(f, cursor) });
  const d = list.data;
  // Temporary machines (CI jobs, sandboxes) on this page stay out until asked for.
  const [showTemporary, setShowTemporary] = useState(false);
  const page = d?.guests ?? [];
  const { shown: guests, hidden } = shownGuests(page, showTemporary);
  const temporary = page.length - shownGuests(page, false).shown.length;
  const byId = useMemo(() => new Map(servers.map((s) => [s.id, s])), [servers]);
  const online = (g: HostGuest) => g.serverOnline !== false && byId.get(g.serverId)?.status !== 'offline';
  const canPower = (g: HostGuest) => byId.get(g.serverId)?.remoteControl.power === true && online(g);
  const canConsole = (g: HostGuest) =>
    byId.get(g.serverId)?.remoteControl.console !== false && online(g) && hasConsole(g);

  // Bulk selection: “server/guest” of this page's rows whose server allows power.
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page or filter starts with nothing selected
  useEffect(() => setPicked(new Set()), [key, cursor]);
  const keyOf = (g: HostGuest) => `${g.serverId}/${g.id}`;
  // The guest this Whombat runs in isn't powered from here (IU-02).
  const selectable = guests.filter((g) => canPower(g) && !isSelfGuest(g));
  const chosen = selectable.filter((g) => picked.has(keyOf(g)));
  const allChosen = selectable.length > 0 && chosen.length === selectable.length;
  const items: BulkGuest[] = chosen.map((g) => ({ server: g.serverId, guest: g, power: true }));
  const sort = parseGuestSort(f.sort);
  const tags = tagFacet(d?.tags);
  const tagValue = tags.find((t) => t.tag.toLowerCase() === (f.tag ?? '').toLowerCase())?.tag ?? f.tag ?? '';

  const go = (g: HostGuest, place: GuestPlace) => {
    const q = new URLSearchParams(Object.entries(place).filter(([, v]) => v) as [string, string][]);
    navigate(`${serverHref(g.serverId)}?${q.toString()}`);
  };
  const head = (k: GuestSortKey, label: string, className?: string) => {
    const active = sort.key === k;
    return (
      <th
        scope="col"
        className={className}
        aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : undefined}
      >
        <button
          type="button"
          className={wc.wcSort}
          aria-pressed={active}
          onClick={() => {
            const next = nextGuestSort(f.sort, k);
            set({ sort: next === 'cpu' ? undefined : next });
          }}
        >
          {label}
          {active ? <span aria-hidden="true">{sort.desc ? '↓' : '↑'}</span> : null}
        </button>
      </th>
    );
  };
  const filtered = !!(f.q || f.state || f.server || f.tag);

  return (
    <Card>
      <search className={wc.wcFilters} aria-label="Find machines and apps">
        <input
          className={styles.search}
          type="search"
          placeholder="Find by name or tag…"
          aria-label="Find by name or tag"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <SegmentedControl
          options={STATES.map((s) => ({
            value: s.value,
            label: d?.counts ? `${s.label} ${d.counts[s.count]}` : s.label,
          }))}
          value={(STATES.find((s) => s.value === f.state)?.value ?? '') as string}
          onChange={(v) => set({ state: v })}
          label="State"
          variant="soft"
          className={styles.segWrap}
        />
        <label className={wc.wcSelect}>
          Server
          <select value={f.server ?? ''} onChange={(e) => set({ server: e.target.value })}>
            <option value="">All</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {tags.length || f.tag ? (
          <label className={wc.wcSelect}>
            Tag
            <select value={tagValue} onChange={(e) => set({ tag: e.target.value })}>
              <option value="">All</option>
              {tags.map((t) => (
                <option key={t.tag} value={t.tag}>
                  {t.tag} ({t.count})
                </option>
              ))}
              {f.tag && !tags.some((t) => t.tag === tagValue) ? <option value={f.tag}>{f.tag}</option> : null}
            </select>
          </label>
        ) : null}
      </search>
      {selectable.length ? (
        <BulkBar burrow={burrow} items={items} withServer onClear={() => setPicked(new Set())} />
      ) : null}
      {list.error && !d ? (
        <ErrorLine error={list.error} onRetry={() => void list.refetch()} />
      ) : !d ? (
        <div style={{ padding: '0 20px 20px' }}>
          <Skeleton height={200} />
        </div>
      ) : !guests.length ? (
        <Empty>{filtered || page.length ? 'Nothing matches these filters.' : 'Nothing reported yet.'}</Empty>
      ) : (
        <>
          <table className={styles.table}>
            <thead>
              <tr>
                {selectable.length ? (
                  <th scope="col" className={cx(wc.wcSel, styles.dropXs)}>
                    <input
                      type="checkbox"
                      aria-label="Select everything on this page"
                      checked={allChosen}
                      ref={(el) => {
                        if (el) el.indeterminate = chosen.length > 0 && !allChosen;
                      }}
                      onChange={(e) =>
                        setPicked(e.target.checked ? new Set(selectable.map(keyOf)) : new Set())
                      }
                    />
                  </th>
                ) : null}
                {head('name', 'Name', styles.cellMain)}
                {head('server', 'Server', styles.dropS)}
                {head('state', 'State')}
                {head('cpu', 'CPU')}
                {head('memory', 'Memory', styles.dropM)}
                <th scope="col" className={styles.dropXl}>
                  Up
                </th>
                <th scope="col">
                  <span className={styles.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {guests.map((g) => {
                const r = guestRow(g);
                const con = canConsole(g);
                const off = !online(g);
                return (
                  <tr key={keyOf(g)} className={cx(g.state === 'stopped' && wc.wcStopped)}>
                    {selectable.length ? (
                      <td className={cx(wc.wcSel, styles.dropXs)}>
                        {canPower(g) && !isSelfGuest(g) ? (
                          <input
                            type="checkbox"
                            aria-label={`Select ${g.name} on ${g.serverId}`}
                            checked={picked.has(keyOf(g))}
                            onChange={(e) =>
                              setPicked((s) => {
                                const n = new Set(s);
                                if (e.target.checked) n.add(keyOf(g));
                                else n.delete(keyOf(g));
                                return n;
                              })
                            }
                          />
                        ) : null}
                      </td>
                    ) : null}
                    <td className={styles.cellMain}>
                      <GuestName
                        guest={g}
                        href={`${serverHref(g.serverId)}?guest=${encodeURIComponent(g.id)}`}
                        after={
                          g.tags?.length ? (
                            <span className={cx(styles.ellipsis, styles.dropL)}>
                              <Tags tags={g.tags.slice(0, 3)} />
                            </span>
                          ) : null
                        }
                      />
                      {/* The server column drops in a narrow card: its name goes under the guest's. */}
                      <span className={cx(styles.cellSub, styles.underIcon, styles.onlyS)}>
                        {byId.get(g.serverId)?.name ?? g.serverId}
                      </span>
                    </td>
                    <td className={styles.dropS}>
                      <AppLink
                        href={serverHref(g.serverId)}
                        className={cx(wc.wcHost, off && wc.wcOffline)}
                        title={off ? 'Offline: from its last report' : undefined}
                      >
                        {byId.get(g.serverId)?.name ?? g.serverId}
                      </AppLink>
                    </td>
                    <td>
                      <StateCell tone={r.stateTone} text={GUEST_STATE_WORDS[g.state]} compact />
                    </td>
                    <td className={styles.num}>{r.cpuText}</td>
                    <td className={cx(styles.num, styles.dropM)}>{r.memoryText}</td>
                    <td className={cx(styles.num, styles.dropXl)}>{r.uptimeText}</td>
                    <td className={wc.wcToolsCell}>
                      <span className={wc.wcTools}>
                        {con ? (
                          <button
                            type="button"
                            className={cx(styles.iconBtn, styles.dropXxs)}
                            aria-label={`Open the console of ${g.name} on ${g.serverId}`}
                            title="Console"
                            onClick={() => go(g, { console: g.id })}
                          >
                            <Icon icon={SquareTerminal} size={15} />
                          </button>
                        ) : null}
                        <GuestRowMenu
                          burrow={burrow}
                          serverId={g.serverId}
                          guest={g}
                          power={canPower(g)}
                          console={con}
                          withServer
                          onGo={(place) => go(g, place)}
                        />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <TemporaryRow
            count={showTemporary ? temporary : hidden}
            shown={showTemporary}
            onToggle={() => setShowTemporary((v) => !v)}
          />
          <div className={wc.wcFoot} aria-live="polite">
            <span>{fleetFootText(cursors.length, guests, d.total, f.sort)}</span>
            {cursors.length || d.nextCursor ? (
              <span className={wc.wcPager}>
                {cursors.length ? (
                  <button
                    type="button"
                    className={styles.cardLink}
                    onClick={() => setCursors((c) => c.slice(0, -1))}
                  >
                    ‹ Previous
                  </button>
                ) : null}
                {d.nextCursor ? (
                  <button
                    type="button"
                    className={styles.cardLink}
                    onClick={() => setCursors((c) => [...c, d.nextCursor as string])}
                  >
                    Next ›
                  </button>
                ) : null}
              </span>
            ) : null}
          </div>
        </>
      )}
    </Card>
  );
}
