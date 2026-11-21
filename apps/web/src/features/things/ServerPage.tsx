/**
 * A server's page (one Whombat mock 2, Whombat dashboards.md DS-01…DS-17; ported from Rackoon's
 * `features/server/ServerPage.tsx`; dashboards-web.md AP-2050…, mocks server.png, unraid.png; connections-page.md
 * AP-2510): the head every page shares — the crumb back to Connections, the server icon, the name in the mono face
 * with its status badge and chips, Ask, Shell and Power, the fact line with its address and when the agent last synced
 * — then the tabs of its kind (every server's, Unraid's, QEMU/KVM's or Incus's) with “Live · every 10 s” at the row's
 * end on the Summary, and the range picker (`?range=`) beside the charts a figure opens (`?chart=`), in the tab row
 * only while a chart card is left. The Summary is every server's dashboard (`ServerSummary`); the other tabs are the
 * kind's own. A guest opens over the tabs (`?guest=`), a console over everything (`?console=`), the Ask pane beside it
 * once asked for (`?ask=1`), with a notice's question ready to send. Live through `hosts:<burrowId>` (AP-1304,
 * AP-1308).
 */
import { CHAT_WORDS, OVERVIEW_WORDS, partsOf, readingsMoment } from '@whombat/client';
import {
  arrayGroups,
  detailGuests,
  guestsWord,
  hostsThisWhombat,
  INCUS_SERVER_TAB_WORDS,
  INCUS_SERVER_TABS,
  isIncusServer,
  isLibvirtGuest,
  isLibvirtServer,
  isMacServer,
  isUnraidServer,
  LIBVIRT_SERVER_TAB_WORDS,
  LIBVIRT_SERVER_TABS,
  MAC_SERVER_TAB_WORDS,
  MAC_SERVER_TABS,
  macScreenView,
  parseDashboardRange,
  parseIncusServerTab,
  parseLibvirtServerTab,
  parseMacServerTab,
  parseServerTab,
  parseUnraidTab,
  SERVER_DASHBOARD_RANGES,
  SERVER_TAB_WORDS,
  SERVER_TABS,
  serverDashboardHead,
  serverDashboardKind,
  serverMark,
  serverPageVerdict,
  serverReportAt,
  splitTemporary,
  UNRAID_TAB_WORDS,
  UNRAID_TABS,
} from '@whombat/client/hosts';
import { useHostServer, useHostsLive, useServerDashboard } from '@whombat/client/hosts/react';
import { useHomeOverview, useRenameThing, useTheAgent } from '@whombat/client/react';
import { CONNECTIONS_HREF, HOST_SERVER_NAME_MAX, thingId } from '@whombat/core';
import type { HostServerDetail } from '@whombat/core/domain';
import { Server } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { InlineRename } from '../../components/InlineRename';
import { Tabs } from '../../components/Tabs';
import { ReadNote, ReadTime } from '../home/ReadState';
import { useBurrowContext, useNow } from '../messaging/useRoom';
import { AskButton, AskPane, isAskOpen } from './AskPane';
import { ConsoleDialog } from './console/ConsoleDialog';
import { rangeInTabRow } from './dashboard/figures';
import { HeadMenu } from './dashboard/HeadMenu';
import { Crumb, PageHead, TabRow, tabsInRow } from './dashboard/PageHead';
import { RangePicker } from './dashboard/RangePicker';
import { ServerSummary, type ServerTechnicalView } from './dashboard/ServerSummary';
import { GuestPage } from './guest/GuestPage';
import { IncusPanel } from './incus/IncusPanel';
import { LibvirtGuestPage } from './libvirt/LibvirtGuestPage';
import { LibvirtPanel } from './libvirt/LibvirtPanel';
import { MacPanel } from './macos/MacPanel';
import { type ServerPowerAction, ServerPowerDialog } from './manage/ServerPowerDialog';
import { AppLink, Skeleton } from './parts';
import { useThingLinkProps } from './prefetch';
import { useServerQuiet } from './quiet/useQuiet';
import { useThingSearch } from './search';
import styles from './Things.module.css';
import { BackupsTab } from './tabs/BackupsTab';
import { GuestsTab } from './tabs/GuestsTab';
import { SensorsTab } from './tabs/SensorsTab';
import { StorageTab } from './tabs/StorageTab';
import { SystemTab } from './tabs/SystemTab';
import { UnraidPanel } from './unraid/UnraidPanel';

