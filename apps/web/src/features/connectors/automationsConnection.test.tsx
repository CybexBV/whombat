/**
 * A report tracker, a connection only automations use (Whombat report-trackers.md TA-01…TA-03), against the fixture
 * catalog (catalogFixtures.ts: the made-up “Acme Desk dev”, reached 2 min ago, and “Acme Desk”, which the poller can't
 * reach): its row on the overview, its page without the agents' parts but “Used by automations” and the poller's line,
 * and its connect form without What may the agent do?
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { pinMockDate } from '../../test/clock';
import { fixtureServices, renderApp } from '../../test/renderApp';
import { USED_BY_AUTOMATIONS } from './catalog';

pinMockDate();

const DEV = '/connections?connection=tracker&id=con_fixture_tracker';
const PROD = '/connections?connection=tracker&id=con_fixture_tracker_prod';
/** Automations answer its customers too (AP-1112). */
const USED_REPLIES = USED_BY_AUTOMATIONS.text;
const ORGANIZATION = USED_BY_AUTOMATIONS.organization;
/** Connections' own Add a connection (the sidebar has one too). */
const addConnection = () =>
  screen
    .getAllByRole('link', { name: 'Add a connection' })
    .find((l) => !l.closest('[aria-label="Sidebar"]')) as HTMLElement;

describe('a report tracker connection (TA-01…TA-03)', () => {
  it('lists its rows with their address only, like any connection (AP-1177)', async () => {
    renderApp('/settings?tab=connections', fixtureServices({ connectors: 'connected' }));
    const connected = await screen.findByRole('region', { name: 'APPS AND SERVICES' });
    const dev = await within(connected).findByRole('link', { name: /Acme Desk dev/ });
    expect(within(dev).getByText('dev.desk.acme.example')).toBeTruthy();
    expect(dev.textContent).not.toMatch(/tools?|Look only|Connected by|Used by automations/);
    // No tracker's brand: the entry is the same for every tracker.
    expect(dev.querySelector('[data-tile]')).toBeNull();
    // Its tile is on Add a connection, Connected.
    await userEvent.setup().click(addConnection());
    const tile = await screen.findByRole('link', { name: 'Connect Report tracker' });
    expect(tile.textContent).toContain('assessed by automations');
    expect(tile.textContent).toContain('Connected');
  });

  it('shows its page without the agents’ parts: “Used by automations” and the poller’s last check', async () => {
    renderApp(DEV, fixtureServices({ connectors: 'connected' }));
    // The Settings address opens the Settings tab of its own page (connection-pages.md CP-01), named in its head.
    expect(
      await screen.findByRole('heading', { name: 'Acme Desk dev', level: 1 }, { timeout: 12_000 }),
    ).toBeTruthy();
    const card = (await screen.findByRole('region', { name: 'CONNECTION' })) as HTMLElement;
    expect(within(card).getByText('Checked for new reports 2 min ago.')).toBeTruthy();
    // Which installation it is and its version.
    expect(within(card).getByText('Development · version 0.1.174')).toBeTruthy();
    const used = card.querySelector('[data-block="used-by-automations"]') as HTMLElement;
    expect(within(used).getByText('Used by automations')).toBeTruthy();
    expect(within(used).getByText(USED_REPLIES)).toBeTruthy();
    // Looking inside the reporting organization follows the token (TA-22, TA-23).
    expect(within(used).getByText(ORGANIZATION)).toBeTruthy();
    expect(within(card).getByText('dev.desk.acme.example')).toBeTruthy();
    // None of what the agent has: its name for it, the level, the tools.
    expect(within(card).queryByText(/CALLS IT$/)).toBeNull();
    expect(within(card).queryByText(/MAY DO$/)).toBeNull();
    expect(within(card).queryByText(/ calls it /)).toBeNull();
    expect(screen.queryByRole('region', { name: 'TOOLS' })).toBeNull();
    // Its token is replaced like any other.
    expect(screen.getByRole('button', { name: 'Replace token' })).toBeTruthy();
  });

  it('says when the poller couldn’t reach the tracker, and when it last did', async () => {
    renderApp(PROD, fixtureServices({ connectors: 'connected' }));
    const card = (await screen.findByRole('region', { name: 'CONNECTION' })) as HTMLElement;
    const line = await within(card).findByText(
      'Couldn’t reach Acme Desk: Acme Desk didn’t answer within 15 s. Last reached 1 hour ago.',
    );
    expect(line.dataset.tone).toBe('warn');
    expect(within(card).queryByText(/Checked for new reports/)).toBeNull();
    // The installation it was when last reached.
    expect(within(card).getByText('Production · version 0.1.170')).toBeTruthy();
  });

  it('connects without asking what agents may do', async () => {
    const user = userEvent.setup();
    renderApp('/connections?connection=tracker', fixtureServices({ connectors: 'connected' }));
    const steps = await screen.findByRole('list', { name: 'Connect Report tracker' });
    expect(within(steps).getByText('Where is it?')).toBeTruthy();
    await user.type(screen.getByLabelText(/^ADDRESS/i), 'https://staging.desk.acme.example');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await within(steps).findByText('How should Whombat sign in?')).toBeTruthy();
    expect(within(steps).queryByText(/^What may .* do\?$/)).toBeNull();
    expect(screen.queryByRole('radio', { name: /Look only/ })).toBeNull();
  });
});
