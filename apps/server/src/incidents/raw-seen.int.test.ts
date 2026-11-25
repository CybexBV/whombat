/**
 * The end of an outage read from the thing itself, on a real database with the watcher's own passes: a Google account
 * that needs a new sign-in opens an incident, stays open while kept quiet and ends as back (not as removed) once signed
 * in, while a watch on it keeps running; a server whose failing disk the person ignored keeps its incident, and one
 * whose ignored disk has nothing to do with its outage ends it when it answers again; a connection whose details
 * couldn't be read isn't back; a pass that couldn't read a connection doesn't start its run again, nor counts as down
 * or makes the push stale; down time ends when the thing answers again while a problem keeps it open, and the push
 * says what is wrong now; one outage buzzes once beside a research finding; a short or undone window doesn't cancel a
 * delayed automation for good. Postgres because each pass is a signed commit read back with the connector rows, line
 * states, windows and automation claims beside it.
 */
import { type AutomationDefinitionInput, FEEDBACK_THING_ID, newId, THING_BACK } from '@whombat/core';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sendMessage } from '../commands/messages';
import {
  catalogConnections,
  connections,
  dispatches,
  events,
  incidents,
  lookResearches,
  noticeStates,
  notifications,
  principals,
  quietWindows,
  thingWatches,
} from '../db/schema/index';
import { createFeedbackIntegration } from '../feedback/integrations';
import { HOSTS_API } from '../hosts/client';
import { serversPrincipal } from '../hosts/principal';
import { hostsFor } from '../hosts/service';
import { FakeHostsService } from '../hosts/testing/fake';
import { reportLook, startResearch } from '../looks/research';
import { IDS, useAutomationWorld } from '../test/automations';
import { insertConnection } from '../test/connections';
import { integrationSettings } from '../test/feedback';
import type { GlanceLine } from '../things/quiet/glance';
import { thingWatchTool } from './agent';
import { periodUptime } from './history';
import type { PassBefore } from './plan';
import { incidentsPass, incidentsPush } from './store';
import { watchIncidents } from './watch';

const fake = new FakeHostsService();
const w = useAutomationWorld({
  env: { WHOMBAT_HOSTS_SOCKET: fake.socket, WHOMBAT_HOSTS_TOKEN_FILE: fake.tokenFile },
});
const MINUTE = 60_000;
let before: PassBefore | null = null;

beforeAll(async () => {
  await fake.start();
});

afterAll(async () => {
  await fake.stop();
});

/** One watcher pass a minute after the last, remembering what it saw (the servers read afresh). */
async function pass() {
  w.advance(MINUTE);
  hostsFor(w.services).forget('fleet');
  before = await watchIncidents(w.services, w.burrowId, before);
  await w.settle();
}

async function incidentsOf(thing: string) {
  return w.services.db.select().from(incidents).where(eq(incidents.thingId, thing));
}

async function open(thing: string) {
  return (await incidentsOf(thing)).find((r) => !r.endedAt);
}

async function backs(thing: string) {
  return (await w.services.db.select().from(events).where(eq(events.type, THING_BACK))).filter(
    (e) => (e.payload as { thing?: string }).thing === thing,
  );
}

const line = (check: string, title: string, more: Partial<GlanceLine> = {}): GlanceLine => ({
  check,
  tone: 'bad',
  nature: 'problem',
  title,
  seen: 2,
  ...more,
});

const NOT_ANSWERING = line('conn.answers', 'Whombat can’t reach it', { confirm: 2, offline: true });

async function connection(handle: string, label: string) {
  const id = await insertConnection(w.services, {
    catalogId: 'homeassistant',
    burrowId: w.burrowId,
    label,
    handle,
    fields: { url: 'http://127.0.0.1:9' },
    secret: 'test-token',
  });
  return `connection:${id}`;
}

/** What the last health pass stored for a connection (`more`: what else its glance says). */
async function stored(thing: string, list: GlanceLine[] | null, more: Record<string, unknown> = {}) {
  const offline = list?.some((l) => l.offline);
  await w.services.db
    .update(catalogConnections)
    .set({
      glance: list
        ? { status: offline ? 'offline' : list.length ? 'bad' : 'ok', facts: [], lines: list, ...more }
        : { status: 'unknown', facts: [] },
      glanceAt: w.now(),
    })
    .where(eq(catalogConnections.id, thing.slice('connection:'.length)));
}

