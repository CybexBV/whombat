/**
 * Screens elsewhere against a real database (desk-display.md DK-138, DK-146; desk-display-server.md “Screens
 * elsewhere”). It needs Postgres because becoming a screen is one commit of a signed `endpoint.enrolled` and the
 * `screens` row naming that key, removing one is one commit revoking the key and deleting the row, and what a session
 * may do is decided from `appliance_endpoints` at every request: the refusals are tested through real sessions.
 */
import {
  type DeskCalm,
  type DeskCalmView,
  type DeskGrid,
  DeskScreenDetail,
  deskDefaultLayout,
  newId,
  topics,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accounts,
  applianceEndpoints,
  applianceEvents,
  applianceState,
  deskScreens,
  messages,
  screens,
} from '../db/schema/index';
import { NO_DISPLAY } from '../desk/hardware';
import { hashPin } from '../desk/pin';
import { screenSessionsFor } from '../desk/screen-sessions';
import { revokeScreenDevice, ScreenStore } from '../desk/screens';
import { DeskService } from '../desk/service';
import { loadDeskRow } from '../desk/store';
import type { ScreenRecord, ScreensApi } from '../desk/widgets/types';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { SCREEN_READS_PER_MINUTE } from './dispatcher';
import { type TestIdentity, type TestSessionClient, testIdentity } from './testing';
import { requireEnrolled, type SessionPrincipal } from './trust';

const m = useManagedRuntime({ seed: true });
const PICTURE_REF = 'abcdefghijklmnopqrstu.signature';
const TABLET = { label: 'Safari on iPad', platform: 'web' as const };
let mara: TestIdentity & { accountId: string; endpointId: string };

/**
 * The screens' store (R1's `ScreenStore`, over the real table) with a fixed glance for drawing: the drawing is the desk
 * service's and isn't what this file tests.
 */
class TestScreens implements ScreensApi {
  draws: DeskCalmView[] = [];
  #store: ScreenStore | null = null;
  private get store(): ScreenStore {
    this.#store ??= new ScreenStore(m.t.services);
    return this.#store;
  }
  list(burrowId: string) {
    return this.store.list(burrowId);
  }
  get(burrowId: string, id: string) {
    return this.store.get(burrowId, id);
  }
  byEndpoint(endpointId: string) {
    return this.store.byEndpoint(endpointId);
  }
  addDevice(tx: unknown, input: Parameters<ScreensApi['addDevice']>[1]) {
    return this.store.addDevice(tx, input);
  }
  seen(id: string, size: { width: number; height: number }, at: Date) {
    return this.store.seen(id, size, at);
  }
  async draw(screen: ScreenRecord, view: DeskCalmView) {
    this.draws.push(view);
    return {
      calm: { headline: { text: 'All fine' } } as unknown as DeskCalm,
      grid: {
        screen: screen.id,
        layout: screen.layout,
        views: [],
        attention: { items: [], more: 0 },
        popups: screen.popups,
      } as DeskGrid,
    };
  }
  async picture(_screen: ScreenRecord, _view: DeskCalmView, _thing: string, ref: string) {
    return ref === PICTURE_REF ? { type: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) } : null;
  }
}

const api = new TestScreens();

type Answer = Awaited<ReturnType<TestSessionClient['request']>>;
const output = (a: Answer) => {
  if (a.t !== 'result') throw new Error(`expected a result: ${JSON.stringify(a)}`);
  return a.output as Record<string, unknown>;
};

/** A tablet that showed its letters, and the person typed them; the screens earlier tests added go first. */
async function addScreen(name: string, start: 'copy' | 'empty' = 'empty') {
  for (const s of await api.list(TEST_BURROW_ID))
    if (s.kind === 'device') await revokeScreenDevice(m.t.services, s);
  const tablet = testIdentity();
  const waiting = await m.client(tablet);
  const asked = output(await waiting.request('enroll.display.request', { endpoint: TABLET }));
  const person = await m.client(mara);
  const added = output(
    await person.request('desk.screen.add', { code: asked.code, name, popups: 'problems', start }),
  );
  return { tablet, waiting, asked, added, screenId: added.id as string };
}

async function endpointOf(peerId: string) {
  const [row] = await m.t.services.db
    .select()
    .from(applianceEndpoints)
    .where(eq(applianceEndpoints.peerId, peerId));
  if (!row) throw new Error('no endpoint');
  return row;
}

