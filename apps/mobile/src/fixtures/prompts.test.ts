/**
 * The person's prompts in the demo world (prompts-phone.md): the answers match the contracts, the writes change the
 * list as the server does, using one posts the person's message in Chat and remembers where it ran, and a Whombat from
 * before prompts answers `unknown_op`.
 */
import { ApiError } from '@whombat/client';
import { api, promptLine, STARTER_PROMPTS, starterPromptId } from '@whombat/core';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { olderWhombat } from '../data/council';
import { canRestorePrompts } from '../data/prompts';
import { demoClient } from '../demo/session';
import { createClock } from '../lib/time';
import { minutesAfterSeed } from '../test/world';
import { DEFAULT_CHAT_ID } from './assistant';
import { createFixtureServer } from './fixture-server';
import type { PromptFixtureOptions } from './prompts';

const burrow = 'burrow-hq';
const params = { burrow };

function setup(prompts: Omit<PromptFixtureOptions, 'now'> = {}) {
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now: createClock(minutesAfterSeed(0), Date.now()),
    setTimer: () => {},
    prompts,
  });
  return demoClient(server.fetch);
}

async function ok<T>(p: Promise<{ status: string; data?: T }>): Promise<T> {
  const r = await p;
  if (r.status !== 'ok' || !r.data) throw new Error(r.status);
  return r.data;
}

describe('prompts in the demo world', () => {
  it('lists Whombat’s starters and one of the person’s own, valid by the contract', async () => {
    const client = setup();
    const list = api.prompts.list.response.parse(await client.prompts.list({ params }));
    expect(list.prompts.map((p) => p.id).slice(0, STARTER_PROMPTS.length)).toEqual(
      STARTER_PROMPTS.map((s) => starterPromptId(s.key)),
    );
    expect(list.prompts.some((p) => !p.starter && !p.onRepository)).toBe(true);
    expect(list.prompts[0]?.runs[0]?.title).toBe('Fusebox');
    expect(canRestorePrompts(list.prompts)).toBe(false);
  });

  it('keeps, changes and removes a prompt; bringing them back restores a starter', async () => {
    const client = setup();
    const body = { title: 'Tidy up', text: 'Tidy the code.', onRepository: true, ownIt: true, ai: null };
    const { prompt } = await ok(client.prompts.create({ params, body }));
    expect(prompt).toMatchObject({ title: 'Tidy up', starter: false });

    const first = starterPromptId(STARTER_PROMPTS[0]?.key ?? '');
    const changed = await ok(
      client.prompts.save({ params: { burrow, promptId: first }, body: { ...body, title: 'Audit' } }),
    );
    expect(changed.prompt).toMatchObject({ title: 'Audit', edited: true, starter: true });

    const removed = await ok(client.prompts.remove({ params: { burrow, promptId: prompt.id } }));
    expect(removed.prompts.some((p) => p.id === prompt.id)).toBe(false);
    expect(canRestorePrompts(removed.prompts)).toBe(true);

    const back = await ok(client.prompts.restore({ params, body: {} }));
    expect(back.prompts.find((p) => p.id === first)).toMatchObject({
      title: STARTER_PROMPTS[0]?.title,
      edited: false,
    });
    expect(canRestorePrompts(back.prompts)).toBe(false);
  });

  it('lists T3 Code’s projects, or none with why', async () => {
    const ready = api.prompts.projects.response.parse(await setup().prompts.projects({ params }));
    expect(ready.t3).toBe('ready');
    expect(ready.projects?.map((p) => p.title)).toContain('Fusebox');
    const off = await setup({ t3: 'not_connected' }).prompts.projects({ params });
    expect(off).toEqual({ projects: null, t3: 'not_connected' });
  });

  it('using one posts the person’s message in Chat and remembers the project', async () => {
    const client = setup();
    const promptId = starterPromptId('bugs');
    const used = await ok(
      client.prompts.use({
        params: { burrow, promptId },
        body: { conversationId: DEFAULT_CHAT_ID, project: { id: 'proj-shop', title: 'Shop' } },
      }),
    );
    expect(used.rootId).toBe(used.messageId);
    const page = await client.messages.list({ params: { burrow, conversationId: DEFAULT_CHAT_ID } });
    const posted = page.messages.find((m) => m.id === used.messageId);
    expect(posted?.text).toBe(promptLine('Hunt for bugs', 'Shop'));
    const list = await client.prompts.list({ params });
    expect(list.prompts.find((p) => p.id === promptId)?.runs[0]?.projectId).toBe('proj-shop');

    const reply = await ok(
      client.prompts.use({
        params: { burrow, promptId },
        body: {
          conversationId: DEFAULT_CHAT_ID,
          rootId: used.rootId,
          project: { id: 'proj-shop', title: 'Shop' },
        },
      }),
    );
    expect(reply.rootId).toBe(used.rootId);
    expect(reply.messageId).not.toBe(used.messageId);
  });

  it('a Whombat from before prompts answers unknown_op', async () => {
    const error = await setup({ older: true })
      .prompts.list({ params })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(olderWhombat(error)).toBe(true);
  });
});
