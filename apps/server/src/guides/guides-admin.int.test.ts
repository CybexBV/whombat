/**
 * The Google side of guided setup against Postgres, with Google “real” but not set up (docs/decisions/
 * assistant-guides.md AG-06, AG-03): the person sets the app up in chat through the secure form — whose values appear in
 * no message, event, outbox row or log.
 */
import { api, buildPath, type GuideCard } from '@whombat/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBurrow } from '../commands/burrows';
import { connectorApps, conversations, messages, principals } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import type { Logger } from '../services';
import { BUSY_POOL_SIZE } from '../test/db';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { startGuide } from './commands';

const t = useTestServer({ seed: true, app: true, env: { WHOMBAT_GOOGLE: 'real' }, poolSize: BUSY_POOL_SIZE });

interface Person {
  id: string;
  agentId: string;
  dmId: string;
  cookie: string;
}
const moss = { burrowId: '' };
let mara: Person;

const SECRET = 'GOCSPX-supersecret-in-chat';

async function accountOf(principalId: string): Promise<string> {
  const [row] = await t.services.db.select().from(principals).where(eq(principals.id, principalId));
  if (!row?.accountId) throw new Error('no account');
  return row.accountId;
}

async function personOf(seedId: string): Promise<Person> {
  const accountId = await accountOf(seedId);
  const [person] = await t.services.db
    .select()
    .from(principals)
    .where(and(eq(principals.burrowId, moss.burrowId), eq(principals.accountId, accountId)));
  if (!person) throw new Error('not in burrow');
  const [agent] = await t.services.db
    .select()
    .from(principals)
    .where(
      and(
        eq(principals.kind, 'agent'),
        sql`${principals.burrowId} = (select p.burrow_id from principals p where p.id = ${person.id})`,
      ),
    );
  const [dm] = await t.services.db
    .select()
    .from(conversations)
    .where(and(eq(conversations.dmAgentId, agent?.id ?? ''), eq(conversations.dmPersonId, person.id)));
  return {
    id: person.id,
    agentId: agent?.id ?? '',
    dmId: dm?.id ?? '',
    cookie: (await sessionFor(t.services, person.id)).cookie,
  };
}

async function dmMessages(p: Person) {
  return t.services.db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, p.dmId))
    .orderBy(asc(messages.ord));
}

async function lastCard(p: Person): Promise<{ id: string; card: GuideCard }> {
  const row = (await dmMessages(p)).filter((m) => m.card?.kind === 'guide').at(-1);
  if (row?.card?.kind !== 'guide') throw new Error('no guide card');
  return { id: row.id, card: row.card };
}

async function act(p: Person, messageId: string, body: object) {
  const res = await t.api.inject({
    method: 'POST',
    url: `${api.guides.act.base}${buildPath(api.guides.act.path, { burrow: 'moss-co', messageId })}`,
    headers: { cookie: p.cookie },
    payload: body,
  });
  return { status: res.statusCode, body: res.json() as { ok?: true; error?: Record<string, unknown> } };
}

async function ok(p: Person, body: object) {
  const res = await act(p, (await lastCard(p)).id, body);
  expect(res).toEqual({ status: 200, body: { ok: true } });
}

beforeAll(async () => {
  const created = await createBurrow(t.services, await accountOf(IDS.mara), 'Moss Co', { besideOwn: true });
  moss.burrowId = created.burrowId;
  await t.services.guides.settle();
  mara = await personOf(IDS.mara);
});

