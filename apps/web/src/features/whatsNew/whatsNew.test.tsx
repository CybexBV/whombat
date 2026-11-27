/**
 * What's new: the page built from the plain-language changelog, its row in This Whombat → About's UPDATES, and the
 * one-time “Whombat updated · See what’s new” notice after an update.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WHATS_NEW_TEXT, whatsNewSeenKey } from '@whombat/client/managed';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/Toast';

const BOX = 'wb-test-0001';

/** The box's session: open, and able to drop and come back (as when the box installs an update). */
const session = vi.hoisted(() => {
  let status = 'open';
  const listeners = new Set<(s: { status: string }) => void>();
  return {
    state: () => ({ status }),
    onState: (cb: (s: { status: string }) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    move(next: string) {
      status = next;
      for (const cb of [...listeners]) cb({ status });
    },
  };
});

const services = vi.hoisted(() => ({
  value: {
    session: null as unknown,
    managed: {
      applianceId: 'wb-test-0001',
      applianceFingerprint: 'ab12',
      control: { releaseSummary: async () => null },
    },
  },
}));
vi.mock('../../app/providers', () => ({ useAppServices: () => ({ ...services.value, session }) }));

const ops = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock('@whombat/client/session', async (original) => {
  const real = await original<typeof import('@whombat/client/session')>();
  return { ...real, sessionOps: { ...real.sessionOps, applianceStatus: ops.status } };
});
vi.mock('@whombat/client/managed', async (original) => ({
  ...(await original<typeof import('@whombat/client/managed')>()),
  readUpdatesChannel: async () => null,
}));
vi.mock('@whombat/client/react', async (original) => ({
  ...(await original<typeof import('@whombat/client/react')>()),
  useSessionProtocol: () => null,
}));
vi.mock('../settings/AgentUpdatesSwitch', () => ({
  AgentUpdatesSwitch: () => null,
  AgentUpdatesSection: () => null,
}));

const { whatsNewMarkdown, WHATS_NEW_MARKDOWN } = await import('./changelog');
const { WhatsNewScreen } = await import('./WhatsNewScreen');
const { WhatsNewNotice } = await import('../../managed/WhatsNewNotice');
const { ManagedAbout } = await import('../settings/ManagedTabs');
const { APPLIANCE_STATUS_KEY } = await import('../settings/version');

/** A managed Whombat's status whose last update installed `release` (none: no update yet). */
function status(release: string | null) {
  return {
    backup: { state: 'protected' },
    update: {
      state: 'Healthy',
      current: release ?? 'whombat-20261120.1',
      candidate: null,
      lastCheckedAt: '2026-11-27T09:00:00Z',
      deferredReason: null,
      failure: null,
      ...(release && { lastUpdate: { release, from: 'whombat-20261120.1', at: '2026-11-27T08:00:00Z' } }),
    },
  };
}

/** `ui` at `path` in a router that also has the What's new page, under a fresh query cache. */
function renderAt(ui: ReactNode, path = '/') {
  const root = createRootRoute({
    component: () => (
      <>
        {ui}
        <Outlet />
      </>
    ),
  });
  const home = createRoute({ getParentRoute: () => root, path: '/', component: () => <p>Home</p> });
  const page = createRoute({ getParentRoute: () => root, path: '/whats-new', component: WhatsNewScreen });
  const router = createRouter({
    routeTree: root.addChildren([home, page]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  /** Until the box's status (with `release` as its last update, when given) has arrived and the screen drew it. */
  const statusRead = async (release?: string) => {
    await vi.waitFor(() => {
      const data = client.getQueryData<ReturnType<typeof status>>([...APPLIANCE_STATUS_KEY]);
      expect(data).toBeTruthy();
      if (release) expect(data?.update.lastUpdate?.release).toBe(release);
    });
    await act(async () => {});
  };
  const view = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RouterProvider router={router as never} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...view, statusRead };
}

const seenEntry = whatsNewSeenKey(BOX);

beforeEach(() => {
  window.localStorage.clear();
  ops.status.mockReset();
});
afterEach(() => window.localStorage.clear());

describe('What’s new page', () => {
  it('is the changelog without the note for those who keep it', () => {
    const text =
      '# What’s new\n\n## 1 May\n\n- A thing.\n\n---\n\n**Keeping this page up to date.** Add a line.\n';
    expect(whatsNewMarkdown(text)).toBe('# What’s new\n\n## 1 May\n\n- A thing.\n');
    expect(WHATS_NEW_MARKDOWN).toMatch(/^# What's new in Whombat/);
    expect(WHATS_NEW_MARKDOWN).not.toContain('Keeping this page up to date');
  });

  it('renders the changelog: its title, its days and their lines', async () => {
    renderAt(null, '/whats-new');
    expect(await screen.findByRole('heading', { level: 1, name: 'What’s new in Whombat' })).toBeTruthy();
    const days = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(days.length).toBeGreaterThan(0);
    for (const day of days) expect(day).toMatch(/^\d{1,2} [A-Z][a-z]+ \d{4}$/);
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Keeping this page up to date/)).toBeNull();
  });
});

describe('This Whombat → About', () => {
  it('UPDATES has What’s new, which opens the page', async () => {
    const user = userEvent.setup();
    renderAt(
      <ManagedAbout burrow="hq" status={status('whombat-20261127.2') as never} onSetUpBackups={() => {}} />,
    );
    const updates = await screen.findByRole('region', { name: 'UPDATES' });
    expect(within(updates).getByText(WHATS_NEW_TEXT.link)).toBeTruthy();
    await user.click(within(updates).getByRole('link', { name: WHATS_NEW_TEXT.open }));
    expect(await screen.findByRole('heading', { level: 1, name: 'What’s new in Whombat' })).toBeTruthy();
  });
});

describe('the notice after an update', () => {
  const notice = () => screen.queryByTestId('whats-new-notice');

  it('says nothing on the first look and remembers the release', async () => {
    ops.status.mockResolvedValue(status('whombat-20261127.2'));
    renderAt(<WhatsNewNotice onWhatsNew={false} />);
    await vi.waitFor(() => expect(window.localStorage.getItem(seenEntry)).toBe('whombat-20261127.2'));
    expect(notice()).toBeNull();
  });

  it('says nothing while the release is the one seen', async () => {
    window.localStorage.setItem(seenEntry, 'whombat-20261127.2');
    ops.status.mockResolvedValue(status('whombat-20261127.2'));
    await renderAt(<WhatsNewNotice onWhatsNew={false} />).statusRead();
    expect(notice()).toBeNull();
    expect(window.localStorage.getItem(seenEntry)).toBe('whombat-20261127.2');
  });

  it('shows once after an update and stays dismissed', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(seenEntry, 'whombat-20261126.5');
    ops.status.mockResolvedValue(status('whombat-20261127.2'));
    const first = renderAt(<WhatsNewNotice onWhatsNew={false} />);
    const shown = await screen.findByTestId('whats-new-notice');
    expect(within(shown).getByText(WHATS_NEW_TEXT.notice)).toBeTruthy();
    expect(within(shown).getByRole('link', { name: WHATS_NEW_TEXT.see })).toBeTruthy();
    // Shown once: kept as seen as soon as it shows.
    expect(window.localStorage.getItem(seenEntry)).toBe('whombat-20261127.2');

    await user.click(within(shown).getByRole('button', { name: WHATS_NEW_TEXT.dismiss }));
    expect(notice()).toBeNull();
    expect(window.localStorage.getItem(seenEntry)).toBe('whombat-20261127.2');

    // Opened again: the same release says nothing.
    first.unmount();
    await renderAt(<WhatsNewNotice onWhatsNew={false} />).statusRead();
    expect(ops.status).toHaveBeenCalledTimes(2);
    expect(notice()).toBeNull();
  });

  it('shows once: opened again before it was dismissed, the same release says nothing', async () => {
    window.localStorage.setItem(seenEntry, 'whombat-20261126.5');
    ops.status.mockResolvedValue(status('whombat-20261127.2'));
    const first = renderAt(<WhatsNewNotice onWhatsNew={false} />);
    await screen.findByTestId('whats-new-notice');
    first.unmount();
    await renderAt(<WhatsNewNotice onWhatsNew={false} />).statusRead();
    expect(notice()).toBeNull();
  });

  it('an open page hears of an update once the box is back', async () => {
    window.localStorage.setItem(seenEntry, 'whombat-20261126.5');
    ops.status.mockResolvedValue(status('whombat-20261126.5'));
    await renderAt(<WhatsNewNotice onWhatsNew={false} />).statusRead();
    expect(notice()).toBeNull();
    // The box installs an update: its session drops and comes back, the page stays open.
    ops.status.mockResolvedValue(status('whombat-20261127.2'));
    act(() => session.move('connecting'));
    act(() => session.move('open'));
    expect(await screen.findByTestId('whats-new-notice')).toBeTruthy();
  });

  it('an open page back while the box still checks the update hears of it once the check is done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      window.localStorage.setItem(seenEntry, 'whombat-20261126.5');
      ops.status.mockResolvedValue(status('whombat-20261126.5'));
      const view = renderAt(<WhatsNewNotice onWhatsNew={false} />);
      await view.statusRead();
      // Back while the box still checks the update: the last update is the old one until it is done.
      const checking = status('whombat-20261126.5');
      ops.status.mockResolvedValue({
        ...checking,
        update: { ...checking.update, state: 'Verifying', candidate: 'whombat-20261127.2' },
      });
      act(() => session.move('connecting'));
      act(() => session.move('open'));
      await vi.waitFor(() => expect(ops.status).toHaveBeenCalledTimes(2));
      await act(async () => {});
      expect(notice()).toBeNull();
      // The check is done: the page asks again by itself while an update moves.
      ops.status.mockResolvedValue(status('whombat-20261127.2'));
      await act(() => vi.advanceTimersByTimeAsync(6_000));
      expect(await screen.findByTestId('whats-new-notice')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second page open at the same time says nothing for an update the first one told about', async () => {
    ops.status.mockResolvedValue(status('whombat-20261126.5'));
    const view = renderAt(<WhatsNewNotice onWhatsNew={false} />);
    await vi.waitFor(() => expect(window.localStorage.getItem(seenEntry)).toBe('whombat-20261126.5'));
    // Another page of this browser showed the notice for the update and kept it.
    window.localStorage.setItem(seenEntry, 'whombat-20261127.2');
    ops.status.mockResolvedValue(status('whombat-20261127.2'));
    act(() => session.move('connecting'));
    act(() => session.move('open'));
    await view.statusRead('whombat-20261127.2');
    expect(notice()).toBeNull();
  });

  it('See what’s new opens the page and counts as seen', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(seenEntry, 'whombat-20261126.5');
    ops.status.mockResolvedValue(status('whombat-20261127.2'));
    renderAt(<WhatsNewNotice onWhatsNew={false} />);
    await user.click(await screen.findByRole('link', { name: WHATS_NEW_TEXT.see }));
    expect(await screen.findByRole('heading', { level: 1, name: 'What’s new in Whombat' })).toBeTruthy();
    expect(notice()).toBeNull();
    expect(window.localStorage.getItem(seenEntry)).toBe('whombat-20261127.2');
  });

  it('on What’s new itself it counts as seen without showing', async () => {
    window.localStorage.setItem(seenEntry, 'whombat-20261126.5');
    ops.status.mockResolvedValue(status('whombat-20261127.2'));
    renderAt(<WhatsNewNotice onWhatsNew />, '/whats-new');
    await vi.waitFor(() => expect(window.localStorage.getItem(seenEntry)).toBe('whombat-20261127.2'));
    expect(notice()).toBeNull();
  });

  it('the first update after the first look gets the notice', async () => {
    ops.status.mockResolvedValue(status(null));
    const first = renderAt(<WhatsNewNotice onWhatsNew={false} />);
    await vi.waitFor(() => expect(window.localStorage.getItem(seenEntry)).toBe('none'));
    first.unmount();
    ops.status.mockResolvedValue(status('whombat-20261127.2'));
    renderAt(<WhatsNewNotice onWhatsNew={false} />);
    expect(await screen.findByTestId('whats-new-notice')).toBeTruthy();
  });
});
