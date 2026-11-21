/**
 * The burrow shell's own quiet states (TODO 16.4): the loading frame while the bootstrap is in
 * flight, the whole-frame error when it fails, and the small "Reconnecting…" pill driven by the
 * realtime socket's status — independent of whatever screen is mounted underneath.
 *
 * `ShellError` and the realtime pill are exercised as units, wrapped only in the provider they need
 * (`WhombatClientProvider`). Going through the full router instead is not useful here: the
 * burrow layout route's `loader` calls `ensureQueryData` for the bootstrap and, on failure, that throw is
 * caught by the *root* route's `errorComponent` (`ErrorPage`, in `router.tsx`) before `BurrowShell`
 * ever mounts — so `ShellError`'s branch is reachable only for a bootstrap re-fetch that fails after
 * an initial success, not for the first load. See `docs/decisions/states.md`.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PLACES_WORDS, type Realtime, type RealtimeStatus, type WhombatClient } from '@whombat/client';
import { WhombatClientProvider } from '@whombat/client/react';
import { describe, expect, it, vi } from 'vitest';
import { testQueryClient } from '../../test/renderApp';
import { ShellError, ShellLayout } from './ShellLayout';

/** A realtime client whose status can be pushed from the test, for `useRealtimeStatus()`. */
function fakeRealtime(
  initial: RealtimeStatus = 'open',
): Realtime & { setStatus: (s: RealtimeStatus) => void } {
  let status = initial;
  const listeners = new Set<(status: RealtimeStatus) => void>();
  return {
    connect() {},
    disconnect() {},
    reconnectNow() {},
    status: () => status,
    session: () => null,
    subscribe: () => () => {},
    topics: () => [],
    lastSeq: () => undefined,
    on: () => () => {},
    onEvent: () => () => {},
    onStatus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onResync: () => () => {},
    onError: () => () => {},
    setStatus(next) {
      status = next;
      for (const listener of listeners) listener(next);
    },
  };
}

describe('shell quiet states (TODO 16.4)', () => {
  it('shows a one-line error with Retry when the burrow bootstrap fails to (re)load', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ShellError onRetry={onRetry} />);
    expect(screen.getByText('Your Whombat didn’t load. Try again in a moment.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows a small "Reconnecting…" pill while the socket is reconnecting or closed, not while open', async () => {
    const realtime = fakeRealtime('open');
    render(
      <WhombatClientProvider
        client={{} as WhombatClient}
        realtime={realtime}
        queryClient={testQueryClient()}
        connect={false}
      >
        <ShellLayout sidebar={null}>
          <div>screen</div>
        </ShellLayout>
      </WhombatClientProvider>,
    );
    expect(screen.queryByText('Reconnecting…')).toBeNull();

    realtime.setStatus('reconnecting');
    expect(await screen.findByText('Reconnecting…')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Reconnecting…');

    realtime.setStatus('open');
    await waitFor(() => expect(screen.queryByText('Reconnecting…')).toBeNull());

    realtime.setStatus('closed');
    expect(await screen.findByText('Reconnecting…')).toBeTruthy();
  });
});

describe('the Places drawer below 1024 px (WE-15)', () => {
  const renderShell = () =>
    render(
      <WhombatClientProvider
        client={{} as WhombatClient}
        realtime={fakeRealtime()}
        queryClient={testQueryClient()}
        connect={false}
      >
        <ShellLayout
          sidebar={
            <aside aria-label="Sidebar">
              <a href="#general">general</a>
              <button type="button">New channel</button>
            </aside>
          }
        >
          <button type="button">In the screen</button>
        </ShellLayout>
      </WhombatClientProvider>,
    );

  it('opens from the menu button, keeps focus inside, and Esc closes it back to the button', async () => {
    const user = userEvent.setup();
    renderShell();
    const menu = screen.getByRole('button', { name: PLACES_WORDS.places });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(menu.getAttribute('aria-haspopup')).toBe('dialog');
    await user.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    // A modal dialog headed Places; its Close, first in it, takes the focus.
    const drawer = screen.getByRole('dialog', { name: PLACES_WORDS.places });
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    const close = screen.getByRole('button', { name: PLACES_WORDS.close });
    await waitFor(() => expect(document.activeElement).toBe(close));
    // The rest of the frame is inert while it's open; Tab wraps around inside.
    expect(menu.closest('main')?.hasAttribute('inert')).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'general' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New channel' }));
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New channel' }));

    await user.keyboard('{Escape}');
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(menu.closest('main')?.hasAttribute('inert')).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(menu));
  });

  it('shows what the screen sets at the end of the top bar', () => {
    render(
      <WhombatClientProvider
        client={{} as WhombatClient}
        realtime={fakeRealtime()}
        queryClient={testQueryClient()}
        connect={false}
      >
        <ShellLayout
          sidebar={<aside aria-label="Sidebar" />}
          barEnd={<a href="/needs-you">7 things need you</a>}
        >
          <p>Screen</p>
        </ShellLayout>
      </WhombatClientProvider>,
    );
    expect(screen.getByRole('link', { name: '7 things need you' }).getAttribute('href')).toBe('/needs-you');
  });

  it('its close button closes it and gives the focus back to the menu button', async () => {
    const user = userEvent.setup();
    renderShell();
    const menu = screen.getByRole('button', { name: PLACES_WORDS.places });
    await user.click(menu);
    await user.click(screen.getByRole('button', { name: PLACES_WORDS.close }));
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(menu));
  });

  it('a link in it closes it', async () => {
    const user = userEvent.setup();
    renderShell();
    const menu = screen.getByRole('button', { name: PLACES_WORDS.places });
    await user.click(menu);
    await user.click(screen.getByRole('link', { name: 'general' }));
    expect(menu.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the narrow screen’s top bar', () => {
  it('holds Places at its left and what needs the person at its right', () => {
    render(
      <WhombatClientProvider
        client={{} as WhombatClient}
        realtime={fakeRealtime()}
        queryClient={testQueryClient()}
        connect={false}
      >
        <ShellLayout sidebar={<aside aria-label="Sidebar" />} barEnd={<a href="/inbox">3 need you</a>}>
          <p>Screen</p>
        </ShellLayout>
      </WhombatClientProvider>,
    );
    const bar = screen.getByRole('button', { name: PLACES_WORDS.places }).parentElement as HTMLElement;
    expect([...bar.querySelectorAll('button, a')].map((e) => e.textContent)).toEqual([
      PLACES_WORDS.places,
      '3 need you',
    ]);
  });
});
