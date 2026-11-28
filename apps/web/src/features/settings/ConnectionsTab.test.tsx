import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Connection, ConnectorsStatus } from '@whombat/core';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { mockedServices, renderApp } from '../../test/renderApp';
import { DESKTOP_CLIENT_ERROR, parseClientSecretFile, redirectMismatchText } from '../connectors/copy';

const REDIRECT = 'https://whombat.example/api/v1/connectors/google/callback';

function baseStatus(patch: Partial<ConnectorsStatus> = {}): ConnectorsStatus {
  return {
    mode: 'real',
    google: {
      app: {
        provider: 'google',
        configured: false,
        source: null,
        clientIdHint: null,
        secretSet: false,
        userType: null,
        updatedAt: null,
      },
      setup: {
        redirectUri: REDIRECT,
        enableApisUrl:
          'https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com,docs.googleapis.com,sheets.googleapis.com,people.googleapis.com',
        links: {
          createProject: 'https://console.cloud.google.com/projectcreate',
          consentScreen: 'https://console.cloud.google.com/auth/branding',
          audience: 'https://console.cloud.google.com/auth/audience',
          createClient: 'https://console.cloud.google.com/auth/clients/create',
        },
        scopes: ['openid', 'email', 'profile'],
        appName: 'Whombat',
        supportEmail: 'mara@burrowhq.example',
        authorizedDomain: 'whombat.example',
      },
      tested: false,
    },
    connections: [],
    ...patch,
  };
}

const CONFIGURED = {
  provider: 'google' as const,
  configured: true,
  source: 'settings' as const,
  clientIdHint: '1234567890-a…',
  secretSet: true,
  userType: 'external' as const,
  updatedAt: '2026-09-24T08:00:00.000Z',
};

