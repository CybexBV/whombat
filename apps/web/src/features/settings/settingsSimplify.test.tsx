/**
 * Settings simplified (docs/decisions/settings-simplify.md; Whombat settings-groups.md): four groups, the old addresses
 * redirected in place (SS-02), This Whombat with its VERSION on every Whombat (SS-06) and the account menu's
 * version line (SS-08).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentSetupStatus } from '@whombat/core/domain';
import { burrow } from '@whombat/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { ASSISTANT_NAME } from '../../app/oneFixtures';
import { mockedServices, renderApp } from '../../test/renderApp';
import { appVersions, versionLine } from './version';

const SETUP: AgentSetupStatus = {
  hermes: { ready: true, version: '0.22.5', problem: null, detail: null },
  runner: { connected: true, seenAt: '2026-09-23T09:20:00.000Z' },
  providers: [
    {
      provider: 'claude',
      state: 'ready',
      version: '2.1.278',
      detail: null,
      sandboxProblem: null,
    },
    { provider: 'codex', state: 'ready', version: 'Hermes 0.22.5', detail: null, sandboxProblem: null },
  ],
  defaultProvider: 'claude',
  checkedAt: '2026-09-23T09:20:00.000Z',
  recheckPending: false,
};

/** The fixture world, with the host's AI readiness (`host.agents`) and, when given, the server's version. */
function world(options: { version?: string } = {}) {
  const base = createWebFixtureFetch({ ai: { installed: { claude: '2.1.278' } } });
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const req = new Request(url, input instanceof Request ? input : init);
    if (url.pathname === `/api/v1/burrows/${burrow.slug}/host/agents`) return Response.json(SETUP);
    if (url.pathname === '/api/v1/health' && options.version)
      return Response.json({ ok: true, service: 'whombat-server', db: 'up', version: options.version });
    return base(req);
  };
  return mockedServices(fetch as typeof globalThis.fetch);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Settings’ home (final-settings-vault-files-usage.md)', () => {
  it('shows Often used, then You, the assistant by its name, Connections, This Whombat and Advanced, in that order', async () => {
    const user = userEvent.setup();
    const app = renderApp('/settings', world());
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    const often = screen.getByRole('region', { name: 'Often used' });
    expect(
      within(often)
        .getByRole('link', { name: /^Notifications/ })
        .getAttribute('href'),
    ).toBe('/settings?part=notifications');
    expect(within(often).queryByText(/brief/i)).toBeNull();
    const groups = [...document.querySelectorAll('[data-settings-group]')].map(
      (g) => g.querySelector('[class*="name"]')?.textContent,
    );
    // Screens shows where this Whombat has screens; the fixture world has none.
    expect(groups).toEqual(['You', ASSISTANT_NAME, 'Connections', 'This Whombat', 'Advanced']);
    // Theme opens its choice in place.
    await user.click(within(often).getByRole('button', { name: /^Theme/, expanded: false }));
    expect(within(often).getByRole('group', { name: 'Theme' })).toBeTruthy();
    // A group's page says its name and the way back.
    await user.click(screen.getByRole('link', { name: /^You/ }));
    await waitFor(() => expect(app.location()).toBe('/settings?part=profile'));
    expect(await screen.findByRole('heading', { name: 'You', level: 1 })).toBeTruthy();
    // The AI provider isn't on the profile any more (SS-03).
    expect(screen.queryByText('AI PROVIDER')).toBeNull();
    await user.click(screen.getByRole('link', { name: 'Back to Settings' }));
    await waitFor(() => expect(app.location()).toBe('/settings'));
  });

  it('keeps every row working when your saved settings can’t be read, with Try again', async () => {
    const base = createWebFixtureFetch();
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
      if (url.pathname === '/api/v1/me/preferences')
        return Response.json({ error: { code: 'internal', message: 'down' } }, { status: 500 });
      return base(new Request(url, input instanceof Request ? input : init));
    }) as typeof globalThis.fetch;
    renderApp('/settings', mockedServices(fetch));
    const failed = await screen.findByRole('alert');
    expect(within(failed).getByText('Couldn’t read your settings')).toBeTruthy();
    expect(within(failed).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Advanced/ })).toBeTruthy();
  });
});

