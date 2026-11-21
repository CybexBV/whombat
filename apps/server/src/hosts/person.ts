/** Who may change servers (one-whombat-servers.md ONE-DH05; server-asks.md SA-05; one-person.md OP-S07): the person. */
import type { PrincipalRow } from '../read/principals';

/** Whether `p` may change servers: the person (`kind === 'person'`). */
export function canManageServers(p: Pick<PrincipalRow, 'kind'>): boolean {
  return p.kind === 'person';
}

export const ONLY_YOU_CHANGE_SERVERS_TEXT = 'Only you can change servers.';