/** The box's desk: a screen's PIN is checked as its own (one count, kept in the database, told to the person). */
let desk: DeskService;
let maras: PersonalSetup;

beforeAll(async () => {
  const services = m.t.services;
  maras = await addPersonalAgent(services, TEST_BURROW_ID, IDS.mara, { services: null });
  mara = await m.enroll(IDS.mara);
  await services.db
    .insert(applianceState)
    .values({ id: 1, claimConsumedAt: services.clock(), claimedByAccountId: mara.accountId })
    .onConflictDoUpdate({
      target: applianceState.id,
      set: { claimConsumedAt: services.clock(), claimedByAccountId: mara.accountId },
    });
  desk = new DeskService(services, {
    display: { display: async () => NO_DISPLAY, connected: async () => false },
    push: null,
  });
  m.runtime.dispatcher.screens = screenSessionsFor(services, api, (pin) => desk.checkScreenPin(pin));
});

afterAll(() => desk.close());

describe('a device becoming a screen', () => {
  it('shows six letters; the person types them; it comes back as a screen of its own', async () => {
    const changed: string[] = [];
    const off = m.t.services.bus.onFrame((f) => {
      if (f.event.type === 'desk.changed') changed.push(f.topic);
    });
    const { tablet, waiting, asked, added, screenId } = await addScreen('Kitchen');
    off();
    // Settings hears of it.
    expect(changed).toContain(topics.me(IDS.mara));
    expect(asked.code).toMatch(/^[A-HJ-NP-Z]{6}$/);
    expect(DeskScreenDetail.safeParse(added).success).toBe(true);
    expect(added).toMatchObject({
      kind: 'device',
      name: 'Kitchen',
      popups: 'problems',
      device: 'iPad · Safari',
    });
    // One commit: the key enrolled as a screen by Mara's device, signed, and the screen naming it.
    const key = await endpointOf(tablet.peerId);
    expect(key).toMatchObject({
      enrolledVia: 'display',
      enrolledByEndpointId: mara.endpointId,
      accountId: mara.accountId,
    });
    const [row] = await m.t.services.db.select().from(screens).where(eq(screens.id, screenId));
    expect(row).toMatchObject({ endpointId: key.id, kind: 'device', personId: IDS.mara });
    const signed = await m.t.services.db
      .select()
      .from(applianceEvents)
      .where(and(eq(applianceEvents.type, 'endpoint.enrolled'), eq(applianceEvents.endpointId, key.id)));
    expect(signed[0]?.payload).toMatchObject({ via: 'display', by: mara.endpointId });
    // The waiting session hears it, and stays on the enrolment channel until it reconnects.
    expect(output(await waiting.request('enroll.display.status', { requestId: asked.requestId }))).toEqual({
      state: 'added',
      screen: { id: screenId, name: 'Kitchen' },
    });
    expect(await waiting.request('screen.state', { size: { width: 1180, height: 820 } })).toMatchObject({
      t: 'error',
      code: 'unknown_op',
    });
    // Back as a screen: it acts for nobody, and draws its own screen.
    const screen = await m.client(tablet);
    expect(screen.received[0]).toMatchObject({
      t: 'welcome',
      channel: 'app',
      principal: null,
      endpointId: key.id,
    });
    const state = output(await screen.request('screen.state', { size: { width: 1180, height: 820 } }));
    expect(state).toMatchObject({
      screen: { id: screenId, name: 'Kitchen', popups: 'problems' },
      lock: { state: 'locked', view: 'summary', hasPin: false },
      grid: { screen: screenId },
    });
    expect(
      output(await screen.request('screen.state', { size: { width: 1180, height: 820 }, known: state.etag })),
    ).toEqual({
      same: true,
      etag: state.etag,
    });
  });

  it('wrong letters count the person’s tries; letters that ran out say so; a full Whombat keeps them', async () => {
    const person = await m.client(mara);
    expect(
      await person.request('desk.screen.add', {
        code: 'ZZZZZZ',
        name: 'Hall',
        popups: 'none',
        start: 'empty',
      }),
    ).toMatchObject({ t: 'error', code: 'forbidden', details: { code: 'wrong_code', triesLeft: 4 } });

    // Full: 8 screens besides the box's own. The letters aren't used up.
    const services = m.t.services;
    const now = services.clock();
    const outputs = Array.from({ length: 8 }, (_, i) => `out_test-${i}`);
    const existing = (await api.list(TEST_BURROW_ID)).filter((s) => s.kind !== 'box').length;
    const filler = outputs.slice(0, 8 - existing);
    for (const id of filler)
      await services.db.insert(screens).values({
        id,
        burrowId: TEST_BURROW_ID,
        kind: 'output',
        name: 'Monitor',
        popups: 'problems',
        layout: deskDefaultLayout(),
        createdAt: now,
        updatedAt: now,
      });
    const tablet = testIdentity();
    const waiting = await m.client(tablet);
    const asked = output(await waiting.request('enroll.display.request', { endpoint: TABLET }));
    const add = { code: asked.code, name: 'Hall', popups: 'none', start: 'empty' };
    expect(await person.request('desk.screen.add', add)).toMatchObject({
      t: 'error',
      code: 'conflict',
      details: { code: 'screens_full' },
    });
    expect(output(await waiting.request('enroll.display.status', { requestId: asked.requestId }))).toEqual({
      state: 'waiting',
    });
    await services.db.delete(screens).where(eq(screens.id, filler[0] as string));
    expect(output(await person.request('desk.screen.add', add))).toMatchObject({ name: 'Hall' });
    for (const id of filler) await services.db.delete(screens).where(eq(screens.id, id));
    await services.db.delete(screens).where(eq(screens.name, 'Hall'));

    // Ten minutes later the letters ran out.
    const late = testIdentity();
    const lateWaiting = await m.client(late);
    const lateAsked = output(await lateWaiting.request('enroll.display.request', { endpoint: TABLET }));
    const clock = services.clock;
    services.clock = () => new Date(clock().getTime() + 10 * 60_000 + 1000);
    try {
      expect(
        await person.request('desk.screen.add', {
          code: lateAsked.code,
          name: 'Late',
          popups: 'none',
          start: 'empty',
        }),
      ).toMatchObject({ t: 'error', code: 'expired', details: { code: 'pairing_expired' } });
      expect(
        output(await lateWaiting.request('enroll.display.status', { requestId: lateAsked.requestId })),
      ).toEqual({
        state: 'expired',
      });
    } finally {
      services.clock = clock;
    }
  });

  it('a person’s device can’t become a screen, and only the device that asked hears how it went', async () => {
    const person = await m.client(mara);
    expect(await person.request('enroll.display.request', { endpoint: TABLET })).toMatchObject({
      t: 'error',
      code: 'conflict',
      details: { code: 'endpoint_enrolled' },
    });
    const tablet = await m.client(testIdentity());
    const asked = output(await tablet.request('enroll.display.request', { endpoint: TABLET }));
    const stranger = await m.client(testIdentity());
    expect(await stranger.request('enroll.display.status', { requestId: asked.requestId })).toMatchObject({
      t: 'error',
      code: 'not_found',
    });
  });
});