export interface ServerPageProps {
  burrow: string;
  serverId: string;
}

type ServerKind = 'unraid' | 'libvirt' | 'incus' | 'mac' | 'plain';

/** A kind's tabs and their words, Summary first; what runs on it is its Machines or, on a Docker host, its Apps. */
function kindTabs(kind: ServerKind, d: HostServerDetail | undefined): { key: string; label: string }[] {
  if (kind === 'unraid') return UNRAID_TABS.map((key) => ({ key, label: UNRAID_TAB_WORDS[key] }));
  if (kind === 'libvirt')
    return LIBVIRT_SERVER_TABS.map((key) => ({ key, label: LIBVIRT_SERVER_TAB_WORDS[key] }));
  if (kind === 'incus') return INCUS_SERVER_TABS.map((key) => ({ key, label: INCUS_SERVER_TAB_WORDS[key] }));
  if (kind === 'mac') return MAC_SERVER_TABS.map((key) => ({ key, label: MAC_SERVER_TAB_WORDS[key] }));
  const guests = d ? guestsWord(serverDashboardKind(d)) : SERVER_TAB_WORDS.guests;
  return SERVER_TABS.map((key) => ({ key, label: key === 'guests' ? guests : SERVER_TAB_WORDS[key] }));
}

function parseTab(kind: ServerKind, v: string | undefined): string {
  if (kind === 'unraid') return parseUnraidTab(v);
  // A link to a server's updates (the phone's Updates screen, `?tab=updates`) opens System here (AP-2875).
  if (v === 'updates') return 'system';
  if (kind === 'libvirt') return parseLibvirtServerTab(v);
  if (kind === 'incus') return parseIncusServerTab(v);
  if (kind === 'mac') return parseMacServerTab(v);
  return parseServerTab(v);
}

/** The counts after a tab's words (“Guests 14”, “Storage 4”, Unraid's “Array 4”). */
function tabCount(key: string, d: HostServerDetail): number | null {
  // Temporary machines (CI jobs, sandboxes) aren't counted; the tab's list shows them on request.
  if (key === 'guests') return splitTemporary(detailGuests(d)).kept.length || null;
  if (key === 'storage') return d.health?.volumes?.length || null;
  if (key === 'array' && d.unraid) {
    const { parity, data } = arrayGroups(d.unraid.array);
    return parity.length + data.length || null;
  }
  return null;
}

