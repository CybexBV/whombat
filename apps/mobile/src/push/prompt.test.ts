import { describe, expect, it } from 'vitest';
import { memoryStore, STORAGE_KEYS } from '../lib/kv';
import { createPushPrompt, pushPromptCopy } from './prompt';

const settle = () => new Promise((ok) => setTimeout(ok, 0));

describe('the one question about notifications', () => {
  it('shows the sheet when offered, and asks the system only on Turn on', async () => {
    const prompt = createPushPrompt(memoryStore());
    const seen: boolean[] = [];
    prompt.subscribe(() => seen.push(prompt.state().shown));
    let asked = 0;
    expect(prompt.state().shown).toBe(false);
    prompt.offer(async () => {
      asked += 1;
    });
    await settle();
    expect(prompt.state()).toEqual({ shown: true, busy: false });
    expect(asked).toBe(0);
    await prompt.turnOn();
    expect(asked).toBe(1);
    expect(prompt.state().shown).toBe(false);
    expect(seen).toEqual([true, true, false]);
  });

  it('keeps Not now on this phone, also for the next offer and the next start', async () => {
    const store = memoryStore();
    const first = createPushPrompt(store);
    expect(await first.notNowKept()).toBe(false);
    first.offer(async () => {});
    await settle();
    await first.notNow();
    expect(first.state().shown).toBe(false);
    expect(store.data.has(STORAGE_KEYS.pushPrompt)).toBe(true);
    expect(await first.notNowKept()).toBe(true);
    first.offer(async () => {});
    expect(first.state().shown).toBe(false);
    const next = createPushPrompt(store);
    expect(await next.notNowKept()).toBe(true);
    next.offer(async () => {});
    await settle();
    expect(next.state().shown).toBe(false);
  });

  it('a Not now kept before this version (the Overview’s card) counts', async () => {
    const store = memoryStore({ [STORAGE_KEYS.pushPrompt]: '2026-11-01T09:00:00.000Z' });
    expect(await createPushPrompt(store).notNowKept()).toBe(true);
  });

  it('goes once notifications are decided, survives a failed ask, and isn’t Not now while the system asks', async () => {
    const prompt = createPushPrompt(memoryStore());
    prompt.offer(async () => {});
    await settle();
    prompt.withdraw();
    expect(prompt.state().shown).toBe(false);
    let answer: () => void = () => {};
    prompt.offer(() => new Promise<void>((ok) => (answer = ok)));
    await settle();
    const asking = prompt.turnOn();
    // The sheet closing under the system's question isn't a Not now.
    await prompt.notNow();
    expect(await prompt.notNowKept()).toBe(false);
    answer();
    await asking;
    expect(prompt.state()).toEqual({ shown: false, busy: false });
    prompt.offer(async () => {
      throw new Error('no push service');
    });
    await prompt.turnOn();
    expect(prompt.state()).toEqual({ shown: false, busy: false });
  });

  it('asks in the web’s words, naming the assistant', () => {
    const copy = pushPromptCopy('Dusty');
    expect(copy.title).toContain('Dusty');
    expect(copy.turnOn).toBe('Turn on');
    expect(copy.notNow).toBe('Not now');
    expect(copy.text).toContain('Settings');
    expect(pushPromptCopy(null).title).toContain('your agent');
  });
});
