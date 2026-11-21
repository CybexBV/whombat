/**
 * What this Whombat can put in a backup file of a burrow (docs/decisions/backup-file.md BF-13, BF-21, BF-S19): every
 * category, `servers` only where it watches servers (the hosts service is here and this is the servers' burrow). The
 * defaults the server answers are the burrow's own (or core's nine) without the ones it can't offer.
 */
import { BACKUP_CATEGORY_IDS, type BackupCategoryId } from '@whombat/core';
import type { Services } from '../services';
import { serversOffered } from './collect/servers';

export async function offeredCategories(services: Services, burrowId: string): Promise<BackupCategoryId[]> {
  const servers = await serversOffered(services, burrowId);
  return BACKUP_CATEGORY_IDS.filter((id) => id !== 'servers' || servers);
}
