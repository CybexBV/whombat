/**
 * Guided setup in a person's Chat with the agent (docs/decisions/assistant-guides.md), end to end against Postgres
 * with the fake Google: the welcome (once; built from what the network scan found, first-day.md), acting on cards
 * (`guides.act`: locked, next step, closed),
 * connecting Google from a guide (the result lands in the DM), the repair message's rate limit and the suggestions'
 * rules.
 */
import { api, buildPath, type GuideCard } from '@whombat/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBurrow } from '../commands/burrows';
import { finishScanForTests } from '../connections/discover';
import { foundStateOf, tellFound } from '../connections/found-scans';
import { markNeedsReauth } from '../connectors/store';
import {
  assistantStates,
  connections,
  conversations,
  dispatches,
  messages,
  principals,
  readStates,
} from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });

/**
 * What the hosted UI does with Google's redirect (AG-14): hands its `code`, `state` and `error` over the session
 * (`connections.finishGoogle`) and goes where the answer says.
 */
async function finishGoogle(url: URL) {
  const ep = api.connections.finishGoogle;
  const param = (name: string) => url.searchParams.get(name) ?? undefined;
  const res = await t.api.inject({
    method: ep.method,
    url: `${ep.base}${ep.path}`,
    headers: { cookie: moss.maraCookie },
    payload: { state: param('state'), code: param('code'), error: param('error') },
  });
  return { status: res.statusCode, location: res.json().returnPath as string };
}

const moss = {
  burrowId: '',
  mara: '',
  maraAgent: '',
  maraDm: '',
  maraCookie: '',
};

async function accountOf(principalId: string): Promise<string> {
  const [row] = await t.services.db.select().from(principals).where(eq(principals.id, principalId));
  if (!row?.accountId) throw new Error('no account');
  return row.accountId;
}

async function dmOf(personId: string): Promise<{ agentId: string; dmId: string }> {
  const [agent] = await t.services.db
    .select()
    .from(principals)
    .where(
      and(
        eq(principals.kind, 'agent'),
        sql`${principals.burrowId} = (select p.burrow_id from principals p where p.id = ${personId})`,
      ),
    );
  if (!agent) throw new Error('no agent');
  const [dm] = await t.services.db
    .select()
    .from(conversations)
    .where(and(eq(conversations.dmAgentId, agent.id), eq(conversations.dmPersonId, personId)));
  return { agentId: agent.id, dmId: dm?.id ?? '' };
}

async function dmMessages(dmId: string) {
  return t.services.db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, dmId))
    .orderBy(asc(messages.ord));
}

async function lastCard(
  dmId: string,
): Promise<{ id: string; text: string; card: GuideCard; threadRootId: string | null }> {
  const rows = (await dmMessages(dmId)).filter((m) => m.card?.kind === 'guide');
  const row = rows.at(-1);
  if (row?.card?.kind !== 'guide') throw new Error('no guide card');
  return { id: row.id, text: row.text, card: row.card, threadRootId: row.threadRootId };
}

