/**
 * A guest's screen on the phone (Whombat proxmox.md PX-06, incus-unraid.md IU-02, IU-09; proxmox-mobile.md
 * AP-1485…AP-1497, incus-unraid-mobile.md AP-1617…AP-1631), opened from a server's guest rows
 * (`things/<server>/guests/<guest>`): its kind as a mark before its name (less-is-more.md AP-1810; Proxmox's
 * number in the line under it), its state as a dot and words, its server or node and project, its tags, and “This Whombat” on the guest this Whombat runs in; its power (Start, Shut down, Restart, Pause,
 * Force stop as its state allows; all but Start and Resume ask first) and More — Proxmox: Back up now, Take a
 * snapshot, Clone, Delete; Incus: Back up now, Take a snapshot, Copy, Rename, Delete — then the tabs Summary · Settings ·
 * Snapshots · Backups · Tasks (underlined, five scrolling sideways; underline-tabs-android.md AP-2633) while the server's
 * Manage switch is on, the Summary alone (saying why) while it is off.
 * On this Whombat itself everything that would switch it off or change it is hidden, with one line saying why. A
 * libvirt VM (QEMU/KVM, IU-13) gets the Incus instance's screen: Settings with vCPUs, memory, autostart, notes and the
 * CD/DVD's ISO, Snapshots, Backups, Tasks, and More with Back up now, Clone, Rename, Delete. A Docker container of an
 * Unraid server gets Update, autostart and its web page on the Summary.
 * Live on the `hosts` topic; long work says when it starts and when it ends (PX-05, IU-07). Hardware, devices,
 * profiles, firewall, HA and moving stay on the web.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { machineVerdict, type PowerActionView, powerActions, type Verdict } from '@whombat/client/hosts';
import {
  type GuestEditKind,
  type GuestWayOut,
  guestHead,
  type IncusEditKind,
  incusHeadLine,
  incusScheduleLine,
  isSelfGuest,
  type LibvirtEditKind,
  libvirtHeadLine,
  manageOffText,
  PHONE_GUEST_TAB_WORDS,
  type PhoneGuestTab,
  phoneGuestTabs,
  phoneIncusTabs,
  phoneLibvirtTabs,
  SELF_LINE,
  selfAllowsAction,
  selfAllowsOp,
  THIS_WHOMBAT,
} from '@whombat/client/hosts/mobile';
import {
  SERVER_DASHBOARD_DETAIL_RANGE,
  useHostGuest,
  useHostManageRead,
  useHostServer,
  useHostsFleet,
  useHostsLive,
  useRefreshHosts,
} from '@whombat/client/hosts/react';
import { thingHref } from '@whombat/core';
import { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useBurrowBase, useNow } from '../data/BurrowProvider';
import { canPower, verdictDot } from '../data/servers';
import { useWebUrl } from '../data/useWebUrl';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Dot, ToneBadge } from '../ui/assistant';
import { GuestKindMark } from '../ui/guestKind';
import { BackBar, Screen } from '../ui/headers';
import { Button, ErrorState, QuietText, SkeletonRows } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { UnderlineTabs } from '../ui/UnderlineTabs';
import { useDecisionFeedback } from './feedback';
import { ContainerCard } from './guest/ContainerCard';
import { GuestBackups } from './guest/GuestBackups';
import { EditSheet, GrowSheet, GuestSettings } from './guest/GuestSettings';
import {
  AddToJobSheet,
  BackupNowSheet,
  CloneSheet,
  DeleteSheet,
  type MoreChoice,
  MoreSheet,
  PowerSheet,
  RestartSheet,
  SnapshotSheet,
} from './guest/GuestSheets';
import { GuestSnapshots } from './guest/GuestSnapshots';
import { GuestSummary } from './guest/GuestSummary';
import { GuestTasks } from './guest/GuestTasks';
import { IncusBackups } from './guest/IncusBackups';
import { IncusEditSheet, IncusSettings } from './guest/IncusSettings';
import { CopySheet, IncusBackupNowSheet, RenameSheet } from './guest/IncusSheets';
import { IncusSummary } from './guest/IncusSummary';
import { LibvirtEditSheet, LibvirtSettings } from './guest/LibvirtSettings';
import { LibvirtBackupNowSheet, LibvirtCloneSheet } from './guest/LibvirtSheets';
import { Tags } from './guest/parts';
import { useGuestAction } from './guest/useServerChange';

type Props = NativeStackScreenProps<RootStackParamList, 'Guest'>;

type Open =
  | { kind: 'power'; action: PowerActionView }
  | { kind: 'more' }
  | { kind: MoreChoice }
  | { kind: 'restart' }
  | { kind: 'add_to_job' }
  | { kind: 'edit'; edit: GuestEditKind }
  | { kind: 'incus_edit'; edit: IncusEditKind }
  | { kind: 'libvirt_edit'; edit: LibvirtEditKind; key?: string }
  | { kind: 'grow'; disk: string };

const TABS: readonly PhoneGuestTab[] = ['summary', 'settings', 'snapshots', 'backups', 'tasks'];
/** The page's side padding; the tabs' hairline reaches over it (AP-2633). */
const INSET = 18;
/** The op each of More's choices sends, for the self guest's check (IU-02). */
const MORE_OPS = {
  backup: 'backup.create',
  clone: 'guest.clone',
  rename: 'guest.rename',
  delete: 'guest.delete',
} as const;
/** After a rename the screen asks for the new id a little while, until the server lists it (AP-1624). */
const RENAME_WAIT_MS = 30_000;

