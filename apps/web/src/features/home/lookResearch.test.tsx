import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DESK_WORDS } from '@whombat/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { HA_LOOK_THREAD, UNIFI_LOOK_THREAD } from '../../app/lookFixtures';
import { fixtureServices, renderApp } from '../../test/renderApp';

// The fixture world with the looks Neo looked into (lookFixtures.ts, look-research-web.md AP-5909).
const looks = () => fixtureServices({ looks: true });

// The page's screens are loaded before the first test's waits start: imported cold on a busy machine, their modules can
// take most of `findBy`'s five seconds before anything renders.
beforeAll(() => import('../things/ThingScreen'), 30_000);

describe('a look the assistant looked into, on its thing’s page (AP-5906)', () => {
  it('at the top of the Summary, with the step and Ask; not on the other tabs', async () => {
    const user = userEvent.setup();
    const app = renderApp('/things/connection%3Acon_unifi', looks());
    const card = await screen.findByRole('region', { name: 'The hallway access point is offline' });
    expect(
      within(card)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Ask Neo']);
    await user.click(within(card).getByRole('button', { name: 'Ask Neo' }));
    await waitFor(() => expect(app.location()).toBe(`/chat?thread=${UNIFI_LOOK_THREAD}`));
  });

  it('the step on the page: “I’m on it.” at once, then its thread opens (BPL-15)', async () => {
    const user = userEvent.setup();
    const app = renderApp('/things/connection%3Acon_home-assistant', looks());
    const card = await screen.findByRole('region', { name: 'Zigbee stopped working in Home Assistant' });
    await user.click(within(card).getByRole('button', { name: 'Restart Zigbee' }));
    expect(await within(card).findByText(DESK_WORDS.looks.fixing)).toBeTruthy();
    await waitFor(() => expect(app.location()).toBe(`/chat?thread=${HA_LOOK_THREAD}`));
  });

  it('not on the other tabs', async () => {
    const user = userEvent.setup();
    renderApp('/things/connection%3Acon_home-assistant', looks());
    await screen.findByRole('region', { name: 'Zigbee stopped working in Home Assistant' });
    await user.click(screen.getByRole('tab', { name: /^Integrations/ }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Zigbee stopped working in Home Assistant' })).toBeNull(),
    );
  });
});