async function act(messageId: string, body: object, cookie = moss.maraCookie) {
  const res = await t.api.inject({
    method: 'POST',
    url: `${api.guides.act.base}${buildPath(api.guides.act.path, { burrow: 'moss-co', messageId })}`,
    headers: { cookie },
    payload: body,
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

beforeAll(async () => {
  const maraAccount = await accountOf(IDS.mara);
  const created = await createBurrow(t.services, maraAccount, 'Moss Co', { besideOwn: true });
  moss.burrowId = created.burrowId;
  moss.mara = created.principalId;
  await t.services.guides.settle();
  ({ agentId: moss.maraAgent, dmId: moss.maraDm } = await dmOf(moss.mara));
  moss.maraCookie = (await sessionFor(t.services, moss.mara)).cookie;
});

describe('the welcome (AG-04)', () => {
  it('is posted once in a new person’s empty DM, by their assistant: hello, then mail', async () => {
    const rows = await dmMessages(moss.maraDm);
    expect(rows).toHaveLength(2);
    const [hello, mail] = rows;
    expect(hello?.authorId).toBe(moss.maraAgent);
    expect(hello?.text).toMatch(/^Hi Mara, I’m \w+\./);
    expect(hello?.card).toBeNull();
    expect(mail?.card).toMatchObject({ kind: 'guide', guide: 'welcome', node: 'mail', state: 'open' });
  });
});

describe('acting on a card (AG-03)', () => {
  it('locks the card with the answer and posts the next step as the agent', async () => {
    const welcome = await lastCard(moss.maraDm);
    const res = await act(welcome.id, { actionId: 'google' });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const [locked] = await t.services.db.select().from(messages).where(eq(messages.id, welcome.id));
    expect(locked?.card).toMatchObject({
      state: 'done',
      answer: { actionId: 'google', optionIds: null, label: 'Gmail or Google Workspace' },
    });
    const next = await lastCard(moss.maraDm);
    expect(next.card).toMatchObject({ guide: 'email', node: 'connect', state: 'open' });
    // In a thread under the welcome card, not at the top of the Chat.
    expect(next.threadRootId).toBe(welcome.id);
    const rows = await dmMessages(moss.maraDm);
    expect(rows.at(-1)?.authorId).toBe(moss.maraAgent);
    // Nobody was woken.
    expect(
      await t.services.db.select().from(dispatches).where(eq(dispatches.agentId, moss.maraAgent)),
    ).toEqual([]);
  });

  it('a second answer gets guide_closed', async () => {
    const [, welcome] = await dmMessages(moss.maraDm);
    const res = await act(welcome?.id ?? '', { actionId: 'google' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'conflict', details: { code: 'guide_closed' } });
  });
});

describe('connecting Google from a guide (AG-05, AG-08)', () => {
  it('lands the result in the card’s thread and locks the connect card', async () => {
    const connect = await lastCard(moss.maraDm);
    const block = connect.card.blocks.find((b) => b.type === 'connect');
    if (block?.type !== 'connect') throw new Error('no connect block');
    // Back to the Chat with the card's thread open.
    const url0 = new URL(block.returnTo, 'http://x');
    expect(url0.pathname).toBe('/moss-co/chat');
    expect(url0.searchParams.get('thread')).toBe(connect.threadRootId);
    expect(url0.searchParams.get('guide')).toBe(connect.id);
    expect(block.services[0]).toBe('mail');

    const start = await t.api.inject({
      method: 'POST',
      url: `${api.connections.startGoogle.base}${api.connections.startGoogle.path}`,
      headers: { cookie: moss.maraCookie },
      payload: { services: block.services, returnTo: block.returnTo },
    });
    expect(start.statusCode).toBe(200);
    const url = new URL(start.json().authorizeUrl);
    const back = await finishGoogle(url);
    expect(back.status).toBe(200);
    expect(back.location).toBe(`${block.returnTo}&connected=google`);

    const rows = await dmMessages(moss.maraDm);
    const [locked] = await t.services.db.select().from(messages).where(eq(messages.id, connect.id));
    expect(locked?.card).toMatchObject({ state: 'done', answer: { actionId: 'connect' } });
    const result = rows.find((m) => m.card?.kind === 'guide' && m.card.node === 'result');
    expect(result?.card).toMatchObject({
      title: expect.stringMatching(/^Google connected · /),
      state: 'done',
    });
    expect(result?.text).toMatch(/^Done\. I can now read your email and draft replies/);
    expect(result?.threadRootId).toBe(connect.threadRootId);
  });

  it('a failed sign-in explains itself with a new connect card', async () => {
    const before = (await dmMessages(moss.maraDm)).length;
    const returnTo = '/moss-co/chat?guide=msg_nothere1';
    const start = await t.api.inject({
      method: 'POST',
      url: `${api.connections.startGoogle.base}${api.connections.startGoogle.path}`,
      headers: { cookie: moss.maraCookie },
      payload: { services: ['calendar'], returnTo },
    });
    const url = new URL(start.json().authorizeUrl);
    url.searchParams.delete('code');
    url.searchParams.set('error', 'access_denied');
    const back = await finishGoogle(url);
    expect(back.location).toContain('connect_error=access_denied');
    const rows = await dmMessages(moss.maraDm);
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)?.text).toBe(
      'Google didn’t connect: access wasn’t allowed. Try again and choose Allow.',
    );
    expect(rows.at(-1)?.card).toMatchObject({
      node: 'retry',
      blocks: [{ type: 'connect', services: ['calendar'] }],
    });
    // The same redirect handed over again says nothing more in the DM.
    await finishGoogle(url);
    expect(await dmMessages(moss.maraDm)).toHaveLength(before + 1);
    // The new card isn't needed: answer it away so the suggestions below see no open card.
    await t.services.db
      .update(messages)
      .set({ card: { ...(rows.at(-1)?.card as GuideCard), state: 'expired' } })
      .where(eq(messages.id, rows.at(-1)?.id ?? ''));
  });

  it('an expired sign-in explains itself once, not on every reload', async () => {
    const before = (await dmMessages(moss.maraDm)).length;
    // A card posted before the Chat had its own address comes back to the Chat, with its thread open.
    const returnTo = `/moss-co/dm/${await dmHandle()}?guide=msg_nothere2`;
    const start = await t.api.inject({
      method: 'POST',
      url: `${api.connections.startGoogle.base}${api.connections.startGoogle.path}`,
      headers: { cookie: moss.maraCookie },
      payload: { services: ['calendar'], returnTo },
    });
    const url = new URL(start.json().authorizeUrl);
    const original = t.services.clock;
    t.services.clock = () => new Date(Date.now() + 11 * 60_000);
    try {
      for (let i = 0; i < 3; i++) {
        const back = await finishGoogle(url);
        expect(back.location).toBe(
          '/moss-co/chat?guide=msg_nothere2&thread=msg_nothere2&connect_error=invalid_state',
        );
      }
    } finally {
      t.services.clock = original;
    }
    const rows = await dmMessages(moss.maraDm);
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)?.text).toBe('That sign-in expired or was already used. Try connecting again.');
    await t.services.db
      .update(messages)
      .set({ card: { ...(rows.at(-1)?.card as GuideCard), state: 'expired' } })
      .where(eq(messages.id, rows.at(-1)?.id ?? ''));
  });
});

