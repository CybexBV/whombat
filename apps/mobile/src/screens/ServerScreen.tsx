/**
 * A server's page on the phone (mock 2 at phone width; Whombat one-whombat.md ONE-11…ONE-13, incus-unraid.md IU-03,
 * IU-08, IU-09, dashboards.md DS-01…DS-17; one-whombat-mobile.md AP-1363…AP-1367; proxmox-mobile.md AP-1498…AP-1500;
 * incus-unraid-mobile.md AP-1632…AP-1639; dashboards-mobile.md AP-2127…AP-2131): its head (the name in the mono face,
 * one status badge, what it runs and what Whombat may do, the fact line, its address); **Summary** — “Live · every
 * 10 s”, then the panels `serverDashboard` builds from the hosts data, stacked by the same renderer as a connection's
 * page (`SummaryPanels`: figures with their small lines, each opening its charts with the range control 1 h…30 d inside
 * the figures' card, Whombat connections-page.md CN-05, connections-page.md AP-2558; the busiest guests, Worth a look,
 * storage with its forecast, the kind's own), each link opening the tab, the guest or the question it names — and
 * “Ask about pve-02”; **Guests**, each opening its own screen (“This Whombat” on the guest it runs in; its kind a mark
 * before the name, less-is-more.md AP-1810); a Proxmox, Incus or QEMU/KVM server's **Backups**; an Unraid server's
 * **Array** (with its unread notifications) and **Plugins**. Live on the `hosts` topic. You set **Asks you
 * first** at the end of the Summary (server-asks.md SA-08; server-asks-mobile.md AP-1740). ALSO CONNECTED lists the
 * connections that are part of it, its Proxmox API (connection-pages.md CP-10, AP-1965). Consoles and the other tabs
 * stay on the web. The tabs are underlined, not a segmented control (underline-tabs-android.md AP-2633). The Summary's
 * Updates card opens the server's Updates screen (server-updates-app.md AP-2881); the AGENT card says how its agent keeps
 * up to date, with its button (agent-updates-app.md AP-2991). Worth a look's lines have their ⋯ menu (Ignore, Remind me
 * tomorrow, Stop watching) and quiet lines greyed with Undo, and WHAT WHOMBAT WATCHES follows Asks you first
 * (quiet-notices-mobile.md AP-4867). The head's ⋯ has Rename, which turns the title into a box: a name a person gave it is
 * the title in the sans face with its id quietly under it in mono.
 */

