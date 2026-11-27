/**
 * A guest's page over its server's (ported from Rackoon's `features/guest/GuestPage.tsx`, `GuestHeader`,
 * `GuestLifecycleMenu`; PX-01): back to the server, the name with its state, the node and its tags, Console, Power
 * and More (Back up now, Clone, Convert to template, Move, Delete — a deleted guest or a new template leaves the page
 * when its task ends), the fact line, changes waiting for a restart, and the tabs the platform and the server's
 * switches allow — Summary, Hardware, Options, Cloud-Init, Snapshots, Backups, Firewall, Replication (a cluster), Tasks
 * (`?gtab=`).
 */
import {
  DASH,
  detailGuests,
  formatDuration,
  formatMemPair,
  GUEST_STATE_WORDS,
  type GuestHintView,
  type GuestTab,
  guestKindText,
  guestStateTone,
  guestTabs,
  guestTabWord,
  INCUS_GUEST_TAB_WORDS,
  type IncusGuestTab,
  incusGuestTabs,
  isSelfGuest,
  isUnraidServer,
  machineVerdict,
  parseGuestTab,
  parseIncusGuestTab,
  parseTags,
  selfAllowsOp,
} from '@whombat/client/hosts';
import { useHostGuest, useHostManageRead, useHostsChange } from '@whombat/client/hosts/react';
import { api } from '@whombat/core/contracts';
import type { HostGuestDetail, HostServerDetail } from '@whombat/core/domain';
import { ChevronLeft, Ellipsis } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type ContextMenuItem, useRowMenu } from '../../../app/shell/ContextMenu';
import { Icon } from '../../../components/Icon';
import { Tabs } from '../../../components/Tabs';
import { currentLocale } from '../../../i18n/provider';
import { AskButton } from '../AskPane';
import { TechnicalDetails, VerdictLine } from '../dashboard/Verdict';
import { IncusConfigTab } from '../incus/IncusConfigTab';
import { IncusDevicesTab } from '../incus/IncusDevicesTab';
import {
  IncusBackupDialog,
  IncusCopyDialog,
  IncusDeleteDialog,
  IncusMoveDialog,
  IncusPublishDialog,
  IncusRenameDialog,
} from '../incus/IncusDialogs';
import { IncusGuestBackups, IncusLogTab, IncusScheduleCard } from '../incus/IncusGuestTabs';
import { SelfChip, SelfLine } from '../incus/SelfGuest';
import { AddToJobDialog } from '../manage/BackupJobs';
import {
  BackupNowDialog,
  CloneDialog,
  DeleteDialog,
  MigrateDialog,
  TemplateDialog,
} from '../manage/GuestDialogs';
import { Badge, ConfirmDialog, ErrorLine, Skeleton, useChangeRunner } from '../parts';
import { useThingSearch } from '../search';
import styles from '../Things.module.css';
import { whenTaskEnds } from '../tasks/taskTracker';
import { UnraidGuestCard } from '../unraid/UnraidGuests';
import wb from '../wb.module.css';
import { type EditCtx, PendingBanner } from './EditDialog';
import { GuestMissing } from './GuestMissing';
import { GuestPower } from './GuestPower';
import { GuestSummary } from './GuestSummary';
import { BackupsTab, CloudInitTab, FirewallTab, SnapshotsTab, TasksTab } from './GuestTabs';
import { HardwareTab } from './HardwareTab';
import { OptionsTab } from './OptionsTab';
import { ReplicationTab } from './ReplicationTab';

export interface GuestPageProps {
  burrow: string;
  serverId: string;
  serverName: string;
  detail: HostServerDetail;
  guestId: string;
  timeZone?: string;
}

type Dialog =
  | 'backup'
  | 'clone'
  | 'template'
  | 'migrate'
  | 'delete'
  | 'job'
  | 'restart'
  | 'rename'
  | 'move'
  | 'publish'
  | null;

/** A Proxmox guest's tabs or an Incus instance's (AP-1563). */
type AnyGuestTab = GuestTab | IncusGuestTab;

/** Tabs that only change a guest: the guest this Whombat runs in doesn't get them (IU-02). */
const CHANGING_TABS: readonly AnyGuestTab[] = ['hardware', 'options', 'cloudinit', 'firewall', 'replication'];

