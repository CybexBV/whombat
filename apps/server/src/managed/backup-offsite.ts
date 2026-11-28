/**
 * The copy somewhere else (docs/decisions/offsite-copy.md): a second place, an S3-compatible bucket the person owns,
 * where the box copies its backups after each one. Each op calls the backup service's local API:
 *
 *   backup.offsite        {}                                          → {offsite}   GET    /v1/offsite
 *   backup.setOffsite     {provider, endpoint, bucket, folder?, accessKeyId, secretAccessKey, region?}
 *                                                                     → {offsite}   PUT    /v1/offsite
 *   backup.removeOffsite  {}                                          → {offsite}   DELETE /v1/offsite
 *   backup.copyOffsite    {}                                          → {queued}    POST   /v1/offsite/copy
 *
 * The person only. `setOffsite` is a secret op: the key goes to the backup service and nowhere else (no receipt, no
 * event, no refusal text), and the service checks the bucket before it keeps it; a step that failed comes back as the
 * person's sentence (`managed.offsite.step.*`). The assistant reads how the copy does, never sets it.
 */
import {
  type BackupOffsite,
  BackupOffsiteProvider,
  BackupOffsiteServiceDoc,
  BackupOffsiteStep,
  type BackupSetOffsiteInput,
  type BackupStatus,
} from '@whombat/protocol/session';
import type { z } from 'zod';
import { externalEffect } from '../commit/scope';
import { tServer } from '../i18n/catalog';
import { accountLocale } from '../i18n/locale';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { appendApplianceEvent } from './audit';
import { noteDestinationChanged, port, reason } from './backup';
import { type BackupPort, READ } from './backup-port';
import { boxBackupOf } from './box-backup';
import type { SessionOpContext } from './dispatcher';
import { requirePerson } from './trust';

type SetInput = z.output<typeof BackupSetOffsiteInput>;
type Step = z.infer<typeof BackupOffsiteStep>;

/** Setting a place checks the bucket and may make the copy's repository there: a slow storage takes a while. */
const SET_DEADLINE_MS = 3 * 60_000;

/**
 * The storage's address as the backup service takes it (`https://host[:port]`): typed without `https://` it is https;
 * a path, a user or a query in it is refused (the bucket and the folder have their own fields). Null when it isn't one.
 */
export function endpointOf(endpoint: string): URL | null {
  const raw = endpoint.trim().replace(/\/+$/, '');
  const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(full);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== ''))
      return null;
    return u;
  } catch {
    return null;
  }
}

/** The restic repository of the place: `s3:https://host/bucket[/folder]`. */
export function offsiteRepository(input: Pick<SetInput, 'endpoint' | 'bucket' | 'folder'>): string | null {
  const u = endpointOf(input.endpoint);
  if (!u) return null;
  const folder = input.folder?.replace(/^\/+|\/+$/g, '');
  return `s3:${u.protocol}//${u.host}/${input.bucket}${folder ? `/${folder}` : ''}`;
}

/** The address, bucket and folder an `s3:` repository names (what the form shows when the person changes it). */
export function placeOf(repository: string): { endpoint: string; bucket: string; folder: string } | null {
  if (!repository.startsWith('s3:')) return null;
  try {
    const u = new URL(repository.slice(3));
    const [bucket = '', ...rest] = u.pathname.replace(/^\/+/, '').split('/');
    if (!bucket) return null;
    return {
      endpoint: u.protocol === 'https:' ? u.host : `${u.protocol}//${u.host}`,
      bucket,
      folder: rest.filter(Boolean).join('/'),
    };
  } catch {
    return null;
  }
}

