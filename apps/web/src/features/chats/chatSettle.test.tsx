/**
 * Settling threads in Chat (Whombat chat-settle.md CHS-01…CHS-12; app chat-settle.md AP-6150…AP-6156, AP-6159,
 * AP-6250…AP-6252), against the fixture world's Chat (`chatChannelFixtures.ts`): its settled threads are in Settled, not
 * in the room, Neo's question about tonight's updates and pve-02's open approval wait for Mara, and Neo is looking into
 * the firmware.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, INBOX_WORDS, SETTLE_QUIET_CHOICES, SETTLE_WORDS } from '@whombat/client';
import { type ApplianceStatus, sessionOps } from '@whombat/client/session';
import { burrow } from '@whombat/fixtures';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CERT_THREAD,
  FIRMWARE_THREAD,
  PVE_THREAD,
  SETTLED_THREADS,
  UPDATES_THREAD,
  ZONNEPLAN_THREAD,
} from '../../app/chatChannelFixtures';
import { COUNCIL_BUILD_THREAD } from '../../app/councilFixtures';
import { DELEGATION_OFFER_THREAD, DELEGATION_WORKING_THREAD } from '../../app/delegationFixtures';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import type { AppServices } from '../../app/services';
import { fixtureServices, mockedServices, renderApp } from '../../test/renderApp';

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  localStorage.clear();
  // New settlements happen after the fixture's already-settled threads from this morning.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const BACKUPS = 'msg_chat-backups';
const room = () => screen.findByRole('region', { name: 'Chat' });
/** A thread's row in the room's list (chat-inbox-web.md). */
const article = (id: string) => document.querySelector<HTMLElement>(`[data-root-id="${id}"]`);
const settledPane = () => screen.findByRole('complementary', { name: 'Settled' });