async function watch(thing: string, event: 'down' | 'back') {
  const { id: messageId } = await w.ok(IDS.mara, sendMessage, {
    conversationId: IDS.dmDusty,
    text: `Tell me when it goes ${event}.`,
  });
  const dispatchId = await w.turn(IDS.dusty, IDS.dmDusty, { messageId });
  const [dispatch] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!dispatch) throw new Error('Missing dispatch');
  const result = await thingWatchTool(
    { services: w.services, agentId: IDS.dusty, burrowId: w.burrowId, dispatch, onBehalfOf: {} },
    { action: 'start', thing, event },
  );
  if (result.status !== 'ok' || !result.watches[0]) throw new Error('Missing watch');
  return result.watches[0].id;
}

async function watchStatus(id: string) {
  return (await w.services.db.select().from(thingWatches).where(eq(thingWatches.id, id)))[0]?.status;
}

describe('the person’s Google account', () => {
  it('opens on a needed sign-in, holds while kept quiet, ends as back once signed in, and keeps a watch', async () => {
    const [mara] = await w.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
    const id = newId('connection');
    await w.services.db.insert(connections).values({
      id,
      accountId: mara?.accountId as string,
      provider: 'google',
      externalId: 'sub-google',
      email: 'mara@example.com',
      services: ['mail'],
      refreshTokenEnc: 'sealed',
      grantedAt: w.now(),
      status: 'active',
      createdAt: w.now(),
      updatedAt: w.now(),
    } as never);
    const thing = `connection:${id}`;
    const signedIn = (status: 'active' | 'needs_reauth') =>
      w.services.db.update(connections).set({ status }).where(eq(connections.id, id));
    const waiting = await watch(thing, 'down');
    await pass();
    await pass();
    // Signed in and fine: a watch on it isn't stopped as if Google were removed.
    expect(await watchStatus(waiting)).toBe('watching');

    await signedIn('needs_reauth');
    await pass();
    await pass();
    const incident = await open(thing);
    expect(incident).toMatchObject({ nature: 'problem', checkId: 'conn.signin' });

    // Kept quiet: it leaves the looks and stays open, not removed.
    await w.services.db.insert(quietWindows).values({
      id: 'qw_google',
      ownerId: w.burrowId,
      thingId: thing,
      startsAt: w.now(),
      endsAt: new Date(w.now().getTime() + 3 * MINUTE),
      createdAt: w.now(),
    });
    await pass();
    await pass();
    expect((await open(thing))?.id).toBe(incident?.id);
    // The window over, it still needs the sign-in: still open.
    await pass();
    await pass();
    expect((await open(thing))?.id).toBe(incident?.id);

    // Signed in again: two passes that see it fine end it as back, not as removed.
    await signedIn('active');
    await pass();
    await pass();
    const [ended] = (await incidentsOf(thing)).filter((r) => r.id === incident?.id);
    expect(ended?.endedAt).not.toBeNull();
    // Back, not removed: removed signs nothing.
    expect(await backs(thing)).toHaveLength(1);
    expect(await watchStatus(waiting)).toBe('watching');
  });
});

describe('Website feedback', () => {
  it('keeps a watch on it while it is on here', async () => {
    await w.ok(IDS.mara, createFeedbackIntegration, integrationSettings());
    const waiting = await watch(FEEDBACK_THING_ID, 'down');
    await pass();
    await pass();
    expect(await watchStatus(waiting)).toBe('watching');
  });
});

describe('a server whose critical alert the person ignored', () => {
  it('keeps its incident while the disk still fails, and ends it when the alert resolves', async () => {
    const thing = 'server:granite';
    fake.openAlert({
      id: 'al_granite_disk',
      server: 'granite',
      rule: 'disk.smart_failing',
      severity: 'critical',
      title: 'A disk is failing',
      entity: 'disk:sda',
    });
    await pass();
    await pass();
    const incident = await open(thing);
    expect(incident).toMatchObject({ nature: 'problem' });
    // Ignored on its page: the server's dot is fine, its look goes, the disk still fails.
    await hostsFor(w.services).call({
      method: 'POST',
      path: `${HOSTS_API}/alerts/al_granite_disk/ack`,
      body: {},
      actor: { id: IDS.mara, name: 'Mara', role: 'operator' },
    });
    for (let i = 0; i < 3; i++) await pass();
    expect((await open(thing))?.id).toBe(incident?.id);
    expect(await backs(thing)).toEqual([]);
    fake.resolveAlert('al_granite_disk');
    await pass();
    await pass();
    expect(await open(thing)).toBeUndefined();
    expect(await backs(thing)).toHaveLength(1);
  });
});

