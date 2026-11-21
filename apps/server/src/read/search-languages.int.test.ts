/**
 * Search across languages and an agent's own past (docs/decisions/resourceful-agents.md RA-26, RA-DS20, RA-DS21):
 * words match as written as well as by their English stems, so a Dutch word finds Dutch and English still finds what it
 * found; `search` with `mine: true` finds only the agent's own earlier messages and runs, within its audience.
 */
import { api, buildPath, type SearchResponse } from '@whombat/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
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
