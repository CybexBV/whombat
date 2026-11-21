/**
 * The AI pages in the assistant shell (docs/decisions/less-is-more.md AP-1780…AP-1788; Whombat settings-groups.md)
 * against the fixture world: Mara with her assistant Neo, signed in to Claude Code with her Max
 * subscription (62 % of its 5-hour window) and to ChatGPT with an API key. Neo's AI sign-in: a row per provider with its
 * sign-in and its usage. Advanced → AI on this Whombat: one line for what is on this Whombat (folded unless something
 * needs her; Claude Code the one client, ChatGPT needs none, chatgpt-no-client.md AP-5614). Advanced → Spend: the spend
 * without the crew, and nobody else's usage (one-person.md AP-5693).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UsageListOutput } from '@whombat/core/contracts';
import type { AgentSetupStatus, SubscriptionUsage } from '@whombat/core/domain';
import { burrow, USAGE_SNAPSHOTS } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import type { AppServices } from '../../app/services';
import type { FakeAiOptions } from '../../managed/fake/ai';
import { pinMockDate } from '../../test/clock';
import { mockedServices, renderApp } from '../../test/renderApp';
import { foldSummary, newerVersion, signInsHelp } from './aiSummary';

pinMockDate();

const B = burrow.slug;

const READY: AgentSetupStatus = {
  hermes: { ready: true, version: '0.22.5', problem: null, detail: null },
  runner: { connected: true, seenAt: '2026-09-23T09:20:00.000Z' },
  providers: [
    { provider: 'claude', state: 'ready', version: '2.1.278', detail: null, sandboxProblem: null },
    { provider: 'codex', state: 'ready', version: 'Hermes 0.22.5', detail: null, sandboxProblem: null },
  ],
  defaultProvider: 'claude',
  checkedAt: '2026-09-23T09:20:00.000Z',
  recheckPending: false,
};

const maraClaude = USAGE_SNAPSHOTS[0] as SubscriptionUsage;
const maraCodex = USAGE_SNAPSHOTS[1] as SubscriptionUsage;

interface WorldOptions {
  ai?: FakeAiOptions;
  /** What the runner reports instead of READY. */
  setup?: AgentSetupStatus;
  /** `clients.list` instead of the fake's (an older Whombat that still lists a Codex client). */
  clients?: unknown;
  usage?: UsageListOutput;
  refresh?: Response[];
}

/** Mara's world in the assistant shell, with the host ready; `usage`, `spend` and `usage.refresh` answers replaced. */
function world({ ai, setup = READY, clients, usage, refresh = [] }: WorldOptions = {}) {
  const base = createWebFixtureFetch({
    ai: ai ?? {
      installed: { claude: '2.1.278' },
      signedIn: [
        { provider: 'claude', authMode: 'subscription_cli' },
        { provider: 'codex', authMode: 'api_key' },
      ],
    },
  });
  const calls = { refresh: 0 };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    if (url.pathname === `/api/v1/burrows/${B}/host/agents`) return Response.json(setup);
    if (url.pathname === '/api/v1/clients' && clients) return Response.json(clients);
    if (url.pathname === `/api/v1/burrows/${B}/usage` && usage) return Response.json(usage);
    if (url.pathname === `/api/v1/burrows/${B}/usage/refresh`) {
      calls.refresh++;
      const next = refresh.shift();
      if (next) return next;
    }
    return base(new Request(url, init), init);
  }) as unknown as typeof globalThis.fetch;
  return { services: mockedServices(fetch, {}), calls };
}

const signIns = () => screen.findByRole('region', { name: 'YOUR AI SIGN-INS' });

/** The assistant's AI sign-in, and Advanced → AI on this Whombat. */
const SIGN_INS = '/settings?tab=agent&part=ai';
const ON_THIS_WHOMBAT = '/settings?tab=advanced&part=ai';

/** A provider's row in the sign-ins: the row around its name, once the sign-ins are read. */
async function rowOf(region: HTMLElement, name: string): Promise<HTMLElement> {
  const title = await within(region).findByText(name, { selector: '[class*="name"]' });
  return title.closest('[class*="row"]') as HTMLElement;
}

