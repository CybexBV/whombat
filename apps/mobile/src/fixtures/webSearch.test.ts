/**
 * Web search in the demo world (Whombat web-search.md): its answers match the contracts, a key Brave turns away is
 * `validation_failed` on `apiKey` and keeps nothing, Save and Remove publish the burrow with the model on the network
 * kept, and the card's words fill in the assistant's name.
 */
import { ApiError } from '@whombat/client';
import { type AnyEndpoint, api, type Bootstrap, type Burrow, type RealtimeEvent } from '@whombat/core';
import { at } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ORIGIN } from '../data/config';
import { createClock } from '../lib/time';
import { webSearchCheckLine, webSearchKeyProblem, webSearchWords } from '../settings/webSearch';
import { createFixtureServer } from './fixture-server';

function setup(webSearch: boolean) {
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now: createClock(new Date(at('14:05')), Date.now()),
    setTimer: () => {},
    assistant: true,
    localModel: true,
    webSearch,
  });
  const events: RealtimeEvent[] = [];
  server.realtime.onEvent((event) => events.push(event));
  server.realtime.connect();
  const raw = async (ep: AnyEndpoint, path: string, init?: RequestInit) => {
    const res = await server.fetch(`${FIXTURE_ORIGIN}/api/v1/burrows/burrow-hq${path}`, init);
    const data = (await res.json()) as unknown;
    if (!res.ok) return { status: res.status, data: data as never };
    const parsed = ep.response.safeParse(data);
    if (!parsed.success) throw new Error(`${ep.id}: ${parsed.error.message}`);
    return { status: res.status, data: parsed.data as never };
  };
  const send = (method: string, body?: unknown) => ({
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const published = () =>
    events.flatMap((e) => (e.type === 'burrow.updated' ? [(e as { burrow: Burrow }).burrow] : []));
  return { raw, send, published };
}

describe('web search in the demo world', () => {
  it('is off by default; a key Brave turns away keeps nothing, a good one turns it on', async () => {
    const s = setup(false);
    const boot: { data: Bootstrap } = await s.raw(api.conversations.bootstrap, '/bootstrap');
    expect(boot.data.burrow.webSearch).toBeNull();

    const refused: { status: number; data: { error: { code: string; fields: Record<string, string[]> } } } =
      await s.raw(api.burrows.setWebSearch, '/web-search', s.send('PUT', { apiKey: 'not-a-brave-key' }));
    expect(refused.status).toBe(400);
    expect(refused.data.error.code).toBe('validation_failed');
    expect(refused.data.error.fields.apiKey).toHaveLength(1);
    expect(s.published()).toHaveLength(0);

    const saved: {
      data: { burrow: Burrow; webSearch: { provider: string; check: { state: string } | null } };
    } = await s.raw(api.burrows.setWebSearch, '/web-search', s.send('PUT', { apiKey: 'BSA-demo-key' }));
    expect(saved.data.webSearch).toMatchObject({ provider: 'brave', check: { state: 'ok' } });
    // The model on the network stays in the burrow it answers and publishes.
    expect(saved.data.burrow.localModel).toMatchObject({ model: 'llama3.3:70b' });
    expect(s.published().at(-1)).toMatchObject({
      webSearch: { provider: 'brave' },
      localModel: { model: 'llama3.3:70b' },
    });
    const after: { data: Bootstrap } = await s.raw(api.conversations.bootstrap, '/bootstrap');
    expect(after.data.burrow.webSearch).toMatchObject({ provider: 'brave' });
  });

  it('has a key when asked for; Check again keeps its result and Remove turns it off', async () => {
    const s = setup(true);
    const boot: { data: Bootstrap } = await s.raw(api.conversations.bootstrap, '/bootstrap');
    expect(boot.data.burrow.webSearch).toMatchObject({ provider: 'brave', check: { state: 'ok' } });

    const checked: { data: { check: { state: string } } } = await s.raw(
      api.burrows.testWebSearch,
      '/web-search/test',
      s.send('POST'),
    );
    expect(checked.data.check.state).toBe('ok');

    const cleared: { data: { burrow: Burrow; removed: boolean } } = await s.raw(
      api.burrows.clearWebSearch,
      '/web-search',
      { method: 'DELETE' },
    );
    expect(cleared.data.removed).toBe(true);
    expect(cleared.data.burrow.webSearch).toBeNull();
    expect(s.published().at(-1)).toMatchObject({ webSearch: null, localModel: { model: 'llama3.3:70b' } });
    const missing: { status: number } = await s.raw(
      api.burrows.testWebSearch,
      '/web-search/test',
      s.send('POST'),
    );
    expect(missing.status).toBe(404);
  });
});

describe('the web search card’s words', () => {
  it('names the assistant, capitalised where a sentence starts', () => {
    const words = webSearchWords({ name: 'Neo', Name: 'Neo' });
    expect(words.hint).toMatch(/^Let Neo search the web/);
    expect(words.removeBody).toMatch(/^Neo can/);
    const fallback = webSearchWords({ name: 'your agent', Name: 'Your agent' });
    expect(fallback.hint).toContain('Let your agent search');
    expect(fallback.removeBody).toMatch(/^Your agent can/);
  });

  it('colours the dot by the last check, and finds the key’s own problem in a refusal', () => {
    expect(webSearchCheckLine(null)).toEqual({ tone: 'ok', text: null });
    expect(webSearchCheckLine({ state: 'invalid_key', at: at('14:00'), detail: '401' }).tone).toBe('bad');
    expect(webSearchCheckLine({ state: 'out_of_credit', at: at('14:00'), detail: '402' }).tone).toBe('warn');
    const refused = new ApiError(400, 'validation_failed', 'Bad', {}, 'burrows.setWebSearch', {
      apiKey: ['Brave says no.'],
    });
    expect(webSearchKeyProblem(refused)).toBe('Brave says no.');
    expect(webSearchKeyProblem(new ApiError(500, 'internal', 'Down', {}, 'burrows.setWebSearch'))).toBeNull();
    expect(webSearchKeyProblem(new Error('offline'))).toBeNull();
  });
});
