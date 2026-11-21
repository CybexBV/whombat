// The selection bar of the guest tables (docs/MANAGE.md, Bulk actions):
// "N selected: Start · Shut down · Reboot · Stop… · Clear". Disruptive
// commands are confirmed with the guests' names; actions run through the
// power action runner, three at a time, and end in one summary toast.

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { t, tn } from '../../lib/i18n';
import { refreshAfterAction, runPowerAction } from '../console/powerActions';
import { BULK_KINDS, type BulkGuest, type BulkKind, type BulkPlan, bulkConfirms, bulkPlan, runLimited } from './bulk';

const SHOWN = 12;

const SPEC: Record<BulkKind, { label: string; icon: IconName; none: string }> = {
  start: { label: t('Start'), icon: 'play', none: t('None of the selected guests is stopped') },
  shutdown: { label: t('Shut down'), icon: 'power', none: t('None of the selected guests is running') },
  reboot: { label: t('Reboot'), icon: 'refresh', none: t('None of the selected guests is running') },
  stop: { label: t('Stop…'), icon: 'square', none: t('None of the selected guests is running') },
};

function confirmTitle(kind: BulkKind, n: number): string {
  if (kind === 'shutdown') return tn(n, 'Shut down {n} guest?', 'Shut down {n} guests?');
  if (kind === 'reboot') return tn(n, 'Reboot {n} guest?', 'Reboot {n} guests?');
  return tn(n, 'Stop {n} guest?', 'Stop {n} guests?');
}

function confirmText(kind: BulkKind): string {
  if (kind === 'shutdown') return t('VMs get a shutdown request, containers stop. Open consoles close.');
  if (kind === 'reboot') return t('Each guest restarts its operating system; running programs stop and users are disconnected.');
  return t('Each guest is powered off at once, like pulling the plug: unsaved data is lost.');
}

function doneText(kind: BulkKind, n: number): string {
  if (kind === 'start') return tn(n, 'Started {n} guest.', 'Started {n} guests.');
  if (kind === 'shutdown') return tn(n, 'Shut down {n} guest.', 'Shut down {n} guests.');
  if (kind === 'reboot') return tn(n, 'Rebooted {n} guest.', 'Rebooted {n} guests.');
  return tn(n, 'Stopped {n} guest.', 'Stopped {n} guests.');
}

interface Props {
  items: BulkGuest[];
  /** Name the host next to each guest (the fleet-wide list). */
  withServer?: boolean;
  onClear: () => void;
}

export function BulkBar({ items, withServer = false, onClear }: Props) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<{ kind: BulkKind; plan: BulkPlan } | null>(null);
  const label = (x: BulkGuest) => (withServer ? `${x.guest.name} · ${x.server}` : x.guest.name);

  const run = async (kind: BulkKind, plan: BulkPlan) => {
    setConfirm(null);
    onClear();
    const failed: string[] = [];
    let ok = 0;
    await runLimited(plan.run, 3, async ({ item, action }) => {
      const r = await runPowerAction(item.server, item.guest.id, action, { onDone: () => refreshAfterAction(qc, item.server, item.guest.id) });
      if (r?.ok) ok++;
      else failed.push(`${label(item)} (${r ? r.message : t('another action is still running')})`);
    });
    if (!failed.length) toast(doneText(kind, ok), 'success');
    else toast(t('{action}: {ok} of {n} done. Failed: {list}', { action: SPEC[kind].label.replace('…', ''), ok, n: plan.run.length, list: failed.join(', ') }), 'error', 12_000);
  };

  const choose = (kind: BulkKind) => {
    const plan = bulkPlan(kind, items);
    if (!plan.run.length) return;
    if (bulkConfirms(kind)) setConfirm({ kind, plan });
    else void run(kind, plan);
  };

  if (!items.length && !confirm) return null;
  return (
    <>
      {items.length > 0 && (
        <div className="bulk-bar" role="group" aria-label={t('Selected guests')}>
          <span className="strong" aria-live="polite">
            {tn(items.length, '{n} selected', '{n} selected')}
          </span>
          {BULK_KINDS.map((k) => {
            const n = bulkPlan(k, items).run.length;
            return (
              <button
                key={k}
                type="button"
                className={`btn-ghost row-action${k === 'stop' ? ' is-serious' : ''}`}
                aria-disabled={n === 0 || undefined}
                title={n === 0 ? SPEC[k].none : n < items.length ? tn(n, '{n} of the selected guests', '{n} of the selected guests') : undefined}
                onClick={() => choose(k)}
              >
                <Icon name={SPEC[k].icon} size={14} />
                {SPEC[k].label}
              </button>
            );
          })}
          <button type="button" className="btn-text" onClick={onClear}>
            {t('Clear')}
          </button>
        </div>
      )}
      {confirm && (
        <Modal
          open
          onClose={() => setConfirm(null)}
          tone={confirm.kind === 'stop' ? 'serious' : 'default'}
          title={confirmTitle(confirm.kind, confirm.plan.run.length)}
          description={confirmText(confirm.kind)}
          actions={
            <>
              <button type="button" className="btn-ghost" autoFocus onClick={() => setConfirm(null)}>
                {t('Cancel')}
              </button>
              <button type="button" className={`btn-primary btn-sm${confirm.kind === 'stop' ? ' is-serious' : ''}`} onClick={() => void run(confirm.kind, confirm.plan)}>
                {confirmTitle(confirm.kind, confirm.plan.run.length).replace(/\?$/, '')}
              </button>
            </>
          }
        >
          <ul className="lc-names" aria-label={t('Guests')}>
            {confirm.plan.run.slice(0, SHOWN).map(({ item }) => (
              <li key={`${item.server}/${item.guest.id}`} className="mono">
                {label(item)}
              </li>
            ))}
            {confirm.plan.run.length > SHOWN && <li className="lbl">{t('and {n} more', { n: confirm.plan.run.length - SHOWN })}</li>}
          </ul>
          {confirm.plan.skipped.length > 0 && <p className="lbl">{tn(confirm.plan.skipped.length, '{n} selected guest is skipped: this does not apply to it.', '{n} selected guests are skipped: this does not apply to them.')}</p>}
        </Modal>
      )}
    </>
  );
}
