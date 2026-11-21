/**
 * What the agent’s reply in Chat says about what answered it, on the phone (chat-runtime-android.md
 * AP-2725…AP-2728): the mark's words, the divider in a thread when it changed, the quiet lines, and that only the Chat
 * room asks for them.
 */
import type { ChatRuntimeView, Message, RanOn } from '@whombat/core';
import { dusty, mara, PR482_MESSAGES, SEED_NOW } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { worldContext } from '../test/world';
import { ranOnView, switchedParts } from './chatRuntime';
import { chatItems } from './messages';

const base = PR482_MESSAGES[0] as Message;
let seq = 0;
const reply = (authorId: string, ranOn: RanOn | null = null): Message => ({
  ...base,
  id: `msg_cr-${++seq}`,
  authorId,
  threadRootId: 'msg_cr-root',
  replyCount: 0,
  card: null,
  createdAt: new Date(SEED_NOW.getTime() - (100 - seq) * 60_000).toISOString(),
  ranOn,
});
const opus: RanOn = { provider: 'claude', model: null, modelLabel: 'Opus', effort: 'high', fast: false };
const sol: RanOn = {
  provider: 'codex',
  model: 'gpt-6.1-sol',
  modelLabel: 'GPT-6.1 Sol',
  effort: 'high',
  fast: false,
};
const view: Pick<ChatRuntimeView, 'providers'> = {
  providers: [
    {
      provider: 'claude',
      ready: true,
      fastBlocked: null,
      usage: null,
      models: [
        { id: 'opus', label: 'Opus', description: null, efforts: ['high'], isDefault: true, fast: 'off' },
        { id: 'fable', label: 'Fable', description: null, efforts: ['high'], isDefault: false },
      ],
    },
  ],
};

describe('a reply’s ranOn (AP-2726…AP-2728)', () => {
  it('names the provider after the time and says the whole line', () => {
    const v = ranOnView({ ranOn: { ...opus, fast: true } }, undefined, null);
    expect(v).toMatchObject({ provider: 'claude', label: 'Claude', switched: null });
    expect(v?.text).toContain('Opus');
    expect(v?.text).toContain('Fast');
    expect(ranOnView({ ranOn: null }, undefined, null)).toBeNull();
  });

  it('says what didn’t happen, a skipped model by its name', () => {
    const v = ranOnView(
      { ranOn: { ...opus, model: 'opus', modelSkipped: 'fable', fastSkipped: 'busy' } },
      undefined,
      view,
    );
    expect(v?.modelSkipped).toContain('Fable');
    expect(v?.modelSkipped).toContain('Opus');
    // Fast replies that were only busy say nothing: the reply came anyway.
    expect(v?.fastSkipped).toBeNull();
  });

  it('draws the divider in a thread only, before the reply that ran on something else', () => {
    const messages = [reply(dusty.id, opus), reply(mara.id), reply(dusty.id, sol), reply(dusty.id, sol)];
    const ctx = worldContext();
    const inThread = chatItems(messages, ctx, { authors: true, threads: false, ranOn: { switches: true } });
    expect(inThread.map((i) => i.ranOn?.switched ?? null)).toEqual([null, null, expect.any(String), null]);
    expect(inThread[2]?.ranOn?.switched).toContain('ChatGPT');
    // The mark only where the model changed (with two AIs ready): not on the first reply, nor on the one after.
    const twoReady = { providers: [...view.providers, { ...view.providers[0], provider: 'codex' as const }] };
    const marked = chatItems(messages, ctx, {
      authors: true,
      threads: false,
      ranOn: { switches: true, view: twoReady as typeof view },
    });
    expect(marked.map((i) => i.ranOn?.marked ?? null)).toEqual([false, null, true, false]);
    const top = chatItems(messages, ctx, { authors: true, threads: true, ranOn: { switches: false } });
    expect(top.every((i) => !i.ranOn?.switched)).toBe(true);
    expect(top[0]?.ranOn?.label).toBe('Claude');
    expect(top.every((i) => !i.ranOn?.marked)).toBe(true);
    // Not the Chat room: nothing about what answered.
    const elsewhere = chatItems(messages, ctx, { authors: true, threads: false });
    expect(elsewhere.every((i) => i.ranOn === null)).toBe(true);
  });

  it('puts what it switched to in bold', () => {
    expect(switchedParts('Switched to ChatGPT · High effort')).toEqual({
      lead: 'Switched to ',
      bold: 'ChatGPT',
      rest: ' · High effort',
    });
    expect(switchedParts('Switched to Sonnet')).toEqual({ lead: 'Switched to ', bold: 'Sonnet', rest: '' });
    expect(switchedParts('Fast replies on')).toEqual({ lead: 'Fast replies on', bold: '', rest: '' });
  });
});
