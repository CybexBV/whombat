/**
 * A search answer's turn keeps the language the search was asked in: switching languages while it waits neither makes
 * the agent answer in the new language nor dates its results in it, so the answer kept under one language is written
 * in that language.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { updatePreferences } from '../commands/account';
import { askSearch } from '../commands/content';
import { sendMessage } from '../commands/messages';
import { dispatches } from '../db/schema/index';
import { personAccountId } from '../read/principals';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { waitFor } from '../test/runner';
import { buildDispatchContext, pinnedSearchLocale } from './context';

const t = useTestServer({ seed: true });
let accountId = '';

beforeAll(async () => {
  const id = await personAccountId(t.services.db);
  if (!id) throw new Error('missing Mara account');
  accountId = id;
  const said = await t.commit(IDS.mara, sendMessage, {
    conversationId: IDS.general,
    text: 'The zebrafish ledger reconciliation finished and the quokka export went out.',
  });
  if (said.status !== 'ok') throw new Error('send failed');
});

afterEach(async () => {
  await updatePreferences(t.services, accountId, { locale: null });
});

async function ask(q: string) {
  const asked = await t.commit(IDS.mara, askSearch, { q });
  if (asked.status !== 'ok') throw new Error('ask failed');
  return asked.result.answerId;
}

async function contextOf(answerId: string) {
  const row = await waitFor(
    async () => {
      const [found] = await t.services.db
        .select()
        .from(dispatches)
        .where(sql`${dispatches.search}->>'answerId' = ${answerId}`);
      return found;
    },
    10_000,
    'the search answer’s turn',
  );
  return buildDispatchContext(t.services, row);
}

describe('a queued search answer', () => {
  it('stays English after the person switched to Dutch', async () => {
    const answerId = await ask('zebrafish ledger');
    await updatePreferences(t.services, accountId, { locale: 'nl-NL' });
    const ctx = await contextOf(answerId);
    expect(ctx.locale).toBe('en-GB');
    expect(ctx.search?.answerId).toBe(answerId);
    const hit = ctx.search?.results.find((r) => r.snippet.toLowerCase().includes('zebrafish'));
    expect(hit?.where).toContain('today');
    expect(hit?.where).not.toContain('vandaag');
  });

  it('stays Dutch after the person switched to English', async () => {
    await updatePreferences(t.services, accountId, { locale: 'nl-NL' });
    const answerId = await ask('quokka export');
    await updatePreferences(t.services, accountId, { locale: 'en-US' });
    const ctx = await contextOf(answerId);
    expect(ctx.locale).toBe('nl-NL');
    const hit = ctx.search?.results.find((r) => r.snippet.toLowerCase().includes('quokka'));
    expect(hit?.where).toContain('vandaag');
  });
});

describe('pinnedSearchLocale', () => {
  it('keeps the asked language and the person’s region when it matches', () => {
    expect(pinnedSearchLocale('en', 'nl-NL')).toBe('en-GB');
    expect(pinnedSearchLocale(null, 'nl-NL')).toBe('en-GB');
    expect(pinnedSearchLocale('nl', 'en-US')).toBe('nl-NL');
    expect(pinnedSearchLocale('nl', null)).toBe('nl-NL');
    expect(pinnedSearchLocale('en', 'en-US')).toBe('en-US');
    expect(pinnedSearchLocale(null, 'en-US')).toBe('en-US');
    expect(pinnedSearchLocale('nl', 'nl-BE')).toBe('nl-BE');
  });
});
