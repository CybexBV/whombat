// "Create" on a host's Guests tab (admins, Manage on): a virtual machine or
// container on Proxmox VE, an instance on Incus. When the create task ends
// well and the user is still on the page, the new guest opens.

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Icon } from '../../components/Icon';
import { Menu } from '../../components/Menu';
import { t } from '../../lib/i18n';
import { guestPath } from '../../lib/urlState';
import { whenTaskFinished } from '../guest/taskEvents';
import { CreateGuestDialog, type CreateKind } from './CreateGuestDialog';

const LABEL: Record<CreateKind, () => string> = {
  vm: () => t('Virtual machine…'),
  container: () => t('Container…'),
  incus: () => t('Instance…'),
};

export function CreateMenu({ serverId, kinds }: { serverId: string; kinds: CreateKind[] }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState<CreateKind | null>(null);
  const waits = useRef(new Set<() => void>());
  useEffect(() => {
    const w = waits.current;
    return () => {
      for (const cancel of w) cancel();
    };
  }, []);
  if (!kinds.length) return null;

  const onStarted = (taskId: string | null, newId: string | undefined) => {
    if (!newId) return;
    if (!taskId) return void navigate(guestPath(serverId, newId));
    const w = whenTaskFinished(taskId);
    waits.current.add(w.cancel);
    void w.promise.then((o) => {
      waits.current.delete(w.cancel);
      if (o.result !== 'error') navigate(guestPath(serverId, newId));
    });
  };

  return (
    <>
      {kinds.length === 1 ? (
        <button type="button" className="btn-ghost" onClick={() => setOpen(kinds[0]!)}>
          <Icon name="plus" size={15} />
          {t('Create')}
        </button>
      ) : (
        <Menu label={t('Create a guest on {name}', { name: serverId })} buttonClassName="btn-ghost" items={kinds.map((k) => ({ label: LABEL[k](), icon: k === 'vm' ? 'monitor' : 'box', onSelect: () => setOpen(k) }))}>
          <Icon name="plus" size={15} />
          {t('Create')}
          <Icon name="chevronDown" size={14} />
        </Menu>
      )}
      {open && <CreateGuestDialog serverId={serverId} kind={open} onClose={() => setOpen(null)} onStarted={onStarted} />}
    </>
  );
}
