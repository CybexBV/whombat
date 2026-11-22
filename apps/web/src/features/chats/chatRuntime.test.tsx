/**
 * What answers in Chat (Whombat chat-runtime.md CR-01…CR-10; app chat-runtime.md AP-2680…AP-2700), against the fixture
 * world's Chat (`chatChannelFixtures.ts`: Neo on Opus, Zonneplan's thread on ChatGPT · High effort). A started thread
 * keeps its provider (Whombat hermes-native.md HN-06; thread-provider.md AP-5600…).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CHAT_RUNTIME_COPY } from '@whombat/core/text';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

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

const chatShell = () => fixtureServices({});
const BUTTON = 'Choose how Neo answers';
const described = (el: HTMLElement) =>
  document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent;

describe('the button in the Chat’s box (CR-01, CR-02; AP-2684, AP-2690…AP-2692)', () => {
  it('starts on Neo’s default, picks ChatGPT, closes with Escape back on the button', async () => {
    const user = userEvent.setup();
    renderApp('/chat?new=1', chatShell());
    const room = await screen.findByRole('region', { name: 'Chat' });
    const button = await within(room).findByRole('button', { name: BUTTON });
    expect(described(button)).toBe('Claude · Opus · Automatic');
    await user.click(button);
    const dialog = await screen.findByRole('dialog', { name: BUTTON });
    expect(within(dialog).getByText('This 5 hours: Claude 38% used · ChatGPT 12% used')).toBeTruthy();
    expect(within(dialog).getByText('For your next question')).toBeTruthy();
    // The default needs no “Make this Neo’s default”.
    expect(within(dialog).queryByRole('button', { name: 'Make this Neo’s default' })).toBeNull();
    await user.click(within(dialog).getByRole('radio', { name: /ChatGPT/ }));
    expect(within(dialog).getByRole('radio', { name: /GPT-6\.1 Sol/ })).toHaveProperty('checked', true);
    expect(within(dialog).getByRole('button', { name: '4 more…' })).toBeTruthy();
    expect(within(dialog).getByRole('switch', { name: 'Fast replies' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: BUTTON })).toBeNull());
    expect(document.activeElement).toBe(button);
    expect(described(button)).toBe('ChatGPT · GPT-6.1 Sol · Automatic · Fast replies');
  });

  it('sends the choice with the question, and the box goes back to the default', async () => {
    const user = userEvent.setup();
    renderApp('/chat?new=1', chatShell());
    const room = await screen.findByRole('region', { name: 'Chat' });
    await user.click(await within(room).findByRole('button', { name: BUTTON }));
    const dialog = await screen.findByRole('dialog', { name: BUTTON });
    await user.click(within(dialog).getByRole('radio', { name: /ChatGPT/ }));
    await user.click(within(dialog).getByRole('radio', { name: 'High' }));
    await user.keyboard('{Escape}');
    await user.type(within(room).getByRole('textbox'), 'Check the UPS battery every night{Enter}');
    // Its thread opens: stored with ChatGPT · High, and its answer ran on it.
    expect(await screen.findByTitle('ChatGPT · GPT-6.1 Sol · High effort · Fast')).toBeTruthy();
    await waitFor(() =>
      expect(described(screen.getAllByRole('button', { name: BUTTON }).at(-1) as HTMLElement)).toBe(
        'ChatGPT · GPT-6.1 Sol · High · Fast replies',
      ),
    );
    // Back in the room, the next question starts on Neo's default again.
    await user.click(screen.getByRole('link', { name: /Back to Chat/ }));
    const again = await screen.findByRole('region', { name: 'Chat' });
    await user.click(within(again).getByRole('button', { name: 'New chat' }));
    await waitFor(() =>
      expect(described(within(again).getByRole('button', { name: BUTTON }))).toBe(
        'Claude · Opus · Automatic',
      ),
    );
  });
});

describe('a Chat thread (CR-02, CR-07, CR-08; AP-2682, AP-2695…AP-2697)', () => {
  it('shows what answered and the switch; its own provider’s choices are saved at once (AP-5600, AP-5601)', async () => {
    const user = userEvent.setup();
    renderApp('/chat?thread=msg_chat-zonneplan', chatShell());
    expect(await screen.findByText('ChatGPT', { selector: 'b' })).toBeTruthy();
    expect(screen.getByText(/Switched to/).textContent).toBe(
      'Switched to ChatGPT · High effort · fast replies on',
    );
    expect(screen.getByTitle('Claude · Opus')).toBeTruthy();
    const buttons = await screen.findAllByRole('button', { name: BUTTON });
    const button = buttons.at(-1) as HTMLElement;
    expect(described(button)).toBe('ChatGPT · GPT-6.1 Sol · High · Fast replies');
    await user.click(button);
    const dialog = await screen.findByRole('dialog', { name: BUTTON });
    expect(within(dialog).getByText('For this thread')).toBeTruthy();
    // A started thread keeps its provider: ChatGPT alone, with its own usage line.
    expect(within(dialog).getByRole('radio', { name: /ChatGPT/ })).toHaveProperty('checked', true);
    expect(within(dialog).queryByRole('radio', { name: /Claude/ })).toBeNull();
    expect(within(dialog).getByText('This 5 hours: ChatGPT 12% used')).toBeTruthy();
    await user.click(within(dialog).getByRole('radio', { name: /GPT-6 Luna/ }));
    await waitFor(() => expect(described(button)).toBe('ChatGPT · GPT-6 Luna · High · Fast replies'));
  });

  it('a Claude thread offers Claude alone, its fast replies on', async () => {
    const user = userEvent.setup();
    renderApp('/chat?thread=msg_chat-pve-memory', chatShell());
    const buttons = await screen.findAllByRole('button', { name: BUTTON });
    await user.click(buttons.at(-1) as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: BUTTON });
    expect(within(dialog).getByRole('radio', { name: /Claude/ })).toHaveProperty('checked', true);
    expect(within(dialog).queryByRole('radio', { name: /ChatGPT/ })).toBeNull();
    expect(within(dialog).getByRole('switch', { name: 'Fast replies' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('says nothing when fast replies were only busy: the reply came anyway', async () => {
    renderApp('/chat?thread=msg_chat-pve-memory', chatShell());
    await screen.findAllByRole('button', { name: BUTTON });
    expect(screen.queryByText(/Fast replies were busy/)).toBeNull();
  });
});

describe('Custom in the picker', () => {
  it('isn’t offered without a custom AI model', async () => {
    const user = userEvent.setup();
    renderApp('/chat?new=1', chatShell());
    const room = await screen.findByRole('region', { name: 'Chat' });
    await user.click(await within(room).findByRole('button', { name: BUTTON }));
    const dialog = await screen.findByRole('dialog', { name: BUTTON });
    expect(within(dialog).queryByRole('radio', { name: /Custom/ })).toBeNull();
  });

  it('lists its models, takes another by name, and has no effort or fast replies', async () => {
    const user = userEvent.setup();
    renderApp('/chat?new=1', fixtureServices({ localModel: true }));
    const room = await screen.findByRole('region', { name: 'Chat' });
    const button = await within(room).findByRole('button', { name: BUTTON });
    await user.click(button);
    const dialog = await screen.findByRole('dialog', { name: BUTTON });
    await user.click(await within(dialog).findByRole('radio', { name: /Custom/ }));
    expect(within(dialog).getByRole('radio', { name: /Llama on the NAS/ })).toHaveProperty('checked', true);
    expect(within(dialog).getByRole('radio', { name: /qwen3:32b/ })).toBeTruthy();
    expect(within(dialog).queryByText('Effort')).toBeNull();
    expect(within(dialog).queryByRole('switch', { name: 'Fast replies' })).toBeNull();

    await user.type(within(dialog).getByLabelText('Another model'), 'gemma3:27b{Enter}');
    expect(within(dialog).getByRole('radio', { name: /gemma3:27b/ })).toHaveProperty('checked', true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: BUTTON })).toBeNull());
    expect(described(button)).toBe('Custom · gemma3:27b');
  });
});

describe('no AI signed in yet (Set up your AI skipped)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('says “No AI yet” instead of a provider, and leads to Settings → AI', async () => {
    vi.stubEnv('VITE_FIXTURE_CHAT_RUNTIME', 'none');
    const user = userEvent.setup();
    const { location } = renderApp('/chat?new=1', chatShell());
    const room = await screen.findByRole('region', { name: 'Chat' });
    const noAi = await within(room).findByRole('link', { name: CHAT_RUNTIME_COPY.noAiLabel('Neo') });
    expect(noAi.textContent).toBe(CHAT_RUNTIME_COPY.noAi);
    expect(within(room).queryByRole('button', { name: BUTTON })).toBeNull();
    await user.click(noAi);
    // Settings → AI (the AI tab is the agent’s AI part now).
    await waitFor(() => expect(location()).toMatch(/^\/settings\?.*\bai\b/));
  });
});
