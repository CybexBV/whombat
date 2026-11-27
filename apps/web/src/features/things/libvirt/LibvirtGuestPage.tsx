/**
 * A libvirt VM's page (Whombat incus-unraid.md IU-13; AP-1649): on a QEMU/KVM server, an Unraid server or any host that
 * runs libvirt — the server it's on decides only where locked settings are changed. Back to the server, the name with
 * its state (and “This Whombat” for the guest this Whombat runs in, IU-02), Console, Power and More (Back up now…,
 * Clone…, Rename…, Delete… — a deleted VM leaves the page when its task ends, a renamed one opens under its new name),
 * the fact line, the changes waiting for its next start, and the tabs Summary · Hardware · Options · Snapshots ·
 * Backups · Tasks · Log (`?gtab=`). The Proxmox page's pieces (`guest/`) do the drawing.
 */
import {
  DASH,
  formatDuration,
  formatMemPair,
  GUEST_STATE_WORDS,
  guestKindText,
  guestStateTone,
  isSelfGuest,
  LIBVIRT_GUEST_TAB_WORDS,
  type LibvirtGuestTab,
  libvirtGuestTabs,
  libvirtLockPlace,
  lvFileName,
  machineVerdict,
  mibText,
  parseLibvirtGuestTab,
  pendingKeys,
  plural,
  readLvDisk,
  selfAllowsOp,
  shownValue,
  snapshotBlocker,
} from '@whombat/client/hosts';
import { useHostGuest, useHostManageRead, useHostsChange } from '@whombat/client/hosts/react';
import { api } from '@whombat/core/contracts';
import type { HostGuestDetail, HostServerDetail } from '@whombat/core/domain';
import { ChevronLeft, Clock, Ellipsis, Info, SquareTerminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type ContextMenuItem, useRowMenu } from '../../../app/shell/ContextMenu';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { Tabs } from '../../../components/Tabs';
import { useWebI18n } from '../../../i18n/provider';
import { AskButton } from '../AskPane';
import { VerdictLine } from '../dashboard/Verdict';
import type { EditCtx } from '../guest/EditDialog';
import { GuestMissing } from '../guest/GuestMissing';
import { GuestPower } from '../guest/GuestPower';
import { scrollToId } from '../guest/GuestSummary';
import { SnapshotsTab, TasksTab } from '../guest/GuestTabs';
import { SelfChip, SelfLine } from '../incus/SelfGuest';
import { Badge, ConfirmDialog, ErrorLine, Skeleton, useChangeRunner } from '../parts';
import { useThingSearch } from '../search';
import styles from '../Things.module.css';
import { whenTaskEnds } from '../tasks/taskTracker';
import wb from '../wb.module.css';
import wq from './Libvirt.module.css';
import { LvGuestBackups, libvirtGuests } from './LibvirtBackups';
import { LvBackupNowDialog, LvCloneDialog, LvDeleteDialog, LvRenameDialog } from './LibvirtDialogs';
import { LibvirtHardwareTab } from './LibvirtHardwareTab';
import { LibvirtLog } from './LibvirtLog';
import { LibvirtOptionsTab } from './LibvirtOptionsTab';
import { LibvirtSummary } from './LibvirtSummary';
import { useLibvirtAccess, useLibvirtManage } from './useLibvirt';

export interface LibvirtGuestPageProps {
  burrow: string;
  serverId: string;
  serverName: string;
  detail: HostServerDetail;
  guestId: string;
  timeZone?: string;
}

type Dialog = 'backup' | 'clone' | 'rename' | 'delete' | 'shutdown' | null;