function connection(patch: Partial<Connection> = {}): Connection {
  return {
    id: 'con_mara',
    provider: 'google',
    email: 'mara.oduya@example.com',
    name: 'Mara Oduya',
    services: ['mail', 'calendar', 'files'],
    status: 'active',
    reauthReason: null,
    checks: [
      {
        service: 'mail',
        state: 'api_disabled',
        enableUrl: 'https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=42',
      },
      { service: 'calendar', state: 'ok' },
      { service: 'files', state: 'ok' },
    ],
    // Checked three days ago; a token refresh moved updatedAt since (IN-29).
    checkedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    createdAt: '2026-09-24T08:00:00.000Z',
    updatedAt: new Date().toISOString(),
    lastUsedAt: null,
    ...patch,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** The connector endpoints scripted over the fixture world. */
function mockServer(
  initial: ConnectorsStatus,
  /** `bare`: GitHub not connected and no website feedback, so nothing at all is connected. */
  options: { bare?: boolean } = {},
) {
  let status = initial;
  const calls: Call[] = [];
  const base = createWebFixtureFetch();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const path = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const json = (data: unknown, code = 200) =>
      new Response(JSON.stringify(data), { status: code, headers: { 'content-type': 'application/json' } });
    if (path.startsWith('/connectors') || path.startsWith('/me/connections'))
      calls.push({ method, path, body });

    if (method === 'GET' && path === '/connectors') return json(status);
    if (options.bare && method === 'GET' && path === `/burrows/${burrow.slug}/feedback/integrations`)
      return json({ integrations: [], can: { manage: true } });
    // GitHub, connected for the burrow (the overview's first entry, SS-05).
    if (method === 'GET' && path === `/burrows/${burrow.slug}/github`)
      return json({
        mode: 'gh',
        connected: !options.bare,
        login: options.bare ? null : 'acme',
        error: null,
        fix: null,
        note: null,
        canConnect: true,
        polledAt: null,
        signInNeeded: false,
      });
    if (method === 'PUT' && path === '/connectors/google/app') {
      status = { ...status, google: { ...status.google, app: { ...CONFIGURED, userType: body.userType } } };
      return json(status);
    }
    if (method === 'DELETE' && path === '/connectors/google/app') {
      status = { ...status, google: { ...status.google, app: baseStatus().google.app } };
      return json(status);
    }
    if (method === 'POST' && path === '/me/connections/google/start')
      return json({ authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=oas_x' });
    if (method === 'POST' && path.endsWith('/check')) {
      const checked = connection({
        checks: connection().checks.map((c) => ({ service: c.service, state: 'ok' })),
        checkedAt: new Date().toISOString(),
      });
      status = { ...status, connections: [checked] };
      return json(checked);
    }
    if (method === 'DELETE' && path.startsWith('/me/connections/')) {
      status = { ...status, connections: [] };
      return json({ ok: true });
    }
    return base(new Request(url, init), init);
  });
  return { fetch, calls };
}

/**
 * A box before accounts' own pages (session minor 6): a connected account's Settings page is where it is managed. A
 * newer box opens the account's own page instead, whose Connection tab draws the same.
 */
const OLDER_BOX = { protocolMinor: 6 };

/** Google's page, on the Connections page (settings-groups.md); `path` another address that lands there. */
async function openTab(status: ConnectorsStatus, options: { path?: string } = {}) {
  const server = mockServer(status);
  const app = renderApp(
    options.path ?? '/connections?connection=google',
    mockedServices(server.fetch, OLDER_BOX),
  );
  await screen.findByRole('heading', { level: 2, name: 'Google' });
  expect(document.querySelector('[data-connections-page="google"]')).toBeTruthy();
  await screen.findByText(/^(Set up )?[Ff]or this Whombat$/);
  return { ...server, app };
}

describe('Connections → Google', () => {
  it('guides you through the six steps, and saves the pasted client', async () => {
    const user = userEvent.setup();
    const { calls } = await openTab(baseStatus());
    expect(screen.getByText(/^Set up Google once, then you can connect your account\./)).toBeTruthy();
    const steps = screen.getByRole('list', { name: 'Set up Google' });
    const titles = within(steps)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent?.replace(/^Step \d: /, '').replace(/(Done|To do|Not yet)$/, ''));
    expect(titles).toEqual([
      'Create a project',
      'Turn on the APIs',
      'Configure the consent screen',
      'Create the OAuth client',
      'Paste the Client ID and secret',
      'Test it',
    ]);
    expect(screen.getByRole('link', { name: /Turn on the APIs/ }).getAttribute('href')).toContain(
      'apiid=gmail.googleapis.com,calendar-json.googleapis.com',
    );
    expect(screen.getAllByText(REDIRECT).length).toBeGreaterThan(0);
    expect(screen.getByText('whombat.example')).toBeTruthy();

    // Step 3's choice changes the path.
    expect(screen.getByText(/in Testing, Google signs you out after 7 days/)).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'A Google Workspace domain' }));
    expect(screen.getByText(/there’s no warning screen and nothing to publish/)).toBeTruthy();
    expect(screen.queryByText(/in Testing, Google signs you out/)).toBeNull();

    // Nothing connects before the app is saved.
    const connect = screen.getByRole('button', { name: 'Connect Google' }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    expect(screen.getByText('Set up Google above first.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toBe('Paste the Client ID from Google.');
    await user.type(screen.getByLabelText('CLIENT ID'), '1234567890-abc.apps.googleusercontent.com');
    await user.type(screen.getByLabelText('CLIENT SECRET'), 'GOCSPX-secret');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Google app saved. Connect your own account to test it.');
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      clientId: '1234567890-abc.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-secret',
      userType: 'internal',
    });
    expect(
      await screen.findByText(/Set up · Client ID 1234567890-a… · Workspace domain \(Internal\)/),
    ).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Connect Google' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByText('TROUBLESHOOTING')).toBeTruthy();
    expect(screen.getByText('redirect_uri_mismatch')).toBeTruthy();
  });

  it('reads a dropped client_secret JSON in the browser and refuses a Desktop client', async () => {
    const user = userEvent.setup();
    await openTab(baseStatus());
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const desktop = new File(
      [JSON.stringify({ installed: { client_id: 'x', client_secret: 'y' } })],
      'client_secret_1.json',
      {
        type: 'application/json',
      },
    );
    await user.upload(input, desktop);
    expect((await screen.findByRole('alert')).textContent).toBe(DESKTOP_CLIENT_ERROR);

    const web = new File(
      [
        JSON.stringify({
          web: {
            client_id: '42-web.apps.googleusercontent.com',
            client_secret: 'GOCSPX-web',
            redirect_uris: ['https://elsewhere.example/cb'],
          },
        }),
      ],
      'client_secret_2.json',
      { type: 'application/json' },
    );
    await user.upload(input, web);
    await waitFor(() =>
      expect((screen.getByLabelText('CLIENT ID') as HTMLInputElement).value).toBe(
        '42-web.apps.googleusercontent.com',
      ),
    );
    expect((screen.getByLabelText('CLIENT SECRET') as HTMLInputElement).value).toBe('GOCSPX-web');
    expect(
      screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === redirectMismatchText(REDIRECT)),
    ).toBeTruthy();
  });

  it('asks for the secret when Replace brings another client (IN-27)', async () => {
    const user = userEvent.setup();
    const { calls } = await openTab(baseStatus({ google: { ...baseStatus().google, app: CONFIGURED } }));
    await user.click(screen.getByRole('button', { name: 'Replace' }));
    await user.type(screen.getByLabelText('CLIENT ID'), '999-other.apps.googleusercontent.com');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toBe('A new Client ID needs its client secret too.');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    // The same client (another audience) keeps the saved secret.
    await user.clear(screen.getByLabelText('CLIENT ID'));
    await user.type(screen.getByLabelText('CLIENT ID'), '1234567890-abc.apps.googleusercontent.com');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Google app saved. Connect your own account to test it.');
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      clientId: '1234567890-abc.apps.googleusercontent.com',
      userType: 'external',
    });
  });

  it('is read-only when the app is set in config', async () => {
    await openTab(
      baseStatus({
        google: {
          ...baseStatus().google,
          app: { ...CONFIGURED, source: 'config', clientIdHint: '5550001-conf…', userType: null },
        },
      }),
    );
    expect(screen.getByText('Set in this Whombat’s config · Client ID 5550001-conf…')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Set up Google' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
  });

  it('lists each connected service with its check, the enable link, Check again and Disconnect', async () => {
    const user = userEvent.setup();
    const { calls } = await openTab(
      baseStatus({
        google: { ...baseStatus().google, app: CONFIGURED, tested: true },
        connections: [connection()],
      }),
    );
    expect(screen.getByText('mara.oduya@example.com')).toBeTruthy();
    expect(
      screen.getByText('Connected as Mara Oduya · Gmail, Google Calendar and Google Drive'),
    ).toBeTruthy();
    const services = screen.getByRole('list', { name: 'Services' });
    expect(within(services).getByText('API turned off in your Google project')).toBeTruthy();
    expect(
      within(services)
        .getByRole('link', { name: /Turn it on/ })
        .getAttribute('href'),
    ).toBe('https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=42');
    expect(within(services).getAllByText('Working')).toHaveLength(2);
    // Google works: its app folds to one line, the steps behind Technical details, no troubleshooting.
    expect(screen.getByText('Set up for this Whombat')).toBeTruthy();
    expect(screen.queryByText('TROUBLESHOOTING')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Set up Google' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Technical details' }));
    expect(screen.getByText(/^Client ID 1234567890-a…/)).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Set up Google' })).toBeTruthy();

    // When the checks ran, not when the token was last refreshed.
    expect(screen.getByText('Checked 3 days ago')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(within(services).getAllByText('Working')).toHaveLength(3));
    expect(screen.getByText('Checked just now')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/me/connections/con_mara/check')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await user.click(screen.getByRole('button', { name: 'Disconnect Google' }));
    await screen.findByText('Google disconnected.');
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/me/connections/con_mara')).toBe(true);
    expect(await screen.findByRole('button', { name: 'Connect Google' })).toBeTruthy();
  });

  it('says why a connection needs connecting again, and reconnects with the ticked services', async () => {
    const user = userEvent.setup();
    const { calls } = await openTab(
      baseStatus({
        google: { ...baseStatus().google, app: CONFIGURED },
        connections: [
          connection({ status: 'needs_reauth', reauthReason: 'testing_expired', services: ['mail'] }),
        ],
      }),
    );
    expect(
      screen.getByText(
        'Google signed you out after 7 days because this Whombat’s Google app is still in Testing. Sign in again, and publish the app in Google Cloud.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    const gmail = screen.getByRole('checkbox', { name: 'Gmail' }) as HTMLInputElement;
    expect(gmail.checked).toBe(true);
    // Connecting again only adds services (CN-04, IN-31): the connected ones can't be unticked here.
    expect(gmail.disabled).toBe(true);
    expect(
      screen.getByText('Services you connected stay connected. Disconnect removes them all.'),
    ).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Google Drive' }) as HTMLInputElement).checked).toBe(false);
    await user.click(screen.getByRole('checkbox', { name: 'Google Calendar' }));
    await user.click(screen.getByRole('button', { name: 'Continue to Google' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/me/connections/google/start')).toBe(true));
    expect(calls.find((c) => c.path === '/me/connections/google/start')?.body).toEqual({
      services: ['mail', 'calendar'],
      returnTo: '/settings?tab=connections&connection=google&burrow=burrow-hq',
    });
  });

  it('explains a failed connection in the card', async () => {
    // Google comes back to the address the connect started with (its `returnTo`), redirected to the Connections page.
    const { app } = await openTab(baseStatus({ google: { ...baseStatus().google, app: CONFIGURED } }), {
      path: '/settings?tab=connections&connection=google&connect_error=access_denied',
    });
    expect(
      await screen.findByText('Google didn’t connect: access wasn’t allowed. Try again and choose Allow.'),
    ).toBeTruthy();
    // Google's page stays open once the answer is off the address (AP-673).
    await waitFor(() => expect(app.location()).toBe(`/connections?connection=google`));
    expect(
      screen.getByText('Google didn’t connect: access wasn’t allowed. Try again and choose Allow.'),
    ).toBeTruthy();
  });
});

/** Settings → Connections. */
const ACCOUNTS = '/settings?tab=connections';

describe('Settings → Connections, the overview (AP-673; connections-redesign.md AP-1157…AP-1166; sidebar-tabs.md)', () => {
  async function openOverview(
    status: ConnectorsStatus,
    options: { bare?: boolean; path?: string; protocolMinor?: number } = {},
  ) {
    const server = mockServer(status, options);
    const user = userEvent.setup();
    const app = renderApp(
      options.path ?? ACCOUNTS,
      mockedServices(server.fetch, options.protocolMinor ? { protocolMinor: options.protocolMinor } : {}),
    );
    if (options.path) await screen.findByRole('searchbox', { name: 'Search connections' });
    else await screen.findByText('What this Whombat is signed in to, and how.');
    return { ...server, app, user };
  }

  /** Add a connection, opened from the overview's button. */
  async function openAdd(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
      within(document.getElementById('settings-panel') as HTMLElement).getByRole('link', {
        name: 'Add a connection',
      }),
    );
    return screen.findByRole('searchbox', { name: 'Search connections' });
  }

  it('lists what you connected in one line each: logo, name, account, whose; and opens its page', async () => {
    const { app, user } = await openOverview(
      baseStatus({
        google: { ...baseStatus().google, app: CONFIGURED, tested: true },
        connections: [connection()],
      }),
      OLDER_BOX,
    );
    const connected = screen.getByRole('region', { name: 'ACCOUNTS' });
    const row = within(connected).getByRole('link', {
      name: /^Google\s*mara\.oduya@example\.com/,
    });
    // What it brings is on its page (AP-1177).
    expect(row.textContent).not.toContain('Gmail, Google Calendar and Google Drive');
    expect(row.textContent).not.toMatch(/Only you|Shared/);
    // The state is for screen readers; the dot shows it.
    expect(row.textContent).toContain('Connected');
    expect(row.querySelector('svg path[fill="#4285F4"]')).toBeTruthy();
    // Google doesn't need you, and the catalog isn't on the overview.
    const needs = screen.queryByRole('region', { name: 'NEEDS YOU' });
    if (needs) expect(within(needs).queryByRole('link', { name: /^Google/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Connect Google' })).toBeNull();
    expect(screen.queryByText('For this Whombat')).toBeNull();

    // Its page is on the Connections page, and its way back goes there.
    await user.click(row);
    await waitFor(() => expect(app.location()).toBe('/connections?connection=google'));
    expect(await screen.findByText('Set up for this Whombat')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Google' })).toBeTruthy();
    await user.click(screen.getByRole('link', { name: '← Connections' }));
    await waitFor(() => expect(app.location()).toBe('/connected'));
  });

  it('puts a connection that needs connecting again under NEEDS YOU, with Connect again', async () => {
    const { app, user } = await openOverview(
      baseStatus({
        google: { ...baseStatus().google, app: CONFIGURED },
        connections: [connection({ status: 'needs_reauth', reauthReason: 'revoked' })],
      }),
      OLDER_BOX,
    );
    const needs = screen.getByRole('region', { name: 'NEEDS YOU' });
    const row = within(needs).getByRole('link', { name: /^Google\s*mara\.oduya@example\.com/ });
    expect(row.textContent).toContain('Needs you to sign in again');
    expect(row.textContent).toContain('Sign in again');
    expect(
      within(screen.getByRole('region', { name: 'ACCOUNTS' })).queryByRole('link', { name: /^Google/ }),
    ).toBeNull();
    await user.click(row);
    await waitFor(() => expect(app.location()).toBe('/connections?connection=google'));
  });

  it('offers every service on Add a connection: Connect, or Set up first', async () => {
    const { app, user } = await openOverview(
      baseStatus({ google: { ...baseStatus().google, app: CONFIGURED } }),
    );
    const search = await openAdd(user);
    await waitFor(() => expect(app.location()).toBe('/connections?connection=add'));
    expect(document.activeElement).toBe(search);
    const google = screen.getByRole('link', { name: 'Connect Google' });
    expect(google.textContent).toContain('Gmail, Calendar, Drive, Docs, Sheets and Contacts.');
    // GitHub is connected: still listed, Connected, opening its page.
    expect(screen.getByRole('link', { name: 'Open GitHub' }).textContent).toContain('Connected');
    await user.click(google);
    await waitFor(() => expect(app.location()).toBe('/connections?connection=google'));
    expect(await screen.findByRole('button', { name: 'Connect Google' })).toBeTruthy();
    cleanup();

    await openOverview(baseStatus(), { path: '/connections?connection=add' });
    const setUp = screen.getByRole('link', { name: 'Set up Google' });
    expect(setUp.textContent).toContain('Set up');
    expect(setUp.textContent).toContain('Set it up once, then you can connect.');
  });

  it('shows the catalog on the overview itself while nothing is connected (AP-1166)', async () => {
    const server = mockServer(baseStatus({ google: { ...baseStatus().google, app: CONFIGURED } }), {
      bare: true,
    });
    renderApp(ACCOUNTS, mockedServices(server.fetch));
    const add = await screen.findByRole('region', { name: 'ADD A CONNECTION' });
    expect(
      within(screen.getByRole('region', { name: 'CONNECTED' })).getByText('Nothing connected yet.'),
    ).toBeTruthy();
    expect(within(add).getByRole('searchbox', { name: 'Search connections' })).not.toBe(
      document.activeElement,
    );
    expect(within(add).getByRole('link', { name: 'Connect Google' })).toBeTruthy();
    expect(within(add).getByRole('link', { name: 'Connect GitHub' }).textContent).not.toContain('Connected');
    // No button to a page that would show the same (the sidebar's own + stays).
    const panel = document.getElementById('settings-panel') as HTMLElement;
    expect(within(panel).queryByRole('link', { name: 'Add a connection' })).toBeNull();
  });

  it('says so when connecting is turned off', async () => {
    const server = mockServer(baseStatus({ mode: 'off' }));
    renderApp('/connections?connection=add', mockedServices(server.fetch));
    expect(await screen.findByText('Connecting accounts is turned off on this Whombat.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View Google' })).toBeTruthy();
  });

  it('narrows Add a connection by search and chip, and keeps the Custom ones for “Not in the list?”', async () => {
    const { user } = await openOverview(baseStatus(), { path: '/connections?connection=add' });
    const search = await screen.findByRole('searchbox', { name: 'Search connections' });
    expect(search.getAttribute('placeholder')).toMatch(/^Search \d+ services$/);
    expect(document.querySelector('[data-provider="custom_mcp"]')).toBeNull();
    expect(screen.getByText(/^Not in the list\? Connect/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'any MCP server' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'any HTTP API' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Developer' }));
    const shown = () =>
      [...document.querySelectorAll('[data-provider]')].map((el) => el.getAttribute('data-provider'));
    expect(shown()).toContain('github');
    expect(shown()).not.toContain('google');
    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.type(search, 'calendar mail');
    expect(shown()).toEqual(['google']);
    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.getByText('No connection matches “zzz”.')).toBeTruthy();
    expect(screen.getByText(/^Not in the list\? Connect/)).toBeTruthy();
  });

  it('lists GitHub and Website feedback beside Google, each opening its own page in Connections (SS-05)', async () => {
    // GitHub is an account, Website feedback an app (sidebar-tabs.md).
    const first = await openOverview(baseStatus(), OLDER_BOX);
    const github = await screen.findByRole('link', { name: /^GitHub\s*@acme/ });
    expect(github.textContent).not.toMatch(/repositor(y|ies) on/);
    expect(github.querySelector('svg')).toBeTruthy();

    await first.user.click(github);
    await waitFor(() => expect(first.app.location()).toBe('/connections?connection=github'));
    expect(await screen.findByRole('heading', { level: 2, name: 'GitHub' })).toBeTruthy();
    expect(await screen.findByText('@acme')).toBeTruthy();
    // The working directory is on This Whombat now (SS-06).
    expect(screen.queryByText('WORKING DIRECTORY')).toBeNull();
    first.app.unmount();

    const { app, user } = await openOverview(baseStatus(), OLDER_BOX);
    const panel = within(document.getElementById('settings-panel') as HTMLElement);
    const feedback = await panel.findByRole('link', { name: /^Website feedback/ });
    await user.click(feedback);
    await waitFor(() => expect(app.location()).toBe('/connections?connection=feedback'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Website feedback' })).toBeTruthy();
    expect(await screen.findByText('INTEGRATIONS')).toBeTruthy();
  });

  it('opens Add a connection on the Connections page, with its way back there', async () => {
    const { app } = await openOverview(baseStatus(), { path: '/connections?connection=add' });
    expect(document.querySelector('[data-connections-page="add"]')).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: 'Settings' })).toBeNull();
    expect(screen.getByRole('link', { name: '← Connections' }).getAttribute('href')).toBe('/connected');
    expect(app.location()).toBe('/connections?connection=add');
  });

  it('sends the old Settings → Connections pages to the Connections page, in place of the old entry', async () => {
    const { app } = await openOverview(baseStatus(), { path: '/settings?tab=connections&connection=add' });
    await waitFor(() => expect(app.location()).toBe('/connections?connection=add'));
    expect(screen.getByRole('link', { name: '← Connections' })).toBeTruthy();
    expect(app.history.length).toBe(1);
    cleanup();

    const found = await openOverview(baseStatus(), { path: '/settings?tab=connections&found=1' });
    await waitFor(() => expect(found.app.location()).toBe('/connections?connection=add&found=1'));
  });

  it('sends Advanced’s old list of every connection to the Connections tab', async () => {
    const server = mockServer(baseStatus());
    const app = renderApp('/settings?tab=advanced&part=accounts', mockedServices(server.fetch));
    expect(await screen.findByRole('heading', { level: 1, name: 'Connections' })).toBeTruthy();
    await waitFor(() => expect(app.location()).toBe(ACCOUNTS));
    expect(await screen.findByText('What this Whombat is signed in to, and how.')).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'ACCOUNTS' })).getByRole('link', { name: /^GitHub/ }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'APPS AND SERVICES' })).getByRole('link', {
        name: /^Website feedback/,
      }),
    ).toBeTruthy();
  });
});

