/**
 * Create on a server's Guests tab (ported from Rackoon's `CreateMenu`; with Manage on): a virtual machine or a
 * container on Proxmox, an instance on Incus. One kind is one button; more open a menu.
 */
import { ChevronDown, Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { IncusCreateDialog } from '../incus/IncusCreateDialog';
import { CreateGuestDialog, type CreateKind } from './CreateGuestDialog';
import { MenuButton } from './MenuButton';

const LABEL: Record<CreateKind, string> = {
  vm: 'Virtual machine…',
  container: 'Container…',
  incus: 'Instance…',
};

export function CreateMenu({
  burrow,
  serverId,
  kinds,
}: {
  burrow: string;
  serverId: string;
  kinds: readonly CreateKind[];
}) {
  const [open, setOpen] = useState<CreateKind | null>(null);
  const first = kinds[0];
  if (!first) return null;
  return (
    <span style={{ marginLeft: 'auto', display: 'inline-flex' }}>
      {kinds.length === 1 ? (
        <Button size="sm" iconStart={<Icon icon={Plus} size={14} />} onClick={() => setOpen(first)}>
          {first === 'incus' ? 'New instance' : 'Create'}
        </Button>
      ) : (
        <MenuButton
          label={`Create a guest on ${serverId}`}
          size="sm"
          items={kinds.map((k) => ({ label: LABEL[k], onSelect: () => setOpen(k) }))}
        >
          <Icon icon={Plus} size={14} />
          Create
          <Icon icon={ChevronDown} size={14} />
        </MenuButton>
      )}
      {open === 'incus' ? (
        <IncusCreateDialog burrow={burrow} serverId={serverId} onClose={() => setOpen(null)} />
      ) : open ? (
        <CreateGuestDialog burrow={burrow} serverId={serverId} kind={open} onClose={() => setOpen(null)} />
      ) : null}
    </span>
  );
}
