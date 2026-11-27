/**
 * Backup options, the list of backups and bringing a Whombat back (docs/decisions/backup-options.md). Each op calls the
 * backup service's local API (appliance BK-37…BK-39) or the manager:
 *
 *   backup.overview       the Backups page in one answer: status, places, the first page, the options
 *   backup.checkpoints    GET    /v1/checkpoints (+ the place's space)        the list, newest first, a page at a time
 *   backup.policy         GET    /v1/policy                                    the options and who clears old backups
 *   backup.setPolicy      PUT    /v1/policy; the place's cleanup follows      every option at once
 *   backup.check          POST   /v1/drills                                    check one backup now
 *   backup.moveLocal      POST   /v1/local/copy                                the box's own disk's backups to the place
 *   backup.removeLocal    DELETE /v1/local                                     or away
 *   backup.adopt          POST   /v1/adopt                                     a new Whombat joins an earlier one's backups
 *   backup.restore        manager POST /v1/backup/restore                      the root restore (stops this runtime)
 *   backup.restoreState   GET    /v1/quarantine                                where it is
 *   backup.finishRestore  POST   /v1/quarantine/resolve…release, manager /v1/backup/restored
 *   backup.letAssistantSetUp                                                   the claim's yes, kept for the assistant
 *
 * The person only. The assistant reads the list and the options and changes the options on the person's word
 * (assistant-settings: `ask`); adopting, restoring and finishing are the person's alone.
 */
import { summarizeBackup } from '@whombat/control-contracts/local';
import {
  BACKUP_PAGE_DEFAULT,
  type BackupCheckpoint,
  BackupCheckpointList,
  type BackupCheckpointsOutput,
  BackupPolicy,
  type BackupPolicyOutput,
  type BackupRecoveryMaterial,
  type BackupRestoreState,
  BackupScope,
  type BackupSetPolicyInput,
  kitMaterialOf,
} from '@whombat/protocol/session';
import type { z } from 'zod';
import { keepPlaceRightSoon, newPasswordOf } from '../backup-places/keep-right';
import { changeBoxBackupNotes, loadBoxBackupNotes, without } from '../backup-places/notes';
import { earlierPlaces, type PlacesNow, placesNow } from '../backup-places/places';
import { discussNeedsYou } from '../chats/commands';
import { externalEffect } from '../commit/scope';
import { thePerson } from '../domain/the-person';
import { hostsFor } from '../hosts/service';
import { isEnglish, tServer } from '../i18n/catalog';
import { accountLocale } from '../i18n/locale';
import { ApiError } from '../lib/errors';
import { iso } from '../lib/time';
import { forgetOnePasswordBases } from '../vault/onepassword/restore';
import { LIST, port, READ, reason } from './backup';
import { noteBroughtBack, placeMovedTo, withBringBack } from './backup-key';
import { backupDownText } from './backup-port';
import { boxBackupStatus } from './box-backup';
import type { SessionOpContext } from './dispatcher';
import { hostTimeZone } from './host-metrics';
import { restoreStateIn, restoreStateOf } from './restore-state';
import { requirePerson } from './trust';

const unavailable = (body: unknown) =>
  new ApiError('conflict', reason(body), { details: { code: 'backup_unavailable' } });

const notUnderstood = () =>
  new ApiError('conflict', 'The backup service’s answer wasn’t understood. Try again.', {
    details: { code: 'backup_unavailable' },
  });

/** A service from before these routes answers 404: the op is as unknown to this box as it is to an older runtime. */
function olderService(status: number): void {
  if (status === 404 || status === 405)
    throw new ApiError(
      'not_implemented',
      'This Whombat’s backup service is older than this. Update it first.',
      {
        details: { code: 'backup_unavailable' },
      },
    );
}

async function listOf(c: SessionOpContext) {
  const res = await port(c).call('GET', '/v1/checkpoints', undefined, LIST);
  olderService(res.status);
  if (res.status !== 200) throw unavailable(res.body);
  const parsed = BackupCheckpointList.safeParse(res.body);
  if (!parsed.success) throw notUnderstood();
  return parsed.data;
}