export function LibvirtGuestPage({
  burrow,
  serverId,
  serverName,
  detail,
  guestId,
  timeZone,
}: LibvirtGuestPageProps) {
  const [search, set] = useThingSearch();
  const [dialog, setDialog] = useState<Dialog>(null);
  const q = useHostGuest({ params: { burrow, serverId, guestId } });
  const g = q.data;
  const access = useLibvirtAccess(burrow, detail);
  // Manage on both sides (the guest says).
  const manage = !!g?.manageable;
  const cfgQ = useHostManageRead(
    manage
      ? { params: { burrow, serverId }, query: { op: 'config.get', guestId, platform: 'libvirt' } }
      : null,
  );
  const config = cfgQ.data?.op === 'config.get' ? cfgQ.data.config : undefined;
  const leaving = useRef<(() => void) | null>(null);
  useEffect(() => () => leaving.current?.(), []);
  const leaveWhenDone = (taskId: string | null) => {
    const leave = () => set({ guest: undefined, gtab: undefined, tab: 'guests' });
    if (!taskId) return leave();
    const w = whenTaskEnds(taskId);
    leaving.current = w.cancel;
    void w.promise.then((o) => o.result !== 'error' && leave());
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
          guestName={libvirtGuests(detail).find((x) => x.id === guestId)?.name ?? null}
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
  const self = isSelfGuest(g);
  // The guest this Whombat runs in keeps only what doesn't change it (IU-02): no Hardware or Options.
  const tabs = libvirtGuestTabs(g.remoteControl, { manage }).filter(
    (t) => !self || (t !== 'hardware' && t !== 'options'),
  );
  const tab = parseLibvirtGuestTab(search.gtab, tabs);
  const ctx: EditCtx | null = config ? { burrow, serverId, guest: g, config } : null;
  const lockPlace = libvirtLockPlace(detail.server.platform);
  const canChange = manage && access.can;
  const taken = libvirtGuests(detail).map((x) => x.name);
  const reason = !g.manageable
    ? (g.remoteControl.manageReason ?? 'Changing guests is switched off for this server.')
    : null;
  const close = () => setDialog(null);
  const tabProps = { burrow, serverId, guest: g, timeZone };
  const blocker = config ? snapshotBlocker(config) : null;
  return (
    <>
      {back}
      <Head guest={g} serverId={serverId} burrow={burrow} manage={canChange} onDialog={setDialog} />
      <VerdictLine verdict={machineVerdict(g, detail.hints, Date.parse(detail.asOf))} />
      <Facts guest={g} />
      {self ? <SelfLine /> : null}
      {ctx && !self ? (
        <div id="wq-pending" tabIndex={-1} style={{ outline: 'none' }}>
          <PendingBanner ctx={ctx} canChange={canChange} onShutdown={() => setDialog('shutdown')} />
        </div>
      ) : null}
      <Tabs<LibvirtGuestTab>
        tabs={tabs.map((key) => ({ key, label: LIBVIRT_GUEST_TAB_WORDS[key] }))}
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
          <LibvirtSummary
            burrow={burrow}
            serverId={serverId}
            guest={g}
            detail={detail}
            ctx={ctx}
            reason={reason}
            timeZone={timeZone}
            onBackup={canChange ? () => setDialog('backup') : null}
            onPending={() => {
              scrollToId('wq-pending');
              document.getElementById('wq-pending')?.focus({ preventScroll: true });
            }}
          />
        ) : tab === 'snapshots' ? (
          <>
            {blocker ? (
              <p className={wb.wbNote}>
                <Icon icon={Info} size={16} />
                <span>
                  Snapshots need every disk in qcow2: <span className={styles.mono}>{blocker}</span> is raw,
                  so libvirt can’t take one of {g.name}. Back it up instead.
                </span>
              </p>
            ) : null}
            <SnapshotsTab {...tabProps} />
          </>
        ) : tab === 'backups' ? (
          <LvGuestBackups
            burrow={burrow}
            detail={detail}
            guest={g}
            canChange={canChange}
            timeZone={timeZone}
          />
        ) : tab === 'tasks' ? (
          <TasksTab {...tabProps} />
        ) : tab === 'log' ? (
          <LibvirtLog {...tabProps} />
        ) : !ctx ? (
          cfgQ.error ? (
            <ErrorLine error={cfgQ.error} onRetry={() => void cfgQ.refetch()} />
          ) : (
            <Skeleton height={200} />
          )
        ) : tab === 'hardware' ? (
          <LibvirtHardwareTab ctx={ctx} lockPlace={lockPlace} readOnly={self || !canChange} />
        ) : (
          <LibvirtOptionsTab
            ctx={ctx}
            lockPlace={lockPlace}
            readOnly={self || !canChange}
            onRename={() => setDialog('rename')}
          />
        )}
      </div>
      {dialog === 'backup' ? (
        <LvBackupNowDialog
          burrow={burrow}
          serverId={serverId}
          guest={g}
          backupsDir={detail.libvirt?.backupsDir}
          onClose={close}
        />
      ) : null}
      {dialog === 'clone' ? (
        <LvCloneDialog burrow={burrow} serverId={serverId} guest={g} taken={taken} onClose={close} />
      ) : null}
      {dialog === 'rename' ? (
        <LvRenameDialog
          burrow={burrow}
          serverId={serverId}
          guest={g}
          taken={taken}
          onClose={close}
          onRenamed={(id) => set({ guest: id }, { replace: true })}
        />
      ) : null}
      {dialog === 'delete' ? (
        <LvDeleteDialog
          burrow={burrow}
          serverId={serverId}
          guest={g}
          disks={(config?.disks ?? [])
            .filter((d) => d.media !== 'cdrom')
            .map((d) => lvFileName(readLvDisk(config?.values[d.key]).source) || d.key)}
          onClose={close}
          onStarted={leaveWhenDone}
        />
      ) : null}
      {dialog === 'shutdown' ? (
        <ShutdownConfirm burrow={burrow} serverId={serverId} guest={g} onClose={close} />
      ) : null}
    </>
  );
}

