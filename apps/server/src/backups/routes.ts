/**
 * Backup files' handlers (`api.backups.*`, contracts CT-335; docs/decisions/backup-file.md): thin adapters over the
 * backup service, the person's only. The session reaches them as `api` ops and the bytes through its streams.
 */

import { api } from '@whombat/core';
import { type RouteDef, route } from '../routes/define';
import { backupsFor } from './service';

export const backupRoutes: RouteDef[] = [
  route(api.backups.defaults, async ({ services, access }) => backupsFor(services).defaults(access)),
  route(api.backups.setDefaults, async ({ services, access, body }) =>
    backupsFor(services).setDefaults(access, body.categories),
  ),
  route(api.backups.estimate, async ({ services, access }) => backupsFor(services).estimate(access)),
  route(api.backups.list, async ({ services, access }) => backupsFor(services).list(access)),
  route(api.backups.create, async ({ services, access, body }) => ({
    file: await backupsFor(services).create(access, body),
  })),
  route(api.backups.get, async ({ services, access, params }) => ({
    file: await backupsFor(services).get(access, params.backupFileId),
  })),
  route(api.backups.remove, async ({ services, access, params }) =>
    backupsFor(services).remove(access, params.backupFileId),
  ),
  route(api.backups.stage, async ({ services, access, body }) => ({
    upload: await backupsFor(services).stage(access, body),
  })),
  route(api.backups.getUpload, async ({ services, access, params }) => ({
    upload: await backupsFor(services).getUpload(access, params.stagedBackupId),
  })),
  route(api.backups.removeUpload, async ({ services, access, params }) =>
    backupsFor(services).removeUpload(access, params.stagedBackupId),
  ),
  route(api.backups.inspect, async ({ services, access, params, body }) =>
    backupsFor(services).inspect(access, params.stagedBackupId, body.password),
  ),
  route(api.backups.restore, async ({ services, access, params, body }) => ({
    restore: await backupsFor(services).restore(access, params.stagedBackupId, body),
  })),
  route(api.backups.getRestore, async ({ services, access, params }) => ({
    restore: await backupsFor(services).getRestore(access, params.restoreId),
  })),
];
