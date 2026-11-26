/**
 * PLACE and NEWS in Settings → This Whombat → About (app weather-news-apps.md) against fixture mode's fake place and news
 * (`placeNewsFixtures.ts`): the time zone's guess, a town looked up and kept, the news it suggests turned on, a page
 * that names no feed refused under the field.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { pinMockDate } from '../../test/clock';
import { fixtureServices, renderApp } from '../../test/renderApp';

pinMockDate();

const ABOUT = '/settings?tab=appliance&section=about';

describe('the place and the news in This Whombat', () => {
  it('keeps a town looked up instead of the guess, and suggests its region’s news', async () => {
    const user = userEvent.setup();
    renderApp(ABOUT, fixtureServices());
    const place = await screen.findByRole('region', { name: 'PLACE' });
    expect(place.getAttribute('data-place')).toBe('guessed');
    expect(within(place).getByText(/Amsterdam/)).toBeTruthy();

    await user.click(within(place).getByRole('button', { name: 'Change' }));
    expect(within(place).getByText('© OpenStreetMap')).toBeTruthy();
    await user.type(within(place).getByLabelText('Town or city'), 'Eind');
    await user.click(within(place).getByRole('button', { name: 'Search' }));
    await user.click(await within(place).findByRole('button', { name: /Eindhoven, Noord-Brabant/ }));

    await waitFor(() => expect(place.getAttribute('data-place')).toBe('chosen'));
    expect(within(place).getByText('Eindhoven, Noord-Brabant')).toBeTruthy();
    const news = screen.getByRole('region', { name: 'NEWS' });
    expect(await within(news).findByText('Suggested for Noord-Brabant')).toBeTruthy();
    expect(news.querySelector('[data-suggestion="nl-omroep-brabant"]')).toBeTruthy();
  });

  it('turns a suggested site on, and says under the field when a page names no feed', async () => {
    const user = userEvent.setup();
    renderApp(ABOUT, fixtureServices());
    const news = await screen.findByRole('region', { name: 'NEWS' });
    await user.click(await within(news).findByRole('button', { name: 'Turn on NOS Nieuws' }));
    await waitFor(() => expect(news.querySelector('[data-source="nl-nos"]')).toBeTruthy());
    expect(within(news).getByRole('button', { name: 'Turn off NOS Nieuws' })).toBeTruthy();

    await user.type(within(news).getByLabelText('Add a news site'), 'example.com');
    await user.click(within(news).getByRole('button', { name: 'Add' }));
    expect((await within(news).findByRole('alert')).textContent).toContain('feed');
  });
});
