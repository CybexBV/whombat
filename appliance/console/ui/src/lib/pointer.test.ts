import { describe, expect, it } from 'vitest';
import { followPointer, mouseMoved, POINTER_REST_MS } from './pointer';

function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    set(fn: () => void, ms: number) {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear(id: unknown) {
      pending.delete(id as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
  };
}

function pointer(type: string, pointerType: string, x = 0, y = 0): Event {
  return Object.assign(new Event(type), { pointerType, screenX: x, screenY: y });
}

function setup() {
  const root = { dataset: {} as DOMStringMap };
  const target = new EventTarget();
  const timers = fakeTimers();
  const stop = followPointer(root, target, timers);
  return { root, target, timers, stop };
}

describe('mouseMoved', () => {
  it('needs a mouse at another place than its last event', () => {
    expect(mouseMoved(null, 'mouse', { x: 640, y: 400 })).toBe(false);
    expect(mouseMoved({ x: 640, y: 400 }, 'mouse', { x: 640, y: 400 })).toBe(false);
    expect(mouseMoved({ x: 640, y: 400 }, 'mouse', { x: 641, y: 400 })).toBe(true);
    expect(mouseMoved({ x: 640, y: 400 }, 'touch', { x: 700, y: 400 })).toBe(false);
    expect(mouseMoved({ x: 640, y: 400 }, 'pen', { x: 700, y: 400 })).toBe(false);
  });
});

describe('followPointer', () => {
  it('stays hidden for a pointer that is only there, as when Chromium starts under it', () => {
    const { root, target } = setup();
    target.dispatchEvent(pointer('pointermove', 'mouse', 640, 400));
    target.dispatchEvent(pointer('pointermove', 'mouse', 640, 400));
    expect(root.dataset.pointer).toBeUndefined();
  });

  it('shows while the mouse moves and hides again after a rest', () => {
    const { root, target, timers } = setup();
    target.dispatchEvent(pointer('pointermove', 'mouse', 640, 400));
    target.dispatchEvent(pointer('pointermove', 'mouse', 650, 405));
    expect(root.dataset.pointer).toBe('shown');
    timers.advance(POINTER_REST_MS - 1);
    target.dispatchEvent(pointer('pointermove', 'mouse', 660, 410));
    timers.advance(POINTER_REST_MS - 1);
    expect(root.dataset.pointer).toBe('shown');
    timers.advance(1);
    expect(root.dataset.pointer).toBeUndefined();
  });

  it('shows on a mouse click, hides on a key or a touch, and never for touch', () => {
    const { root, target } = setup();
    target.dispatchEvent(pointer('pointerdown', 'mouse'));
    expect(root.dataset.pointer).toBe('shown');
    target.dispatchEvent(new Event('keydown'));
    expect(root.dataset.pointer).toBeUndefined();
    target.dispatchEvent(pointer('pointerdown', 'mouse'));
    target.dispatchEvent(pointer('pointerdown', 'touch'));
    expect(root.dataset.pointer).toBeUndefined();
    target.dispatchEvent(pointer('pointermove', 'touch', 10, 10));
    target.dispatchEvent(pointer('pointermove', 'touch', 90, 90));
    expect(root.dataset.pointer).toBeUndefined();
  });

  it('lets go when stopped', () => {
    const { root, target, stop } = setup();
    target.dispatchEvent(pointer('pointerdown', 'mouse'));
    stop();
    expect(root.dataset.pointer).toBeUndefined();
    target.dispatchEvent(pointer('pointerdown', 'mouse'));
    expect(root.dataset.pointer).toBeUndefined();
  });
});