describe('a tablet becomes a screen only at an HTTPS address (LNK-17)', () => {
  it('a page the box served over plain HTTP is refused; the same page over HTTPS gets its letters', async () => {
    const page = (secureContext: boolean) => ({
      transport: {
        via: 'direct' as const,
        network: 'lan' as const,
        tls: secureContext,
        page: {
          origin: secureContext ? 'https://box.tail0000.ts.net' : 'http://192.168.1.20:4480',
          secureContext,
        },
      },
    });
    const plain = await m.client(testIdentity(), page(false));
    expect(await plain.request('enroll.display.request', { endpoint: TABLET })).toMatchObject({
      t: 'error',
      code: 'forbidden',
    });
    const secure = await m.client(testIdentity(), page(true));
    expect(await secure.request('enroll.display.request', { endpoint: TABLET })).toMatchObject({
      t: 'result',
      output: { code: expect.any(String) },
    });
  });
});

describe('a screen sees its own screen and nothing else', () => {
  it('every other operation refuses it, as if it didn’t exist', async () => {
    const { tablet } = await addScreen('Refusals');
    const screen = await m.client(tablet);
    const ops = m.runtime.dispatcher.allowlist.ops.filter((op) => !op.startsWith('screen.'));
    expect(ops.length).toBeGreaterThan(100);
    const allowed: string[] = [];
    for (const op of ops) {
      const answer = await screen.request(op, {});
      if (answer.t !== 'error' || answer.code !== 'unknown_op') allowed.push(op);
    }
    expect(allowed).toEqual([]);
    expect(m.runtime.dispatcher.allowedOps(screen.connection.principal as never).sort()).toEqual([
      'screen.image',
      'screen.lock',
      'screen.state',
      'screen.unlock',
    ]);
  });

  it('every op runs past the channel again: skipping the allowlist, even with the person’s account, gets nowhere', async () => {
    const { tablet } = await addScreen('Second wall');
    const screen = await m.client(tablet);
    const principal = screen.connection.principal as SessionPrincipal;
    const [account] = await m.t.services.db.select().from(accounts).where(eq(accounts.id, mara.accountId));
    const dispatcher = m.runtime.dispatcher;
    for (const who of [principal, { ...principal, account: account ?? null }])
      for (const op of ['appliance.status', 'endpoints.list', 'me.get', 'desk.get', 'enroll.pair.request']) {
        const spec = dispatcher.allowlist.get(op);
        if (!spec) throw new Error(`no ${op}`);
        expect(await dispatcher.run(spec, who, {}), op).toMatchObject({ type: 'error', code: 'unknown_op' });
      }
    // And the person's handlers refuse a screen themselves.
    expect(() => requireEnrolled({ ...principal, account: account ?? null })).toThrow(/screen/);
    // A person's session can't run a screen op past the allowlist either.
    const person = (await m.client(mara)).connection.principal as SessionPrincipal;
    const state = dispatcher.allowlist.get('screen.state');
    if (!state) throw new Error('no screen.state');
    expect(await dispatcher.run(state, person, { size: { width: 1180, height: 820 } })).toMatchObject({
      type: 'error',
      code: 'unknown_op',
    });
  });

  it('subscribes to nothing and opens no stream but its own picture', async () => {
    const { tablet } = await addScreen('Streams');
    const screen = await m.client(tablet);
    screen.send({ t: 'subscribe', sub: 's1', topics: [topics.me(IDS.mara), topics.burrow(TEST_BURROW_ID)] });
    expect(
      await screen.waitFor(
        (x) => x.t === 'error' && (x as { details?: { sub?: string } }).details?.sub === 's1',
      ),
    ).toMatchObject({ code: 'forbidden' });
    const burrow = 'burrow-hq';
    const specs = [
      {
        kind: 'download',
        resource: { type: 'attachment', burrow, attachmentId: newId('attachment'), variant: 'original' },
      },
      {
        kind: 'upload',
        target: { type: 'attachment', burrow, attachmentId: newId('attachment') },
        size: 10,
        sha256: '0'.repeat(64),
        chunkSize: 65_536,
      },
      {
        kind: 'upload',
        target: { type: 'dictation', burrow },
        size: 10,
        sha256: '0'.repeat(64),
        chunkSize: 65_536,
      },
      { kind: 'export', op: 'audit.export', input: { params: { burrow } } },
      { kind: 'export', op: 'desk.voiceSample', input: { voice: 'heart' } },
      { kind: 'export', op: 'screen.state', input: { size: { width: 1180, height: 820 } } },
      { kind: 'collab', burrow, canvasId: newId('canvas') },
      { kind: 'console', burrow, sessionId: 'console-1', token: 'token-1' },
    ] as const;
    for (const spec of specs)
      expect((await screen.open(spec as never)).answer, spec.kind).toMatchObject({
        t: 'error',
        code: 'stream_refused',
      });
    expect(screen.received.some((x) => x.t === 'subscribed' || x.t === 'opened')).toBe(false);
    // Its picture, too large for a message, comes through an export; one its views don't name is refused.
    const picture = await screen.open({
      kind: 'export',
      op: 'screen.image',
      input: { thing: 'connection:plex', ref: PICTURE_REF },
    });
    expect(picture.answer).toMatchObject({
      t: 'opened',
      meta: { kind: 'export', contentType: 'application/json' },
    });
    const bytes = (await screen.readStream(picture.stream)).bytes;
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ type: 'image/png', data: 'iVBORw==' });
    expect(
      await screen.request('screen.image', { thing: 'connection:plex', ref: 'zyxwvutsrqponmlkjih.other' }),
    ).toMatchObject({ t: 'error', code: 'not_found' });
  });

  it('holds two sessions at most: a third closes its oldest, never the person’s', async () => {
    const { tablet } = await addScreen('Sessions');
    const person = await m.client(mara);
    const first = await m.client(tablet);
    const second = await m.client(tablet);
    const third = await m.client(tablet);
    expect(await first.closed).toBe('overload');
    const size = { width: 1180, height: 820 };
    for (const c of [second, third])
      expect(output(await c.request('screen.state', { size }))).toHaveProperty('etag');
    expect(output(await person.request('endpoints.list', {}))).toHaveProperty('endpoints');
  });

  it('a page asking far more than it needs is refused, not drawn for each time', async () => {
    const { tablet } = await addScreen('Busy');
    const screen = await m.client(tablet);
    const services = m.t.services;
    const clock = services.clock;
    const at = clock();
    services.clock = () => at;
    try {
      const size = { width: 1180, height: 820 };
      const allowed = SCREEN_READS_PER_MINUTE['screen.state'] ?? 0;
      const drawn = api.draws.length;
      for (let i = 0; i < allowed; i++)
        expect((await screen.request('screen.state', { size })).t).toBe('result');
      expect(await screen.request('screen.state', { size })).toMatchObject({
        t: 'error',
        code: 'rate_limited',
      });
      expect(api.draws.length - drawn).toBe(allowed);
    } finally {
      services.clock = clock;
    }
  });

  it('nobody else may use the screen channel', async () => {
    const person = await m.client(mara);
    const stranger = await m.client(testIdentity());
    for (const op of ['screen.state', 'screen.unlock', 'screen.lock', 'screen.image']) {
      expect(await person.request(op, {}), op).toMatchObject({ t: 'error', code: 'unknown_op' });
      expect(await stranger.request(op, {}), op).toMatchObject({ t: 'error', code: 'unknown_op' });
    }
  });

  it('never finds the person’s commands by their request ids', async () => {
    const { tablet } = await addScreen('Receipts');
    const person = await m.client(mara);
    const id = person.newId();
    output(
      await person.request('endpoints.rename', { endpointId: mara.endpointId, label: 'Laptop' }, { id }),
    );
    person.send({ t: 'status', id });
    expect(await person.waitFor((x) => x.t === 'outcome' && x.id === id)).toMatchObject({
      state: 'completed',
    });
    const screen = await m.client(tablet);
    screen.send({ t: 'status', id });
    expect(await screen.waitFor((x) => x.t === 'outcome' && x.id === id)).toMatchObject({
      state: 'not_found',
    });
  });

  it('is no device of the person’s: not listed, not renamed, never pushed, never their last device', async () => {
    const { tablet } = await addScreen('Not a device');
    const key = await endpointOf(tablet.peerId);
    const person = await m.client(mara);
    const listed = output(await person.request('endpoints.list', {})) as {
      endpoints: { endpointId: string }[];
    };
    expect(listed.endpoints.map((e) => e.endpointId)).toEqual([mara.endpointId]);
    expect(await person.request('endpoints.rename', { endpointId: key.id, label: 'Mine now' })).toMatchObject(
      {
        t: 'error',
        code: 'not_found',
      },
    );
    // Mara's only device can't go, whatever screens she has.
    expect(await person.request('endpoints.revoke', { endpointId: mara.endpointId })).toMatchObject({
      t: 'error',
      code: 'conflict',
      details: { code: 'last_endpoint' },
    });
    // A screen with a push handle (it can't set one) still never gets pushed.
    const db = m.t.services.db;
    await db
      .update(applianceEndpoints)
      .set({ pushHandle: 'h-screen' })
      .where(eq(applianceEndpoints.id, key.id));
    await db
      .update(applianceEndpoints)
      .set({ pushHandle: 'h-mara' })
      .where(eq(applianceEndpoints.id, mara.endpointId));
    const screen = await m.client(tablet);
    expect(await screen.request('push.handles.set', { handle: 'h-screen-2' })).toMatchObject({
      code: 'unknown_op',
    });
    const before = m.manager.pushes.length;
    await m.runtime.trust.push?.forAccounts([mara.accountId], 'security', 'test');
    const handles = m.manager.pushes.slice(before).flatMap((p) => p.handles);
    expect(handles).toEqual(['h-mara']);
    await db
      .update(applianceEndpoints)
      .set({ pushHandle: null })
      .where(eq(applianceEndpoints.id, mara.endpointId));
  });

  it('the box’s PIN unlocks it, and locked it shows what the box’s lock lets show', async () => {
    const { tablet } = await addScreen('Locked');
    const db = m.t.services.db;
    const now = m.t.services.clock();
    const pin = { pinHash: await hashPin('2580'), pinDigits: 4, lockedView: 'time' as const };
    await db
      .insert(deskScreens)
      .values({ id: 1, burrowId: TEST_BURROW_ID, personId: IDS.mara, ...pin, pairedAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: deskScreens.id, set: pin });
    const screen = await m.client(tablet);
    const size = { width: 1180, height: 820 };
    expect(output(await screen.request('screen.state', { size }))).toMatchObject({
      lock: { state: 'locked', view: 'time', hasPin: true },
      calm: null,
      grid: null,
    });
    expect(output(await screen.request('screen.unlock', { pin: '1111' }))).toMatchObject({
      state: 'locked',
      triesLeft: 4,
    });
    expect(output(await screen.request('screen.unlock', { pin: '2580' }))).toMatchObject({
      state: 'unlocked',
    });
    api.draws = [];
    expect(output(await screen.request('screen.state', { size }))).toMatchObject({
      lock: { state: 'unlocked' },
    });
    expect(api.draws).toEqual(['everything']);
    expect(output(await screen.request('screen.lock', {}))).toMatchObject({ state: 'locked' });
    await db.delete(deskScreens).where(eq(deskScreens.id, 1));
  });

  it('wrong PINs count with the box’s own: kept, the fifth told to the person, and the box’s wait holds here', async () => {
    const { tablet } = await addScreen('Guessed');
    const db = m.t.services.db;
    const now = m.t.services.clock();
    // Three wrong PINs typed at the box already.
    const pin = { pinHash: await hashPin('2580'), pinDigits: 4, wrongPins: 3, retryAt: null };
    await db
      .insert(deskScreens)
      .values({ id: 1, burrowId: TEST_BURROW_ID, personId: IDS.mara, ...pin, pairedAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: deskScreens.id, set: pin });
    const screen = await m.client(tablet);
    expect(output(await screen.request('screen.unlock', { pin: '1111' }))).toMatchObject({
      state: 'locked',
      triesLeft: 1,
    });
    expect(output(await screen.request('screen.unlock', { pin: '1112' }))).toMatchObject({
      state: 'backoff',
    });
    const row = await loadDeskRow(db);
    expect(row?.wrongPins).toBe(5);
    expect(row?.retryAt).not.toBeNull();
    // The right PIN while the box waits isn't even checked, and the screen's state says it waits.
    expect(output(await screen.request('screen.unlock', { pin: '2580' }))).toMatchObject({
      state: 'backoff',
    });
    expect(
      output(await screen.request('screen.state', { size: { width: 1180, height: 820 } })),
    ).toMatchObject({
      lock: { state: 'backoff' },
    });
    await m.t.services.background.settle();
    const told = await db
      .select({ text: messages.text })
      .from(messages)
      .where(and(eq(messages.conversationId, maras.dmId), eq(messages.authorId, maras.agentId)));
    expect(told.some((m) => m.text.includes('wrong PIN'))).toBe(true);
    await db.delete(deskScreens).where(eq(deskScreens.id, 1));
  });
});