/** The service's document as the app shows it (pure): null when no second place is set (or it isn't a bucket). */
export function offsiteOf(doc: BackupOffsiteServiceDoc): BackupOffsite | null {
  if (!doc.configured || doc.state === 'none' || !doc.repository || !doc.configuredAt) return null;
  const place = placeOf(doc.repository);
  if (!place) return null;
  const provider = BackupOffsiteProvider.safeParse(doc.provider);
  const step = BackupOffsiteStep.safeParse(doc.lastFailure?.step);
  const failing = doc.failedAttempts > 0 && doc.lastFailure;
  return {
    provider: provider.success ? provider.data : 's3',
    display: doc.display ?? `${place.endpoint}/${place.bucket}`,
    ...place,
    region: doc.s3Region || null,
    state: doc.state,
    configuredAt: doc.configuredAt,
    lastCopyAt: doc.lastCopy?.at ?? null,
    newestInCopyAt: doc.lastCopy?.checkpointAt ?? null,
    newestBackupAt: doc.newestBackupAt ?? null,
    backupsInCopy: doc.backupsInCopy,
    failedAttempts: doc.failedAttempts,
    lastFailure: failing ? { at: failing.at, step: step.success ? step.data : 'copy' } : null,
    nextTryAt: doc.nextTryAt ?? null,
    lastClearedAt: doc.lastClearedAt ?? null,
  };
}

/** The second place as the service says it now; undefined when it didn't answer (or is too old to keep one). */
async function readOffsite(backup: BackupPort): Promise<BackupOffsite | null | undefined> {
  const res = await backup.call('GET', '/v1/offsite', undefined, READ).catch(() => null);
  if (res?.status !== 200) return undefined;
  const parsed = BackupOffsiteServiceDoc.safeParse(res.body);
  return parsed.success ? offsiteOf(parsed.data) : undefined;
}

/** The last answer, kept a minute: the status, the overview and the Inbox read it often. */
const kept = new WeakMap<Services, { at: number; offsite: BackupOffsite | null | undefined }>();
const KEPT_FOR_MS = 60_000;

/** The second place now (`fresh` right after a change); undefined when this box can't say (no backup service). */
export async function offsiteNow(
  services: Services,
  options: { fresh?: boolean } = {},
): Promise<BackupOffsite | null | undefined> {
  const box = boxBackupOf(services);
  if (!box) return undefined;
  const now = services.clock().getTime();
  const last = kept.get(services);
  if (!options.fresh && last && now - last.at < KEPT_FOR_MS) return last.offsite;
  const offsite = await readOffsite(box.port);
  kept.set(services, { at: now, offsite });
  return offsite;
}

/** A backup summary with the second place (null: none); unchanged when the service didn't say. */
export async function withOffsite(services: Services, summary: BackupStatus): Promise<BackupStatus> {
  const offsite = await offsiteNow(services).catch(() => undefined);
  return offsite === undefined ? summary : { ...summary, offsite };
}

/** The person's sentence for a step that failed. */
export function offsiteStepText(step: Step, locale?: string | null): string {
  return tServer(locale, `managed.offsite.step.${step}` as const);
}

async function localeOf(c: SessionOpContext): Promise<string | null> {
  const account = c.principal.account?.id;
  return account ? accountLocale(c.services, account).catch(() => null) : null;
}

/** The service's refusal of a place, as the person reads it (never the key they typed). */
async function refusal(c: SessionOpContext, res: { status: number; body: unknown }): Promise<ApiError> {
  const locale = await localeOf(c);
  if (res.status === 404 || res.status === 405)
    return new ApiError('not_implemented', tServer(locale, 'managed.offsite.notYet'), {
      details: { code: 'backup_unavailable' },
    });
  const err = (res.body as { error?: { code?: unknown; step?: unknown } } | null)?.error;
  const step = BackupOffsiteStep.safeParse(err?.step);
  if (res.status === 422 && step.success)
    return new ApiError('conflict', offsiteStepText(step.data, locale), {
      details: { code: 'backup_offsite_failed', step: step.data },
    });
  if (res.status === 400)
    return new ApiError('bad_request', tServer(locale, 'managed.offsite.badPlace'), {
      details: { code: 'backup_offsite_failed' },
    });
  return new ApiError('conflict', reason(res.body), { details: { code: 'backup_offsite_failed' } });
}

