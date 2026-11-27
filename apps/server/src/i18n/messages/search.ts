/** Search's own words: when a hit was written (`read/search.ts`). */
import { splitPairs } from './pairs';

export const SEARCH = splitPairs({
  'search.todayAt': ['today {time}', 'vandaag {time}'],
  'search.yesterdayAt': ['yesterday {time}', 'gisteren {time}'],
});
