/**
 * WEB SEARCH in Settings → Advanced → AI on this Whombat (web-search.md) against the fixture world's Brave
 * (webSearchFixtures.ts: it takes keys that start with `BSA`): the person gets a key at Brave, pastes it and saves;
 * a key Brave turns away says so under the field; on, it checks again, takes another key and is removed.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BRAVE_SEARCH_KEYS_URL, BRAVE_SEARCH_SIGNUP_URL } from '@whombat/core/domain';
import { describe, expect, it, vi } from 'vitest';
import { pinMockDate } from '../../test/clock';
import { fixtureServices, renderApp } from '../../test/renderApp';

pinMockDate();

/** Advanced → AI on this Whombat (settings-groups.md). */
const AI = '/settings?tab=advanced&part=ai';
const SECTION = 'WEB SEARCH';
const FIELD = 'Brave Search API key';

describe('web search in Settings → Advanced → AI on this Whombat', () => {
  it('off: links to Brave’s keys page and sign-up, and has the key field', async () => {
    renderApp(AI, fixtureServices());
    const section = await screen.findByRole('region', { name: SECTION });
    expect(section.getAttribute('data-web-search')).toBe('off');

    const getKey = within(section).getByRole('link', { name: /Get a Brave Search key/ });
    expect(getKey.getAttribute('href')).toBe(BRAVE_SEARCH_KEYS_URL);
    expect(getKey.getAttribute('target')).toBe('_blank');
    expect(getKey.getAttribute('rel')).toContain('noopener');
    const signUp = within(section).getByRole('link', { name: /Sign up/ });
    expect(signUp.getAttribute('href')).toBe(BRAVE_SEARCH_SIGNUP_URL);

    const field = within(section).getByLabelText(FIELD) as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect((within(section).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves a pasted key and shows it on', async () => {
    const user = userEvent.setup();
    const services = fixtureServices();
    const request = vi.spyOn(services.client, 'request');
    renderApp(AI, services);
    const section = await screen.findByRole('region', { name: SECTION });
    await user.type(within(section).getByLabelText(FIELD), '  BSA-key-from-brave  ');
    await user.click(within(section).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(section.getAttribute('data-web-search')).toBe('on'));
    expect(within(section).getByText('On, with your Brave Search key.')).toBeTruthy();
    expect(within(section).getByText('It works.')).toBeTruthy();
    expect(await screen.findByText('Web search is on.')).toBeTruthy();
    const save = request.mock.calls.find(([ep]) => ep.id === 'burrows.setWebSearch');
    expect((save?.[1] as { body?: unknown } | undefined)?.body).toEqual({
      apiKey: 'BSA-key-from-brave',
    });
  });

  it('shows Brave’s refusal under the field', async () => {
    const user = userEvent.setup();
    renderApp(AI, fixtureServices());
    const section = await screen.findByRole('region', { name: SECTION });
    const field = within(section).getByLabelText(FIELD);
    await user.type(field, 'notABraveKey123');
    await user.click(within(section).getByRole('button', { name: 'Save' }));

    expect(await within(section).findByText(/Brave doesn’t accept this key/)).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(section.getAttribute('data-web-search')).toBe('off');
  });

  it('on: Check again, Use another key with Cancel, and Remove asks first', async () => {
    const user = userEvent.setup();
    renderApp(AI, fixtureServices({ webSearch: true }));
    const section = await screen.findByRole('region', { name: SECTION });
    expect(within(section).getByText('On, with your Brave Search key.')).toBeTruthy();
    expect(within(section).getByText('It works.')).toBeTruthy();

    await user.click(within(section).getByRole('button', { name: 'Check again' }));
    expect(within(section).getByText('It works.')).toBeTruthy();

    await user.click(within(section).getByRole('button', { name: 'Use another key' }));
    expect(within(section).getByLabelText(FIELD)).toBeTruthy();
    await user.click(within(section).getByRole('button', { name: 'Cancel' }));
    expect(within(section).queryByLabelText(FIELD)).toBeNull();

    await user.click(within(section).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Remove web search?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(section.getAttribute('data-web-search')).toBe('off'));
    expect(await screen.findByText('Removed web search.')).toBeTruthy();
  });
});
