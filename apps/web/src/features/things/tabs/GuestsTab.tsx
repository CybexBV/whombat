/**
 * A server's guests (Whombat connections-page.md CN-08; app connections-page.md AP-2540…; mock `#guests-web`; ported
 * from Rackoon's `features/server/Guests.tsx`): every VM and container, the name first and never cut — its state as a
 * dot, its kind as an icon, “VM 5911” or a change waiting for a restart under it — then CPU and memory as small bars
 * with their numbers and the uptime short. Running guests first by name, stopped ones dimmed and last; a column head
 * sorts by it. A search and a filter (`?q=`, `?state=`; tags still match the search), the console (Start for a stopped
 * guest) and a ⋯ menu per row (power, Snapshots…, History…, Open), tick boxes on hover with the bulk bar with
 * power on, Create with Manage on (VM and container on Proxmox, instance on Incus), and Proxmox's templates
 * under the table. A row's name opens the guest.
 */

import { BrandMark } from '@whombat/brand/react';
import {
  actionAcceptedText,
  type BulkGuest,
  detailGuests,
  filterGuests,
  GUEST_STATE_WORDS,
  type GuestFilter,
  guestKind,
  guestStateTone,
  guestsWord,
  isSelfGuest,
  powerActions,
  SELF_GUEST_CHIP,
  selfAllowsAction,
  serverDashboardKind,
  shownGuests,
  splitTemporary,
} from '@whombat/client/hosts';
import { useHostsChange } from '@whombat/client/hosts/react';
import { api } from '@whombat/core/contracts';
import type { HostGuest } from '@whombat/core/domain';
import { Box, House, Monitor, Power, Search, SquareTerminal } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { SegmentedControl } from '../../../components/SegmentedControl';
import wi from '../incus/Incus.module.css';
import { BulkBar } from '../manage/BulkBar';
import type { CreateKind } from '../manage/CreateGuestDialog';
import { CreateMenu } from '../manage/CreateMenu';
import { GuestRowMenu } from '../manage/GuestRowMenu';
import { TemplatesList } from '../manage/TemplatesList';
import { Card, Dot, Empty, useChangeRunner } from '../parts';
import { useThingSearch } from '../search';
import { TemporaryRow } from '../TemporaryRow';
import styles from '../Things.module.css';
import gs from './GuestsTab.module.css';
import {
  GUEST_SORT_DEFAULT,
  GUEST_SORT_WORDS,
  type GuestSort,
  type GuestSortKey,
  guestCpu,
  guestMemory,
  guestSubline,
  guestUp,
  nextGuestSort,
  sortGuests,
} from './guestList';
import type { TabProps } from './tabProps';

const FILTERS: { value: GuestFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'stopped', label: 'Stopped' },
];

/** What a server kind adds to the table (Unraid: an Autostart column, Update and the web page, Check for updates). */
export interface GuestsTabExtras {
  /** A column after Up. */
  column?: { label: string; cell: (g: HostGuest) => ReactNode };
  /** More in a row's tools, before the console. */
  tools?: (g: HostGuest) => ReactNode;
  /** More in the card's head, before Create. */
  head?: ReactNode;
}

/** Whether a row has a console to open. */
export function hasConsole(g: Pick<HostGuest, 'console'>): boolean {
  return g.console.available && (g.console.protocols?.length ?? 0) > 0;
}