async function policyOf(c: SessionOpContext) {
  const res = await port(c).call('GET', '/v1/policy', undefined, READ);
  olderService(res.status);
  if (res.status !== 200) throw unavailable(res.body);
  const parsed = BackupPolicy.safeParse(res.body);
  if (!parsed.success) throw notUnderstood();
  return parsed.data;
}

/* Pages ----------------------------------------------------------------------------------------------------------- */

/** A page's end: the last backup's time (ms) and id. */
export function cursorOf(cp: Pick<BackupCheckpoint, 'createdAt' | 'id'>): string {
  return `${Date.parse(cp.createdAt)}.${cp.id}`;
}

/**
 * One page of a list, newest first (pure, CT-1690): after the backup the cursor names (or, when that one went, after
 * its time), `limit` long, and the cursor of the next page when there is one.
 */
export function pageOf(
  all: readonly BackupCheckpoint[],
  cursor: string | undefined,
  limit = BACKUP_PAGE_DEFAULT,
): { checkpoints: BackupCheckpoint[]; total: number; nextCursor: string | null } {
  const sorted = [...all].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  let from = 0;
  if (cursor) {
    const dot = cursor.indexOf('.');
    const at = Number(cursor.slice(0, dot));
    const id = cursor.slice(dot + 1);
    const i = sorted.findIndex((cp) => cp.id === id);
    from = i >= 0 ? i + 1 : sorted.findIndex((cp) => Date.parse(cp.createdAt) < at);
    if (from < 0) from = sorted.length;
  }
  const checkpoints = sorted.slice(from, from + limit);
  const last = checkpoints.at(-1);
  return {
    checkpoints,
    total: sorted.length,
    nextCursor: last && from + limit < sorted.length ? cursorOf(last) : null,
  };
}

/** The place in use, from the places now. */
function placeInUse(now: PlacesNow | null) {
  return now?.places.find((p) => p.id === now.currentPlaceId && p.state === 'in_use') ?? null;
}

async function checkpointsPage(
  c: SessionOpContext,
  input: { cursor?: string; limit?: number },
  now: PlacesNow | null,
): Promise<BackupCheckpointsOutput> {
  const list = await listOf(c);
  const place = placeInUse(now);
  return {
    ...list,
    ...pageOf(list.checkpoints, input.cursor, input.limit),
    space: place?.kept ? { usedBytes: place.kept.usedBytes, freeBytes: place.kept.freeBytes } : null,
  };
}

/**
 * Who clears old backups: the place's cleanup (a place Whombat set up and can hand one), the box itself (a destination
 * its key may delete from), or nobody (an append-only destination of its own, or a place set up by hand: it has no
 * cleanup until Whombat can reach it with Manage).
 */
async function clearedBy(c: SessionOpContext, now: PlacesNow | null): Promise<'place' | 'box' | 'none'> {
  const status = await boxBackupStatus(c.services);
  // The service says who does (`clearing.by`): the box wherever its key may delete, else only the destination's side.
  const by = status?.clearing?.by;
  if (by === 'box') return 'box';
  const place = placeInUse(now);
  const row = now?.rows.find((r) => r.id === place?.id);
  if (place && !(row?.byHand ?? place.byHand)) return 'place';
  if (by === 'destination') return 'none';
  const d = status?.destination;
  if (!d?.configured) return 'none';
  return d.appendOnly === 'verified' ? 'none' : 'box';
}

async function policyAnswer(c: SessionOpContext, now?: PlacesNow | null): Promise<BackupPolicyOutput> {
  const places = now === undefined ? await placesNow(c.services).catch(() => null) : now;
  return { policy: await policyOf(c), clearedBy: await clearedBy(c, places) };
}