describe('Accounts with a page of their own (a box at session minor 7)', () => {
  const WORKS = { google: { ...baseStatus().google, app: CONFIGURED, tested: true } };
  const GOOGLE_PAGE = `/things/${encodeURIComponent('connection:con_mara')}`;

  it('opens a connected account’s page from its row; an older box keeps its Settings page', async () => {
    const server = mockServer(
      baseStatus({
        ...WORKS,
        connections: [connection({ status: 'needs_reauth', reauthReason: 'revoked' })],
      }),
    );
    renderApp(ACCOUNTS, mockedServices(server.fetch));
    await screen.findByText('What this Whombat is signed in to, and how.');
    const accounts = within(screen.getByRole('region', { name: 'ACCOUNTS' }));
    expect(accounts.getByRole('link', { name: /^GitHub/ }).getAttribute('href')).toBe(
      `/things/${encodeURIComponent('connection:github')}`,
    );
    const panel = within(document.getElementById('settings-panel') as HTMLElement);
    expect((await panel.findByRole('link', { name: /^Website feedback/ })).getAttribute('href')).toBe(
      `/things/${encodeURIComponent('connection:feedback')}`,
    );
    // Signed out: its Connection tab, where Reconnect is.
    const needs = within(screen.getByRole('region', { name: 'NEEDS YOU' }));
    expect(needs.getByRole('link', { name: /^Google/ }).getAttribute('href')).toBe(
      `${GOOGLE_PAGE}?tab=settings`,
    );
    cleanup();

    renderApp(ACCOUNTS, mockedServices(mockServer(baseStatus()).fetch, OLDER_BOX));
    await screen.findByText('What this Whombat is signed in to, and how.');
    expect(
      within(screen.getByRole('region', { name: 'ACCOUNTS' }))
        .getByRole('link', { name: /^GitHub/ })
        .getAttribute('href'),
    ).toBe('/settings?tab=connections&connection=github');
  });

  it('opens a connected account’s Settings address as its page’s Connection tab, in place of the address', async () => {
    const server = mockServer(baseStatus({ ...WORKS, connections: [connection()] }));
    const app = renderApp('/settings?tab=connections&connection=google', mockedServices(server.fetch));
    await waitFor(() => expect(app.location()).toBe(`${GOOGLE_PAGE}?tab=settings`));
    expect(app.history.length).toBe(1);
    cleanup();

    // GitHub, by its own thing.
    const github = renderApp(
      '/connections?connection=github',
      mockedServices(mockServer(baseStatus()).fetch),
    );
    await waitFor(() =>
      expect(github.location()).toBe(`/things/${encodeURIComponent('connection:github')}?tab=settings`),
    );
  });

  it('keeps the Settings page of an account that isn’t connected', async () => {
    const server = mockServer(baseStatus(WORKS));
    const app = renderApp('/connections?connection=google', mockedServices(server.fetch));
    expect(await screen.findByRole('button', { name: 'Connect Google' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Google' })).toBeTruthy();
    expect(app.location()).toBe('/connections?connection=google');
    cleanup();

    // Nothing at all connected: GitHub's page stays too.
    renderApp(
      '/connections?connection=github',
      mockedServices(mockServer(baseStatus(), { bare: true }).fetch),
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'GitHub' })).toBeTruthy();
  });

  it('opens the account’s Summary after a sign-in came back, with its toast', async () => {
    const server = mockServer(baseStatus({ ...WORKS, connections: [connection()] }));
    const app = renderApp(
      '/settings?tab=connections&connection=google&connected=google',
      mockedServices(server.fetch),
    );
    await waitFor(() => expect(app.location()).toBe(GOOGLE_PAGE));
    expect(await screen.findByText('Google connected: mara.oduya@example.com.')).toBeTruthy();
  });

  it('keeps the Settings page after a sign-in that failed, with its reason', async () => {
    const failed = renderApp(
      '/settings?tab=connections&connection=google&connect_error=access_denied',
      mockedServices(mockServer(baseStatus({ ...WORKS, connections: [connection()] })).fetch),
    );
    expect(
      await screen.findByText('Google didn’t connect: access wasn’t allowed. Try again and choose Allow.'),
    ).toBeTruthy();
    // The answer leaves the address; the page stays, with the reason.
    await waitFor(() => expect(failed.location()).toBe('/connections?connection=google'));
    expect(screen.getByText(/access wasn’t allowed/)).toBeTruthy();
  });
});

describe('connections copy', () => {
  it('reads Google’s client_secret JSON', () => {
    expect(
      parseClientSecretFile('{"web":{"client_id":" a.apps ","client_secret":"s","redirect_uris":["u"]}}'),
    ).toEqual({
      ok: true,
      clientId: 'a.apps',
      clientSecret: 's',
      redirectUris: ['u'],
    });
    expect(parseClientSecretFile('{"installed":{"client_id":"a","client_secret":"s"}}')).toEqual({
      ok: false,
      error: DESKTOP_CLIENT_ERROR,
    });
    expect(parseClientSecretFile('not json').ok).toBe(false);
    expect(parseClientSecretFile('{"web":{}}').ok).toBe(false);
  });
});
