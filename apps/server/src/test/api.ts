/**
 * Tests call the contract's client endpoints the way the session dispatcher runs them (MR-05, hermes-engine.md HE-48):
 * in-process, as an account, through `runApiHandler` — the op allowlist, the input guards, the endpoint's Zod parsing,
 * the burrow membership check, the handler and the contract check — and read the answer like HTTP (`statusCode`,
 * `json()`), so a test states what a person's device sees. There is no HTTP client path in the product: who calls is
 * the account `sessionFor` names (`test/tokens.ts`), carried here in a `cookie` or `authorization` header for brevity.
 *
 * An attachment's bytes go as a session's streams carry them: the upload through `completeAttachmentUpload` (the
 * upload stream's own completion), the download and the thumbnail read like `openDownload` reads them (`PUT`/`GET` on
 * `ATTACHMENT_TRANSFER`'s paths). Anything else (the runner protocol, MCP, the gateway relay, the demo's controls) goes
 * to the loopback listener (`app.inject`), as the runner and agents reach it.
 */
import { createHash } from 'node:crypto';
import { parse as parseQuery } from 'node:querystring';
import { Readable } from 'node:stream';
import { type AnyEndpoint, ATTACHMENT_TRANSFER, NoBody, pathParamNames } from '@whombat/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { burrowAccess } from '../auth/request';
import { accounts, attachments } from '../db/schema/index';
import { readableAttachment } from '../files/access';
import { attachmentHeaders } from '../files/http';
import { attachmentPreview } from '../files/previews';
import { filesDir } from '../files/service';
import { ApiError, conflict, notFound, validationError } from '../lib/errors';
import { buildAllowlist, runApiHandler, SESSION_DENIED } from '../managed/dispatcher';
import { managedRefusal } from '../managed/policy';
import { completeAttachmentUpload } from '../managed/resources';
import { OutcomeReply, Raw, type RouteDef } from '../routes/define';
import { ROUTES } from '../routes/index';
import type { Services } from '../services';

/** The header value naming a test caller (`sessionFor`): `whombat_test_account=<account id>`. */
export const TEST_ACCOUNT_COOKIE = 'whombat_test_account';
/** The bearer form: `Bearer acct:<account id>`. */
export const TEST_ACCOUNT_BEARER = 'acct:';

export interface InjectOptions {
  method?: string;
  url: string;
  headers?: Record<string, string | string[] | undefined>;
  payload?: unknown;
  query?: Record<string, string | string[]>;
}

export interface InjectResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  payload: string;
  rawPayload: Buffer;
  // biome-ignore lint/suspicious/noExplicitAny: tests read answers loosely, as from HTTP
  json<T = any>(): T;
}

interface Matcher {
  def: RouteDef;
  method: string;
  pattern: RegExp;
  names: string[];
}

let matchers: Matcher[] | null = null;

