// Test helpers for the fixture server (used by the *.test.ts files only).

import { handleApi } from './api.ts';
import { fxRequest } from './http.ts';
import { COOKIE, type FixtureStore } from './state.ts';

export interface CallResult {
  status: number;
  headers: Record<string, string | string[]>;
  /** Parsed JSON body (null when empty or not JSON). */
  json: unknown;
  text: string;
}

/** One API call as browser `cookie` (state id); non-GET calls carry a CSRF header unless csrf=false. */
export function call(store: FixtureStore, method: string, path: string, opts: { cookie?: string; body?: unknown; csrf?: boolean } = {}): CallResult {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = `${COOKIE}=${opts.cookie}`;
  if (method !== 'GET' && opts.csrf !== false) headers['x-csrf-token'] = 'test';
  const res = handleApi(store, fxRequest(method, `/api/v1${path}`, { headers, body: opts.body }));
  const text = res.body === undefined ? '' : typeof res.body === 'string' ? res.body : Buffer.from(res.body).toString('utf8');
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, text };
}

/** A browser: a fresh state id plus a bound `call`. */
export function browser(store: FixtureStore): { id: string; call: (method: string, path: string, body?: unknown) => CallResult } {
  const st = store.create();
  return { id: st.id, call: (method, path, body) => call(store, method, path, { cookie: st.id, body }) };
}
