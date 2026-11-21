/**
 * Settings → Advanced (settings-groups.md) against the fixture world: folded by default — a list of the
 * expert pages in its groups, a row each — and a row opens its page at `&part=` with the way back to the list. Facts
 * (ids, addresses, the rows' titles from the shared model), not sentences.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { advancedRows, SETTINGS_GROUP_TEXT } from '@whombat/client';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_NAME } from '../../app/oneFixtures';
import { fixtureServices, renderApp } from '../../test/renderApp';

const ADVANCED = '/settings?tab=advanced';
const title = (key: string) => advancedRows(ASSISTANT_NAME).find((r) => r.key === key)?.title ?? key;

/** Advanced's list, once it is on the page. */
async function list(): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-advanced-list]');
    if (!el) throw new Error('no list yet');
    return el;
  });
}
const rowKeys = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-advanced-row]')].map((r) => r.getAttribute('data-advanced-row'));

describe('Settings → Advanced', () => {
  it('lists the expert pages in their groups, a link each, and nothing open', async () => {
    renderApp(ADVANCED, fixtureServices());
    expect(await screen.findByRole('heading', { name: 'Advanced', level: 1 })).toBeTruthy();
    const el = await list();
    const sections = SETTINGS_GROUP_TEXT.advanced.sections(ASSISTANT_NAME);
    const labels = [...el.querySelectorAll('h2')].map((h) => h.textContent);
    expect(labels).toEqual([sections.ai, sections.work, sections.whombat]);
    const keys = rowKeys(el);
    expect(keys).toEqual(['model', 'ai', 'running', 'skills', 'audit']);
    // Usage has no row; the diagnostics file is a box's (a managed Whombat). What moved out —
    // Connections, GitHub, Website feedback, the keys, the home network ranges, the schedules — has no row.
    // Each row is a link to its page.
    const skillsRow = within(el).getByRole('link', { name: new RegExp(`^${title('skills')}`) });
    expect(skillsRow.getAttribute('href')).toBe('/settings?tab=advanced&part=skills');
    expect(document.querySelector('[data-advanced-part]')).toBeNull();
  });

  it('opens a row’s page with its title and the way back to the list', async () => {
    const user = userEvent.setup();
    const app = renderApp(ADVANCED, fixtureServices());
    const el = await list();
    await user.click(within(el).getByRole('link', { name: new RegExp(`^${title('running')}`) }));
    await waitFor(() => expect(app.location()).toBe('/settings?tab=advanced&part=running'));
    const page = document.querySelector<HTMLElement>('[data-advanced-part]');
    expect(page?.getAttribute('data-advanced-part')).toBe('running');
    expect(
      within(page as HTMLElement).getByRole('heading', { level: 2, name: title('running') }),
    ).toBeTruthy();
    const back = screen.getByRole('link', { name: SETTINGS_GROUP_TEXT.advanced.back });
    expect(back.getAttribute('href')).toBe(ADVANCED);
    await user.click(back);
    await waitFor(() => expect(app.location()).toBe(ADVANCED));
    expect(rowKeys(await list())).toContain('running');
  });

  it('opens a page from its address, and the list for a part it doesn’t have', async () => {
    const first = renderApp('/settings?tab=advanced&part=audit', fixtureServices());
    expect(await screen.findByRole('heading', { level: 2, name: title('audit') })).toBeTruthy();
    expect(document.querySelector('[data-advanced-part]')?.getAttribute('data-advanced-part')).toBe('audit');
    first.unmount();
    renderApp('/settings?tab=advanced&part=nope', fixtureServices());
    expect(rowKeys(await list())).toContain('audit');
    expect(document.querySelector('[data-advanced-part]')).toBeNull();
  });

  it('sends the pages that moved out to where they are now', async () => {
    const cases: [string, string][] = [
      ['/settings?tab=advanced&part=keys&key=deploy', '/settings?tab=agent&part=may&key=deploy'],
      ['/settings?tab=advanced&part=network', '/settings?tab=agent&part=may#local-network'],
      ['/settings?tab=advanced&part=schedules', '/automations'],
      ['/connections?connection=github', '/connections?connection=github'],
      ['/connections?connection=feedback', '/connections?connection=feedback'],
      ['/settings?tab=advanced&part=accounts', '/settings?tab=connections'],
    ];
    for (const [from, to] of cases) {
      const app = renderApp(from, fixtureServices());
      await waitFor(() => expect(`${app.location()}${app.history.location.hash}`).toBe(to));
      app.unmount();
    }
  });
});
