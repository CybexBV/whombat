/**
 * One-time Find My watches end to end (docs/decisions/findmy-watch.md). Needs Postgres: the watch's row, its card
 * resolved on the assistant's message, the message the assistant posts in the thread when it happens, the day's end and
 * a removed connection in the background's sweep, and the card's Cancel as the person's device calls it. The assistant's
 * `findmy_watch` reads a made-up Mac; later reads are handed to the watcher. The clock is the test's; nothing sleeps.
 * Made-up names only (Mara, Ruben and Noor Visser, a Mac called Studio).
 */
import type { HostFindMyPerson } from '@whombat/core';
import { and, asc, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FindMyPeopleDeps, findMyWatchTool } from '../connections/adapters/findmy';
import type { AdapterContext } from '../connections/adapters/types';
import { catalogConnections, findMyWatches, messages } from '../db/schema/index';
import { loadMessages } from '../read/messages';
import { inProcessApi } from '../test/api';
import { IDS, useAutomationWorld } from '../test/automations';
import { insertConnection } from '../test/connections';
import { sessionFor } from '../test/tokens';
import type { HostsActor } from './client';
import { FindMyStore, findMyPersonId } from './findmy';
import { findMyWatcherFor, watchedConnections } from './findmy-watch';
import type { HostsService } from './service';
import { FakeFindMyMac } from './testing/fake-findmy';

const w = useAutomationWorld();
const api = inProcessApi(() => w.services);
const ACTOR: HostsActor = { id: IDS.dusty, name: 'Dusty for Mara', role: 'admin' };
const HOUR = 3_600_000;
let connectionId: string;
let cookie: string;

const ruben = (place: string | null, address: string | null): HostFindMyPerson => ({
  id: findMyPersonId('Ruben Visser'),
  name: 'Ruben Visser',
  place,
  address,
  when: 'Now',
  nearby: false,
  location: null,
});

/** The tool against a made-up Mac (fresh each time, so every call reads it), for `personId`'s turn. */
function tool(personId: string | null = IDS.mara, conversationId: string | null = IDS.dmDusty) {
  const fake = new FakeFindMyMac();
  const store = new FindMyStore({ now: () => w.now().getTime(), sleep: async () => {} });
  const hosts = {
    call: fake.call.bind(fake),
    fleetRaw: async () => ({ servers: [] }),
  } as unknown as HostsService;
  const deps: FindMyPeopleDeps = {
    scope: async () => ({ hosts, call: {} as never, personId, actor: () => ACTOR }),
    store: () => store,
    wait: () => new Promise<void>(() => {}),
    now: () => w.now().getTime(),
  };
  const ctx: AdapterContext = {
    baseUrl: 'whombat-hosts:',
    fields: { mac: 'studio' },
    bases: {},
    send: async () => {
      throw new Error('Find My sends nothing to its base');
    },
    call: {
      services: w.services,
      burrowId: w.burrowId,
      agentId: IDS.dusty,
      connectionId,
      callId: 'call_watch',
      conversationId,
      threadRootId: null,
      personId,
    },
  };
  const run = findMyWatchTool(deps);
  return async (args: Record<string, unknown>) => {
    const out = await run(ctx, args);
    return { isError: out.isError, body: JSON.parse(out.content) as Record<string, unknown> };
  };
}

const watches = () =>
  w.services.db
    .select()
    .from(findMyWatches)
    .where(eq(findMyWatches.burrowId, w.burrowId))
    .orderBy(asc(findMyWatches.startedAt));

const dmMessages = () =>
  w.services.db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, IDS.dmDusty), eq(messages.authorId, IDS.dusty)))
    .orderBy(asc(messages.createdAt), asc(messages.id));

/** What the assistant said under a watch's card (the clock stands still, so order can't tell). */
async function saidUnder(watch: { messageId: string | null } | undefined) {
  return (await dmMessages()).filter((m) => m.threadRootId !== null && m.threadRootId === watch?.messageId);
}

async function cardOf(messageId: string | null) {
  const [row] = await w.services.db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId ?? ''));
  if (!row) throw new Error('no card message');
  const [loaded] = await loadMessages(w.services.db, [row], IDS.mara);
  return loaded?.card;
}

beforeAll(async () => {
  cookie = (await sessionFor(w.services, IDS.mara)).cookie;
});

beforeEach(async () => {
  await w.services.db.delete(findMyWatches).where(eq(findMyWatches.burrowId, w.burrowId));
  await w.services.db
    .delete(catalogConnections)
    .where(and(eq(catalogConnections.burrowId, w.burrowId), eq(catalogConnections.catalogId, 'findmy')));
  connectionId = await insertConnection(w.services, {
    catalogId: 'findmy',
    burrowId: w.burrowId,
    signIn: 'none',
    fields: { mac: 'studio', background: 'off' },
  });
});

