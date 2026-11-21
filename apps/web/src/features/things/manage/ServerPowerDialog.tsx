/**
 * The question before a server's own restart or shutdown (ONE-12, IU-02): its guests stop, and on the server that runs
 * this Whombat it goes down too. Asked from the head's Power menu and the System tab's Restart now (Whombat
 * server-updates.md SWU-10; server-updates-app.md AP-2866).
 */
import { useQueryClient } from '@tanstack/react-query';
import { hostPowerBody } from '@whombat/client/hosts';
import { useHostsChange } from '@whombat/client/hosts/react';
import { api } from '@whombat/core/contracts';
import { useState } from 'react';
import { ConfirmDialog, useChangeRunner } from '../parts';

export type ServerPowerAction = 'host_reboot' | 'host_shutdown';

export function ServerPowerDialog({
  burrow,
  serverId,
  name,
  action,
  thisWhombat = false,
  onClose,
}: {
  burrow: string;
  serverId: string;
  name: string;
  /** The action asked about; null: closed. */
  action: ServerPowerAction | null;
  /** This Whombat runs on it: the question says it goes down too (IU-02). */
  thisWhombat?: boolean;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const change = useHostsChange(api.hosts.serverAction);
  const { run, busy } = useChangeRunner();
  const qc = useQueryClient();
  const close = () => {
    setError(null);
    onClose();
  };
  const confirm = async () => {
    if (!action) return;
    setError(null);
    const out = await run(
      () => change.mutateAsync({ params: { burrow, serverId }, body: { action, confirm: true } }),
      action === 'host_reboot' ? `Restarting ${name}.` : `Shutting ${name} down.`,
      { inline: true },
    );
    if (out.ok) {
      close();
      void qc.invalidateQueries();
    } else if (out.error) setError(out.message);
    else close();
  };
  return (
    <ConfirmDialog
      open={action !== null}
      title={action === 'host_shutdown' ? `Shut ${name} down?` : `Restart ${name}?`}
      body={hostPowerBody(action ?? 'host_reboot', thisWhombat)}
      confirm={action === 'host_shutdown' ? 'Shut down' : 'Restart'}
      serious
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onClose={close}
    />
  );
}
