import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { burrow, REPOS } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { mockedServices, renderApp } from '../../test/renderApp';

/**
 * Scripts the settings write endpoints (not in the shared fixtures' `IMPLEMENTED` set — see
 * `docs/decisions/web-push-connect.md`): `repos.list/sync`, `github.status`. Everything else (bootstrap, shell chrome) falls through to the
 * real seeded world via `createWebFixtureFetch()`.
 */
const profileCalls: unknown[] = [];

function mockServer(
  options: { githubConnected?: boolean; reposFail?: boolean; delayMs?: number; ghError?: string } = {},
) {
  // `reposFail` is read per request, so a test can make a later refetch fail.
  const { delayMs = 0 } = options;
  let githubConnected = options.githubConnected ?? true;
  const status = () => ({
    mode: 'gh',
    connected: githubConnected,
    login: options.ghError ? null : 'acme',
    error: options.ghError ?? null,
    fix: null,
    note: null,
    canConnect: true,
    polledAt: null,
    signInNeeded: false,
  });
  const base = createWebFixtureFetch();
  const repos = REPOS.map((r) => ({ ...r }));

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const path = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

    if (method === 'GET' && path === `/burrows/${burrow.slug}/repos`) {
      if (options.reposFail) return json({ error: { code: 'server_error', message: 'nope' } }, 500);
      return json({ repos: githubConnected ? repos : [], githubConnected });
    }
    if (method === 'POST' && path === `/burrows/${burrow.slug}/repos/sync`) {
      // Sync brings in a repository made on GitHub since (agent-repos.md AGR-09).
      if (!repos.some((r) => r.fullName === 'acme/Whombat'))
        repos.push({
          ...(REPOS[0] as (typeof REPOS)[number]),
          id: 'rep_new',
          fullName: 'acme/Whombat',
        });
      return json({ repos, githubConnected });
    }
    if (method === 'GET' && path === `/burrows/${burrow.slug}/github`) return json(status());
    if (method === 'POST' && path === `/burrows/${burrow.slug}/github/connect`) {
      if (options.ghError)
        return json(
          { error: { code: 'conflict', message: options.ghError, details: { fix: 'gh auth login' } } },
          409,
        );
      githubConnected = true;
      return json(status());
    }
    if (method === 'PATCH' && path === '/me/profile') {
      profileCalls.push(body);
      const account = {
        id: 'acc_mara',
        email: 'mara@burrowhq.example',
        name: body.name,
        title: body.title,
        createdAt: '2026-01-05T09:00:00.000Z',
      };
      return json({ account, people: [] });
    }
    return base(new Request(url, init), init);
  });
  return fetch;
}

/** GitHub's page in Connections (was Repositories, `?tab=repos`, and Software Dev, `?tab=dev`; SS-05). */
const GITHUB = '/connections?connection=github';
/** GitHub's own page, where a box at session minor 7 opens it. */
const GITHUB_PAGE = `/things/${encodeURIComponent('connection:github')}`;
/** A box before accounts' own pages: GitHub's page in Connections is where it is managed. */
const OLDER_BOX = { protocolMinor: 6 };

