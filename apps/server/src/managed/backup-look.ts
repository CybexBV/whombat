/**
 * Getting one thing back from a backup, as session ops (docs/decisions/backup-look.md):
 *
 *   backup.look          {checkpointId}                        the backup opened for reading (`POST /v1/peeks`)
 *   backup.lookContents  {lookId, category?, query?, cursor?}  its categories and a page of one's items
 *   backup.lookBring     {lookId, items? | categories?}        the backup file's restorer on what was picked (only adds)
 *   backup.lookClose     {lookId}                              closed (`DELETE /v1/peeks/{id}`)
 *
 * The person, or their assistant through the settings tools: looking is a read, bringing back always asks the person
 * first (assistant-settings `ask`).
 */
import type {
  BackupLookBringInput,
  BackupLookCloseInput,
  BackupLookContentsInput,
  BackupLookInput,
} from '@whombat/protocol/session';
import { and, asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { type Looker, looksFor } from '../backups/look/service';
import { burrows, principals } from '../db/schema/index';
import { ApiError } from '../lib/errors';
import { LIST, port } from './backup';
import type { SessionOpContext } from './dispatcher';
import { requirePerson } from './trust';

/** The person behind the session, in this Whombat. */
async function looker(c: SessionOpContext): Promise<Looker> {
  const { account } = requirePerson(c.principal);
  const [row] = await c.services.db
    .select({ person: principals, burrow: burrows })
    .from(principals)
    .innerJoin(burrows, eq(burrows.id, principals.burrowId))
    .where(and(eq(principals.accountId, account.id), eq(principals.kind, 'person')))
    .orderBy(asc(burrows.createdAt))
    .limit(1);
  if (!row)
    throw new ApiError('forbidden', 'Only the person whose Whombat this is can look inside its backups.');
  return {
    burrow: row.burrow,
    person: row.person,
    email: (account.email ?? row.person.email ?? `${row.person.handle}@example.com`).toLowerCase(),
  };
}

/** When a backup was made, from the list (null when the list doesn't say). */
async function madeAtOf(c: SessionOpContext, checkpointId: string): Promise<Date | null> {
  // Only a short wait: the person is waiting for the backup to open, and the date is only for its title.
  const res = await port(c)
    .call('GET', '/v1/checkpoints', undefined, { ...LIST, deadlineMs: 10_000 })
    .catch(() => null);
  const list = (res?.body as { checkpoints?: { id?: unknown; createdAt?: unknown }[] } | null)?.checkpoints;
  const at = list?.find((cp) => cp.id === checkpointId)?.createdAt;
  return typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? new Date(at) : null;
}

// biome-ignore lint/suspicious/noExplicitAny: each handler receives its op's parsed input.
type Handler = (c: SessionOpContext, input: any) => Promise<unknown>;

export const BACKUP_LOOK_HANDLERS: Readonly<Record<string, Handler>> = {
  'backup.look': async (c, input: z.output<typeof BackupLookInput>) => {
    const who = await looker(c);
    const p = port(c);
    return looksFor(c.services).open(p, who, input.checkpointId, () => madeAtOf(c, input.checkpointId));
  },

  'backup.lookContents': async (c, input: z.output<typeof BackupLookContentsInput>) => {
    const who = await looker(c);
    port(c);
    return looksFor(c.services).contents(who, input);
  },

  'backup.lookBring': async (c, input: z.output<typeof BackupLookBringInput>) => {
    const who = await looker(c);
    port(c);
    // Accepted once it starts; its batches commit through the pipeline as it goes.
    await c.services.pipeline.transactAccount(async () => {});
    return looksFor(c.services).bring(who, input);
  },

  'backup.lookClose': async (c, input: z.output<typeof BackupLookCloseInput>) => {
    const who = await looker(c);
    await c.services.pipeline.transactAccount(async () => {});
    return looksFor(c.services).close(input.lookId, who.person);
  },
};
