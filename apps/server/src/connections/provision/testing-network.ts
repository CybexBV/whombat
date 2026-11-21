/**
 * Tests only: an in-process stub server that plays one service for a provisioner's unit test (http, or https with the
 * self-signed test certificate), and a `ProvisionInput` whose `fetch` talks straight to it (no destination policy, no
 * pinning; redirects answered, not followed, as `input.fetch` does). Every request is kept.
 */
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { catalogEntry } from '@whombat/core';
import { SELF_SIGNED_CERT_A, SELF_SIGNED_KEY_A } from '../../test/self-signed';
import { ProvisionError, type ProvisionFetch, type ProvisionInput, type ProvisionResponse } from './types';

/** The password every test signs in with: it must never show up in an error. */
export const PASSWORD = 'pw-Sesam-0pen!';

/** The clock of every test: 2026-10-08 14:05 UTC (token names end in `20261008-1405`). */
export const NOW = new Date('2026-10-08T14:05:30Z');

export interface SeenRequest {
  method: string;
  /** The path with its query. */
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface StubReply {
  status: number;
  headers?: Record<string, string | string[]>;
  /** An object is sent as JSON. */
  body?: string | object;
}

export type StubHandler = (request: SeenRequest) => StubReply | Promise<StubReply>;

export interface StubServer {
  /** `http(s)://127.0.0.1:<port>`. */
  url: string;
  requests: SeenRequest[];
  /** The requests to one path (without its query), in order. */
  to(method: string, path: string): SeenRequest[];
  close(): Promise<void>;
}

export async function startStub(handler: StubHandler, options: { tls?: boolean } = {}): Promise<StubServer> {
  const requests: SeenRequest[] = [];
  const listener = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const seen: SeenRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(seen);
      Promise.resolve()
        .then(() => handler(seen))
        .then(
          (reply) => {
            const json = typeof reply.body === 'object';
            const headers = {
              ...(json ? { 'content-type': 'application/json' } : {}),
              ...(reply.headers ?? {}),
            };
            res.writeHead(reply.status, headers);
            res.end(json ? JSON.stringify(reply.body) : (reply.body ?? ''));
          },
          (err: unknown) => {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end(String(err));
          },
        );
    });
  };
  const server = options.tls
    ? https.createServer({ cert: SELF_SIGNED_CERT_A, key: SELF_SIGNED_KEY_A }, listener)
    : http.createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    requests,
    to: (method, path) => requests.filter((r) => r.method === method && r.path.split('?')[0] === path),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** `input.fetch` for tests: a path under the base URL or a same-origin URL, straight to the stub. */
export function stubFetch(baseUrl: string): ProvisionFetch {
  const base = new URL(baseUrl);
  return (pathOrUrl, init) => {
    const target = /^https?:\/\//i.test(pathOrUrl) ? new URL(pathOrUrl) : new URL(`${baseUrl}${pathOrUrl}`);
    if (target.origin !== base.origin) return Promise.reject(new Error('Not the connection’s origin.'));
    const lib = target.protocol === 'https:' ? https : http;
    return new Promise<ProvisionResponse>((resolve, reject) => {
      const req = lib.request(
        target,
        {
          method: init.method,
          headers: { 'User-Agent': 'Whombat', ...(init.headers ?? {}) },
          rejectUnauthorized: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks);
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body,
              text: () => body.toString('utf8'),
              json: () => {
                try {
                  return JSON.parse(body.toString('utf8')) as unknown;
                } catch {
                  return null;
                }
              },
            });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
  };
}

/** A sign-in for the entry `catalogId` against the stub: `admin` with `PASSWORD`, Look only, no code. */
export function networkInput(
  catalogId: string,
  stub: Pick<StubServer, 'url'>,
  overrides: Partial<Omit<ProvisionInput, 'entry'>> = {},
): ProvisionInput {
  const entry = catalogEntry(catalogId);
  if (!entry) throw new Error(`No catalog entry ${catalogId}.`);
  const baseUrl = overrides.baseUrl ?? stub.url;
  return {
    entry,
    baseUrl,
    fields: { url: stub.url },
    account: 'admin',
    password: PASSWORD,
    code: null,
    challenge: null,
    access: 'read',
    name: 'Whombat',
    publicUrl: 'https://whombat.home.test',
    clientId: 'whombat-test-client',
    fetch: stubFetch(baseUrl),
    socket: () => Promise.reject(new Error('No sockets here.')),
    clock: () => NOW,
    ...overrides,
  };
}

/** What a promise rejected with (fails when it resolved). */
export async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('Expected a refusal, but the call succeeded.');
}

/**
 * The `ProvisionError` a sign-in stopped with; anything else fails, and so does an error whose message or fields hold
 * the password (CS-02).
 */
export async function refusalOf(promise: Promise<unknown>, password = PASSWORD): Promise<ProvisionError> {
  const err = await caught(promise);
  if (!(err instanceof ProvisionError))
    throw new Error(`Expected a ProvisionError, got ${err.name}: ${err.message}`);
  const seen = `${err.message} ${JSON.stringify({ ...err })} ${err.stack ?? ''}`;
  if (seen.includes(password)) throw new Error('The password is in the error.');
  return err;
}

/** The form fields of an `application/x-www-form-urlencoded` body. */
export function formOf(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

/** The account and password of a `Basic` authorization header, or null. */
export function basicOf(header: string | undefined): { user: string; password: string } | null {
  const match = /^Basic\s+(.+)$/i.exec(header ?? '');
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? null : { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/** The cookies a request sent, by name. */
export function cookiesOf(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}
