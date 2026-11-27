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
/** When a release was installed: its day from its name (`whombat-20261127.2` on 27 November), then its number. */
function installedAt(release: string): string {
  const day = release.replace(/^whombat-(\d{4})(\d{2})(\d{2})\.(\d+)$/, '$1-$2-$3T08:0$4:00Z');
  return day === release ? '2026-11-27T08:00:00Z' : day;
}

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
      ...(release && { lastUpdate: { release, from: 'whombat-20261120.1', at: installedAt(release) } }),
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
  return { ...view, statusRead, router };
}

const seenEntry = whatsNewSeenKey(BOX);

/** The release this browser keeps as seen (it keeps when the release was installed beside it). */
function seenRelease(): string | null {
  const raw = window.localStorage.getItem(seenEntry);
  if (raw === null) return null;
  try {
    return (JSON.parse(raw) as { release: string }).release;
  } catch {
    return raw;
  }
}

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

  it('on the page a box serves, Read loads the page afresh, with the notes of the version now running', async () => {
    vi.stubEnv('VITE_WHOMBAT_TARGET', 'box');
    try {
      const user = userEvent.setup();
      const view = renderAt(
        <ManagedAbout burrow="hq" status={status('whombat-20261127.2') as never} onSetUpBackups={() => {}} />,
      );
      const updates = await screen.findByRole('region', { name: 'UPDATES' });
      const read = within(updates).getByRole('link', { name: WHATS_NEW_TEXT.open });
      expect(read.getAttribute('href')).toBe('/whats-new');
      await user.click(read);
      // Not drawn by this page: the browser asks the box for it, which serves its version now running.
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(view.router.state.location.pathname).toBe('/');
      expect(screen.queryByRole('heading', { level: 1, name: 'What’s new in Whombat' })).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the notice after an update', () => {
  const notice = () => screen.queryByTestId('whats-new-notice');

  it('says nothing on the first look and remembers the release', async () => {
    ops.status.mockResolvedValue(status('whombat-20261127.2'));
    renderAt(<WhatsNewNotice onWhatsNew={false} />);
    await vi.waitFor(() => expect(seenRelease()).toBe('whombat-20261127.2'));
    expect(notice()).toBeNull();
  });

  it('says nothing while the release is the one seen', async () => {
    window.localStorage.setItem(seenEntry, 'whombat-20261127.2');
    ops.status.mockResolvedValue(status('whombat-20261127.2'));
    await renderAt(<WhatsNewNotice onWhatsNew={false} />).statusRead();
    expect(notice()).toBeNull();
    expect(seenRelease()).toBe('whombat-20261127.2');
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
    expect(seenRelease()).toBe('whombat-20261127.2');

    await user.click(within(shown).getByRole('button', { name: WHATS_NEW_TEXT.dismiss }));
    expect(notice()).toBeNull();
    expect(seenRelease()).toBe('whombat-20261127.2');

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

  it('an open page back before the box says how its updates stand asks again until it does', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      window.localStorage.setItem(seenEntry, 'whombat-20261126.5');
      ops.status.mockResolvedValue(status('whombat-20261126.5'));
      await renderAt(<WhatsNewNotice onWhatsNew={false} />).statusRead();
      // Back, but the box's manager hasn't said yet how its updates stand.
      ops.status.mockResolvedValue({ ...status(null), update: null });
      act(() => session.move('connecting'));
      act(() => session.move('open'));
      await vi.waitFor(() => expect(ops.status).toHaveBeenCalledTimes(2));
      await act(async () => {});
      expect(notice()).toBeNull();
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
    await vi.waitFor(() => expect(seenRelease()).toBe('whombat-20261126.5'));
    // Another page of this browser showed the notice for the update and kept it.
    window.localStorage.setItem(seenEntry, 'whombat-20261127.2');
    ops.status.mockResolvedValue(status('whombat-20261127.2'));
    act(() => session.move('connecting'));
    act(() => session.move('open'));
    await view.statusRead('whombat-20261127.2');
    expect(notice()).toBeNull();
  });

  it('two pages that hear of the same update at the same moment: only one tells', async () => {
    window.localStorage.setItem(seenEntry, 'whombat-20261126.5');
    ops.status.mockResolvedValue(status('whombat-20261127.2'));
    renderAt(
      <>
        <WhatsNewNotice onWhatsNew={false} />
        <WhatsNewNotice onWhatsNew={false} />
      </>,
    );
    await screen.findByTestId('whats-new-notice');
    await act(async () => {});
    expect(screen.getAllByTestId('whats-new-notice')).toHaveLength(1);
    expect(seenRelease()).toBe('whombat-20261127.2');
  });

  it('a page still holding an older answer neither tells nor goes back to it', async () => {
    window.localStorage.setItem(
      seenEntry,
      JSON.stringify({ release: 'whombat-20261127.2', at: installedAt('whombat-20261127.2') }),
    );
    ops.status.mockResolvedValue(status('whombat-20261126.5'));
    await renderAt(<WhatsNewNotice onWhatsNew={false} />).statusRead();
    expect(notice()).toBeNull();
    expect(seenRelease()).toBe('whombat-20261127.2');
  });

  it('a page gone before the browser lets it claim the update keeps nothing, so another can tell', async () => {
    const queued: (() => void)[] = [];
    const locks = {
      request: (_name: string, take: () => unknown) =>
        new Promise((resolve) => queued.push(() => resolve(take()))),
    };
    vi.stubGlobal('navigator', { ...navigator, locks });
    try {
      window.localStorage.setItem(seenEntry, 'whombat-20261126.5');
      ops.status.mockResolvedValue(status('whombat-20261127.2'));
      const view = renderAt(<WhatsNewNotice onWhatsNew={false} />);
      await vi.waitFor(() => expect(queued).toHaveLength(1));
      view.unmount();
      await act(async () => queued.shift()?.());
      expect(seenRelease()).toBe('whombat-20261126.5');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a read that fails just after the box is back is asked again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      window.localStorage.setItem(seenEntry, 'whombat-20261126.5');
      ops.status.mockResolvedValue(status('whombat-20261126.5'));
      await renderAt(<WhatsNewNotice onWhatsNew={false} />).statusRead();
      ops.status.mockRejectedValueOnce(new Error('not yet'));
      ops.status.mockResolvedValue(status('whombat-20261127.2'));
      act(() => session.move('connecting'));
      act(() => session.move('open'));
      await vi.waitFor(() => expect(ops.status).toHaveBeenCalledTimes(2));
      await act(async () => {});
      expect(notice()).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(6_000));
      expect(await screen.findByTestId('whats-new-notice')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('See what’s new opens the page and counts as seen', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(seenEntry, 'whombat-20261126.5');
    ops.status.mockResolvedValue(status('whombat-20261127.2'));
    renderAt(<WhatsNewNotice onWhatsNew={false} />);
    await user.click(await screen.findByRole('link', { name: WHATS_NEW_TEXT.see }));
    expect(await screen.findByRole('heading', { level: 1, name: 'What’s new in Whombat' })).toBeTruthy();
    expect(notice()).toBeNull();
    expect(seenRelease()).toBe('whombat-20261127.2');
  });

  it('on What’s new itself it counts as seen without showing', async () => {
    window.localStorage.setItem(seenEntry, 'whombat-20261126.5');
    ops.status.mockResolvedValue(status('whombat-20261127.2'));
    renderAt(<WhatsNewNotice onWhatsNew />, '/whats-new');
    await vi.waitFor(() => expect(seenRelease()).toBe('whombat-20261127.2'));
    expect(notice()).toBeNull();
  });

  it('on the page a box serves, See what’s new loads the page afresh, with the notes of the version now running', async () => {
    vi.stubEnv('VITE_WHOMBAT_TARGET', 'box');
    try {
      window.localStorage.setItem(seenEntry, 'whombat-20261126.5');
      ops.status.mockResolvedValue(status('whombat-20261127.2'));
      const user = userEvent.setup();
      const view = renderAt(<WhatsNewNotice onWhatsNew={false} />);
      const see = await screen.findByRole('link', { name: WHATS_NEW_TEXT.see });
      expect(see.getAttribute('href')).toBe('/whats-new');
      await user.click(see);
      // A page open across the update still runs the version from before it: the browser loads the page again.
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(view.router.state.location.pathname).toBe('/');
      expect(screen.queryByRole('heading', { level: 1, name: 'What’s new in Whombat' })).toBeNull();
      expect(notice()).toBeNull();
      expect(seenRelease()).toBe('whombat-20261127.2');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a page opened while its first read fails asks again shortly', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      window.localStorage.setItem(seenEntry, 'whombat-20261126.5');
      ops.status.mockRejectedValueOnce(new Error('not yet'));
      ops.status.mockResolvedValue(status('whombat-20261127.2'));
      renderAt(<WhatsNewNotice onWhatsNew={false} />);
      await vi.waitFor(() => expect(ops.status).toHaveBeenCalledTimes(1));
      await act(async () => {});
      expect(notice()).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(6_000));
      expect(await screen.findByTestId('whats-new-notice')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a page opened before the box says how its updates stand asks again until it does', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      window.localStorage.setItem(seenEntry, 'whombat-20261126.5');
      ops.status.mockResolvedValueOnce({ ...status(null), update: null });
      ops.status.mockResolvedValue(status('whombat-20261127.2'));
      renderAt(<WhatsNewNotice onWhatsNew={false} />);
      await vi.waitFor(() => expect(ops.status).toHaveBeenCalledTimes(1));
      await act(async () => {});
      expect(notice()).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(6_000));
      expect(await screen.findByTestId('whats-new-notice')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('two pages that claim the same update through the browser’s lock in turn: only one tells', async () => {
    // One holder at a time, as the browser's lock does; each claim waits for the one before it.
    let last: Promise<unknown> = Promise.resolve();
    let claims = 0;
    const locks = {
      request: (_name: string, take: () => unknown) => {
        claims += 1;
        const turn = last.then(() => new Promise((resolve) => setTimeout(() => resolve(take()), 5)));
        last = turn;
        return turn;
      },
    };
    vi.stubGlobal('navigator', { ...navigator, locks });
    try {
      window.localStorage.setItem(seenEntry, 'whombat-20261126.5');
      ops.status.mockResolvedValue(status('whombat-20261127.2'));
      renderAt(
        <>
          <WhatsNewNotice onWhatsNew={false} />
          <WhatsNewNotice onWhatsNew={false} />
        </>,
      );
      await screen.findByTestId('whats-new-notice');
      await vi.waitFor(() => expect(claims).toBeGreaterThanOrEqual(2));
      await act(() => last);
      expect(screen.getAllByTestId('whats-new-notice')).toHaveLength(1);
      expect(seenRelease()).toBe('whombat-20261127.2');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a browser that can’t keep the update says nothing, so the notice doesn’t come back at every start', async () => {
    window.localStorage.setItem(seenEntry, 'whombat-20261126.5');
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      ops.status.mockResolvedValue(status('whombat-20261127.2'));
      await renderAt(<WhatsNewNotice onWhatsNew={false} />).statusRead();
      await act(async () => {});
      expect(setItem).toHaveBeenCalled();
      expect(notice()).toBeNull();
      expect(seenRelease()).toBe('whombat-20261126.5');
    } finally {
      setItem.mockRestore();
    }
  });

  it('the first update after the first look gets the notice', async () => {
    ops.status.mockResolvedValue(status(null));
    const first = renderAt(<WhatsNewNotice onWhatsNew={false} />);
    await vi.waitFor(() => expect(seenRelease()).toBe('none'));
    first.unmount();
    ops.status.mockResolvedValue(status('whombat-20261127.2'));
    renderAt(<WhatsNewNotice onWhatsNew={false} />);
    expect(await screen.findByTestId('whats-new-notice')).toBeTruthy();
  });
});
