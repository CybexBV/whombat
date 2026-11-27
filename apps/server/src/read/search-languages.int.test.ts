/**
 * Search across languages and an agent's own past (docs/decisions/resourceful-agents.md RA-26, RA-DS20, RA-DS21):
 * words match as written as well as by their English stems, so a Dutch word finds Dutch and English still finds what it
 * found; `search` with `mine: true` finds only the agent's own earlier messages and runs, within its audience.
 */
import { api, buildPath, type SearchResponse } from '@whombat/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { updatePreferences } from '../commands/account';
import { sendMessage } from '../commands/messages';
import { personAccountId } from '../read/principals';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { agentTokenFor, sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, listen: true });
const ids: Record<string, string> = {};
const clients: TestMcp[] = [];
let cookie = '';

async function post(authorId: string, conversationId: string, text: string) {
  const res = await t.commit(authorId, sendMessage, { conversationId, text });
  if (res.status !== 'ok') throw new Error('send');
  return res.result.id;
}

beforeAll(async () => {
  cookie = (await sessionFor(t.services, IDS.mara)).cookie;
  ids.dutch = await post(IDS.mara, IDS.general, 'De facturen voor klant Jansen zijn eindelijk betaald.');
  ids.english = await post(IDS.mara, IDS.general, 'The staging deploys kept failing overnight.');
  ids.dustyGeneral = await post(IDS.dusty, IDS.general, 'I restored the zebrafish backup on staging.');
  ids.mara = await post(IDS.mara, IDS.general, 'Plan for the zebrafish backup restore.');
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
});

async function find(q: string) {
  const res = await t.api.inject({
    method: 'GET',
    url: `${api.search.query.base}${buildPath(api.search.query.path, { burrow: 'burrow-hq' })}?q=${encodeURIComponent(q)}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as SearchResponse).results.map((r) => r.id);
}

describe('search across languages', () => {
  it('finds Dutch words as written', async () => {
    expect(await find('facturen')).toContain(ids.dutch);
    expect(await find('Jansen betaald')).toContain(ids.dutch);
    expect(await find('"klant Jansen"')).toContain(ids.dutch);
  });

  it('still finds English by its stems, and a question’s stopwords don’t find everything', async () => {
    expect(await find('deploy failed')).toContain(ids.english);
    expect(await find('what about the deploys')).toContain(ids.english);
    // “the” is in most messages: only “factuur” counts, and no message has it as written.
    const the = await find('the factuur');
    expect(the).not.toContain(ids.english);
    expect(the).not.toContain(ids.mara);
  });

  it('filters Dutch stopwords on Dutch accounts without stripping English words on English accounts', async () => {
    const wantMsg = await post(IDS.mara, IDS.general, 'We want faster nightly backups.');
    const anderMsg = await post(IDS.mara, IDS.general, 'Ander werk eerst, de printer kan wachten.');
    // On an English account, “want” (a Dutch stopword) still finds the English message.
    expect(await find('want')).toContain(wantMsg);
    // Switch Mara to Dutch: “de” and “van” are filtered as Dutch stopwords so “de onbekendwoord” doesn't match Dutch “De facturen…”.
    const maraAccountId = await personAccountId(t.services.db);
    if (!maraAccountId) throw new Error('missing Mara account');
    await updatePreferences(t.services, maraAccountId, { locale: 'nl-NL' });
    try {
      const res = await t.api.inject({
        method: 'GET',
        url: `${api.search.query.base}${buildPath(api.search.query.path, { burrow: 'burrow-hq' })}?q=${encodeURIComponent('de onbekendwoord')}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as SearchResponse;
      expect(body.results.map((r) => r.id)).not.toContain(ids.dutch);
      // “andere” is a Dutch stopword: it goes before the English stemmer would make it “ander” and find other words.
      const andere = await t.api.inject({
        method: 'GET',
        url: `${api.search.query.base}${buildPath(api.search.query.path, { burrow: 'burrow-hq' })}?q=${encodeURIComponent('andere onbekendwoord')}`,
        headers: { cookie },
      });
      expect((andere.json() as SearchResponse).results.map((r) => r.id)).not.toContain(anderMsg);
      // Dutch word still matches and `where` uses Dutch “vandaag”.
      const hitRes = await t.api.inject({
        method: 'GET',
        url: `${api.search.query.base}${buildPath(api.search.query.path, { burrow: 'burrow-hq' })}?q=${encodeURIComponent('facturen')}`,
        headers: { cookie },
      });
      const hitBody = hitRes.json() as SearchResponse;
      expect(hitBody.results.find((r) => r.id === ids.dutch)?.where).toContain('vandaag');
    } finally {
      await updatePreferences(t.services, maraAccountId, { locale: null });
    }
  });
});

describe('search with mine', () => {
  it('finds only the agent’s own messages, still within its audience', async () => {
    const { token } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.general);
    const mcp = await mcpClient(t.baseUrl, token);
    clients.push(mcp);
    const all = await mcp.call('search', { query: 'zebrafish backup' });
    expect(all.body.status).toBe('ok');
    const allIds = (all.body.results as { id: string }[]).map((r) => r.id);
    expect(allIds).toEqual(expect.arrayContaining([ids.dustyGeneral, ids.mara]));
    const mine = await mcp.call('search', { query: 'zebrafish backup', mine: true });
    const mineIds = (mine.body.results as { id: string; authorId: string }[]).map((r) => r.id);
    expect(mineIds).toContain(ids.dustyGeneral);
    expect(mineIds).not.toContain(ids.mara);
    for (const r of mine.body.results as { authorId: string }[]) expect(r.authorId).toBe(IDS.dusty);
  });
});
