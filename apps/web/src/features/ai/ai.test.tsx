import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAi } from '../../managed/fake/ai';
import { fixtureServices, renderApp } from '../../test/renderApp';
import { DEVICE_POLL } from './DeviceCode';

/** A terminal without xterm (jsdom has no layout): what was written, and a way to type. */
const term = vi.hoisted(() => {
  const state = {
    output: '',
    listener: null as ((data: string) => void) | null,
    disposed: 0,
  };
  return {
    state,
    mountTerminal: () => {
      state.output = '';
      state.listener = null;
      const decoder = new TextDecoder();
      return {
        cols: 72,
        rows: 12,
        write: (bytes: Uint8Array) => {
          state.output += decoder.decode(bytes, { stream: true });
        },
        onData: (l: (data: string) => void) => {
          state.listener = l;
        },
        onResize: () => {},
        focus: () => {},
        dispose: () => {
          state.disposed += 1;
        },
      };
    },
    type: (data: string) => state.listener?.(data),
  };
});
vi.mock('./terminal', () => ({ mountTerminal: term.mountTerminal }));

afterEach(() => {
  DEVICE_POLL.ms = 3_000;
  vi.restoreAllMocks();
  document.removeEventListener('click', noNavigation, true);
});

// jsdom doesn't open new tabs: links that would are clicked without navigating.
function noNavigation(e: MouseEvent) {
  if ((e.target as Element | null)?.closest?.('a[target="_blank"]')) e.preventDefault();
}
beforeEach(() => document.addEventListener('click', noNavigation, true));

/**
 * Holds the console's writes (and any other `ops`) until released, recording what was typed into Claude Code.
 * `release()` lets the writes through, `release(op)` another op.
 */
function holdWrites(ai: ReturnType<typeof createFakeAi>, ops: string[] = []) {
  const call = ai.call.bind(ai);
  const data: string[] = [];
  const gates = new Map<string, { promise: Promise<void>; open: () => void }>();
  for (const op of ['signins.consoleWrite', ...ops]) {
    let open: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    gates.set(op, { promise, open });
  }
  vi.spyOn(ai, 'call').mockImplementation(async (id, params, query, body) => {
    if (id === 'signins.consoleWrite') data.push(String((body as { data?: unknown } | undefined)?.data));
    await gates.get(id)?.promise;
    return call(id, params, query, body);
  });
  return { data, release: (op = 'signins.consoleWrite') => gates.get(op)?.open() };
}

/** A clipboard with `readText`, and a permission state for `clipboard-read`. */
function stubClipboard(readText: () => Promise<string>, permission: { state: PermissionState }) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } });
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: () => Promise.resolve({ state: permission.state }) },
  });
}

/** The state of the guided step `el` is in. */
function stepOf(el: Element): string | null {
  return el.closest('li')?.getAttribute('data-state') ?? null;
}

/** The assistant's AI sign-in (settings-groups.md): your sign-ins. */
const AI_TAB = `/settings?tab=agent&part=ai`;
/** Advanced → AI on this Whombat: the AI programs installed here. */
const AI_MACHINE = `/settings?tab=advanced&part=ai`;

function signIns() {
  return screen.getByRole('region', { name: 'YOUR AI SIGN-INS' });
}

/** Opens “On this Whombat” (it opens by itself only when something there needs the person, AP-1786). */
async function openFold(user: ReturnType<typeof userEvent.setup>) {
  const toggle = await screen.findByRole('button', { name: /details/i });
  if (toggle.getAttribute('aria-expanded') !== 'true') await user.click(toggle);
}

