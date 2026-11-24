/**
 * Monitoring on the web (Whombat docs/decisions/monitoring.md MON-04, MON-07, MON-09, MON-15; app
 * monitoring-web.md AP-9930…) against the fixture world: Keep quiet… from a page's ⋯ and End now, the line under the
 * head of a thing kept quiet or down because of something else, held lines folded with End now, What happened, and a
 * server check's limit from a line's ⋯.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../../test/renderApp';

const HETZNER = '/things/connection%3Acon_hetzner';
const UNIFI = '/things/connection%3Acon_unifi';
const HA = '/things/connection%3Acon_home-assistant';
const PVE02 = '/things/server%3Apve-02';
const calm = () => fixtureServices({ hosts: true, connectors: 'connected', monitoring: false });
const seeded = () => fixtureServices({ hosts: true, connectors: 'connected', monitoring: true });
const T = { timeout: 12_000 };

describe('keep quiet for a while (MON-04)', () => {
  it('keeps a thing quiet from ⋯ until a time with a note, says so under the head, and ends it', async () => {
    const user = userEvent.setup();
    renderApp(HETZNER, calm());
    await user.click(await screen.findByRole('button', { name: 'More for Hetzner' }, T));
    await user.click(await screen.findByRole('menuitem', { name: 'Keep quiet…' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('heading', { name: 'Keep Hetzner quiet' })).toBeTruthy();
    const choices = within(sheet)
      .getAllByRole('radio')
      .map((r) => r.closest('label')?.textContent ?? '');
    expect(choices.some((c) => c.startsWith('For an hour'))).toBe(true);
    expect(choices.some((c) => c.startsWith('Pick a time'))).toBe(true);
    await user.type(within(sheet).getByLabelText('NOTE (OPTIONAL)'), 'Moving the NAS');
    await user.click(within(sheet).getByRole('button', { name: 'Keep quiet' }));
    // The toast says until when, with Undo.
    expect(await screen.findByText(/^Quiet until .+\.$/)).toBeTruthy();
    const hold = await screen.findByRole('region', { name: 'Kept quiet' }, T);
    expect(hold.textContent).toContain('Moving the NAS');
    await user.click(within(hold).getByRole('button', { name: 'End now' }));
    expect(await screen.findByText('Whombat watches Hetzner again.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Kept quiet' })).toBeNull());
  });

  it('a picked time that is gone stays in the sheet with why', async () => {
    const user = userEvent.setup();
    renderApp(HETZNER, calm());
    await user.click(await screen.findByRole('button', { name: 'More for Hetzner' }, T));
    await user.click(await screen.findByRole('menuitem', { name: 'Keep quiet…' }));
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('radio', { name: /Pick a time/ }));
    const until = within(sheet).getByLabelText('UNTIL');
    fireEvent.change(until, { target: { value: '2020-01-01T10:00' } });
    await user.click(within(sheet).getByRole('button', { name: 'Keep quiet' }));
    expect(within(sheet).getByRole('alert').textContent).toContain('still ahead');
  });

  it('a page kept quiet folds its held lines, each with End now instead of Undo', async () => {
    const user = userEvent.setup();
    renderApp(UNIFI, seeded());
    const hold = await screen.findByRole('region', { name: 'Kept quiet' }, T);
    expect(hold.textContent).toContain('Replacing the attic access point');
    const worth = await screen.findByRole('region', { name: 'Worth a look' }, T);
    // The hold's heads-up line is for apps that don't draw the line under the head.
    expect(within(worth).queryByText(/^Quiet until/, { selector: 'b' })).toBeNull();
    await user.click(within(worth).getByRole('button', { name: /^Show \d+ kept quiet$/ }));
    const ap = within(worth)
      .getByText('AP Paardenstal is offline', { exact: false })
      .closest('[data-notice]');
    expect(ap?.textContent).toContain('Kept quiet by Mara');
    expect(within(ap as HTMLElement).getByRole('button', { name: /^End now/ })).toBeTruthy();
    expect(within(ap as HTMLElement).queryByRole('button', { name: /^Undo/ })).toBeNull();
  });
});

describe('one cause (MON-07)', () => {
  it('says why under the head with a link to the cause, and its lines offer neither Undo nor End now', async () => {
    renderApp(HA, seeded());
    const hold = await screen.findByRole('region', { name: 'Why it isn’t answering' }, T);
    expect(hold.textContent).toContain('Not answering while homeassistant is stopped');
    expect(within(hold).getByRole('link', { name: 'Open homeassistant' }).getAttribute('href')).toContain(
      'pve-02',
    );
    expect(within(hold).queryByRole('button', { name: 'End now' })).toBeNull();
  });
});

describe('what happened (MON-09)', () => {
  it('lists a thing’s incidents with when and how long, and says when nothing went wrong', async () => {
    renderApp(HA, seeded());
    const card = (await screen.findByRole('heading', { name: 'What happened' }, T)).closest(
      'section',
    ) as HTMLElement;
    await waitFor(() => expect(card.querySelectorAll('[data-history]').length).toBeGreaterThan(0));
    expect(card.textContent).toContain('still going');
    expect(card.textContent).toContain('While homeassistant was down');
  });

  it('says nothing went wrong on a calm world', async () => {
    renderApp(HETZNER, calm());
    const card = (await screen.findByRole('heading', { name: 'What happened' }, T)).closest(
      'section',
    ) as HTMLElement;
    expect(await within(card).findByText('Nothing went wrong in the last 30 days.')).toBeTruthy();
  });
});

describe('change the limit (MON-15)', () => {
  it('changes a disk’s limit from its line’s ⋯ with Undo in the toast', async () => {
    const user = userEvent.setup();
    renderApp(PVE02, seeded());
    await user.click(await screen.findByRole('button', { name: /^More for Disk \/var\/lib\/vz/ }, T));
    const item = await screen.findByRole('menuitem', { name: /Change the limit/ });
    expect(item.textContent).toContain('Now 90 %');
    await user.click(item);
    const sheet = await screen.findByRole('dialog');
    expect(sheet.textContent).toContain('/var/lib/vz');
    const field = within(sheet).getByLabelText('WARN ABOVE');
    await user.clear(field);
    await user.type(field, '120');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(within(sheet).getByRole('alert').textContent).toContain('1 to 100');
    await user.clear(field);
    await user.type(field, '95');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/warns above 95 % now/)).toBeTruthy();
  });
});