function routeMatchers(): Matcher[] {
  matchers ??= ROUTES.filter((def) => def.endpoint.auth !== 'runner').map((def) => {
    const ep: AnyEndpoint = def.endpoint;
    const names = pathParamNames(ep.path);
    const source = `${ep.base}${ep.path}`
      .split('/')
      .map((part) => (part.startsWith(':') ? '([^/]+)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/');
    return { def, method: ep.method.toUpperCase(), pattern: new RegExp(`^${source}$`), names };
  });
  return matchers;
}

function header(headers: InjectOptions['headers'], name: string): string | undefined {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** The account a test request names (`sessionFor`'s cookie or bearer), or null. */
export function callerAccountId(headers: InjectOptions['headers']): string | null {
  const cookie = header(headers, 'cookie') ?? '';
  const fromCookie = new RegExp(`(?:^|;\\s*)${TEST_ACCOUNT_COOKIE}=([^;]+)`).exec(cookie)?.[1];
  if (fromCookie) return decodeURIComponent(fromCookie);
  const bearer = /^Bearer\s+(\S+)$/i.exec(header(headers, 'authorization') ?? '')?.[1];
  return bearer?.startsWith(TEST_ACCOUNT_BEARER) ? bearer.slice(TEST_ACCOUNT_BEARER.length) : null;
}

function answer(status: number, body: unknown, headers: Record<string, string> = {}): InjectResponse {
  // A JSON `null` answer is `null`, as HTTP sent it; nothing at all is an empty body.
  const raw =
    body === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const text = raw.toString('utf8');
  const contentType =
    headers['content-type'] ??
    (Buffer.isBuffer(body)
      ? 'application/octet-stream'
      : typeof body === 'string'
        ? 'text/plain'
        : 'application/json; charset=utf-8');
  return {
    statusCode: status,
    headers: { ...headers, 'content-type': contentType },
    body: text,
    payload: text,
    rawPayload: raw,
    json: () => JSON.parse(text),
  };
}

const T = ATTACHMENT_TRANSFER;
const BYTE_ROUTES = (['upload', 'download', 'thumbnail'] as const).map((kind) => ({
  kind,
  pattern: new RegExp(`^${`${T[kind].base}${T[kind].path}`.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`),
}));

/** An attachment's bytes as a session carries them, for the account a test names. */
async function bytes(
  services: Services,
  kind: 'upload' | 'download' | 'thumbnail',
  slug: string,
  attachmentId: string,
  accountId: string | null,
  o: InjectOptions,
  query: Record<string, unknown>,
): Promise<InjectResponse> {
  const [account] = accountId
    ? await services.db.select().from(accounts).where(eq(accounts.id, accountId))
    : [];
  const { principal: person } = await burrowAccess(services, { account: account ?? null }, slug).catch(() => {
    throw notFound(kind === 'upload' ? 'Upload' : 'File');
  });
  if (kind === 'upload') {
    const [row] = await services.db.select().from(attachments).where(eq(attachments.id, attachmentId));
    if (!row || row.burrowId !== person.burrowId || row.uploadedById !== person.id) throw notFound('Upload');
    if (row.state !== 'reserved') throw conflict('That file is already uploaded.');
    const data = Buffer.isBuffer(o.payload) ? o.payload : Buffer.from(String(o.payload ?? ''));
    // More bytes than reserved: a session's upload stream never takes them (its chunks stop at the reserved size).
    if (data.length > row.size)
      throw new ApiError('too_large', 'That file is larger than it said it was.', {
        details: { reason: 'size_mismatch' },
      });
    const sha256 = createHash('sha256').update(data).digest('hex');
    return answer(
      200,
      await completeAttachmentUpload(services, person, row.id, Readable.from([data]), sha256),
    );
  }
  const row = await readableAttachment(services.db, person.burrowId, person.id, attachmentId);
  if (!row?.blobKey || !row.sha256) throw notFound(kind === 'thumbnail' ? 'Thumbnail' : 'File');
  if (kind === 'thumbnail') {
    if (!row.thumbnailWidth) throw notFound('Thumbnail');
    const made = await attachmentPreview({
      filesRoot: filesDir(services.config),
      store: services.files.store,
      images: services.feedback.images,
      source: { ...row, blobKey: row.blobKey, sha256: row.sha256 },
    });
    if (!made.ok) throw notFound('Thumbnail');
    return answer(200, Buffer.from(made.preview.bytes), { 'content-type': made.preview.contentType });
  }
  const readable = await services.files.store.open(row.blobKey);
  if (!readable) throw notFound('File');
  const chunks: Buffer[] = [];
  for await (const c of readable as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
  const headers = attachmentHeaders({
    contentType: row.contentType,
    kind: row.kind,
    name: row.name,
    sha256: row.sha256,
    forceDownload: query.download === '1',
  });
  return answer(200, Buffer.concat(chunks), headers);
}

function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw validationError(r.error, `The request ${what} is not valid.`);
  return r.data;
}

function bodyOf(payload: unknown): unknown {
  if (payload === undefined || payload === null) return undefined;
  if (typeof payload === 'string') return payload.trim() ? JSON.parse(payload) : undefined;
  if (Buffer.isBuffer(payload)) return payload.length ? JSON.parse(payload.toString('utf8')) : undefined;
  return payload;
}

/** An in-process caller over `services` (and the loopback `app` for everything else). */
export function inProcessApi(
  getServices: () => Services,
  getApp: () => FastifyInstance | undefined = () => undefined,
) {
  const allowlist = buildAllowlist();
  return {
    async inject(options: InjectOptions | string): Promise<InjectResponse> {
      const o: InjectOptions = typeof options === 'string' ? { url: options } : options;
      const method = (o.method ?? 'GET').toUpperCase();
      const [path = '', rawQuery = ''] = o.url.split('?');
      for (const route of BYTE_ROUTES) {
        const hit = route.pattern.exec(path);
        if (!hit || method !== (route.kind === 'upload' ? 'PUT' : 'GET')) continue;
        try {
          return await bytes(
            getServices(),
            route.kind,
            decodeURIComponent(hit[1] ?? ''),
            decodeURIComponent(hit[2] ?? ''),
            callerAccountId(o.headers),
            o,
            { ...parseQuery(rawQuery) },
          );
        } catch (err) {
          if (err instanceof ApiError) return answer(err.status, err.toBody());
          throw err;
        }
      }
      // A static segment wins over a parameter, as in a router (`/audit/export` before `/audit/:eventId`).
      const found = routeMatchers()
        .map((m) => ({ m, hit: m.method === method ? m.pattern.exec(path) : null }))
        .filter((x) => x.hit)
        .sort((a, b) => a.m.names.length - b.m.names.length)[0];
      if (!found?.hit) {
        const app = getApp();
        if (!app) return answer(404, { error: { code: 'not_found', message: 'No such endpoint.' } });
        const res = await app.inject({
          method: method as 'GET',
          url: o.url,
          ...(o.headers ? { headers: o.headers as Record<string, string> } : {}),
          ...(o.payload !== undefined ? { payload: o.payload as string } : {}),
          ...(o.query ? { query: o.query } : {}),
        });
        return res as unknown as InjectResponse;
      }
      const { m, hit } = found;
      const ep = m.def.endpoint;
      const services = getServices();
      try {
        const resolved = allowlist.resolve(ep.id, { enrolled: true });
        if (!resolved.ok) {
          const denied = SESSION_DENIED[ep.id];
          if (denied && denied !== 'local') throw managedRefusal(denied);
          throw new ApiError('not_found', 'No such endpoint.');
        }
        const rawParams = Object.fromEntries(
          m.names.map((n, i) => [n, decodeURIComponent(hit[i + 1] ?? '')]),
        );
        const params = parseOrThrow(ep.params, rawParams, 'path');
        const query = parseOrThrow(ep.query, { ...parseQuery(rawQuery), ...o.query }, 'query');
        const body = ep.body === NoBody ? undefined : parseOrThrow(ep.body, bodyOf(o.payload), 'body');
        const accountId = callerAccountId(o.headers);
        const [account] = accountId
          ? await services.db.select().from(accounts).where(eq(accounts.id, accountId))
          : [];
        const out = await runApiHandler(services, m.def, ep.id, account ?? null, { params, query, body });
        if (out.raw instanceof Raw) return answer(out.raw.status, out.raw.body, out.raw.headers);
        return answer(ep.status, out.body);
      } catch (err) {
        if (err instanceof OutcomeReply) return answer(err.status, err.body);
        if (err instanceof ApiError) return answer(err.status, err.toBody());
        throw err;
      }
    },
  };
}

export type InProcessApi = ReturnType<typeof inProcessApi>;