import type { MarkLike } from '@whombat/brand';
import {
  holdView,
  type LimitView,
  lineLimit,
  OVERVIEW_WORDS,
  overviewWords,
  readingsMoment,
  readingTime,
  serverStatusLevel,
  thingGlyph,
  thingMark,
  thingRenameTarget,
} from '@whombat/client';
import {
  detailGuests,
  FIND_MY_WORDS,
  guestsWord,
  isIncusServer,
  isMacServer,
  isUnraidServer,
  MAC_PHONE_TABS,
  MAC_PHONE_TABS_WITH_FIND_MY,
  SERVER_DASHBOARD_DEFAULT_RANGE,
  SERVER_DASHBOARD_PHONE_RANGES,
  type ServerDashboardHead,
  serverDashboardKind,
  serverMark,
  serverReportAt,
  shortOs,
  statusText,
  type Verdict,
} from '@whombat/client/hosts';
import { isLibvirtServer, THIS_WHOMBAT, thisWhombatFact } from '@whombat/client/hosts/mobile';
import {
  useFindMyConnectionOf,
  useFindMyOnMac,
  useHostGuests,
  useHostsFleet,
  useHostsLive,
  useHostsStatus,
  useServerDashboard,
} from '@whombat/client/hosts/react';
import {
  useHomeOverview,
  useKeepQuiet,
  useLookResearch,
  useQuietActions,
  useSessionProtocol,
  useSetWatchLimit,
  useThingWatch,
} from '@whombat/client/react';
import { type ChatSubject, type HostGuest, type HostSeriesRange, thingId } from '@whombat/core';
import { KEEP_QUIET_MINOR, protocolAtLeast } from '@whombat/protocol/session';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, RefreshControl, ScrollView, View } from 'react-native';
import { useBurrowBase, useNow, useNowLabel } from '../data/BurrowProvider';
import { rangeOptions } from '../data/dashboard';
import { parseMonitoringPick, serverMoreMenu } from '../data/monitoring';
import { QUIET_COPY, quietNote, WATCH_FIRST } from '../data/quiet';
import { isOwnId, parseThingRowPick, RENAME_COPY } from '../data/rename';
import { serverAsksRow } from '../data/serverAsks';
import { type ServerTab, serverLinkTarget, serverPhoneTabs, serverTabFor } from '../data/serverSummary';
import { serverCopy, serverGuestList, type serverThingStatus, verdictDot } from '../data/servers';
import { type LinkRun, partsOf, shownPanels, thingPageCopy } from '../data/thingPage';
import { showToast } from '../data/toast';
import { useAgentWords } from '../data/useAgent';
import { useThingRename } from '../data/useThingRename';
import { useI18n, useMobileT } from '../i18n';
import { openHref, useAppNavigation } from '../navigation/hooks';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BigButton, Dot, OneCard, OneRow, ThingDot, ThingIcon, ToneBadge, toneOf } from '../ui/assistant';
import { GuestKindMark } from '../ui/guestKind';
import { BackBar, Screen } from '../ui/headers';
import { Clock, Ellipsis } from '../ui/icons';
import { InlineRename } from '../ui/inlineRename';
import { hasNativeMenu, MenuSheet, NativeMenu } from '../ui/nativeMenu';
import { Button, ErrorState, QuietText, SkeletonRows } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { LevelPill } from '../ui/statusMark';
import { Touchable } from '../ui/Touchable';
import { UnderlineTabs } from '../ui/UnderlineTabs';
import { FindMyPart } from './findmy/FindMyPart';
import { CardSkeletons, ReadNote } from './home/OverviewParts';
import { NewChatSheet } from './NewChatSheet';
import { ServerBackups } from './ServerBackups';
import { AgentUpdatesCard } from './server/AgentUpdates';
import { AsksFirstCard } from './server/AsksFirst';
import { IncusServerBackups } from './server/IncusServer';
import { LibvirtServerBackups } from './server/LibvirtServer';
import { MacScreenPart } from './server/MacScreen';
import { TechnicalDetailsCard } from './server/TechnicalDetails';
import { UnraidArray, UnraidPlugins } from './server/UnraidParts';
import { useUnraidOp } from './server/UnraidSheets';
import { UpdatesCard, useServerUpdatesView } from './server/Updates';
import { BackupsKeptHere } from './thing/KeptHere';
import { LookCard } from './thing/LookCard';
import { KeepQuietSheet, KeptQuietLine, LimitSheet, WhatHappenedCard } from './thing/Monitoring';
import { type PanelContext, SummaryPanels } from './thing/Panels';
import { useWidePage } from './thing/parts';
import { useHandOver } from './thing/useHandOver';
import { WhatWhombatWatches } from './thing/WhatWhombatWatches';
import { useAskAbout } from './useAskAbout';

const INSET = 18;

