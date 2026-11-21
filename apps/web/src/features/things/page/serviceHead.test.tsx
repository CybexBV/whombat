/**
 * A service page's head after the UI refresh (docs/decisions/ui-refresh-chat.md): the status pill leads the first line
 * with what it runs on (and Change), the address to copy and when it was checked; the version, Docker, the database
 * and the uptime are under “More detail”.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { headFacts } from '@whombat/client';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../../test/renderApp';

const HA = '/things/connection%3Acon_home-assistant';

describe('a service page’s head', () => {
  it('keeps the first line short and folds the rest under More detail', async () => {
    const user = userEvent.setup();
    renderApp(HA, fixtureServices({ hosts: true, connectors: 'connected' }));
    const more = await screen.findByRole('button', { name: 'More detail' }, { timeout: 12_000 });
    const line = more.closest('div') as HTMLElement;
    const words = line.textContent ?? '';
    expect(words.indexOf('Needs a look')).toBe(0);
    expect(words).toContain('pve-02');
    expect(words).toContain('Checked 2 min ago');
    expect(words).not.toContain('MariaDB');
    expect(screen.getByRole('button', { name: 'Change what Home Assistant runs on' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy the address 10.100.0.5:8123' })).toBeTruthy();

    const detail = document.getElementById(more.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(detail.hidden).toBe(true);
    await user.click(more);
    await waitFor(() => expect(more.getAttribute('aria-expanded')).toBe('true'));
    expect(detail.hidden).toBe(false);
    expect(detail.textContent).toContain('MariaDB 10.11');
    expect(detail.textContent).toContain('Docker');
  });

  it('finds when it was checked among the facts', () => {
    const facts = [[{ text: 'MariaDB ' }, { text: '10.11', strong: true }], [{ text: 'Checked 1 min ago' }]];
    expect(headFacts(facts)).toEqual({ checked: facts[1], detail: [facts[0]] });
    expect(headFacts([]).checked).toBeNull();
  });
});
