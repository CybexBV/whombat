/**
 * The backup service's peek (`appliance/backup/internal/peek`; backup-look.md): one backup opened for reading at
 * a time, as a temporary database (`whombat_peek_<12 hex>`, which the runtime's role may only read) and a read-only
 * folder. These calls and what their refusals mean to people.
 *
 *   POST   /v1/peeks {checkpointId}  → 202 {id}; 409 busy; 404 not_found; 507 no_space {needBytes, freeBytes};
 *                                       503 unavailable (not set up on this box)
 *   GET    /v1/peeks/{id}            → {id, checkpointId, state, database, root, expiresAt, error}
 *   DELETE /v1/peeks/{id}            → the peek, closed; 409 while the database is still being read
 */
import { formatBytes } from '@whombat/core/text';
import type { BackupLookProblem } from '@whombat/protocol/session';
import { z } from 'zod';
import { tServer } from '../../i18n/catalog';
import type { BackupPort } from '../../managed/backup-port';

/** What a look shows when something stops it, in plain words, in `locale`. */
export function lookText(locale?: string | null) {
  return {
    busy: tServer(locale, 'look.busy'),
    notSupported: tServer(locale, 'look.notSupported'),
    notFound: tServer(locale, 'look.notFound'),
    failed: tServer(locale, 'look.failed'),
    closed: tServer(locale, 'look.closed'),
    noRoom: (need: number | null, free: number | null) =>
      need !== null && free !== null
        ? tServer(locale, 'look.noRoomSized', { need: formatBytes(need), free: formatBytes(free) })
        : tServer(locale, 'look.noRoom'),
  };
}

/** The same words in English. */
export const LOOK_TEXT = lookText('en');

/** A problem's words in `locale`, from its code (and its sizes): what was stored in English, said again. */
export function lookProblemIn(problem: BackupLookProblem, locale?: string | null): BackupLookProblem {
  const t = lookText(locale);
  const message =
    problem.code === 'no_room'
      ? t.noRoom(problem.needBytes ?? null, problem.freeBytes ?? null)
      : problem.code === 'busy'
        ? t.busy
        : problem.code === 'not_supported'
          ? t.notSupported
          : problem.code === 'not_found'
            ? t.notFound
            : problem.code === 'closed'
              ? t.closed
              : t.failed;
  return { ...problem, message };
}

/** The peek's database: never another (the runtime connects only to this one, read-only). */
export const PEEK_DATABASE = /^whombat_peek_[0-9a-f]{12}$/;

export const PeekAnswer = z.object({
  id: z.string().min(1).max(64),
  checkpointId: z.string().max(128),
  state: z.enum(['opening', 'ready', 'failed', 'closed']),
  database: z.string().max(64).nullable().optional(),
  root: z.string().max(4096).nullable().optional(),
  expiresAt: z.string().max(64).nullable().optional(),
  error: z.string().max(2000).nullable().optional(),
});
export type PeekAnswer = z.infer<typeof PeekAnswer>;

/** The service's refusal as people read it, or null when the call went through. */
export function peekProblem(status: number, body: unknown): BackupLookProblem | null {
  if (status >= 200 && status < 300) return null;
  const err = (body as { error?: unknown } | null)?.error as
    | { code?: unknown; needBytes?: unknown; freeBytes?: unknown }
    | undefined;
  const code = typeof err?.code === 'string' ? err.code : null;
  if (status === 507 || code === 'no_space') {
    const need = typeof err?.needBytes === 'number' ? err.needBytes : null;
    const free = typeof err?.freeBytes === 'number' ? err.freeBytes : null;
    return {
      code: 'no_room',
      message: LOOK_TEXT.noRoom(need, free),
      ...(need !== null ? { needBytes: Math.max(0, Math.round(need)) } : {}),
      ...(free !== null ? { freeBytes: Math.max(0, Math.round(free)) } : {}),
    };
  }
  if (status === 409) return { code: 'busy', message: LOOK_TEXT.busy };
  // The peek's own “no such backup”; a service from before peeks answers its router's 404 without one.
  if (status === 404 && code === 'not_found') return { code: 'not_found', message: LOOK_TEXT.notFound };
  if (status === 404 || status === 405 || status === 503)
    return { code: 'not_supported', message: LOOK_TEXT.notSupported };
  return { code: 'failed', message: LOOK_TEXT.failed };
}

/** Asks the service to open a backup for reading: the peek's id, or why not. */
export async function openPeek(
  port: BackupPort,
  checkpointId: string,
): Promise<{ id: string } | { problem: BackupLookProblem }> {
  const res = await port.call('POST', '/v1/peeks', { checkpointId }, { deadlineMs: 15_000 });
  const problem = peekProblem(res.status, res.body);
  if (problem) return { problem };
  const id = (res.body as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
    return { problem: { code: 'failed', message: LOOK_TEXT.failed } };
  return { id };
}

/** The peek now; null when the service no longer knows it. */
export async function readPeek(port: BackupPort, id: string): Promise<PeekAnswer | null> {
  const res = await port.call('GET', `/v1/peeks/${encodeURIComponent(id)}`, undefined, {
    deadlineMs: 10_000,
  });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`the backup service answered ${res.status}`);
  const parsed = PeekAnswer.safeParse(res.body);
  if (!parsed.success) throw new Error('the backup service’s answer wasn’t understood');
  return parsed.data;
}

/** Closes the peek: `closed` (or already gone), or `busy` while a session on its database lingers. */
export async function closePeek(
  port: BackupPort,
  id: string,
  deadlineMs = 15_000,
): Promise<'closed' | 'busy'> {
  const res = await port.call('DELETE', `/v1/peeks/${encodeURIComponent(id)}`, undefined, { deadlineMs });
  return res.status === 409 ? 'busy' : 'closed';
}
