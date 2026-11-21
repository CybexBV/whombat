/**
 * What the storage kinds share to talk to their services (service-dashboards.md SD-S05, SD-S17): a read as the
 * connection (`signedConnectionFetch`: its policy, its credential, its session for Synology and QNAP) with the headers a
 * service needs (Nextcloud's `OCS-APIRequest`), a POST that only reads (Immich's search), JSON or text (QNAP's XML);
 * an error status as a `StatusProblem` so a part an older version doesn't have (404, 405) is left out. Buttons use
 * `kinds/act.ts` (`actAs`).
 */
import { externalEffect } from '../../../commit/scope';
import { signedConnectionFetch } from '../../../connections/http';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { KIND_DEADLINE_MS, KIND_MAX_BYTES, problemOf, ReadProblem } from '../read';

/** An answer with an error status: `missing` (404, 405) means this version hasn't got it. */
export class StatusProblem extends ReadProblem {
  constructor(
    message: string,
    readonly status: number,
    refused = false,
  ) {
    super(message, refused);
  }

  get missing(): boolean {
    return this.status === 404 || this.status === 405 || this.status === 501;
  }
}

export interface ReadRequest {
  path: string;
  query?: Record<string, string>;
  /** A POST that only reads (Immich's `/api/search/metadata`). */
  method?: 'GET' | 'POST';
  /** JSON for a POST. */
  body?: unknown;
  headers?: Record<string, string>;
  maxBytes?: number;
}

/** A URL on the connection's base. */
export function urlOf(
  row: Pick<CatalogConnectionRow, 'baseUrl'>,
  path: string,
  query: Record<string, string> = {},
) {
  const search = new URLSearchParams(query).toString();
  return `${row.baseUrl.replace(/\/+$/, '')}${path}${search ? `?${search}` : ''}`;
}

/** The raw answer of a read as the connection; a refusal or an error status is a `ReadProblem`. */
export async function readRaw(
  services: Services,
  row: CatalogConnectionRow,
  name: string,
  req: ReadRequest,
): Promise<{ status: number; body: Buffer }> {
  const method = req.method ?? 'GET';
  let res: Awaited<ReturnType<typeof signedConnectionFetch>>;
  try {
    res = await externalEffect(
      'things.read',
      () =>
        signedConnectionFetch(
          services,
          row,
          {
            method,
            url: urlOf(row, req.path, req.query),
            headers: {
              Accept: 'application/json',
              ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
              ...req.headers,
            },
            ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
          },
          { maxBytes: req.maxBytes ?? KIND_MAX_BYTES, deadlineMs: KIND_DEADLINE_MS },
        ),
      { idempotent: true },
    );
  } catch (err) {
    throw problemOf(err, name);
  }
  if (res.status === 401 || res.status === 403)
    throw new StatusProblem(`${name} refused Whombat’s sign-in.`, res.status, res.status === 401);
  if (res.status >= 400) throw new StatusProblem(`${name} answered with an error.`, res.status);
  return { status: res.status, body: res.body };
}

/** The answer's JSON. */
export async function readJson(
  services: Services,
  row: CatalogConnectionRow,
  name: string,
  req: ReadRequest,
): Promise<unknown> {
  const { body } = await readRaw(services, row, name, req);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new ReadProblem(`${name} answered with something Whombat can’t read.`);
  }
}

/** The answer's text (QNAP's XML). */
export async function readText(
  services: Services,
  row: CatalogConnectionRow,
  name: string,
  req: ReadRequest,
): Promise<string> {
  const { body } = await readRaw(services, row, name, {
    ...req,
    headers: { Accept: 'application/xml, text/xml, */*', ...req.headers },
  });
  return body.toString('utf8');
}

/** An optional part (SD-S05): null when it fails, so the rest of the page stays. */
export const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/** A part this version or this key hasn't got (404, 405; 403 too when `forbiddenToo`): null; other failures throw. */
export async function ifPresent<T>(p: Promise<T>, { forbiddenToo = false } = {}): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof StatusProblem && (err.missing || (forbiddenToo && err.status === 403))) return null;
    throw err;
  }
}
