/** What a service's settings copy is made of, and why a try didn't work (docs/decisions/outside-changes.md). */
import { externalEffect } from '../../commit/scope';
import { signedConnectionFetch } from '../../connections/http';
import { type CatalogConnectionRow, ConnectionAuthError } from '../../connections/types';
import type { Services } from '../../services';
import { ReadProblem } from '../../things/kinds/read';
import { VaultCallError, VaultEchoError } from '../../vault/net';
import type { SettingsSummary } from './summary';

/** The largest copy Whombat keeps. */
export const COPY_MAX_BYTES = 20 * 1024 * 1024;
/** One try's deadline. */
const COPY_DEADLINE_MS = 60_000;

/** Why a try didn't work, said in the person's language from the catalog (`changes.copy.problem.*`). */
export const COPY_PROBLEMS = [
  'signin',
  'notAllowed',
  'missing',
  'error',
  'tooLarge',
  'unreachable',
  'unreadable',
] as const;
export type CopyProblem = (typeof COPY_PROBLEMS)[number];

export class CopyFailed extends Error {
  override name = 'CopyFailed';
  constructor(readonly problem: CopyProblem) {
    super(problem);
  }
}

/** One try's copy: the export's bytes, as a file, and its summary (null when it couldn't be read: the last stands). */
export interface CopyTaken {
  bytes: Buffer;
  fileName: string;
  contentType: string;
  summary: SettingsSummary | null;
}

export interface CopyService {
  /** “OPNsense”. */
  name: string;
  take(services: Services, row: CatalogConnectionRow, now: Date): Promise<CopyTaken>;
}

/** A failure as the problem a try had. */
export function copyProblemOf(err: unknown): CopyProblem {
  if (err instanceof CopyFailed) return err.problem;
  if (err instanceof ConnectionAuthError) return 'signin';
  if (err instanceof VaultEchoError) return 'unreadable';
  if (err instanceof VaultCallError) return err.reason === 'too_large' ? 'tooLarge' : 'unreachable';
  if (err instanceof ReadProblem) {
    if (err.httpStatus === 401 || err.refused) return 'signin';
    if (err.httpStatus === 403) return 'notAllowed';
    if (err.httpStatus === 404) return 'missing';
    return err.httpStatus !== null ? 'error' : 'unreachable';
  }
  return 'unreachable';
}

/** The bytes of a GET as the connection, up to `COPY_MAX_BYTES`. */
export async function getBytes(
  services: Services,
  row: CatalogConnectionRow,
  path: string,
  accept = '*/*',
): Promise<Buffer> {
  const url = `${row.baseUrl.replace(/\/+$/, '')}${path}`;
  let res: Awaited<ReturnType<typeof signedConnectionFetch>>;
  try {
    res = await externalEffect(
      'things.read',
      () =>
        signedConnectionFetch(
          services,
          row,
          { method: 'GET', url, headers: { Accept: accept } },
          { maxBytes: COPY_MAX_BYTES, deadlineMs: COPY_DEADLINE_MS },
        ),
      { idempotent: true },
    );
  } catch (err) {
    throw new CopyFailed(copyProblemOf(err));
  }
  if (res.status === 401) throw new CopyFailed('signin');
  if (res.status === 403) throw new CopyFailed('notAllowed');
  if (res.status === 404) throw new CopyFailed('missing');
  if (res.status >= 400) throw new CopyFailed('error');
  return res.body;
}