export function ServerPage({ burrow, serverId }: ServerPageProps) {
  const { bootstrap, timeZone } = useBurrowContext(burrow);
  const { words } = useTheAgent(burrow);
  useHostsLive(bootstrap?.burrow.id);
  const [search, set] = useThingSearch();
  const detail = useHostServer({ params: { burrow, serverId }, query: { range: '24h' } });
  const d = detail.data;
  // An Unraid server has its own tabs (IU-03), so have QEMU/KVM (IU-13), Incus (IU-03) and a Mac (macos-servers.md).
  const kind: ServerKind = !d
    ? 'plain'
    : isMacServer(d)
      ? 'mac'
      : isUnraidServer(d)
        ? 'unraid'
        : isIncusServer(d)
          ? 'incus'
          : isLibvirtServer(d)
            ? 'libvirt'
            : 'plain';
  const tab = parseTab(kind, search.tab);
  const range = parseDashboardRange(search.range);
  const askOpen = isAskOpen(search);
  const [draft, setDraft] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // The Summary's panels, read here so the tab row knows whether the range picker is still needed there (AP-2510).
  const summary = !!d && tab === 'summary' && !search.guest;
  // You quiet its lines: the ⋯ menu, Undo (quiet-notices.md AP-4828).
  const sq = useServerQuiet(burrow, serverId);
  const dash = useServerDashboard({
    burrow,
    serverId: summary ? serverId : null,
    range,
    timeZone: zone,
    // Worth a look's waiting updates open System, where they install (SWU-13).
    updates: 'web',
    quiet: sq.mayQuiet,
    // A problem's button asks the assistant by name.
    assistant: words.name,
  });
  const pickerInRow = dash.panels ? rangeInTabRow(dash.panels) : false;
  const technical = useServerTechnical(burrow, serverId, d);

  // A new tab or guest starts at the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the place changes
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [search.tab, search.guest, serverId]);

  // The name a person gave it (“The Titan”), else its id.
  const name = d?.server.name ?? d?.server.id ?? serverId;
  const onAsk = (question?: string) => {
    setDraft(question ?? null);
    set({ ask: '1', chat: 'new' }, { replace: true });
  };
  let body: ReactNode;
  if (!d) {
    body = detail.error ? (
      <>
        <Crumb href={CONNECTIONS_HREF} label={CHAT_WORDS.dashboard} />
        <h1 className={styles.title}>{serverId}</h1>
        {/* The first read failed: nothing saved, so no figures that could look current. */}
        <ReadNote
          title={OVERVIEW_WORDS.couldntRead(`${serverId}’s readings`)}
          body={OVERVIEW_WORDS.noSaved}
          error={detail.error}
          busy={detail.isFetching}
          onRetry={() => void detail.refetch()}
        />
      </>
    ) : (
      <div
        role="status"
        aria-busy="true"
        aria-label={`Loading ${serverId}`}
        style={{ display: 'grid', gap: 18 }}
      >
        <Skeleton height={28} />
        <Skeleton height={64} />
        <Skeleton height={108} />
        <Skeleton height={200} />
      </div>
    );
  } else if (search.guest && isLibvirtGuest(search.guest)) {
    // A libvirt VM's page, whatever server it's on (IU-13).
    body = (
      <LibvirtGuestPage
        burrow={burrow}
        serverId={serverId}
        serverName={name}
        detail={d}
        guestId={search.guest}
        timeZone={timeZone}
      />
    );
  } else if (search.guest) {
    body = (
      <GuestPage
        burrow={burrow}
        serverId={serverId}
        serverName={name}
        detail={d}
        guestId={search.guest}
        timeZone={timeZone}
      />
    );
  } else {
    const props = { burrow, serverId, detail: d, timeZone };
    body = (
      <>
        <ServerHead
          burrow={burrow}
          serverId={serverId}
          detail={d}
          timeZone={zone}
          onShell={() => set({ console: 'host' })}
          onScreen={() => set({ console: 'screen' })}
        />
        {detail.error ? (
          // A refresh failed: the page keeps its readings, from its own report's time.
          <ReadNote
            className={styles.readNote}
            title={
              serverReportAt(d)
                ? OVERVIEW_WORDS.savedFrom(readingsMoment(serverReportAt(d) as string, zone))
                : OVERVIEW_WORDS.savedUnknown
            }
            body={OVERVIEW_WORDS.keepLast}
            error={detail.error}
            busy={detail.isFetching}
            onRetry={() => void detail.refetch()}
          />
        ) : null}
        <TabRow
          picker={
            tab === 'summary' ? (
              <RangePicker
                ranges={pickerInRow ? SERVER_DASHBOARD_RANGES : []}
                value={range}
                onChange={(next) => set({ range: next === '24h' ? undefined : next }, { replace: true })}
              />
            ) : null
          }
        >
          <Tabs<string>
            tabs={kindTabs(kind, d).map((t) => {
              const count = tabCount(t.key, d);
              return count !== null ? { ...t, meta: count } : t;
            })}
            value={tab}
            onChange={(next) => set({ tab: next === 'summary' ? undefined : next }, { replace: true })}
            label={`${name} sections`}
            idPrefix="server-tab"
            panelId="server-panel"
            className={tabsInRow}
          />
        </TabRow>
        <div
          id="server-panel"
          role="tabpanel"
          aria-labelledby={`server-tab-${tab}`}
          style={{ display: 'contents' }}
        >
          {tab === 'summary' ? (
            <ServerSummary
              burrow={burrow}
              serverId={serverId}
              name={name}
              range={range}
              timeZone={zone}
              onAsk={onAsk}
              dash={dash}
              quiet={sq.actions}
              technical={technical}
              status={d.server.status}
            />
          ) : kind === 'unraid' ? (
            <UnraidPanel
              tab={parseUnraidTab(tab) as Exclude<ReturnType<typeof parseUnraidTab>, 'summary'>}
              {...props}
            />
          ) : kind === 'libvirt' ? (
            <LibvirtPanel
              tab={parseLibvirtServerTab(tab) as Exclude<ReturnType<typeof parseLibvirtServerTab>, 'summary'>}
              {...props}
            />
          ) : kind === 'incus' ? (
            <IncusPanel
              tab={parseIncusServerTab(tab) as Exclude<ReturnType<typeof parseIncusServerTab>, 'summary'>}
              {...props}
            />
          ) : kind === 'mac' ? (
            <MacPanel
              tab={parseMacServerTab(tab) as Exclude<ReturnType<typeof parseMacServerTab>, 'summary'>}
              {...props}
            />
          ) : tab === 'guests' ? (
            <GuestsTab {...props} />
          ) : tab === 'storage' ? (
            <StorageTab burrow={burrow} detail={d} />
          ) : tab === 'sensors' ? (
            <SensorsTab {...props} />
          ) : tab === 'backups' ? (
            <BackupsTab {...props} />
          ) : (
            <SystemTab {...props} />
          )}
        </div>
      </>
    );
  }

  return (
    <div className={styles.screen} data-screen="server">
      <div className={styles.scroll} ref={scrollRef}>
        <main className={styles.page} aria-label={name}>
          {body}
        </main>
      </div>
      {askOpen ? (
        <AskPane
          burrow={burrow}
          subject={{ kind: 'server', id: serverId, name }}
          chatId={search.chat}
          draft={draft}
          onChat={(chat) => {
            // Sent: a later “New chat” starts empty.
            if (chat !== 'new') setDraft(null);
            set({ chat }, { replace: true });
          }}
          onClose={() => {
            setDraft(null);
            set({ ask: undefined, chat: undefined }, { replace: true });
          }}
        />
      ) : null}
      {search.console && d ? (
        <ConsoleDialog
          burrow={burrow}
          serverId={serverId}
          detail={d}
          target={search.console}
          onClose={() => set({ console: undefined }, { replace: true })}
        />
      ) : null}
    </div>
  );
}