async function dmHandle(): Promise<string | undefined> {
  const [agent] = await t.services.db.select().from(principals).where(eq(principals.id, moss.maraAgent));
  return agent?.handle;
}

describe('repair (AG-13)', () => {
  it('tells the person once per 24 hours when Google stops working', async () => {
    const [row] = await t.services.db
      .select()
      .from(connections)
      .where(eq(connections.accountId, await accountOf(IDS.mara)));
    if (!row) throw new Error('no connection');
    // It goes to the Chat of the burrow Mara was most recently active in: Moss Co, not the seeded Burrow HQ.
    await t.services.db
      .insert(readStates)
      .values({ conversationId: moss.maraDm, principalId: moss.mara, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [readStates.conversationId, readStates.principalId],
        set: { updatedAt: new Date() },
      });
    const before = (await dmMessages(moss.maraDm)).length;
    expect(await markNeedsReauth(t.services, row.id, 'revoked')).toBe(true);
    await t.services.guides.settle();
    const rows = await dmMessages(moss.maraDm);
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)?.text).toMatch(
      /^Google stopped working for me: Google signed me out of your account\./,
    );
    expect(rows.at(-1)?.card).toMatchObject({
      guide: 'repair',
      blocks: [{ type: 'connect', reconnect: true }],
    });

    await t.services.db.update(connections).set({ status: 'active' }).where(eq(connections.id, row.id));
    await markNeedsReauth(t.services, row.id, 'revoked');
    await t.services.guides.settle();
    expect(await dmMessages(moss.maraDm)).toHaveLength(before + 1);

    await t.services.db
      .update(connections)
      .set({ status: 'active', repairNotifiedAt: new Date(Date.now() - 25 * 3_600_000) })
      .where(eq(connections.id, row.id));
    await markNeedsReauth(t.services, row.id, 'revoked');
    await t.services.guides.settle();
    expect(await dmMessages(moss.maraDm)).toHaveLength(before + 2);
  });
});

