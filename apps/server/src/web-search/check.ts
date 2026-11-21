/**
 * Checking a Brave Search key (Whombat web-search.md): one search for “whombat”, at most 15 s, through
 * `lib/outbound.ts` (https to a public address only, no redirect followed, at most 1 MiB read). What Brave answers
 * becomes a `WebSearchCheck`: results are `ok`; a key it turns away `invalid_key` (an unknown key is a 422
 * `SUBSCRIPTION_TOKEN_INVALID`); no searches left on the plan `out_of_credit`; anything else `unreachable`. The key
 * goes only in Brave's own header and never into what the check says.
 *
 * Tests answer for Brave through `useWebSearchNetForTests` (refused outside `NODE_ENV=test`), without the network.
 */
import type { WebSearchCheck, WebSearchCheckState } from '@whombat/core';
import { outboundErrorOf, outboundRequest } from '../lib/outbound';
import type { Services } from '../services';

/** The longest a check takes, connect to last byte (`burrows.setWebSearch`, `burrows.testWebSearch`). */
export const WEB_SEARCH_CHECK_MS = 15_000;
/** The one search a check makes: a single result is enough to know the key works. */
export const BRAVE_SEARCH_CHECK_URL = 'https://api.search.brave.com/res/v1/web/search?q=whombat&count=1';
/** The most bytes read of an answer. */
const ANSWER_MAX_BYTES = 1024 * 1024;
/** `WebSearchCheck.detail`'s bound. */
const DETAIL_MAX = 500;

/** What Brave answered: a status and its body, or why there was no answer. */
export type BraveAnswer = { status: number; body: Buffer } | { failed: string };

/** One request to Brave (tests only replace it). */
export type BraveRequest = (
  url: string,
  headers: Record<string, string>,
  deadlineMs: number,
) => Promise<BraveAnswer>;

const systemRequest: BraveRequest = async (url, headers, deadlineMs) => {
  try {
    const res = await outboundRequest(
      url,
      { method: 'GET', headers },
      { deadlineMs, timeoutMs: deadlineMs, maxBytes: ANSWER_MAX_BYTES },
    );
    return { status: res.status, body: res.body };
  } catch (err) {
    return { failed: outboundErrorOf(err).message };
  }
};

const overrides = new WeakMap<Services, { request: BraveRequest; testMs?: number }>();

/** Tests only: answers for Brave without the network, and a shorter whole check. Refused outside `NODE_ENV=test`. */
export function useWebSearchNetForTests(
  services: Services,
  net: { request: BraveRequest; testMs?: number },
): void {
  if (services.config.NODE_ENV !== 'test') throw new Error('The web search network seam is for tests only.');
  overrides.set(services, net);
}

/** A text for the person, one line, within the bound, the key never in it. */
function detailText(text: string, key: string): string | null {
  // Control characters (a server's own error text) become spaces.
  const flat = [...text].map((c) => (c < ' ' || c === '\u007f' ? ' ' : c)).join('');
  const line = flat.split(key).join('…').replace(/\s+/g, ' ').trim();
  return line ? line.slice(0, DETAIL_MAX) : null;
}

/** What Brave's error answer says (`{"error":{"code","detail"}}`), else the start of the body. */
function braveSaid(body: Buffer): string | null {
  const text = body.toString('utf8');
  try {
    const json = JSON.parse(text) as { error?: unknown; message?: unknown };
    const error = json.error as { code?: unknown; detail?: unknown } | string | undefined;
    if (typeof error === 'string') return error;
    const code = typeof error?.code === 'string' ? error.code : null;
    const detail = typeof error?.detail === 'string' ? error.detail : null;
    if (code || detail) return [code, detail].filter(Boolean).join(': ');
    return typeof json.message === 'string' ? json.message : null;
  } catch {
    return text.trim() ? text.slice(0, 200) : null;
  }
}

/** Whether a body is JSON (a 200 that isn't is no answer Whombat can read). */
function isJson(body: Buffer): boolean {
  try {
    JSON.parse(body.toString('utf8'));
    return true;
  } catch {
    return false;
  }
}

/** How a check went, from what Brave answered. `key`: kept out of the detail. */
export function webSearchCheckOf(answer: BraveAnswer, key: string, at: string): WebSearchCheck {
  const result = (state: WebSearchCheckState, detail: string | null): WebSearchCheck => ({
    state,
    at,
    detail: state === 'ok' || !detail ? null : detailText(detail, key),
  });
  if ('failed' in answer) return result('unreachable', answer.failed);
  const { status, body } = answer;
  if (status === 200 && isJson(body)) return result('ok', null);
  const said = braveSaid(body);
  const detail = said ? `HTTP ${status} · ${said}` : `HTTP ${status}`;
  if (status === 401 || status === 403 || status === 422) return result('invalid_key', detail);
  if (status === 402 || status === 429) return result('out_of_credit', detail);
  return result('unreachable', status === 200 ? 'HTTP 200 · an answer that isn’t JSON' : detail);
}

/** Checks a key with one search, within `WEB_SEARCH_CHECK_MS`. Never throws. */
export async function checkWebSearchKey(services: Services, key: string): Promise<WebSearchCheck> {
  const net = overrides.get(services);
  const total = net?.testMs ?? WEB_SEARCH_CHECK_MS;
  const request = net?.request ?? systemRequest;
  const headers = { 'X-Subscription-Token': key, Accept: 'application/json' };
  let timer: NodeJS.Timeout | undefined;
  const answer = await Promise.race([
    request(BRAVE_SEARCH_CHECK_URL, headers, total).catch(
      (err: unknown): BraveAnswer => ({ failed: outboundErrorOf(err).message }),
    ),
    new Promise<BraveAnswer>((resolve) => {
      timer = setTimeout(() => resolve({ failed: `No answer within ${total} ms.` }), total);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return webSearchCheckOf(answer, key, services.clock().toISOString());
}
