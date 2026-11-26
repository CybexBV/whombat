import { NEWS_SOURCES_MAX, NEWS_WORDS, placeFromTimeZone } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { ApiError } from './http/errors';
import {
  countryName,
  fieldProblem,
  newsHasRoom,
  newsIdsWith,
  newsIdsWithout,
  newsSuggestedTitle,
  placeRowText,
} from './weatherNews';
import { createFakePlaceNews } from './weatherNewsFake';

const guess = placeFromTimeZone('Europe/Amsterdam');
const eindhoven = {
  name: 'Eindhoven',
  lat: 51.44,
  lon: 5.48,
  country: 'NL',
  region: 'NL-NB',
  regionName: 'Noord-Brabant',
  guessed: false,
};

describe('the place and the news in Settings', () => {
  it('say where the Whombat is, and when it was only guessed', () => {
    expect(placeRowText(guess)).toContain('Amsterdam');
    expect(placeRowText(guess)).toContain('guessed');
    expect(placeRowText(eindhoven)).toBe('Eindhoven, Noord-Brabant');
    expect(placeRowText(null)).toBeTruthy();
  });

  it('suggest for the region when it is known, else the country', () => {
    expect(newsSuggestedTitle(eindhoven)).toContain('Noord-Brabant');
    expect(newsSuggestedTitle(guess)).toContain('Netherlands');
    expect(newsSuggestedTitle(null)).toBeNull();
    expect(countryName('BE')).toBe('Belgium');
  });

  it('turn a site on at the end and off where it is', () => {
    const view = { chosen: [{ id: 'nl-nos' }, { id: 'own-abc' }] } as never;
    expect(newsIdsWith(view, 'nl-omroep-brabant')).toEqual(['nl-nos', 'own-abc', 'nl-omroep-brabant']);
    expect(newsIdsWithout(view, 'nl-nos')).toEqual(['own-abc']);
    expect(newsHasRoom({ chosen: Array.from({ length: NEWS_SOURCES_MAX }) } as never)).toBe(false);
  });

  it('read a refusal’s words for its field only', () => {
    const refused = new ApiError(422, 'validation_failed', 'Check the fields.', {}, 'news.addSite', {
      url: [NEWS_WORDS.notFeed],
    });
    expect(fieldProblem(refused, 'url')).toBe(NEWS_WORDS.notFeed);
    expect(fieldProblem(refused, 'ids')).toBeNull();
    expect(fieldProblem(new Error('x'), 'url')).toBeNull();
  });
});

describe('the fake place and news', () => {
  it('finds towns, keeps one, and goes back to the guess', () => {
    const fake = createFakePlaceNews({ guess });
    const found = fake.call('place.find', { query: { query: 'Eind' } })?.body as {
      places: { name: string }[];
    };
    expect(found.places.map((p) => p.name)).toContain('Eindhoven');
    const near = fake.call('place.find', { query: { lat: '51.45', lon: '5.47' } })?.body as {
      places: { name: string }[];
    };
    expect(near.places[0]?.name).toBe('Eindhoven');
    fake.call('place.set', { body: { place: { ...eindhoven, guessed: undefined } } });
    expect(fake.place()).toMatchObject({ name: 'Eindhoven', guessed: false });
    expect(fake.news().suggestions[0]?.id).toBe('nl-omroep-brabant');
    fake.call('place.set', { body: { place: null } });
    expect(fake.place()).toEqual(guess);
  });

  it('turns suggestions on, adds a site by its page, and refuses one that names no feed', () => {
    const fake = createFakePlaceNews({ guess, chosen: [] });
    const on = fake.call('news.setSources', { body: { ids: ['nl-nos'] } });
    expect(on?.status).toBe(200);
    expect(fake.news().chosen.map((s) => s.id)).toEqual(['nl-nos']);
    expect(fake.news().suggestions.some((s) => s.id === 'nl-nos')).toBe(false);
    const added = fake.call('news.addSite', { body: { url: 'dutchnews.nl' } });
    expect(added?.status).toBe(200);
    expect(fake.news().chosen.map((s) => s.name)).toContain('DutchNews.nl');
    const refused = fake.call('news.addSite', { body: { url: 'example.com' } });
    expect(refused?.status).toBe(422);
    expect(JSON.stringify(refused?.body)).toContain(NEWS_WORDS.notFeed);
    expect(fake.call('news.addSite', { body: { url: 'http://dutchnews.nl' } })?.status).toBe(422);
  });
});
