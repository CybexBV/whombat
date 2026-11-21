/**
 * The servers' details the places list keeps for half a minute (docs/decisions/backup-places.md BPL-S10), in a module
 * of its own so the place lock can forget them after a flow without importing the places list.
 */
import type { Services } from '../services';
import type { ServerFacts } from './places';

export const serversRead = new WeakMap<Services, { at: number; value: Promise<ServerFacts[]> }>();

/** After a change: the next read asks the servers again. */
export function forgetServers(services: Services): void {
  serversRead.delete(services);
}
