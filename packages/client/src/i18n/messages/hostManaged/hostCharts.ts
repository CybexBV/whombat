import { treeCatalogs } from '../../tree';

/** The chart axes' own words in How it’s doing (`host/model.ts`); the rest are core's `hostStatusCopy`. */
export const HOST_CHART_WORDS_TREE = treeCatalogs(
  'hostManaged.hostCharts',
  { now: 'now', today: 'today' },
  { now: 'nu', today: 'vandaag' },
);
