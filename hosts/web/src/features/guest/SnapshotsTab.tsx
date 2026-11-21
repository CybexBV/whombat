// Snapshots of the guest (Proxmox, Incus, libvirt; needs the power
// permission like the row menu's dialog): create, roll back and delete
// inline, with the dialog's list and confirmations (SnapshotsDialog.tsx).

import { t, tn } from '../../lib/i18n';
import { useSnapshotsPanel } from '../guests/SnapshotsDialog';
import type { GuestTabProps } from './GuestPage';

export function SnapshotsTab({ serverId, guest }: GuestTabProps) {
  const p = useSnapshotsPanel(serverId, guest);
  return (
    <section className="card list-card" aria-labelledby="guest-snapshots">
      <div className="list-card-head">
        <h2 className="h2" id="guest-snapshots">
          {t('Snapshots')}
        </h2>
        {p.count != null && <span className="lbl">{tn(p.count, '{n} snapshot', '{n} snapshots')}</span>}
      </div>
      {p.form}
      {p.list}
      {p.confirmDialog}
    </section>
  );
}
