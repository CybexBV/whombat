/**
 * Service pages in the fixture world (`@whombat/fixtures` `createServicePages`; contracts 0.121, CT-1000…CT-1014;
 * service-dashboards.md AP-4560…AP-4571): Seerr's requests approved and declined from their rows with the toast in the
 * server's words and the page read again, a head button, Pi-hole's question before pausing for 30 minutes, and Home
 * Assistant's Controls switching a light that the next read keeps; Plex's Summary in slots (service-slots-web.md):
 * the Worth a look strip, live rows, counts with their Scan, the shelf, people and the week's labelled bars.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../../test/renderApp';

const world = () => fixtureServices({ services: true, connectors: 'connected' });
const card = async (title: string) =>
  (await screen.findByRole('heading', { name: title, level: 2 }, { timeout: 12_000 })).closest(
    'section',
  ) as HTMLElement;

describe('a service’s page (AP-4560…AP-4571)', () => {
  it('approves a request from its row, says so, and reads the page again', async () => {
    renderApp('/things/connection%3Acon_seerr', world());
    const waiting = await card('Waiting for you');
    const row = (id: string) => waiting.querySelector(`[data-item="${id}"]`) as HTMLElement | null;
    const wicked = row('412') as HTMLElement;
    // Who asked, with their initial, beside what it is.
    expect(within(wicked).getByText('Sam')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(wicked).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/Approved Wicked: For Good/)).toBeTruthy();
    await waitFor(() => expect(row('412')).toBeNull());

    // Declining asks first; cancelling sends nothing.
    await user.click(within(row('411') as HTMLElement).getByRole('button', { name: 'Decline' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(row('411')).toBeTruthy();

    // Requests by state with what changed this week.
    const requests = await card('Requests');
    expect(within(requests).getByText('+6 this week')).toBeTruthy();
  });

  it('pauses Pi-hole for 30 minutes only after its question', async () => {
    renderApp('/things/connection%3Acon_pihole', world());
    await card('Most blocked');
    const user = userEvent.setup();
    // In slots the pauses are on Blocking now's line, not in the head.
    const live = await card('Blocking now');
    await user.click(within(live).getByRole('button', { name: 'Pause 30 min' }));
    const dialog = await screen.findByRole('dialog');
    const yes = within(dialog)
      .getAllByRole('button')
      .find((b) => b.textContent !== 'Cancel');
    expect(yes).toBeTruthy();
    await user.click(yes as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Once the page is read again, the line offers Resume.
    expect(await within(await card('Blocking now')).findByRole('button', { name: 'Resume' })).toBeTruthy();
  });

  it('switches a light in Home Assistant’s Controls and keeps what the next read says', async () => {
    renderApp('/things/connection%3Acon_home-assistant', world());
    const controls = await card('Controls');
    const switches = within(controls).getAllByRole('switch');
    const first = switches[0] as HTMLElement;
    const was = first.getAttribute('aria-checked');
    const user = userEvent.setup();
    await user.click(first);
    const now = was === 'true' ? 'false' : 'true';
    expect(first.getAttribute('aria-checked')).toBe(now);
    // The page is read again after the answer, and the world says the same.
    await waitFor(() =>
      expect(within(controls).getAllByRole('switch')[0]?.getAttribute('aria-checked')).toBe(now),
    );
  });

  it('draws Plex’s Summary in slots: the strip, live rows, counts, a shelf, people and the week', async () => {
    renderApp('/things/connection%3Acon_plex', world());
    const playing = await card('Now playing');
    // The head: the verdict on the name's line.
    expect(screen.getByText(/^Plex is fine: 3 people are watching/)).toBeTruthy();

    // Worth a look is a strip of its lines, no card of its own; its heads-ups fold behind their own row.
    const strip = screen.getByRole('region', { name: 'Worth a look' });
    await userEvent.setup().click(within(strip).getByRole('button', { name: /^Show \d+ heads-ups?$/ }));
    expect(strip.querySelectorAll('[data-notice]')).toHaveLength(2);
    expect(within(strip).getByText('Plex couldn’t match 3 home videos')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Worth a look', level: 2 })).toBeNull();

    // Live rows: who watches with their initial and device, the tag, and the progress with both ends.
    const dune = playing.querySelector('[data-item="session-1"]') as HTMLElement;
    expect(within(dune).getByText('Anna')).toBeTruthy();
    expect(within(dune).getByText('Living room TV')).toBeTruthy();
    expect(within(dune).getByText('Direct play')).toBeTruthy();
    const bar = within(dune).getByRole('progressbar', { name: 'Dune: Part Two' });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(bar.getAttribute('aria-valuetext')).toContain('1 h 36 min left');

    // Counts: the figure, what changed, and Scan as a glyph named by its label.
    const libraries = await card('Libraries');
    const movies = libraries.querySelector('[data-item="1"]') as HTMLElement;
    expect(within(movies).getByText('1,284')).toBeTruthy();
    expect(within(movies).getByText('+9 this week')).toBeTruthy();
    expect(within(movies).getByRole('button', { name: 'Scan Movies' })).toBeTruthy();

    // The shelf: one row (eight where nothing measures), each picture's tag says who asked; See all in Plex on top.
    const shelf = await card('Recently added');
    expect(shelf.querySelectorAll('[data-item]')).toHaveLength(8);
    expect(within(shelf).getByRole('link', { name: /^Conclave · Film.* · Anna asked$/ })).toBeTruthy();
    expect(within(shelf).getByRole('link', { name: 'See all in Plex' })).toBeTruthy();

    // People with their initials; the machine's name leads to its page.
    const people = await card('Who watches');
    expect(within(people).getByText('21 plays')).toBeTruthy();
    const machine = await card('The machine');
    expect(within(machine).getByRole('link', { name: 'See thetitan' }).textContent).toBe('thetitan');

    // The week: a bar per day with its word under it, today last; no range picker for it.
    const week = await card('This week');
    expect(within(week).getByText('Today')).toBeTruthy();
    expect(within(week).getAllByRole('listitem')).toHaveLength(7);
    expect(within(week).getByRole('listitem', { name: /^Today · 7 plays$/ })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Range' })).toBeNull();
  });
});
