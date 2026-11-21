/** What every server tab gets: the burrow, the server, its page, and the person's time zone. */
import type { HostServerDetail } from '@whombat/core/domain';

export interface TabProps {
  burrow: string;
  serverId: string;
  detail: HostServerDetail;
  timeZone?: string;
}