describe('a server whose ignored alert has nothing to do with its outage', () => {
  /** The server stops reporting (its offline alert opens), or reports again. */
  function power(server: string, on: boolean) {
    const card = (fake.fleet.servers as Record<string, unknown>[]).find((s) => s.id === server);
    if (!card) throw new Error(`Missing ${server}`);
    if (on) {
      Object.assign(card, { status: 'online', agent_connected: true });
      fake.resolveAlert(`al_${server}_offline`);
      return;
    }
    Object.assign(card, { status: 'offline', agent_connected: false });
    fake.openAlert({
      id: `al_${server}_offline`,
      server,
      rule: 'agent.heartbeat_missing',
      severity: 'critical',
      title: `${server} isn’t reporting`,
    });
  }

  it('ends its offline incident with thing.back once it answers again', async () => {
    const thing = 'server:obsidian';
    fake.openAlert({
      id: 'al_obsidian_disk',
      server: 'obsidian',
      rule: 'disk.smart_failing',
      severity: 'critical',
      title: 'A disk is failing',
      entity: 'disk:sdb',
    });
    await hostsFor(w.services).call({
      method: 'POST',
      path: `${HOSTS_API}/alerts/al_obsidian_disk/ack`,
      body: {},
      actor: { id: IDS.mara, name: 'Mara', role: 'operator' },
    });
    await pass();
    await pass();
    expect(await open(thing)).toBeUndefined();
    // It loses power: an outage of its own, about its being offline.
    power('obsidian', false);
    await pass();
    await pass();
    expect(await open(thing)).toMatchObject({ nature: 'down' });
    // Back, its failing disk still ignored: the outage is over.
    power('obsidian', true);
    await pass();
    await pass();
    expect(await open(thing)).toBeUndefined();
    expect(await backs(thing)).toHaveLength(1);
    fake.resolveAlert('al_obsidian_disk');
  });
});

describe('a connection Whombat couldn’t read', () => {
  it('isn’t back while the details that found the fault weren’t read', async () => {
    const thing = await connection('nextcloud', 'Nextcloud');
    const disk = line('machine.disk', 'The disk is almost full');
    await stored(thing, [disk]);
    await pass();
    await pass();
    const incident = await open(thing);
    expect(incident).toMatchObject({ checkId: 'machine.disk' });
    // It answers, and its reader fails: the disk wasn't read.
    await stored(thing, [], { readFailedSince: w.now().toISOString() });
    for (let i = 0; i < 3; i++) await pass();
    expect((await open(thing))?.id).toBe(incident?.id);
    // The details are read again, but not the machine's disk: its line is the one kept from before.
    await w.services.db.insert(noticeStates).values({
      thingId: thing,
      checkId: 'machine.disk',
      subject: '',
      firstSeen: new Date(w.now().getTime() - 10 * MINUTE),
      lastSeen: new Date(w.now().getTime() - 5 * MINUTE),
      seenPasses: 2,
      tone: 'bad',
    });
    await stored(thing, []);
    for (let i = 0; i < 3; i++) await pass();
    expect((await open(thing))?.id).toBe(incident?.id);
    expect(await backs(thing)).toEqual([]);
    // Read fine: the pass drops the line's state, and two such passes end it.
    await w.services.db.delete(noticeStates).where(eq(noticeStates.thingId, thing));
    await pass();
    await pass();
    expect(await open(thing)).toBeUndefined();
    expect(await backs(thing)).toHaveLength(1);
  });

  it('opens from the first bad pass when a pass in between couldn’t read it', async () => {
    const thing = await connection('jellyfin', 'Jellyfin');
    await stored(thing, [NOT_ANSWERING]);
    await pass();
    const first = w.now();
    // Its check couldn't run.
    await stored(thing, null);
    await pass();
    await stored(thing, [NOT_ANSWERING]);
    await pass();
    expect((await open(thing))?.startedAt).toEqual(first);
  });

  it('counts three blind hours neither as down nor against the push', async () => {
    const thing = await connection('lidarr', 'Lidarr');
    await stored(thing, [NOT_ANSWERING]);
    await pass();
    const first = w.now();
    // Its runner stops reporting for three hours.
    await stored(thing, null);
    await pass();
    w.advance(180 * MINUTE);
    await pass();
    const blind = w.now();
    await stored(thing, [NOT_ANSWERING]);
    await pass();
    const incident = await open(thing);
    expect(incident).toMatchObject({ startedAt: first, downSince: blind });
    for (let i = 0; i < 9; i++) await pass();
    expect((await open(thing))?.pushGroup).not.toBeNull();
  });
});

