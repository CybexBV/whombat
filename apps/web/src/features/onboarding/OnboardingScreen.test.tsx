import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { agentFaceStyle } from '@whombat/client';
import { burrow, dusty, mara, onboarding } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { createFakeAi, type FakeAi } from '../../managed/fake/ai';
import { fixtureServices, mockedServices, renderApp } from '../../test/renderApp';
import { AI_STEP_TEXT } from './onboardingCopy';

// The sign-in console's terminal without xterm (jsdom has no layout).
vi.mock('../ai/terminal', () => ({
  mountTerminal: () => ({
    cols: 72,
    rows: 12,
    write: () => {},
    onData: () => {},
    onResize: () => {},
    focus: () => {},
    dispose: () => {},
  }),
}));

describe('OnboardingScreen (fixture bootstrap)', () => {
  it('renders step 1 copy and checks the name against the seeded burrow', async () => {
    const user = userEvent.setup();
    renderApp('/onboarding');
    await screen.findByRole('heading', { name: 'Name your Whombat' });
    expect(screen.getByText('STEP 1 OF 3')).toBeTruthy();
    // Three steps (Whombat one-agent.md OA-13, one-person.md OP-11); “Set up your AI” replaces the mock's “Connect your
    // code” (SUB-08); nobody to invite (AP-5673).
    for (const s of ['Name your Whombat', 'Set up your AI', 'Meet your agent'])
      expect(screen.getAllByText(s).length).toBeGreaterThan(0);
    expect(screen.queryByText('Invite people')).toBeNull();
    expect(screen.queryByText('Connect your code')).toBeNull();
    // The tip is the agent's, Dusty until it is named (OA-08).
    expect(screen.getByText(/Hi, I’m Dusty\./)).toBeTruthy();

    await user.type(screen.getByLabelText('WHOMBAT NAME'), 'Burrow HQ');
    expect(await screen.findByText('That name is already taken.')).toBeTruthy();
    // Burrows are path-based at app.whombat.com (docs/decisions/production.md).
    expect(screen.getByText('app.whombat.com/burrow-hq')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('"Skip for now" leaves onboarding for the account’s first burrow', async () => {
    const user = userEvent.setup();
    const app = renderApp('/onboarding');
    await screen.findByRole('heading', { name: 'Name your Whombat' });
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(app.location()).not.toMatch(/^\/onboarding/));
  });
});

describe('OnboardingScreen quiet states (TODO 16.4)', () => {
  it('shows a one-line error with inline Retry when the slug check fails over the network', async () => {
    const user = userEvent.setup();
    renderApp('/onboarding', fixtureServices({ failing: ['burrows.slugCheck'] }));
    await screen.findByRole('heading', { name: 'Name your Whombat' });
    await user.type(screen.getByLabelText('WHOMBAT NAME'), 'Whatever Burrow');
    expect(await screen.findByText('Couldn’t check that name.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Couldn’t check that name.')).toBeTruthy();
  });
});

describe('OnboardingScreen (mocked server)', () => {
  /**
   * Scripts the burrow-creating write endpoints (not in the shared fixtures' `IMPLEMENTED` set —
   * see `docs/decisions/canvas-onboarding.md`); everything else, including the reads that follow
   * "Open the burrow" into the shell and the AI side (`signins.*`, `clients.*`, the fake in `managed/fake/ai.ts`),
   * falls through to the seeded world via `createWebFixtureFetch()`. The scripted burrow reuses the seeded
   * `burrow-hq` slug so that fall-through works without inventing a second burrow's worth of shell data.
   */
  function mockServer(
    options: {
      calls?: { method: string; path: string; body: unknown }[];
      finish?: { nameTaken?: string };
      ai?: FakeAi;
      /** A self-hosted server before contracts 0.9: no `clients.*`, the host's AI provider panel instead. */
      hostSetup?: boolean;
    } = {},
  ) {
    const { calls = [], finish = {} } = options;
    const ai = options.ai ?? createFakeAi({ installed: { claude: '2.1.278' } });
    const base = createWebFixtureFetch({ ai });
    // Host setup: the runner found Claude Code logged out and ChatGPT ready (as Hermes is).
    const agentSetup = {
      hermes: { ready: true, version: '0.22.5', problem: null, detail: null },
      runner: { connected: true, seenAt: '2026-09-23T09:20:00.000Z' },
      providers: [
        {
          provider: 'claude',
          state: 'logged_out',
          version: null,
          detail: 'Claude is installed but not logged in.',
          sandboxProblem: null,
        },
        {
          provider: 'codex',
          state: 'ready',
          version: 'Hermes 0.22.5',
          detail: null,
          sandboxProblem: null,
        },
      ],
      defaultProvider: 'codex',
      checkedAt: '2026-09-23T09:20:00.000Z',
      recheckPending: false,
    };

    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
      const path = url.pathname.replace('/api/v1', '');
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
      calls.push({ method, path, body });

      if (options.hostSetup && (path.startsWith('/clients') || path.startsWith('/sign-ins')))
        return json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
      if (method === 'POST' && path === '/burrows') {
        return json(
          {
            burrow: { ...burrow, name: body.name },
            me: mara,
            onboarding: {
              ...onboarding,
              burrowName: body.name,
              slug: burrow.slug,
              host: `app.whombat.com/${burrow.slug}`,
            },
          },
          201,
        );
      }
      if (method === 'PATCH' && path === `/burrows/${burrow.slug}/onboarding`) {
        return json({ ...onboarding, ...body, slug: burrow.slug });
      }
      if (method === 'POST' && path === `/burrows/${burrow.slug}/onboarding/complete`) {
        if (finish.nameTaken)
          return json(
            {
              error: {
                code: 'validation_failed',
                message: 'Some fields are not valid.',
                fields: { name: [`There’s already a ${finish.nameTaken} in this burrow.`] },
              },
            },
            400,
          );
        return json({ burrow, agent: dusty, redirectTo: '/chat' });
      }
      if (method === 'GET' && path === `/burrows/${burrow.slug}/host/agents`) return json(agentSetup);
      return base(new Request(url, init), init);
    });
    return Object.assign(fetch, { ai });
  }

  async function toAiStep(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole('heading', { name: 'Name your Whombat' });
    await user.type(screen.getByLabelText('WHOMBAT NAME'), 'Acme Corp');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Set up your AI' });
    expect(screen.getByText('STEP 2 OF 3')).toBeTruthy();
  }

  it('on the box’s own page asks only Set up your AI: the Whombat is made with the person’s name, the agent is Dusty', async () => {
    const user = userEvent.setup();
    const calls: { method: string; path: string; body: unknown }[] = [];
    const services = mockedServices(mockServer({ calls }));
    // The box's own page after its setup from the link page: only `page` matters here.
    Object.assign(services, {
      managed: { page: { kind: 'box', secure: true, atAddress: true, fromLink: true, knowsAccount: true } },
    });
    const app = renderApp('/onboarding', services);
    await screen.findByRole('heading', { name: 'Set up your AI' });
    expect(screen.getByText('STEP 4 OF 4')).toBeTruthy();
    for (const done of ['Add your Whombat', 'Claim your Whombat', 'Make its passkey'])
      expect(screen.getByText(done)).toBeTruthy();
    for (const gone of ['Who are you?', 'Protect your Whombat', 'Name your Whombat', 'Meet your agent'])
      expect(screen.queryByText(gone)).toBeNull();
    // Made by itself, named after the person (the seeded account's first name).
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/burrows')).toBeTruthy());
    const name =
      (calls.find((c) => c.path === '/burrows')?.body as { name?: string } | undefined)?.name ?? '';
    expect(name).toMatch(/’s Whombat$/);
    const named = await screen.findByTestId('onboarding-named');
    expect(named.textContent).toContain(name);
    expect(named.textContent).toContain('Dusty');
    expect(named.textContent).toContain('Settings');
    // No way back to a name step, and no greyed Open beside Skip for now; skipping opens the Whombat with Dusty as it is.
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    await user.click(screen.getByRole('button', { name: AI_STEP_TEXT.skip }));
    await waitFor(() => expect(app.location()).not.toMatch(/^\/onboarding/));
    expect(calls.some((c) => c.path.endsWith('/onboarding/complete'))).toBe(true);
    expect(calls.some((c) => c.method === 'PATCH' && 'agentName' in ((c.body as object) ?? {}))).toBe(false);
  });

  it('on the box’s own page opened another way, its count names Who are you? and still ends at 4', async () => {
    const services = mockedServices(mockServer({ calls: [] }));
    Object.assign(services, { managed: { page: { kind: 'box', secure: true, atAddress: false } } });
    renderApp('/onboarding', services);
    await screen.findByRole('heading', { name: 'Set up your AI' });
    expect(screen.getByText('STEP 4 OF 4')).toBeTruthy();
    for (const done of ['Claim your Whombat', 'Who are you?', 'Reach it from anywhere'])
      expect(screen.getByText(done)).toBeTruthy();
  });

  it('creates the burrow, sets up Claude Code with a key, names the agent and finishes', async () => {
    const user = userEvent.setup();
    const calls: { method: string; path: string; body: unknown }[] = [];
    const app = renderApp('/onboarding', mockedServices(mockServer({ calls })));
    await toAiStep(user);

    // Choose Claude Code: installed already, not signed in.
    await user.click(screen.getByRole('button', { name: 'Use Claude Code' }));
    const card = await screen.findByRole('region', { name: 'Claude Code' });
    expect(await within(card).findByText('Installed · 2.1.278')).toBeTruthy();
    expect(within(card).getByText('Not signed in')).toBeTruthy();
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/onboarding'))?.body).toMatchObject({
        clients: ['claude'],
      }),
    );

    // Sign in with a key: sent once, never shown again.
    await user.click(within(card).getByRole('button', { name: 'Use your own API key (Claude Code)' }));
    await user.type(within(card).getByLabelText('Claude Code API key'), 'sk-ant-0123456789');
    await user.click(within(card).getByRole('button', { name: 'Save key' }));
    expect(await within(card).findByText('Signed in with your API key')).toBeTruthy();
    expect(screen.queryByDisplayValue('sk-ant-0123456789')).toBeNull();

    // Installed and signed in: the agent can use it.
    const claude = (await screen.findByRole('radio', { name: 'Claude Code' })) as HTMLInputElement;
    await waitFor(() => expect(claude.checked).toBe(true));
    expect(claude.disabled).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Meet your agent' });
    expect(screen.getByText('STEP 3 OF 3')).toBeTruthy();
    // Dusty in Dusty's drawing until changed (OA-08); a name and one of the five characters (AP-5500).
    const name = screen.getByLabelText('NAME') as HTMLInputElement;
    expect(name.value).toBe('Dusty');
    const characters = screen.getByRole('radiogroup', { name: 'CHARACTER' });
    expect(within(characters).getAllByRole('radio')).toHaveLength(5);
    expect((screen.getByRole('radio', { name: 'Dusty’s face' }) as HTMLInputElement).checked).toBe(true);
    // A typed name stays when another character is picked (AP-5502).
    await user.clear(name);
    await user.type(name, 'Rex');
    await user.click(screen.getByRole('radio', { name: 'Neo’s face' }));
    expect(screen.getAllByRole('img', { name: 'Neo’s face' }).length).toBeGreaterThan(0);
    expect(name.value).toBe('Rex');

    // The last step: “Open” saves the name and face (onboarding.update), then gives them to the agent.
    await user.click(screen.getByRole('button', { name: 'Open Acme Corp' }));
    await waitFor(() => expect(app.location()).not.toMatch(/^\/onboarding/));
    expect(
      calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/onboarding')).map((c) => c.body),
    ).toContainEqual({ agentName: 'Rex', agentFace: 'neo' });
    const complete = calls.find((c) => c.path.endsWith('/onboarding/complete'))?.body;
    expect(complete).toMatchObject({ provider: 'claude' });
    expect(complete).not.toHaveProperty('roles');
    expect(complete).not.toHaveProperty('invites');
    // No GitHub or repo calls any more.
    expect(calls.some((c) => c.path.includes('/github') || c.path.includes('/repos'))).toBe(false);
  });

  it('keeps Meet your agent open with the reason when the name can’t be used, and sends nothing unchanged', async () => {
    const user = userEvent.setup();
    const calls: { method: string; path: string; body: unknown }[] = [];
    renderApp('/onboarding', mockedServices(mockServer({ calls })));
    await toAiStep(user);
    // No AI signed in: Skip for now is the one way on, and says what skipping means (FDY-33, FDY-45).
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.getByText(AI_STEP_TEXT.later)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: AI_STEP_TEXT.skip }));
    await screen.findByRole('heading', { name: 'Meet your agent' });
    // The skipped step isn't ticked in the list.
    expect(screen.getByRole('button', { name: /Set up your AI/ }).textContent).toContain('2');
    const name = screen.getByLabelText('NAME');
    await user.clear(name);
    await user.type(name, 'Whombat');
    await user.click(screen.getByRole('button', { name: 'Open Acme Corp' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Meet your agent' })).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith('/onboarding/complete'))).toBe(false);
    await user.clear(name);
    await user.type(name, 'Dusty');
    await user.click(screen.getByRole('button', { name: 'Open Acme Corp' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/onboarding/complete'))).toBe(true));
    const patches = calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/onboarding'));
    expect(patches.some((c) => 'agentName' in (c.body as object) || 'agentFace' in (c.body as object))).toBe(
      false,
    );
    const body = calls.find((c) => c.path.endsWith('/onboarding/complete'))?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('packs');
  });

  it('describes the picked character, and its name follows the face until someone types their own (AP-5501, AP-5502)', async () => {
    const user = userEvent.setup();
    const calls: { method: string; path: string; body: unknown }[] = [];
    renderApp('/onboarding', mockedServices(mockServer({ calls })));
    await toAiStep(user);
    await user.click(screen.getByRole('button', { name: AI_STEP_TEXT.skip }));
    await screen.findByRole('heading', { name: 'Meet your agent' });
    const name = screen.getByLabelText('NAME') as HTMLInputElement;
    const characters = screen.getByRole('radiogroup', { name: 'CHARACTER' });
    const line = () => document.getElementById(characters.getAttribute('aria-describedby') ?? '');
    expect(line()?.getAttribute('aria-live')).toBe('polite');
    expect(line()?.textContent).toBe(`Dusty · ${agentFaceStyle('dusty')}`);

    await user.click(within(characters).getByRole('radio', { name: 'Neo’s face' }));
    expect(name.value).toBe('Neo');
    expect(line()?.textContent).toBe(`Neo · ${agentFaceStyle('neo')}`);
    await user.click(within(characters).getByRole('radio', { name: 'Hazel’s face' }));
    expect(name.value).toBe('Hazel');
    // The tip is the agent's, by its new name.
    expect(screen.getByRole('img', { name: 'Hazel' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Open Acme Corp' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/onboarding/complete'))).toBe(true));
    expect(
      calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/onboarding')).map((c) => c.body),
    ).toContainEqual({ agentName: 'Hazel', agentFace: 'hazel' });
  });

  it('shows ChatGPT’s device code in steps, with nothing to install: the page to open, the code with a copy button, the countdown and the ChatGPT setting', async () => {
    const user = userEvent.setup();
    const ai = createFakeAi({ installed: { claude: '2.1.278' } });
    const calls: { method: string; path: string; body: unknown }[] = [];
    renderApp('/onboarding', mockedServices(mockServer({ ai, calls })));
    await toAiStep(user);
    await user.click(screen.getByRole('button', { name: 'Use ChatGPT' }));
    const card = await screen.findByRole('region', { name: 'ChatGPT' });
    // Its sign-in alone, titled: no client row, no install (AP-5615).
    expect(await within(card).findByText('ChatGPT')).toBeTruthy();
    expect(within(card).getByText('Not signed in')).toBeTruthy();
    expect(within(card).queryByText(/^(Installed|Not installed|Installing)/)).toBeNull();
    expect(within(card).queryByRole('progressbar')).toBeNull();
    expect(within(card).queryByRole('button', { name: /Install|Try again/ })).toBeNull();
    expect(within(card).queryByText(/waits until/)).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Sign in with your subscription (ChatGPT)' }));
    const link = await within(card).findByRole('link', { name: 'Open auth.openai.com' });
    expect(link.getAttribute('href')).toBe('https://auth.openai.com/codex/device');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(within(card).getByText('Enter this code')).toBeTruthy();
    expect(within(card).getByText(/^[A-Z0-9]{4}-[A-Z0-9]{5}$/).tagName).toBe('CODE');
    expect(within(card).getByRole('button', { name: 'Copy code' })).toBeTruthy();
    expect(within(card).getByText(/^Expires in 1[45]:\d\d$/)).toBeTruthy();
    expect(within(card).getByText(/ChatGPT’s security settings/)).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith('/install'))).toBe(false);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/onboarding'))?.body).toMatchObject({
        clients: ['codex'],
      }),
    );
  });

  it('makes ChatGPT the agent’s once signed in, with Claude Code picked too and nothing installed for ChatGPT', async () => {
    const user = userEvent.setup();
    const ai = createFakeAi({ installed: { claude: '2.1.278' } });
    const calls: { method: string; path: string; body: unknown }[] = [];
    renderApp('/onboarding', mockedServices(mockServer({ ai, calls })));
    await toAiStep(user);
    await user.click(screen.getByRole('button', { name: 'Use Claude Code' }));
    await user.click(screen.getByRole('button', { name: 'Use ChatGPT' }));
    const claudeCard = await screen.findByRole('region', { name: 'Claude Code' });
    const card = await screen.findByRole('region', { name: 'ChatGPT' });
    expect(await within(claudeCard).findByText('Installed · 2.1.278')).toBeTruthy();
    // Neither is signed in: neither can be the agent's yet.
    const chatgpt = (await screen.findByRole('radio', { name: 'ChatGPT' })) as HTMLInputElement;
    expect(chatgpt.disabled).toBe(true);
    expect(screen.getByText(/^Sign in to Claude Code or ChatGPT above/)).toBeTruthy();

    await user.click(within(card).getByRole('button', { name: 'Use your own API key (ChatGPT)' }));
    await user.type(within(card).getByLabelText('ChatGPT API key'), 'sk-proj-0123456789');
    await user.click(within(card).getByRole('button', { name: 'Save key' }));
    expect(await within(card).findByText('Signed in with your API key')).toBeTruthy();
    await waitFor(() => expect(chatgpt.disabled).toBe(false));
    await waitFor(() => expect(chatgpt.checked).toBe(true));
    expect((screen.getByRole('radio', { name: 'Claude Code' }) as HTMLInputElement).disabled).toBe(true);
    expect(calls.some((c) => c.path.endsWith('/install'))).toBe(false);
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/onboarding')).map((c) => c.body),
      ).toContainEqual(expect.objectContaining({ clients: ['claude', 'codex'], provider: 'codex' })),
    );
  });

  it('installs a client as soon as it is chosen, with the runtime’s progress, and nothing else (AP-194)', async () => {
    const user = userEvent.setup();
    const ai = createFakeAi({ installMs: 1_500 });
    const calls: { method: string; path: string; body: unknown }[] = [];
    renderApp('/onboarding', mockedServices(mockServer({ ai, calls })));
    await toAiStep(user);
    await user.click(screen.getByRole('button', { name: 'Use Claude Code' }));
    const card = await screen.findByRole('region', { name: 'Claude Code' });
    // No Install button to find: the bar shows up by itself and fills with the percentages the list reports.
    const bar = await within(card).findByRole('progressbar');
    expect(within(card).queryByRole('button', { name: 'Install' })).toBeNull();
    await waitFor(() => expect(Number(bar.getAttribute('aria-valuenow'))).toBeGreaterThan(0), {
      timeout: 3000,
    });
    expect(within(card).getByText(/^Installing · \d+%$/)).toBeTruthy();
    expect(await within(card).findByText('Installed · 2.1.278', {}, { timeout: 4000 })).toBeTruthy();
    expect(within(card).queryByRole('progressbar')).toBeNull();
    const installs = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/install'));
    expect(installs.map((c) => c.path)).toEqual(['/clients/claude/install']);
  });

  it('shows why an install can’t start, and tries again on request', async () => {
    const user = userEvent.setup();
    const ai = createFakeAi({ unpublished: ['claude'] });
    const calls: { method: string; path: string; body: unknown }[] = [];
    renderApp('/onboarding', mockedServices(mockServer({ ai, calls })));
    await toAiStep(user);
    await user.click(screen.getByRole('button', { name: 'Use Claude Code' }));
    const card = await screen.findByRole('region', { name: 'Claude Code' });
    // The list still says “not installed”; the install's own answer is what the card shows.
    expect(await within(card).findByText(/^No tested Claude Code version is published/)).toBeTruthy();
    expect(within(card).getByText('Install failed')).toBeTruthy();
    const installs = () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/install')).length;
    expect(installs()).toBe(1);
    await user.click(within(card).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(installs()).toBe(2));
    expect(await within(card).findByText(/^No tested Claude Code version is published/)).toBeTruthy();
  });
});
