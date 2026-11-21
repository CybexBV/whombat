/**
 * The fake hosts service's HTTP pieces (`fake.ts`, `fake-manage.ts`): what a request looks like to a handler, an
 * answer, and the hub's problem answers.
 */
import type { IncomingMessage } from 'node:http';

export type Json = Record<string, unknown>;

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
  /** The body's bytes as they came (a `.tar.gz` upload). */
  raw: Buffer;
  /** `X-Whombat-Actor`, decoded from its UTF-8 bytes. */
  actor: string | null;
  role: string | null;
  clientIp: string | null;
}

export interface FakeAnswer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * A route's handler. `null` passes the request on to the next route that matches (the Incus and unRAID sides answer
 * their own guests' backups and tasks and leave the rest to the Proxmox side).
 */
export type FakeHandler = (
  req: FakeRequest,
  params: string[],
) => FakeAnswer | null | Promise<FakeAnswer | null>;

/** A problem answer as the hub sends it. */
export function problem(status: number, code: string, detail: string, extra: Json = {}): FakeAnswer {
  return {
    status,
    headers: { 'content-type': 'application/problem+json' },
    body: { code, detail, status, title: 'Problem', type: `https://rackoon.dev/problems/${code}`, ...extra },
  };
}

export const ok = (body: unknown, status = 200): FakeAnswer => ({ status, body });
