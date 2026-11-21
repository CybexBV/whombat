/** The phone's toast with Undo (quiet-notices-mobile.md AP-4864): how long it stays, Undo once, one at a time. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_TOAST_MS, createToastStore, SLOW_TOAST_FACTOR, showToast, toasts } from './toast';

describe('the toast with Undo (AP-4864)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    toasts.dismiss();
    vi.useRealTimers();
  });

  it('goes after 2.6 s, after 8 s with Undo, and twice as long while TalkBack is on', () => {
    const store = createToastStore();
    store.show('Saved.');
    vi.advanceTimersByTime(2599);
    expect(store.get()?.text).toBe('Saved.');
    vi.advanceTimersByTime(1);
    expect(store.get()).toBeNull();
    store.show('Ignored. You’ll hear if it changes.', { action: { label: 'Undo', onPress: () => {} } });
    vi.advanceTimersByTime(ACTION_TOAST_MS - 1);
    expect(store.get()?.action?.label).toBe('Undo');
    vi.advanceTimersByTime(1);
    expect(store.get()).toBeNull();
    store.setSlow(true);
    store.show('I’ll remind you tomorrow.', { action: { label: 'Undo', onPress: () => {} } });
    vi.advanceTimersByTime(ACTION_TOAST_MS * SLOW_TOAST_FACTOR - 1);
    expect(store.get()).not.toBeNull();
  });

  it('keeps Undo at least as long as Android asks for, and until dismissed while VoiceOver is on', () => {
    const store = createToastStore();
    const undo = { label: 'Undo', onPress: () => {} };
    expect(ACTION_TOAST_MS).toBe(8000);
    store.setActionFloor(12_000);
    store.show('Settled.', { action: undo });
    vi.advanceTimersByTime(11_999);
    expect(store.get()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(store.get()).toBeNull();
    store.setStay(true);
    const id = store.show('Settled.', { action: undo });
    vi.advanceTimersByTime(60_000);
    expect(store.get()?.id).toBe(id);
    // A plain toast still goes by itself.
    store.show('Saved.');
    vi.advanceTimersByTime(2600);
    expect(store.get()).toBeNull();
  });

  it('stays as long as asked when a toast says (“Thread settled.” for 5 s, chat-settle.md AP-6151)', () => {
    const store = createToastStore();
    store.show('Thread settled.', { action: { label: 'Undo', onPress: () => {} }, ms: 5000 });
    vi.advanceTimersByTime(4999);
    expect(store.get()?.text).toBe('Thread settled.');
    vi.advanceTimersByTime(1);
    expect(store.get()).toBeNull();
  });

  it('runs Undo once and goes; a newer toast takes the place of the one showing', () => {
    const store = createToastStore();
    const undo = vi.fn();
    const first = store.show('Ignored. You’ll hear if it changes.', {
      action: { label: 'Undo', onPress: undo },
    });
    const second = store.show('Whombat stopped watching Hallway AP.', {
      action: { label: 'Undo', onPress: undo },
    });
    store.press(first);
    expect(undo).not.toHaveBeenCalled();
    expect(store.get()?.id).toBe(second);
    store.press(second);
    store.press(second);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(store.get()).toBeNull();
  });

  it('shows Undo only with something to take back, and nothing for blank words', () => {
    const undo = vi.fn();
    showToast('Ignored. You’ll hear if it changes.', { undo });
    expect(toasts.get()?.action?.label).toBe('Undo');
    showToast('Saved.');
    expect(toasts.get()).toMatchObject({ text: 'Saved.', action: null });
    showToast('  ');
    expect(toasts.get()?.text).toBe('Saved.');
  });
});