function Head({
  burrow,
  serverId,
  guest: g,
  manage,
  onDialog,
}: {
  burrow: string;
  serverId: string;
  guest: HostGuestDetail;
  manage: boolean;
  onDialog: (d: Dialog) => void;
}) {
  const [, set] = useThingSearch();
  const menu = useRowMenu();
  const rc = g.remoteControl;
  const con = rc.console !== false && g.console.available && (g.console.protocols?.length ?? 0) > 0;
  const stopped = g.state === 'stopped';
  const self = isSelfGuest(g);
  const first = 'Shut it down first';
  const items: ContextMenuItem[] = [
    { label: 'Back up now…', onSelect: () => onDialog('backup') },
    { label: 'Clone…', ...(stopped ? {} : { description: first }), onSelect: () => onDialog('clone') },
    ...(selfAllowsOp(g, 'guest.rename')
      ? [{ label: 'Rename…', ...(stopped ? {} : { description: first }), onSelect: () => onDialog('rename') }]
      : []),
    ...(selfAllowsOp(g, 'guest.delete')
      ? [{ label: 'Delete…', danger: true, separated: true, onSelect: () => onDialog('delete') }]
      : []),
  ];
  return (
    <div className={styles.head}>
      <h1 className={styles.title}>{g.name}</h1>
      <SelfChip guest={g} head />
      <Badge tone={guestStateTone(g.state)} dot>
        {GUEST_STATE_WORDS[g.state]}
      </Badge>
      <div className={styles.actions}>
        <AskButton burrow={burrow} />
        {con ? (
          <Button
            className={styles.btn}
            iconStart={<Icon icon={SquareTerminal} size={15} />}
            onClick={() => set({ console: g.id })}
          >
            Console
          </Button>
        ) : null}
        {self ? null : (
          <GuestPower
            burrow={burrow}
            serverId={serverId}
            guest={g}
            allowed={rc.power !== false}
            reason={rc.powerReason}
          />
        )}
        {manage ? (
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

function Facts({ guest: g }: { guest: HostGuestDetail }) {
  const { tag: uiLocale } = useWebI18n();
  const on = g.state === 'running' || g.state === 'unhealthy';
  const parts: { pre: string; strong: string }[] = [{ pre: '', strong: guestKindText(g) }];
  if (g.vcpu) parts.push({ pre: '', strong: plural(g.vcpu, 'vCPU') });
  if (g.memoryLimitMb)
    parts.push({
      pre: 'Memory ',
      // A switched-off VM shows what it gets, not a dash.
      strong: on ? formatMemPair(g.memoryUsedMb, g.memoryLimitMb) : mibText(g.memoryLimitMb),
    });
  if (on && g.uptimeS != null) parts.push({ pre: 'Up ', strong: formatDuration(g.uptimeS, uiLocale) });
  if (g.addresses?.length) parts.push({ pre: '', strong: g.addresses[0] ?? DASH });
  return (
    <div className={styles.facts}>
      {parts.map((p) => (
        <span key={`${p.pre}${p.strong}`}>
          {p.pre}
          <b>{p.strong}</b>
        </span>
      ))}
    </div>
  );
}

/**
 * Changes that wait for the VM's next start (libvirt keeps a running VM as it is until it's started again; a restart
 * from inside isn't enough, AP-1652): each now → then with Revert, and Shut down to get there.
 */
function PendingBanner({
  ctx,
  canChange,
  onShutdown,
}: {
  ctx: EditCtx;
  canChange: boolean;
  onShutdown: () => void;
}) {
  const { send, busy } = useLibvirtManage(ctx.burrow, ctx.serverId);
  const keys = pendingKeys(ctx.config);
  if (!keys.length) return null;
  const revert = (ks: string[]) =>
    void send(
      {
        op: 'config.set',
        guestId: ctx.guest.id,
        params: { revert: ks },
        digest: ctx.config.digest,
        name: ctx.guest.name,
      },
      { inline: false },
    );
  return (
    <section className={cx(styles.notice, styles.noticeWarn)} aria-labelledby="wq-pending-title">
      <span className={cx(styles.noticeIcon, styles.noticeIconWarn)} aria-hidden="true">
        <Icon icon={Clock} size={16} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <b id="wq-pending-title">
          {keys.length === 1
            ? 'A change applies when it next starts'
            : `${keys.length} changes apply when it next starts`}
        </b>
        <p>Shut {ctx.guest.name} down and start it again: a restart from inside isn’t enough.</p>
        <ul className={styles.review} aria-label="Waiting for its next start" style={{ marginTop: 6 }}>
          {keys.map((k) => {
            const removed = !(k in (ctx.config.pending ?? {}));
            return (
              <li key={k} style={{ alignItems: 'center' }}>
                <b>{k}</b>
                <span style={{ flex: 1 }} className={wq.wqPendingValue}>
                  <span className={styles.old}>{shownValue(k, ctx.config.values[k])}</span> →{' '}
                  {removed ? 'removed' : shownValue(k, ctx.config.pending?.[k])}
                </span>
                {canChange ? (
                  <button
                    type="button"
                    className={styles.cardLink}
                    disabled={busy}
                    onClick={() => revert([k])}
                  >
                    Revert <span className={styles.srOnly}>{k}</span>
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {canChange ? (
          <div className={styles.noticeActs}>
            {ctx.config.running ? (
              <Button size="sm" variant="primary" onClick={onShutdown} disabled={busy}>
                Shut down…
              </Button>
            ) : null}
            {keys.length > 1 ? (
              <Button size="sm" onClick={() => revert(keys)} disabled={busy}>
                Revert all
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Shut down to take the waiting changes (asked first, as every shutdown is). */
function ShutdownConfirm({
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
      title={`Shut ${guest.name} down?`}
      body="It closes its programs first. Start it again afterwards and it runs with the new settings."
      confirm="Shut down"
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={() =>
        void (async () => {
          const out = await run(
            () =>
              change.mutateAsync({
                params: { burrow, serverId, guestId: guest.id },
                body: { action: 'shutdown', confirm: true },
              }),
            `Shutting ${guest.name} down.`,
            { inline: true },
          );
          if (out.ok || !out.error) onClose();
          else setError(out.message);
        })()
      }
    />
  );
}