describe('old Settings addresses (SS-02)', () => {
  it.each([
    ['/settings?tab=usage', '/settings?tab=agent&part=ai', '', ASSISTANT_NAME],
    ['/settings?tab=ai#clients', '/settings?tab=advanced&part=ai', '#clients', 'Advanced'],
    ['/settings?tab=general', '/settings?part=profile', '', 'You'],
    ['/settings?tab=about', '/settings?tab=agent&part=memory', '', ASSISTANT_NAME],
    ['/settings?tab=devices', '/settings?part=devices', '', 'You'],
    ['/settings?tab=appliance#devices', '/settings?part=devices', '', 'You'],
    ['/settings?tab=appliance&section=access', '/settings?tab=agent&part=may', '', ASSISTANT_NAME],
    ['/settings#ai-provider', '/settings?tab=agent&part=ai', '', ASSISTANT_NAME],
  ])('opens %s as %s%s, in place of the old entry', async (from, to, hash, title) => {
    const app = renderApp(from, world());
    expect(await screen.findByRole('heading', { name: title, level: 1 })).toBeTruthy();
    await waitFor(() => expect(app.location()).toBe(to));
    expect(app.history.location.hash).toBe(hash);
    expect(app.history.length).toBe(1);
  });

  // GitHub isn't connected in this world: its Settings page. Website feedback has a site: its own page's Connection tab.
  it.each([
    ['/settings?tab=repos', '/connections?connection=github', 'GitHub', 2],
    [
      '/settings?tab=feedback',
      `/things/${encodeURIComponent('connection:feedback')}?tab=settings`,
      'Website feedback',
      1,
    ],
  ])('opens %s as %s, in place of the old entry', async (from, to, name, level) => {
    const app = renderApp(from, world());
    expect(await screen.findByRole('heading', { name, level })).toBeTruthy();
    await waitFor(() => expect(app.location()).toBe(to));
    expect(app.history.length).toBe(1);
  });

  it('opens /settings?tab=spend as Usage, its own page at Advanced’s old address', async () => {
    const app = renderApp('/settings?tab=spend', world());
    expect(await screen.findByRole('heading', { level: 1, name: 'Usage' })).toBeTruthy();
    await waitFor(() => expect(app.location()).toBe('/settings?tab=advanced&part=spend'));
    expect(screen.queryByRole('tab', { name: 'Advanced' })).toBeNull();
    expect(app.history.length).toBe(1);
  });

  it.each(['/settings?tab=packs', '/settings?tab=skills', '/settings?tab=agent&part=skills'])(
    'opens %s as Settings → Advanced → Skills (AP-883, AP-5530)',
    async (from) => {
      const app = renderApp(from, world());
      expect(await screen.findByRole('heading', { name: 'Advanced', level: 1 })).toBeTruthy();
      await waitFor(() => expect(app.location()).toBe('/settings?tab=advanced&part=skills'));
      expect(document.querySelector('[data-advanced-part]')?.getAttribute('data-advanced-part')).toBe(
        'skills',
      );
      expect(app.history.length).toBe(1);
    },
  );
});

