/**
 * The person's Stop of one of the agent's services (one-person.md OP-19, OP-S45) against a real Postgres: a running
 * service is signed `service.stopped` (Keys, the service's id, name and port) and then stopped through the engine; one
 * that is stopped already signs nothing; an id that isn't a service is `not_found`.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBurrowRow } from '../commit/pipeline';
import { events } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { ApiError } from '../lib/errors';
import { useTestServer } from '../test/harness';
import { SocketEngine } from './engine';
import { stopService } from './routes';
import { AgentServices } from './service';
import { FakeEngine, serviceContainer } from './testing';

const t = useTestServer({ seed: true });
const fake = new FakeEngine();

beforeAll(async () => {
  await fake.start();
  t.services.agentServices = new AgentServices({
    engine: new SocketEngine(fake.socket),
    address: () => '192.168.1.20',
  });
});
afterAll(async () => {
  await fake.close();
});

async function asThePerson() {
  const burrow = await loadBurrowRow(t.services.db, t.burrowId);
  const principal = await thePerson(t.services.db, t.burrowId);
  if (!burrow || !principal) throw new Error('no person');
  return { services: t.services, access: { burrow, principal } };
}

const stopped = () =>
  t.services.db
    .select()
    .from(events)
    .where(and(eq(events.burrowId, t.burrowId), eq(events.type, 'service.stopped')));

describe('Stop on one of the agent’s services', () => {
  it('signs the stop, then stops it; a second Stop signs nothing', async () => {
    fake.containers = [serviceContainer({ port: 20_004 })];
    const ctx = await asThePerson();
    const first = await stopService(ctx, 'a'.repeat(64));
    expect(first.service).toMatchObject({ state: 'stopped', port: 20_004, url: 'http://192.168.1.20:20004' });
    expect(first.eventId).toEqual(expect.any(String));
    const [signed] = await stopped();
    expect(signed).toMatchObject({
      id: first.eventId,
      actorId: ctx.access.principal.id,
      kind: 'Keys',
      payload: { serviceId: 'a'.repeat(64), name: 'invoice-site', port: 20_004 },
    });
    const again = await stopService(ctx, 'a'.repeat(64));
    expect(again.eventId).toBeNull();
    expect(await stopped()).toHaveLength(1);
  });

  it('answers not_found for an id that isn’t a service', async () => {
    fake.containers = [serviceContainer({ Labels: {} })];
    const err = await stopService(await asThePerson(), 'a'.repeat(64)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('not_found');
  });
});
