/**
 * Search filters and paging (CT-180; docs/decisions/essentials-conversations.md EC-25, EC-26) and private channels in
 * search (EC-10): `from`, `in`, `after`, `before` (calendar days in the viewer's zone, inclusive), an empty `q` with a
 * filter, the cursor; a private channel's words are found only by its members, people and agents alike.
 */
import { api, buildPath, type SearchResponse } from '@whombat/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { loadBurrowRow } from '../commit/pipeline';
import { grants } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { chatWith, makeRoom } from '../test/rooms';
import { sessionFor } from '../test/tokens';
import { loadPrincipalRow } from './principals';
import { search } from './search';

const t = useTestServer({ seed: true, app: true });
const cookies: Record<string, string> = {};
const WORD = 'quokkafilter';

async function post(authorId: string, conversationId: string, text: string, at: string) {
  const res = await t.commit(authorId, sendMessage, { conversationId, text }, { now: new Date(at) });
  if (res.status !== 'ok') throw new Error('send');
  return res.result.id;
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  cookies.mara = (await sessionFor(t.services, IDS.mara)).cookie;
  // Amsterdam is UTC+2: 23:30 UTC on the 19th is 01:30 on the 20th there.
  ids.late19 = await post(
    IDS.mara,
    IDS.general,
    `${WORD} late on the 19th (UTC)`,
    '2026-09-19T23:30:00.000Z',
  );
  ids.dusty20 = await post(
    IDS.dusty,
    IDS.general,
    `${WORD} from Dusty on the 20th`,
    '2026-09-20T10:00:00.000Z',
  );
  ids.mara21 = await post(
    IDS.mara,
    IDS.billing,
    `${WORD} in billing on the 21st`,
    '2026-09-21T10:00:00.000Z',
  );
  ids.mara22 = await post(IDS.mara, IDS.general, `${WORD} on the 22nd`, '2026-09-22T10:00:00.000Z');
  // A pull request's room Dusty never posted in.
  const secretRoom = await makeRoom(t.services, t.burrowId, 'secret-search');
  ids.secret = await post(IDS.mara, secretRoom, `${WORD} private words`, '2026-09-22T11:00:00.000Z');
});

async function find(who: string, query: Record<string, string | number>) {
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  const res = await t.api.inject({
    method: 'GET',
    url: `${api.search.query.base}${buildPath(api.search.query.path, { burrow: 'burrow-hq' })}?${qs}`,
    headers: { cookie: cookies[who] as string },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as SearchResponse;
}
const hits = (r: SearchResponse) => r.results.map((x) => x.id).sort();

describe('search filters', () => {
  it('filters by author, conversation and days in the viewer’s zone, with or without words', async () => {
    expect(hits(await find('mara', { q: WORD, from: 'dusty' }))).toEqual([ids.dusty20]);
    expect(hits(await find('mara', { q: WORD, in: IDS.billing }))).toEqual([ids.mara21]);
    // 01:30 on the 20th in Amsterdam: in `after=20`, not in `before=19`.
    expect(hits(await find('mara', { q: WORD, after: '2026-09-20', before: '2026-09-20' }))).toEqual(
      [ids.late19, ids.dusty20].sort(),
    );
    expect(hits(await find('mara', { q: WORD, before: '2026-09-19' }))).toEqual([]);
    expect(hits(await find('mara', { q: WORD, after: '2026-09-21', from: 'mara' }))).toEqual(
      [ids.mara21, ids.mara22, ids.secret].sort(),
    );
    // No words, only a filter: everything that matches it, newest first.
    const noWords = await find('mara', { q: '', from: 'dusty', in: IDS.general });
    expect(noWords.results.map((r) => r.id)).toContain(ids.dusty20);
    expect(hits(await find('mara', { q: '' }))).toEqual([]);
    // Someone nobody is called finds nothing.
    expect(hits(await find('mara', { q: WORD, from: 'nobody' }))).toEqual([]);
  });

  it('pages with a cursor until there is no next page', async () => {
    const first = await find('mara', { q: WORD, limit: 2 });
    expect(first.results).toHaveLength(2);
    expect(first.next).toBeTruthy();
    const second = await find('mara', { q: WORD, limit: 2, cursor: first.next as string });
    expect(second.results).toHaveLength(2);
    const third = await find('mara', { q: WORD, limit: 2, cursor: second.next as string });
    expect(third.results).toHaveLength(1);
    expect(third.next).toBeNull();
    const all = [...first.results, ...second.results, ...third.results].map((r) => r.id);
    expect(new Set(all).size).toBe(5);
  });
});

describe('rooms the agent isn’t in, in search', () => {
  it('an agent with “Search messages” finds rooms it isn’t in, and the person’s Chat (one-person.md OP-S71)', async () => {
    await t.services.db
      .insert(grants)
      .values({ agentId: IDS.dusty, burrowId: t.burrowId, keyId: 'messages.search', tier: 'can' })
      .onConflictDoUpdate({ target: [grants.agentId, grants.keyId], set: { tier: 'can' } });
    const chat = await chatWith(t.services, t.burrowId, IDS.dusty, IDS.mara);
    const own = await post(IDS.mara, chat, `${WORD} for Dusty only`, '2026-09-22T12:00:00.000Z');
    const waffle = await loadPrincipalRow(t.services.db, IDS.dusty);
    const burrow = await loadBurrowRow(t.services.db, t.burrowId);
    if (!waffle || !burrow) throw new Error('world');
    const res = await search(
      t.services.db,
      waffle,
      burrow,
      { q: WORD, type: 'all', limit: 50 },
      t.services.clock(),
    );
    const found = res.results.map((r) => r.id);
    // A pull request's room Dusty never posted in: found (one-agent.md OA-S50). Mara's Chat too: it's all hers.
    expect(found).toContain(ids.secret);
    expect(found).toContain(own);
  });
});