describe('a thing that answers again while a problem keeps its outage open', () => {
  it('stops counting down time, says what is wrong now in its push, and counts a second stop', async () => {
    const thing = await connection('sabnzbd', 'SABnzbd');
    await stored(thing, [NOT_ANSWERING]);
    await pass();
    const start = w.now();
    await pass();
    expect(await open(thing)).toMatchObject({ nature: 'down', startedAt: start });
    // It answers again; its disk is almost full.
    await stored(thing, [line('machine.disk', 'The disk is almost full')]);
    await pass();
    const answered = w.now();
    expect((await open(thing))?.downStretches).toEqual([
      { from: start.toISOString(), to: answered.toISOString() },
    ]);
    for (let i = 0; i < 8; i++) await pass();
    const incident = await open(thing);
    expect(incident?.pushGroup).not.toBeNull();
    const [pushed] = await w.services.db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupKey, `incident:${incident?.pushGroup}`));
    expect(pushed?.text).toMatch(/^SABnzbd: /);
    expect(pushed?.text).not.toContain('down');
    // It stops again, then answers and is fine: two stretches, each counted.
    await stored(thing, [NOT_ANSWERING]);
    await pass();
    await stored(thing, []);
    await pass();
    await pass();
    const [ended] = (await incidentsOf(thing)).filter((r) => r.id === incident?.id);
    expect(ended?.endedAt).not.toBeNull();
    expect(ended?.downStretches).toHaveLength(2);
    const said = await periodUptime(w.services, w.burrowId, thing, {
      now: w.now(),
      days: 7,
      timeZone: 'UTC',
    });
    expect(said?.uptime).toMatchObject({ downs: 2, downMinutes: 3 });
  });
});

