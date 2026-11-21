/**
 * The agent's model and effort on Settings → Advanced → Model and effort (Whombat model-effort.md ME-01…ME-07; AP-1128…AP-1130;
 * one-agent.md AP-4927), in the fixture world with the models (modelFixtures.ts, AP-1134): the agent on Claude Code with
 * Fable at High effort, whose last turn ran on the default model.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentSetupStatus } from '@whombat/core/domain';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../../app/fixtureFetch';
import { ASSISTANT_NAME } from '../../../app/oneFixtures';
import { mockedServices, renderApp } from '../../../test/renderApp';

const FIXED = 'Every reply and task uses this. Higher thinks longer: slower replies and more usage.';
const AUTOMATIC = 'Medium for conversations, high for code work.';
const NOTE = `Fable wasn’t available on Priya’s sign-in, so ${ASSISTANT_NAME} used the default model for that reply.`;
const MODEL = '/settings?tab=advanced&part=model';

type Write = { method: string; path: string; body: unknown };

/**
 * The fixture world with the models, recording every write; `respond` may answer one itself, `setup` change what the
 * runner reports, `signIns: false` is a self-hosted server without `signins.*`.
 */
function server(
  options: {
    respond?: (w: Write) => Response | undefined;
    setup?: (s: AgentSetupStatus) => AgentSetupStatus;
    signIns?: boolean;
    /** A model on the network saved (hermes-engine-app.md AP-5047). */
    localModel?: boolean;
  } = {},
) {
  const base = createWebFixtureFetch({ models: true, localModel: options.localModel ?? false });
  const writes: Write[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/api/v1', '');
    if (options.signIns === false && path.startsWith('/sign-ins'))
      return Response.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 });
    if (method !== 'GET') {
      const write = { method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      writes.push(write);
      const scripted = options.respond?.(write);
      if (scripted) return scripted;
    }
    const res = await base(new Request(url, init), init);
    if (options.setup && method === 'GET' && path === `/burrows/${burrow.slug}/host/agents`)
      return Response.json(options.setup((await res.json()) as AgentSetupStatus));
    return res;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, writes };
}

async function modelGroup() {
  return screen.findByRole('radiogroup', { name: 'Model' });
}

const checked = (group: HTMLElement) =>
  within(group)
    .getAllByRole('radio')
    .filter((r) => (r as HTMLInputElement).checked)
    .map((r) => r.closest('label')?.textContent);

const saveBar = () => screen.getByRole('region', { name: 'Unsaved changes' });

