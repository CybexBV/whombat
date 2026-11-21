import type { HostGuestDetail } from '@whombat/core/domain';

/** What a guest's tab gets from the guest page. */
export interface GuestTabProps {
  burrow: string;
  serverId: string;
  guest: HostGuestDetail;
  timeZone?: string;
}
