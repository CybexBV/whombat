/**
 * Web search, the pure parts (web-search.md): what Brave's answer to one search means, the view without the key, the
 * sealed key bound to its burrow, and which turns get it.
 */
import { describe, expect, it } from 'vitest';
import { KeyCustody } from '../keys/custody';
import { type BraveAnswer, webSearchCheckOf } from './check';
import {
  openWebSearchKey,
  sealWebSearchKey,
  webSearchDispatch,
  webSearchKeyOf,
  webSearchView,
} from './store';

const AT = '2026-11-15T10:00:00.000Z';
const KEY = 'BSA-test-key-one';

const answer = (status: number, body: unknown): BraveAnswer => ({
  status,
  body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
});
const stateOf = (a: BraveAnswer) => webSearchCheckOf(a, KEY, AT).state;

describe('what Brave’s answer means', () => {
  it('results are ok, with no detail', () => {
    expect(webSearchCheckOf(answer(200, { type: 'search', web: { results: [] } }), KEY, AT)).toEqual({
      state: 'ok',
      at: AT,
      detail: null,
    });
  });

  it('a key Brave turns away is invalid_key, with its code', () => {
    const unknown = answer(422, {
      type: 'ErrorResponse',
      error: {
        status: 422,
        code: 'SUBSCRIPTION_TOKEN_INVALID',
        detail: 'The provided subscription token is invalid.',
      },
    });
    const check = webSearchCheckOf(unknown, KEY, AT);
    expect(check.state).toBe('invalid_key');
    expect(check.detail).toContain('422');
    expect(check.detail).toContain('SUBSCRIPTION_TOKEN_INVALID');
    expect(stateOf(answer(401, {}))).toBe('invalid_key');
    expect(stateOf(answer(403, 'forbidden'))).toBe('invalid_key');
  });

  it('no searches left is out_of_credit', () => {
    expect(stateOf(answer(402, { error: { code: 'PAYMENT_REQUIRED' } }))).toBe('out_of_credit');
    expect(stateOf(answer(429, { error: { code: 'RATE_LIMITED' } }))).toBe('out_of_credit');
  });

  it('anything else, no answer or one that isn’t JSON is unreachable', () => {
    expect(stateOf(answer(500, 'oops'))).toBe('unreachable');
    expect(stateOf(answer(301, ''))).toBe('unreachable');
    expect(stateOf(answer(200, '<html>'))).toBe('unreachable');
    const failed = webSearchCheckOf({ failed: 'No answer within 15000 ms.' }, KEY, AT);
    expect(failed).toMatchObject({ state: 'unreachable', detail: 'No answer within 15000 ms.' });
  });

  it('the detail is one bounded line and never holds the key', () => {
    const echoed = webSearchCheckOf(answer(401, { error: { detail: `bad token ${KEY}\n\nagain` } }), KEY, AT);
    expect(echoed.detail).not.toContain(KEY);
    expect(echoed.detail).not.toContain('\n');
    expect(webSearchCheckOf(answer(500, 'x'.repeat(2000)), KEY, AT).detail?.length).toBeLessThanOrEqual(500);
  });
});

describe('the stored key and view', () => {
  const custody = new KeyCustody(undefined);
  const stored = { provider: 'brave' as const, check: null, updatedAt: AT };

  it('opens only on its own burrow', () => {
    const sealed = sealWebSearchKey(custody, 'brw_a', KEY);
    expect(sealed).not.toContain(KEY);
    expect(openWebSearchKey(custody, 'brw_a', sealed)).toBe(KEY);
    expect(webSearchKeyOf(custody, { id: 'brw_b', webSearchKeyEnc: sealed })).toBeNull();
    expect(webSearchKeyOf(custody, { id: 'brw_a', webSearchKeyEnc: null })).toBeNull();
  });

  it('the view is null while off and never carries the key', () => {
    expect(webSearchView({ webSearch: null })).toBeNull();
    expect(webSearchView({ webSearch: stored })).toEqual(stored);
  });

  it('a turn gets the key only when it is the person’s and the key opens', () => {
    const burrow = {
      id: 'brw_a',
      webSearch: stored,
      webSearchKeyEnc: sealWebSearchKey(custody, 'brw_a', KEY),
    };
    expect(webSearchDispatch(custody, burrow, true)).toEqual({ v: 1, provider: 'brave', apiKey: KEY });
    expect(webSearchDispatch(custody, burrow, false)).toBeNull();
    expect(webSearchDispatch(custody, { ...burrow, webSearch: null }, true)).toBeNull();
    expect(webSearchDispatch(custody, { ...burrow, id: 'brw_b' }, true)).toBeNull();
  });
});
