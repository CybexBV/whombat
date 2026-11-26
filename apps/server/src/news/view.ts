/**
 * The news as Settings and the screens read it (docs/decisions/weather-news.md): `news.sources` (the sites on, each
 * one's last problem, and the suggestions for the place that aren't on) and the `news` widget's `list` view (the
 * headline, its site and its time). Never private on a locked screen: headlines are public.
 */
import {
  DESK_SCREEN_WORDS,
  DESK_VIEW_ROWS_MAX,
  NEWS_WORDS,
  type NewsHeadline,
  type NewsSource,
  type NewsSourcesView,
  newsSuggestion,
  newsSuggestionsFor,
  type PlaceInput,
} from '@whombat/core';
import { screenText } from '../desk/glance';
import { clockIn } from '../desk/widgets/own';
import type { Resolved } from '../desk/widgets/types';
import { placeOfBurrow } from '../place/store';
import { newsSourcesOf } from './commands';
import type { NewsReader } from './reader';

/** The widget is drawn again this often; each site is read only every 15 minutes (`NewsReader`). */
export const NEWS_REFRESH_S = 60;

/** `news.sources` for a burrow row. */
export function newsSourcesView(
  reader: Pick<NewsReader, 'problemOf'>,
  burrow: { news: { sources: NewsSource[] } | null; place: PlaceInput | null; timeZone: string },
): NewsSourcesView {
  const place = placeOfBurrow(burrow);
  const chosen = newsSourcesOf(burrow);
  const on = new Set(chosen.map((s) => s.id));
  return {
    place,
    chosen: chosen.map((s) => {
      const problem = reader.problemOf(s.url);
      return { ...s, own: !newsSuggestion(s.id), ...(problem ? { problem } : {}) };
    }),
    suggestions: newsSuggestionsFor(place).filter((s) => !on.has(s.id)),
  };
}

/** What the `news` widget reads: the sites on and the headlines read, and whether any site could be read. */
export interface NewsRead {
  sources: number;
  headlines: NewsHeadline[];
  anyRead: boolean;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();
/** “14:05” today, else “Tue”, in the Whombat's zone. */
function whenText(at: Date, now: Date, timeZone: string): string {
  let f = dayFormats.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      f = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    }
    dayFormats.set(timeZone, f);
  }
  if (f.format(at) === f.format(now)) return clockIn(at, timeZone);
  try {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone }).format(at);
  } catch {
    return at.toUTCString().slice(0, 3);
  }
}

/** The `news` widget's view: the newest headlines, each with its site and time. */
export function newsDeskView(id: string, read: NewsRead | null, now: Date, timeZone: string): Resolved {
  const base = { kind: 'list' as const, id, title: DESK_SCREEN_WORDS.own.news.name };
  if (!read || read.sources === 0)
    return {
      view: { ...base, rows: [], empty: NEWS_WORDS.widgetEmpty },
      private: false,
      refreshS: NEWS_REFRESH_S,
    };
  if (!read.anyRead && read.headlines.length === 0)
    return {
      view: { ...base, rows: [], tone: 'off', problem: { text: NEWS_WORDS.widgetProblem } },
      private: false,
      refreshS: NEWS_REFRESH_S,
    };
  const rows = read.headlines.slice(0, DESK_VIEW_ROWS_MAX).flatMap((h) => {
    const title = screenText(h.title, 120);
    if (!title) return [];
    return [
      {
        title,
        detail: screenText(h.source, 120),
        time: whenText(new Date(h.at), now, timeZone),
      },
    ];
  });
  return {
    view: {
      ...base,
      rows,
      ...(read.headlines.length > rows.length ? { count: read.headlines.length } : {}),
    },
    private: false,
    refreshS: NEWS_REFRESH_S,
  };
}