describe('suggestions (AG-11)', () => {
  const day = 24 * 3_600_000;
  const t0 = new Date(Date.now() + 1000);
  const at = (days: number) => new Date(t0.getTime() + days * day);

  /** Mara read her DM at `when` (her last activity). */
  async function activeAt(when: Date) {
    await t.services.db
      .insert(readStates)
      .values({ conversationId: moss.maraDm, principalId: moss.mara, updatedAt: when })
      .onConflictDoUpdate({
        target: [readStates.conversationId, readStates.principalId],
        set: { updatedAt: when },
      });
  }

  it('respects the welcome, the 7-day spacing, Don’t ask again and suggestions off', async () => {
    // Mara's open cards (Google's repair) are answered away; she was welcomed 4 days before t0.
    await t.services.db
      .update(messages)
      .set({ card: sql`jsonb_set(${messages.card}, '{state}', '"expired"')` })
      .where(and(eq(messages.conversationId, moss.maraDm), sql`${messages.card}->>'state' = 'open'`));
    await activeAt(t0);
    expect(await t.services.guides.suggest(t0)).toBe(0); // welcomed just now
    await t.services.db
      .update(assistantStates)
      .set({ welcomedAt: at(-4) })
      .where(eq(assistantStates.personId, moss.mara));

    expect(await t.services.guides.suggest(t0)).toBe(1);
    const first = await lastCard(moss.maraDm);
    expect(first.card).toMatchObject({ guide: 'email', node: 'suggest' });
    expect(first.text).toContain('Want to connect your email?');

    // Not while it is open, and not again within 7 days.
    expect(await t.services.guides.suggest(at(1))).toBe(0);
    expect((await act(first.id, { actionId: 'never' }, moss.maraCookie)).status).toBe(200);
    expect((await dmMessages(moss.maraDm)).at(-1)?.text).toBe(
      'Okay, I won’t bring up email again. You can always ask me, or use Settings → Connections.',
    );
    await activeAt(at(6));
    expect(await t.services.guides.suggest(at(6))).toBe(0);

    // A week on: the next topic, email being in dontAsk.
    await activeAt(at(8));
    expect(await t.services.guides.suggest(at(8))).toBe(1);
    const second = await lastCard(moss.maraDm);
    expect(second.card).toMatchObject({ guide: 'calendar', node: 'suggest' });
    expect((await act(second.id, { actionId: 'later' }, moss.maraCookie)).status).toBe(200);

    // Inactive for more than 3 days: none.
    expect(await t.services.guides.suggest(at(16))).toBe(0);

    // Suggestions off (Settings → Profile).
    const off = await t.api.inject({
      method: 'PATCH',
      url: `${api.me.updatePreferences.base}${api.me.updatePreferences.path}`,
      headers: { cookie: moss.maraCookie },
      payload: { assistant: { suggestions: false, dontAsk: ['email'] } },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().assistant).toEqual({ suggestions: false, dontAsk: ['email'] });
    await activeAt(at(16));
    expect(await t.services.guides.suggest(at(16))).toBe(0);
  });

  it('expires open cards after 7 days', async () => {
    const card = await lastCard(moss.maraDm);
    await t.services.db
      .update(messages)
      .set({ card: { ...card.card, state: 'open', answer: null } })
      .where(eq(messages.id, card.id));
    expect(await t.services.guides.expireCards(at(30))).toBeGreaterThanOrEqual(1);
    const [row] = await t.services.db.select().from(messages).where(eq(messages.id, card.id));
    expect(row?.card).toMatchObject({ state: 'expired', answer: null });
  });
});

describe('the welcome from what the box found (first-day.md)', () => {
  const ha = {
    catalogId: 'homeassistant',
    host: '192.168.77.20',
    port: 8123,
    url: 'http://192.168.77.20:8123',
    version: null,
    certificate: null,
  };
  const debian = {
    catalogId: 'server',
    host: '192.168.77.30',
    port: 22,
    url: 'ssh://192.168.77.30',
    version: 'Debian',
    certificate: null,
  };

  /** A burrow of Mara's own, its Chat welcomed at the claim (no scan had finished then). */
  async function newBurrow(name: string) {
    const created = await createBurrow(t.services, await accountOf(IDS.mara), name, { besideOwn: true });
    await t.services.guides.settle();
    const { agentId, dmId } = await dmOf(created.principalId);
    return { burrowId: created.burrowId, personId: created.principalId, agentId, dmId };
  }
  const linksOf = (card: { kind: string } | null | undefined) =>
    card?.kind === 'guide'
      ? (card as GuideCard).blocks.flatMap((b) => (b.type === 'actions' ? b.actions : []))
      : [];

  it('names what a finished scan found, one button each, and claims the telling so the scan says nothing more', async () => {
    const fern = await newBurrow('Fern Co');
    // As if the Chat were new now, after the box's first scan.
    await t.services.db.delete(messages).where(eq(messages.conversationId, fern.dmId));
    await t.services.db
      .update(assistantStates)
      .set({ welcomedAt: null })
      .where(eq(assistantStates.burrowId, fern.burrowId));
    const at = t.services.clock();
    finishScanForTests(t.services, fern.burrowId, [debian, ha], at);

    expect(await t.services.guides.welcome(fern.burrowId, fern.personId)).toBe(true);
    const [found, mail] = await dmMessages(fern.dmId);
    expect(found?.authorId).toBe(fern.agentId);
    expect(found?.text).toContain('Home Assistant and a Debian server');
    expect(found?.card).toMatchObject({ guide: 'welcome', node: 'found', state: 'done' });
    expect(linksOf(found?.card).map((a) => a.href)).toEqual([
      expect.stringContaining('connection=homeassistant'),
      '/things/servers?add=1&address=192.168.77.30',
    ]);
    expect(mail?.card).toMatchObject({ node: 'mail', state: 'open' });
    expect((await foundStateOf(t.services.db, fern.burrowId)).toldAt).not.toBeNull();
    expect(await tellFound(t.services, fern.burrowId, fern.personId, { finishedAt: at, found: [ha] })).toBe(
      false,
    );
    expect(await dmMessages(fern.dmId)).toHaveLength(2);
  });

  it('with nothing found at the welcome, the scan’s finds come later as one message', async () => {
    const reed = await newBurrow('Reed Co');
    const [hello, mail] = await dmMessages(reed.dmId);
    expect(hello?.card).toBeNull();
    expect(hello?.text).not.toContain('Home Assistant');
    expect(mail?.card).toMatchObject({ node: 'mail' });

    const scan = { finishedAt: t.services.clock(), found: [ha] };
    expect(await tellFound(t.services, reed.burrowId, reed.personId, scan)).toBe(true);
    const later = (await dmMessages(reed.dmId)).at(-1);
    expect(later?.authorId).toBe(reed.agentId);
    expect(later?.text).toContain('Home Assistant');
    expect(later?.text).not.toContain('Hi Mara');
    expect(linksOf(later?.card)).toHaveLength(1);
    // Once.
    expect(await tellFound(t.services, reed.burrowId, reed.personId, scan)).toBe(false);
    expect(await dmMessages(reed.dmId)).toHaveLength(3);
  });
});
