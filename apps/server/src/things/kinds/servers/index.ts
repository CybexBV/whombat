/**
 * The servers group: connections that reach a server's own API (Proxmox VE, Unraid). Their page is the server Whombat
 * watches when it does (`watched.ts`), else what the service's API says.
 */
import type { KindModule } from '../registry';
import { PROXMOX_KIND } from './proxmox';
import { UNRAID_KIND } from './unraid';

export const SERVER_KINDS: Record<string, KindModule> = {
  proxmox: PROXMOX_KIND,
  unraid: UNRAID_KIND,
};