/**
 * The head (DS-01): the crumb, icon, name and badge, Ask {assistant} first and the rest (a shell, Restart, Shut down)
 * behind ⋯, then the verdict. Its versions, processor, address and helper are the Summary's Technical details.
 */
function ServerHead({
  burrow,
  serverId,
  detail,
  timeZone,
  onShell,
  onScreen,
}: {
  burrow: string;
  serverId: string;
  detail: HostServerDetail;
  timeZone: string;
  onShell: () => void;
  /** A Mac's screen (macos-servers.md). */
  onScreen: () => void;
}) {
  const now = useNow(30_000);
  const head = serverDashboardHead(detail);
  const verdict = useMemo(() => serverPageVerdict(detail), [detail]);
  const rc = detail.server.remoteControl;
  // The host's shell (and a Mac's screen beside it) goes with the host-shell switch only, as the hosts service asks.
  const shellOk = rc.hostShell !== false && detail.server.status !== 'offline';
  const [renaming, setRenaming] = useState(false);
  const { rename } = useRenameThing(burrow);
  const target = { kind: 'server' as const, id: serverId, name: head.name, max: HOST_SERVER_NAME_MAX };
  // A Mac's screen sits beside its shell in ⋯ (its Screen tab has the rest).
  const screen = useMemo(
    () =>
      macScreenView(detail, { name: head.name, owner: true, now: Date.parse(detail.asOf) })?.screen ?? null,
    [detail, head.name],
  );
  return (
    <>
      <PageHead
        crumb={{ href: CONNECTIONS_HREF, label: CHAT_WORDS.dashboard }}
        icon={Server}
        mark={serverMark(detail.server)}
        iconTone="plain"
        name={head.name}
        // A host name is set in the mono face; a name a person gave it isn't, its id is under it.
        mono={!head.idLine}
        // Its condition and when its own report was read lead the fact line, as on its Overview card.
        statusFirst
        facts={
          <>
            <ReadTime at={serverReportAt(detail)} now={now} timeZone={timeZone} />
            {head.idLine ? <span className={styles.idLine}>{head.idLine}</span> : null}
          </>
        }
        renaming={
          renaming ? (
            <InlineRename
              value={head.name}
              maxLength={HOST_SERVER_NAME_MAX}
              label={`Rename ${head.name}`}
              hint="Leave it empty to use its id again."
              onSave={async (typed) => {
                const outcome = await rename(target, typed);
                return outcome.ok ? null : outcome.problem;
              }}
              onClose={() => setRenaming(false)}
            />
          ) : undefined
        }
        badge={{ tone: head.tone, text: head.badge }}
        verdict={verdict?.sentence ?? null}
        actions={
          <>
            <AskButton burrow={burrow} />
            <ServerMore
              burrow={burrow}
              serverId={serverId}
              name={head.name}
              onRename={() => setRenaming(true)}
              shell={
                shellOk
                  ? { onShell }
                  : { reason: rc.hostShellReason ?? 'The shell is switched off for this server.' }
              }
              screen={screen ? (screen.can ? { onScreen } : { reason: screen.why }) : null}
              allowed={rc.hostPower !== false}
              reason={rc.hostPowerReason}
              thisWhombat={hostsThisWhombat(detail.server)}
            />
          </>
        }
      />
    </>
  );
}