export function GuestPage({ burrow, serverId, serverName, detail, guestId, timeZone }: GuestPageProps) {
  const [search, set] = useThingSearch();
  const [dialog, setDialog] = useState<Dialog>(null);
  const q = useHostGuest({ params: { burrow, serverId, guestId } });
  const g = q.data;
  const manage = !!g?.manageable && (g.platform === 'pve' || g.platform === 'incus');
  const cfgQ = useHostManageRead(
    manage
      ? {
          params: { burrow, serverId },
          query: { op: 'config.get', guestId, platform: g?.platform === 'incus' ? 'incus' : 'pve' },
        }
      : null,
  );
  const config = cfgQ.data?.op === 'config.get' ? cfgQ.data.config : undefined;
  // A deleted guest or a new template leaves the page once its task ends well (not when the page went first).
  const leaving = useRef<(() => void) | null>(null);
  useEffect(() => () => leaving.current?.(), []);
  const leaveWhenDone = (taskId: string | null) => {
    const leave = () => set({ guest: undefined, gtab: undefined, tab: 'guests' });
    if (!taskId) return leave();
    const w = whenTaskEnds(taskId);
    leaving.current = w.cancel;
    void w.promise.then((o) => o.result !== 'error' && leave());
  };
  // A renamed or moved instance has a new id: follow it once its task ends well.
  const followWhenDone = (taskId: string | null, newId?: string) => {
    if (!newId || newId === guestId) return;
    const go = () => set({ guest: newId }, { replace: true });
    if (!taskId) return go();
    const w = whenTaskEnds(taskId);
    leaving.current = w.cancel;
    void w.promise.then((o) => o.result !== 'error' && go());
  };
  const back = (
    <button type="button" className={styles.crumb} onClick={() => set({ guest: undefined, gtab: undefined })}>
      <Icon icon={ChevronLeft} size={15} />
      {serverName}
    </button>
  );
  if (!g)
    return q.error ? (
      <>
        {back}
        <GuestMissing
          burrow={burrow}
          serverName={serverName}
          guestName={detailGuests(detail).find((x) => x.id === guestId)?.name ?? null}
          onRetry={() => void q.refetch()}
        />
      </>
    ) : (
      <>
        {back}
        <Skeleton height={64} />
        <Skeleton height={200} />
      </>
    );
  const cluster = !!detail.proxmox?.cluster;
  const cloudInit = !!config && Object.values(config.values).some((v) => /cloudinit/.test(v));
  const incus = g.platform === 'incus';
  const self = isSelfGuest(g);
  const tabs: AnyGuestTab[] = incus
    ? incusGuestTabs(g.remoteControl, manage)
    : guestTabs(g, g.remoteControl, { manageable: manage, cloudInit, cluster }).filter(
        (t) => !self || !CHANGING_TABS.includes(t),
      );
  const tab: AnyGuestTab = incus
    ? parseIncusGuestTab(search.gtab, tabs as IncusGuestTab[])
    : parseGuestTab(search.gtab, tabs as GuestTab[]);
  const ctx: EditCtx | null = config ? { burrow, serverId, guest: g, config } : null;
  const template = config?.values.template === '1';
  const guests = [
    ...(detail.proxmox?.guests.vm?.guests ?? []),
    ...(detail.proxmox?.guests.container?.guests ?? []),
  ];
  const onFix = (fix: GuestHintView['fix']) => {
    if (fix === 'backup_now') setDialog('backup');
    else if (fix === 'backup_job') setDialog('job');
    else if (fix === 'restart') setDialog('restart');
    else if (fix === 'snapshots' && tabs.includes('snapshots')) set({ gtab: 'snapshots' }, { replace: true });
  };
  const close = () => setDialog(null);
  return (
    <>
      {back}
      <GuestHead
        guest={g}
        serverId={serverId}
        burrow={burrow}
        manage={manage}
        cluster={cluster}
        template={template}
        tags={config ? parseTags(config.values.tags) : (g.tags ?? [])}
        onDialog={setDialog}
      />
      <VerdictLine verdict={machineVerdict(g, detail.hints, Date.parse(detail.asOf))} />
      {self ? <SelfLine /> : null}
      {ctx && g.platform === 'pve' && !self ? (
        <div id="wb-pending" tabIndex={-1} style={{ outline: 'none' }}>
          <PendingBanner ctx={ctx} onRestart={() => setDialog('restart')} />
        </div>
      ) : null}
      <Tabs<AnyGuestTab>
        tabs={tabs.map((key) => ({
          key,
          label: incus ? INCUS_GUEST_TAB_WORDS[key as IncusGuestTab] : guestTabWord(key as GuestTab, g.kind),
        }))}
        value={tab}
        onChange={(next) => set({ gtab: next === 'summary' ? undefined : next }, { replace: true })}
        label={`${g.name} sections`}
        idPrefix="guest-tab"
        panelId="guest-panel"
        className={styles.tabs}
      />
      <div
        id="guest-panel"
        role="tabpanel"
        aria-labelledby={`guest-tab-${tab}`}
        style={{ display: 'contents' }}
      >
        {tab === 'summary' ? (
          <>
            {g.platform === 'docker' || g.platform === 'libvirt' ? (
              <UnraidGuestCard burrow={burrow} detail={detail} guest={g} onUnraid={isUnraidServer(detail)} />
            ) : null}
            <GuestSummary
              burrow={burrow}
              serverId={serverId}
              guest={g}
              detail={detail}
              ctx={ctx}
              timeZone={timeZone}
              onFix={onFix}
            />
            {/* Its kind and number, cores, memory and address: the page's one Technical details fold. */}
            <TechnicalDetails rows={guestFacts(g)} />
          </>
        ) : tab === 'snapshots' ? (
          <>
            {incus ? <IncusScheduleCard ctx={ctx} guest={g} /> : null}
            <SnapshotsTab burrow={burrow} serverId={serverId} guest={g} timeZone={timeZone} />
          </>
        ) : tab === 'backups' && incus ? (
          <IncusGuestBackups
            burrow={burrow}
            serverId={serverId}
            guest={g}
            timeZone={timeZone}
            onStarted={followWhenDone}
          />
        ) : tab === 'log' ? (
          <IncusLogTab burrow={burrow} serverId={serverId} guest={g} />
        ) : tab === 'backups' ? (
          <BackupsTab burrow={burrow} serverId={serverId} guest={g} guests={guests} timeZone={timeZone} />
        ) : tab === 'firewall' ? (
          <FirewallTab burrow={burrow} serverId={serverId} guest={g} />
        ) : tab === 'tasks' ? (
          <TasksTab burrow={burrow} serverId={serverId} guest={g} timeZone={timeZone} />
        ) : !ctx ? (
          cfgQ.error ? (
            <ErrorLine error={cfgQ.error} onRetry={() => void cfgQ.refetch()} />
          ) : (
            <Skeleton height={200} />
          )
        ) : tab === 'config' ? (
          <IncusConfigTab ctx={ctx} guest={g} />
        ) : tab === 'devices' ? (
          <IncusDevicesTab ctx={ctx} guest={g} detail={detail} />
        ) : tab === 'hardware' ? (
          <HardwareTab ctx={ctx} guest={g} />
        ) : tab === 'options' ? (
          <OptionsTab ctx={ctx} guest={g} />
        ) : tab === 'cloudinit' ? (
          <CloudInitTab ctx={ctx} />
        ) : (
          <ReplicationTab ctx={ctx} guest={g} timeZone={timeZone} />
        )}
      </div>
      {dialog === 'backup' && !incus ? (
        <BackupNowDialog burrow={burrow} serverId={serverId} guest={g} onClose={close} />
      ) : null}
      {dialog === 'clone' && !incus ? (
        <CloneDialog burrow={burrow} serverId={serverId} guest={g} template={template} onClose={close} />
      ) : null}
      {incus && dialog === 'backup' ? (
        <IncusBackupDialog burrow={burrow} serverId={serverId} guest={g} onClose={close} />
      ) : null}
      {incus && dialog === 'clone' ? (
        <IncusCopyDialog burrow={burrow} serverId={serverId} guest={g} onClose={close} />
      ) : null}
      {incus && dialog === 'rename' ? (
        <IncusRenameDialog
          burrow={burrow}
          serverId={serverId}
          guest={g}
          onClose={close}
          onStarted={followWhenDone}
        />
      ) : null}
      {incus && dialog === 'move' ? (
        <IncusMoveDialog
          burrow={burrow}
          serverId={serverId}
          guest={g}
          pool={config?.disks?.find((d) => d.path === '/')?.storage}
          onClose={close}
          onStarted={followWhenDone}
        />
      ) : null}
      {incus && dialog === 'publish' ? (
        <IncusPublishDialog burrow={burrow} serverId={serverId} guest={g} onClose={close} />
      ) : null}
      {incus && dialog === 'delete' ? (
        <IncusDeleteDialog
          burrow={burrow}
          serverId={serverId}
          guest={g}
          protectedOn={/^(true|yes|on|1)$/i.test(config?.values['security.protection.delete'] ?? '')}
          onClose={close}
          onStarted={leaveWhenDone}
        />
      ) : null}
      {dialog === 'template' ? (
        <TemplateDialog
          burrow={burrow}
          serverId={serverId}
          guest={g}
          onClose={close}
          onStarted={leaveWhenDone}
        />
      ) : null}
      {dialog === 'migrate' ? (
        <MigrateDialog burrow={burrow} serverId={serverId} guest={g} onClose={close} />
      ) : null}
      {dialog === 'delete' && !incus ? (
        <DeleteDialog
          burrow={burrow}
          serverId={serverId}
          guest={g}
          protectedOn={config?.values.protection === '1'}
          onClose={close}
          onStarted={leaveWhenDone}
        />
      ) : null}
      {dialog === 'job' ? (
        <AddToJobDialog burrow={burrow} serverId={serverId} guest={g} guests={guests} onClose={close} />
      ) : null}
      {dialog === 'restart' ? (
        <RestartConfirm burrow={burrow} serverId={serverId} guest={g} onClose={close} />
      ) : null}
    </>
  );
}