describe('one outage, one buzz', () => {
  async function research(thing: string, name: string) {
    const started = await w.ok(IDS.dusty, startResearch, {
      look: {
        key: thing,
        kind: 'server',
        name,
        rank: 0,
        reason: 'Not answering',
        question: null,
        check: null,
        subject: '',
        since: null,
        lines: [],
      },
      personId: IDS.mara,
    });
    if (!started) throw new Error('Missing research');
    return started;
  }

  async function report(dispatchId: string) {
    await w.ok(IDS.dusty, reportLook, {
      dispatchId,
      report: {
        title: 'It lost power',
        summary: 'It lost power after the storm.',
        fixed: false,
        fix: { label: 'Wake it', step: 'Send it a wake-on-LAN packet.' },
      },
    });
    await w.settle();
  }

  it('doesn’t push an outage a research finding pushed about meanwhile', async () => {
    const thing = 'server:onyx';
    const signer = await serversPrincipal(w.services, w.burrowId);
    await w.ok(signer, incidentsPass, {
      opened: [
        {
          thing,
          kind: 'server',
          name: 'onyx',
          nature: 'down',
          words: 'Not answering',
          check: null,
          subject: '',
          cause: null,
          startedAt: w.now().toISOString(),
        },
      ],
      changed: [],
      ended: [],
    });
    const incident = await open(thing);
    const { researchId, dispatchId } = await research(thing, 'onyx');
    await report(dispatchId);
    const [finding] = await w.services.db
      .select()
      .from(lookResearches)
      .where(eq(lookResearches.id, researchId));
    expect(finding?.pushedAt).not.toBeNull();
    // The watcher had planned the push before the finding went out.
    expect(await w.ok(signer, incidentsPush, { ids: [incident?.id ?? ''] })).toEqual({ pushed: 0 });
    expect((await open(thing))?.pushedAt).toBeNull();
  });

  it('keeps a late finding in the Inbox without a second buzz', async () => {
    const control = w.services.push.control;
    const deliver = vi.fn(async () => {});
    w.services.push.control = deliver;
    try {
      const findingRows = () =>
        w.services.db.select().from(notifications).where(like(notifications.dedupKey, 'look-finding:%'));
      const outage = async (thing: string, name: string) => {
        const signer = await serversPrincipal(w.services, w.burrowId);
        await w.ok(signer, incidentsPass, {
          opened: [
            {
              thing,
              kind: 'server',
              name,
              nature: 'down',
              words: 'Not answering',
              check: null,
              subject: '',
              cause: null,
              startedAt: w.now().toISOString(),
            },
          ],
          changed: [],
          ended: [],
        });
        return open(thing);
      };
      // The outage of flint was pushed ten minutes in; the research's finding comes after.
      const flint = await outage('server:flint', 'flint');
      const signer = await serversPrincipal(w.services, w.burrowId);
      await w.ok(signer, incidentsPush, { ids: [flint?.id ?? ''] });
      await w.settle();
      deliver.mockClear();
      const late = await research('server:flint', 'flint');
      await report(late.dispatchId);
      const held = (await findingRows()).find((r) => r.dedupKey === `look-finding:${late.researchId}`);
      expect(held).toBeDefined();
      expect(deliver).not.toHaveBeenCalled();
      // Quartz's outage wasn't pushed: its finding buzzes.
      await outage('server:quartz', 'quartz');
      const first = await research('server:quartz', 'quartz');
      await report(first.dispatchId);
      const buzzed = (await findingRows()).find((r) => r.dedupKey === `look-finding:${first.researchId}`);
      expect(deliver).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ notificationId: buzzed?.id }),
        expect.anything(),
      );
    } finally {
      w.services.push.control = control;
    }
  });

  it('holds a finding’s buzz when the outage that buzzed ended while the research was underway', async () => {
    const control = w.services.push.control;
    const deliver = vi.fn(async () => {});
    w.services.push.control = deliver;
    try {
      const signer = await serversPrincipal(w.services, w.burrowId);
      const findingOf = async (researchId: string) =>
        (
          await w.services.db
            .select()
            .from(notifications)
            .where(like(notifications.dedupKey, 'look-finding:%'))
        ).find((r) => r.dedupKey === `look-finding:${researchId}`);
      const pushedOutage = async (thing: string) => {
        await w.ok(signer, incidentsPass, {
          opened: [
            {
              thing,
              kind: 'server',
              name: thing.slice('server:'.length),
              nature: 'down',
              words: 'Not answering',
              check: null,
              subject: '',
              cause: null,
              startedAt: w.now().toISOString(),
            },
          ],
          changed: [],
          ended: [],
        });
        const row = await open(thing);
        await w.ok(signer, incidentsPush, { ids: [row?.id ?? ''] });
        await w.settle();
        return row?.id ?? '';
      };
      const end = (id: string) =>
        w.ok(signer, incidentsPass, {
          opened: [],
          changed: [],
          ended: [{ id, endedAt: w.now().toISOString() }],
        });

      // Slate's outage buzzed; it comes back while the research looks into it, and the finding comes after.
      const slate = await pushedOutage('server:slate');
      deliver.mockClear();
      const late = await research('server:slate', 'slate');
      w.advance(MINUTE);
      await end(slate);
      await report(late.dispatchId);
      const held = await findingOf(late.researchId);
      expect(held).toBeDefined();
      // Only the outage's push was cleared quietly when it ended.
      expect(deliver).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ notificationId: held?.id }),
        expect.anything(),
      );

      // Basalt's outage ended before its research began: that finding buzzes.
      const basalt = await pushedOutage('server:basalt');
      await end(basalt);
      w.advance(MINUTE);
      deliver.mockClear();
      const fresh = await research('server:basalt', 'basalt');
      await report(fresh.dispatchId);
      expect(deliver).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ notificationId: (await findingOf(fresh.researchId))?.id }),
        expect.anything(),
      );
    } finally {
      w.services.push.control = control;
    }
  });

  it('lets a newer outage buzz after a finding held beside an older one', async () => {
    const control = w.services.push.control;
    const deliver = vi.fn(async () => {});
    w.services.push.control = deliver;
    try {
      const signer = await serversPrincipal(w.services, w.burrowId);
      const findingOf = async (researchId: string) =>
        (
          await w.services.db
            .select()
            .from(notifications)
            .where(eq(notifications.dedupKey, `look-finding:${researchId}`))
        )[0];
      const buzzed = (id: string | undefined) =>
        deliver.mock.calls.some(
          (c) => ((c as unknown[])[1] as { notificationId?: string } | undefined)?.notificationId === id,
        );
      const outage = async (thing: string, startedAt = w.now()) => {
        await w.ok(signer, incidentsPass, {
          opened: [
            {
              thing,
              kind: 'server',
              name: thing.slice('server:'.length),
              nature: 'down',
              words: 'Not answering',
              check: null,
              subject: '',
              cause: null,
              startedAt: startedAt.toISOString(),
            },
          ],
          changed: [],
          ended: [],
        });
        return (await open(thing))?.id ?? '';
      };
      const end = (id: string) =>
        w.ok(signer, incidentsPass, {
          opened: [],
          changed: [],
          ended: [{ id, endedAt: w.now().toISOString() }],
        });

      // Jasper's first outage buzzed and ended while the research looked; the finding stays quiet beside it.
      const first = await outage('server:jasper');
      await w.ok(signer, incidentsPush, { ids: [first] });
      const looked = await research('server:jasper', 'jasper');
      w.advance(MINUTE);
      await end(first);
      w.advance(MINUTE);
      const badFrom = w.now();
      w.advance(MINUTE);
      deliver.mockClear();
      await report(looked.dispatchId);
      expect(buzzed((await findingOf(looked.researchId))?.id)).toBe(false);
      // Its next outage, bad from before the finding came, still pushes.
      const second = await outage('server:jasper', badFrom);
      expect(await w.ok(signer, incidentsPush, { ids: [second] })).toEqual({ pushed: 1 });

      // Agate's next outage opened before the finding came and hasn't buzzed: the finding buzzes for it, once.
      const earlier = await outage('server:agate');
      await w.ok(signer, incidentsPush, { ids: [earlier] });
      const asked = await research('server:agate', 'agate');
      w.advance(MINUTE);
      await end(earlier);
      w.advance(MINUTE);
      const next = await outage('server:agate');
      deliver.mockClear();
      await report(asked.dispatchId);
      expect(buzzed((await findingOf(asked.researchId))?.id)).toBe(true);
      expect(await w.ok(signer, incidentsPush, { ids: [next] })).toEqual({ pushed: 0 });
    } finally {
      w.services.push.control = control;
    }
  });
});

