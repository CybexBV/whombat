/**
 * Search answers reused (docs/decisions/review-features.md RF-08; report C1): the same words, case and spacing aside,
 * asked again within the reuse window get the answer on its way or given, and nobody is woken again; a failed answer
 * and an older one ask again. The search finds its answer on record the same way.
 */
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { updatePreferences } from '../commands/account';
import { deliverAnswer } from '../commands/agent-tools';
import { askSearch } from '../commands/content';
import { loadBurrowRow } from '../commit/pipeline';
import { dispatches, searchAnswers } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { loadPrincipalRow, personAccountId } from './principals';
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

describe('switching language', () => {
  async function onRecord(q: string, locale: string) {
    const viewer = await loadPrincipalRow(t.services.db, IDS.mara);
    const burrow = await loadBurrowRow(t.services.db, t.burrowId);
    if (!viewer || !burrow) throw new Error('no viewer');
    const found = await search(
      t.services.db,
      viewer,
      burrow,
      { q, type: 'all', limit: 5, locale },
      new Date(),
    );
    return found.answer?.id ?? null;
  }

  async function withLocale<T>(locale: string, run: () => Promise<T>): Promise<T> {
    const accountId = await personAccountId(t.services.db);
    if (!accountId) throw new Error('no account');
    await updatePreferences(t.services, accountId, { locale });
    try {
      return await run();
    } finally {
      await updatePreferences(t.services, accountId, { locale: null });
    }
  }

  it('keeps an answer on its way: it still finishes, and the new language asks again', async () => {
    const english = await ask(IDS.mara, 'Backup window tonight');
    const dutch = await withLocale('nl-NL', async () => {
      const again = await ask(IDS.mara, 'Backup window tonight');
      expect(await onRecord('Backup window tonight', 'nl-NL')).toBe(again);
      return again;
    });
    expect(dutch).not.toBe(english);
    // The English answer was kept, and its turn can still deliver it.
    const delivered = await t.commit(IDS.dusty, deliverAnswer, {
      answerId: english,
      text: 'Tonight at two [1].',
      citations: [{ n: 1, resultId: 'hist_thread-credit-note' }],
      actions: [],
    });
    expect(delivered.status).toBe('ok');
    const [row] = await t.services.db.select().from(searchAnswers).where(eq(searchAnswers.id, english));
    expect(row?.status).toBe('ready');
    expect(row?.language).toBe('en');
  });

  it('keeps a given answer for its own language and doesn’t show it in the other', async () => {
    const english = await ask(IDS.mara, 'Who owns the VPN');
    await t.services.db
      .update(searchAnswers)
      .set({ status: 'ready', text: 'Sam.' })
      .where(eq(searchAnswers.id, english));
    await withLocale('nl-NL', async () => {
      expect(await onRecord('Who owns the VPN', 'nl-NL')).toBeNull();
      expect(await ask(IDS.mara, 'who owns the vpn')).not.toBe(english);
    });
    // Back in English, the English answer is the answer again and nobody is asked twice.
    expect(await onRecord('Who owns the VPN', 'en-GB')).toBe(english);
    expect(await ask(IDS.mara, 'Who owns the VPN')).toBe(english);
  });
});
