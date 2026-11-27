/**
 * Settings → News and weather (app weather-news-apps.md) against fixture mode's fake place and news
 * (`placeNewsFixtures.ts`): the time zone's guess and a town kept instead, a suggestion turned on and moved, a source of
 * the person's own added or refused, a list imported from another reader and saved for one, *Find it again*, and what a
 * Whombat from before shows.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ownNewsSourceId } from '@whombat/core';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { pinMockDate } from '../../test/clock';
import { jsonAnswer, recordingWorld } from '../../test/recordingWorld';
import { fixtureServices, mockedServices, renderApp } from '../../test/renderApp';

pinMockDate();

const PAGE = '/settings?tab=news';
const AT5 = ownNewsSourceId('https://www.at5.nl/feeds/nieuws.xml');
const NEWS_PATH = `/burrows/${burrow.slug}/news`;

const sources = () => screen.getByRole('region', { name: 'YOUR SOURCES' });
const findMore = () => screen.getByRole('region', { name: 'FIND MORE' });
const shownIds = () =>
  [...sources().querySelectorAll('[data-source]')].map((r) => r.getAttribute('data-source'));
const sourceRow = (id: string) => sources().querySelector(`[data-source="${id}"]`) as HTMLElement;

describe('Settings → News and weather', () => {
  it('has the place, your sources and Find more under its own title', async () => {
    renderApp(PAGE, fixtureServices());
    expect(await screen.findByRole('heading', { name: 'News and weather', level: 1 })).toBeTruthy();
    const place = await screen.findByRole('region', { name: 'PLACE' });
    expect(place.getAttribute('data-place')).toBe('guessed');
    await screen.findByRole('region', { name: 'YOUR SOURCES' });
    expect(sources().querySelector('[data-news-count]')?.textContent).toBe('1 of 30');
    expect(within(sourceRow(AT5)).getByText('Website · added by you')).toBeTruthy();
    expect(within(sourceRow(AT5)).getByRole('button', { name: 'Remove AT5' })).toBeTruthy();
    expect(within(findMore()).getByRole('tab', { name: 'Suggested', selected: true })).toBeTruthy();
  });

  it('keeps a town looked up instead of the guess, and suggests its region’s news first', async () => {
    const user = userEvent.setup();
    renderApp(PAGE, fixtureServices());
    const place = await screen.findByRole('region', { name: 'PLACE' });
    await user.click(within(place).getByRole('button', { name: 'Change' }));
    expect(within(place).getByText('© OpenStreetMap')).toBeTruthy();
    await user.type(within(place).getByLabelText('Town or city'), 'Eind');
    await user.click(within(place).getByRole('button', { name: 'Search' }));
    await user.click(await within(place).findByRole('button', { name: /Eindhoven, Noord-Brabant/ }));

    await waitFor(() => expect(place.getAttribute('data-place')).toBe('chosen'));
    expect(within(place).getByText('Eindhoven, Noord-Brabant')).toBeTruthy();
    await waitFor(() =>
      expect(findMore().querySelector('[data-suggestion]')?.getAttribute('data-suggestion')).toBe(
        'nl-omroep-brabant',
      ),
    );
    const brabant = findMore().querySelector('[data-suggestion="nl-omroep-brabant"]') as HTMLElement;
    expect(within(brabant).getByText('Noord-Brabant · Dutch')).toBeTruthy();
    // Near you is a chip now that a region's site is near.
    await user.click(within(findMore()).getByRole('button', { name: 'Near you' }));
    expect(findMore().querySelectorAll('[data-suggestion]').length).toBe(1);
  });

  it('turns a suggestion on last, moves it up and takes away one of the person’s own', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = recordingWorld();
    renderApp(PAGE, mockedServices(fetch));
    await screen.findByRole('region', { name: 'FIND MORE' });
    await user.click(await within(findMore()).findByRole('button', { name: 'Add NOS Nieuws' }));
    await waitFor(() => expect(shownIds()).toEqual([AT5, 'nl-nos']));
    expect(within(sourceRow('nl-nos')).getByText('Netherlands · national')).toBeTruthy();
    expect(sources().querySelector('[data-news-count]')?.textContent).toBe('2 of 30');
    await waitFor(() =>
      expect(within(findMore()).queryByRole('button', { name: 'Add NOS Nieuws' })).toBeNull(),
    );

    await user.click(within(sources()).getByRole('button', { name: 'Move NOS Nieuws up' }));
    await waitFor(() => expect(shownIds()).toEqual(['nl-nos', AT5]));
    const saves = calls.filter((c) => c.method === 'PUT' && c.path === NEWS_PATH);
    expect(saves.at(-1)?.body).toEqual({ ids: ['nl-nos', AT5] });

    await user.click(within(sources()).getByRole('button', { name: 'Remove AT5' }));
    await waitFor(() => expect(shownIds()).toEqual(['nl-nos']));
  });

  it('adds a source of the person’s own, and says under the field when a page names no feed', async () => {
    const user = userEvent.setup();
    renderApp(PAGE, fixtureServices());
    await screen.findByRole('region', { name: 'FIND MORE' });
    await user.click(within(findMore()).getByRole('tab', { name: 'Add your own' }));
    const field = within(findMore()).getByLabelText(/YouTube channel, subreddit/);
    await user.type(field, 'example.com');
    await user.click(within(findMore()).getByRole('button', { name: 'Add' }));
    expect((await within(findMore()).findByRole('alert')).textContent).toContain('feed');

    await user.clear(field);
    await user.type(field, 'reddit.com/r/selfhosted');
    await user.click(within(findMore()).getByRole('button', { name: 'Add' }));
    const id = ownNewsSourceId('https://www.reddit.com/r/selfhosted/.rss');
    await waitFor(() => expect(sourceRow(id)).toBeTruthy());
    expect(within(sourceRow(id)).getByText('Reddit · added by you')).toBeTruthy();
    expect(await screen.findByText('r/selfhosted is on.')).toBeTruthy();
  });

  it('imports another reader’s list on this device, and saves the sources as one', async () => {
    const user = userEvent.setup();
    renderApp(PAGE, fixtureServices());
    await screen.findByRole('region', { name: 'FIND MORE' });
    await user.click(within(findMore()).getByRole('tab', { name: 'Import' }));
    const opml = `<?xml version="1.0"?><opml version="2.0"><body>
      <outline text="DutchNews" xmlUrl="https://www.dutchnews.nl/feed/"/>
      <outline text="A page" xmlUrl="https://example.com/page"/>
    </body></opml>`;
    const input = findMore().querySelector('[data-news-import-file]') as HTMLInputElement;
    await user.upload(input, new File([opml], 'reader.opml', { type: 'text/x-opml' }));
    const said = await within(findMore()).findByRole('status');
    expect(said.textContent).toContain('One source added. 1 couldn’t be added.');
    expect(said.textContent).toContain('example.com');
    await waitFor(() => expect(within(sources()).getByText('DutchNews.nl')).toBeTruthy());

    const save = within(findMore()).getByRole('link', { name: 'Save as OPML' });
    expect(save.getAttribute('download')).toBe('whombat-news.opml');
    const file = decodeURIComponent(save.getAttribute('href')?.replace(/^data:[^,]*,/, '') ?? '');
    expect(file).toContain('xmlUrl="https://www.dutchnews.nl/feed/"');
    expect(file).toContain('text="AT5"');
  });

  it('says a source’s problem, and Find it again puts its address in Add your own', async () => {
    const user = userEvent.setup();
    const { fetch } = recordingWorld({}, async (call, res) => {
      if (call.method !== 'GET' || call.path !== NEWS_PATH) return res;
      const view = await res.json();
      return jsonAnswer({
        ...view,
        chosen: view.chosen.map((s: { id: string }) =>
          s.id === AT5 ? { ...s, problem: 'The site moved its feed' } : s,
        ),
      });
    });
    renderApp(PAGE, mockedServices(fetch));
    await screen.findByRole('region', { name: 'YOUR SOURCES' });
    const at5 = sourceRow(AT5);
    expect(within(at5).getByText(/The site moved its feed\./)).toBeTruthy();
    await user.click(within(at5).getByRole('button', { name: 'Find it again' }));
    expect(within(findMore()).getByRole('tab', { name: 'Add your own', selected: true })).toBeTruthy();
    const field = within(findMore()).getByLabelText(/YouTube channel, subreddit/) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe('https://www.at5.nl'));
    expect(document.activeElement).toBe(field);
  });

  it('on a Whombat from before browsing: its suggestions and Add your own, up to 12', async () => {
    const { fetch } = recordingWorld();
    renderApp(PAGE, mockedServices(fetch, { protocolMinor: 18 }));
    await screen.findByRole('region', { name: 'FIND MORE' });
    expect(sources().querySelector('[data-news-count]')?.textContent).toBe('1 of 12');
    expect(within(findMore()).queryByRole('tablist')).toBeNull();
    expect(within(findMore()).getByRole('button', { name: 'Add NOS Nieuws' })).toBeTruthy();
    expect(within(findMore()).getByLabelText(/YouTube channel, subreddit/)).toBeTruthy();
    const asked = fetch.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input));
    expect(asked.some((u) => u.includes('/news/browse'))).toBe(false);
  });

  it('isn’t offered by a Whombat from before the place and the news', async () => {
    const { fetch } = recordingWorld();
    renderApp('/settings', mockedServices(fetch, { protocolMinor: 15 }));
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    expect(document.querySelector('[data-settings-group="appliance"]')).toBeTruthy();
    expect(document.querySelector('[data-settings-group="news"]')).toBeNull();
  });

  it('opens on a Whombat from before the place and the news as Settings’ home', async () => {
    const { fetch } = recordingWorld();
    renderApp(PAGE, mockedServices(fetch, { protocolMinor: 15 }));
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'PLACE' })).toBeNull();
  });

  it('is no longer part of This Whombat → About', async () => {
    renderApp('/settings?tab=appliance&section=about', fixtureServices());
    await screen.findByRole('region', { name: 'VERSION' });
    expect(screen.queryByRole('region', { name: 'PLACE' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'YOUR SOURCES' })).toBeNull();
  });
});