describe('Settings → the assistant → AI sign-in, and Advanced → AI on this Whombat', () => {
  it('back on the tab, focuses the field and offers the clipboard’s code only when reading it is already allowed', async () => {
    const user = userEvent.setup();
    const ai = createFakeAi({ installed: { claude: '2.1.278' } });
    const writes = holdWrites(ai);
    const readText = vi.fn(() => Promise.resolve(' AbCdEf0123456789#StAtE0123456789\n'));
    const clipboard = { state: 'prompt' as PermissionState };
    stubClipboard(readText, clipboard);
    renderApp(AI_TAB, fixtureServices({ ai }));
    const region = await waitFor(signIns);
    await user.click(
      await within(region).findByRole('button', { name: 'Sign in with your subscription (Claude Code)' }),
    );
    const open = await within(region).findByRole('link', { name: 'Open claude.ai to sign in' });
    await user.click(open);
    const field = within(region).getByLabelText('Paste the code from claude.ai') as HTMLInputElement;

    // Not allowed yet: the field gets the focus, the clipboard isn't read.
    field.blur();
    window.dispatchEvent(new Event('focus'));
    expect(document.activeElement).toBe(field);
    await new Promise((r) => setTimeout(r, 10));
    expect(readText).not.toHaveBeenCalled();
    expect(field.value).toBe('');

    // Allowed: the code is offered in the field, and not sent.
    clipboard.state = 'granted';
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(field.value).toBe('AbCdEf0123456789#StAtE0123456789'));
    expect(writes.data).toEqual([]);

    // Something that isn't code-shaped isn't offered.
    await user.clear(field);
    readText.mockResolvedValue('Hello, this is not a code at all');
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 10));
    expect(field.value).toBe('');
    writes.release();
  });

  it('“Paste” puts the clipboard in the field and doesn’t send it', async () => {
    const user = userEvent.setup();
    const ai = createFakeAi({ installed: { claude: '2.1.278' } });
    const writes = holdWrites(ai);
    stubClipboard(() => Promise.resolve('  code-4821#state \n'), { state: 'denied' });
    renderApp(AI_TAB, fixtureServices({ ai }));
    const region = await waitFor(signIns);
    await user.click(
      await within(region).findByRole('button', { name: 'Sign in with your subscription (Claude Code)' }),
    );
    await within(region).findByRole('link', { name: 'Open claude.ai to sign in' });
    await user.click(within(region).getByRole('button', { name: 'Paste' }));
    const field = within(region).getByLabelText('Paste the code from claude.ai') as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe('code-4821#state'));
    expect(writes.data).toEqual([]);

    stubClipboard(() => Promise.reject(new Error('denied')), { state: 'denied' });
    await user.clear(field);
    await user.click(within(region).getByRole('button', { name: 'Paste' }));
    expect(
      await within(region).findByText(
        'Your browser didn’t let Whombat read the clipboard. Paste with Ctrl+V or ⌘V.',
      ),
    ).toBeTruthy();
    writes.release();
  });

  it('says when the code didn’t work, and “Get a new link” starts a new console in one click', async () => {
    const user = userEvent.setup();
    const ai = createFakeAi({ installed: { claude: '2.1.278' } });
    const call = vi.spyOn(ai, 'call');
    renderApp(AI_TAB, fixtureServices({ ai }));
    const region = await waitFor(signIns);
    await user.click(
      await within(region).findByRole('button', { name: 'Sign in with your subscription (Claude Code)' }),
    );
    const first = await within(region).findByRole('link', { name: 'Open claude.ai to sign in' });
    const firstHref = first.getAttribute('href');
    await user.type(within(region).getByLabelText('Paste the code from claude.ai'), 'wrong');
    await user.click(within(region).getByRole('button', { name: 'Sign in' }));
    expect(
      await within(region).findByText(
        'That code didn’t work. Codes work once and expire after a few minutes.',
      ),
    ).toBeTruthy();
    expect(within(region).queryByLabelText('Paste the code from claude.ai')).toBeNull();
    const again = within(region).getByRole('button', { name: 'Get a new link' });
    expect(document.activeElement).toBe(again);
    await user.click(again);
    const next = await within(region).findByRole('link', { name: 'Open claude.ai to sign in' });
    expect(next.getAttribute('href')).not.toBe(firstHref);
    expect(call.mock.calls.filter(([id]) => id === 'signins.consoleStart')).toHaveLength(2);
    expect(within(region).getByRole('status', { name: '' }).textContent).toBe(
      'Waiting for the code from claude.ai…',
    );
  });

  it('keeps Claude Code’s output one click away, and typing there still works', async () => {
    const user = userEvent.setup();
    const ai = createFakeAi({ installed: { claude: '2.1.278' } });
    renderApp(AI_TAB, fixtureServices({ ai }));
    const region = await waitFor(signIns);
    await user.click(
      await within(region).findByRole('button', { name: 'Sign in with your subscription (Claude Code)' }),
    );
    await waitFor(() => expect(term.state.output).toContain('Paste code here'));
    const toggle = within(region).getByRole('button', { name: 'Show Claude Code’s output' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const output = document.getElementById(toggle.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(output.hasAttribute('inert')).toBe(true);
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(output.hasAttribute('inert')).toBe(false);
    expect(within(output).getByRole('region', { name: 'Claude Code’s output' })).toBeTruthy();

    // Claude Code shows nothing while the code is typed: the status counts it; Enter sends it.
    term.type('abc');
    expect(await within(region).findByText('Code entered (3 characters) · press Enter')).toBeTruthy();
    term.type('\u007f');
    expect(await within(region).findByText('Code entered (2 characters) · press Enter')).toBeTruthy();
    term.type('c123\r');
    expect(await within(region).findByText('Signed in with your Claude subscription')).toBeTruthy();
    expect(term.state.output).toContain('Login successful');
  });

  it('offers no button for a link to another host, and shows Claude Code’s output instead', async () => {
    const user = userEvent.setup();
    const ai = createFakeAi({
      installed: { claude: '2.1.278' },
      consoleLink: 'https://claude.ai.example.net/oauth/authorize?state=x',
    });
    renderApp(AI_TAB, fixtureServices({ ai }));
    const region = await waitFor(signIns);
    await user.click(
      await within(region).findByRole('button', { name: 'Sign in with your subscription (Claude Code)' }),
    );
    expect(
      await within(region).findByText(
        'Open the link in Claude Code’s output below, approve, then copy the code it shows.',
      ),
    ).toBeTruthy();
    expect(within(region).queryByRole('link', { name: 'Open claude.ai to sign in' })).toBeNull();
    expect(
      within(region).getByRole('button', { name: 'Show Claude Code’s output' }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('cancels the console on Cancel and closes it', async () => {
    const user = userEvent.setup();
    const ai = createFakeAi({ installed: { claude: '2.1.278' } });
    renderApp(AI_TAB, fixtureServices({ ai }));
    const region = await waitFor(signIns);
    await user.click(
      await within(region).findByRole('button', { name: 'Sign in with your subscription (Claude Code)' }),
    );
    await waitFor(() => expect(term.state.output).toContain('Paste code here'));
    await user.click(within(region).getByRole('button', { name: 'Cancel' }));
    expect(within(region).queryByRole('region', { name: 'Claude Code sign-in' })).toBeNull();
    const list = (await ai.call('signins.list'))?.body as { consoles: { state: string }[] };
    expect(list.consoles.map((c) => c.state)).toEqual(['cancelled']);
  });

  it('says a timed-out console expired and offers a new link', async () => {
    const user = userEvent.setup();
    const ai = createFakeAi({ installed: { claude: '2.1.278' } });
    renderApp(AI_TAB, fixtureServices({ ai }));
    const region = await waitFor(signIns);
    await user.click(
      await within(region).findByRole('button', { name: 'Sign in with your subscription (Claude Code)' }),
    );
    await waitFor(() => expect(term.state.output).toContain('Paste code here'));
    ai.expireConsole();
    expect(
      await within(region).findByText(
        'The sign-in timed out. Links work for a few minutes, so start with a new one.',
      ),
    ).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Get a new link' })).toBeTruthy();
  });

  it('picks up a console that still runs after a reload', async () => {
    const ai = createFakeAi({ installed: { claude: '2.1.278' } });
    await ai.call(
      'signins.consoleStart',
      {},
      {},
      { provider: 'claude', authMode: 'subscription_cli', cols: 80, rows: 24 },
    );
    renderApp(AI_TAB, fixtureServices({ ai }));
    const region = await waitFor(signIns);
    expect(await within(region).findByRole('region', { name: 'Claude Code sign-in' })).toBeTruthy();
    expect(await within(region).findByRole('link', { name: 'Open claude.ai to sign in' })).toBeTruthy();
    const list = (await ai.call('signins.list'))?.body as { consoles: unknown[] };
    expect(list.consoles).toHaveLength(1); // resumed, not started again
  });

  it('signs in to ChatGPT in guided steps: open auth.openai.com, enter the code', async () => {
    DEVICE_POLL.ms = 20;
    const user = userEvent.setup();
    const ai = createFakeAi({ installed: { claude: '2.1.278' }, deviceCompletesAfterPolls: 3 });
    renderApp(AI_TAB, fixtureServices({ ai }));
    const region = await waitFor(signIns);
    await user.click(
      await within(region).findByRole('button', { name: 'Sign in with your subscription (ChatGPT)' }),
    );
    const panel = await within(region).findByRole('region', { name: 'ChatGPT sign-in' });
    expect(within(panel).getByText(/OpenAI’s own sign-in/)).toBeTruthy();
    const open = within(panel).getByRole('link', { name: 'Open auth.openai.com' });
    expect(open.getAttribute('href')).toBe('https://auth.openai.com/codex/device');
    expect(open.getAttribute('target')).toBe('_blank');
    expect(document.activeElement).toBe(open);
    const code = within(panel).getByText(/^[A-Z0-9]{4}-[A-Z0-9]{5}$/);
    expect(stepOf(code)).toBe('todo');
    expect(within(panel).getByText('Enter this code')).toBeTruthy();
    await user.click(open);
    expect(stepOf(open)).toBe('done');
    expect(stepOf(code)).toBe('active');
    expect(within(panel).getByRole('status').textContent).toBe('Waiting for you to finish signing in…');
    expect(
      await within(region).findByText('Signed in with your ChatGPT plan', {}, { timeout: 3000 }),
    ).toBeTruthy();
    await waitFor(() => expect(within(region).queryByRole('region', { name: 'ChatGPT sign-in' })).toBeNull());
  });

  it('offers a new ChatGPT code once one expired, and no button for a page elsewhere', async () => {
    DEVICE_POLL.ms = 20;
    const user = userEvent.setup();
    let clock = Date.now();
    const ai = createFakeAi({
      installed: { claude: '2.1.278' },
      deviceCompletesAfterPolls: 1000,
      deviceUri: 'https://auth.example.net/codex/device',
      now: () => clock,
    });
    renderApp(AI_TAB, fixtureServices({ ai }));
    const region = await waitFor(signIns);
    await user.click(
      await within(region).findByRole('button', { name: 'Sign in with your subscription (ChatGPT)' }),
    );
    const panel = await within(region).findByRole('region', { name: 'ChatGPT sign-in' });
    expect(within(panel).queryByRole('link')).toBeNull();
    expect(within(panel).getByText('https://auth.example.net/codex/device')).toBeTruthy();
    clock += 16 * 60_000;
    expect(await within(panel).findByText('The code expired. Get a new one to start again.')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Get a new code' }));
    clock = Date.now();
    expect(await within(region).findByText(/^[A-Z0-9]{4}-[A-Z0-9]{5}$/)).toBeTruthy();
  });

  it('saves the person’s own key and signs out again', async () => {
    const user = userEvent.setup();
    const ai = createFakeAi({ installed: { claude: '2.1.278' } });
    renderApp(AI_TAB, fixtureServices({ ai }));
    const region = await waitFor(signIns);
    await user.click(await within(region).findByRole('button', { name: 'Use your own API key (ChatGPT)' }));
    await user.type(within(region).getByLabelText('ChatGPT API key'), 'bad-key-123');
    await user.click(within(region).getByRole('button', { name: 'Save key' }));
    expect((await within(region).findByRole('alert')).textContent).toBe(
      'That key isn’t right. Check it and try again.',
    );
    await user.clear(within(region).getByLabelText('ChatGPT API key'));
    await user.type(within(region).getByLabelText('ChatGPT API key'), 'sk-proj-0123456789');
    await user.click(within(region).getByRole('button', { name: 'Save key' }));
    expect(await within(region).findByText('Signed in. The key works.')).toBeTruthy();
    expect(await within(region).findByText('Signed in with your API key')).toBeTruthy();
    await user.click(within(region).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(within(region).getAllByText('Not signed in')).toHaveLength(2));
  });

  it('lists Claude Code as the one AI client; you remove and install it, and there is no update button', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const ai = createFakeAi({ installed: { claude: '2.1.278' }, installMs: 200 });
    renderApp(AI_MACHINE, fixtureServices({ ai }));
    await openFold(user);
    const clients = await screen.findByRole('region', { name: 'AI CLIENTS' });
    expect(await within(clients).findByText('Installed · 2.1.278')).toBeTruthy();
    expect(within(clients).getByText('Updates itself to each version Whombat has tested.')).toBeTruthy();
    expect(within(clients).queryByRole('button', { name: /Update/ })).toBeNull();
    // ChatGPT needs nothing installed: no row of its own (AP-5614).
    expect(within(clients).queryByText(/^(ChatGPT|Codex)$/)).toBeNull();
    await user.click(within(clients).getByRole('button', { name: 'Remove' }));
    expect(await within(clients).findByText('Not installed · Latest tested 2.1.278')).toBeTruthy();
    await user.click(within(clients).getByRole('button', { name: 'Install' }));
    expect(await within(clients).findByText('Installed · 2.1.278', {}, { timeout: 4000 })).toBeTruthy();
    expect(within(clients).getAllByRole('button', { name: /Install|Remove/ })).toHaveLength(1);
  });

  it('lets people sign in to ChatGPT with nothing installed, while Claude Code’s sign-in waits for its install', async () => {
    const user = userEvent.setup();
    renderApp(AI_TAB, fixtureServices({ ai: createFakeAi({ installed: {} }) }));
    const region = await waitFor(signIns);
    const chatgpt = await within(region).findByRole('button', {
      name: 'Sign in with your subscription (ChatGPT)',
    });
    const claude = within(region).getByRole('button', {
      name: 'Sign in with your subscription (Claude Code)',
    });
    expect((chatgpt as HTMLButtonElement).disabled).toBe(false);
    expect((claude as HTMLButtonElement).disabled).toBe(true);
    // The only “waits until … is installed” is Claude Code's.
    expect(within(region).getAllByText(/waits until/)).toHaveLength(1);
    expect(within(region).getByText(/waits until Claude Code/)).toBeTruthy();
    await user.click(chatgpt);
    expect(await within(region).findByRole('region', { name: 'ChatGPT sign-in' })).toBeTruthy();
  });

  it('opens what is on this Whombat for Claude Code alone when nothing is installed', async () => {
    renderApp(AI_MACHINE, fixtureServices({ ai: createFakeAi({ installed: {} }) }));
    // The fold opens for Claude Code alone, and says nothing about ChatGPT.
    const summary = await waitFor(() => {
      const el = document.querySelector('[data-fold-summary]');
      if (!el?.textContent?.includes('isn’t installed')) throw new Error('not yet');
      return el.textContent;
    });
    expect(summary).toBe('Claude Code isn’t installed');
    const clients = await screen.findByRole('region', { name: 'AI CLIENTS' });
    expect(within(clients).getAllByRole('button', { name: 'Install' })).toHaveLength(1);
  });
});
