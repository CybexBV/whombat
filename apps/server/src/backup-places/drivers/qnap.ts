/**
 * QNAP as a backup place (docs/decisions/backup-places.md BPL-03 b), through the connection's own API (QTS’s File Station and Container Station 3’s application API).
 * The driver itself is in `../nas/qnap.ts`.
 */
import { nasDriverFactory } from '../nas/place-driver';
import type { PlaceDriverFactory } from './types';

export const qnapDriver: PlaceDriverFactory = nasDriverFactory('qnap');