describe('a delayed automation', () => {
  function definition(thing: string) {
    return {
      version: 1,
      conversationId: IDS.incidents,
      triggers: [{ kind: 'thing', event: 'down', thing, forMinutes: 10 }],
      steps: [{ id: 'note', kind: 'post_message', text: '{{trigger.name}} is still down' }],
    } satisfies AutomationDefinitionInput;
  }

  async function opened(thing: string) {
    const signer = await serversPrincipal(w.services, w.burrowId);
    await w.ok(signer, incidentsPass, {
      opened: [
        {
          thing,
          kind: 'connection',
          name: 'Radarr',
          nature: 'down',
          words: 'Not answering',
          check: 'conn.answers',
          subject: '',
          cause: null,
          startedAt: w.now().toISOString(),
        },
      ],
      changed: [],
      ended: [],
    });
    const [row] = await w.services.db
      .select()
      .from(incidents)
      .where(and(eq(incidents.thingId, thing), eq(incidents.startedAt, w.now())));
    if (!row) throw new Error('Missing incident');
    return row.id;
  }

  async function window(id: string, thing: string, minutes: number, undoneAfter?: number) {
    await w.services.db.insert(quietWindows).values({
      id,
      ownerId: w.burrowId,
      thingId: thing,
      startsAt: w.now(),
      endsAt: new Date(w.now().getTime() + minutes * MINUTE),
      ...(undoneAfter ? { endedAt: new Date(w.now().getTime() + undoneAfter * MINUTE) } : {}),
      createdAt: w.now(),
    });
  }

  it('starts at its deadline after a short or undone window, and not while one holds then', async () => {
    const thing = await connection('radarr', 'Radarr');
    const id = await w.publish(definition(thing), { name: 'Radarr stays down' });
    await stored(thing, [NOT_ANSWERING]);

    const first = await opened(thing);
    await w.settle();
    w.advance(2 * MINUTE);
    await window('qw_radarr_short', thing, 2);
    w.advance(2 * MINUTE);
    await window('qw_radarr_undone', thing, 60, 1);
    w.advance(7 * MINUTE);
    await w.settle();
    expect(await w.runs(id)).toHaveLength(1);
    await w.ok(await serversPrincipal(w.services, w.burrowId), incidentsPass, {
      opened: [],
      changed: [],
      ended: [{ id: first, endedAt: w.now().toISOString() }],
    });

    // Kept quiet over the deadline: it doesn't start.
    w.advance(MINUTE);
    await opened(thing);
    await w.settle();
    w.advance(5 * MINUTE);
    await window('qw_radarr_over', thing, 30);
    w.advance(6 * MINUTE);
    await w.settle();
    expect(await w.runs(id)).toHaveLength(1);
  });
});