describe('a one-time Find My watch', () => {
  it('starts from a fresh read where someone is now, with a card in the chat', async () => {
    const before = (await dmMessages()).length;
    const { isError, body } = await tool()({ person: 'Ruben' });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ started: true, what: 'When Ruben Visser leaves Stationsplein 2, Lelystad' });
    const [row] = await watches();
    expect(row).toMatchObject({
      status: 'watching',
      change: 'leaves',
      place: 'Stationsplein 2, Lelystad',
      fromAddress: 'Stationsplein 2, Lelystad',
      connectionId,
      agentId: IDS.dusty,
    });
    expect(row?.endsAt.getTime()).toBe(w.now().getTime() + 24 * HOUR);
    const posted = await dmMessages();
    expect(posted).toHaveLength(before + 1);
    expect(posted.at(-1)?.text).toContain('Ruben Visser');
    expect(await cardOf(row?.messageId ?? null)).toMatchObject({
      kind: 'findmy_watch',
      watch: { status: 'watching', name: 'Ruben Visser' },
    });
    // The connection now reads every 5 minutes, for Ruben.
    expect((await watchedConnections(w.services.db)).get(connectionId)).toBe('Ruben Visser');
  });

  it('ends once when a read shows them on another street, saying so under its card', async () => {
    await tool()({ person: 'Ruben' });
    const watcher = findMyWatcherFor(w.services);
    await watcher.noted('studio', [ruben('Lelystad', 'Stationsplein 2, Lelystad')]);
    expect((await watches())[0]?.status).toBe('watching');
    const before = (await dmMessages()).length;
    await watcher.noted('studio', [ruben('Almere', 'Markt 1, Almere')]);
    const [row] = await watches();
    expect(row).toMatchObject({ status: 'happened', to: 'Almere', fromAddress: null, lat: null });
    const posted = await dmMessages();
    expect(posted).toHaveLength(before + 1);
    const [said] = await saidUnder(row);
    expect(said?.text).toContain('Almere');
    expect(said?.threadRootId).toBe(row?.messageId);
    expect(await cardOf(row?.messageId ?? null)).toMatchObject({ watch: { status: 'happened' } });
    // A later read says nothing more.
    await watcher.noted('studio', [ruben('Zwolle', 'Plein 3, Zwolle')]);
    expect(await dmMessages()).toHaveLength(before + 1);
  });

  it('watches for an arrival in Find My’s words, and says when someone is already there', async () => {
    const ask = tool();
    expect((await ask({ person: 'Mara', change: 'arrives', place: 'home' })).body.note).toContain('already');
    expect(await watches()).toEqual([]);
    expect((await ask({ person: 'Ruben', change: 'arrives', place: 'Home' })).body.started).toBe(true);
    await findMyWatcherFor(w.services).noted('studio', [ruben('Home', 'Kerkstraat 4, Rietveen')]);
    expect((await watches())[0]).toMatchObject({ status: 'happened', change: 'arrives' });
    expect((await saidUnder((await watches())[0]))[0]?.text).toContain('Home');
  });

  it('is cancelled with the card’s Cancel, and listed and cancelled by the assistant', async () => {
    const ask = tool();
    await ask({ person: 'Ruben' });
    const [row] = await watches();
    expect((await ask({ action: 'list' })).body.watches).toHaveLength(1);
    const cancel = () =>
      api.inject({
        method: 'POST',
        url: `/api/v1/burrows/burrow-hq/find-my/watches/${row?.id}/cancel`,
        headers: { cookie, 'content-type': 'application/json' },
        payload: {},
      });
    const first = await cancel();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: row?.id, status: 'cancelled' });
    expect((await cancel()).json()).toMatchObject({ status: 'cancelled' });
    expect(await cardOf(row?.messageId ?? null)).toMatchObject({ watch: { status: 'cancelled' } });
    expect((await ask({ action: 'list' })).body.watches).toEqual([]);

    await ask({ person: 'Ruben' });
    const second = (await watches()).at(-1);
    expect((await ask({ action: 'cancel', watchId: second?.id })).body.status).toBe('cancelled');
  });

  it('stops after a day, and when its Find My is removed, and says so', async () => {
    await tool()({ person: 'Ruben' });
    const watcher = findMyWatcherFor(w.services);
    await watcher.sweep(w.now());
    expect((await watches())[0]?.status).toBe('watching');
    await watcher.sweep(new Date(w.now().getTime() + 24 * HOUR + 1));
    expect((await watches())[0]).toMatchObject({ status: 'expired', fromAddress: null });
    expect((await saidUnder((await watches())[0]))[0]?.text).toContain('24 hours');

    await tool()({ person: 'Ruben' });
    await w.services.db.delete(catalogConnections).where(eq(catalogConnections.id, connectionId));
    await watcher.sweep(w.now());
    expect((await watches()).at(-1)).toMatchObject({ status: 'stopped', connectionId: null });
    expect((await saidUnder((await watches()).at(-1)))[0]?.text).toContain('Find My');
  });

  it('starts only in the person’s own turns, in a chat', async () => {
    expect((await tool(null)({ person: 'Ruben' })).isError).toBe(true);
    expect((await tool(IDS.mara, null)({ person: 'Ruben' })).isError).toBe(true);
    expect(await watches()).toEqual([]);
  });
});
