// The ⋯ menu of a guest row (host page and Guests page): History (every
// role), power actions without opening the console, and Snapshots…. Only
// what the user may do is listed (power permission from the API);
// destructive actions confirm first. The outcome arrives as a toast and
// the lists refresh. The guest page's header shares the power items.

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Guest, PowerAction, RemoteControl } from '../../api/types';
import { Menu, type MenuItem } from '../../components/Menu';
import { toast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import { PowerConfirmDialog } from '../console/ConsoleDialogs';
import { ACTIONS, type ActionSpec, actionText } from '../console/labels';
import { type ActionResult, refreshAfterAction, runPowerAction, useActionState } from '../console/powerActions';
import { guestPowerActions, hasSnapshots, needsConfirm } from './guestActions';
import { GuestHistoryDialog } from './GuestHistory';
import { SnapshotsDialog } from './SnapshotsDialog';

/** Toast for an action's outcome ("web-01: stopped.", "Stop web-01 failed: …"). */
export function toastResult(name: string, r: ActionResult | null): void {
  if (!r) return;
  const a = actionText(r.action);
  if (r.ok) toast(t('{name}: {done}.', { name, done: a.done.toLowerCase() }), 'success');
  else if (r.code === 'timeout') toast(`${name}: ${r.message}`, 'info');
  else toast(t('{action} {name} failed: {error}', { action: a.label, name, error: r.message }), 'error');
}

interface Props {
  serverId: string;
  guest: Pick<Guest, 'id' | 'name' | 'platform' | 'kind' | 'state'>;
  /** The user's permissions on the guest's server (missing: none). */
  rc: RemoteControl | undefined;
  /** Name the server in the accessible name ("Actions for web-01 on basalt"). */
  withServer?: boolean;
}

/**
 * The power items of a guest's menus (row menu, guest page header) and the
 * confirmation they open: only what the user may do and the guest's state
 * allows; disabled while an action runs.
 */
export function useGuestPower(serverId: string, guest: Props['guest'], rc: RemoteControl | undefined, onDone?: () => void) {
  const qc = useQueryClient();
  const state = useActionState(serverId, guest.id);
  const [confirm, setConfirm] = useState<ActionSpec | null>(null);
  const run = (action: PowerAction) =>
    void runPowerAction(serverId, guest.id, action, {
      onDone: () => {
        refreshAfterAction(qc, serverId, guest.id);
        onDone?.();
      },
    }).then((r) => toastResult(guest.name, r));
  const busy = state.pending ? t('{action} is in progress', { action: actionText(state.pending.action).pending.replace('…', '') }) : undefined;
  const items: MenuItem[] = (rc?.power ? guestPowerActions(guest) : []).map((a) => {
    const spec = ACTIONS[a];
    return {
      label: needsConfirm(a) ? `${spec.verb}…` : spec.verb,
      icon: spec.icon,
      danger: spec.serious,
      disabled: !!busy,
      title: busy,
      onSelect: () => (needsConfirm(a) ? setConfirm(spec) : run(a)),
    };
  });
  const dialog = (
    <PowerConfirmDialog
      spec={confirm}
      guestName={guest.name}
      onCancel={() => setConfirm(null)}
      onConfirm={() => {
        const spec = confirm;
        setConfirm(null);
        if (spec) run(spec.action);
      }}
    />
  );
  return { items, dialog, pending: state.pending };
}

export function GuestMenu({ serverId, guest, rc, withServer = false }: Props) {
  const power = useGuestPower(serverId, guest, rc);
  const [snapshots, setSnapshots] = useState(false);
  const [history, setHistory] = useState(false);

  const items: MenuItem[] = [{ label: t('History'), icon: 'chart', onSelect: () => setHistory(true) }, ...power.items];
  if (rc?.power && hasSnapshots(guest)) items.push({ label: t('Snapshots…'), icon: 'clock', onSelect: () => setSnapshots(true) });

  return (
    <>
      <Menu label={withServer ? t('Actions for {name} on {server}', { name: guest.name, server: serverId }) : t('Actions for {name}', { name: guest.name })} items={items} buttonClassName="btn-ghost btn-icon row-action" floating>
        {power.pending ? <span className="spinner spinner-sm" aria-hidden="true" /> : undefined}
      </Menu>
      {power.dialog}
      {snapshots && <SnapshotsDialog serverId={serverId} guest={guest} onClose={() => setSnapshots(false)} />}
      {history && <GuestHistoryDialog serverId={serverId} guest={guest} onClose={() => setHistory(false)} />}
    </>
  );
}
