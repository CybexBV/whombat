/**
 * TrueNAS as a backup place (docs/decisions/backup-places.md BPL-03 b), through the connection's own API (its JSON-RPC socket: datasets, a custom app from compose, and an NFS share for a server’s backups).
 * The driver itself is in `../nas/truenas.ts`.
 */
import { nasDriverFactory } from '../nas/place-driver';
import type { PlaceDriverFactory } from './types';

export const truenasDriver: PlaceDriverFactory = nasDriverFactory('truenas');