/**
 * The Summary's Technical details: the server's system, processor, memory, address, Whombat's helper and what Whombat
 * may do there, and the connections that are part of it, each a link to its page.
 */
function useServerTechnical(
  burrow: string,
  serverId: string,
  detail: HostServerDetail | undefined,
): ServerTechnicalView {
  const parts = useServerParts(burrow, serverId);
  // A part's page is read while the pointer rests on its name (page-speed.md AP-2660).
  const linkProps = useThingLinkProps(burrow);
  const rows = useMemo(() => (detail ? serverDashboardHead(detail).details : []), [detail]);
  return {
    rows,
    extra: parts.length ? (
      <p className={styles.alsoConnected}>
        Also connected:{' '}
        {parts.map((t, i) => (
          <span key={t.id}>
            {i ? ', ' : null}
            <AppLink href={t.href} {...linkProps(t.href)} className={styles.factLink}>
              {t.name}
            </AppLink>
          </span>
        ))}
      </p>
    ) : null,
  };
}

/**
 * The connections that are part of this server (a Proxmox or Unraid API to it; connection-pages.md CP-10): its
 * Technical details link to their pages, as the sidebar and Home leave them out.
 */
function useServerParts(burrow: string, serverId: string) {
  const { data } = useHomeOverview({ params: { burrow } }, { retry: false });
  return useMemo(() => partsOf(data?.things ?? [], thingId('server', serverId)), [data?.things, serverId]);
}

/**
 * ⋯ beside Ask: a shell on the server (for who knows one), Restart and Shut down, each asked first. What the server's
 * switches don't allow is there but greyed, with why.
 */
function ServerMore({
  burrow,
  serverId,
  name,
  onRename,
  shell,
  screen,
  allowed,
  reason,
  thisWhombat = false,
}: {
  burrow: string;
  serverId: string;
  name: string;
  /** Rename turns the title into a box. */
  onRename: () => void;
  shell: { onShell: () => void } | { reason: string };
  /** A Mac's screen; null on any other server. */
  screen: { onScreen: () => void } | { reason: string } | null;
  allowed: boolean;
  reason?: string | null;
  /** This Whombat runs on it: the question says it goes down too (IU-02). */
  thisWhombat?: boolean;
}) {
  const [ask, setAsk] = useState<ServerPowerAction | null>(null);
  const powerOff = allowed ? null : (reason ?? 'Restarting this server from Whombat is switched off.');
  return (
    <>
      <HeadMenu
        name={name}
        items={[
          { key: 'rename', label: 'Rename', onSelect: onRename },
          ...(screen
            ? [
                {
                  key: 'screen',
                  label: 'Open the screen',
                  onSelect: () => ('onScreen' in screen ? screen.onScreen() : undefined),
                  disabled: 'reason' in screen,
                  reason: 'reason' in screen ? screen.reason : null,
                },
              ]
            : []),
          {
            key: 'shell',
            label: 'Open a shell',
            onSelect: () => ('onShell' in shell ? shell.onShell() : undefined),
            disabled: 'reason' in shell,
            reason: 'reason' in shell ? shell.reason : null,
          },
          {
            key: 'restart',
            label: `Restart ${name}`,
            onSelect: () => setAsk('host_reboot'),
            disabled: !allowed,
            reason: powerOff,
          },
          {
            key: 'shutdown',
            label: `Shut ${name} down`,
            onSelect: () => setAsk('host_shutdown'),
            disabled: !allowed,
            reason: powerOff,
            serious: true,
          },
        ]}
      />
      <ServerPowerDialog
        burrow={burrow}
        serverId={serverId}
        name={name}
        action={ask}
        thisWhombat={thisWhombat}
        onClose={() => setAsk(null)}
      />
    </>
  );
}