export function GuestScreen({ route, navigation }: Props) {
  const bottomRoom = useBottomRoom();
  const { serverId, guestId, title } = route.params;
  const theme = useTheme();
  const { slug, timeZone, currentBootstrap, clock } = useBurrowBase();
  const now = useNow().getTime();
  const webUrl = useWebUrl();
  const refresh = useRefreshHosts();
  useHostsLive(currentBootstrap().burrow.id);
  const [renamedAt, setRenamedAt] = useState<number | null>(null);
  const fleet = useHostsFleet({ params: { burrow: slug } }, { retry: false });
  const q = useHostGuest(
    { params: { burrow: slug, serverId, guestId } },
    { retry: false, refetchInterval: renamedAt ? 2000 : false },
  );
  const g = q.data;
  const pve = g?.platform === 'pve';
  const incus = g?.platform === 'incus';
  // A libvirt VM gets the Incus instance's screen when this Whombat's runtime has it (`hosts.libvirt`, IU-13).
  const libvirt = g?.platform === 'libvirt';
  const platform = pve ? 'pve' : incus ? 'incus' : libvirt ? 'libvirt' : null;
  // The server's page: its hints (an Incus guest's way out) and whether it is Unraid. The Summary's read (its range),
  // so coming from the server's page reads nothing again.
  const server = useHostServer(
    incus || g?.platform === 'docker' || g?.platform === 'libvirt'
      ? { params: { burrow: slug, serverId }, query: { range: SERVER_DASHBOARD_DETAIL_RANGE } }
      : null,
    { retry: false },
  );
  const cfgQ = useHostManageRead(
    g?.manageable && platform
      ? { params: { burrow: slug, serverId }, query: { op: 'config.get', guestId, platform } }
      : null,
    { retry: false },
  );
  const config = cfgQ.data?.op === 'config.get' ? cfgQ.data.config : undefined;
  // Start and Resume go at once; everything else asks first (Pause too, PX-06).
  const act = useGuestAction(serverId, { id: guestId, name: g?.name ?? title ?? guestId });
  const feedback = useDecisionFeedback();
  const asked = route.params.tab;
  const [tab, setTab] = useState<PhoneGuestTab>(
    asked && (TABS as readonly string[]).includes(asked) ? (asked as PhoneGuestTab) : 'summary',
  );
  const [open, setOpen] = useState<Open | null>(null);
  const fleetRow = fleet.data?.servers.find((s) => s.id === serverId);
  const serverName = fleetRow?.name ?? serverId;
  const back = route.params.back ?? serverName;
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));
  // The renamed guest is listed again: stop asking.
  useEffect(() => {
    if (renamedAt && (q.data || clock().getTime() - renamedAt > RENAME_WAIT_MS)) setRenamedAt(null);
  }, [renamedAt, q.data, clock]);

  if (!g)
    return (
      <Screen>
        <BackBar label={back} onPress={goBack} />
        <View style={{ paddingHorizontal: INSET, gap: 14 }}>
          <Text size={28} weight={700} tracking={-0.02} accessibilityRole="header">
            {title ?? guestId}
          </Text>
          {q.isError && !renamedAt ? (
            <ErrorState text="This guest didn’t load." onRetry={() => void q.refetch()} />
          ) : (
            <SkeletonRows count={4} lines={2} label="Loading the guest" />
          )}
        </View>
      </Screen>
    );

  const head = guestHead(g);
  const self = isSelfGuest(g);
  const line = incus ? incusHeadLine(g) : libvirt ? libvirtHeadLine(g) : head.line;
  const power = canPower(g.remoteControl, g.serverOnline !== false);
  // Incus changes need this Whombat's runtime to know them (`hosts.incus`, as `hosts.backup_jobs`).
  const canChange = g.manageable;
  const tabs = incus ? phoneIncusTabs(g) : libvirt ? phoneLibvirtTabs(g) : phoneGuestTabs(g);
  const shown = tabs.includes(tab) ? tab : 'summary';
  const actions = power.ok ? powerActions(g).filter((a) => selfAllowsAction(g, a.action)) : [];
  const onUnraid = server.data?.server.platform === 'unraid' || !!server.data?.unraid;
  const containerChange = g.remoteControl.manage === true;
  const more: MoreChoice[] = canChange
    ? (
        [
          'backup',
          ...(tabs.includes('snapshots') ? (['snapshot'] as const) : []),
          'clone',
          ...(incus || libvirt ? (['rename'] as const) : []),
          'delete',
        ] as MoreChoice[]
      ).filter((c) => c === 'snapshot' || selfAllowsOp(g, MORE_OPS[c]))
    : [];
  const close = () => setOpen(null);
  const base = { serverId, serverName, guest: g, onClose: close };
  const wayOut = (to: GuestWayOut) => {
    if (to === 'snapshots') setTab('snapshots');
    else if (to === 'back_up') setOpen({ kind: 'backup' });
    else if (to === 'restart') setOpen({ kind: 'restart' });
    else setOpen({ kind: 'add_to_job' });
  };
  const settingsChange = canChange && selfAllowsOp(g, 'config.set');
  const guestWeb = webUrl(
    `${thingHref('server', serverId)}?guest=${encodeURIComponent(g.id)}${pve ? '&gtab=hardware' : ''}`,
  );

  return (
    <Screen>
      <BackBar label={back} onPress={goBack} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: INSET, paddingBottom: 24 + bottomRoom, gap: 14 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={q.isRefetching && !renamedAt}
            onRefresh={() => refresh()}
            colors={[theme.colors.ink]}
            tintColor={theme.colors.mut}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <View
          style={{ gap: 8 }}
          accessible
          accessibilityRole="header"
          accessibilityLabel={self ? `${head.label}, ${THIS_WHOMBAT}` : head.label}
        >
          {/* The kind as a mark before the name (less-is-more.md AP-1810); Proxmox's number leads the line. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <GuestKindMark glyph={head.kind.glyph} size={26} />
            <Text size={28} weight={700} tracking={-0.02} numberOfLines={2} style={{ flexShrink: 1 }}>
              {head.name}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Dot tone={head.tone === 'mut' ? null : head.tone} />
            <Text size={14} color={theme.colors.ink2} numberOfLines={1} style={{ flexShrink: 1 }}>
              {[head.stateText, head.kind.id, line].filter(Boolean).join(' · ')}
            </Text>
          </View>
          {self ? <ToneBadge text={THIS_WHOMBAT} tone="brand" /> : null}
          <Tags tags={head.tags} />
        </View>
        {/* The verdict, as on the web: its state in words, then what needs the person there. */}
        <GuestVerdict verdict={machineVerdict(g, server.data?.hints ?? [], now)} />
        {actions.length || more.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {actions.map((a, i) => (
              <Button
                key={a.action}
                label={a.label}
                variant={i === 0 && !a.confirm ? 'primary' : 'secondary'}
                busy={act.busy === a.action}
                disabled={act.busy !== null}
                onPress={() =>
                  a.confirm || a.action === 'pause'
                    ? setOpen({ kind: 'power', action: a })
                    : void act.send({ action: a.action }).then((o) => {
                        if (!o.ok && !o.waiting) feedback.onText(o.message);
                      })
                }
                style={{ flexGrow: 1, flexBasis: '30%' }}
              />
            ))}
            {more.length ? (
              <Button
                label="More"
                variant="secondary"
                onPress={() => setOpen({ kind: 'more' })}
                style={{ flexGrow: 1, flexBasis: '30%' }}
                accessibilityHint={
                  self
                    ? `Back up, snapshot or copy ${g.name}`
                    : incus
                      ? `Back up, snapshot, copy, rename or delete ${g.name}`
                      : `Back up, snapshot, clone or delete ${g.name}`
                }
              />
            ) : null}
          </View>
        ) : null}
        {self ? (
          <QuietText style={{ paddingVertical: 4 }}>{SELF_LINE}</QuietText>
        ) : !power.ok ? (
          <QuietText>{power.reason}</QuietText>
        ) : null}
        {tabs.length > 1 ? (
          <UnderlineTabs<PhoneGuestTab>
            label={`${g.name}: what to show`}
            value={shown}
            onChange={setTab}
            tabs={tabs.map((t) => ({ key: t, label: PHONE_GUEST_TAB_WORDS[t] }))}
            bleed={INSET}
          />
        ) : null}
        {shown === 'summary' ? (
          <GuestSummary
            slug={slug}
            serverId={serverId}
            serverName={serverName}
            guest={g}
            config={config}
            now={now}
            timeZone={timeZone}
            canChange={canChange && pve}
            jobs={true}
            manageOff={manageOffText(g, serverName)}
            onWayOut={wayOut}
            lead={
              // A libvirt VM with its full screen has autostart in its Settings.
              g.platform === 'docker' || (g.platform === 'libvirt' && !(libvirt && g.manageable)) ? (
                <ContainerCard
                  serverId={serverId}
                  serverName={serverName}
                  guest={g}
                  onUnraid={onUnraid}
                  canChange={containerChange}
                />
              ) : null
            }
            extra={
              incus || (libvirt && g.manageable) ? (
                <IncusSummary
                  slug={slug}
                  serverId={serverId}
                  platform={incus ? 'incus' : 'libvirt'}
                  guest={g}
                  config={config}
                  hints={server.data?.hints ?? []}
                  now={now}
                  timeZone={timeZone}
                  canChange={settingsChange}
                  canBackUp={canChange}
                  onWayOut={(to) =>
                    to === 'back_up'
                      ? setOpen({ kind: 'backup' })
                      : setOpen({ kind: 'incus_edit', edit: 'schedule' })
                  }
                />
              ) : null
            }
          />
        ) : shown === 'settings' ? (
          config ? (
            incus ? (
              <IncusSettings
                config={config}
                canChange={settingsChange}
                webUrl={guestWeb}
                onEdit={(edit) => setOpen({ kind: 'incus_edit', edit })}
              />
            ) : libvirt ? (
              <LibvirtSettings
                config={config}
                canChange={settingsChange}
                webUrl={guestWeb}
                onEdit={(edit, key) => setOpen({ kind: 'libvirt_edit', edit, ...(key ? { key } : {}) })}
              />
            ) : (
              <GuestSettings
                config={config}
                guest={g}
                canChange={settingsChange}
                webUrl={guestWeb}
                onEdit={(edit) => setOpen({ kind: 'edit', edit })}
                onGrow={(disk) => setOpen({ kind: 'grow', disk })}
              />
            )
          ) : cfgQ.isError ? (
            <ErrorState text="Its settings didn’t load." onRetry={() => void cfgQ.refetch()} />
          ) : (
            <SkeletonRows count={5} lines={2} label="Loading its settings" />
          )
        ) : shown === 'snapshots' ? (
          <GuestSnapshots
            slug={slug}
            serverId={serverId}
            guest={g}
            now={now}
            timeZone={timeZone}
            canChange={canChange}
            canRestore={selfAllowsAction(g, 'snapshot_restore')}
            {...(incus && config
              ? {
                  schedule: {
                    text: incusScheduleLine(config).text,
                    onChange: settingsChange ? () => setOpen({ kind: 'incus_edit', edit: 'schedule' }) : null,
                  },
                }
              : {})}
            onTake={() => setOpen({ kind: 'snapshot' })}
          />
        ) : shown === 'backups' ? (
          incus || libvirt ? (
            <IncusBackups
              slug={slug}
              serverId={serverId}
              platform={incus ? 'incus' : 'libvirt'}
              guest={g}
              now={now}
              timeZone={timeZone}
              canChange={canChange}
              onBackUp={() => setOpen({ kind: 'backup' })}
            />
          ) : (
            <GuestBackups
              slug={slug}
              serverId={serverId}
              guest={g}
              now={now}
              timeZone={timeZone}
              canChange={canChange}
              onBackUp={() => setOpen({ kind: 'backup' })}
            />
          )
        ) : (
          <GuestTasks
            slug={slug}
            serverId={serverId}
            guest={g}
            now={now}
            timeZone={timeZone}
            canChange={canChange}
          />
        )}
      </ScrollView>
      {open?.kind === 'power' ? <PowerSheet {...base} action={open.action} /> : null}
      {open?.kind === 'more' ? (
        <MoreSheet
          guest={g}
          choices={more}
          cloneWord={incus ? 'Copy' : 'Clone'}
          onPick={(c) => setOpen({ kind: c })}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'backup' ? (
        incus ? (
          <IncusBackupNowSheet {...base} />
        ) : libvirt ? (
          <LibvirtBackupNowSheet {...base} />
        ) : (
          <BackupNowSheet {...base} />
        )
      ) : null}
      {open?.kind === 'snapshot' ? <SnapshotSheet {...base} /> : null}
      {open?.kind === 'clone' ? (
        incus ? (
          <CopySheet {...base} />
        ) : libvirt ? (
          <LibvirtCloneSheet {...base} />
        ) : (
          <CloneSheet {...base} />
        )
      ) : null}
      {open?.kind === 'rename' ? (
        <RenameSheet
          {...base}
          platform={libvirt ? 'libvirt' : 'incus'}
          onRenamed={(id, name) => {
            setRenamedAt(clock().getTime());
            navigation.setParams({ guestId: id, title: name });
          }}
        />
      ) : null}
      {open?.kind === 'delete' ? (
        <DeleteSheet
          {...base}
          onDeleted={() => {
            close();
            goBack();
          }}
        />
      ) : null}
      {open?.kind === 'restart' ? <RestartSheet {...base} /> : null}
      {open?.kind === 'add_to_job' ? <AddToJobSheet {...base} /> : null}
      {open?.kind === 'edit' && config ? (
        <EditSheet serverId={serverId} guest={g} config={config} kind={open.edit} onClose={close} />
      ) : null}
      {open?.kind === 'libvirt_edit' && config ? (
        <LibvirtEditSheet
          serverId={serverId}
          guest={g}
          config={config}
          kind={open.edit}
          {...(open.key ? { cdrom: open.key } : {})}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'incus_edit' && config ? (
        <IncusEditSheet serverId={serverId} guest={g} config={config} kind={open.edit} onClose={close} />
      ) : null}
      {open?.kind === 'grow' && config ? (
        <GrowSheet serverId={serverId} guest={g} config={config} disk={open.disk} onClose={close} />
      ) : null}
    </Screen>
  );
}

/** The machine's verdict under its head (Whombat server-pages.md). */
function GuestVerdict({ verdict }: { verdict: Verdict }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
      <View style={{ paddingTop: 7 }}>
        <Dot tone={verdictDot(verdict)} />
      </View>
      <Text size={15.5} lh={1.45} style={{ flexShrink: 1 }}>
        {verdict.sentence}
      </Text>
    </View>
  );
}
