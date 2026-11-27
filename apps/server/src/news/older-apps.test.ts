/**
 * An app before more news (docs/decisions/weather-news.md): it is shown the first twelve sources, its saved list keeps
 * the ones it couldn't see, and it can't add a thirteenth. A newer app, the assistant and anything outside a session
 * get everything.
 */
import { NEWS_SOURCES_MAX, NEWS_SOURCES_MAX_BEFORE_MORE, type NewsSourcesView } from '@whombat/core';
import { NEWS_MORE_MINOR } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import {
  addSiteResultFor,
  newsSourcesMaxFor,
  newsSourcesShownTo,
  newsViewFor,
  withUnseenSources,
} from './older-apps';

const OLD = NEWS_MORE_MINOR - 1;
const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i + 1}`);
const view = (n: number) =>
  ({
    chosen: ids(n).map((id) => ({ id, name: id, url: `https://${id}.example.com/feed`, own: true })),
    suggestions: [],
  }) as unknown as NewsSourcesView;

describe('the news for an app before more news', () => {
  it('shows an older app the first twelve sources and lets it have twelve, a newer one all of them', () => {
    expect(newsViewFor(view(15), OLD).chosen.map((s) => s.id)).toEqual(ids(NEWS_SOURCES_MAX_BEFORE_MORE));
    for (const minor of [NEWS_MORE_MINOR, undefined]) {
      expect(newsViewFor(view(15), minor).chosen).toHaveLength(15);
      expect(newsSourcesMaxFor(minor)).toBe(NEWS_SOURCES_MAX);
      expect(newsSourcesShownTo(minor)).toBeUndefined();
    }
    expect(newsViewFor(view(5), OLD).chosen).toHaveLength(5);
    expect(newsSourcesMaxFor(OLD)).toBe(NEWS_SOURCES_MAX_BEFORE_MORE);
    expect(newsSourcesShownTo(OLD)).toBe(NEWS_SOURCES_MAX_BEFORE_MORE);
    const added = addSiteResultFor({ added: view(1).chosen[0], news: view(14) } as never, OLD);
    expect([added.added.id, added.news.chosen.length]).toEqual(['s1', NEWS_SOURCES_MAX_BEFORE_MORE]);
  });

  it('keeps the sources an older app couldn’t see after its list, unless it names them', () => {
    const on = ids(15).map((id) => ({ id }));
    const shown = NEWS_SOURCES_MAX_BEFORE_MORE;
    // It turned one of its twelve off.
    expect(withUnseenSources(ids(11), on, shown)).toEqual([...ids(11), 's13', 's14', 's15']);
    // It reordered its twelve and added one it found among the suggestions.
    const reordered = ['s2', 's1', ...ids(12).slice(2), 'new'];
    expect(withUnseenSources(reordered, on, shown)).toEqual([...reordered, 's13', 's14', 's15']);
    // A hidden one it names keeps its place in the app's list and isn't kept twice.
    expect(withUnseenSources(['s14', 's1'], on, shown)).toEqual(['s14', 's1', 's13', 's15']);
    // A newer app's list is the list.
    expect(withUnseenSources(ids(3), on, undefined)).toEqual(ids(3));
  });
});
