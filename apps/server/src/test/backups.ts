/**
 * A backup file's bytes in tests, as a session's streams move them (docs/decisions/backup-file.md BF-10): the download
 * reads the staged file `openBackupDownload` streams (its maker, the person, while it lasts); the upload writes the staged
 * upload's file and completes it, as the `backup-file` upload stream does at its end. The streams themselves (chunks,
 * ranges, resuming, refusals) are tested in `backups/streams.int.test.ts`.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { burrowAccess } from '../auth/request';
import { backupsFor } from '../backups/service';
import { accounts } from '../db/schema/index';
import type { Services } from '../services';
import { callerAccountId } from './api';

/** The person a test cookie (`sessionFor`) names in a burrow. */
async function personIn(services: Services, slug: string, cookie: string) {
  const accountId = callerAccountId({ cookie });
  const [account] = accountId
    ? await services.db.select().from(accounts).where(eq(accounts.id, accountId))
    : [];
  return burrowAccess(services, { account: account ?? null }, slug);
}

/** The whole backup file `backupFileId` as its download stream gives it to the person `cookie` names. */
export async function downloadBackup(
  services: Services,
  slug: string,
  cookie: string,
  backupFileId: string,
): Promise<Buffer> {
  const { principal, burrow } = await personIn(services, slug, cookie);
  const { path } = await backupsFor(services).downloadable(burrow.id, principal, backupFileId);
  return readFile(path);
}

/** Uploads `bytes` into the staged backup `stagedBackupId` as its upload stream does; the stream's `stream_done` output. */
export async function uploadBackup(
  services: Services,
  slug: string,
  cookie: string,
  stagedBackupId: string,
  bytes: Uint8Array,
): Promise<unknown> {
  const { principal, burrow } = await personIn(services, slug, cookie);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const target = await backupsFor(services).sessionTarget(burrow.id, principal, stagedBackupId, {
    size: bytes.length,
    sha256,
  });
  await writeFile(target.path, bytes);
  return target.complete(sha256);
}