describe('Settings → Advanced → Model and effort: MODEL and EFFORT (AP-1128)', () => {
  it('lists the tool’s models after “Default (Opus)”, the levels the model takes, and the note on the last turn', async () => {
    renderApp(MODEL, mockedServices(server().fetch));
    const models = await modelGroup();
    expect(
      within(models)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual([
      'Default (Opus)',
      'OpusOpus 5.5 · Best for everyday, complex tasks',
      'FableFable 5.1 · Most capable for long, hard work',
      'SonnetSonnet 5 · Fast and capable for everyday tasks',
      'HaikuHaiku 4.5 · Fastest for quick answers',
    ]);
    expect(checked(models)).toEqual(['FableFable 5.1 · Most capable for long, hard work']);
    expect(screen.getByText(NOTE)).toBeTruthy();
    const effort = screen.getByRole('radiogroup', { name: 'Effort' });
    expect(
      within(effort)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual(['Automatic', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
    expect((within(effort).getByRole('radio', { name: 'High' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(FIXED)).toBeTruthy();
    // Nothing changed yet.
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('offers only the default and every level while the runner hasn’t listed the models', async () => {
    const setup = (s: AgentSetupStatus) => ({
      ...s,
      providers: s.providers.map(({ models: _models, ...p }) => p),
    });
    renderApp(MODEL, mockedServices(server({ setup }).fetch));
    const models = await modelGroup();
    expect(
      within(models)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual(['Default', 'fable']);
    const effort = screen.getByRole('radiogroup', { name: 'Effort' });
    expect(within(effort).getAllByRole('radio')).toHaveLength(7);
    expect(screen.getByText(NOTE.replace('Fable', 'fable'))).toBeTruthy();
  });
});

describe('Saving the model runtime (AP-1129)', () => {
  it('sends the model with an effort change, in one agents.update, and says so', async () => {
    const { fetch, writes } = server();
    const user = userEvent.setup();
    renderApp(MODEL, mockedServices(fetch));
    await modelGroup();
    await user.click(screen.getByRole('radio', { name: 'Max' }));
    expect(within(saveBar()).getByText('Unsaved changes')).toBeTruthy();
    await user.click(within(saveBar()).getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('status')).textContent).toBe(
      `Updated ${ASSISTANT_NAME}’s model and effort.`,
    );
    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: `/burrows/burrow-hq/agent`,
        body: { runtime: { provider: 'claude', model: 'fable', effort: 'max' } },
      },
    ]);
    // The same model: the note about its last turn stays.
    expect(screen.getByText(NOTE)).toBeTruthy();
  });

  it('saves a new model with Automatic, and the note goes', async () => {
    const { fetch, writes } = server();
    const user = userEvent.setup();
    renderApp(MODEL, mockedServices(fetch));
    const models = await modelGroup();
    await user.click(within(models).getByRole('radio', { name: /^Sonnet/ }));
    await user.click(screen.getByRole('radio', { name: 'Automatic' }));
    expect(screen.getByText(AUTOMATIC)).toBeTruthy();
    await user.click(within(saveBar()).getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('status')).textContent).toBe(
      `Updated ${ASSISTANT_NAME}’s model and effort.`,
    );
    expect(writes.map((w) => w.body)).toEqual([{ runtime: { provider: 'claude', model: 'sonnet' } }]);
    await waitFor(() => expect(screen.queryByText(NOTE)).toBeNull());
    expect(checked(models)).toEqual(['SonnetSonnet 5 · Fast and capable for everyday tasks']);
  });

  it('runs on Claude Code or ChatGPT, and ChatGPT is “Ready” without the runner’s version (AP-5611, AP-5613)', async () => {
    const { fetch } = server();
    const user = userEvent.setup();
    renderApp(MODEL, mockedServices(fetch));
    await modelGroup();
    const providers = screen.getByRole('group', { name: 'AI provider' });
    expect(within(providers).getByRole('radio', { name: 'Claude Code' })).toBeTruthy();
    expect(within(providers).getByRole('radio', { name: 'ChatGPT' })).toBeTruthy();
    expect(within(providers).queryByRole('radio', { name: 'Codex' })).toBeNull();
    expect(screen.getByText(/^Ready · 2\.1\.296 \(Claude Code\) on this machine\.$/)).toBeTruthy();
    await user.click(within(providers).getByRole('radio', { name: 'ChatGPT' }));
    expect(await screen.findByText('Ready on this machine.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Hermes|Codex/);
  });

  it('keeps the effort within what a new model takes, and a new provider clears both', async () => {
    const { fetch, writes } = server();
    const user = userEvent.setup();
    renderApp(MODEL, mockedServices(fetch));
    await modelGroup();
    await user.click(screen.getByRole('radio', { name: 'ChatGPT' }));
    const models = await modelGroup();
    await user.click(within(models).getByRole('radio', { name: /^GPT-6\.1-Sol/ }));
    const effort = screen.getByRole('radiogroup', { name: 'Effort' });
    await user.click(within(effort).getByRole('radio', { name: 'Ultra' }));
    // GPT-5.5 goes up to Extra high: the nearest level it takes.
    await user.click(within(models).getByRole('radio', { name: /^GPT-5\.5/ }));
    expect((within(effort).getByRole('radio', { name: 'Extra high' }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(within(effort).queryByRole('radio', { name: 'Ultra' })).toBeNull();

    await user.click(screen.getByRole('radio', { name: 'Claude Code' }));
    const claude = await modelGroup();
    expect(checked(claude)).toEqual(['Default (Opus)']);
    expect((screen.getByRole('radio', { name: 'Automatic' }) as HTMLInputElement).checked).toBe(true);
    await user.click(within(saveBar()).getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('status')).textContent).toContain(ASSISTANT_NAME);
    expect(writes.map((w) => w.body)).toEqual([{ runtime: { provider: 'claude' } }]);
  });

  it('shows the server’s refusal and keeps the choice', async () => {
    const message = 'Fable doesn’t take Max effort.';
    const { fetch } = server({
      respond: (w) =>
        w.method === 'PATCH'
          ? Response.json(
              { error: { code: 'validation_failed', message, fields: { runtime: [message] } } },
              { status: 422 },
            )
          : undefined,
    });
    const user = userEvent.setup();
    renderApp(MODEL, mockedServices(fetch));
    await modelGroup();
    await user.click(screen.getByRole('radio', { name: 'Max' }));
    await user.click(within(saveBar()).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Max' }) as HTMLInputElement).checked).toBe(true);
    expect(within(saveBar()).getByText('Unsaved changes')).toBeTruthy();
  });
});

describe('Settings → Advanced → Model and effort on Custom', () => {
  it('offers Custom only when a custom AI model is set up', async () => {
    renderApp(MODEL, mockedServices(server().fetch));
    await modelGroup();
    expect(screen.queryByRole('radio', { name: 'Custom' })).toBeNull();
  });

  it('lists the burrow’s models and takes another by name; no effort, fast replies or sign-in', async () => {
    const { fetch, writes } = server({ localModel: true });
    const user = userEvent.setup();
    renderApp(MODEL, mockedServices(fetch));
    await user.click(await screen.findByRole('radio', { name: 'Custom' }));
    expect(screen.getByText('Llama on the NAS. It answers.')).toBeTruthy();
    const models = await modelGroup();
    expect(
      within(models)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual(['Default (Llama on the NAS)', 'Llama on the NAS', 'qwen3:32b', 'mistral-small']);
    expect(screen.queryByRole('radiogroup', { name: 'Effort' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Fast replies' })).toBeNull();
    expect(screen.queryByText('RUNS ON')).toBeNull();

    await user.type(screen.getByLabelText('Another model'), 'gemma3:27b');
    await user.click(screen.getByRole('button', { name: 'Use' }));
    expect(checked(models)).toEqual(['gemma3:27b']);
    await user.click(within(saveBar()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toEqual({ runtime: { provider: 'local', model: 'gemma3:27b' } });
    expect(await screen.findByText(`Updated ${ASSISTANT_NAME}’s AI provider and model.`)).toBeTruthy();
  });
});

describe('Settings → Advanced → Model and effort background model', () => {
  it('defaults to “Same as the main model”, lists only the chosen provider’s models, saves and clears on provider switch', async () => {
    const { fetch, writes } = server();
    const user = userEvent.setup();
    renderApp(MODEL, mockedServices(fetch));
    await modelGroup();
    const bgGroup = screen.getByRole('radiogroup', { name: 'Background model' });
    expect(checked(bgGroup)).toEqual(['Same as the main model']);
    expect(
      within(bgGroup)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.querySelector('span > span')?.textContent),
    ).toEqual(['Same as the main model', 'Opus', 'Fable', 'Sonnet', 'Haiku']);

    await user.click(within(bgGroup).getByRole('radio', { name: /^Haiku/ }));
    await user.click(within(saveBar()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toEqual({
      runtime: { provider: 'claude', model: 'fable', backgroundModel: 'haiku', effort: 'high' },
    });

    // Picking “Same as the main model” sends explicit null so the server clears it.
    await user.click(within(bgGroup).getByRole('radio', { name: 'Same as the main model' }));
    await user.click(within(saveBar()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.body).toEqual({
      runtime: { provider: 'claude', model: 'fable', backgroundModel: null, effort: 'high' },
    });

    // Switching provider resets the background model and offers only the new provider's models.
    await user.click(screen.getByRole('radio', { name: 'ChatGPT' }));
    const codexBg = screen.getByRole('radiogroup', { name: 'Background model' });
    expect(checked(codexBg)).toEqual(['Same as the main model']);
    expect(within(codexBg).queryByRole('radio', { name: /^Haiku/ })).toBeNull();
    expect(within(codexBg).getByRole('radio', { name: /^GPT-6\.1-Sol/ })).toBeTruthy();
  });
});