describe('Settings → the AI sign-in and AI on this Whombat in the assistant shell (less-is-more.md)', () => {
  it('reads as one page: a row per provider with its sign-in and usage, no jump links, nothing of the crew', async () => {
    renderApp(SIGN_INS, world().services);
    const region = await signIns();
    expect(await within(region).findByText('Neo works on your own sign-in.')).toBeTruthy();

    const claude = await rowOf(region, 'Claude Code');
    await waitFor(() =>
      expect(
        within(claude).getByText('Signed in with your Claude subscription').parentElement?.textContent,
      ).toBe('Max plan · Signed in with your Claude subscription'),
    );
    const meters = await within(claude).findAllByRole('meter');
    expect(meters.map((m) => m.getAttribute('aria-label'))).toEqual([
      'Claude 5-hour usage',
      'Claude 7-day usage',
      'Claude 7-day Opus usage',
    ]);
    expect(within(claude).getByRole('button', { name: 'Refresh Claude usage' })).toBeTruthy();
    expect(within(claude).getByRole('button', { name: 'Sign out' })).toBeTruthy();

    const chatgpt = await rowOf(region, 'ChatGPT');
    expect(within(chatgpt).getByText('Signed in with your API key').parentElement?.textContent).toBe(
      'Pay as you go · Signed in with your API key',
    );
    expect(within(chatgpt).queryByRole('meter')).toBeNull();
    expect(within(chatgpt).queryByRole('button', { name: /Refresh/ })).toBeNull();
    expect(within(region).queryByText('Codex')).toBeNull();

    // No jump links, no group titles, no GitHub pointer (AP-1785).
    expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: 'Accounts' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Settings → Connections → GitHub' })).toBeNull();
    // The old anchors still land here; what is on this Whombat and Spend are Advanced's.
    expect(document.getElementById('accounts')).toBeTruthy();
    expect(document.getElementById('usage')).toBeTruthy();
    expect(document.getElementById('clients')).toBeNull();
    expect(screen.queryByRole('region', { name: 'SPEND' })).toBeNull();
  });

  it('opens Advanced’s Spend as Usage: what it cost and the times worked, nothing of the crew', async () => {
    renderApp('/settings?tab=advanced&part=spend', world().services);
    // Usage, the Spend report's one page (final-settings-vault-files-usage.md); no agents, no handoffs (AP-1782).
    expect(await screen.findByRole('heading', { level: 1, name: 'Usage' })).toBeTruthy();
    expect(await screen.findByText('$0.37')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /^BY AGENT/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'HANDOFF BUDGETS' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'TOP PLANS' })).toBeNull();
    expect(screen.queryByText(/· retired/)).toBeNull();
    // One person's Whombat: nobody else's usage or spend (one-person.md AP-5693).
    expect(screen.queryByRole('region', { name: 'EVERYONE' })).toBeNull();
    expect(screen.queryByRole('region', { name: /^BY PERSON/ })).toBeNull();
  });

  it('folds what is on this Whombat into one line, with the AI clients behind Details', async () => {
    const user = userEvent.setup();
    renderApp(ON_THIS_WHOMBAT, world().services);
    const fold = await screen.findByRole('region', { name: 'On this Whombat' });
    expect(document.getElementById('clients')).toBeTruthy();
    expect(await within(fold).findByText('Claude Code 2.1.278 is installed and up to date')).toBeTruthy();
    const details = within(fold).getByRole('button', { name: 'Details' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    expect(within(fold).queryByRole('region', { name: 'AI CLIENTS' })).toBeNull();

    await user.click(details);
    expect(within(fold).getByRole('button', { name: 'Hide details' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    const clients = within(fold).getByRole('region', { name: 'AI CLIENTS' });
    expect(within(clients).getByText('Agent runner')).toBeTruthy();
    expect(within(clients).getByText('Installed · 2.1.278')).toBeTruthy();
    expect(within(clients).getByRole('button', { name: 'Check again' })).toBeTruthy();
    // Claude Code is the one client: no row for ChatGPT, nothing to install (AP-5614).
    expect(within(clients).getAllByText(/^Installed ·/)).toHaveLength(1);
    expect(within(clients).queryByRole('button', { name: 'Install' })).toBeNull();
    expect(within(clients).queryByText(/^(ChatGPT|Codex)$/)).toBeNull();
    expect(within(clients).getByText(/^Usage is read from Claude Code and ChatGPT /)).toBeTruthy();
    expect(clients.textContent).not.toMatch(/Codex|Hermes/);
    expect(within(fold).queryByRole('region', { name: 'ORGANIZATION KEYS' })).toBeNull();
  });

  it('opens by itself when something there needs the person, and for #clients (AP-1753)', async () => {
    const first = renderApp(ON_THIS_WHOMBAT, world({ ai: { installed: {}, signedIn: [] } }).services);
    const fold = await screen.findByRole('region', { name: 'On this Whombat' });
    expect(await within(fold).findByText('Claude Code isn’t installed')).toBeTruthy();
    await waitFor(() =>
      expect(within(fold).getByRole('button', { name: 'Hide details' }).getAttribute('aria-expanded')).toBe(
        'true',
      ),
    );
    expect(within(fold).getAllByRole('button', { name: 'Install' })).toHaveLength(1);
    first.unmount();

    // The old #clients link lands on Advanced → AI on this Whombat, opened.
    const app = renderApp('/settings?tab=ai#clients', world().services);
    const linked = await screen.findByRole('region', { name: 'On this Whombat' });
    expect(app.location()).toBe(ON_THIS_WHOMBAT);
    expect(app.history.location.hash).toBe('#clients');
    expect(within(linked).getByRole('button', { name: 'Hide details' })).toBeTruthy();
  });

  it('ignores a Codex client an older Whombat still lists, and never offers to install it (AP-5614)', async () => {
    const user = userEvent.setup();
    const listed = (provider: 'claude' | 'codex', version: string | null) => ({
      provider,
      installed: version ? { version, installedAt: '2026-09-20T09:00:00.000Z' } : null,
      latest: { version: provider === 'claude' ? '2.1.278' : '0.157.0', publishedAt: '2026-09-24T08:00:00Z' },
      state: version ? 'installed' : 'not_installed',
      progress: null,
      error: null,
    });
    const w = () =>
      world({
        ai: { installed: { claude: '2.1.278' }, signedIn: [] },
        clients: {
          clients: [listed('claude', '2.1.278'), listed('codex', null)],
          checkedAt: null,
        },
      }).services;
    const first = renderApp(ON_THIS_WHOMBAT, w());
    const fold = await screen.findByRole('region', { name: 'On this Whombat' });
    expect(await within(fold).findByText('Claude Code 2.1.278 is installed and up to date')).toBeTruthy();
    await user.click(within(fold).getByRole('button', { name: 'Details' }));
    const clients = within(fold).getByRole('region', { name: 'AI CLIENTS' });
    expect(within(clients).queryByRole('button', { name: 'Install' })).toBeNull();
    expect(clients.textContent).not.toMatch(/Codex|0\.157\.0/);
    first.unmount();
    // ChatGPT's sign-in doesn't wait for an install either.
    renderApp(SIGN_INS, w());
    const chatgpt = await rowOf(await signIns(), 'ChatGPT');
    const start = within(chatgpt).getByRole('button', { name: 'Sign in with your subscription (ChatGPT)' });
    expect((start as HTMLButtonElement).disabled).toBe(false);
    expect(within(chatgpt).queryByText(/waits until/)).toBeNull();
  });

  it('says in the contracts’ words when what turns run on isn’t ready, never its name (AP-5040)', async () => {
    const setup: AgentSetupStatus = {
      ...READY,
      hermes: { ready: false, version: null, problem: 'outdated', detail: 'hermes 0.22.4, want 0.22.5' },
    };
    renderApp(ON_THIS_WHOMBAT, world({ setup }).services);
    const fold = await screen.findByRole('region', { name: 'On this Whombat' });
    expect(await within(fold).findByText('Part of this Whombat is out of date')).toBeTruthy();
    const row = await within(fold).findByText('Agent runner');
    const runner = row.closest('[data-engine-problem]') as HTMLElement;
    expect(runner.getAttribute('data-engine-problem')).toBe('outdated');
    expect(within(runner).getByRole('status').textContent).toContain('Updating this Whombat fixes it.');
    expect(document.body.textContent).not.toMatch(/hermes/i);
  });

  it('shows the shell’s notice in those words off Settings', async () => {
    const setup: AgentSetupStatus = {
      ...READY,
      hermes: { ready: false, version: null, problem: 'broken', detail: null },
    };
    renderApp('/chat', world({ setup }).services);
    expect(await screen.findByText(/can’t reply yet: part of this Whombat didn’t start/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Set up AI provider' })).toBeTruthy();
  });

  it('asks a person on a managed Whombat to sign in to Claude Code or ChatGPT, installed or not (AP-5616, FDY-33)', async () => {
    const managed = (ai: FakeAiOptions) => ({
      ...world({ ai }).services,
      managed: {} as NonNullable<AppServices['managed']>,
    });
    const first = renderApp('/chat', managed({ installed: { claude: '2.1.278' }, signedIn: [] }));
    const both = await screen.findByText(/^You haven’t signed in to/);
    expect(both.textContent).toContain('Claude Code or ChatGPT');
    first.unmount();
    // Nothing installed: still both, so it doesn't look as if the Whombat had chosen ChatGPT.
    renderApp('/chat', managed({ installed: {}, signedIn: [] }));
    const none = await screen.findByText(/^You haven’t signed in to/);
    expect(none.textContent).toContain('Claude Code or ChatGPT');
    expect(none.textContent).not.toMatch(/Codex/);
  });

  it('refreshes a subscription from its row, then waits the minute before the next', async () => {
    const user = userEvent.setup();
    const fresh = { ...maraClaude, observedAt: '2026-09-23T09:22:00.000Z' };
    const w = world({ refresh: [Response.json({ usage: fresh })] });
    renderApp(SIGN_INS, w.services);
    const claude = await rowOf(await signIns(), 'Claude Code');
    await user.click(await within(claude).findByRole('button', { name: 'Refresh Claude usage' }));
    expect(
      await within(claude).findByRole('button', { name: /^Refresh in (60|59) s \(Claude\)$/ }),
    ).toBeTruthy();
    expect(w.calls.refresh).toBe(1);
  });

  it('says how old a stale snapshot is, after the row’s state', async () => {
    const stale = { ...maraClaude, observedAt: '2026-09-23T08:32:00.000Z' };
    renderApp(SIGN_INS, world({ usage: { mine: [stale, maraCodex] } }).services);
    const claude = await rowOf(await signIns(), 'Claude Code');
    await waitFor(() =>
      expect(
        within(claude).getByText('Signed in with your Claude subscription').parentElement?.textContent,
      ).toBe('Max plan · Signed in with your Claude subscription · usage as of 10:32'),
    );
  });
});

describe('the folded line (AP-1786)', () => {
  const client = (provider: 'claude' | 'codex', version: string | null, latest = version) => ({
    provider,
    installed: version ? { version, installedAt: '2026-09-20T09:00:00.000Z' } : null,
    latest: latest ? { version: latest, publishedAt: '2026-09-24T08:00:00Z' } : null,
    state: version ? ('installed' as const) : ('not_installed' as const),
    progress: null,
    error: null,
  });
  const clients = (...c: ReturnType<typeof client>[]) => ({ clients: c, checkedAt: null });

  it('says what is installed, and whether a newer tested version waits', () => {
    expect(foldSummary({ clients: clients(client('claude', '2.1.302', '2.1.278')), setup: READY })).toEqual({
      text: 'Claude Code 2.1.302 is installed and up to date',
      tone: 'ok',
      attention: false,
    });
    expect(foldSummary({ clients: clients(client('claude', '2.1.278', '2.1.300')), setup: READY }).text).toBe(
      'Claude Code 2.1.278 is installed and updates itself',
    );
  });

  it('says nothing about a Codex client an older Whombat still lists (AP-5614)', () => {
    for (const codex of [client('codex', null), client('codex', '0.162.1')])
      expect(foldSummary({ clients: clients(client('claude', '2.1.302'), codex), setup: READY })).toEqual({
        text: 'Claude Code 2.1.302 is installed and up to date',
        tone: 'ok',
        attention: false,
      });
  });

  it('puts what needs the person first, and opens for it', () => {
    const both = clients(client('claude', '2.1.278'));
    expect(
      foldSummary({ clients: both, setup: { ...READY, runner: { connected: false, seenAt: null } } }),
    ).toEqual({
      text: 'Part of Whombat is restarting',
      tone: 'bad',
      attention: true,
    });
    expect(foldSummary({ clients: clients(client('claude', null)), setup: READY })).toEqual({
      text: 'Claude Code isn’t installed',
      tone: 'warn',
      attention: true,
    });
    const broken: AgentSetupStatus = {
      ...READY,
      providers: [
        READY.providers[0] as AgentSetupStatus['providers'][number],
        { ...(READY.providers[1] as AgentSetupStatus['providers'][number]), state: 'error' },
      ],
    };
    expect(foldSummary({ clients: both, setup: broken }).text).toBe('ChatGPT isn’t working');
    // What turns run on isn't ready (AP-5040): the contracts' first sentence, never its name.
    const missing = foldSummary({
      clients: both,
      setup: { ...READY, hermes: { ready: false, version: null, problem: 'missing', detail: 'not found' } },
    });
    expect(missing).toMatchObject({ tone: 'bad', attention: true });
    expect(missing.text).not.toMatch(/hermes|\./i);
  });

  it('compares versions as numbers', () => {
    expect(newerVersion('2.1.300', '2.1.296')).toBe(true);
    expect(newerVersion('2.1.278', '2.1.296')).toBe(false);
    expect(newerVersion('0.162.1', '0.162.1')).toBe(false);
  });

  it('says through which gateway a provider’s turns go', () => {
    expect(signInsHelp('Neo', null)).toBe('Neo works on your own sign-in.');
    expect(signInsHelp('Neo', { name: 'Fusebox', providers: ['claude'] })).toBe(
      'Neo works on your own sign-in (Claude Code goes through Fusebox).',
    );
  });
});
