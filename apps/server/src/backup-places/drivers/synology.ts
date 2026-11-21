/**
 * Synology as a backup place (docs/decisions/backup-places.md BPL-03 b), through the connection's own API (DSM’s Web API: folders through File Station and a Container Manager project).
 * The driver itself is in `../nas/synology.ts`.
 */
import { nasDriverFactory } from '../nas/place-driver';
import type { PlaceDriverFactory } from './types';

export const synologyDriver: PlaceDriverFactory = nasDriverFactory('synology');
