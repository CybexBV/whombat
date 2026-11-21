/**
 * Changing QEMU/KVM through libvirt (Whombat incus-unraid.md IU-13, IU-06, IU-07; AP-1649): whether it can be changed
 * (the server's Manage switch on and a Whombat that has `hosts.libvirt`) and why not, the host's libvirt choices, and one
 * libvirt change at a time through `useManage` — `platform: libvirt` on every request, so host routes on an Unraid
 * server reach libvirt and the task tracker asks for `libvirt:<id>` tasks as such (PX-05).
 */
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostChoices, HostServerDetail } from '@whombat/core/domain';
import { useCallback } from 'react';
import { type ManageOutcome, type ManageSend, useManage } from '../manage/useManage';

export interface LibvirtAccess {
  /** This server's VMs can be changed now. */
  can: boolean;
  /** Why not (Manage off); null when they can. */
  reason: string | null;
}

export function useLibvirtAccess(_burrow: string, detail: Pick<HostServerDetail, 'server'>): LibvirtAccess {
  const rc = detail.server.remoteControl;
  const manage = rc.manage === true;
  const reason = manage
    ? null
    : (rc.manageReason ?? `Changing ${detail.server.id} from Whombat is switched off.`);
  return { can: manage, reason };
}

/** The host's libvirt choices (pools or Unraid's VM folder, networks, bridges, ISO images, OS types, firmware). */
export function useLibvirtChoices(burrow: string, serverId: string, enabled = true): HostChoices | undefined {
  const r = useHostManageRead(
    enabled ? { params: { burrow, serverId }, query: { op: 'choices', platform: 'libvirt' } } : null,
  );
  return r.data?.op === 'choices' ? r.data.choices : undefined;
}

/** `useManage` with `platform: libvirt` on every change. */
export function useLibvirtManage(burrow: string, serverId: string) {
  const { send, busy } = useManage(burrow, serverId);
  const lv = useCallback(
    (s: Omit<ManageSend, 'platform'>, opts?: { inline?: boolean }): Promise<ManageOutcome> =>
      send({ ...s, platform: 'libvirt' }, opts),
    [send],
  );
  return { send: lv, busy };
}