describe('SettingsScreen', () => {
  it('shows GitHub connected status and every repo with nothing to pick, and no Members tab', async () => {
    const user = userEvent.setup();
    const app = renderApp(`/settings`, mockedServices(mockServer({ githubConnected: true })));

    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    // The agent by its name (one-agent.md AP-4923): the web fixture world's is Neo.
    expect(screen.getByRole('link', { name: /^Neo/ })).toBeTruthy();
    await user.click(screen.getByRole('link', { name: /^You/ }));
    await screen.findByRole('heading', { level: 1, name: 'You' });
    expect(screen.getByText('PROFILE')).toBeTruthy();
    expect(screen.queryByText('REPOSITORIES')).toBeNull();
    // A Whombat is one person's (one-person.md AP-5670).
    expect(screen.queryByText('Members')).toBeNull();

    // GitHub is a connection (SS-05): its row in Connections, a group on the home, opens its own page, whose
    // Connection tab is GitHub's settings.
    await user.click(screen.getByRole('link', { name: 'Back to Settings' }));
    await user.click(await screen.findByRole('link', { name: /^Connections/ }));
    await waitFor(() => expect(app.location()).toBe(`/settings?tab=connections`));
    await user.click(await screen.findByRole('link', { name: /^GitHub\s*@acme/ }));
    await waitFor(() => expect(app.location()).toBe(GITHUB_PAGE));
    await user.click(await screen.findByRole('tab', { name: 'Connection' }));
    const tab = within(document.getElementById('thing-panel') as HTMLElement);
    expect(await tab.findByText('@acme')).toBeTruthy();
    // Every repository the account owns is the agent's (agent-repos.md AGR-08, AGR-12): listed, nothing to switch or pick.
    expect(tab.getByText(/every repository @acme owns/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).toBeNull();
    const list = (await screen.findByText('REPOSITORIES')).closest('section') as HTMLElement;
    for (const repo of REPOS) expect(await within(list).findByText(repo.fullName)).toBeTruthy();
    expect(within(list).queryByRole('switch')).toBeNull();
    expect(screen.queryByText('ADD FROM GITHUB')).toBeNull();
    expect(screen.queryByRole('textbox', { name: /owner\/name/ })).toBeNull();
  });

  it('brings in a repository made on GitHub since with Sync repos', async () => {
    const user = userEvent.setup();
    renderApp(GITHUB, mockedServices(mockServer({ githubConnected: true })));
    const list = (await screen.findByText('REPOSITORIES')).closest('section') as HTMLElement;
    await within(list).findByText(REPOS[0]?.fullName ?? '');
    expect(within(list).queryByText('acme/Whombat')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sync repos' }));
    expect(await within(list).findByText('acme/Whombat')).toBeTruthy();
  });
});

describe('SettingsScreen quiet states (TODO 16.4)', () => {
  it.each([['REPOSITORIES', GITHUB, REPOS[0]?.fullName ?? '']])(
    'shows skeleton rows while %s are loading',
    async (label, path, first) => {
      renderApp(path, mockedServices(mockServer({ delayMs: 60 }), OLDER_BOX));
      const card = (await screen.findByText(label)).closest('section') as HTMLElement;
      expect(card.querySelector('[data-state="loading"]')).not.toBeNull();
      await within(card).findByText(first);
      expect(card.querySelector('[data-state="loading"]')).toBeNull();
    },
  );

  it('shows a one-line error with Retry when repos fail to load', async () => {
    const user = userEvent.setup();
    renderApp(GITHUB, mockedServices(mockServer({ reposFail: true })));
    expect(await screen.findByText('Couldn’t load repos. Try again in a moment.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Couldn’t load repos. Try again in a moment.')).toBeTruthy();
  });

  it.each([['repos', GITHUB, 'repos.list', REPOS[0]?.fullName ?? '']])(
    'keeps showing loaded %s when a later refetch fails',
    async (what, path, query, first) => {
      const options = { reposFail: false };
      const services = mockedServices(mockServer(options), OLDER_BOX);
      renderApp(path, services);
      const heading = await screen.findByRole('heading', { level: 2, name: 'GitHub' });
      const panel = heading.closest('[data-connections-page]') as HTMLElement;
      await within(panel).findByText(first);

      options.reposFail = true;
      await services.queryClient.refetchQueries();
      await waitFor(() =>
        expect(
          services.queryClient.getQueryCache().findAll({ queryKey: ['whombat', query] })[0]?.state.error,
        ).toBeTruthy(),
      );
      expect(within(panel).getByText(first)).toBeTruthy();
      expect(screen.queryByText(`Couldn’t load ${what}. Try again in a moment.`)).toBeNull();
    },
  );
});

describe('SettingsScreen profile', () => {
  it('refuses an empty name without calling the server', async () => {
    const user = userEvent.setup();
    profileCalls.length = 0;
    renderApp(`/settings?part=profile`, mockedServices(mockServer({ githubConnected: true })));
    await screen.findByRole('heading', { level: 1, name: 'You' });
    const profile = screen.getByText('PROFILE').closest('section') as HTMLElement;
    const name = within(profile).getByLabelText('NAME') as HTMLInputElement;
    await waitFor(() => expect(name.value).not.toBe(''));
    await user.clear(name);
    await user.type(name, '...');
    await user.click(within(profile).getByRole('button', { name: 'Save' }));
    expect((await within(profile).findByRole('alert')).textContent).toBe('Use at least one letter.');
    expect(profileCalls).toEqual([]);
  });
});

describe('SettingsScreen profile photo (PA-05)', () => {
  /** The fixture world with Mara's photo set: a JPEG's first bytes are enough for its type check. */
  async function withPhoto() {
    const world = createWebFixtureFetch();
    const calls: unknown[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req =
        input instanceof Request ? input : new Request(new URL(String(input), 'http://whombat.test'), init);
      if (req.method === 'PUT') calls.push(await req.clone().json());
      return world(req);
    });
    const set = await world(
      new Request('http://whombat.test/api/v1/me/avatar', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: '/9j/4AAQ' }),
      }),
    );
    expect(set.status).toBe(200);
    return { fetch, calls };
  }

  it('draws the photo, and Remove photo goes back to the initials', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = await withPhoto();
    renderApp('/settings?part=profile', mockedServices(fetch));
    await screen.findByRole('heading', { level: 1, name: 'You' });
    const profile = screen.getByText('PROFILE').closest('section') as HTMLElement;
    // The avatar is a button to a new photo, and it shows the photo.
    const avatar = await within(profile).findByRole('button', {
      name: 'Change photo',
      description: 'Change photo',
    });
    await waitFor(() => expect(avatar.querySelector('img')?.getAttribute('src')).toMatch(/^(blob|data):/));
    expect(within(profile).getAllByRole('button', { name: 'Change photo' })).toHaveLength(2);

    await user.click(within(profile).getByRole('button', { name: 'Remove photo' }));
    expect(await screen.findByText('Photo removed.')).toBeTruthy();
    expect(calls).toEqual([{ image: null }]);
    await waitFor(() => expect(within(profile).queryByRole('button', { name: 'Remove photo' })).toBeNull());
    expect(avatar.querySelector('img')).toBeNull();
  });

  it('says why a picture can’t be used', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = await withPhoto();
    renderApp('/settings?part=profile', mockedServices(fetch));
    await screen.findByRole('heading', { level: 1, name: 'You' });
    const input = document.querySelector('[data-photo-input]') as HTMLInputElement;
    // jsdom can't decode images: the picked file can't be read.
    await user.upload(input, new File(['not an image'], 'notes.png', { type: 'image/png' }));
    expect(await screen.findByText('Couldn’t read that image.')).toBeTruthy();
    expect(calls).toEqual([]);
  });
});