describe('the room leaves settled threads to Settled (AP-6250, AP-6251)', () => {
  it('shows only open threads, and its head’s Settled opens the settled ones beside it', async () => {
    const user = userEvent.setup();
    const app = renderApp('/chat', fixtureServices({}));
    await room();
    await waitFor(() => expect(article(BACKUPS)).toBeTruthy());
    expect(article(FIRMWARE_THREAD)).toBeTruthy();
    expect(article(CERT_THREAD)).toBeNull();
    expect(article(ZONNEPLAN_THREAD)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Settled' }));
    await waitFor(() => expect(app.location()).toBe('/chat?settled=1'));
    const pane = await settledPane();
    const row = await waitFor(() => {
      const r = pane.querySelector<HTMLElement>(`[data-thread-row="${CERT_THREAD}"]`);
      if (!r) throw new Error('not yet');
      return r;
    });
    // A row opens its thread in the same place.
    await user.click(row);
    await waitFor(() => expect(app.location()).toBe(`/chat?thread=${CERT_THREAD}`));
  });
});

describe('Settle on a thread’s row (AP-6150, AP-6151; chat-inbox-web.md)', () => {
  it('settles from the toolbar with no question: the row leaves, the toast offers Undo, Undo brings it back', async () => {
    const user = userEvent.setup();
    renderApp('/chat', fixtureServices({}));
    await room();
    const backups = await waitFor(() => {
      const row = article(BACKUPS);
      if (!row || !within(row).queryByRole('button', { name: 'Settle' })) throw new Error('not yet');
      return row;
    });
    // The first tool on the row.
    const tools = within(within(backups).getByRole('group')).getAllByRole('button');
    expect(tools[0]?.getAttribute('aria-label')).toBe('Settle');
    await user.click(within(backups).getByRole('button', { name: 'Settle' }));

    expect(await screen.findByText('Settled.')).toBeTruthy();
    await waitFor(() => expect(article(BACKUPS)).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(article(BACKUPS)).toBeTruthy());
  });

  it('offers nothing where Neo works or something waits', async () => {
    renderApp('/chat', fixtureServices({}));
    await room();
    await waitFor(() =>
      expect(within(article(BACKUPS) as HTMLElement).getByRole('button', { name: 'Settle' })),
    );
    for (const id of [FIRMWARE_THREAD, PVE_THREAD, UPDATES_THREAD])
      expect(within(article(id) as HTMLElement).queryByRole('button', { name: 'Settle' })).toBeNull();
  });

  it('offers nothing where work is handed over: a council at work, tasks with T3 Code', async () => {
    renderApp('/chat', fixtureServices({ council: true, delegation: 'all' }));
    await room();
    // A checklist not handed over yet is nothing at work: that thread settles.
    await waitFor(() =>
      expect(within(article(DELEGATION_OFFER_THREAD) as HTMLElement).getByRole('button', { name: 'Settle' })),
    );
    for (const id of [DELEGATION_WORKING_THREAD, COUNCIL_BUILD_THREAD])
      expect(within(article(id) as HTMLElement).queryByRole('button', { name: 'Settle' })).toBeNull();
  });

  it('says a refusal in a toast and puts the thread back', async () => {
    const user = userEvent.setup();
    const services = fixtureServices({});
    const request = services.client.request.bind(services.client);
    vi.spyOn(services.client, 'request').mockImplementation(((ep: { id: string }, input: never) =>
      ep.id === 'chats.settle'
        ? Promise.reject(new ApiError(409, 'conflict', 'Neo is still working on this.', null, ep.id))
        : request(ep as never, input)) as never);
    renderApp('/chat', services);
    await room();
    const backups = await waitFor(() => {
      const row = article(BACKUPS);
      if (!row || !within(row).queryByRole('button', { name: 'Settle' })) throw new Error('not yet');
      return row;
    });
    await user.click(within(backups).getByRole('button', { name: 'Settle' }));
    expect(await screen.findByText('Neo is still working on this.')).toBeTruthy();
    await waitFor(() => expect(article(BACKUPS)).toBeTruthy());
    await waitFor(() => expect(screen.queryByText('Thread settled.')).toBeNull());
  });
});

describe('an open thread (AP-6150, AP-6154)', () => {
  it('has Settle in its head, which settles it and goes back to Chat', async () => {
    const user = userEvent.setup();
    const app = renderApp(`/chat?thread=${BACKUPS}`, fixtureServices({}));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    const settle = await within(pane).findByRole('button', { name: 'Settle' });
    await user.click(settle);
    await waitFor(() => expect(app.location()).toBe('/chat'));
    expect(await screen.findByText('Settled.')).toBeTruthy();
    await waitFor(() => expect(article(BACKUPS)).toBeNull());
  });

  it('has no Settle while it waits', async () => {
    renderApp(`/chat?thread=${UPDATES_THREAD}`, fixtureServices({}));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    await within(pane).findByRole('heading', { name: /Install the updates/ });
    expect(within(pane).queryByRole('button', { name: 'Settle' })).toBeNull();
  });

  it('says when a settled one settled, opens it again, and says a reply would', async () => {
    const user = userEvent.setup();
    renderApp(`/chat?thread=${CERT_THREAD}`, fixtureServices({}));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    const line = await waitFor(() => {
      const l = pane.querySelector<HTMLElement>('[data-settled-line]');
      if (!l) throw new Error('no line yet');
      return l;
    });
    expect(line.textContent).toMatch(/^Settled /);
    expect(within(pane).getByText('A reply opens it again.')).toBeTruthy();
    expect(within(pane).queryByRole('button', { name: 'Settle' })).toBeNull();
    await user.click(within(line).getByRole('button', { name: 'Open again' }));
    await waitFor(() => expect(pane.querySelector('[data-settled-line]')).toBeNull());
    expect(within(pane).queryByText('A reply opens it again.')).toBeNull();
    expect(await within(pane).findByRole('button', { name: 'Settle' })).toBeTruthy();
  });
});

describe('Settled (AP-6153, AP-6252)', () => {
  it('lists the latest ten settled, how each settled, Open again on each, and Show more', async () => {
    const user = userEvent.setup();
    renderApp('/chat?settled=1', fixtureServices({}));
    const pane = await settledPane();
    const settled = await within(pane).findByRole('list', { name: 'Settled in Chat' });
    const rows = await within(settled).findAllByRole('link');
    expect(rows).toHaveLength(10);
    expect(rows[0]?.getAttribute('data-thread-row')).toBe(CERT_THREAD);
    expect(settled.textContent).toContain('Settled by itself after 3 quiet days');
    expect(settled.textContent).toContain('Settled when its pull request merged');
    expect(within(settled).getAllByRole('button', { name: 'Open again' })).toHaveLength(10);
    // Only settled threads: nothing open, waiting or worked on.
    for (const id of [BACKUPS, FIRMWARE_THREAD, PVE_THREAD, UPDATES_THREAD])
      expect(settled.querySelector(`[data-thread-row="${id}"]`)).toBeNull();
    await user.click(within(pane).getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(settled).getAllByRole('link')).toHaveLength(SETTLED_THREADS));
  });

  it('takes a thread settled in the room at the top, and Open again puts it back in the room', async () => {
    const user = userEvent.setup();
    renderApp('/chat?settled=1', fixtureServices({}));
    const pane = await settledPane();
    const settled = await within(pane).findByRole('list', { name: 'Settled in Chat' });
    const backups = await waitFor(() => {
      const row = article(BACKUPS);
      if (!row || !within(row).queryByRole('button', { name: 'Settle' })) throw new Error('not yet');
      return row;
    });
    await user.click(within(backups).getByRole('button', { name: 'Settle' }));
    await waitFor(() =>
      expect(settled.querySelector('[data-thread-row]')?.getAttribute('data-thread-row')).toBe(BACKUPS),
    );
    await waitFor(() => expect(article(BACKUPS)).toBeNull());

    const first = settled.querySelector(`[data-thread-row="${BACKUPS}"]`)?.closest('li') as HTMLElement;
    await user.click(within(first).getByRole('button', { name: 'Open again' }));
    await waitFor(() => expect(article(BACKUPS)).toBeTruthy());
    expect(settled.querySelector(`[data-thread-row="${BACKUPS}"]`)).toBeNull();
  });
});