export function ServerScreen({
  serverId,
  name,
  back,
  onBack,
}: {
  serverId: string;
  name: string;
  back: string;
  onBack: () => void;
}) {
  const { rawLocale } = useI18n();
  const serverCopyHere = serverCopy(rawLocale);
  const thingPageCopyHere = thingPageCopy(rawLocale);

  const overviewWordsHere = overviewWords(rawLocale);

  const { t: tMobile } = useMobileT();
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const { slug, currentBootstrap, timeZone } = useBurrowBase();
  const now = useNow().getTime();
  const navigation = useAppNavigation();
  useHostsLive(currentBootstrap().burrow.id);
  const status = useHostsStatus({ params: { burrow: slug } }, { retry: false });
  const fleet = useHostsFleet({ params: { burrow: slug } }, { retry: false });
  // The Summary (DS-02): the server's page, its history for the range and its busiest guests', as panels.
  const [range, setRange] = useState<HostSeriesRange>(SERVER_DASHBOARD_DEFAULT_RANGE);
  // Worth a look's waiting updates open the Updates screen (Whombat server-updates.md SWU-13; AP-2882).
  // Quiet notices (Whombat quiet-notices.md QN-10, QN-15, QN-23; quiet-notices-mobile.md AP-4867): on a Whombat with
  // `things.quiet`, What Whombat watches says whether its lines may be quieted, and only then do they get their ⋯ menu
  // and Undo.
  const thing = `server:${serverId}`;
  const watch = useThingWatch({ params: { burrow: slug, thing } }, { retry: false });
  const quiet = useQuietActions(slug, thing, { timeZone, note: quietNote(showToast) });
  const agent = useAgentWords();
  // Keep quiet for a while and a check's limit: on a Whombat at session minor 9.
  const keepsQuiet = protocolAtLeast(useSessionProtocol(), KEEP_QUIET_MINOR);
  const [keeping, setKeeping] = useState(false);
  const [limitFor, setLimitFor] = useState<LimitView | null>(null);
  const limits = useSetWatchLimit(slug, thing, { note: quietNote(showToast), assistantName: agent.name });
  const fleetName = fleet.data?.servers.find((s) => s.id === serverId)?.name;
  // What the assistant found out about the server and the plan it offers (handle-it.md); none on an older Whombat.
  const look = useLookResearch({ params: { burrow: slug }, query: { key: thing } }, { retry: false });
  const research = look.data?.research ?? null;
  const handOver = useHandOver(thing, (question) => setAsking({ text: question }));
  const dash = useServerDashboard({
    burrow: slug,
    serverId,
    range,
    timeZone,
    updates: 'phone',
    quiet: !!watch.data?.mayChange,
    // The verdict names it as the person does; a problem's button asks the assistant by name.
    name: fleetName ?? name,
    assistant: agent.name,
  });
  const [tab, setTab] = useState<ServerTab>('summary');
  const [pulling, setPulling] = useState(false);
  const scroller = useRef<ScrollView>(null);
  // With the list hidden on an open phone the cards sit in columns, as on the web.
  const widePage = useWidePage(INSET);
  const tabsAt = useRef(0);
  const d = dash.detail ?? null;
  const unraid = d && isUnraidServer(d) ? (d.unraid ?? null) : null;
  const incus = d && isIncusServer(d) ? (d.incus ?? null) : null;
  // A QEMU/KVM server (IU-13): libvirt without Proxmox VE, Unraid or Incus.
  const libvirt = d && isLibvirtServer(d) ? (d.libvirt ?? null) : null;
  // A Mac (macos-servers.md): its Summary and its Screen, nothing running on it to list; its Summary links to the Find
  // My connection that reads it (findmy-connection.md §1.5).
  const mac = !!d && isMacServer(d);
  const findMy = useFindMyConnectionOf(slug, mac ? serverId : null);
  // An older Whombat has no Find My connection: its Mac keeps its own Find My segment until it is updated.
  const findMyHere = useFindMyOnMac(mac);
  // The other segments name guests (Backups by its guest, Array's stop question by its containers).
  const guests = useHostGuests(
    tab !== 'summary' ? { params: { burrow: slug }, query: { server: serverId, limit: 200 } } : null,
    { retry: false },
  );
  // Connections that are part of this server (its Proxmox API): Things leaves them out, this page lists them (CP-10).
  const home = useHomeOverview({ params: { burrow: slug } });
  const parts = useMemo(() => partsOf(home.data?.things ?? [], serverId), [home.data, serverId]);
  const findMyLine = findMy
    ? (home.data?.things.find((t) => t.id === thingId('connection', findMy.connectionId))?.line ?? null)
    : null;
  const [asking, setAsking] = useState<{ text: string | null } | null>(null);
  // Temporary machines (CI jobs, sandboxes) stay out of the list until asked for.
  const [showTemporary, setShowTemporary] = useState(false);

  const row = fleet.data?.servers.find((s) => s.id === serverId) ?? null;
  // The name a person gave it (the page's, else the fleet's), the one just saved while those catch up.
  const rename = useThingRename(slug);
  const shown = rename.shown(thing, d?.server.name ?? row?.name ?? name);
  const target = thingRenameTarget({ id: thing, name: shown });
  const known: HostGuest[] = guests.data?.guests ?? (d ? detailGuests(d) : []);
  const list = useMemo(
    () => serverGuestList(guests.data?.guests ?? [], showTemporary),
    [guests.data, showTemporary],
  );
  const rows = list.rows;
  const unraidOp = useUnraidOp(serverId, shown);
  const keep = useKeepQuiet(slug, thing, { name: shown, timeZone, note: quietNote(showToast) });
  const hold = keepsQuiet && d ? holdView(d) : null;
  const canKeepQuiet = keepsQuiet && (!!watch.data?.mayChange || !!d?.keptQuiet?.canEnd);
  const subject: ChatSubject = { kind: 'server', id: serverId, name: shown };
  const askAbout = useAskAbout(subject, shown, () => setAsking({ text: null }));
  const updates = useServerUpdatesView(d, shown);
  const openUpdates = () => navigation.navigate('ServerUpdates', { serverId, title: shown, back: shown });
  const proxmox = !!d?.proxmox || d?.server.platform === 'proxmox';
  const tabs: ServerTab[] = mac
    ? [...(findMyHere ? MAC_PHONE_TABS_WITH_FIND_MY : MAC_PHONE_TABS)]
    : unraid
      ? ['summary', 'array', 'guests', 'plugins']
      : proxmox || incus || libvirt
        ? ['summary', 'guests', 'backups']
        : ['summary', 'guests'];
  const phoneTabs = serverPhoneTabs(tabs);
  const shownTab: ServerTab = tabs.includes(tab) ? tab : 'summary';
  const canChange = true;
  const rc = d?.server.remoteControl;
  // Unraid's and Incus's changes: the Manage switch on both sides and this Whombat's runtime (IU-06).
  const manageOn = rc?.manage === true;
  const unraidChange = manageOn;
  const incusChange = manageOn;
  const libvirtChange = manageOn;
  const manageOff = !manageOn
    ? rc?.manageReason?.trim() || `Changing ${shown} is switched off for Whombat.`
    : null;
  // “Asks you first” (SA-05, SA-08): on a Whombat that keeps it.
  const asksFirst = d?.server.asksFirst ?? row?.asksFirst;
  const hostsThisWhombat = d?.server.hostsThisWhombat ?? row?.hostsThisWhombat;
  const asks = serverAsksRow({ server: shown, asksFirst, hostsThisWhombat, available: true });
  const absent = status.data && !status.data.present;
  const failed = !d && !row && (!!dash.error || fleet.isError);
  const openGuest = (g: Pick<HostGuest, 'id' | 'name'>, guestTab?: string) =>
    navigation.navigate('Guest', {
      serverId,
      guestId: g.id,
      title: g.name,
      back: shown,
      ...(guestTab ? { tab: guestTab } : {}),
    });
  const showTab = (next: ServerTab) => {
    setTab(next);
    scroller.current?.scrollTo({ y: Math.max(0, tabsAt.current - 8), animated: true });
  };
  /** A Summary link's way out (DS-09): its question, a segment, a guest, nothing for a console, else the link. */
  const run = (r: LinkRun) => {
    switch (r.kind) {
      case 'ask':
        return setAsking({ text: r.question });
      case 'tab': {
        const to = serverTabFor(r.tab, tabs);
        return to ? showTab(to) : undefined;
      }
      case 'settings':
        return;
      case 'href': {
        const at = serverLinkTarget(r.href, serverId);
        if (!at) return void openHref(r.href);
        if (at.guest) {
          const g = known.find((x) => x.id === at.guest);
          return openGuest({ id: at.guest, name: g?.name ?? at.guest }, at.guestTab ?? undefined);
        }
        // The updates have their own screen (AP-2880); Unraid's are its Plugins.
        if (at.tab === 'updates' && !unraid) return openUpdates();
        const to = at.tab ? serverTabFor(at.tab, tabs) : null;
        return to ? showTab(to) : undefined;
      }
      case 'url':
        return void Linking.openURL(r.url).catch(() => {});
    }
  };
  // While a new range loads the previous one stays on screen, with its own words along the bottom.
  const shownRange = dash.series && dash.series.range !== 'custom' ? dash.series.range : range;
  const ctx: PanelContext = {
    thing: { id: `server:${serverId}`, name: shown },
    tabs: phoneTabs,
    range: shownRange,
    run,
    openSettings: null,
    quiet,
    research,
    onHandle: handOver,
    endQuiet: d?.keptQuiet?.canEnd ? { run: () => void keep.end(), busy: keep.busy } : null,
    limits:
      keepsQuiet && watch.data?.mayChange
        ? { of: (line) => lineLimit(line, watch.data?.checks), open: setLimitFor }
        : null,
  };
  const panels = useMemo(() => shownPanels(dash.panels ?? []), [dash.panels]);
  const ranges = useMemo(() => rangeOptions(SERVER_DASHBOARD_PHONE_RANGES), []);
  const refresh = () => {
    setPulling(true);
    dash.refetch();
    void fleet.refetch();
    void watch.refetch();
    if (tab !== 'summary') void guests.refetch();
  };
  // A pull shows until its reads are in (the 60-second reads show nothing).
  useEffect(() => {
    if (!pulling || dash.fetching) return;
    const t = setTimeout(() => setPulling(false), 300);
    return () => clearTimeout(t);
  }, [pulling, dash.fetching]);

  return (
    <Screen>
      <BackBar
        label={back}
        onPress={onBack}
        right={
          target && (d || row) && !absent ? (
            <ServerMenu
              name={shown}
              onRename={() => rename.start(thing)}
              onKeepQuiet={canKeepQuiet ? () => setKeeping(true) : null}
            />
          ) : undefined
        }
      />
      <ScrollView
        ref={scroller}
        onLayout={widePage.onLayout}
        // A tap on Cancel under the name's box reaches it with the keyboard up.
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: INSET, paddingBottom: 24 + bottomRoom, gap: 14 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={refresh}
            colors={[theme.colors.ink]}
            tintColor={theme.colors.mut}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <ServerHead
          head={dash.head}
          verdict={dash.verdict}
          name={shown}
          idLine={isOwnId(shown, serverId) ? null : serverId}
          renaming={
            target && rename.editing === thing ? (
              <InlineRename
                value={shown}
                maxLength={target.max}
                label={RENAME_COPY.label(shown)}
                hint={RENAME_COPY.serverHint}
                onSave={(typed) => rename.save(target, typed)}
                onClose={rename.stop}
                size={26}
                weight={600}
                mono={isOwnId(shown, serverId)}
              />
            ) : null
          }
          mark={d ? serverMark(d.server) : row ? serverMark(row) : null}
          // When its readings were taken: the page's own report, else the fleet's for it (the same server's report).
          readAt={d ? serverReportAt(d) : (row?.lastSeen ?? null)}
          here={thisWhombatFact(hostsThisWhombat, known)?.value ?? null}
          week={d?.uptime?.text ?? null}
          fallback={
            row
              ? {
                  status: row.status,
                  words: [statusText(row.status, row.statusNote), shortOs(row.os)]
                    .filter(Boolean)
                    .join(' · '),
                }
              : null
          }
        />
        {hold?.kind === 'window' ? (
          // Kept quiet until a time: its words, who, and End now; its banner waits meanwhile.
          <KeptQuietLine
            words={hold.words}
            who={hold.who}
            endNow={hold.endNow}
            busy={keep.busy}
            onEnd={() => void keep.end()}
          />
        ) : null}
        {absent ? (
          <QuietText>{serverCopyHere.absent}</QuietText>
        ) : failed ? (
          <ReadNote
            title={overviewWordsHere.couldntRead(shown)}
            body={overviewWordsHere.noSaved}
            onRetry={dash.refetch}
            error={dash.error}
          />
        ) : !d && !row ? (
          <CardSkeletons label={overviewWordsHere.loading(shown)} count={2} tiles={4} />
        ) : (
          <>
            {d && dash.error ? (
              // A failed refresh keeps the saved readings, with the time they were taken.
              <ReadNote
                title={savedTitle(serverReportAt(d), timeZone)}
                body={overviewWordsHere.keepLast}
                onRetry={dash.refetch}
                error={dash.error}
              />
            ) : null}
            <View
              onLayout={(e) => {
                tabsAt.current = e.nativeEvent.layout.y;
              }}
            >
              <UnderlineTabs<ServerTab>
                label={`${shown}: what to show`}
                value={shownTab}
                onChange={setTab}
                tabs={tabs.map((t) => ({
                  key: t,
                  // What runs on it: its Machines, or a Docker host's and Unraid's Apps.
                  label: t === 'guests' && d ? guestsWord(serverDashboardKind(d)) : serverCopyHere[t],
                }))}
                bleed={INSET}
              />
            </View>
            {shownTab === 'screen' && mac && d ? (
              <MacScreenPart serverId={serverId} serverName={shown} detail={d} now={now} />
            ) : shownTab === 'findmy' && mac ? (
              <FindMyPart serverId={serverId} />
            ) : shownTab === 'backups' && incus ? (
              <IncusServerBackups
                slug={slug}
                serverId={serverId}
                hints={d?.hints ?? []}
                guests={guests.data?.guests ?? []}
                now={now}
                timeZone={timeZone}
                canChange={incusChange}
                onOpenGuest={(g, t) => openGuest(g, t)}
              />
            ) : shownTab === 'backups' && libvirt ? (
              <LibvirtServerBackups
                slug={slug}
                serverId={serverId}
                hints={d?.hints ?? []}
                guests={guests.data?.guests ?? []}
                now={now}
                timeZone={timeZone}
                canChange={libvirtChange}
                onOpenGuest={(g, t) => openGuest(g, t)}
              />
            ) : shownTab === 'backups' ? (
              <ServerBackups
                slug={slug}
                serverId={serverId}
                serverName={shown}
                detail={d}
                guests={guests.data?.guests ?? []}
                now={now}
                timeZone={timeZone}
                canChange={canChange}
                jobs={true}
              />
            ) : shownTab === 'array' && unraid ? (
              <UnraidArray
                serverId={serverId}
                serverName={shown}
                detail={d ?? { server: { address: null } as never }}
                unraid={unraid}
                guests={known}
                now={now}
                timeZone={timeZone}
                canChange={unraidChange}
                manageOff={manageOff}
              />
            ) : shownTab === 'plugins' && unraid ? (
              <UnraidPlugins
                serverId={serverId}
                serverName={shown}
                detail={d ?? { server: { address: null } as never }}
                unraid={unraid}
                now={now}
                timeZone={timeZone}
                canChange={unraidChange}
              />
            ) : shownTab === 'summary' ? (
              <>
                {research && d ? (
                  <LookCard
                    page={{
                      research,
                      name: shown,
                      status: d.server.status === 'pending' ? 'warn' : d.server.status,
                    }}
                    onAsk={askAbout}
                  />
                ) : null}
                {dash.loading ? (
                  <CardSkeletons label={overviewWordsHere.loading(shown)} count={2} tiles={4} />
                ) : (
                  <SummaryPanels
                    panels={panels}
                    ctx={ctx}
                    range={{
                      options: ranges,
                      value: range,
                      onChange: setRange,
                    }}
                    extra={
                      // The Updates card (SWU-12): the line, when it was read, the restart it needs.
                      updates?.available ? <UpdatesCard view={updates} onOpen={openUpdates} /> : null
                    }
                    wide={widePage.wide}
                  />
                )}
                {/* The last 30 days: its outages and problems, and its own alerts folded under them. */}
                <WhatHappenedCard thing={thing} />
                {/* When it keeps this Whombat's backups (backup-places.md AP-6721). */}
                <BackupsKeptHere thing={thing} />
                {dash.head ? (
                  <TechnicalDetailsCard rows={dash.head.details} panels={dash.details ?? []} ctx={ctx} />
                ) : null}
                {d ? (
                  // How its agent keeps up to date (agent-updates-app.md AP-2991), with the feature.
                  <AgentUpdatesCard serverId={serverId} serverName={shown} detail={d} />
                ) : null}
                {asks ? (
                  <AsksFirstCard
                    serverId={serverId}
                    serverName={shown}
                    asksFirst={asksFirst}
                    hostsThisWhombat={hostsThisWhombat}
                  />
                ) : null}
                {d ? (
                  // What Whombat watches (QN-15, AP-4867): the phone has no Settings tab for a server, so it sits
                  // with Asks you first at the end of the Summary, folded after six checks.
                  <OneCard label={QUIET_COPY.watchTitle}>
                    <WhatWhombatWatches
                      watch={watch.data}
                      pending={watch.isPending}
                      failed={watch.isError}
                      onRetry={() => void watch.refetch()}
                      actions={quiet}
                      timeZone={timeZone}
                      now={now}
                      first={WATCH_FIRST}
                      divider="top"
                      inset={14}
                      onLimit={keepsQuiet ? setLimitFor : null}
                    />
                  </OneCard>
                ) : null}
                {findMy ? (
                  // The one link to Find My on this Mac: its connection's page, with its line from Overview.
                  <OneCard>
                    <OneRow
                      first
                      leading={<ThingIcon glyph="plug" mark="findmy" />}
                      title={FIND_MY_WORDS.linkTitle}
                      line={findMyLine}
                      chevron
                      label={[FIND_MY_WORDS.linkTitle, findMyLine].filter(Boolean).join(', ')}
                      hint={FIND_MY_WORDS.linkHint}
                      onPress={() =>
                        navigation.navigate('Thing', {
                          thingId: thingId('connection', findMy.connectionId),
                          title: findMy.label,
                          back: shown,
                        })
                      }
                    />
                  </OneCard>
                ) : null}
                {parts.length ? (
                  <OneCard label={thingPageCopyHere.alsoConnected}>
                    {parts.map((t) => (
                      <OneRow
                        key={t.id}
                        leading={<ThingIcon glyph={thingGlyph(t)} mark={thingMark(t)} />}
                        title={t.name}
                        trailing={<ThingDot status={t.status} />}
                        chevron
                        label={`${thingPageCopyHere.alsoConnected}: ${t.name}`}
                        hint={tMobile('screens.opens-its-page')}
                        onPress={() =>
                          navigation.navigate('Thing', { thingId: t.id, title: t.name, back: shown })
                        }
                      />
                    ))}
                  </OneCard>
                ) : null}
                <BigButton label={serverCopyHere.ask(shown)} variant="secondary" onPress={askAbout} />
              </>
            ) : guests.isPending ? (
              <SkeletonRows count={6} lines={2} label={tMobile('screens.loading-the-guests')} />
            ) : !guests.data ? (
              <ErrorState text={serverCopyHere.guestsFailed} onRetry={() => void guests.refetch()} />
            ) : rows.length === 0 && !list.temporary ? (
              <QuietText>{serverCopyHere.noGuests}</QuietText>
            ) : (
              <>
                {unraid && unraidChange && unraid.docker.enabled ? (
                  <Button
                    label={tMobile('screens.check-containers-for-updates')}
                    variant="secondary"
                    busy={unraidOp.busy}
                    onPress={() => void unraidOp.run('containers.check')}
                  />
                ) : null}
                <OneCard>
                  {rows.map((g, i) => (
                    <OneRow
                      key={g.id}
                      first={i === 0}
                      leading={<GuestKindMark glyph={g.kind.glyph} />}
                      title={g.name}
                      titleMono
                      // The name comes first and isn't cut (CN-08, AP-2562): a long one takes a second line.
                      titleLines={2}
                      titleAfter={g.kind.id}
                      line={g.meta || null}
                      badge={g.self ? <ToneBadge text={THIS_WHOMBAT} tone="brand" /> : undefined}
                      trailing={
                        // Running is the dot alone; any other state says its word too (AP-1753, AP-1810).
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Dot tone={g.tone} />
                          {g.guest.state === 'running' ? null : (
                            <Text size={12} weight={500} mono color={toneOf(theme, g.tone)}>
                              {g.stateText}
                            </Text>
                          )}
                        </View>
                      }
                      chevron
                      label={g.label}
                      hint={tMobile('screens.opens-its-page')}
                      onPress={() => openGuest(g)}
                    />
                  ))}
                  {list.temporary ? (
                    <OneRow
                      first={rows.length === 0}
                      title={list.temporary.text}
                      trailing={
                        <Text size={13.5} weight={600} color={theme.colors.brand}>
                          {list.temporary.button}
                        </Text>
                      }
                      label={`${list.temporary.text}. ${list.temporary.button}`}
                      onPress={() => setShowTemporary(!showTemporary)}
                    />
                  ) : null}
                </OneCard>
              </>
            )}
          </>
        )}
      </ScrollView>
      <NewChatSheet
        visible={!!asking}
        onClose={() => setAsking(null)}
        subject={subject}
        back={shown}
        initialText={asking?.text ?? null}
      />
      <KeepQuietSheet visible={keeping} name={shown} actions={keep} onClose={() => setKeeping(false)} />
      <LimitSheet view={limitFor} actions={limits} onClose={() => setLimitFor(null)} />
    </Screen>
  );
}

