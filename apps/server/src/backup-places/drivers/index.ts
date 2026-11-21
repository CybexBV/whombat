/**
 * Which driver sets up which kind of backup place (docs/decisions/backup-places.md BPL-03): the agent driver for Unraid
 * and other Linux servers, one driver per NAS kind for a connection. One file per driver; a new kind adds its line here.
 */
import type { BackupPlaceKind } from '@whombat/core';
import { agentDriver } from './agent';
import { qnapDriver } from './qnap';
import { synologyDriver } from './synology';
import { truenasDriver } from './truenas';
import type { PlaceDriver, PlaceDriverContext, PlaceDriverFactory } from './types';

export const PLACE_DRIVERS: Record<BackupPlaceKind, PlaceDriverFactory> = {
  unraid: agentDriver,
  linux: agentDriver,
  truenas: truenasDriver,
  synology: synologyDriver,
  qnap: qnapDriver,
};

export function placeDriver(ctx: PlaceDriverContext): PlaceDriver {
  return PLACE_DRIVERS[ctx.target.kind](ctx);
}

export type {
  PlaceDriver,
  PlaceDriverContext,
  PlaceDriverFactory,
  PlaceEnsured,
  PlaceStatus,
  PlaceTarget,
} from './types';
export { PlaceError } from './types';