describe('Settle finished threads (AP-6155)', () => {
  it('settles what nobody works on or waits for, from the sidebar’s menu, and says how many', async () => {
    const user = userEvent.setup();
    renderApp('/chat', fixtureServices({}));
    const side = await screen.findByRole('complementary', { name: 'Sidebar' });
    await room();
    await waitFor(() => expect(article(BACKUPS)).toBeTruthy());
    await user.pointer({ keys: '[MouseRight]', target: within(side).getByRole('link', { name: /^Chat/ }) });
    await user.click(screen.getByRole('menuitem', { name: 'Settle finished threads' }));
    expect(await screen.findByText('Settled 1 thread.')).toBeTruthy();
    await waitFor(() => expect(article(BACKUPS)).toBeNull());
    expect(article(FIRMWARE_THREAD)).toBeTruthy();
    expect(article(PVE_THREAD)).toBeTruthy();

    await user.pointer({ keys: '[MouseRight]', target: within(side).getByRole('link', { name: /^Chat/ }) });
    await user.click(screen.getByRole('menuitem', { name: 'Settle finished threads' }));
    expect(await screen.findByText('Nothing to settle.')).toBeTruthy();
  });
});

describe('Settings → You → Profile → CHAT (AP-6156; chat-inbox-web.md)', () => {
  it('offers when threads settle by themselves, after 3 days by default, and saves a change at once', async () => {
    const user = userEvent.setup();
    const services = fixtureServices({});
    renderApp('/settings?part=profile', services);
    const section = await screen.findByRole('region', { name: 'CHAT' });
    const quiet = within(section).getByRole('radiogroup', { name: INBOX_WORDS.quietChoice });
    const choice = (label: string) => within(quiet).getByRole('radio', { name: label });
    expect(
      within(quiet)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual(SETTLE_QUIET_CHOICES.map((c) => c.label));
    expect((choice('After 3 days') as HTMLInputElement).checked).toBe(true);
    // Settling on a merge shows once GitHub or website feedback is known to be connected.
    const merged = await within(section).findByRole('switch', {
      name: SETTLE_WORDS.mergedSwitch,
    });
    expect(merged.getAttribute('aria-checked')).toBe('true');
    expect(section.textContent).toMatch(/Never while Neo is still working on it/);

    await user.click(choice('Never'));
    await waitFor(() => expect((choice('Never') as HTMLInputElement).checked).toBe(true));
    await waitFor(async () =>
      expect((await services.client.me.getPreferences()).chat).toEqual({
        settleQuietDays: null,
        settleMerged: true,
      }),
    );
    await user.click(choice('After a week'));
    await waitFor(async () =>
      expect((await services.client.me.getPreferences()).chat?.settleQuietDays).toBe(7),
    );
  });

  it('leaves settling on a merge out where neither GitHub nor website feedback is connected', async () => {
    const base = createWebFixtureFetch();
    const asked = new Set<string>();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
      const path = url.pathname.replace(`/api/v1/burrows/${burrow.slug}`, '');
      asked.add(path);
      if (path === '/github')
        return Response.json({
          mode: 'gh',
          connected: false,
          login: null,
          error: null,
          fix: null,
          note: null,
          canConnect: true,
          polledAt: null,
          signInNeeded: false,
        });
      if (path === '/repos') return Response.json({ repos: [], githubConnected: false });
      if (path === '/feedback/integrations')
        return Response.json({ integrations: [], can: { manage: true } });
      return base(new Request(url, init), init);
    }) as unknown as typeof globalThis.fetch;
    const services = mockedServices(fetch);
    renderApp('/settings?part=profile', services);
    const section = await screen.findByRole('region', { name: 'CHAT' });
    expect(within(section).getByRole('radiogroup', { name: INBOX_WORDS.quietChoice })).toBeTruthy();
    await waitFor(() => expect(asked.has('/feedback/integrations') && asked.has('/github')).toBe(true));
    // Once GitHub's and feedback's answers are in.
    await waitFor(() => expect(services.queryClient.isFetching()).toBe(0));
    expect(within(section).queryByRole('switch', { name: SETTLE_WORDS.mergedSwitch })).toBeNull();
  });
});

