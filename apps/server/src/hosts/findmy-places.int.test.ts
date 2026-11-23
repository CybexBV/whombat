/**
 * Arriving on Find My end to end (docs/decisions/findmy-connection.md). Needs Postgres: the places a listened Find My
 * connection keeps in `findmy_places`, the signed `findmy.place_changed` written through the commit pipeline by the
 * burrow's Find My signer, and the automations engine reading that event into a run with its scope. Made-up names only.
 */
import { FIND_MY_PLACE_CHANGED } from '@whombat/core';
import { and, asc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { setAutomationEnabled } from '../automations/commands';
import { automations, events } from '../db/schema/index';
import { IDS, useAutomationWorld } from '../test/automations';
import { insertConnection } from '../test/connections';
import { findMyPersonId } from './findmy';
import { listenedFindMyConnections } from './findmy-connection';
import { FindMyPlacesWatch, findMyPlacesFor, keptPlaces } from './findmy-places';

const w = useAutomationWorld();
const MARA = findMyPersonId('Mara Visser');
const RUBEN = findMyPersonId('Ruben Visser');
let connectionId: string;

beforeAll(async () => {
  connectionId = await insertConnection(w.services, {
    catalogId: 'findmy',
    burrowId: w.burrowId,
    signIn: 'none',
    fields: { mac: 'studio', background: 'off' },
  });
});

/** A read of the Mac: Mara where given, Ruben without a place. */
const read = (place: string | null) => [
  { id: MARA, name: 'Mara Visser', place },
  { id: RUBEN, name: 'Ruben Visser', place: null },
];

const placeEvents = async () =>
  w.services.db
    .select()
    .from(events)
    .where(and(eq(events.burrowId, w.burrowId), eq(events.type, FIND_MY_PLACE_CHANGED)))
    .orderBy(asc(events.seq));

describe('Find My places', () => {
  it('are neither kept nor signed while no automation listens', async () => {
    await findMyPlacesFor(w.services).noted('studio', read('Lelystad'), w.now());
    expect(await keptPlaces(w.services.db, connectionId)).toEqual([]);
    expect(await placeEvents()).toEqual([]);
  });

  it('start an automation when someone arrives, once, and a restart invents nothing', async () => {
    const automationId = await w.publish(
      {
        version: 1,
        conversationId: IDS.incidents,
        triggers: [
          {
            kind: 'findmy',
            connectionId,
            person: MARA,
            name: 'Mara Visser',
            change: 'arrives',
            place: 'Home',
          },
        ],
        steps: [{ id: 'tell', kind: 'post_message', text: '{{trigger.text}}' }],
      },
      { name: 'Tell me when Mara gets home' },
    );
    expect(await listenedFindMyConnections(w.services.db)).toEqual(
      new Map([[connectionId, 'Tell me when Mara gets home']]),
    );
    const watch = findMyPlacesFor(w.services);
    // The first read keeps her place without a change; a read without a place keeps it.
    w.advance(60_000);
    await watch.noted('studio', read('Lelystad'), w.now());
    w.advance(60_000);
    await watch.noted('studio', read(null), w.now());
    expect((await keptPlaces(w.services.db, connectionId)).map((k) => [k.person, k.place])).toEqual([
      [MARA, 'Lelystad'],
    ]);
    expect(await placeEvents()).toEqual([]);

    w.advance(60_000);
    await watch.noted('studio', read('Home'), w.now());
    const [event, ...more] = await placeEvents();
    expect(more).toEqual([]);
    expect(event?.payload).toEqual({
      connectionId,
      person: MARA,
      name: 'Mara Visser',
      from: 'Lelystad',
      to: 'Home',
    });
    expect(event?.text).toBeNull();

    await w.settle();
    const [run, ...others] = await w.runs(automationId);
    expect(others).toEqual([]);
    expect(run?.trigger.kind).toBe('findmy');
    const [auto] = await w.services.db
      .select({ principalId: automations.principalId })
      .from(automations)
      .where(eq(automations.id, automationId));
    const posted = await w.messagesBy(auto?.principalId ?? '');
    expect(posted.map((m) => m.text).join(' ')).toMatch(/Mara Visser.*Home.*Lelystad/);

    // Another process compares with what was kept: the same place is no change, nor a new arrival.
    w.advance(60_000);
    await new FindMyPlacesWatch(w.services).noted('studio', read('home'), w.now());
    expect(await placeEvents()).toHaveLength(1);

    // Switched off, nothing listens: what was kept goes.
    await w.ok(IDS.mara, setAutomationEnabled, { automationId, enabled: false });
    await findMyPlacesFor(w.services).clearUnlistened(await listenedFindMyConnections(w.services.db));
    expect(await keptPlaces(w.services.db, connectionId)).toEqual([]);
  });
});