/** The head's ⋯ (44dp): Rename, and Keep quiet…. iOS's own menu from the button on iPhone, a sheet elsewhere. */
function ServerMenu({
  name,
  onRename,
  onKeepQuiet,
}: {
  name: string;
  onRename: () => void;
  onKeepQuiet: (() => void) | null;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const spec = serverMoreMenu(!!onKeepQuiet);
  const onPick = (id: string) => {
    if (parseThingRowPick(id) === 'rename') onRename();
    if (parseMonitoringPick(id) === 'keep_quiet') onKeepQuiet?.();
  };
  const face = <Ellipsis size={22} color={theme.colors.ink2} strokeWidth={1.75} />;
  const box = {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  } as const;
  if (hasNativeMenu)
    return (
      <NativeMenu spec={spec} onPick={onPick} trigger="tap" label={RENAME_COPY.more(name)} style={box}>
        <View style={box}>{face}</View>
      </NativeMenu>
    );
  return (
    <>
      <Touchable
        onPress={() => setOpen(true)}
        feedback="wash"
        ringRadius={22}
        accessibilityLabel={RENAME_COPY.more(name)}
        style={box}
      >
        {face}
      </Touchable>
      <MenuSheet
        spec={open ? spec : null}
        visible={open}
        label={RENAME_COPY.rowMenu(name)}
        onClose={() => setOpen(false)}
        onPick={onPick}
      />
    </>
  );
}

/**
 * The head (DS-01): the name — a host name in the mono face, a name a person gave it in the sans face with its id
 * quietly under it in mono — its status pill (red only when it isn't working) with when its own report was read (“Read 2
 * min ago”, as on Overview), then the verdict (“pve-02 is running warm. 2 things need you.”) and, when this Whombat runs
 * on it, that. Its versions, processor, address and helper are the Summary's
 * Technical details. Before the server's page is read, the fleet's status words. While it is renamed the name is a box.
 */
function ServerHead({
  head,
  verdict,
  name,
  idLine,
  renaming,
  mark,
  readAt,
  here,
  week,
  fallback,
}: {
  head: ServerDashboardHead | null;
  verdict: Verdict | null;
  name: string;
  /** Its id under a name a person gave it; null when it goes by its id. */
  idLine: string | null;
  /** The box the name is while it is renamed. */
  renaming: ReactNode;
  /** What it runs, as its mark (Debian, Proxmox; marks.md AP-2205), beside the name. */
  mark: MarkLike | null;
  /** When its readings were taken (its own report), null when unknown: “Reading time unknown”. */
  readAt: string | null;
  /** “Runs here, in whombat”: this Whombat runs on it. */
  here: string | null;
  /** Its week in one line: “Up 99.6 % this week · down once, 12 min”. */
  week: string | null;
  fallback: { status: Parameters<typeof serverThingStatus>[0]; words: string } | null;
}) {
  const { rawLocale } = useI18n();

  const theme = useTheme();
  const { timeZone } = useBurrowBase();
  const status = head?.status ?? fallback?.status ?? null;
  const badge = head?.badge ?? fallback?.words ?? null;
  const read = useNowLabel((now) => readingTime(readAt, now, timeZone, rawLocale).text);
  const readExact = useNowLabel((now) => readingTime(readAt, now, timeZone, rawLocale).exact);
  return (
    <View style={{ gap: 8 }}>
      <View
        style={{ gap: 6 }}
        // While it is renamed the box is its own stop.
        accessible={!renaming}
        {...(renaming
          ? null
          : {
              accessibilityRole: 'header' as const,
              accessibilityLabel: [name, idLine, badge, readExact, week].filter(Boolean).join(', '),
            })}
      >
        <View style={{ flexDirection: 'row', alignItems: renaming ? 'flex-start' : 'center', gap: 10 }}>
          {mark ? (
            <View style={renaming ? { paddingTop: 10 } : null}>
              <ThingIcon glyph="server" mark={mark} size={24} />
            </View>
          ) : null}
          {renaming ?? (
            <Text
              size={26}
              weight={600}
              mono={!idLine}
              tracking={-0.02}
              numberOfLines={2}
              style={{ flexShrink: 1 }}
            >
              {name}
            </Text>
          )}
        </View>
        {idLine && !renaming ? (
          <Text size={13} mono color={theme.colors.mut} numberOfLines={1}>
            {idLine}
          </Text>
        ) : null}
        {/* The pill (red only when it isn't working) and when its readings were taken, as on Overview. */}
        <View
          style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 6 }}
        >
          {status && badge ? <LevelPill level={serverStatusLevel(status)} word={badge} /> : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Clock size={13} color={theme.colors.mut} strokeWidth={1.8} />
            <Text size={12} mono color={theme.colors.mut} numberOfLines={1}>
              {read}
            </Text>
          </View>
          {/* The row's gap sets it apart: a “·” of its own would start the next line when it wraps. */}
          {week ? (
            <Text size={12} mono color={theme.colors.mut} numberOfLines={2} style={{ flexShrink: 1 }}>
              {week}
            </Text>
          ) : null}
        </View>
      </View>
      {verdict ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
          <View style={{ paddingTop: 7 }}>
            <Dot tone={verdictDot(verdict)} />
          </View>
          <Text size={15.5} lh={1.45} style={{ flexShrink: 1 }}>
            {verdict.sentence}
          </Text>
        </View>
      ) : null}
      {here ? (
        <Text size={13.5} lh={1.45} color={theme.colors.brand}>
          {`${THIS_WHOMBAT}: ${here}`}
        </Text>
      ) : null}
    </View>
  );
}

/** A failed refresh's heading: “Couldn’t refresh; showing readings from 14:03 on 23 Sept.”, or that their time is unknown. */
function savedTitle(at: string | null, timeZone: string): string {
  return at ? OVERVIEW_WORDS.savedFrom(readingsMoment(at, timeZone)) : OVERVIEW_WORDS.savedUnknown;
}
