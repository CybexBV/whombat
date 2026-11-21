/**
 * A thread opens at its latest reply and stays at the end while its replies settle; further up, “Scroll to the end”
 * (docs/app/decisions/thread-scroll.md AP-676, AP-6450…). jsdom lays nothing out, so the list's height is faked, the
 * scroll position recorded and the resize observer called by hand.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PVE_THREAD } from '../../app/chatChannelFixtures';
import { renderApp } from '../../test/renderApp';
import { SCROLL_TO_END, useThreadScroll, waitingCardTop } from './useThreadScroll';

/** Chat's thread about pve-02's memory (`chatChannelFixtures.ts`). */
const THREAD = `/chat?thread=${PVE_THREAD}`;

let height = 4321;
const scrolled = new WeakMap<Element, number>();
const observers: (() => void)[] = [];
const original = {
  scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop'),
  scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
};
const originalObserver = globalThis.ResizeObserver;

beforeEach(() => {
  height = 4321;
  Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return scrolled.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      scrolled.set(this, value);
    },
  });
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      observers.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  for (const [name, descriptor] of Object.entries(original))
    if (descriptor) Object.defineProperty(Element.prototype, name, descriptor);
  globalThis.ResizeObserver = originalObserver;
  observers.length = 0;
  vi.restoreAllMocks();
});

/** The rows took their real size: what the browser's resize observers would hear. */
function settle(to: number) {
  height = to;
  for (const callback of observers) callback();
}

async function openThread() {
  renderApp(THREAD);
  const pane = await screen.findByRole('complementary', { name: 'Thread' });
  await within(pane).findAllByText(/ZFS cache/);
  const list = pane.querySelector('[data-thread-scroll]') as HTMLElement;
  await waitFor(() => expect(list.scrollTop).toBe(height));
  return { pane, list };
}

describe('opening a thread', () => {
  it('shows the latest reply', async () => {
    await openThread();
  });

  it('stays at the end while the replies settle', async () => {
    const { list } = await openThread();
    settle(9000);
    expect(list.scrollTop).toBe(9000);
  });

  it('leaves a reader who scrolled up where they are, with a way back to the end', async () => {
    const { pane, list } = await openThread();
    fireEvent.wheel(list, { deltaY: -400 });
    list.scrollTop = 1000;
    fireEvent.scroll(list);
    settle(6000);
    expect(list.scrollTop).toBe(1000);

    fireEvent.click(await within(pane).findByRole('button', { name: SCROLL_TO_END }));
    expect(list.scrollTop).toBe(6000);
    await waitFor(() => expect(within(pane).queryByRole('button', { name: SCROLL_TO_END })).toBeNull());
    settle(6500);
    expect(list.scrollTop).toBe(6500);
  });
});

describe('something new while the reader reads further up', () => {
  interface Shown {
    count: number;
    newest: string;
    typing?: number;
    newestMine?: boolean;
  }

  /** The hook on a bare list: its replies are faked, as their height is. */
  function Thread({ count, newest, typing = 0, newestMine = false }: Shown) {
    const listRef = useRef<HTMLDivElement>(null);
    const scroll = useThreadScroll(listRef, {
      rootId: 'root',
      count,
      newest,
      typing,
      target: null,
      newestMine,
    });
    return (
      <>
        <div ref={listRef} data-testid="list" onScroll={scroll.onScroll} />
        {scroll.away && (
          <button type="button" onClick={scroll.toEnd}>
            {SCROLL_TO_END}
          </button>
        )}
      </>
    );
  }

  /** Opens a thread of three replies and scrolls 200px up from its end (not at the end, too close for the pill). */
  function readAbove() {
    const view = render(<Thread count={3} newest="m3" />);
    const list = screen.getByTestId('list');
    expect(list.scrollTop).toBe(height);
    fireEvent.wheel(list, { deltaY: -200 });
    list.scrollTop = height - 200;
    fireEvent.scroll(list);
    expect(screen.queryByRole('button', { name: SCROLL_TO_END })).toBeNull();
    return { list, rerender: (shown: Shown) => view.rerender(<Thread {...shown} />) };
  }

  it('leaves them where they read when a reply comes in, and says there is more below', () => {
    const { list, rerender } = readAbove();
    height += 300;
    rerender({ count: 4, newest: 'm4' });
    expect(list.scrollTop).toBe(4321 - 200);
    expect(screen.getByRole('button', { name: SCROLL_TO_END })).toBeTruthy();
  });

  it('leaves them there when someone starts to work', () => {
    const { list, rerender } = readAbove();
    height += 40;
    rerender({ count: 3, newest: 'm3', typing: 1 });
    expect(list.scrollTop).toBe(4321 - 200);
    expect(screen.getByRole('button', { name: SCROLL_TO_END })).toBeTruthy();
  });

  it('takes them to the end with their own reply', () => {
    const { list, rerender } = readAbove();
    height += 80;
    rerender({ count: 4, newest: 'm4', newestMine: true });
    expect(list.scrollTop).toBe(height);
    expect(screen.queryByRole('button', { name: SCROLL_TO_END })).toBeNull();
  });

  it('follows a reader at the end once their scroll is over, and the pill goes when they get there', () => {
    const { list, rerender } = readAbove();
    height += 300;
    rerender({ count: 4, newest: 'm4' });
    fireEvent.wheel(list, { deltaY: 400 });
    list.scrollTop = height;
    fireEvent.scroll(list);
    expect(screen.queryByRole('button', { name: SCROLL_TO_END })).toBeNull();
    // Still under their wheel: a reply doesn't move the list.
    height += 300;
    rerender({ count: 5, newest: 'm5' });
    expect(list.scrollTop).toBe(height - 300);
    // Their scroll is over.
    const later = performance.now() + 1000;
    vi.spyOn(performance, 'now').mockReturnValue(later);
    list.scrollTop = height;
    height += 300;
    rerender({ count: 6, newest: 'm6' });
    expect(list.scrollTop).toBe(height);
  });
});

describe('a tall card at the end that waits for the person', () => {
  /** A list with its last row holding a card of this mark and height; jsdom lays nothing out, so sizes are faked. */
  function listWith(mark: string, cardHeight: number) {
    const list = document.createElement('div');
    list.innerHTML = `<div data-message-id="m1"></div><div data-message-id="m2"><section data-card="delegation" data-mark="${mark}"></section></div>`;
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 600 });
    list.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    const card = list.querySelector('section') as HTMLElement;
    card.getBoundingClientRect = () => ({ top: 2000, height: cardHeight }) as DOMRect;
    list.scrollTop = 1500;
    return list;
  }

  it('opens at its top, so what it is comes before what to press', () => {
    expect(waitingCardTop(listWith('waiting', 800))).toBe(2000 - 100 + 1500 - 12);
  });

  it('opens at the end when it fits, or doesn’t wait for the person', () => {
    expect(waitingCardTop(listWith('waiting', 300))).toBeNull();
    expect(waitingCardTop(listWith('working', 800))).toBeNull();
  });
});