async function audit(
  c: SessionOpContext,
  type: 'backup.offsite_set' | 'backup.offsite_removed',
  payload: Record<string, unknown>,
): Promise<void> {
  const { endpointId, account, agentId } = requirePerson(c.principal);
  await c.services.pipeline.transactAccount(async (tx) => {
    await appendApplianceEvent(tx, c.services.custody, {
      type,
      actorAccountId: account.id,
      endpointId,
      payload: agentId ? { ...payload, agentId } : payload,
      at: c.services.clock(),
    });
  });
}

/** The answer after a change: read again (a failed read says what was asked for: none after a removal). */
async function answerNow(c: SessionOpContext): Promise<{ offsite: BackupOffsite | null }> {
  const offsite = await offsiteNow(c.services, { fresh: true });
  return { offsite: offsite ?? null };
}

// biome-ignore lint/suspicious/noExplicitAny: each handler receives its op's parsed input.
type Handler = (c: SessionOpContext, input: any) => Promise<unknown>;

export const BACKUP_OFFSITE_HANDLERS: Readonly<Record<string, Handler>> = {
  'backup.offsite': async (c) => {
    requirePerson(c.principal);
    const backup = port(c);
    const res = await backup.call('GET', '/v1/offsite', undefined, READ);
    if (res.status !== 200) throw await refusal(c, res);
    const parsed = BackupOffsiteServiceDoc.safeParse(res.body);
    if (!parsed.success)
      throw new ApiError('conflict', reason(res.body), { details: { code: 'backup_unavailable' } });
    const offsite = offsiteOf(parsed.data);
    kept.set(c.services, { at: c.services.clock().getTime(), offsite });
    return { offsite };
  },

  'backup.setOffsite': async (c, input: SetInput) => {
    requirePerson(c.principal);
    const backup = port(c);
    const repository = offsiteRepository(input);
    if (!repository)
      throw new ApiError('bad_request', tServer(await localeOf(c), 'managed.offsite.badAddress'), {
        details: { code: 'backup_offsite_failed' },
      });
    // Accepted before the service is called: checking a bucket and making the copy's repository there may take a while.
    await c.services.pipeline.transactAccount(async () => {});
    const res = await externalEffect('backup.offsite', () =>
      backup.call(
        'PUT',
        '/v1/offsite',
        {
          provider: input.provider,
          repository,
          s3AccessKeyId: input.accessKeyId,
          s3SecretAccessKey: input.secretAccessKey,
          s3Region: input.region ?? '',
        },
        { deadlineMs: SET_DEADLINE_MS },
      ),
    );
    if (res.status !== 200) throw await refusal(c, res);
    await audit(c, 'backup.offsite_set', {
      provider: input.provider,
      host: endpointOf(input.endpoint)?.host ?? 'unknown',
    });
    // What bringing the box back takes changed: the passkey's locked copies follow.
    noteDestinationChanged(c.services);
    return answerNow(c);
  },

  'backup.removeOffsite': async (c) => {
    requirePerson(c.principal);
    const backup = port(c);
    const res = await externalEffect('backup.offsite', () => backup.call('DELETE', '/v1/offsite'));
    if (res.status !== 200) throw await refusal(c, res);
    await audit(c, 'backup.offsite_removed', {});
    noteDestinationChanged(c.services);
    return answerNow(c);
  },

  'backup.copyOffsite': async (c) => {
    requirePerson(c.principal);
    const backup = port(c);
    const res = await externalEffect('backup.offsite', () => backup.call('POST', '/v1/offsite/copy', {}));
    if (res.status === 412)
      throw new ApiError('conflict', tServer(await localeOf(c), 'managed.offsite.none'), {
        details: { code: 'backup_offsite_none' },
      });
    if (res.status !== 202 && res.status !== 200) throw await refusal(c, res);
    kept.delete(c.services);
    return { queued: true as const };
  },
};
