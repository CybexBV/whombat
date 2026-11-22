/**
 * A MODEL ON YOUR NETWORK in Settings → AI (hermes-engine-app.md AP-5048…AP-5051) against the fixture world's model
 * server (localModelFixtures.ts: it answers at 192.168.1.20 with llama3.3:70b, qwen3:32b and mistral-small): the person
 * sets one up, tests a draft, changes and removes it.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { pinMockDate } from '../../test/clock';
import { fixtureServices, mockedServices, renderApp } from '../../test/renderApp';

pinMockDate();

afterEach(() => {});

/** Advanced → AI on this Whombat (settings-groups.md). */
const AI = '/settings?tab=advanced&part=ai';
const SECTION = 'CUSTOM AI MODEL';

describe('custom AI model in Settings → Advanced → AI on this Whombat', () => {
  it('lets the person try one, save it and see it answer', async () => {
    const user = userEvent.setup();
    renderApp(AI, fixtureServices());
    const section = await screen.findByRole('region', { name: SECTION });
    expect(section.getAttribute('data-local-model')).toBe('none');

    const address = within(section).getByLabelText('Address');
    await user.type(address, 'http://127.0.0.1:11434/v1');
    await user.tab();
    // The contracts' sentence for an address that is this Whombat itself.
    expect(address.getAttribute('aria-invalid')).toBe('true');
    await user.clear(address);
    await user.type(address, 'http://192.168.1.20:11434/v1');
    await user.type(within(section).getByLabelText('Model'), 'qwen3:32b');
    await user.type(within(section).getByLabelText('Name (optional)'), 'Qwen on the NAS');

    await user.click(within(section).getByRole('button', { name: 'Test' }));
    const result = await within(section).findByText('It answers.');
    expect(result.closest('[data-test-result]')?.getAttribute('data-tone')).toBe('ok');

    await user.click(within(section).getByRole('button', { name: 'Save' }));
    const row = await within(section).findByText('Qwen on the NAS');
    expect(row.closest('[data-local-model-row]')?.getAttribute('data-check')).toBe('ok');
    expect(within(section).getByText('qwen3:32b · http://192.168.1.20:11434/v1')).toBeTruthy();
    expect(await screen.findByText('Saved the custom AI model.')).toBeTruthy();
  });

  it('says what a test found for a model the server doesn’t have', async () => {
    const user = userEvent.setup();
    renderApp(AI, fixtureServices());
    const section = await screen.findByRole('region', { name: SECTION });
    await user.type(within(section).getByLabelText('Address'), 'http://192.168.1.20:11434/v1');
    await user.type(within(section).getByLabelText('Model'), 'gemma9');
    await user.click(within(section).getByRole('button', { name: 'Test' }));
    const result = await within(section).findByText(/gemma9/);
    expect(result.closest('[data-test-result]')?.getAttribute('data-tone')).toBe('bad');
  });

  it('shows the saved one; Change keeps the key unshown, Remove asks first', async () => {
    const user = userEvent.setup();
    renderApp(AI, fixtureServices({ localModel: true }));
    const section = await screen.findByRole('region', { name: SECTION });
    expect(await within(section).findByText('Llama on the NAS')).toBeTruthy();
    expect(within(section).getByText('It answers.')).toBeTruthy();

    await user.click(within(section).getByRole('button', { name: 'Change' }));
    const key = within(section).getByLabelText('API key (optional)') as HTMLInputElement;
    expect(key.value).toBe('');
    expect(key.type).toBe('password');
    expect(within(section).getByText('A key is saved. Type a new one to replace it.')).toBeTruthy();
    expect((within(section).getByLabelText('Address') as HTMLInputElement).value).toBe(
      'http://192.168.1.20:11434/v1',
    );
    await user.click(within(section).getByRole('button', { name: 'Cancel' }));

    await user.click(within(section).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(section.getAttribute('data-local-model')).toBe('none'));
    expect(await screen.findByText('Removed the custom AI model.')).toBeTruthy();
  });

  it('shows a saved one with Check again, Change and Remove, and nobody else’s words', async () => {
    renderApp(AI, fixtureServices({ localModel: true }));
    const section = await screen.findByRole('region', { name: SECTION });
    expect(await within(section).findByText('Llama on the NAS')).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Change' })).toBeTruthy();
    expect(section.textContent).not.toMatch(/owner/i);
  });

  it('refuses to toast saved if the box answers ok without keeping the requested model', async () => {
    const base = createWebFixtureFetch();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
      const req = new Request(url, init);
      const res = await base(req, init);
      if (req.method === 'PUT' && url.pathname.endsWith('/local-model')) {
        const body = (await res.json()) as {
          burrow: Record<string, unknown>;
          localModel: Record<string, unknown>;
          eventId: null;
        };
        const returned = { ...body.localModel, model: 'different-model' };
        return Response.json({
          ...body,
          burrow: { ...body.burrow, localModel: returned },
          localModel: returned,
        });
      }
      return res;
    }) as unknown as typeof globalThis.fetch;
    const user = userEvent.setup();
    renderApp(AI, mockedServices(fetch));
    const section = await screen.findByRole('region', { name: SECTION });
    await user.type(within(section).getByLabelText('Address'), 'https://api.example.com/v1');
    await user.type(within(section).getByLabelText('Model'), 'qwen3:32b');
    await user.click(within(section).getByRole('button', { name: 'Save' }));
    expect(await within(section).findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Saved the custom AI model.')).toBeNull();
  });
});