/** The asking person's language (English when it can't be read). */
async function principalLocale(c: SessionOpContext): Promise<string | null> {
  const account = c.principal.account?.id;
  return account ? accountLocale(c.services, account).catch(() => null) : null;
}

/* Bringing a Whombat back ---------------------------------------------------------------------------------------- */

/**
 * The quarantine's checklist from the person's one answer (CT-1692); the rest is Whombat's: sign-ins that need it ask
 * again on their own, devices are on the Devices page. Notes are printable ASCII (the service's).
 */
export function answers(input: {
  oldWhombat: 'gone' | 'lost';
}): [item: string, resolution: string, note: string][] {
  return [
    [
      'old-appliance',
      input.oldWhombat === 'gone' ? 'decommissioned' : 'credentials-rotated',
      input.oldWhombat === 'gone'
        ? 'the person: broken or wiped'
        : 'the person: lost or stolen; the place gets a new password',
    ],
    ['revocations', 'none-after-checkpoint', 'brought back from the app'],
    ['endpoints', 'reviewed', 'devices are on the Devices page'],
    ['provider-logins', 'verified', 'sign-ins that need it ask again on their own'],
    ['external-outcomes', 'none', 'nothing replayed; the assistant was told'],
    ['identity-repin', 'repinned', 'the device that answered is in'],
    ['backup-destination', 'adopted', 'backups continue to the same place'],
  ];
}

