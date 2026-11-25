/**
 * Monitoring on the web against the fixture world: Keep quiet… from a page's ⋯ and End now, the line under the
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
const BLACKBOX = '/things/server%3Ablackbox';
const calm = () => fixtureServices({ hosts: true, connectors: 'connected', monitoring: false });
const seeded = () => fixtureServices({ hosts: true, connectors: 'connected', monitoring: true });
const T = { timeout: 12_000 };

describe('keep quiet for a while', () => {
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
    // The head's state pill would say the hold's first words again: the line under it says them once.
    const head = screen.getByRole('main', { name: 'UniFi' });
    expect(
      within(head)
        .getAllByText(/^Quiet until/)
        .every((el) => hold.contains(el)),
    ).toBe(true);
    const worth = await screen.findByRole('region', { name: 'Worth a look' }, T);
    // The hold's heads-up line is for apps that don't draw the line under the head.
    expect(within(worth).queryByText(/^Quiet until/, { selector: 'b' })).toBeNull();
    await user.click(within(worth).getByRole('button', { name: /^Show \d+ on hold$/ }));
    const ap = within(worth)
      .getByText('AP Paardenstal is offline', { exact: false })
      .closest('[data-notice]');
    expect(ap?.textContent).toContain('Kept quiet by Mara');
    expect(within(ap as HTMLElement).getByRole('button', { name: /^End now/ })).toBeTruthy();
    expect(within(ap as HTMLElement).queryByRole('button', { name: /^Undo/ })).toBeNull();
  });
});

describe('one cause', () => {
  it('says why under the head with a link to the cause, and its lines offer neither Undo nor End now', async () => {
    renderApp(HA, seeded());
    const hold = await screen.findByRole('region', { name: 'Why it isn’t answering' }, T);
    expect(hold.textContent).toContain('Not answering while homeassistant is stopped');
    expect(within(hold).getByRole('link', { name: 'Open homeassistant' }).getAttribute('href')).toContain(
      'pve-02',
    );
    expect(within(hold).queryByRole('button', { name: 'End now' })).toBeNull();
    // Said once: not again in the head's state pill above it.
    expect(screen.getAllByText('Not answering while homeassistant is stopped')).toHaveLength(1);
  });
});

describe('Overview while things are held', () => {
  /** Overview's own page (the sidebar lists the servers too). */
  const overview = () =>
    waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-screen="home"]');
      if (!el) throw new Error('Overview isn’t there yet');
      return el;
    }, T);

  it('counts a connection down because of something else as not answering, its tile still grey', async () => {
    renderApp('/connections', seeded());
    const page = await overview();
    const label = await within(page).findByText('Connections working', {}, T);
    const figure = label.closest('div') as HTMLElement;
    // Home Assistant is down while its machine is stopped: one of five isn't working.
    await waitFor(() => expect(figure.textContent).toContain('1 not answering'));
    expect(figure.textContent).toMatch(/4\s*of 5/);
    expect(figure.querySelector('[data-tone="off"]')).toBeTruthy();
    expect(await within(page).findByText('Not answering while homeassistant is stopped', {}, T)).toBeTruthy();
  });

  it('says on a server’s row until when it is kept quiet, as the phone’s card does', async () => {
    const user = userEvent.setup();
    renderApp(PVE02, calm());
    await user.click(await screen.findByRole('button', { name: 'More for pve-02' }, T));
    await user.click(await screen.findByRole('menuitem', { name: 'Keep quiet…' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep quiet' }));
    await screen.findByRole('region', { name: 'Kept quiet' }, T);
    await user.click(screen.getAllByRole('link', { name: 'Overview' })[0] as HTMLElement);
    const page = await overview();
    const row = await waitFor(() => {
      const el = page.querySelector<HTMLElement>('[data-server="pve-02"]');
      if (!el?.querySelector('[data-quiet]')) throw new Error('no quiet line yet');
      return el;
    }, T);
    const quiet = row.querySelector('[data-quiet]') as HTMLElement;
    expect(quiet.textContent).toMatch(/^Quiet until /);
    const name = within(row).getByRole('link', { name: /^pve-02, / });
    expect(name.getAttribute('aria-label')).toContain(`. ${quiet.textContent}`);
    // Only the server kept quiet says so.
    expect(page.querySelector('[data-server="pve-01"] [data-quiet]')).toBeNull();
  });
});

describe('a server’s tabs while it is kept quiet', () => {
  it('a held line on a tab offers End now, never Undo, and ends the whole window', async () => {
    const user = userEvent.setup();
    renderApp(`${BLACKBOX}?tab=array`, calm());
    await screen.findByText('The disk array on blackbox has failed', { selector: 'b' }, T);
    await user.click(await screen.findByRole('button', { name: 'More for blackbox' }, T));
    await user.click(await screen.findByRole('menuitem', { name: 'Keep quiet…' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep quiet' }));
    await screen.findByRole('region', { name: 'Kept quiet' }, T);
    const line = await waitFor(() => {
      const b = screen.getByText('The disk array on blackbox has failed', { selector: 'b' });
      const held = b.closest('[data-quiet]');
      expect(held).toBeTruthy();
      return held as HTMLElement;
    }, T);
    expect(line.textContent).toContain('Kept quiet by Mara');
    expect(within(line).queryByRole('button', { name: /^Undo/ })).toBeNull();
    await user.click(within(line).getByRole('button', { name: /^End now/ }));
    expect(await screen.findByText('Whombat watches blackbox again.')).toBeTruthy();
  });
});

describe('what happened', () => {
  it('lists a thing’s incidents with when and how long, and says when nothing went wrong', async () => {
    renderApp(HA, seeded());
    const card = (await screen.findByRole('heading', { name: 'What happened' }, T)).closest(
      'section',
    ) as HTMLElement;
    await waitFor(() => expect(card.querySelectorAll('[data-history]').length).toBeGreaterThan(0));
    expect(card.textContent).toContain('still going');
    expect(card.textContent).toContain('While homeassistant was down');
  });

  it('says a server’s outage once, its own alerts under “From the server”, “Show N more” with the outages', async () => {
    const user = userEvent.setup();
    renderApp(PVE02, seeded());
    const card = (await screen.findByRole('heading', { name: 'What happened' }, T)).closest(
      'section',
    ) as HTMLElement;
    await waitFor(() => expect(card.querySelectorAll('[data-history]').length).toBeGreaterThan(0));
    // Its “isn’t checking in” alerts are the outages listed above: only the other two are left to show.
    const fold = within(card).getByRole('button', { name: 'Show 2 alerts from the server' });
    await user.click(fold);
    const group = within(card).getByRole('region', { name: 'From the server' });
    expect(group.querySelectorAll('[data-history]')).toHaveLength(2);
    expect(card.textContent).not.toContain('isn’t checking in');
    // “Show 1 more” belongs to the outages: it comes before the heading.
    const more = within(card).getByRole('button', { name: 'Show 1 more' });
    expect(more.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says nothing went wrong on a calm world', async () => {
    renderApp(HETZNER, calm());
    const card = (await screen.findByRole('heading', { name: 'What happened' }, T)).closest(
      'section',
    ) as HTMLElement;
    expect(await within(card).findByText('Nothing went wrong in the last 30 days.')).toBeTruthy();
  });
});

describe('change the limit', () => {
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

  it('says a refused limit in the open sheet, which stays open, and toasts nothing', async () => {
    const user = userEvent.setup();
    renderApp(PVE02, seeded());
    await user.click(await screen.findByRole('tab', { name: 'System' }, T));
    await user.click(await screen.findByRole('button', { name: 'Change the limit: Running hot' }, T));
    const sheet = await screen.findByRole('dialog');
    const field = within(sheet).getByLabelText('WARN ABOVE');
    await user.clear(field);
    // Within the check's range, but at the sensor's critical limit: only the hub can refuse it.
    await user.type(field, '95');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(within(sheet).getByRole('alert').textContent).toContain('below the critical limit of 95 °C'),
    );
    expect(screen.getByRole('dialog')).toBe(sheet);
    expect(screen.queryByText(/warns above/)).toBeNull();
    expect(screen.getAllByText(/below the critical limit/)).toHaveLength(1);
  });
});
