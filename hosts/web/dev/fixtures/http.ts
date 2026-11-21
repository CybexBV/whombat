// Small HTTP layer of the fixture server. Handlers work on plain request /
// response objects (FxRequest -> FxResponse) so the tests can drive them
// without sockets; plugin.ts adapts them to Node's req/res.

import { STATUS_CODES, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Problem } from '../../src/api/types.ts';

export interface FxRequest {
  method: string;
  /** Path below /api/v1 without a trailing slash, e.g. "/servers/basalt". */
  path: string;
  query: URLSearchParams;
  /** Lower-case header names (Node style). */
  headers: IncomingHttpHeaders;
  /** Parsed JSON body; undefined when the body was empty. */
  body: unknown;
  /** The body was not valid JSON. */
  bodyInvalid: boolean;
  /** Peer address (audit client_ip). */
  ip: string;
  /** Host header (install command). */
  host: string;
}

export interface FxResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body?: string | Uint8Array;
  /** Long-lived responses (SSE): take over the Node response. */
  stream?: (req: IncomingMessage, res: ServerResponse) => void;
}

/** Build an FxRequest for tests (and the adapter). */
export function fxRequest(method: string, pathAndQuery: string, init: { headers?: IncomingHttpHeaders; body?: unknown; ip?: string; host?: string } = {}): FxRequest {
  const url = new URL(pathAndQuery, 'http://fixtures.local');
  return {
    method,
    path: url.pathname.replace(/^\/api\/v1/, '').replace(/\/$/, '') || '/',
    query: url.searchParams,
    headers: init.headers ?? {},
    body: init.body,
    bodyInvalid: false,
    ip: init.ip ?? '127.0.0.1',
    host: init.host ?? '127.0.0.1:5173',
  };
}

export function json(status: number, body: unknown, cache = 'no-store'): FxResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache },
    body: JSON.stringify(body),
  };
}

export function noContent(): FxResponse {
  return { status: 204, headers: { 'Cache-Control': 'no-store' } };
}

/** Hub-style problem+json (internal/hub/http.go writeProblem). */
export function problem(status: number, code: string, detail: string): FxResponse {
  const body: Problem = { type: `https://rackoon.dev/problems/${code}`, title: STATUS_CODES[status] ?? 'Error', status, detail, code };
  return { status, headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

/** The original fixture-server problem shape, kept for the read endpoints. */
export function legacyProblem(status: number, title: string, code: string, detail?: string): FxResponse {
  const body: Problem = { type: 'about:blank', title, status, code, ...(detail ? { detail } : {}) };
  return { status, headers: { 'Content-Type': 'application/problem+json' }, body: JSON.stringify(body) };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function header(req: FxRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** The body as a plain object ({} when empty or not an object). */
export function bodyObject(req: FxRequest): Record<string, unknown> {
  const b = req.body;
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

/** FIXTURE_TIME=live: shift every ISO timestamp in a response body. */
export function shiftTimes(value: unknown, offsetMs: number): unknown {
  if (offsetMs === 0) return value;
  if (typeof value === 'string') {
    return ISO_RE.test(value) ? new Date(Date.parse(value) + offsetMs).toISOString().replace('.000Z', 'Z') : value;
  }
  if (Array.isArray(value)) return value.map((v) => shiftTimes(v, offsetMs));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = shiftTimes(v, offsetMs);
    return out;
  }
  return value;
}

const BODY_LIMIT = 1 << 20;

/** Read and parse a JSON request body (at most 1 MiB). */
export async function readJsonBody(req: IncomingMessage): Promise<{ body: unknown; invalid: boolean }> {
  if (req.method === 'GET' || req.method === 'HEAD') return { body: undefined, invalid: false };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.length;
    if (size > BODY_LIMIT) return { body: undefined, invalid: true };
    chunks.push(b);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return { body: undefined, invalid: false };
  try {
    return { body: JSON.parse(text) as unknown, invalid: false };
  } catch {
    return { body: undefined, invalid: true };
  }
}

export function writeResponse(req: IncomingMessage, res: ServerResponse, r: FxResponse): void {
  res.statusCode = r.status;
  for (const [k, v] of Object.entries(r.headers)) {
    // Several handlers may add cookies; never drop one already set.
    if (k.toLowerCase() === 'set-cookie') {
      const prev = res.getHeader('Set-Cookie');
      const list = [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), ...(Array.isArray(v) ? v : [v])];
      res.setHeader('Set-Cookie', list);
    } else {
      res.setHeader(k, v);
    }
  }
  if (r.stream) {
    r.stream(req, res);
    return;
  }
  res.end(r.body);
}
