import { describe, expect, it } from 'vitest';
import { memoryStore, STORAGE_KEYS } from '../lib/kv';
import { createPushPrompt, PUSH_PROMPT_COPY } from './prompt';

const settle = () => new Promise((ok) => setTimeout(ok, 0));

describe('notifications are asked for with a reason first (MN-05)', () => {
  it('shows the card while the system hasn’t asked, and asks only on “Turn on”', async () => {
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

  it('“Not now” keeps the card away on this phone, also for the next offer and the next start', async () => {
    const store = memoryStore();
    const first = createPushPrompt(store);
    first.offer(async () => {});
    await settle();
    await first.notNow();
    expect(first.state().shown).toBe(false);
    expect(store.data.has(STORAGE_KEYS.pushPrompt)).toBe(true);
    first.offer(async () => {});
    expect(first.state().shown).toBe(false);
    const next = createPushPrompt(store);
    next.offer(async () => {});
    await settle();
    expect(next.state().shown).toBe(false);
  });

  it('goes once notifications are decided, and survives a failed ask', async () => {
    const prompt = createPushPrompt(memoryStore());
    prompt.offer(async () => {});
    await settle();
    prompt.withdraw();
    expect(prompt.state().shown).toBe(false);
    prompt.offer(async () => {
      throw new Error('no push service');
    });
    await settle();
    await prompt.turnOn();
    expect(prompt.state()).toEqual({ shown: false, busy: false });
    // The bridge offers again while the system still hasn't asked.
    prompt.offer(async () => {});
    expect(prompt.state().shown).toBe(true);
  });

  it('says what notifications are for, in the app’s words', () => {
    expect(PUSH_PROMPT_COPY.turnOn).toBe('Turn on');
    expect(PUSH_PROMPT_COPY.notNow).toBe('Not now');
    expect(PUSH_PROMPT_COPY.text).toContain('’');
  });
});
