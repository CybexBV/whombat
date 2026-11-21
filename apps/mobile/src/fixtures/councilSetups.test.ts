/**
 * Settings → Neo → Council in the demo world (council.md): its answers parse as the contract has them, and Save and “Use
 * the usual rounds and score” change the one council in memory as the server does, through the fixture server.
 */
import { api } from '@whombat/core';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ORIGIN } from '../data/config';
import { createFixtureServer } from './fixture-server';

function setup(councilSetups?: { empty?: boolean }) {
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now: () => new Date('2026-11-05T12:00:00Z'),
    setTimer: () => {},
    ...(councilSetups ? { councilSetups } : {}),
  });
  const base = `${FIXTURE_ORIGIN}/api/v1/burrows/burrow-hq/councils/setup`;
  const read = async () => api.councils.setup.response.parse(await (await server.fetch(base)).json());
  const post = (path: string, body: unknown) =>
    server.fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { read, post };
}

const seats = [
  { provider: 'claudeAgent', model: 'claude-sonnet-5-5', effort: 'high' },
  { provider: 'muse', model: 'muse-wonder-full', effort: null },
];

describe('the council in the demo world’s Settings', () => {
  it('has T3 Code’s council with Mara’s rounds and score, and what T3 Code runs', async () => {
    const { read } = setup();
    const data = await read();
    expect(data.setup?.seats.map((s) => [s.model, s.effort])).toEqual([
      ['gpt-6.2-sol', 'xhigh'],
      ['claude-opus-5-5', 'xhigh'],
      ['muse-wonder-full-1.0', 'xhigh'],
      ['gemini-4-neon', 'xhigh'],
    ]);
    expect(data.setup).toMatchObject({ builder: 0, rounds: 3, target: 9 });
    expect(data.t3).toBe('ready');
    expect(data.options?.map((p) => p.id)).toEqual(['codex', 'claudeAgent', 'muse', 'antigravity']);
    expect(data.automatic).toEqual(data.setup?.seats);
  });

  it('starts with none set when asked', async () => {
    const { read } = setup({ empty: true });
    expect((await read()).setup).toBeNull();
  });

  it('saves the rounds and score in place, T3 Code’s council still sitting, and goes back to the usual', async () => {
    const { read, post } = setup();
    const res = await post('', { seats, builder: 1, rounds: 2, target: 8.5 });
    const { setup: saved } = api.councils.saveSetup.response.parse(await res.json());
    expect(saved).toMatchObject({ rounds: 2, target: 8.5 });
    const after = (await read()).setup;
    expect(after).toMatchObject({ builder: 0, rounds: 2, target: 8.5 });
    expect(after?.seats.map((s) => s.model)).toEqual([
      'gpt-6.2-sol',
      'claude-opus-5-5',
      'muse-wonder-full-1.0',
      'gemini-4-neon',
    ]);
    const reset = await post('/reset', {});
    expect(api.councils.resetSetup.response.parse(await reset.json()).setup).toBeNull();
    expect((await read()).setup).toBeNull();
  });

  it('refuses a council of one company with the server’s words', async () => {
    const { read, post } = setup();
    const one = await post('', {
      seats: [seats[0], { provider: 'claudeAgent', model: 'claude-haiku-5-5', effort: null }],
      builder: 0,
      rounds: 3,
      target: 9,
    });
    expect(one.status).toBe(400);
    expect(((await one.json()) as { error: { code: string; message: string } }).error).toMatchObject({
      code: 'validation_failed',
      message: expect.stringContaining('two different'),
    });
    expect((await read()).setup?.rounds).toBe(3);
  });
});
