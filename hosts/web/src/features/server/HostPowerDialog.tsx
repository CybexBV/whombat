// Reboot or shut down the host itself (admins, with host power switched on
// in the hub and in the agent's configuration). The host name is typed to
// confirm; the hub asks for a recent sign-in; the outcome is a toast.

import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { HOST_GUEST_ID } from '../../api/client';
import type { HostAction } from '../../api/types';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { t, tx } from '../../lib/i18n';
import { refreshAfterAction, runPowerAction } from '../console/powerActions';

const TEXT: Record<HostAction, { ask: (id: string) => string; failed: (id: string, error: string) => string; verb: string; explain: string }> = {
  host_reboot: {
    ask: (id) => t('Reboot {name}?', { name: id }),
    failed: (id, error) => t('Reboot {id} failed: {error}', { id, error }),
    verb: t('Reboot host'),
    explain: t('Every guest on it stops while it restarts, and consoles close. The agent reports again once the host is up.'),
  },
  host_shutdown: {
    ask: (id) => t('Shut down {name}?', { name: id }),
    failed: (id, error) => t('Shut down {id} failed: {error}', { id, error }),
    verb: t('Shut down host'),
    explain: t('Every guest on it stops. Powering it on again needs the power button, IPMI or Wake-on-LAN.'),
  },
};

/** Start a host power action; resolves when the agent answered (the host goes down a few seconds later). */
export function runHostAction(qc: ReturnType<typeof useQueryClient>, serverId: string, action: HostAction): void {
  void runPowerAction(serverId, HOST_GUEST_ID, action, { onDone: () => refreshAfterAction(qc, serverId, HOST_GUEST_ID) }).then((r) => {
    if (!r) return;
    if (r.ok) toast(`${serverId}: ${r.message.replace(/\.?$/, '.')}`, 'success', 10_000);
    else toast(TEXT[action].failed(serverId, r.message), 'error');
  });
}

export function HostPowerDialog({ serverId, action, onClose }: { serverId: string; action: HostAction | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const inputId = useId();
  if (!action) return null;
  const txt = TEXT[action];
  const ready = typed.trim() === serverId;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    setTyped('');
    onClose();
    runHostAction(qc, serverId, action);
  };
  return (
    <Modal
      open
      onClose={() => {
        setTyped('');
        onClose();
      }}
      tone="serious"
      title={txt.ask(serverId)}
      description={txt.explain}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form={`${inputId}-form`} className="btn-primary btn-sm is-serious" aria-disabled={!ready || undefined}>
            {txt.verb}
          </button>
        </>
      }
    >
      <form id={`${inputId}-form`} className="field" onSubmit={submit}>
        <label className="field-label" htmlFor={inputId}>
          {tx('Type {id} to confirm', { id: <span className="mono">{serverId}</span> })}
        </label>
        <input id={inputId} className="input mono" autoFocus autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
      </form>
    </Modal>
  );
}
