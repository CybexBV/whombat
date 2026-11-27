import { splitPairs } from './pairs.js';

/** What the agent's turns used (`domain/spend.ts`). */
export const SPEND = splitPairs({
  'spend.under': ['under {amount}', 'onder {amount}'],
  'spend.about': ['about {amount}', 'ongeveer {amount}'],
  'spend.tokens': ['{tokens} tokens', '{tokens} tokens'],
  'spend.week': ['This week: {summary}', 'Deze week: {summary}'],
  'spend.weekNone': ['This week: no turns', 'Deze week: geen beurten'],
});