describe('removing a screen', () => {
  it('*Remove* ends its sessions at once and takes its screen with it; control hears', async () => {
    const { tablet, screenId } = await addScreen('Removed');
    const screen = await m.client(tablet);
    const person = await m.client(mara);
    const record = await api.get(TEST_BURROW_ID, screenId);
    if (!record) throw new Error('no screen');
    const changed: string[] = [];
    const off = m.t.services.bus.onFrame((f) => {
      if (f.event.type === 'desk.changed') changed.push(f.topic);
    });
    expect(
      await revokeScreenDevice(m.t.services, record, {
        id: IDS.mara,
        burrowId: TEST_BURROW_ID,
        endpointId: mara.endpointId,
      }),
    ).toBe(true);
    off();
    expect(changed).toContain(topics.me(IDS.mara));
    expect(await screen.waitFor((x) => x.t === 'revoked')).toMatchObject({
      scope: 'endpoint',
      clearCache: true,
    });
    expect(await screen.closed).toBe('endpoint_revoked');
    // The person's sessions learn their account's authorization moved.
    expect(await person.closed).toBe('authz_changed');
    expect(await api.get(TEST_BURROW_ID, screenId)).toBeNull();
    const key = await endpointOf(tablet.peerId);
    expect(key.revokedAt).not.toBeNull();
    const signed = await m.t.services.db
      .select()
      .from(applianceEvents)
      .where(eq(applianceEvents.type, 'endpoint.revoked'));
    expect(signed.find((e) => (e.payload as { endpointId?: string }).endpointId === key.id)).toMatchObject({
      endpointId: mara.endpointId,
      actorAccountId: mara.accountId,
    });
    await m.runtime.trust.reportPending();
    expect(m.manager.revocations.some((r) => r.peerId === tablet.peerId)).toBe(true);
    // Its key can't come back; removing it again does nothing.
    expect(String(await m.client(tablet).catch((err: Error) => err))).toMatch(/no welcome/);
    expect(await revokeScreenDevice(m.t.services, record)).toBe(false);
  });

  it('never revokes one of the person’s own devices: a screen naming one is only forgotten', async () => {
    const now = m.t.services.clock();
    await m.t.services.db.insert(screens).values({
      id: 'scr_mislaid01',
      burrowId: TEST_BURROW_ID,
      kind: 'device',
      name: 'Mislaid',
      popups: 'none',
      layout: deskDefaultLayout(),
      endpointId: mara.endpointId,
      createdAt: now,
      updatedAt: now,
    });
    const record = await api.get(TEST_BURROW_ID, 'scr_mislaid01');
    if (!record) throw new Error('no screen');
    expect(await revokeScreenDevice(m.t.services, record)).toBe(true);
    expect(await api.get(TEST_BURROW_ID, 'scr_mislaid01')).toBeNull();
    expect((await endpointOf(mara.peerId)).revokedAt).toBeNull();
  });

  it('revoking its key from the person’s devices does the same', async () => {
    const { tablet, screenId } = await addScreen('Revoked');
    const screen = await m.client(tablet);
    const key = await endpointOf(tablet.peerId);
    const person = await m.client(mara);
    expect(output(await person.request('endpoints.revoke', { endpointId: key.id }))).toMatchObject({
      endpoint: { endpointId: key.id },
    });
    expect(await screen.closed).toBe('endpoint_revoked');
    expect(await api.get(TEST_BURROW_ID, screenId)).toBeNull();
  });

  it('a screen whose screen went (its burrow, say) is no screen any more', async () => {
    const { tablet, screenId } = await addScreen('Orphan');
    const screen = await m.client(tablet);
    await m.t.services.db.delete(screens).where(eq(screens.id, screenId));
    // Its key is revoked as it asks; the session may close before the answer leaves.
    const id = screen.newId();
    screen.send({
      t: 'request',
      id,
      op: 'screen.state',
      input: { size: { width: 1180, height: 820 } },
      deadlineMs: 30_000,
    });
    expect(await screen.closed).toBe('endpoint_revoked');
    const answer = screen.received.find((x) => x.t === 'error' && (x as { id?: string }).id === id);
    if (answer) expect(answer).toMatchObject({ code: 'not_found', details: { code: 'unknown_screen' } });
    expect((await endpointOf(tablet.peerId)).revokedAt).not.toBeNull();
  });

  it('a screen whose person went draws for nobody else: refused, and its key revoked', async () => {
    const { tablet, screenId } = await addScreen('Nobody’s');
    const screen = await m.client(tablet);
    await m.t.services.db.update(screens).set({ personId: null }).where(eq(screens.id, screenId));
    const drawn = api.draws.length;
    const id = screen.newId();
    screen.send({
      t: 'request',
      id,
      op: 'screen.state',
      input: { size: { width: 1180, height: 820 } },
      deadlineMs: 30_000,
    });
    expect(await screen.closed).toBe('endpoint_revoked');
    expect((await endpointOf(tablet.peerId)).revokedAt).not.toBeNull();
    expect(await api.get(TEST_BURROW_ID, screenId)).toBeNull();
    // Nothing was drawn for it.
    expect(api.draws.length).toBe(drawn);
  });
});
