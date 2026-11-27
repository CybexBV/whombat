/**
 * A service page's head (docs/decisions/servers-connections-places.md): the name with its status word
 * only when it isn't fine (the level's word when Worth a look tells why), then one line of where it runs and when it
 * was checked; Change, the address and More detail (the version, Docker, the database, the uptime) are in ⋯.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { headFacts, pageHeadBadge } from '@whombat/client';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../../test/renderApp';

const HA = '/things/connection%3Acon_home-assistant';

describe('a service page’s head', () => {
  it('keeps the head to one line and puts the rest in ⋯', async () => {
    const user = userEvent.setup();
    renderApp(HA, fixtureServices({ hosts: true, connectors: 'connected' }));
    await screen.findByRole('heading', { level: 1, name: 'Home Assistant' }, { timeout: 12_000 });
    // The head (the logo, the name's box, the buttons and the fact line under them), once the page has answered: until
    // then it is drawn from what Home knows.
    await screen.findByRole('tab', { name: /^Summary/ }, { timeout: 12_000 });
    const head = screen
      .getByRole('heading', { level: 1, name: 'Home Assistant' })
      .closest('[class*="nameBox"]')?.parentElement as HTMLElement;
    const below = head.querySelector('[class*="below"]') as HTMLElement;
    // The level's word beside the name: Worth a look says why.
    expect(within(head).getByText('Needs a look')).toBeTruthy();
    // What shows: the detail under the fact line is there but hidden until More detail.
    const shown = (el: HTMLElement) => {
      const copy = el.cloneNode(true) as HTMLElement;
      for (const hidden of copy.querySelectorAll('[hidden]')) hidden.remove();
      return copy.textContent ?? '';
    };
    const words = shown(head);
    expect(words).toContain('pve-02');
    expect(words).toContain('Checked 2 min ago');
    expect(words).not.toContain('MariaDB');
    expect(words).not.toContain('10.100.0.5:8123');
    expect(screen.queryByRole('button', { name: 'More detail' })).toBeNull();

    await user.click(within(head).getByRole('button', { name: /^More/ }));
    expect(await screen.findByRole('menuitem', { name: 'Change what it runs on' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Copy address 10.100.0.5:8123' })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: 'More detail' }));
    await waitFor(() => expect(shown(below)).toContain('MariaDB 10.11'));
    expect(shown(below)).toContain('Docker');
  });

  it('says a page’s status in its head only when it isn’t fine, and the reason only where nothing else does', () => {
    const look = { key: 'summary', panels: [{ kind: 'notices', items: [{ tone: 'warn' }] }] } as never;
    const bare = { key: 'summary', panels: [] } as never;
    // Only a folded heads-up or an FYI: the head's badge is the one place the reason is said.
    const folded = {
      key: 'summary',
      panels: [{ kind: 'notices', items: [{ tone: 'warn', quiet: { until: null } }, { tone: 'info' }] }],
    } as never;
    expect(pageHeadBadge({ status: 'ok', badge: 'Connected', tabs: [look] })).toBeNull();
    expect(pageHeadBadge({ status: 'warn', badge: '2 integrations not loading', tabs: [look] })).toBe(
      'Needs a look',
    );
    expect(pageHeadBadge({ status: 'offline', badge: 'Can’t reach it', tabs: [look] })).toBe('Offline');
    expect(pageHeadBadge({ status: 'warn', badge: '2 integrations not loading', tabs: [bare] })).toBe(
      '2 integrations not loading',
    );
    expect(pageHeadBadge({ status: 'warn', badge: '2 integrations not loading', tabs: [folded] })).toBe(
      '2 integrations not loading',
    );
  });

  it('finds when it was checked among the facts', () => {
    const facts = [[{ text: 'MariaDB ' }, { text: '10.11', strong: true }], [{ text: 'Checked 1 min ago' }]];
    expect(headFacts(facts)).toEqual({ checked: facts[1], detail: [facts[0]] });
    expect(headFacts([]).checked).toBeNull();
  });
});