describe('the person sets Google up in chat (AG-06)', () => {
  it('walks the steps from the start to the form', async () => {
    const started = await t.services.pipeline.commit(
      startGuide,
      { topic: 'email' },
      { burrowId: moss.burrowId, actorId: mara.agentId, onBehalfOf: { principalId: mara.id } },
    );
    expect(started.status).toBe('ok');
    await ok(mara, { actionId: 'provider', optionIds: ['google'] });
    expect((await lastCard(mara)).card.node).toBe('intro.email');
    await ok(mara, { actionId: 'audience', optionIds: ['external'] });
    for (let step = 1; step <= 4; step++) {
      expect((await lastCard(mara)).card.step).toEqual({ index: step, total: 6 });
      await ok(mara, { actionId: 'next' });
    }
    expect((await lastCard(mara)).card).toMatchObject({ node: 'step_5.external.email', state: 'open' });
    // The whole walk stays in one thread, under the guide's first card.
    const first = started.status === 'ok' ? started.result.messageId : '';
    const rows = await dmMessages(mara);
    const after = rows.slice(rows.findIndex((m) => m.id === first) + 1);
    expect(after.length).toBeGreaterThan(5);
    expect(after.every((m) => m.threadRootId === first)).toBe(true);
  });

  it('refuses bad values by field, keeping the card open', async () => {
    const five = await lastCard(mara);
    const missing = await act(mara, five.id, { actionId: 'app', values: { clientSecret: SECRET } });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({
      code: 'validation_failed',
      details: { code: 'invalid_values' },
      fields: { clientId: ['Paste the Client ID from Google.'] },
    });
    const desktop = await act(mara, five.id, {
      actionId: 'app',
      values: { clientJson: JSON.stringify({ installed: { client_id: 'x', client_secret: SECRET } }) },
    });
    expect(desktop.body.error).toMatchObject({
      details: { code: 'invalid_values' },
      fields: { clientJson: ['This is a Desktop app client. Create one of type Web application.'] },
    });
    expect(JSON.stringify([missing.body, desktop.body])).not.toContain(SECRET);
    expect((await lastCard(mara)).card.state).toBe('open');
  });

  it('refuses a client set in config', async () => {
    const config = t.services.config as {
      WHOMBAT_GOOGLE_CLIENT_ID?: string;
      WHOMBAT_GOOGLE_CLIENT_SECRET?: string;
    };
    config.WHOMBAT_GOOGLE_CLIENT_ID = 'config-client.apps.googleusercontent.com';
    config.WHOMBAT_GOOGLE_CLIENT_SECRET = 'GOCSPX-config';
    try {
      const inConfig = await act(mara, (await lastCard(mara)).id, {
        actionId: 'app',
        values: { clientId: '1234567890-abc.apps.googleusercontent.com', clientSecret: SECRET },
      });
      expect(inConfig.status).toBe(409);
      expect(inConfig.body.error).toMatchObject({
        code: 'conflict',
        details: { code: 'google_app_in_config' },
      });
    } finally {
      config.WHOMBAT_GOOGLE_CLIENT_ID = undefined;
      config.WHOMBAT_GOOGLE_CLIENT_SECRET = undefined;
    }
  });

  it('saves the client from the form; the secret is in no message, event, outbox row or log', async () => {
    const lines: string[] = [];
    const log = t.services.log;
    const capture = (level: string) => (obj: unknown, msg?: string) => {
      lines.push(`${level} ${msg ?? ''} ${JSON.stringify(obj)}`);
    };
    t.services.log = {
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
      debug: capture('debug'),
    } as Logger;
    try {
      const five = await lastCard(mara);
      const res = await act(mara, five.id, {
        actionId: 'app',
        values: { clientId: '1234567890-abc.apps.googleusercontent.com', clientSecret: SECRET },
      });
      expect(res).toEqual({ status: 200, body: { ok: true } });
      await t.services.guides.settle();
    } finally {
      t.services.log = log;
    }
    const [app] = await t.services.db.select().from(connectorApps);
    expect(app).toMatchObject({
      clientId: '1234567890-abc.apps.googleusercontent.com',
      userType: 'external',
    });
    expect(app?.clientSecretEnc).not.toContain(SECRET);

    const five = (await dmMessages(mara)).find(
      (m) => m.card?.kind === 'guide' && m.card.node === 'step_5.external.email',
    );
    expect(five?.card).toMatchObject({
      state: 'done',
      answer: { actionId: 'app', label: 'Client ID 1234567890-a… saved' },
    });
    const six = await lastCard(mara);
    expect(six.card).toMatchObject({
      node: 'step_6.external.email',
      step: { index: 6, total: 6 },
      title: 'Test it',
    });
    expect((await dmMessages(mara)).at(-1)?.text).toBe(
      'Saved. Now connect your own Google account to test it.',
    );

    const like = `%${SECRET}%`;
    const found = await t.services.db.execute(sql`
      select 'message' as what from messages where text like ${like} or card::text like ${like}
      union all select 'event' from events where coalesce(text, '') like ${like} or payload::text like ${like}
      union all select 'outbox' from outbox where event::text like ${like}`);
    expect([...found]).toEqual([]);
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain('supersecret');
  });
});

describe('a guide asked for in a thread (connect-in-chat.md)', () => {
  it('starts in the turn’s thread of the person’s Chat, and only there', async () => {
    const root = (await dmMessages(mara)).find((m) => !m.threadRootId);
    if (!root) throw new Error('no top-level message');
    const start = (conversationId: string) =>
      t.services.pipeline.commit(
        startGuide,
        { topic: 'calendar', conversationId, threadRootId: root.id },
        { burrowId: moss.burrowId, actorId: mara.agentId, onBehalfOf: { principalId: mara.id } },
      );
    const inChat = await start(mara.dmId);
    if (inChat.status !== 'ok') throw new Error(inChat.status);
    const [posted] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, inChat.result.messageId));
    expect(posted?.threadRootId).toBe(root.id);
    // A turn elsewhere names a thread that isn't in the Chat: the guide starts at the top of the Chat.
    const elsewhere = await start('cnv_elsewhere');
    if (elsewhere.status !== 'ok') throw new Error(elsewhere.status);
    const [top] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, elsewhere.result.messageId));
    expect(top?.threadRootId).toBeNull();
  });
});