describe('This Whombat → About → VERSION (AP-6159)', () => {
  const status = (hermes: { version: string } | null) =>
    ({
      claimed: true,
      claimReported: true,
      recovery: { enrolled: true, kitVerified: true, rotationPending: false },
      revocationsPending: 0,
      revocationsApplied: 0,
      draining: false,
      policy: {},
      backup: {
        state: 'protected',
        lastSuccessAt: null,
        ageS: null,
        coverage: [],
        unprotected: [],
        relogin: [],
        lastFailure: null,
        recoverable: true,
      },
      update: null,
      appliance: {
        runtimeVersion: '0.166.0',
        schemaVersion: 14,
        protocol: { major: 3, minor: 8 },
        hermes,
      },
      providers: [],
    }) as unknown as ApplianceStatus;
  const managed = (): AppServices => ({
    ...fixtureServices({}),
    managed: {} as NonNullable<AppServices['managed']>,
  });

  it('shows the Hermes Agent after Whombat with its version', async () => {
    vi.spyOn(sessionOps, 'applianceStatus').mockResolvedValue(status({ version: '0.24.1' }));
    renderApp('/settings?tab=appliance&section=about', managed());
    const version = await screen.findByRole('region', { name: 'VERSION' });
    // The versions are under Technical details.
    await userEvent.click(within(version).getByRole('button', { name: 'Technical details' }));
    const row = (await within(version).findByText('Hermes Agent')).closest('div') as HTMLElement;
    expect(row.textContent).toContain('What your assistant runs on');
    expect(within(row).getByText('0.24.1')).toBeTruthy();
    const titles = [...version.querySelectorAll('[class*="rowTitle"]')].map((t) => t.textContent);
    expect(titles.indexOf('Hermes Agent')).toBe(titles.indexOf('Whombat') + 1);
  });

  it('says Not known yet until a runner has said', async () => {
    vi.spyOn(sessionOps, 'applianceStatus').mockResolvedValue(status(null));
    renderApp('/settings?tab=appliance&section=about', managed());
    const version = await screen.findByRole('region', { name: 'VERSION' });
    // The versions are under Technical details.
    await userEvent.click(within(version).getByRole('button', { name: 'Technical details' }));
    const row = (await within(version).findByText('Hermes Agent')).closest('div') as HTMLElement;
    expect(row.textContent).toContain('Not known yet');
  });
});
