// The guest page's lifecycle actions (docs/MANAGE.md, Header): Clone…,
// Back up now…, Convert to template…, Delete… — each only for the users and
// guests it applies to (Manage on; admins for all but backups). A deleted
// guest or a new template leaves the page for the host's guest list when
// its task ends.

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { ManagePlatform } from '../../api/manage';
import { Menu, type MenuItem } from '../../components/Menu';
import { t } from '../../lib/i18n';
import { guestTab, hostPath } from '../../lib/urlState';
import { BackupNowDialog } from '../manage/BackupDialogs';
import { CloneDialog, ConvertTemplateDialog, DeleteGuestDialog, type GuestRef } from '../manage/LifecycleDialogs';
import type { GuestTabProps } from './GuestPage';
import { managed } from './tabs';
import { whenTaskFinished } from './taskEvents';

type Dialog = 'clone' | 'backup' | 'template' | 'delete' | null;

export function GuestLifecycleMenu({ serverId, guest, rc, isAdmin }: GuestTabProps) {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), []);
  if (!rc?.manage || !managed(guest)) return null;
  const platform = guest.platform as ManagePlatform;
  const pve = platform === 'pve';
  const ref: GuestRef = { id: guest.id, name: guest.name, kind: guest.kind, state: guest.state, platform, vmid: guest.vmid };
  const stopped = guest.state === 'stopped';

  /** When the task ends well and the page is still open, go to the host's guest list. */
  const leaveWhenDone = (taskId: string | null) => {
    const back = () => navigate(hostPath(serverId, { tab: 'guests', platform: guestTab(guest.platform, guest.kind) }));
    if (!taskId) return back();
    const w = whenTaskFinished(taskId);
    cancel.current = w.cancel;
    void w.promise.then((o) => o.result !== 'error' && back());
  };

  const items: MenuItem[] = [
    isAdmin && { label: t('Clone…'), icon: 'copy', onSelect: () => setDialog('clone') },
    pve && { label: t('Back up now…'), icon: 'download', onSelect: () => setDialog('backup') },
    isAdmin &&
      pve && {
        label: t('Convert to template…'),
        icon: 'layers',
        disabled: !stopped,
        title: stopped ? undefined : t('Shut the guest down first'),
        onSelect: () => setDialog('template'),
      },
    isAdmin && { label: t('Delete…'), icon: 'trash', danger: true, onSelect: () => setDialog('delete') },
  ].filter(Boolean) as MenuItem[];
  if (!items.length) return null;

  return (
    <>
      <Menu label={t('More actions for {name}', { name: guest.name })} items={items} />
      {dialog === 'clone' && <CloneDialog serverId={serverId} guest={ref} onClose={() => setDialog(null)} />}
      {dialog === 'backup' && <BackupNowDialog serverId={serverId} guest={ref} onClose={() => setDialog(null)} />}
      {dialog === 'template' && <ConvertTemplateDialog serverId={serverId} guest={ref} onClose={() => setDialog(null)} onStarted={leaveWhenDone} />}
      {dialog === 'delete' && <DeleteGuestDialog serverId={serverId} guest={ref} onClose={() => setDialog(null)} onStarted={leaveWhenDone} />}
    </>
  );
}
