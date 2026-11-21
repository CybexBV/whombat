/**
 * A model on the burrow's network in the demo world (hermes-engine-app.md AP-5126): its answers match the contracts,
 * a save tests at once, a draft is only tried, Remove takes Local out of the Chat picker.
 */
import {
  type AnyEndpoint,
  api,
  type Bootstrap,
  type ChatRuntimeView,
  type RealtimeEvent,
} from '@whombat/core';
import { at } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ORIGIN } from '../data/config';
import { createClock } from '../lib/time';
import { createFixtureServer } from './fixture-server';

function setup(localModel: boolean) {
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now: createClock(new Date(at('14:05')), Date.now()),
    setTimer: () => {},
    assistant: true,
    localModel,
  });
  const events: RealtimeEvent[] = [];
  server.realtime.onEvent((event) => events.push(event));
  server.realtime.connect();
  const raw = async (ep: AnyEndpoint, path: string, init?: RequestInit) => {
    const res = await server.fetch(`${FIXTURE_ORIGIN}/api/v1/burrows/burrow-hq${path}`, init);
    const data = (await res.json()) as unknown;
    const parsed = ep.response.safeParse(data);
    if (!parsed.success) throw new Error(`${ep.id}: ${parsed.error.message}`);
    return { status: res.status, data: parsed.data as never };
  };
  const send = (method: string, body: unknown) => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { raw, send, events };
}

const providersOf = (view: ChatRuntimeView) => view.providers.map((p) => p.provider);

describe('a model on the network in the demo world', () => {
  it('has Llama on the NAS when asked for, in the bootstrap and as Local in the Chat picker', async () => {
    const s = setup(true);
    const boot: { data: Bootstrap } = await s.raw(api.conversations.bootstrap, '/bootstrap');
    expect(boot.data.burrow.localModel).toMatchObject({ model: 'llama3.3:70b', hasApiKey: true });
    const view: { data: ChatRuntimeView } = await s.raw(api.chats.runtime, '/chats/runtime');
    expect(providersOf(view.data)).toEqual(['claude', 'codex', 'local']);
    expect(view.data.providers[2]?.models.map((m) => m.id)).toEqual(['llama3.3:70b', 'qwen3:32b']);
  });

  it('has none by default, and a save tests at once and publishes the burrow', async () => {
    const s = setup(false);
    const boot: { data: Bootstrap } = await s.raw(api.conversations.bootstrap, '/bootstrap');
    expect(boot.data.burrow.localModel).toBeNull();
    const saved: { data: { localModel: { check: { state: string } | null; hasApiKey: boolean } } } =
      await s.raw(
        api.burrows.setLocalModel,
        '/local-model',
        s.send('PUT', { baseUrl: 'http://192.168.1.20:11434/v1', model: 'qwen3:32b', apiKey: 'sk-local' }),
      );
    expect(saved.data.localModel).toMatchObject({ hasApiKey: true, check: { state: 'ok' } });
    expect(s.events.some((e) => e.type === 'burrow.updated')).toBe(true);
    const view: { data: ChatRuntimeView } = await s.raw(api.chats.runtime, '/chats/runtime');
    expect(providersOf(view.data)).toContain('local');
  });

  it('only tries a draft, keeps the saved one’s test, and Remove takes Local out', async () => {
    const s = setup(true);
    const tried: { data: { check: { state: string } } } = await s.raw(
      api.burrows.testLocalModel,
      '/local-model/test',
      s.send('POST', { draft: { baseUrl: 'http://192.168.1.20:11434/v1', model: 'phi-9' } }),
    );
    expect(tried.data.check.state).toBe('no_model');
    const again: { data: { check: { state: string } } } = await s.raw(
      api.burrows.testLocalModel,
      '/local-model/test',
      s.send('POST', {}),
    );
    expect(again.data.check.state).toBe('ok');
    const cleared: { data: { removed: boolean } } = await s.raw(api.burrows.clearLocalModel, '/local-model', {
      method: 'DELETE',
    });
    expect(cleared.data.removed).toBe(true);
    const view: { data: ChatRuntimeView } = await s.raw(api.chats.runtime, '/chats/runtime');
    expect(providersOf(view.data)).toEqual(['claude', 'codex']);
  });
});
