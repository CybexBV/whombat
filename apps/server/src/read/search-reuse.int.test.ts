/**
 * Search answers reused (docs/decisions/review-features.md RF-08; report C1): the same words, case and spacing aside,
 * asked again within the reuse window get the answer on its way or given, and nobody is woken again; a failed answer
 * and an older one ask again. The search finds its answer on record the same way.
 */
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { askSearch } from '../commands/content';
import { loadBurrowRow } from '../commit/pipeline';
import { dispatches, searchAnswers } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { loadPrincipalRow } from './principals';
import { SEARCH_ANSWER_REUSE_MS, search } from './search';

const t = useTestServer({ seed: true });

async function ask(who: string, q: string): Promise<string> {
  const res = await t.commit(who, askSearch, { q });
  if (res.status !== 'ok') throw new Error('ask failed');
  return res.result.answerId;
}

async function searchDispatches() {
  return t.services.db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.burrowId, t.burrowId), eq(dispatches.trigger, 'search')));
}

beforeAll(async () => {
  // Nothing claims the turns here: the queue is what is counted.
  Object.assign(t.services.runtime.options, { pollMs: 20 });
});

describe('asking the same words again', () => {
  it('reuses the answer for the same person, case and spacing aside, and wakes nobody again', async () => {
    const first = await ask(IDS.mara, 'Rounding  VAT on refunds?');
    const turns = (await searchDispatches()).length;
    expect(await ask(IDS.mara, '  rounding vat ON refunds?')).toBe(first);
    expect(await ask(IDS.mara, 'Rounding VAT on refunds?')).toBe(first);
    expect(await searchDispatches()).toHaveLength(turns);
    // Other words are another question.
    expect(await ask(IDS.mara, 'Rounding VAT on refunds')).not.toBe(first);
  });

  it('asks again after a failed answer and after the reuse window', async () => {
    const failed = await ask(IDS.mara, 'who broke staging');
    await t.services.db.update(searchAnswers).set({ status: 'failed' }).where(eq(searchAnswers.id, failed));
    const again = await ask(IDS.mara, 'Who broke staging');
    expect(again).not.toBe(failed);
    await t.services.db
      .update(searchAnswers)
      .set({ status: 'ready', createdAt: new Date(Date.now() - SEARCH_ANSWER_REUSE_MS - 60_000) })
      .where(eq(searchAnswers.id, again));
    expect(await ask(IDS.mara, 'who broke staging')).not.toBe(again);
  });

  it('the search shows the answer on record for the same words, however they are spelled', async () => {
    const asked = await ask(IDS.mara, 'Invoice PDF cache');
    const viewer = await loadPrincipalRow(t.services.db, IDS.mara);
    const burrow = await loadBurrowRow(t.services.db, t.burrowId);
    if (!viewer || !burrow) throw new Error('no viewer');
    const found = await search(
      t.services.db,
      viewer,
      burrow,
      { q: 'invoice   pdf CACHE', type: 'all', limit: 5 },
      new Date(),
    );
    expect(found.answer?.id).toBe(asked);
  });
});