describe('Settings → This Whombat in parts (this-whombat-sections.md AP-1221…AP-1225, SS-06, SS-07)', () => {
  it('opens on the Overview: how it’s doing, then the rest at a glance, each row a way to its part', async () => {
    vi.stubEnv('VITE_WHOMBAT_VERSION', '0.36.0');
    const user = userEvent.setup();
    const app = renderApp('/settings?tab=appliance', world({ version: '0.41.1' }));
    const parts = await screen.findByRole('group', { name: 'Parts of This Whombat' });
    // The assistant's access is its What it may do now.
    expect(
      within(parts)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual(['Overview', 'Backups', 'About']);
    expect(within(parts).getByRole('radio', { name: 'Overview' })).toHaveProperty('checked', true);
    const glance = await screen.findByRole('region', { name: 'AT A GLANCE' });
    const labels = [...document.querySelectorAll('#settings-panel h2')].map((h) => h.textContent);
    expect(labels[0]).toBe('How it’s doing');
    expect(labels).toContain('AT A GLANCE');
    const version = await within(glance).findByRole('button', { name: /^Version/ });
    expect(version.textContent).toBe('VersionApp 0.36.0 · Whombat 0.41.1');
    await user.click(version);
    await waitFor(() => expect(app.location()).toBe('/settings?tab=appliance&section=about'));
    expect(await screen.findByRole('region', { name: 'VERSION' })).toBeTruthy();
  });

  it('About: VERSION first — the Whombat, every version under Technical details — then the rest', async () => {
    vi.stubEnv('VITE_WHOMBAT_VERSION', '0.36.0');
    vi.stubEnv('VITE_WHOMBAT_BUILD', '0.36.0+1a2b3c4');
    vi.stubEnv('VITE_WHOMBAT_CONTRACTS', '0.45.2');
    const user = userEvent.setup();
    renderApp('/settings?tab=appliance&section=about', world({ version: '0.41.1' }));
    const version = await screen.findByRole('region', { name: 'VERSION' });
    expect(await within(version).findByText('Whombat 0.41.1')).toBeTruthy();
    // The versions wait behind Technical details.
    expect(within(version).queryByText('App')).toBeNull();
    await user.click(within(version).getByRole('button', { name: 'Technical details' }));
    expect(within(version).getByText('App').closest('div')?.textContent).toBe(
      'AppBuild 0.36.0+1a2b3c40.36.0',
    );
    expect(within(version).getByText('0.41.1')).toBeTruthy();
    expect(within(version).getByText('0.45.2')).toBeTruthy();
    await user.click(within(version).getByRole('button', { name: 'Hide technical details' }));
    expect(within(version).queryByText('App')).toBeNull();
    const labels = [...document.querySelectorAll('#settings-panel h2')].map((h) => h.textContent);
    expect(labels[0]).toBe('VERSION');
    expect(labels).toContain('HARDWARE');
    // The audit log is Advanced's now.
    expect(labels).not.toContain('AUDIT LOG');
  });

  it('the audit log and the signing keys are in Advanced', async () => {
    renderApp('/settings?tab=advanced&part=audit', world());
    expect(await screen.findByRole('region', { name: 'AUDIT LOG' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'SIGNING KEYS' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the audit log' }).getAttribute('href')).toBe('/log');
  });

  it('What the assistant may do has no working directory and no web browser of the Whombat’s own (HE-42, HE-48, AP-5250)', async () => {
    renderApp('/settings?tab=agent&part=may', world());
    await screen.findByRole('region', { name: 'SERVERS' });
    const labels = [...document.querySelectorAll('#settings-panel h2')].map((h) => h.textContent);
    expect(labels).not.toContain('WEB BROWSER');
    expect(labels).not.toContain('WORKING DIRECTORY');
    expect(labels).not.toContain('VERSION');
  });

  it('shows the app’s version alone when the server doesn’t say its own', async () => {
    vi.stubEnv('VITE_WHOMBAT_VERSION', '0.36.0');
    const user = userEvent.setup();
    renderApp('/settings?tab=appliance&section=about', world());
    const version = await screen.findByRole('region', { name: 'VERSION' });
    expect(within(version).getByText('Whombat 0.36.0')).toBeTruthy();
    await user.click(within(version).getByRole('button', { name: 'Technical details' }));
    expect(within(version).getByText('0.36.0')).toBeTruthy();
    expect(within(version).queryByText('Whombat')).toBeNull();
  });

  it('a part this Whombat doesn’t have shows the Overview', async () => {
    renderApp('/settings?tab=appliance&section=screen', world());
    const parts = await screen.findByRole('group', { name: 'Parts of This Whombat' });
    await waitFor(() =>
      expect(within(parts).getByRole('radio', { name: 'Overview' })).toHaveProperty('checked', true),
    );
  });
});

describe('the account menu’s version line (SS-08)', () => {
  it('says the Whombat’s and the app’s version and opens This Whombat → About (AP-1233)', async () => {
    vi.stubEnv('VITE_WHOMBAT_VERSION', '0.36.0');
    const user = userEvent.setup();
    const app = renderApp('/chat', world({ version: '0.41.1' }));
    await user.click(await screen.findByRole('button', { name: /^Account,/ }));
    const line = await screen.findByRole('link', { name: 'Whombat 0.41.1 · app 0.36.0. This Whombat' });
    expect(line.textContent).toBe('Whombat 0.41.1 · app 0.36.0');
    await user.click(line);
    await waitFor(() => expect(app.location()).toBe('/settings?tab=appliance&section=about'));
  });

  it('reads the versions from the build', () => {
    expect(versionLine({ app: '0.36.0', runtime: null })).toBe('app 0.36.0');
    expect(versionLine({ app: '0.36.0', runtime: '0.41.1' })).toBe('Whombat 0.41.1 · app 0.36.0');
    expect(appVersions({ VITE_WHOMBAT_BUILD: '0.36.0+1a2b3c4' })).toEqual({
      app: '0.36.0',
      build: '0.36.0+1a2b3c4',
      contracts: null,
    });
    expect(appVersions({ VITE_WHOMBAT_VERSION: '0.36.0', VITE_WHOMBAT_BUILD: '0.36.0' }).build).toBeNull();
    expect(appVersions({ VITE_WHOMBAT_CONTRACTS: 'unknown' })).toEqual({
      app: 'dev',
      build: null,
      contracts: null,
    });
  });
});