function GuestHead({
  burrow,
  serverId,
  guest: g,
  manage,
  cluster,
  template,
  tags,
  onDialog,
}: {
  burrow: string;
  serverId: string;
  guest: HostGuestDetail;
  manage: boolean;
  cluster: boolean;
  template: boolean;
  tags: readonly string[];
  onDialog: (d: Dialog) => void;
}) {
  const [, set] = useThingSearch();
  const menu = useRowMenu();
  const rc = g.remoteControl;
  const con = rc.console !== false && g.console.available && (g.console.protocols?.length ?? 0) > 0;
  const pve = g.platform === 'pve';
  const incus = g.platform === 'incus';
  const self = isSelfGuest(g);
  const stopped = g.state === 'stopped';
  const stopFirst = stopped ? {} : { description: 'Stop it first' };
  // An Incus instance's More (AP-1569): back up, copy, rename, move, make an image, delete; the guest this Whombat runs
  // in keeps only what doesn't change it (IU-02).
  const incusItems: ContextMenuItem[] = [
    { label: 'Back up now…', onSelect: () => onDialog('backup') },
    { label: 'Copy…', onSelect: () => onDialog('clone') },
    ...(selfAllowsOp(g, 'guest.rename')
      ? [
          { label: 'Rename…', ...stopFirst, onSelect: () => onDialog('rename') },
          { label: 'Move…', ...stopFirst, onSelect: () => onDialog('move') },
          { label: 'Make an image…', onSelect: () => onDialog('publish') },
        ]
      : []),
    ...(selfAllowsOp(g, 'guest.delete')
      ? [{ label: 'Delete…', danger: true, separated: true, onSelect: () => onDialog('delete') }]
      : []),
  ];
  const pveItems: ContextMenuItem[] = [
    { label: 'Back up now…', onSelect: () => onDialog('backup') },
    { label: 'Clone…', onSelect: () => onDialog('clone') },
    ...(template
      ? []
      : [
          {
            label: 'Convert to template…',
            ...(stopped ? {} : { description: 'Shut it down first' }),
            onSelect: () => onDialog('template'),
          },
        ]),
    ...(cluster && !template
      ? [{ label: 'Move to another server…', onSelect: () => onDialog('migrate') }]
      : []),
    { label: 'Delete…', danger: true, separated: true, onSelect: () => onDialog('delete') },
  ].filter((i) => !self || i.label === 'Back up now…' || i.label === 'Clone…');
  // Ask, Power, then ⋯: the console (a shell for a container) is the menu's first line, as a server's shell is.
  const consoleItem: ContextMenuItem[] = con
    ? [
        {
          label: g.kind === 'vm' ? 'Open the console' : 'Open a shell',
          onSelect: () => set({ console: g.id }),
        },
      ]
    : [];
  const manageItems = manage && (pve || incus) ? (incus ? incusItems : pveItems) : [];
  const items: ContextMenuItem[] = [
    ...consoleItem,
    ...manageItems.map((it, i) => (i === 0 && consoleItem.length ? { ...it, separated: true } : it)),
  ];
  return (
    <div className={styles.head}>
      <h1 className={styles.title}>{g.name}</h1>
      <SelfChip guest={g} head />
      {template ? (
        <Badge tone="mut">Template</Badge>
      ) : (
        <Badge tone={guestStateTone(g.state)} dot>
          {GUEST_STATE_WORDS[g.state]}
        </Badge>
      )}
      {(cluster || (g.node && g.node !== serverId)) && g.node ? (
        <span className={wb.wbChip}>node {g.node}</span>
      ) : null}
      {tags.length ? (
        <ul className={wb.wbChips} aria-label="Tags" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {tags.map((t) => (
            <li key={t} className={styles.gtag} style={{ marginRight: 0 }}>
              {t}
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.actions}>
        <AskButton burrow={burrow} />
        {template || self ? null : (
          <GuestPower
            burrow={burrow}
            serverId={serverId}
            guest={g}
            allowed={rc.power !== false}
            reason={rc.powerReason}
          />
        )}
        {items.length ? (
          <button
            type="button"
            className={styles.iconBtn}
            style={{ width: 38, height: 38, borderRadius: 'var(--radius-button)' }}
            aria-label={`More for ${g.name}`}
            aria-haspopup="menu"
            onClick={(e) => menu.openFrom(e.currentTarget, 'guest-more', `More for ${g.name}`, items, 'end')}
          >
            <Icon icon={Ellipsis} size={16} />
          </button>
        ) : null}
      </div>
      {menu.element}
    </div>
  );
}

/** What a machine's head used to list, for its Technical details: its kind and number, cores, memory, uptime, address. */
function guestFacts(g: HostGuestDetail): { label: string; value: string; mono?: boolean }[] {
  const on = g.state === 'running' || g.state === 'unhealthy';
  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: 'Kind', value: guestKindText(g) },
  ];
  if (g.vcpu) rows.push({ label: 'Processor', value: `${g.vcpu} ${g.vcpu === 1 ? 'core' : 'cores'}` });
  if (g.memoryLimitMb)
    rows.push({
      label: 'Memory',
      value: formatMemPair(on ? g.memoryUsedMb : null, g.memoryLimitMb).replace(/^— \/ /, ''),
    });
  if (on && g.uptimeS != null) rows.push({ label: 'Up', value: formatDuration(g.uptimeS, currentLocale()) });
  if (g.addresses?.length) rows.push({ label: 'Address', value: g.addresses.join(', ') || DASH, mono: true });
  return rows;
}

/** Restart now, asked first as every restart is (changes waiting for it, or a hint's Restart to apply). */
function RestartConfirm({
  burrow,
  serverId,
  guest,
  onClose,
}: {
  burrow: string;
  serverId: string;
  guest: HostGuestDetail;
  onClose: () => void;
}) {
  const change = useHostsChange(api.hosts.guestAction);
  const { run, busy } = useChangeRunner();
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmDialog
      open
      title={`Restart ${guest.name} now?`}
      body="It’s down for a moment while it restarts, then runs with the new settings."
      confirm="Restart now"
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={() =>
        void (async () => {
          const out = await run(
            () =>
              change.mutateAsync({
                params: { burrow, serverId, guestId: guest.id },
                body: { action: 'reboot', confirm: true },
              }),
            `Restarting ${guest.name}.`,
            { inline: true },
          );
          if (out.ok || !out.error) onClose();
          else setError(out.message);
        })()
      }
    />
  );
}
