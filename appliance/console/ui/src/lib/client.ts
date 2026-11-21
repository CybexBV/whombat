/** Talking to the local server: GET /api/state and the few POSTs, with the page's token (CG-03). */
import { parseState, type ServerState } from './api';
import { authHeaders } from './token';

export interface PostResult {
  status: number;
  body: unknown;
}

/** A POST that waits longer than its path's usual time (Talk's mic: as long as the box may take), or may be stopped. */
export interface PostOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Client {
  /** The current state; throws when the server is away or answers something the page doesn't understand. */
  state(): Promise<ServerState>;
  post(path: string, body?: unknown, options?: PostOptions): Promise<PostResult>;
  /** A JSON GET besides the state (the box's network, the installer's Wi-Fi: CG-102, CG-121). */
  get(path: string): Promise<PostResult>;
  /** A file the server sends (the desk's spoken answer, CG-44); null when it has none (404). */
  blob(path: string): Promise<Blob | null>;
}

const TIMEOUT_MS = 4000;
/**
 * Requests that take longer: a talk's question carries up to 30 s of speech (about 1.3 MB as base64); a Wi-Fi scan
 * waits up to 10 s for a fresh one, a join for the runtime's answer (15 s), the installer's join for the network and
 * an address (CG-112, CG-121); the console server waits 5 s for Bluetooth's (scan, pair, confirm, cancel,
 * disconnect, forget) and 20 s for a connect (the service waits up to 15 s for the device, CG-200).
 */
const SLOW_POSTS: Record<string, number> = {
  '/api/desk/talk': 20_000,
  '/api/network/wifi/scan': 20_000,
  '/api/network/wifi/join': 20_000,
  '/api/network/wifi/forget': 20_000,
  '/api/wifi/scan': 20_000,
  '/api/wifi/join': 60_000,
  '/api/bluetooth/scan': 8000,
  '/api/bluetooth/pair': 8000,
  '/api/bluetooth/confirm': 8000,
  '/api/bluetooth/cancel': 8000,
  '/api/bluetooth/connect': 25_000,
  '/api/bluetooth/disconnect': 8000,
  '/api/bluetooth/forget': 8000,
};

export function httpClient(token: string | null, base = ''): Client {
  const headers = authHeaders(token);
  return {
    async state() {
      const res = await fetch(`${base}/api/state`, {
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`state: HTTP ${res.status}`);
      const s = parseState(await res.json());
      if (!s) throw new Error('state: not a state this page understands');
      return s;
    },
    async post(path, body, options) {
      const timeout = AbortSignal.timeout(options?.timeoutMs ?? SLOW_POSTS[path] ?? TIMEOUT_MS);
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        signal: options?.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
      });
      return { status: res.status, body: await jsonOrNull(res) };
    },
    async get(path) {
      const res = await fetch(`${base}${path}`, {
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return { status: res.status, body: await jsonOrNull(res) };
    },
    async blob(path) {
      const res = await fetch(`${base}${path}`, {
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return res.blob();
    },
  };
}

/** 202 and 409 may have no body. */
async function jsonOrNull(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