export function GuestsTab({
  burrow,
  serverId,
  detail,
  extras,
}: Omit<TabProps, 'timeZone'> & { extras?: GuestsTabExtras }) {
  const [search, set] = useThingSearch();
  // Temporary machines (CI jobs, sandboxes) stay out until asked for; the counts never include them.
  const [showTemporary, setShowTemporary] = useState(false);
  const every = detailGuests(detail);
  const kept = splitTemporary(every).kept;
  const { shown: all, hidden } = shownGuests(every, showTemporary);
  const temporary = every.length - kept.length;
  const word = guestsWord(serverDashboardKind(detail));
  const state = (FILTERS.some((f) => f.value === search.state) ? search.state : 'all') as GuestFilter;
  const [sort, setSort] = useState<GuestSort>(GUEST_SORT_DEFAULT);
  const list = sortGuests(filterGuests(all, state, search.q ?? ''), sort);
  const rc = detail.server.remoteControl;
  const proxmox = detail.server.platform === 'proxmox';
  const manage = rc.manage === true;
  const powerOk = rc.power !== false;
  const consoleOk = rc.console !== false;
  const kinds: CreateKind[] = manage
    ? [
        ...(proxmox ? (['vm', 'container'] as const) : []),
        ...(detail.workloads?.incus ? (['incus'] as const) : []),
      ]
    : [];

  // Bulk selection: guest ids, kept while the rows are listed.
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new server starts with nothing selected
  useEffect(() => setPicked(new Set()), [serverId]);
  // The guest this Whombat runs in isn't powered from here (IU-02): it has no tick box.
  const pickable = list.filter((g) => !isSelfGuest(g));
  const chosen = pickable.filter((g) => picked.has(g.id));
  const allChosen = pickable.length > 0 && chosen.length === pickable.length;
  const items: BulkGuest[] = chosen.map((g) => ({ server: serverId, guest: g, power: true }));
  const toggle = (id: string, on: boolean) =>
    setPicked((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const head = (key: GuestSortKey, label: string, className?: string) => {
    const on = sort.key === key;
    return (
      <th
        scope="col"
        className={className}
        aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <button type="button" className={gs.sortBtn} onClick={() => setSort((s) => nextGuestSort(s, key))}>
          {label}
          {on ? (
            <span className={gs.arrow} aria-hidden="true">
              {sort.dir === 'asc' ? '↑' : '↓'}
            </span>
          ) : null}
        </button>
      </th>
    );
  };

  return (
    <Card
      title={word}
      meta={`${kept.filter((g) => g.state !== 'stopped').length} of ${kept.length} running`}
      link={
        kinds.length || extras?.head ? (
          <span style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            {extras?.head}
            {kinds.length ? <CreateMenu burrow={burrow} serverId={serverId} kinds={kinds} /> : null}
          </span>
        ) : undefined
      }
    >
      <div className={gs.toolbar}>
        <div className={gs.searchBox}>
          <Icon icon={Search} size={15} />
          <input
            className={gs.search}
            type="search"
            placeholder="Find by name…"
            aria-label={`Find ${word.toLowerCase()} by name`}
            value={search.q ?? ''}
            onChange={(e) => set({ q: e.target.value }, { replace: true })}
          />
        </div>
        <SegmentedControl
          options={FILTERS}
          value={state}
          onChange={(v) => set({ state: v === 'all' ? undefined : v }, { replace: true })}
          label="Show"
          variant="soft"
          className={styles.segWrap}
        />
        <span className={gs.sorted}>
          Sorted by <b>{GUEST_SORT_WORDS[sort.key]}</b> · click a column to sort
        </span>
      </div>
      {powerOk ? <BulkBar burrow={burrow} items={items} onClear={() => setPicked(new Set())} /> : null}
      {list.length === 0 ? (
        <Empty>{all.length ? 'Nothing matches that.' : 'Nothing runs on this server.'}</Empty>
      ) : (
        <table className={cx(styles.table, gs.table, chosen.length > 0 && gs.picking)}>
          <thead>
            <tr>
              {powerOk ? (
                <th scope="col" className={cx(gs.sel, styles.dropXs)}>
                  <input
                    type="checkbox"
                    aria-label="Select everything listed"
                    checked={allChosen}
                    ref={(el) => {
                      if (el) el.indeterminate = chosen.length > 0 && !allChosen;
                    }}
                    onChange={(e) =>
                      setPicked(e.target.checked ? new Set(pickable.map((g) => g.id)) : new Set())
                    }
                  />
                </th>
              ) : null}
              {head('name', 'Name', cx(gs.guestCell, powerOk && gs.afterSel))}
              {head('cpu', 'CPU', gs.figCell)}
              {head('memory', 'Memory', gs.memCell)}
              {head('up', 'Up', gs.upCell)}
              {extras?.column ? (
                <th scope="col" className={styles.dropM}>
                  {extras.column.label}
                </th>
              ) : null}
              <th scope="col" className={gs.toolsCell}>
                <span className={styles.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((g) => (
              <GuestRow
                key={g.id}
                burrow={burrow}
                serverId={serverId}
                guest={g}
                powerOk={powerOk}
                consoleOk={consoleOk}
                selected={picked.has(g.id)}
                onSelect={(on) => toggle(g.id, on)}
                extras={extras}
              />
            ))}
          </tbody>
        </table>
      )}
      <TemporaryRow
        count={showTemporary ? temporary : hidden}
        shown={showTemporary}
        onToggle={() => setShowTemporary((v) => !v)}
      />
      {proxmox && manage ? <TemplatesList burrow={burrow} serverId={serverId} canChange /> : null}
    </Card>
  );
}

/** The kind as the mock draws it — a screen for a VM, a box for a container, Docker's mark — named by its words. */
function KindIcon({ guest }: { guest: HostGuest }) {
  const kind = guestKind(guest);
  return (
    <span className={gs.kind} role="img" aria-label={kind.label} title={kind.label} data-kind={kind.glyph}>
      {kind.glyph === 'docker' ? (
        <BrandMark mark="docker" size={15} />
      ) : (
        <Icon icon={kind.glyph === 'vm' ? Monitor : Box} size={15} />
      )}
    </span>
  );
}

function GuestRow({
  burrow,
  serverId,
  guest: g,
  powerOk,
  consoleOk,
  selected,
  onSelect,
  extras,
}: {
  burrow: string;
  serverId: string;
  guest: HostGuest;
  powerOk: boolean;
  consoleOk: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  extras?: GuestsTabExtras;
}) {
  const [, set] = useThingSearch();
  const con = consoleOk && hasConsole(g);
  const stopped = g.state === 'stopped';
  // A stopped guest's quick button is Start, where its power may be used (the ⋯ menu has the same).
  const start =
    powerOk && stopped && selfAllowsAction(g, 'start')
      ? powerActions(g).find((a) => a.action === 'start')
      : undefined;
  const sub = guestSubline(g);
  const cpu = guestCpu(g);
  const mem = guestMemory(g);
  return (
    <tr className={cx(gs.row, stopped && gs.stopped)}>
      {powerOk ? (
        <td className={cx(gs.sel, styles.dropXs)}>
          {isSelfGuest(g) ? null : (
            <input
              type="checkbox"
              aria-label={`Select ${g.name}`}
              checked={selected}
              onChange={(e) => onSelect(e.target.checked)}
            />
          )}
        </td>
      ) : null}
      <td className={cx(gs.guestCell, powerOk && gs.afterSel)}>
        <div className={gs.guest}>
          <Dot tone={guestStateTone(g.state)} label={GUEST_STATE_WORDS[g.state]} />
          <KindIcon guest={g} />
          <div className={gs.who}>
            <div className={gs.nameLine}>
              <button type="button" className={gs.name} onClick={() => set({ guest: g.id })}>
                {g.name}
              </button>
              {isSelfGuest(g) ? (
                <span className={cx(wi.wiSelf, gs.self)} title="Your Whombat runs here">
                  <Icon icon={House} size={12} />
                  {SELF_GUEST_CHIP}
                </span>
              ) : null}
            </div>
            <div className={sub.note ? gs.note : gs.sub}>{sub.text}</div>
          </div>
        </div>
      </td>
      <td className={gs.figCell}>
        {cpu ? (
          <div className={gs.meter}>
            <span className={gs.bar} aria-hidden="true">
              <i className={gs.cpuFill} style={{ width: `${Math.max(3, cpu.share * 100)}%` }} />
            </span>
            <span className={gs.num}>{cpu.text}</span>
          </div>
        ) : (
          <span className={gs.dash}>—</span>
        )}
      </td>
      <td className={gs.memCell}>
        {mem ? (
          <div className={gs.meter}>
            {mem.share !== null ? (
              <span className={gs.bar} aria-hidden="true">
                <i
                  className={mem.warn ? gs.warnFill : gs.memFill}
                  style={{ width: `${Math.max(3, Math.min(100, mem.share * 100))}%` }}
                />
              </span>
            ) : null}
            <span className={gs.num}>
              {mem.value} <small>{mem.rest}</small>
            </span>
          </div>
        ) : (
          <span className={gs.dash}>—</span>
        )}
      </td>
      <td className={gs.upCell}>
        <span className={stopped ? gs.dash : gs.num}>{guestUp(g)}</span>
      </td>
      {extras?.column ? <td className={styles.dropM}>{extras.column.cell(g)}</td> : null}
      <td className={gs.toolsCell}>
        <span className={gs.tools}>
          {extras?.tools?.(g)}
          {start ? (
            <StartButton burrow={burrow} serverId={serverId} guest={g} />
          ) : con ? (
            <button
              type="button"
              className={cx(gs.ib, styles.dropXxs)}
              aria-label={`Open the console of ${g.name}`}
              title="Console"
              onClick={() => set({ console: g.id })}
            >
              <Icon icon={SquareTerminal} size={15} />
            </button>
          ) : null}
          <GuestRowMenu
            burrow={burrow}
            serverId={serverId}
            guest={g}
            power={powerOk}
            console={con}
            onGo={(place) => set(place)}
          />
        </span>
      </td>
    </tr>
  );
}

/** Start a stopped guest (not asked first, as the ⋯ menu's Start); the toast says it's starting. */
function StartButton({ burrow, serverId, guest: g }: { burrow: string; serverId: string; guest: HostGuest }) {
  const change = useHostsChange(api.hosts.guestAction);
  const { run, busy } = useChangeRunner();
  return (
    <button
      type="button"
      className={gs.ib}
      aria-label={`Start ${g.name}`}
      title="Start"
      disabled={busy}
      onClick={() =>
        void run(
          () =>
            change.mutateAsync({ params: { burrow, serverId, guestId: g.id }, body: { action: 'start' } }),
          (data) => actionAcceptedText('start', g.name, data.noop),
        )
      }
    >
      <Icon icon={Power} size={15} />
    </button>
  );
}