/** What the assistant tells the person once the box is back (BKO-13): plain words, the time it is back to. */
export function restoredMessage(createdAt: string | null, timeZone: string, locale?: string | null): string {
  if (!createdAt) return tServer(locale, 'managed.backup.restored');
  let when = createdAt;
  try {
    when = new Intl.DateTimeFormat(isEnglish(locale) ? 'en-GB' : 'nl-NL', {
      timeZone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(createdAt));
  } catch {
    // the instant as it is
  }
  return tServer(locale, 'managed.backup.restoredAt', { when });
}

/** What a restore is known by in the runtime's notes: when it began (the marker's, else the result's). */
const restoreKey = (state: { since: string | null }) => state.since ?? 'unknown';

/** The assistant says what came back, once per restore (a retry doesn't say it again). */
async function sayRestored(
  c: SessionOpContext,
  accountId: string,
  before: z.output<typeof BackupRestoreState>,
): Promise<void> {
  const key = restoreKey(before);
  if ((await loadBoxBackupNotes(c.services.db)).restoreSaid === key) return;
  try {
    const burrowId = await hostsFor(c.services).homeBurrowId();
    const person = burrowId ? await thePerson(c.services.db, burrowId) : null;
    if (!burrowId || !person) return;
    const text = restoredMessage(
      before.restored?.createdAt ?? null,
      await hostTimeZone(c.services.db, accountId),
      await accountLocale(c.services, accountId).catch(() => null),
    );
    await c.services.pipeline.commit(discussNeedsYou, { text }, { burrowId, actorId: person.id });
    await changeBoxBackupNotes(c.services, (n) => ({ ...n, restoreSaid: key }));
  } catch (err) {
    // A failure here doesn't hold the restart up.
    c.services.log.warn({ err: String(err) }, 'backup restore: the assistant’s message wasn’t posted');
  }
}

/**
 * The manager restarts the runtime and the hosts service, once per restore: noted before it is asked (it stops this
 * runtime, so nothing is written after), taken back when it refused, so a retry asks again.
 */
async function restartAfterRestore(c: SessionOpContext, key: string): Promise<void> {
  const restart = c.manager?.backupRestored?.bind(c.manager);
  if (!restart) return;
  if ((await loadBoxBackupNotes(c.services.db)).restartedFor === key) return;
  await changeBoxBackupNotes(c.services, (n) => ({ ...n, restartedFor: key }));
  try {
    await restart();
  } catch (err) {
    c.services.log.warn({ err: String(err) }, 'backup restore: the manager didn’t restart the runtime');
    await changeBoxBackupNotes(c.services, (n) =>
      n.restartedFor === key ? without(n, 'restartedFor') : null,
    );
    // The words of a restart that didn't happen: the person tries again.
    const words = tServer(await principalLocale(c), 'managed.backup.restartFailed');
    throw new ApiError('unavailable', words, { details: { code: 'backup_restart_failed' } });
  }
}

async function stateOf(c: SessionOpContext) {
  const res = await port(c).call('GET', '/v1/quarantine', undefined, READ);
  olderService(res.status);
  if (res.status !== 200) throw unavailable(res.body);
  const state = restoreStateIn(restoreStateOf(res.body), await principalLocale(c));
  if (!state) throw notUnderstood();
  // Once it is back: whether Whombat can give the backups a new password if the old one was lost or stolen, so the
  // question and the done screen promise only that.
  if (state.phase !== 'checking' && state.phase !== 'released') return state;
  const newPassword = await newPasswordOf(c.services).catch(() => undefined);
  return newPassword === undefined ? state : { ...state, newPassword };
}

/* The ops -------------------------------------------------------------------------------------------------------- */

// biome-ignore lint/suspicious/noExplicitAny: each handler receives its op's parsed input.
type Handler = (c: SessionOpContext, input: any) => Promise<unknown>;

export const BACKUP_OPTIONS_HANDLERS: Readonly<Record<string, Handler>> = {
  /**
   * The Backups page in one answer (CT-1691): the places read once (they read the network), the status and the list
   * at the same time. A part that fails is null; when the service doesn't answer at all, `notice` says so. The places
   * that kept backups before the one in use come from their records, so the page can say where the older ones are.
   */
  'backup.overview': async (c) => {
    requirePerson(c.principal);
    const down = { value: false };
    const part = <T>(p: Promise<T>): Promise<T | null> =>
      p.catch((err: unknown) => {
        if (err instanceof ApiError && err.code === 'unavailable') down.value = true;
        return null;
      });
    const [status, places] = await Promise.all([
      boxBackupStatus(c.services, { fresh: true }),
      placesNow(c.services, { fresh: true }).catch(() => null),
    ]);
    const [checkpoints, policy] = await Promise.all([
      part(checkpointsPage(c, {}, places)),
      part(policyAnswer(c, places)),
    ]);
    const service = status ?? null;
    return {
      status: service,
      summary: await withBringBack(c.services, summarizeBackup(service, BackupScope.options), service),
      places: places ? { places: places.places, currentPlaceId: places.currentPlaceId } : null,
      checkpoints,
      policy,
      notice:
        down.value || (!service && !checkpoints && !policy) ? backupDownText(await principalLocale(c)) : null,
      earlierPlaces: places ? earlierPlaces(places) : [],
    };
  },

  'backup.checkpoints': async (c, input: { cursor?: string; limit?: number }) => {
    requirePerson(c.principal);
    // Only the first page says the space (later pages are read for the list alone).
    const now = input.cursor ? null : await placesNow(c.services).catch(() => null);
    return checkpointsPage(c, input, now);
  },

  'backup.policy': async (c) => {
    requirePerson(c.principal);
    return policyAnswer(c);
  },

  'backup.setPolicy': async (c, input: z.output<typeof BackupSetPolicyInput>) => {
    const { account } = requirePerson(c.principal);
    const policy = {
      v: 1 as const,
      frequency: input.frequency,
      timeZone: await hostTimeZone(c.services.db, account.id),
      keep: input.keep,
      limitBytes: input.limitBytes,
      weeklyCheck: input.weeklyCheck,
    };
    // Accepted once the service took it; the place's cleanup follows.
    await c.services.pipeline.transactAccount(async () => {});
    const res = await externalEffect('backup.policy', () => port(c).call('PUT', '/v1/policy', policy));
    olderService(res.status);
    if (res.status !== 200)
      throw new ApiError('validation_failed', reason(res.body), { details: { code: 'backup_policy' } });
    // The place's cleanup takes the new windows from the keep-the-place-right job, which may wait behind a move of the
    // backups (up to an hour): saving never waits for it, and a change that doesn't take is handed again.
    keepPlaceRightSoon(c.services);
    await boxBackupStatus(c.services, { fresh: true });
    return policyAnswer(c);
  },

  'backup.check': async (c, input: { checkpointId: string }) => {
    requirePerson(c.principal);
    const list = await listOf(c);
    const cp = list.checkpoints.find((x) => x.id === input.checkpointId);
    if (!cp)
      throw new ApiError('not_found', 'That backup isn’t there any more.', {
        details: { code: 'backup_gone' },
      });
    // Accepted (a receipt) before the check is asked for.
    await c.services.pipeline.transactAccount(async () => {});
    const res = await externalEffect('backup.check', () =>
      port(c).call('POST', '/v1/drills', { checkpointId: cp.id, own: cp.own }),
    );
    olderService(res.status);
    if (res.status !== 202) throw unavailable(res.body);
    return { queued: true as const };
  },

  'backup.moveLocal': async (c) => {
    requirePerson(c.principal);
    await c.services.pipeline.transactAccount(async () => {});
    const res = await externalEffect('backup.move_local', () => port(c).call('POST', '/v1/local/copy', {}));
    olderService(res.status);
    if (res.status === 409)
      throw new ApiError('conflict', 'A backup is running. Try again in a minute.', {
        details: { code: 'backup_busy' },
      });
    if (res.status !== 200) throw unavailable(res.body);
    const copied = (res.body as { copied?: unknown } | null)?.copied;
    return { copied: typeof copied === 'number' ? copied : 0 };
  },

  'backup.removeLocal': async (c) => {
    requirePerson(c.principal);
    await c.services.pipeline.transactAccount(async () => {});
    const res = await externalEffect('backup.remove_local', () => port(c).call('DELETE', '/v1/local'));
    olderService(res.status);
    if (res.status === 409)
      throw new ApiError('conflict', 'A backup is running. Try again in a minute.', {
        details: { code: 'backup_busy' },
      });
    if (res.status !== 200) throw unavailable(res.body);
    return { ok: true as const };
  },

  'backup.adopt': async (c, input: { kit: string; replace?: boolean }) => {
    requirePerson(c.principal);
    const material: z.output<typeof BackupRecoveryMaterial> | null = kitMaterialOf(input.kit);
    if (!material)
      throw new ApiError(
        'validation_failed',
        'That isn’t a recovery kit Whombat can read. Check it’s the whole kit.',
        {
          details: { code: 'backup_kit_invalid' },
        },
      );
    await c.services.pipeline.transactAccount(async () => {});
    // A kit from before the place's address changed finds it on this network by its repository. `replace`: the person
    // confirmed this Whombat's own backups give way (the backup service decides what that allows).
    const found = await placeMovedTo(c.services, material);
    const res = await externalEffect('backup.adopt', () =>
      port(c).call(
        'POST',
        '/v1/adopt',
        { material: found, ...(input.replace ? { replace: true } : {}) },
        LIST,
      ),
    );
    olderService(res.status);
    if (res.status === 409)
      throw new ApiError('conflict', reason(res.body), { details: { code: 'backup_has_own' } });
    if (res.status !== 200)
      throw new ApiError('conflict', reason(res.body), { details: { code: 'backup_adopt_failed' } });
    const out = res.body as { oldApplianceId?: unknown; checkpoints?: unknown };
    const list = BackupCheckpointList.shape.checkpoints.safeParse(out.checkpoints);
    if (!list.success || typeof out.oldApplianceId !== 'string') throw notUnderstood();
    await boxBackupStatus(c.services, { fresh: true });
    return { oldApplianceId: out.oldApplianceId, ...pageOf(list.data, undefined) };
  },

  'backup.restore': async (c, input: { checkpointId: string }) => {
    requirePerson(c.principal);
    const restore = c.manager?.backupRestore?.bind(c.manager);
    if (!restore)
      throw new ApiError('not_implemented', 'This Whombat can’t bring a backup back from the app.', {
        details: { code: 'backup_unavailable' },
      });
    const state = await stateOf(c);
    if (state.phase === 'restoring' || state.phase === 'checking')
      throw new ApiError('conflict', 'A restore is going already.', { details: { code: 'backup_busy' } });
    // Accepted before the manager is asked: the restore stops this runtime, so nothing answers after it.
    await c.services.pipeline.transactAccount(async () => {});
    await externalEffect('backup.restore', () => restore(input.checkpointId));
    return { started: true as const };
  },

  'backup.restoreState': async (c) => {
    requirePerson(c.principal);
    return stateOf(c);
  },

  /**
   * The person's one answer (CT-1692). Doing it again carries on where it stopped: items resolved already are left,
   * the assistant's message is said once, and once released only the restart is left (asked again when it didn't
   * happen). Lost or stolen: the place in use gets a new password once the box runs normally again (the
   * keep-the-place-right job; the hosts service and the place are reached only then).
   */
  'backup.finishRestore': async (c, input: { oldWhombat: 'gone' | 'lost' }) => {
    const { account } = requirePerson(c.principal);
    const before = await stateOf(c);
    if (before.phase === 'released') {
      await restartAfterRestore(c, restoreKey(before));
      return stateOf(c);
    }
    if (before.phase !== 'checking')
      throw new ApiError('conflict', 'There is no restore waiting for your answers.', {
        details: { code: 'backup_no_restore' },
      });
    await c.services.pipeline.transactAccount(async () => {});
    for (const [item, resolution, note] of answers(input)) {
      const open = before.items.find((i) => i.id === item);
      if (!open || open.resolution !== null) continue;
      const res = await port(c).call('POST', '/v1/quarantine/resolve', { item, resolution, note });
      if (res.status !== 200) throw unavailable(res.body);
    }
    // Noted before the release, so a restart can't lose it: a lost box's place gets a new password, and the earlier
    // Whombat's passkeys that came with the backup no longer sign in (doing it again changes nothing).
    if (input.oldWhombat === 'lost')
      await changeBoxBackupNotes(c.services, (n) => ({
        ...n,
        rotate: n.rotate ?? { since: iso(c.services.clock()), tries: 0, lastError: null },
      }));
    await noteBroughtBack(c.services, before.oldApplianceId, before.restored?.createdAt ?? null);
    // The restored Vault is older than 1Password: every pair forgets its base and the backup's unfinished archiving
    // before any pass can run, so 1Password's version wins at the next one (onepassword-sync.md). When it
    // fails, the restore isn't finished: the box stays quarantined and the answer can be sent again (this is safe twice).
    await forgetOnePasswordBases(c.services);
    // What the backup service may use to trust the earlier Whombat's key only up to the restored backup.
    const released = await port(c).call('POST', '/v1/quarantine/release', {
      oldWhombat: input.oldWhombat,
      ...(before.restored ? { checkpointId: before.restored.checkpointId } : {}),
    });
    if (released.status !== 200) throw unavailable(released.body);
    await sayRestored(c, account.id, before);
    const after = await stateOf(c);
    await restartAfterRestore(c, restoreKey(after));
    return after;
  },

  /** The claim's “Let {assistant} set it up” (CT-1694): kept as the person's yes; the job carries it out. */
  'backup.letAssistantSetUp': async (c, input: { placeId?: string }) => {
    const { account } = requirePerson(c.principal);
    await changeBoxBackupNotes(c.services, (n) =>
      n.consent?.state === 'waiting' && n.consent.placeId === (input.placeId ?? null)
        ? null
        : {
            ...n,
            consent: {
              at: iso(c.services.clock()),
              accountId: account.id,
              placeId: input.placeId ?? null,
              state: 'waiting',
            },
          },
    );
    keepPlaceRightSoon(c.services);
    return { ok: true as const };
  },
};
