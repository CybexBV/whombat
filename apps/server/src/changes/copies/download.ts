/** `things.settingsCopy`: a service's settings copy for Download, opened from its seal (docs/decisions/outside-changes.md). */
import type { SettingsCopyFile } from '@whombat/core';
import { and, desc, eq } from 'drizzle-orm';
import type { ConnectionViewer } from '../../connections/store';
import { settingsCopies } from '../../db/schema/index';
import { notFound } from '../../lib/errors';
import type { Services } from '../../services';
import { findThing } from '../../things/page';

/** The newest copy of the thing's settings, or the one named by `copy`; `not_found` when there is none. */
export async function settingsCopyFile(
  services: Services,
  viewer: ConnectionViewer,
  thing: string,
  copy: string | undefined,
): Promise<SettingsCopyFile> {
  const target = await findThing(services, viewer, thing);
  if (target.kind !== 'connection') throw notFound('Settings copy');
  const [row] = await services.db
    .select()
    .from(settingsCopies)
    .where(
      and(eq(settingsCopies.connectionId, target.row.id), ...(copy ? [eq(settingsCopies.id, copy)] : [])),
    )
    .orderBy(desc(settingsCopies.madeAt))
    .limit(1);
  if (!row) throw notFound('Settings copy');
  const bytes = services.custody.openBytes(`settings_copy:${row.id}`, row.sealed);
  return {
    fileName: row.fileName,
    contentType: row.contentType,
    size: bytes.length,
    madeAt: row.madeAt.toISOString(),
    base64: bytes.toString('base64'),
  };
}
