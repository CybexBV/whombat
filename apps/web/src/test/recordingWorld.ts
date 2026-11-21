import { vi } from 'vitest';
import { createWebFixtureFetch, type WebFixtureOptions } from '../app/fixtureFetch';

export interface RecordedCall {
  method: string;
  /** The API path without `/api/v1`. */
  path: string;
  body: unknown;
}

/**
 * The web fixture world (`createWebFixtureFetch(options)`), recording every write with its body. `answer` may change
 * an answer (its path, the world's response) before the app reads it — a refusal, an older answer.
 */
export function recordingWorld(
  options: WebFixtureOptions = {},
  answer?: (call: RecordedCall, response: Response) => Response | Promise<Response>,
) {
  const world = createWebFixtureFetch(options);
  const calls: RecordedCall[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const req = input instanceof Request ? input : new Request(url, init);
    const path = url.pathname.replace('/api/v1', '');
    const text = req.method === 'GET' ? '' : await req.clone().text();
    const call = { method: req.method, path, body: text ? JSON.parse(text) : undefined };
    if (req.method !== 'GET') calls.push(call);
    const res = await world(req);
    return answer ? answer(call, res) : res;
  });
  return { fetch, calls };
}

/** A JSON answer, for `answer`. */
export function jsonAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
