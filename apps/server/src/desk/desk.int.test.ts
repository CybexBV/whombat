/**
 * The desk screen against a real database (docs/decisions/desk-display-server.md): it needs Postgres because pairing,
 * the PIN, the settings, the switch and pairing itself are commands in `desk_screens` and `desk_display`, the wait
 * after five wrong PINs must survive a restart, the screen decides real approvals through the pipeline, the power,
 * wrong-PIN and paired-itself messages are posted in the person's chat with their assistant, with what the person last
 * heard kept in `burrows.host_power_alert`, the PIN's length
 * and the camera's switch are migration 0124's columns, written by those commands, the voice is 0125's, which the
 * screen's talk reads to answer in it, and *Lock again*, the camera for the clock and the boot an unlock that stays was
 * made on are 0126's, the boot written and forgotten by commands and read by a runtime that starts again. Found on your
 * network (desk-found.md DF-02…DF-07) keeps the burrow's first scan, the assistant's telling and Not now in 0127's
 * `connection_found_state`, and the assistant's message is posted in the person's chat. A server's screen
 * (desk-display.md DK-83…DK-86) is shown by what the paired person chose in `desk_screens`. What the screen shows and
 * the Whombat's name (DK-102, DK-119) are migration 0010's `desk_screens.show` and `desk_display.whombat_name`, written
 * by commands, the name kept past an unpairing. The screens of widgets (DK-126…DK-149) are migration 0013's `screens`:
 * a layout saved and read back, a monitor's row made when the page reports it and kept after it's unplugged.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DESK_TALK_TEXT_MAX,
  DeskServerPage,
  DeskServersAnswer,
  DeskState,
  DeskTalkSession,
  deskServerPageValid,
  deskStateValid,
  deskTalkSessionValid,
} from '@whombat/control-contracts/local';
import {
  DEFAULT_DESK_SHOW,
  DEFAULT_DESK_VOICE,
  DESK_TRY_S,
  DESK_VOICES,
  DeskCalm,
  DeskCatalog,
  type DeskDisplay,
  DeskGrid,
  type DeskLayout,
  DeskPreview,
  DeskScreen,
  DeskScreenDetail,
  DeskScreensList,
  deskDefaultLayout,
  deskLockAgainPatch,
  newId,
  topics,
} from '@whombat/core';
import {
  DeskScreenAddPageOutput,
  DeskScreenViews,
  DeskVoiceSample,
  SCREEN_TIMES_MINOR,
} from '@whombat/protocol/session';
import { and, asc, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { approvalActionHash } from '../approvals/create';
import { threadedRoom } from '../chats/rooms';
import { sendMessage } from '../commands/messages';
import { callArgsAad, newCallId } from '../connections/call';
import { burrowFound, DISCOVERY_PORTS } from '../connections/discover';
import { useDiscoveryNetForTests } from '../connections/finder';
import { FOUND_EVERY_MS, foundScansFor, foundStateOf } from '../connections/found-scans';
import {
  applianceState,
  approvals,
  burrows,
  catalogConnections,
  deskDisplay,
  deskScreens,
  dispatches,
  events,
  widgets as homeWidgetRows,
  lookResearches,
  messages,
  needsYouSnoozes,
  principals,
  screens,
} from '../db/schema/index';
import { serversPrincipal } from '../hosts/principal';
import { HostsService, setHostsFor } from '../hosts/service';
import { FakeHostsService } from '../hosts/testing/fake';
import type { HostMetricsService } from '../managed/host-metrics';
import { opaqueRef, resolvePushRef } from '../managed/push';
import { SessionOpError } from '../managed/session-error';
import { sampleHostMetrics, type TestIdentity } from '../managed/testing';
import type { SessionPrincipal } from '../managed/trust';
import { loadConversationRow } from '../read/conversations';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { insertConnection } from '../test/connections';
import { TEST_APP_URL } from '../test/harness';
import { useManagedRuntime } from '../test/managed';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { emitDoorbellRing } from '../things/kinds/home/doorbell';
import { parseWav, setVoiceFor, VoiceCallError } from '../voice/speech';
import { updateVoiceTyping } from '../voice/store';
import { FAKE_SPEECH_RATE, FakeVoice, fakeRecording } from '../voice/testing/fake-voice';
import { NO_DISPLAY } from './hardware';
import { PAIRING_TRIES, PRESENCE_GONE_MS, UNLOCK_IDLE_MS } from './lock';
import { hashPin, verifyPin } from './pin';
import { HostPower, POWER_OUT_AFTER_MS } from './power';
import { CONSOLE_ASKED_MS, PRESENCE_CHECK_MS, setPresenceFor } from './presence';
import { unlockPushWhat } from './push-link';
import { DeskRefused, DeskService } from './service';
import type { DeskPower } from './shapes';
import { loadDeskRow, loadScreenChoice, loadWhombatName, pairDesk, pairDeskItself } from './store';
import { createDeskTalk, deskClientId, deskTurnOf } from './talk';
import { tellPerson } from './tell';
import { FakePresence } from './testing/fake-presence';
import { FakeTime } from './testing/fake-time';
import { homeWidgetView, screenHomeWidgets } from './widgets/home';
import type { ScreenRecord, ThingWidgets } from './widgets/types';

const m = useManagedRuntime({ seed: true });
/** A request made here carries the hash of its own action, as every request does (an approval without one is refused). */
const withHash = (row: typeof approvals.$inferInsert): typeof approvals.$inferInsert => ({
  ...row,
  actionHash: approvalActionHash(row.action, null, null),
});
let maras: PersonalSetup;
let mara: SessionPrincipal;
/** Mara's enrolled device, for the session ops a client sends. */
let maraDevice: TestIdentity;
let desk: DeskService;
/** The desk's power reading (the manager's, `power` below). */
let hostPower: HostPower;
/** The boot this runtime runs on (DK-75). */
const THIS_BOOT = '5d0c4a528e0b4b8e9a430a6b0e1c2f3d';
let now = Date.parse('2026-10-20T12:34:00.000Z');
let power: DeskPower | null = null;
const pushes: { kind: string; what: string; clear: boolean; title: string | null }[] = [];
const changed: string[] = [];
/** What is plugged in (DK-16): nothing until a test plugs something in. */
let plugged: DeskDisplay = NO_DISPLAY;
const MONITOR: DeskDisplay = { connected: true, real: true, builtIn: false, name: 'DELL U2720Q' };
const VM_SCREEN: DeskDisplay = { connected: true, real: false, builtIn: false, name: 'QEMU Monitor' };
/** The camera's checks run on the test's clock (DK-S37), against the fake presence service. */
const time = new FakeTime(
  () => now,
  (ms) => {
    now = ms;
  },
);
const camera = new FakePresence(() => now);
/** The next PIN check waits until the test lets it go (DK-S22's race). */
let pinHold: { started: () => void; until: Promise<void> } | null = null;

function holdNextPin(): { started: Promise<void>; release: () => void } {
  let release = () => {};
  let started = () => {};
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  pinHold = { started, until };
  return { started: begun, release };
}

const principal = (accountId: string) =>
  ({
    account: { id: accountId },
    peerId: 'p',
    publicKey: 'k',
    endpoint: null,
    authzGeneration: 1,
  }) as unknown as SessionPrincipal;

/** What the assistant said in Mara's chat (or `whose`) that has `phrase` in it. */
async function said(phrase: string | RegExp, whose: PersonalSetup = maras): Promise<string[]> {
  const rows = await m.t.services.db
    .select({ text: messages.text })
    .from(messages)
    .where(and(eq(messages.conversationId, whose.dmId), eq(messages.authorId, whose.agentId)))
    .orderBy(asc(messages.createdAt));
  return rows
    .map((r) => r.text)
    .filter((t) => (typeof phrase === 'string' ? t.includes(phrase) : phrase.test(t)));
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; details: unknown }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SessionOpError) return { code: err.code, details: err.details };
    if (err instanceof DeskRefused) return { code: err.code, details: err.status };
    throw err;
  }
  throw new Error('expected a refusal');
}

beforeAll(async () => {
  const services = m.t.services;
  services.clock = () => new Date(now);
  setPresenceFor(services, camera);
  maras = await addPersonalAgent(services, TEST_BURROW_ID, IDS.mara, { services: null });
  maraDevice = await m.enroll(IDS.mara);
  mara = principal((maraDevice as TestIdentity & { accountId: string }).accountId);
  const host = {
    read: async () => ({
      metrics: power
        ? { ...sampleHostMetrics(), now: { ...sampleHostMetrics().now, power } }
        : sampleHostMetrics(),
      reason: null,
    }),
  } as unknown as HostMetricsService;
  hostPower = new HostPower(services, host);
  desk = new DeskService(services, {
    power: hostPower,
    bootId: THIS_BOOT,
    display: { display: async () => plugged, connected: async () => plugged.connected },
    push: {
      forAccounts: async (_accounts, kind, what, options) => {
        pushes.push({ kind, what, clear: !!options?.clear, title: options?.preview?.title ?? null });
      },
    },
    // An answer counts 20 ms after the assistant's message (DK-T06's 15 s), so a test sees it spoken.
    talk: (s, host) => createDeskTalk(s, host, { timings: { settleMs: 20 } }),
    random: (() => {
      let n = 0;
      return (size: number) => Uint8Array.from({ length: size }, () => n++ % 20);
    })(),
    after: time.after,
    verifyPin: async (pin, stored) => {
      const hold = pinHold;
      pinHold = null;
      if (hold) {
        hold.started();
        await hold.until;
      }
      return verifyPin(pin, stored);
    },
  });
  services.bus.onFrame((f) => {
    if ((f.event as { type: string }).type === 'desk.changed') changed.push(f.topic);
  });
});
afterAll(() => desk.close());

describe('pairing the screen (DK-02)', () => {
  it('leaves an unpaired box as it was', async () => {
    const state = DeskState.parse(await desk.state());
    expect(deskStateValid(state)).toBe(true);
    expect(state).toMatchObject({ paired: null, glance: null, pairing: null, lock: { state: 'locked' } });
    expect((await desk.screen(mara)).paired).toBeNull();
  });

  it('pairs to the person who types the letters on the screen', async () => {
    const { expiresAt } = await desk.startPairing(mara);
    expect(Date.parse(expiresAt)).toBe(now + 10 * 60_000);
    expect(changed).toContain(topics.me(IDS.mara));
    const code = (await desk.state()).pairing?.code as string;
    expect(code).toMatch(/^[A-Z]{4}$/);
    const wrong = await refusal(desk.pair(mara, { code: code === 'ABCD' ? 'ABCE' : 'ABCD', pin: '135790' }));
    expect(wrong).toEqual({
      code: 'forbidden',
      details: { code: 'wrong_code', triesLeft: PAIRING_TRIES - 1 },
    });
    const screen = await desk.pair(mara, { code, pin: '135790' });
    expect(screen.paired).toMatchObject({ personId: IDS.mara });
    expect(screen.settings).toMatchObject({ lockedView: 'summary', stayUnlocked: false, cameraWake: false });
    const row = await loadDeskRow(m.t.services.db);
    expect(row).toMatchObject({ burrowId: TEST_BURROW_ID, personId: IDS.mara, wrongPins: 0 });
    expect(row?.pinHash).not.toContain('135790');
    const [event] = await m.t.services.db.select().from(events).where(eq(events.type, 'desk.paired'));
    expect(event?.actorId).toBe(IDS.mara);
    expect((await desk.state()).pairing).toBeNull();
    expect((await refusal(desk.pair(mara, { code, pin: '135790' }))).details).toEqual({
      code: 'pairing_expired',
    });
  });

  it('lets the paired person change the PIN and settings', async () => {
    const screen = await desk.update(mara, { lockedView: 'everything', night: 'black' });
    expect(screen.settings).toMatchObject({ lockedView: 'everything', night: 'black', voice: true });
    await desk.update(mara, { lockedView: 'summary' });
  });
});

describe('what the screen shows (DK-03)', () => {
  it('shows the person, their assistant and a summary while locked', async () => {
    const state = DeskState.parse(await desk.state());
    expect(deskStateValid(state)).toBe(true);
    expect(state.paired).toMatchObject({ person: { name: 'Mara', initial: 'M' }, lockedView: 'summary' });
    expect(state.paired?.assistant.name).toBe('Dusty');
    // The seeded staging deploy waits for Mara: counted, not named.
    expect(state.glance?.needsYou.count).toBeGreaterThanOrEqual(1);
    expect(state.glance?.needsYou.items).toEqual([]);
    expect(JSON.stringify(state.glance)).not.toContain('invoice');
    expect(state.talk).toBeNull();
  });
});

describe('unlocking (DK-04)', () => {
  it('waits after five wrong PINs, says so in Chat once, and the wait survives', async () => {
    for (let i = 1; i < 5; i++)
      expect(await desk.unlock('000000')).toEqual({ v: 1, result: 'wrong', triesLeft: 5 - i });
    const fifth = await desk.unlock('000000');
    expect(fifth).toMatchObject({ result: 'backoff' });
    expect(Date.parse(fifth.retryAt as string)).toBe(now + 60_000);
    // Even the right PIN waits; the wait is in the database, not the process.
    expect((await desk.unlock('135790')).result).toBe('backoff');
    expect((await loadDeskRow(m.t.services.db))?.wrongPins).toBe(5);
    expect((await desk.state()).lock.state).toBe('backoff');
    await m.t.services.background.settle();
    expect(await said('wrong PIN')).toHaveLength(1);
    now += 61_000;
    expect((await desk.unlock('000001')).retryAt).toBe(new Date(now + 120_000).toISOString());
    now += 121_000;
    expect(await desk.unlock('135790')).toEqual({ v: 1, result: 'unlocked' });
    expect((await loadDeskRow(m.t.services.db))?.wrongPins).toBe(0);
    expect(await said('wrong PIN')).toHaveLength(1);
  });

  it('shows everything while unlocked, and the risky asks say why and that the PIN approves them', async () => {
    const state = DeskState.parse(await desk.state());
    expect(deskStateValid(state)).toBe(true);
    expect(state.lock.state).toBe('unlocked');
    const deploy = state.glance?.needsYou.items.find((i) => i.number === 12);
    expect(deploy).toMatchObject({
      kind: 'approval',
      onDesk: false,
      phoneReason: 'release',
      approveWithPin: true,
      deny: true,
    });
    expect(deploy?.detail).toBeTruthy();
    desk.lockNow();
    expect((await desk.state()).lock.state).toBe('locked');
    expect((await refusal(Promise.resolve().then(() => desk.touch()))).code).toBe('locked');
  });

  it('asks the phone once, and the person’s answer unlocks', async () => {
    const first = await desk.unlockPhone();
    const again = await desk.unlockPhone();
    expect(again.expiresAt).toBe(first.expiresAt);
    const asked = pushes.filter((p) => !p.clear);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: 'security', title: expect.stringContaining('desk screen') });
    const screen = await desk.screen(mara);
    expect(screen.unlockRequest?.expiresAt).toBe(first.expiresAt);
    expect(
      (await desk.screen({ ...mara, account: { id: 'acc_other' } } as SessionPrincipal)).unlockRequest,
    ).toBeNull();
    // A tap on the push opens This Whombat, for Mara only (DK-S21).
    const pushRef = opaqueRef(
      'ref',
      unlockPushWhat(screen.unlockRequest?.id as string),
      m.t.services.config.WHOMBAT_MASTER_KEY,
    );
    expect(await resolvePushRef(m.t.services, mara.account?.id as string, pushRef)).toEqual({
      burrow: 'burrow-hq',
      link: { type: 'external', url: `${TEST_APP_URL}/settings?tab=appliance` },
    });
    await desk.answerUnlock(mara, { id: screen.unlockRequest?.id as string, unlock: true });
    expect((await desk.state()).lock.state).toBe('unlocked');
    expect(pushes.filter((p) => p.clear)).toHaveLength(1);
    const late = await refusal(
      desk.answerUnlock(mara, { id: screen.unlockRequest?.id as string, unlock: true }),
    );
    expect(late.details).toEqual({ code: 'request_expired' });
  });

  it('unlocks only the pairing and PIN a PIN was checked against (DK-S22)', async () => {
    desk.lockNow();
    // A pairing that lands while the PIN is checked: the old PIN is checked again, against the new one.
    let held = holdNextPin();
    const early = desk.unlock('135790');
    await held.started;
    const res = await m.t.services.pipeline.commit(
      pairDesk,
      { pinHash: await hashPin('246802'), pinDigits: 6 },
      { burrowId: TEST_BURROW_ID, actorId: IDS.mara },
    );
    expect(res.status).toBe('ok');
    held.release();
    expect(await early).toEqual({ v: 1, result: 'wrong', triesLeft: 4 });
    expect((await desk.state()).lock.state).toBe('locked');
    // Pairing again waits for a PIN being checked, then starts locked: that PIN doesn't carry over.
    await desk.startPairing(mara);
    const code = (await desk.state()).pairing?.code as string;
    const order: string[] = [];
    held = holdNextPin();
    const checking = desk.unlock('246802').then((a) => {
      order.push(`unlock ${a.result}`);
    });
    await held.started;
    const paired = desk.pair(mara, { code, pin: '135790' }).then(() => {
      order.push('paired');
    });
    held.release();
    await Promise.all([checking, paired]);
    expect(order).toEqual(['unlock unlocked', 'paired']);
    expect((await desk.state()).lock.state).toBe('locked');
    expect((await desk.unlock('246802')).result).toBe('wrong');
    expect(await desk.unlock('135790')).toEqual({ v: 1, result: 'unlocked' });
    expect((await loadDeskRow(m.t.services.db))?.wrongPins).toBe(0);
  });
});

describe('answering on the screen (DK-05, DK-61, DK-62)', () => {
  it('decides an everyday ask as the person, once; a deploy not without the PIN', async () => {
    const [seeded] = await m.t.services.db.select().from(approvals).where(eq(approvals.number, 12));
    if (!seeded) throw new Error('no seeded approval');
    await m.t.services.db.insert(approvals).values(
      withHash({
        ...seeded,
        id: 'apr_desk-ci',
        number: 901,
        keyId: 'ci.run',
        action: { type: 'custom', params: { name: 'Run CI', keyId: 'ci.run', data: {} } },
        title: 'Run CI on feat/invoice-pdf',
        question: 'Run CI on feat/invoice-pdf?',
        conditions: [
          {
            id: 'person',
            kind: 'person_approves',
            label: 'A person says yes',
            met: false,
            approverIds: [IDS.mara],
          },
        ],
      }),
    );
    desk.lock.unlock(now);
    await desk.refresh();
    const item = (await desk.state()).glance?.needsYou.items.find((i) => i.number === 901);
    expect(item).toMatchObject({ onDesk: true, approveLabel: 'Run CI on feat/invoice-pdf', deny: true });
    expect(item).not.toHaveProperty('approveWithPin');
    expect(await refusal(desk.decide(12, 'approve'))).toEqual({ code: 'pin_needed', details: 403 });
    expect(await refusal(desk.decide(4242, 'approve'))).toEqual({ code: 'not_found', details: 404 });
    expect(await desk.decide(901, 'approve')).toEqual({ v: 1, result: 'decided' });
    const [decided] = await m.t.services.db.select().from(approvals).where(eq(approvals.number, 901));
    expect(decided?.decidedById).toBe(IDS.mara);
    expect(await refusal(desk.decide(901, 'decline'))).toEqual({ code: 'decided', details: 409 });
    // Not now is Home's (DK-S19): snoozed for Mara until tomorrow at 09:00, still waiting for a decision.
    await m.t.services.db.insert(approvals).values(
      withHash({
        ...seeded,
        id: 'apr_desk-ci-2',
        number: 902,
        keyId: 'ci.run',
        action: { type: 'custom', params: { name: 'Run CI', keyId: 'ci.run', data: {} } },
        title: 'Run CI on main',
        question: 'Run CI on main?',
        conditions: [
          {
            id: 'person',
            kind: 'person_approves',
            label: 'A person says yes',
            met: false,
            approverIds: [IDS.mara],
          },
        ],
      }),
    );
    await desk.refresh();
    expect((await desk.state()).glance?.needsYou.items.map((i) => i.number)).toContain(902);
    expect(await desk.decide(902, 'decline')).toEqual({ v: 1, result: 'decided' });
    const [waiting] = await m.t.services.db.select().from(approvals).where(eq(approvals.number, 902));
    expect(waiting?.state).toBe('pending');
    const [snoozed] = await m.t.services.db
      .select()
      .from(needsYouSnoozes)
      .where(and(eq(needsYouSnoozes.personId, IDS.mara), eq(needsYouSnoozes.refId, '902')));
    expect(snoozed).toMatchObject({ refKind: 'approval', state: 'snoozed' });
    expect(snoozed?.until?.getTime()).toBeGreaterThan(now);
    expect((await desk.state()).glance?.needsYou.items.map((i) => i.number)).not.toContain(902);
    desk.lockNow();
    expect((await refusal(desk.decide(12, 'decline'))).code).toBe('locked');
  });

  it('offers the web card’s wider choice with the PIN and says who asks; one it doesn’t offer is refused (TF-14, TF-15)', async () => {
    const [seeded] = await m.t.services.db.select().from(approvals).where(eq(approvals.number, 12));
    if (!seeded) throw new Error('no seeded approval');
    for (const number of [906, 907])
      await m.t.services.db.insert(approvals).values({ ...seeded, id: `apr_desk-always-${number}`, number });
    desk.lock.unlock(now);
    await desk.refresh();
    const [requester] = await m.t.services.db
      .select()
      .from(principals)
      .where(eq(principals.id, seeded.requesterId));
    const item = (await desk.state()).glance?.needsYou.items.find((i) => i.number === 906);
    // Mara may change the requester's keys: “Always allow …” as on the web card, with the PIN; the asker named.
    expect(item).toMatchObject({ approveWithPin: true, choices: [{ scope: 'agent' }] });
    expect(item?.choices?.[0]?.label).toContain('Always allow');
    expect(item?.from).toBe(requester?.shortName || requester?.name);
    // Every wider choice needs the PIN; a scope the ask doesn't offer is refused before it.
    expect(await refusal(desk.decide(906, 'approve', undefined, 'agent'))).toEqual({
      code: 'pin_needed',
      details: 403,
    });
    expect(await refusal(desk.decide(906, 'approve', '135790', 'task'))).toEqual({
      code: 'not_offered',
      details: 403,
    });
    expect(await desk.decide(906, 'approve', '000000', 'agent')).toEqual({
      v: 1,
      result: 'wrong',
      triesLeft: 4,
    });
    expect(await desk.decide(906, 'approve', '135790', 'agent')).toEqual({ v: 1, result: 'decided' });
    const [decided] = await m.t.services.db.select().from(approvals).where(eq(approvals.number, 906));
    expect(decided).toMatchObject({ state: 'approved', scope: 'agent', decidedById: IDS.mara });
    // Locked, or on a screen without a PIN, the choice isn't there and isn't taken.
    const pinHash = (await loadDeskRow(m.t.services.db))?.pinHash ?? null;
    await m.t.services.db.update(deskScreens).set({ pinHash: null });
    await desk.refresh();
    expect((await desk.state()).glance?.needsYou.items.find((i) => i.number === 907)).not.toHaveProperty(
      'choices',
    );
    expect(await refusal(desk.decide(907, 'approve', '135790', 'agent'))).toEqual({
      code: 'not_offered',
      details: 403,
    });
    await m.t.services.db.update(deskScreens).set({ pinHash });
    const [still] = await m.t.services.db.select().from(approvals).where(eq(approvals.number, 907));
    expect(still?.state).toBe('pending');
    // Out of the way of the asks that come next.
    expect(await desk.decide(907, 'deny')).toEqual({ v: 1, result: 'decided' });
    await m.t.services.background.settle();
  });

  it('approves a risky ask with the PIN typed again, counted as an unlock’s; Deny needs none (DK-S60, DK-S61)', async () => {
    const [seeded] = await m.t.services.db.select().from(approvals).where(eq(approvals.number, 12));
    if (!seeded) throw new Error('no seeded approval');
    for (const number of [903, 904, 905])
      await m.t.services.db.insert(approvals).values({ ...seeded, id: `apr_desk-deploy-${number}`, number });
    desk.lock.unlock(now);
    await desk.refresh();
    const items = (await desk.state()).glance?.needsYou.items ?? [];
    expect(items.find((i) => i.number === 903)).toMatchObject({ onDesk: false, approveWithPin: true });
    expect(await refusal(desk.decide(903, 'approve'))).toEqual({ code: 'pin_needed', details: 403 });
    expect(await desk.decide(903, 'approve', '000000')).toEqual({ v: 1, result: 'wrong', triesLeft: 4 });
    expect((await loadDeskRow(m.t.services.db))?.wrongPins).toBe(1);
    expect(await desk.decide(903, 'approve', '135790')).toEqual({ v: 1, result: 'decided' });
    expect((await loadDeskRow(m.t.services.db))?.wrongPins).toBe(0);
    // Deny is Chat's no, as Mara.
    expect(await desk.decide(904, 'deny')).toEqual({ v: 1, result: 'decided' });
    const rows = await m.t.services.db.select().from(approvals).where(eq(approvals.burrowId, TEST_BURROW_ID));
    const by = (n: number) => rows.find((r) => r.number === n);
    expect(by(903)).toMatchObject({ state: 'approved', decidedById: IDS.mara });
    expect(by(904)).toMatchObject({ state: 'declined', decidedById: IDS.mara });
    // A screen without a PIN leaves the risky yes to the phone; its no still works.
    const pinHash = (await loadDeskRow(m.t.services.db))?.pinHash ?? null;
    await m.t.services.db.update(deskScreens).set({ pinHash: null });
    expect(await refusal(desk.decide(905, 'approve', '135790'))).toEqual({ code: 'on_phone', details: 403 });
    await m.t.services.db.update(deskScreens).set({ pinHash });
    // Five wrong PINs: the wait, and the screen locks where it shows (DK-S61).
    for (let i = 1; i < 5; i++) expect((await desk.decide(905, 'approve', '000000')).result).toBe('wrong');
    expect((await desk.decide(905, 'approve', '000000')).result).toBe('backoff');
    expect((await desk.state()).lock.state).toBe('backoff');
    expect(by(905)?.state).toBe('pending');
    now += 61_000;
    expect(await desk.unlock('135790')).toEqual({ v: 1, result: 'unlocked' });
    desk.lockNow();
  });
});

describe('a command on a server (DK-05, DK-S25)', () => {
  /** A Servers call that waits for Mara: `server_command` running `command` (or arguments nobody can read). */
  async function serverCommand(number: number, command: string | null): Promise<void> {
    const [seeded] = await m.t.services.db.select().from(approvals).where(eq(approvals.number, 12));
    if (!seeded) throw new Error('no seeded approval');
    const callId = newCallId();
    const call = {
      connectionId: 'con_desk-servers',
      handle: 'servers',
      tool: 'server_command',
      toolHash: 'a'.repeat(64),
    };
    await m.t.services.db.insert(approvals).values(
      withHash({
        ...seeded,
        id: `apr_desk-cmd-${number}`,
        number,
        keyId: 'connections.write',
        action: {
          type: 'connection_call',
          params: { ...call, words: 'run a command on blackbox' },
        },
        command: {
          name: 'call_connection_tool',
          input: {
            ...call,
            callId,
            argsEnc:
              command === null
                ? 'not-sealed'
                : m.t.services.custody.seal(
                    callArgsAad(callId),
                    JSON.stringify({ server: 'blackbox', command, reason: 'Plex stopped answering' }),
                  ),
            conversationId: seeded.conversationId,
          },
        },
        title: 'Run a command on blackbox',
        question: 'Run a command on blackbox?',
        conditions: [
          {
            id: 'person',
            kind: 'person_approves',
            label: 'A person says yes',
            met: false,
            approverIds: [IDS.mara],
          },
        ],
      }),
    );
  }

  it('reads the command: deleting needs the PIN; a restart is decided', async () => {
    await serverCommand(911, 'rm -rf /srv/backups');
    await serverCommand(912, 'docker restart plex');
    await serverCommand(913, null);
    desk.lock.unlock(now);
    await desk.refresh();
    const items = (await desk.state()).glance?.needsYou.items ?? [];
    const item = (n: number) => items.find((i) => i.number === n);
    expect(item(911)).toMatchObject({ onDesk: false, phoneReason: 'delete' });
    expect(item(912)).toMatchObject({ onDesk: true });
    expect(item(913)).toMatchObject({ onDesk: false, phoneReason: 'delete' });
    for (const n of [911, 913])
      expect(await refusal(desk.decide(n, 'approve'))).toEqual({ code: 'pin_needed', details: 403 });
    expect(await desk.decide(912, 'approve')).toEqual({ v: 1, result: 'decided' });
    const rows = await m.t.services.db.select().from(approvals).where(eq(approvals.burrowId, TEST_BURROW_ID));
    const by = (n: number) => rows.find((r) => r.number === n);
    expect(by(912)?.decidedById).toBe(IDS.mara);
    expect([by(911)?.state, by(913)?.state]).toEqual(['pending', 'pending']);
    await m.t.services.background.settle();
  });
});

describe('talking at the screen (DK-06, DK-S16)', () => {
  it('passes a question to Talk only while unlocked, and shows the talk only then', async () => {
    desk.lockNow();
    expect((await refusal(desk.talkStart({ text: 'Is pve-02 okay?', continue: false }))).code).toBe('locked');
    desk.lock.unlock(now);
    const { id } = await desk.talkStart({ text: 'Is pve-02 okay?', continue: false });
    expect((await desk.state()).talk).toMatchObject({ id, question: 'Is pve-02 okay?' });
    expect(desk.talkGet(id).id).toBe(id);
    desk.lockNow();
    expect((await desk.state()).talk).toBeNull();
    expect((await refusal(Promise.resolve().then(() => desk.talkGet(id)))).code).toBe('locked');
    expect((await refusal(desk.talkSession())).code).toBe('locked');
    expect((await refusal(Promise.resolve().then(() => desk.talkClose()))).code).toBe('locked');
  });

  it('marks an ask made in the conversation, says the next words after its answer, and shows it all (DK-63, DK-S63)', async () => {
    desk.lock.unlock(now);
    // The last test's question was never answered: the screen stops waiting for it.
    desk.talk.forget();
    const { id } = await desk.talkStart({ text: 'Can you run CI on main?', continue: true });
    const root = await vi.waitFor(
      async () => {
        const [row] = await m.t.services.db
          .select()
          .from(messages)
          .where(eq(messages.clientId, deskClientId(id, false)));
        if (!row) throw new Error('not posted yet');
        return row;
      },
      { interval: 10, timeout: 5000 },
    );
    const room = await loadConversationRow(m.t.services.db, root.conversationId);
    const threaded = room ? threadedRoom(room) : false;
    const inThread = threaded ? { threadRootId: root.id } : {};
    const said = await m.t.commit(maras.agentId, sendMessage, {
      conversationId: root.conversationId,
      text: 'I’ll ask you first.',
      ...inThread,
    });
    expect(said.status).toBe('ok');
    await vi.waitFor(() => expect(desk.talkGet(id).state).toBe('answered'), { interval: 10, timeout: 5000 });
    // The assistant's ask, its card in the thread.
    const [seeded] = await m.t.services.db.select().from(approvals).where(eq(approvals.number, 12));
    if (!seeded) throw new Error('no seeded approval');
    await m.t.services.db.insert(messages).values({
      id: 'msg_desk-card-931',
      burrowId: TEST_BURROW_ID,
      conversationId: root.conversationId,
      authorId: maras.agentId,
      createdAt: new Date(now),
      text: '',
      card: { kind: 'approval', approvalId: 'apr_desk-talk-931' },
      threadRootId: threaded ? root.id : null,
    });
    await m.t.services.db.insert(approvals).values(
      withHash({
        ...seeded,
        id: 'apr_desk-talk-931',
        number: 931,
        keyId: 'ci.run',
        action: { type: 'custom', params: { name: 'Run CI', keyId: 'ci.run', data: {} } },
        title: 'Run CI on main',
        question: 'Run CI on main?',
        conversationId: root.conversationId,
        messageId: 'msg_desk-card-931',
        conditions: [
          {
            id: 'person',
            kind: 'person_approves',
            label: 'A person says yes',
            met: false,
            approverIds: [IDS.mara],
          },
        ],
      }),
    );
    await desk.refresh();
    const items = (await desk.state()).glance?.needsYou.items ?? [];
    expect(items.find((i) => i.number === 931)).toMatchObject({ inTalk: true, onDesk: true });
    expect(items.find((i) => i.number === 12)).not.toHaveProperty('inTalk');
    const decided = await desk.decide(931, 'approve');
    expect(decided).toMatchObject({ v: 1, result: 'decided', talk: expect.stringMatching(/^dtk_/) });
    const follow = decided.talk as string;
    expect(desk.talkGet(follow).state).toBe('thinking');
    const next = await m.t.commit(maras.agentId, sendMessage, {
      conversationId: root.conversationId,
      text: 'CI is running on main.',
      ...inThread,
    });
    expect(next.status).toBe('ok');
    await vi.waitFor(
      () =>
        expect(desk.talkGet(follow)).toMatchObject({ state: 'answered', answer: 'CI is running on main.' }),
      {
        interval: 10,
        timeout: 5000,
      },
    );
    const session = DeskTalkSession.parse(await desk.talkSession());
    expect(deskTalkSessionValid(session)).toBe(true);
    expect(session.open).toBe(true);
    expect(session.messages.map((msg) => [msg.from, msg.ask?.state ?? msg.talk ?? null])).toEqual([
      ['you', id],
      ['assistant', id],
      ['assistant', 'approved'],
      ['assistant', follow],
    ]);
    desk.talkClose();
    expect((await desk.talkSession()).open).toBe(false);
    desk.lockNow();
  });
});

describe('Talk’s mic is voice typing', () => {
  const voice = new FakeVoice();
  beforeAll(async () => {
    voice.ability = { ...voice.ability, models: ['parakeet'] };
    setVoiceFor(m.t.services, voice);
    // Voice typing's own switch is off: the desk's Talk switch is what allows the mic here.
    await m.t.commit(IDS.mara, updateVoiceTyping, { on: false });
  });
  afterAll(async () => {
    setVoiceFor(m.t.services, null);
    await m.t.commit(IDS.mara, updateVoiceTyping, { on: true });
    desk.lockNow();
  });

  it('hears a recording into words for the box, posting nothing, only while unlocked', async () => {
    desk.lockNow();
    expect((await refusal(desk.hear(fakeRecording(2)))).code).toBe('locked');
    desk.lock.unlock(now);
    voice.transcripts.push('Is [BLANK_AUDIO] pve-02 okay?');
    const before = await m.t.services.db.select({ id: messages.id }).from(messages);
    expect(await desk.hear(fakeRecording(2))).toEqual({ v: 1, text: 'Is pve-02 okay?' });
    // Voice typing's way: its model, nothing posted, nothing said.
    expect(voice.calls.at(-1)).toMatchObject({ kind: 'transcribe', model: 'parakeet', seconds: 2 });
    expect(await m.t.services.db.select({ id: messages.id }).from(messages)).toHaveLength(before.length);
    // Silence is nothing heard, without asking the speech service.
    const asked = voice.calls.length;
    expect(await desk.hear(fakeRecording(1, { silent: true }))).toEqual({ v: 1, text: '' });
    expect(voice.calls).toHaveLength(asked);
  });

  it('takes voice typing’s five minutes, cuts what doesn’t fit a question at a word, one recording at a time', async () => {
    desk.lock.unlock(now);
    const long = fakeRecording(120);
    voice.transcripts.push(Array.from({ length: 400 }, (_, i) => `word${i}`).join(' '));
    const heard = await desk.hear(long);
    expect([...heard.text].length).toBeLessThanOrEqual(DESK_TALK_TEXT_MAX);
    expect(heard.text).toMatch(/^word0 word1 .* word\d+$/);
    voice.hold();
    const first = desk.hear(fakeRecording(2));
    await vi.waitFor(() => expect(voice.calls.at(-1)).toMatchObject({ seconds: 2 }), { interval: 5 });
    expect((await refusal(desk.hear(fakeRecording(2)))).code).toBe('busy');
    voice.release();
    expect((await first).text).toBe('Is pve-02 okay?');
  });

  it('refuses without Talk’s voice, a model or a WAV, in the screen’s codes', async () => {
    desk.lock.unlock(now);
    expect((await refusal(desk.hear(Buffer.from('RIFF not a wav at all, really not')))).code).toBe(
      'bad_audio',
    );
    voice.ability = { ...voice.ability, models: [] };
    setVoiceFor(m.t.services, voice);
    expect((await refusal(desk.hear(fakeRecording(2)))).code).toBe('voice_unavailable');
    voice.ability = { ...voice.ability, models: ['parakeet'] };
    setVoiceFor(m.t.services, voice);
    voice.failNext.transcribe = new VoiceCallError('error', 'fake voice: broken');
    expect(await refusal(desk.hear(fakeRecording(2)))).toEqual({ code: 'unavailable', details: 503 });
    await desk.update(mara, { voice: false });
    expect((await refusal(desk.hear(fakeRecording(2)))).code).toBe('voice_unavailable');
    await desk.update(mara, { voice: true });
  });

  it('sends the words as a question that came by voice (DK-T05)', async () => {
    desk.lock.unlock(now);
    desk.talk.forget();
    const { id } = await desk.talkStart({ text: 'Is pve-02 okay?', continue: false, spoken: true });
    await vi.waitFor(
      async () => {
        const [row] = await m.t.services.db
          .select()
          .from(messages)
          .where(eq(messages.clientId, deskClientId(id, true)));
        if (!row) throw new Error('not posted yet');
      },
      { interval: 10, timeout: 5000 },
    );
    desk.talk.forget();
  });
});

describe('the battery as a UPS (DK-10)', () => {
  const battery = (percent: number): DeskPower => ({
    source: 'battery',
    percent,
    charging: false,
    minutesLeft: 180,
    chargeLimit: null,
    since: new Date(now - POWER_OUT_AFTER_MS).toISOString(),
  });

  it('tells the person when the power goes out, runs low and comes back, once each', async () => {
    const watch = new HostPower(m.t.services, {
      read: async () => ({
        metrics: { ...sampleHostMetrics(), now: { ...sampleHostMetrics().now, power } },
        reason: null,
      }),
    } as unknown as HostMetricsService);
    power = battery(62);
    expect(await watch.check()).toMatchObject({ alerts: ['out'] });
    expect(await watch.check()).toMatchObject({ alerts: [] });
    expect(await said('power is out')).toHaveLength(1);
    expect((await said('power is out'))[0]).toContain('3 h');
    power = battery(14);
    expect(await watch.check()).toMatchObject({ alerts: ['low'] });
    const [kept] = await m.t.services.db
      .select({ level: burrows.hostPowerAlert })
      .from(burrows)
      .where(eq(burrows.id, TEST_BURROW_ID));
    expect(kept?.level).toBe(2);
    // A restart (a new watcher) on mains still says it's back.
    power = { source: 'ac', percent: 15, charging: true, minutesLeft: null, chargeLimit: 80, since: null };
    const restarted = new HostPower(m.t.services, {
      read: async () => ({
        metrics: { ...sampleHostMetrics(), now: { ...sampleHostMetrics().now, power } },
        reason: null,
      }),
    } as unknown as HostMetricsService);
    expect(await restarted.check()).toMatchObject({ alerts: ['back'] });
    expect(await said('power is back')).toHaveLength(1);
    expect(await said(/battery is at 14\s%/u)).toHaveLength(1);
    now += 11_000;
    expect((await desk.screen(mara)).hasBattery).toBe(true);
  });

  it('posts an alert nobody heard because posting failed at the next check, not one nobody could hear (DK-S23)', async () => {
    const host = {
      read: async () => ({
        metrics: { ...sampleHostMetrics(), now: { ...sampleHostMetrics().now, power } },
        reason: null,
      }),
    } as unknown as HostMetricsService;
    const level = async () =>
      (
        await m.t.services.db
          .select({ level: burrows.hostPowerAlert })
          .from(burrows)
          .where(eq(burrows.id, TEST_BURROW_ID))
      )[0]?.level;
    let failing = true;
    const watch = new HostPower(m.t.services, host, (...args) => {
      if (failing) return Promise.reject(new Error('chat is down'));
      return tellPerson(...args);
    });
    const before = (await said('power is out')).length;
    power = battery(62);
    expect(await watch.check()).toEqual({ posted: 0, alerts: ['out'] });
    expect(await level()).toBe(0);
    failing = false;
    expect(await watch.check()).toMatchObject({ alerts: ['out'] });
    expect(await said('power is out')).toHaveLength(before + 1);
    expect(await level()).toBe(1);
    // Nobody to tell (no assistant to say it): told is told.
    const nobody = new HostPower(m.t.services, host, async () => false);
    power = { source: 'ac', percent: 80, charging: false, minutesLeft: null, chargeLimit: 80, since: null };
    expect(await nobody.check()).toEqual({ posted: 0, alerts: ['back'] });
    expect(await nobody.check()).toEqual({ posted: 0, alerts: [] });
    expect(await level()).toBe(0);
  });
});

describe('unpairing is turning the screen off (DK-20)', () => {
  it('is the person’s; the screen goes back to the console and stays off', async () => {
    const screen = await desk.unpair(mara);
    expect(screen).toMatchObject({ paired: null, on: false, onChosen: true });
    expect(await m.t.services.db.select().from(deskScreens)).toEqual([]);
    expect((await desk.state()).paired).toBeNull();
    const [event] = await m.t.services.db.select().from(events).where(eq(events.type, 'desk.screen_set'));
    expect(event).toMatchObject({ actorId: IDS.mara, payload: { on: false, unpairedPersonId: IDS.mara } });
    // Nothing pairs itself while it is off, a monitor plugged in or not.
    plugged = MONITOR;
    expect(await desk.pairItself()).toBe(false);
    expect(await loadScreenChoice(m.t.services.db)).toBe(false);
    // Settings hear it: `desk.changed` reaches the session log for the person.
    await m.runtime.events.flushed();
  });
});

describe('the switch (DK-18, DK-20)', () => {
  it('turns on only with a screen connected', async () => {
    plugged = NO_DISPLAY;
    expect(await refusal(desk.setScreen(mara, { on: true }))).toEqual({
      code: 'conflict',
      details: { code: 'no_screen' },
    });
    plugged = VM_SCREEN;
    expect(await desk.screen(mara)).toMatchObject({
      on: false,
      onChosen: true,
      display: VM_SCREEN,
      hasDisplay: true,
      paired: null,
    });
  });

  it('pairs the person who turns it on, on a VM’s screen too, without letters or a PIN', async () => {
    const on = await desk.setScreen(mara, { on: true });
    expect(on).toMatchObject({
      on: true,
      onChosen: true,
      paired: { personId: IDS.mara, hasPin: false, self: true },
    });
    expect(await loadDeskRow(m.t.services.db)).toMatchObject({ pairedVia: 'switch', pinHash: null });
    const state = DeskState.parse(await desk.state());
    expect(deskStateValid(state)).toBe(true);
    expect(state.paired?.hasPin).toBe(false);
    // On again keeps the pairing as it is.
    expect((await desk.setScreen(mara, { on: true })).paired?.pairedAt).toBe(on.paired?.pairedAt);
  });

  it('refuses a PIN on a screen without one, counting nothing; the phone still unlocks (DK-18)', async () => {
    expect(await refusal(desk.unlock('135790'))).toEqual({ code: 'no_pin', details: 409 });
    expect((await loadDeskRow(m.t.services.db))?.wrongPins).toBe(0);
    await desk.unlockPhone();
    const id = (await desk.screen(mara)).unlockRequest?.id as string;
    await desk.answerUnlock(mara, { id, unlock: true });
    expect((await desk.state()).lock.state).toBe('unlocked');
    desk.lockNow();
  });

  it('takes the first PIN as it changes one', async () => {
    expect((await desk.setPin(mara, { pin: '135790' })).paired?.hasPin).toBe(true);
    const [chosen] = await m.t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'desk.pin_changed'))
      .orderBy(desc(events.createdAt))
      .limit(1);
    expect(chosen?.text).toContain('Chose');
    expect(await desk.unlock('135790')).toEqual({ v: 1, result: 'unlocked' });
    desk.lockNow();
  });
});

describe('a PIN of 4 to 6 digits (DK-26, DK-27)', () => {
  it('keeps the PIN’s length with its hash, and the pad gets it; an easy PIN is refused', async () => {
    const db = m.t.services.db;
    expect(await refusal(desk.setPin(mara, { pin: '1234' }))).toEqual({
      code: 'validation_failed',
      details: { code: 'easy_pin' },
    });
    expect((await loadDeskRow(db))?.pinDigits).toBe(6);
    // A PIN from before 0124 has no length kept: six dots.
    await db.update(deskScreens).set({ pinDigits: null });
    expect((await desk.state()).paired?.pinDigits).toBe(6);
    await desk.setPin(mara, { pin: '2580' });
    expect(await loadDeskRow(db)).toMatchObject({ pinDigits: 4, wrongPins: 0 });
    const state = DeskState.parse(await desk.state());
    expect(deskStateValid(state)).toBe(true);
    expect(state.paired).toMatchObject({ hasPin: true, pinDigits: 4 });
    expect(await desk.unlock('2580')).toEqual({ v: 1, result: 'unlocked' });
    desk.lockNow();
    // The column takes 4 to 6 only.
    await expect(db.update(deskScreens).set({ pinDigits: 3 })).rejects.toThrow();
    await expect(db.update(deskScreens).set({ pinDigits: 7 })).rejects.toThrow();
  });

  it('refuses an easy PIN before the letters are used up', async () => {
    await desk.startPairing(mara);
    const code = (await desk.state()).pairing?.code as string;
    expect((await refusal(desk.pair(mara, { code, pin: '0000' }))).details).toEqual({ code: 'easy_pin' });
    expect((await desk.pair(mara, { code, pin: '52031' })).paired).toMatchObject({
      personId: IDS.mara,
      hasPin: true,
    });
    expect((await desk.state()).paired?.pinDigits).toBe(5);
    expect(await desk.unlock('52031')).toEqual({ v: 1, result: 'unlocked' });
    desk.lockNow();
  });
});

describe('staying unlocked while you’re here (DK-28…DK-30)', () => {
  it('is the paired person’s switch, off until they turn it on, shown where the camera works', async () => {
    const screen = await desk.screen(mara);
    expect(screen).toMatchObject({ presenceAvailable: true, settings: { presence: false } });
    // A locked screen never looks (DK-29).
    expect((await desk.update(mara, { presence: true })).settings.presence).toBe(true);
    expect((await loadDeskRow(m.t.services.db))?.presence).toBe(true);
    await time.advance(PRESENCE_CHECK_MS);
    expect(camera.calls).toEqual([]);
  });

  it('watches while unlocked, keeps it while someone is there, and the lock turns the camera off', async () => {
    expect(await desk.unlock('52031')).toEqual({ v: 1, result: 'unlocked' });
    await time.advance(0);
    expect(camera.calls).toEqual(['watch']);
    expect((await desk.state()).lock).toMatchObject({ state: 'unlocked', camera: true });
    await time.advance(UNLOCK_IDLE_MS + PRESENCE_CHECK_MS);
    const state = DeskState.parse(await desk.state());
    expect(deskStateValid(state)).toBe(true);
    expect(state.lock).toMatchObject({ state: 'unlocked', camera: true, present: true });
    expect(Date.parse(state.lock.until as string) - now).toBeLessThanOrEqual(PRESENCE_GONE_MS);
    desk.lockNow();
    expect(camera.calls.at(-1)).toBe('stop');
    expect(camera.cameraOn()).toBe(false);
    expect((await desk.state()).lock).toEqual({ state: 'locked' });
  });

  it('stops the camera when the switch goes off, the screen staying unlocked by DK-04’s rule', async () => {
    await desk.unlock('52031');
    await time.advance(PRESENCE_CHECK_MS * 2);
    expect(camera.cameraOn()).toBe(true);
    const asked = camera.calls.length;
    await desk.update(mara, { presence: false });
    expect(camera.calls.at(-1)).toBe('stop');
    const state = await desk.state();
    expect(state.lock.state).toBe('unlocked');
    expect(state.lock.camera).toBeUndefined();
    await time.advance(PRESENCE_CHECK_MS * 3);
    expect(camera.calls).toHaveLength(asked + 1);
    // Turned on again while unlocked: it watches at once.
    await desk.update(mara, { presence: true });
    await time.advance(0);
    expect(camera.calls.at(-1)).toBe('watch');
    desk.lockNow();
    await desk.update(mara, { presence: false });
  });
});

describe('Lock again (DK-74…DK-76)', () => {
  const row = () => loadDeskRow(m.t.services.db);
  /** Another runtime on this database (an update, a reboot), on the boot it runs on. */
  const runtimeOn = (bootId: string | null) =>
    new DeskService(m.t.services, {
      display: { display: async () => plugged, connected: async () => plugged.connected },
      after: time.after,
      bootId,
    });

  it('offers the choices where the camera works, and When you leave only there', async () => {
    expect(await desk.screen(mara)).toMatchObject({
      lockAgain: ['idle', 'away', 'never'],
      cameraWakeAvailable: true,
      settings: { stayUnlocked: false, cameraWake: false },
    });
    camera.ability = { camera: false, detector: true };
    setPresenceFor(m.t.services, camera);
    expect(await desk.screen(mara)).toMatchObject({
      lockAgain: ['idle', 'never'],
      cameraWakeAvailable: false,
    });
    camera.ability = { camera: true, detector: true };
    setPresenceFor(m.t.services, camera);
  });

  it('stays unlocked until Lock, its boot kept quietly with it; Lock forgets it', async () => {
    const pushed = pushes.length;
    const settings = (await desk.update(mara, deskLockAgainPatch('never'))).settings;
    expect(settings).toMatchObject({ stayUnlocked: true, presence: false });
    expect(await desk.unlock('52031')).toEqual({ v: 1, result: 'unlocked' });
    expect((await row())?.unlockedBoot).toBe(THIS_BOOT);
    const watched = camera.calls.length;
    await time.advance(5 * UNLOCK_IDLE_MS);
    const state = DeskState.parse(await desk.state());
    expect(deskStateValid(state)).toBe(true);
    expect(state.lock).toEqual({
      state: 'unlocked',
      until: new Date(now + UNLOCK_IDLE_MS).toISOString(),
      stays: true,
    });
    expect(desk.touch().until).toBe(new Date(now + UNLOCK_IDLE_MS).toISOString());
    // No camera for the lock, no push, nothing said.
    expect(camera.calls).toHaveLength(watched);
    expect(pushes).toHaveLength(pushed);
    expect(await desk.lockNow()).toEqual({ v: 1 });
    expect((await row())?.unlockedBoot).toBeNull();
    expect((await desk.state()).lock).toEqual({ state: 'locked' });
  });

  it('is unlocked again by a runtime that starts on the same boot, never on another or without one', async () => {
    await desk.unlock('52031');
    const info = vi.spyOn(m.t.services.log, 'info');
    const updated = runtimeOn(THIS_BOOT);
    expect(await updated.restoreUnlock()).toBe(true);
    expect(updated.lock.view(now, null)).toMatchObject({ state: 'unlocked', stays: true });
    expect(info.mock.calls.filter((c) => String(c.at(-1)).includes('unlocked again'))).toHaveLength(1);
    info.mockRestore();
    updated.close();
    // A reboot: locked, and the boot is forgotten.
    const rebooted = runtimeOn('a-boot-after-a-power-cut');
    expect(await rebooted.restoreUnlock()).toBe(false);
    expect(rebooted.lock.unlocked(now)).toBe(false);
    expect((await row())?.unlockedBoot).toBeNull();
    rebooted.close();
    // No boot id (written by a runtime that has one, read by one that hasn't).
    await desk.lockNow();
    await desk.unlock('52031');
    expect((await row())?.unlockedBoot).toBe(THIS_BOOT);
    const unknown = runtimeOn(null);
    expect(await unknown.restoreUnlock()).toBe(false);
    expect((await row())?.unlockedBoot).toBeNull();
    unknown.close();
    // A boot this runtime has no unlock for: nothing to bring back.
    const again = runtimeOn(THIS_BOOT);
    expect(await again.restoreUnlock()).toBe(false);
    again.close();
    await desk.lockNow();
  });

  it('back to After 2 minutes: the change counts as a touch, and the boot goes with it', async () => {
    await desk.unlock('52031');
    await time.advance(10 * UNLOCK_IDLE_MS);
    const changed = now;
    expect((await desk.update(mara, deskLockAgainPatch('idle'))).settings.stayUnlocked).toBe(false);
    expect((await row())?.unlockedBoot).toBeNull();
    expect((await desk.state()).lock).toEqual({
      state: 'unlocked',
      until: new Date(changed + UNLOCK_IDLE_MS).toISOString(),
    });
    await time.advance(UNLOCK_IDLE_MS - 1);
    expect(desk.lock.unlocked(now)).toBe(true);
    await time.advance(1);
    expect(desk.lock.unlocked(now)).toBe(false);
    // A runtime that starts now finds nothing to bring back.
    const started = runtimeOn(THIS_BOOT);
    expect(await started.restoreUnlock()).toBe(false);
    started.close();
  });

  it('chosen while unlocked, the unlock going on stays and its boot is kept; a locked screen stays locked', async () => {
    await desk.update(mara, deskLockAgainPatch('never'));
    expect(desk.lock.unlocked(now)).toBe(false);
    await desk.update(mara, deskLockAgainPatch('idle'));
    await desk.unlock('52031');
    expect((await row())?.unlockedBoot).toBeNull();
    await desk.update(mara, deskLockAgainPatch('never'));
    expect((await row())?.unlockedBoot).toBe(THIS_BOOT);
    await time.advance(3 * UNLOCK_IDLE_MS);
    expect((await desk.state()).lock).toMatchObject({ state: 'unlocked', stays: true });
  });

  it('to When you leave from it: the camera at once and DK-28’s rules; an older app’s switch doesn’t win over it', async () => {
    // An older app turns *Stay unlocked while you’re here* on: When you press Lock still wins (DK-76).
    await desk.update(mara, { presence: true });
    await time.advance(PRESENCE_CHECK_MS * 2);
    expect((await desk.state()).lock).toMatchObject({ state: 'unlocked', stays: true });
    expect(camera.cameraOn()).toBe(false);
    await desk.update(mara, deskLockAgainPatch('away'));
    expect((await row())?.unlockedBoot).toBeNull();
    await time.advance(0);
    expect(camera.calls.at(-1)).toBe('watch');
    await time.advance(PRESENCE_CHECK_MS * 3);
    const lock = (await desk.state()).lock;
    expect(lock).toMatchObject({ state: 'unlocked', camera: true, present: true });
    expect(lock.stays).toBeUndefined();
    await desk.lockNow();
    expect(camera.calls.at(-1)).toBe('stop');
    await desk.update(mara, deskLockAgainPatch('idle'));
  });
});

describe('the camera for the clock (DK-72, DK-73)', () => {
  /** Hours and minutes in the person's zone, for quiet hours around now. */
  const hm = (ms: number, timeZone: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(ms);

  it('looks while the console asks for the state, locked too, and the state says who is there', async () => {
    const screen = await desk.update(mara, {
      cameraWake: true,
      quietHours: { enabled: false, start: '23:00', end: '07:00' },
    });
    expect(screen.settings.cameraWake).toBe(true);
    // No console has asked lately: no camera.
    await time.advance(CONSOLE_ASKED_MS + PRESENCE_CHECK_MS);
    const asked = camera.calls.length;
    await time.advance(PRESENCE_CHECK_MS);
    expect(camera.calls).toHaveLength(asked);
    expect((await desk.state()).presence).toEqual({ camera: false, watching: false, here: false });
    await time.advance(0);
    expect(camera.calls.at(-1)).toBe('watch');
    await time.advance(PRESENCE_CHECK_MS);
    const state = DeskState.parse(await desk.state());
    expect(deskStateValid(state)).toBe(true);
    expect(state.presence).toEqual({ camera: true, watching: true, here: true });
    // A face never unlocks (DK-29), and the chip's own mark is the lock's camera's (DK-30).
    expect(state.lock).toEqual({ state: 'locked' });
    // The console stops asking: off within 10 s and a check.
    await time.advance(CONSOLE_ASKED_MS + PRESENCE_CHECK_MS);
    expect(camera.calls.at(-1)).toBe('stop');
    expect(camera.cameraOn()).toBe(false);
  });

  it('keeps the camera on through an unlock and a lock', async () => {
    await desk.state();
    await time.advance(PRESENCE_CHECK_MS);
    expect(camera.cameraOn()).toBe(true);
    const from = camera.calls.length;
    await desk.unlock('52031');
    await desk.state();
    await time.advance(PRESENCE_CHECK_MS);
    await desk.lockNow();
    await desk.state();
    await time.advance(PRESENCE_CHECK_MS);
    expect(camera.calls.slice(from)).not.toContain('stop');
    expect((await desk.state()).presence).toMatchObject({ camera: true, here: true });
  });

  it('is off in quiet hours and on battery, and when its switch goes off', async () => {
    const zone = (await desk.state()).paired?.timeZone as string;
    await desk.update(mara, {
      quietHours: { enabled: true, start: hm(now - 3_600_000, zone), end: hm(now + 3_600_000, zone) },
    });
    let state = await desk.state();
    expect(state.presence).toBeUndefined();
    await time.advance(PRESENCE_CHECK_MS);
    expect(camera.calls.at(-1)).toBe('stop');
    await desk.update(mara, { quietHours: { enabled: false, start: '23:00', end: '07:00' } });
    // The morning (quiet hours over): the console's next ask starts it.
    expect((await desk.state()).presence).toBeDefined();
    await time.advance(0);
    expect(camera.calls.at(-1)).toBe('watch');
    power = {
      source: 'battery',
      percent: 80,
      charging: false,
      minutesLeft: 200,
      chargeLimit: null,
      since: null,
    };
    await hostPower.read();
    state = await desk.state();
    expect(state.presence).toBeUndefined();
    await time.advance(PRESENCE_CHECK_MS);
    expect(camera.calls.at(-1)).toBe('stop');
    power = null;
    await hostPower.read();
    expect((await desk.state()).presence).toBeDefined();
    await desk.update(mara, { cameraWake: false });
    expect(camera.calls.at(-1)).toBe('stop');
    expect((await desk.state()).presence).toBeUndefined();
  });
});

describe('choosing the voice (DK-50…DK-52)', () => {
  const voice = new FakeVoice();
  const EVERYTHING = { ...voice.ability };
  /** What the voice service says now; its health is read again. */
  function service(ability: FakeVoice['ability']): void {
    voice.ability = ability;
    setVoiceFor(m.t.services, voice);
  }
  /** *Listen* as the app asks for it: an export stream of `desk.voiceSample` from Mara's device. */
  async function sample(voiceName: string) {
    const c = await m.client(maraDevice);
    const s = await c.open({ kind: 'export', op: 'desk.voiceSample', input: { voice: voiceName } });
    return { ...s, c };
  }
  beforeAll(() => {
    service(EVERYTHING);
    // The session ops reach this desk (boot.ts gives the runtime's own).
    m.runtime.dispatcher.desk = desk;
  });
  afterAll(() => {
    setVoiceFor(m.t.services, null);
    m.runtime.dispatcher.desk = undefined;
  });

  it('lists the box’s voices and keeps the one the person chooses', async () => {
    const db = m.t.services.db;
    const screen = await desk.screen(mara);
    expect(screen.voices).toEqual([...DESK_VOICES]);
    expect(screen.settings.speechVoice).toBe(DEFAULT_DESK_VOICE);
    expect((await loadDeskRow(db))?.speechVoice).toBe(DEFAULT_DESK_VOICE);
    expect((await desk.update(mara, { speechVoice: 'emma' })).settings.speechVoice).toBe('emma');
    expect((await loadDeskRow(db))?.speechVoice).toBe('emma');
    // Through the session op a client sends, and other settings keep it.
    const c = await m.client(maraDevice);
    const got = (await c.request('desk.get', {})) as {
      t: string;
      output?: { settings: { speechVoice: string } };
    };
    expect(got.output?.settings.speechVoice).toBe('emma');
    expect((await desk.update(mara, { night: 'dim' })).settings.speechVoice).toBe('emma');
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.type, 'desk.updated'))
      .orderBy(desc(events.createdAt), desc(events.seq))
      .limit(1);
    expect(event?.payload).toMatchObject({ settings: { speechVoice: 'emma' } });
    // The column takes a voice's name only.
    await expect(db.update(deskScreens).set({ speechVoice: 'Not a voice' })).rejects.toThrow();
  });

  it('refuses a voice the box doesn’t list, and lists none where it can’t choose', async () => {
    service({ ...EVERYTHING, voices: ['heart', 'bella'] });
    expect((await desk.screen(mara)).voices).toEqual(['heart', 'bella']);
    expect(await refusal(desk.update(mara, { speechVoice: 'george' }))).toEqual({
      code: 'conflict',
      details: { code: 'no_voice' },
    });
    expect((await loadDeskRow(m.t.services.db))?.speechVoice).toBe('emma');
    // A voice service from before 0.105, one that can't speak, and none at all.
    for (const ability of [
      { stt: true, tts: true, microphone: true, speaker: true },
      { ...EVERYTHING, tts: false },
    ]) {
      service(ability);
      const screen = await desk.screen(mara);
      expect('voices' in screen).toBe(false);
      expect((await refusal(desk.update(mara, { speechVoice: 'heart' }))).details).toEqual({
        code: 'no_voice',
      });
    }
    setVoiceFor(m.t.services, null);
    expect('voices' in (await desk.screen(mara))).toBe(false);
    service(EVERYTHING);
  });

  it('plays a sample in a voice through an export stream, changing nothing (DK-51)', async () => {
    const before = (await m.t.services.db.select({ id: events.id }).from(events)).length;
    const c = await m.client(maraDevice);
    // Never as a request: its answer is larger than a message, so nothing is said for it.
    expect(await c.request('desk.voiceSample', { voice: 'george' })).toMatchObject({
      t: 'error',
      details: { code: 'use_export_stream' },
    });
    expect(voice.calls).toEqual([]);
    const s = await sample('george');
    expect(s.answer).toMatchObject({
      t: 'opened',
      meta: { kind: 'export', contentType: 'application/json' },
    });
    const got = await s.c.readStream(s.stream);
    expect(got.reset).toBeNull();
    const answer = DeskVoiceSample.parse(JSON.parse(Buffer.from(got.bytes).toString('utf8')));
    const wav = parseWav(Buffer.from(answer.audioWav, 'base64'));
    expect(wav).toMatchObject({ format: 1, channels: 1, bitsPerSample: 16, sampleRate: FAKE_SPEECH_RATE });
    // The screen's sentence with the assistant's name, in that voice.
    expect(voice.calls).toEqual([{ kind: 'tts', text: expect.stringContaining('Dusty'), voice: 'george' }]);
    expect((await m.t.services.db.select({ id: events.id }).from(events)).length).toBe(before);
    expect((await loadDeskRow(m.t.services.db))?.speechVoice).toBe('emma');
  });

  it('refuses a sample in a voice the box doesn’t have, or when it can’t speak now (DK-52)', async () => {
    voice.calls.length = 0;
    service({ ...EVERYTHING, voices: ['heart', 'bella'] });
    expect((await sample('george')).answer).toMatchObject({
      t: 'error',
      code: 'stream_refused',
      details: { code: 'no_voice' },
    });
    service(EVERYTHING);
    for (const failure of ['busy', 'unavailable', 'error'] as const) {
      voice.failNext.tts = new VoiceCallError(failure, 'the voice failed');
      expect((await sample('bella')).answer).toMatchObject({
        code: 'stream_refused',
        details: { code: 'no_voice' },
      });
    }
    // Not a voice at all, and someone else's screen.
    expect((await sample('alloy')).answer).toMatchObject({ t: 'error', code: 'stream_refused' });
    expect(voice.calls).toEqual([]);
    expect((await desk.voiceSample(mara, { voice: 'bella' })).audioWav.length).toBeGreaterThan(60);
  });

  it('answers on the screen in the voice chosen (DK-S53)', async () => {
    voice.calls.length = 0;
    expect(await desk.talkHost().speechVoice?.()).toBe('emma');
    desk.lock.unlock(now);
    const { id } = await desk.talkStart({ text: 'Is pve-02 okay?', continue: false });
    const root = await vi.waitFor(
      async () => {
        const [row] = await m.t.services.db
          .select()
          .from(messages)
          .where(eq(messages.clientId, deskClientId(id, false)));
        if (!row) throw new Error('not posted yet');
        return row;
      },
      { interval: 10, timeout: 5000 },
    );
    // The assistant answers where the question went: in its thread where the room has threads.
    const room = await loadConversationRow(m.t.services.db, root.conversationId);
    const threaded = room ? threadedRoom(room) : false;
    const res = await m.t.commit(maras.agentId, sendMessage, {
      conversationId: root.conversationId,
      text: 'pve-02 is fine, up 41 days.',
      ...(threaded ? { threadRootId: root.id } : {}),
    });
    expect(res.status).toBe('ok');
    await vi.waitFor(() => expect(desk.talkGet(id)).toMatchObject({ state: 'answered', audio: true }), {
      interval: 10,
      timeout: 5000,
    });
    expect(voice.calls).toEqual([{ kind: 'tts', text: 'pve-02 is fine, up 41 days.', voice: 'emma' }]);
    desk.lockNow();
  });
});

describe('the screen pairs itself (DK-17, DK-19, DK-22)', () => {
  /** A box where nobody chose (as after the update, DK-21) and nobody is paired. */
  async function nobodyChose(): Promise<void> {
    await desk.setScreen(mara, { on: false });
    await m.t.services.db.delete(deskDisplay);
  }

  it('waits for a real screen while nobody chose', async () => {
    await nobodyChose();
    plugged = VM_SCREEN;
    expect(await desk.pairItself()).toBe(false);
    expect((await desk.screen(mara)).on).toBe(false);
  });

  it('pairs with the person when the console asks, signed by Whombat, and says so once', async () => {
    const db = m.t.services.db;
    const marasAccount = mara.account?.id as string;
    await db
      .insert(applianceState)
      .values({ id: 1, claimedByAccountId: marasAccount })
      .onConflictDoUpdate({ target: applianceState.id, set: { claimedByAccountId: marasAccount } });
    plugged = MONITOR;
    now += 11_000;
    // The console's poll checks (at most every 10 s, without waiting for it); the check after it finds it paired.
    expect((await desk.state()).paired).toBeNull();
    expect(await desk.pairItself()).toBe(false);
    expect(await loadDeskRow(db)).toMatchObject({ personId: IDS.mara, pairedVia: 'itself', pinHash: null });
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.type, 'desk.paired'))
      .orderBy(desc(events.createdAt))
      .limit(1);
    const [signer] = await db
      .select()
      .from(principals)
      .where(eq(principals.id, event?.actorId as string));
    expect(signer?.system).toBe('servers');
    expect(event?.text).toContain('Mara Okafor');
    await m.t.services.background.settle();
    expect(await said('choose a PIN', maras)).toHaveLength(1);
    expect(await desk.screen(mara)).toMatchObject({
      on: true,
      onChosen: false,
      paired: { personId: IDS.mara, hasPin: false, self: true },
    });
    const state = DeskState.parse(await desk.state());
    expect(deskStateValid(state)).toBe(true);
    expect(state.paired).toMatchObject({ person: { name: 'Mara' }, hasPin: false });
  });

  it('pairs again once nobody chose, and on any screen once the person chose on', async () => {
    const db = m.t.services.db;
    await nobodyChose();
    expect(await desk.pairItself()).toBe(true);
    expect((await loadDeskRow(db))?.personId).toBe(IDS.mara);
    // The person chose on, then the pairing's row went: a VM's screen counts now.
    await desk.setScreen(mara, { on: true });
    await db.delete(deskScreens);
    plugged = VM_SCREEN;
    expect(await desk.pairItself()).toBe(true);
    expect((await loadDeskRow(db))?.personId).toBe(IDS.mara);
    await m.t.services.background.settle();
  });

  it('is only Whombat’s, and not once the person turned the screen off', async () => {
    const db = m.t.services.db;
    await desk.setScreen(mara, { on: false });
    const signer = await serversPrincipal(m.t.services, TEST_BURROW_ID);
    const res = await m.t.services.pipeline.commit(
      pairDeskItself,
      { personId: IDS.mara },
      { burrowId: TEST_BURROW_ID, actorId: signer },
    );
    expect(res).toMatchObject({ status: 'ok', result: { paired: false } });
    await db.delete(deskDisplay);
    await expect(
      m.t.services.pipeline.commit(
        pairDeskItself,
        { personId: IDS.mara },
        { burrowId: TEST_BURROW_ID, actorId: IDS.mara },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await loadDeskRow(db)).toBeNull();
  });
});

describe('found on your network on the screen (desk-found.md DF-02…DF-07)', () => {
  /** A Home Assistant on the home network that answers its probe only when the test lets it. */
  let ha: Server;
  let haPort = 0;
  let release = () => {};
  let probed = () => {};
  const asked = new Promise<void>((resolve) => {
    probed = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scans = () => foundScansFor(m.t.services);

  beforeAll(async () => {
    ha = createServer((req, res) => {
      probed();
      void held.then(() => {
        if (req.url !== '/manifest.json') {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'Home Assistant', short_name: 'Assistant', display: 'standalone' }));
      });
    });
    await new Promise<void>((resolve) => ha.listen(0, '127.0.0.1', resolve));
    haPort = (ha.address() as AddressInfo).port;
    useDiscoveryNetForTests(m.t.services, {
      interfaces: () => ({
        eth0: [
          {
            address: '192.168.77.5',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:16:3e:00:00:01',
            internal: false,
            cidr: '192.168.77.5/24',
          },
        ],
      }),
      dial: (address, port) =>
        address === '192.168.77.20' && port === 8123 ? { address: '127.0.0.1', port: haPort } : null,
    });
  });
  afterAll(async () => {
    release();
    ha.closeAllConnections();
    await new Promise<void>((resolve) => ha.close(() => resolve()));
  });

  it('looks by itself once the screen paired itself, showing the first scan’s progress, then what it found', async () => {
    plugged = MONITOR;
    expect(await desk.pairItself()).toBe(true);
    expect((await loadDeskRow(m.t.services.db))?.personId).toBe(IDS.mara);
    await scans().check();
    await asked;
    // The first automatic scan looks: the panel at once, before anything is found (DF-07).
    await desk.refresh();
    const looking = DeskState.parse(await desk.state());
    expect(deskStateValid(looking)).toBe(true);
    const found = (await desk.state()).glance?.found;
    expect(found).toMatchObject({ scanning: true, items: [], count: 0, finishedAt: null });
    expect(found?.progress?.total).toBe(253 * DISCOVERY_PORTS.length);

    release();
    await scans().settle();
    await desk.refresh();
    const done = (await desk.state()).glance?.found;
    expect(done).toMatchObject({
      scanning: false,
      progress: null,
      count: 1,
      items: [{ catalogId: 'homeassistant', name: 'Home Assistant', address: '192.168.77.20' }],
    });
    expect(done?.finishedAt).toEqual(expect.any(String));
    expect((await foundStateOf(m.t.services.db, TEST_BURROW_ID)).firstScanAt).not.toBeNull();
    // The assistant says it once, in Mara's chat, with a button that connects it (DF-05; first-day.md).
    const told = await said('Home Assistant');
    expect(told).toHaveLength(1);
    const [card] = await m.t.services.db
      .select({ card: messages.card })
      .from(messages)
      .where(and(eq(messages.conversationId, maras.dmId), eq(messages.text, told[0] ?? '')));
    expect(JSON.stringify(card?.card)).toContain('connection=homeassistant');
  });

  it('looks again only a day later, and says nothing again (DF-02, DF-05)', async () => {
    const first = burrowFound(m.t.services, TEST_BURROW_ID).last?.finishedAt;
    await scans().check();
    expect(burrowFound(m.t.services, TEST_BURROW_ID).running).toBeNull();
    now += FOUND_EVERY_MS;
    await scans().check();
    await scans().settle();
    expect(burrowFound(m.t.services, TEST_BURROW_ID).last?.finishedAt.getTime()).toBeGreaterThan(
      first?.getTime() ?? Number.POSITIVE_INFINITY,
    );
    expect(await said('Home Assistant')).toHaveLength(1);
  });

  it('puts it away with Not now while locked, for good: no panel, no automatic scans (DF-04)', async () => {
    expect((await desk.state()).lock.state).toBe('locked');
    expect(await desk.foundDismiss()).toEqual({ v: 1 });
    expect((await desk.state()).glance?.found).toBeUndefined();
    expect((await foundStateOf(m.t.services.db, TEST_BURROW_ID)).putAwayAt).not.toBeNull();
    const last = burrowFound(m.t.services, TEST_BURROW_ID).last?.finishedAt;
    now += FOUND_EVERY_MS;
    await scans().check();
    await scans().settle();
    expect(burrowFound(m.t.services, TEST_BURROW_ID).last?.finishedAt).toEqual(last);
    await desk.refresh();
    expect((await desk.state()).glance?.found).toBeUndefined();
    expect(await desk.foundDismiss()).toEqual({ v: 1 });
  });
});

describe('the servers on the screen (DK-83…DK-86)', () => {
  const hub = new FakeHostsService();
  let hosts: HostsService;
  const servicesOf = (socket: string | undefined) => {
    const services = m.t.services;
    return new HostsService({
      config: { WHOMBAT_HOSTS_SOCKET: socket, WHOMBAT_HOSTS_TOKEN_FILE: hub.tokenFile },
      db: services.db,
      log: () => services.log,
      clock: () => services.clock(),
    });
  };
  beforeAll(async () => {
    await hub.start();
    hosts = servicesOf(hub.socket);
    setHostsFor(m.t.services, hosts);
  });
  afterAll(async () => {
    setHostsFor(m.t.services, servicesOf(undefined));
    await hub.stop();
  });

  it('shows every server as a card while locked, worst first, and a server’s screen without its alerts’ words', async () => {
    await desk.update(mara, { lockedView: 'summary' });
    await desk.lockNow();
    const all = DeskServersAnswer.parse(await desk.servers());
    expect(all.more).toBe(0);
    expect(all.servers[0]).toMatchObject({ id: 'marble', state: 'off' });
    expect(all.servers.find((c) => c.id === 'shale')).toMatchObject({
      state: 'warn',
      note: 'CPU temperature',
    });
    expect(all.servers.every((c) => c.id && (c.state === 'off' || c.disk))).toBe(true);
    const page = DeskServerPage.parse(await desk.server('shale', '24h'));
    expect(deskServerPageValid(page)).toBe(true);
    expect(page).toMatchObject({ server: { id: 'shale' }, os: 'Proxmox VE 9', history: { range: '24h' } });
    expect(page.alerts).toEqual({ count: 1, items: [] });
    // Reading isn't using the screen: it stays locked.
    expect((await desk.state()).lock.state).toBe('locked');
    expect(hub.calls('GET', '/api/v1/servers/shale').at(-1)?.query.get('range')).toBe('24h');
  });

  it('names the alerts unlocked, or with Everything; none for Only the time', async () => {
    desk.lock.unlock(now);
    expect((await desk.server('shale', '1h')).alerts.items).toEqual([
      { tone: 'warn', title: 'CPU package at 83 °C' },
    ]);
    await desk.lockNow();
    await desk.update(mara, { lockedView: 'everything' });
    expect((await desk.server('shale', '7d')).alerts.items).toHaveLength(1);
    await desk.update(mara, { lockedView: 'time' });
    expect((await refusal(desk.servers())).code).toBe('locked');
    expect((await refusal(desk.server('shale', '24h'))).code).toBe('locked');
    await desk.update(mara, { lockedView: 'summary' });
  });

  it('knows only the fleet’s servers', async () => {
    expect(await refusal(desk.server('nope', '24h'))).toEqual({ code: 'not_found', details: 404 });
  });

  /** The desk question of a talk once it is in Chat. */
  const posted = (talk: string) =>
    vi.waitFor(
      async () => {
        const [row] = await m.t.services.db
          .select({ clientId: messages.clientId, text: messages.text })
          .from(messages)
          .where(eq(messages.clientId, deskClientId(talk, false)));
        if (!row) throw new Error('not posted yet');
        return row;
      },
      { interval: 5, timeout: 5000 },
    );

  it('asks the assistant about the server on the screen: the talk is about it, its turn is told (DK-85)', async () => {
    desk.lock.unlock(now);
    desk.talk.forget();
    const { id } = await desk.talkStart({ text: 'why is it so hot?', continue: false, server: 'shale' });
    expect(desk.talkGet(id).thing).toMatchObject({ id: 'shale', name: 'shale' });
    // The question in Chat carries its talk; the turn it wakes is told which server (never the chat).
    const question = await posted(id);
    expect(question.text).toBe('why is it so hot?');
    expect(deskTurnOf({ trigger: 'dm' }, question ?? null, m.t.services)).toEqual({
      spoken: false,
      server: { id: 'shale', name: 'shale' },
    });
    // An id the fleet doesn't have: the talk goes on without it.
    desk.talk.forget();
    const other = await desk.talkStart({ text: 'and the other one?', continue: false, server: 'nope' });
    expect(desk.talkGet(other.id).thing).toBeNull();
    expect(deskTurnOf({ trigger: 'dm' }, await posted(other.id), m.t.services)).toEqual({ spoken: false });
    desk.talk.forget();
    await desk.lockNow();
  });

  it('says it can’t reach them when the hosts service doesn’t answer', async () => {
    await hub.stop();
    hosts.forget();
    expect(await refusal(desk.servers())).toEqual({ code: 'unavailable', details: 503 });
    expect(await refusal(desk.server('shale', '24h'))).toEqual({ code: 'unavailable', details: 503 });
  });
});

describe('what the screen shows and the Whombat’s name (DK-102, DK-119, DK-124)', () => {
  it('keeps the choices, only the parts changed, and lists what can be chosen while paired', async () => {
    const before = DeskScreen.parse(await desk.screen(mara));
    expect(before.settings.show).toEqual(DEFAULT_DESK_SHOW);
    expect(before.showOptions?.map((o) => o.key)).toEqual(expect.arrayContaining(['work', 'coming', 'box']));
    expect(before.whombatName).toBeNull();
    const screen = await desk.update(mara, {
      show: { clock: 'small', items: { work: 'off', 'server:shale': 'always' }, order: ['shale', 'shale'] },
    });
    // A choice set to its default isn't kept; the order without repeats.
    expect(screen.settings.show).toMatchObject({ clock: 'small', items: { work: 'off' }, order: ['shale'] });
    expect((await loadDeskRow(m.t.services.db))?.show).toMatchObject({
      clock: 'small',
      items: { work: 'off' },
    });
    await desk.update(mara, { show: { items: { work: null } }, night: 'dim' });
    expect((await desk.screen(mara)).settings.show).toMatchObject({
      clock: 'small',
      items: {},
      order: ['shale'],
    });
    const state = DeskState.parse(await desk.state());
    expect(deskStateValid(state)).toBe(true);
    expect(state.glance?.calm).toMatchObject({ bar: DEFAULT_DESK_SHOW.bar });
    await desk.update(mara, { show: { clock: 'big', order: [] } });
  });

  it('keeps the Whombat’s name with the box for the top bar and the preview, past an unpairing', async () => {
    changed.length = 0;
    const screen = await desk.setName(mara, { name: ' Home ' });
    expect(screen.whombatName).toBe('Home');
    expect(changed).toContain(topics.me(IDS.mara));
    expect(DeskState.parse(await desk.state()).name).toBe('Home');
    expect(DeskPreview.parse(await desk.preview(mara, { scenario: 'now' })).name).toBe('Home');
    // The same name again changes nothing.
    changed.length = 0;
    await desk.setName(mara, { name: 'Home' });
    expect(changed).toEqual([]);
    expect(await m.t.services.db.select().from(events).where(eq(events.type, 'desk.named'))).toHaveLength(1);
    await expect(desk.setName(mara, { name: '   ' })).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('tries a scenario on the screen for a minute, trimmed by the lock; a touch ends it', async () => {
    desk.lock.unlock(now);
    const { until } = await desk.tryOnScreen(mara, { scenario: 'busy' });
    expect(Date.parse(until)).toBe(now + DESK_TRY_S * 1_000);
    expect(DeskState.parse(await desk.state()).glance?.calm?.sample).toEqual({ scenario: 'busy', until });
    desk.touch();
    expect((await desk.state()).glance?.calm).not.toHaveProperty('sample');
    await desk.tryOnScreen(mara, { scenario: 'wrong', show: { ...DEFAULT_DESK_SHOW, clock: 'small' } });
    now += DESK_TRY_S * 1_000;
    expect((await desk.state()).glance?.calm).not.toHaveProperty('sample');
    await desk.lockNow();
  });

  it('previews a server that isn’t answering with what the assistant found and its step (look-research.md LR-09)', async () => {
    const wrong = DeskPreview.parse(await desk.preview(mara, { scenario: 'wrong' }));
    expect(wrong.calm.hero).toMatchObject({ kind: 'look', research: 'found' });
    expect(wrong.calm.hero?.fix).toMatch(/^Restart /);
  });

  it('takes the step on a look only unlocked, as the paired person, and only while it is offered (look-research.md LR-08)', async () => {
    const db = m.t.services.db;
    const key = 'connection:con_deskstep001';
    const root = newId('message');
    const at = new Date(now);
    await db.insert(messages).values({
      id: root,
      burrowId: TEST_BURROW_ID,
      conversationId: maras.dmId,
      authorId: maras.agentId,
      createdAt: at,
      text: 'Attic HA needs a look. I’m looking into it.',
    });
    const id = newId('lookResearch');
    await db.insert(lookResearches).values({
      id,
      burrowId: TEST_BURROW_ID,
      agentId: maras.agentId,
      personId: IDS.mara,
      lookKey: key,
      kind: 'connection',
      name: 'Attic HA',
      rank: 1,
      state: 'found',
      title: 'Zigbee stopped',
      summary: 'It stopped after the update.',
      fixLabel: 'Restart Zigbee',
      fixStep: 'Restart the Zigbee add-on.',
      conversationId: maras.dmId,
      threadRootId: root,
      startedAt: at,
      stateAt: at,
    });
    await desk.lockNow();
    expect((await refusal(desk.lookFix(key))).code).toBe('locked');
    desk.lock.unlock(now);
    expect(await desk.lookFix(key)).toEqual({ v: 1 });
    const [row] = await db.select().from(lookResearches).where(eq(lookResearches.id, id));
    expect(row?.state).toBe('fixing');
    const [turn] = await db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, row?.dispatchId ?? ''));
    expect(turn).toMatchObject({ trigger: 'look_fix', threadRootId: root });
    expect(await refusal(desk.lookFix(key))).toEqual({ code: 'not_found', details: 404 });
    await db.update(lookResearches).set({ goneAt: at }).where(eq(lookResearches.id, id));
    await desk.lockNow();
  });

  it('previews only a paired screen; the name stays when it is turned off', async () => {
    await desk.setScreen(mara, { on: false });
    expect((await refusal(desk.preview(mara, { scenario: 'now' }))).details).toEqual({ code: 'not_paired' });
    expect((await desk.screen(mara)).showOptions).toBeUndefined();
    expect(await loadWhombatName(m.t.services.db)).toBe('Home');
    expect(DeskState.parse(await desk.state())).toMatchObject({ paired: null, name: 'Home' });
    // The state's check whether to pair itself, waited for: off, it doesn't.
    expect(await desk.pairItself()).toBe(false);
  });
});

describe('screens of widgets (DK-126…DK-149)', () => {
  const db = () => m.t.services.db;
  const layout: DeskLayout = {
    pages: [
      {
        id: 'p_first',
        name: 'Overview',
        layouts: {
          '8x5': [
            { id: 'w_clock', type: 'clock', opts: {}, x: 0, y: 0, w: 4, h: 2 },
            { id: 'w_work', type: 'work', opts: {}, x: 4, y: 0, w: 4, h: 1 },
            { id: 'w_done', type: 'done', opts: {}, x: 4, y: 1, w: 4, h: 2 },
          ],
        },
        last: '8x5',
      },
      { id: 'p_media', name: 'Media', layouts: { '8x5': [] }, last: '8x5' },
    ],
    turn: '30s',
    size: 'larger',
  };

  beforeAll(async () => {
    plugged = MONITOR;
    await desk.setScreen(mara, { on: true });
  });

  it('lists the box’s own screen as the calm glance before anyone changed it, without a row', async () => {
    const list = DeskScreensList.parse(await desk.screensList(mara));
    expect(list.screens.map((s) => [s.id, s.kind, s.popups])).toEqual([['box', 'box', 'all']]);
    expect(list.canAdd).toBe(true);
    const box = DeskScreenDetail.parse(await desk.screenGet(mara, { screen: 'box' }));
    expect(box.layout).toEqual(deskDefaultLayout());
    expect(await db().select().from(screens)).toEqual([]);
    expect((await refusal(desk.screenGet(mara, { screen: 'out_dp-9' }))).details).toEqual({
      code: 'unknown_screen',
    });
  });

  it('keeps a layout as it was saved, signed without words; one it can’t keep is refused', async () => {
    changed.length = 0;
    const saved = DeskScreenDetail.parse(
      await desk.screenUpdate(mara, { screen: 'box', layout, popups: 'problems', name: 'Not its name' }),
    );
    expect(saved).toMatchObject({ layout, popups: 'problems', pages: 2 });
    expect(saved.name).not.toBe('Not its name');
    const [row] = await db().select().from(screens).where(eq(screens.id, 'box'));
    expect(row).toMatchObject({ burrowId: TEST_BURROW_ID, kind: 'box', popups: 'problems' });
    const [event] = await db().select().from(events).where(eq(events.type, 'desk.screen_updated'));
    expect(event).toMatchObject({ actorId: IDS.mara, text: null });
    expect(changed).toContain(topics.me(IDS.mara));
    const overlapping = structuredClone(layout);
    overlapping.pages[0]?.layouts['8x5']?.push({
      id: 'w_x',
      type: 'coming',
      opts: {},
      x: 0,
      y: 0,
      w: 2,
      h: 2,
    });
    expect(
      (await refusal(desk.screenUpdate(mara, { screen: 'box', layout: overlapping }))).details,
    ).toMatchObject({
      code: 'bad_layout',
    });
    const tooSmall = structuredClone(layout);
    const clock = tooSmall.pages[0]?.layouts['8x5']?.[0];
    if (clock) clock.w = 1;
    expect((await refusal(desk.screenUpdate(mara, { screen: 'box', layout: tooSmall }))).code).toBe(
      'validation_failed',
    );
  });

  it('draws the box’s grid beside the calm glance, as the lock lets it; none in Only the time', async () => {
    desk.lock.unlock(now);
    const open = DeskState.parse(await desk.state());
    expect(deskStateValid(open)).toBe(true);
    const grid = DeskGrid.parse(open.glance?.grid);
    expect(grid).toMatchObject({ screen: 'box', layout, popups: 'problems' });
    // Whombat's own read what the glance read: they have views at once; the clock has none of its own.
    expect(grid.views.map((v) => v.id).sort()).toEqual(['w_done', 'w_work']);
    expect(open.glance?.calm).toBeDefined();
    await desk.lockNow();
    await desk.update(mara, { lockedView: 'time' });
    expect(DeskState.parse(await desk.state()).glance?.grid).toBeUndefined();
    await desk.update(mara, { lockedView: 'summary' });
    expect(DeskGrid.parse(DeskState.parse(await desk.state()).glance?.grid).screen).toBe('box');
  });

  it('makes a monitor a screen of its own when the page reports it, and keeps it for the next time', async () => {
    const main = { key: 'edp-1', main: true, name: null, size: { width: 2560, height: 1600 } };
    const monitor = {
      key: 'hdmi-a-1',
      main: false,
      name: 'DELL U2720Q',
      size: { width: 1920, height: 1080 },
    };
    await desk.size([main, monitor]);
    const list = DeskScreensList.parse(await desk.screensList(mara));
    expect(list.screens.map((s) => s.id)).toEqual(['box', 'out_hdmi-a-1']);
    expect(list.screens[0]?.size).toEqual({ width: 2560, height: 1600 });
    expect(list.screens[1]).toMatchObject({
      kind: 'output',
      name: 'DELL U2720Q',
      popups: 'problems',
      online: true,
    });
    const state = DeskState.parse(await desk.state());
    expect(deskStateValid(state)).toBe(true);
    expect(state.glance?.outputs?.map((o) => [o.key, o.name, DeskGrid.parse(o.grid).screen])).toEqual([
      ['hdmi-a-1', 'DELL U2720Q', 'out_hdmi-a-1'],
    ]);
    // Unplugged: not drawn any more, but kept with its layout.
    await desk.size([main]);
    expect(DeskState.parse(await desk.state()).glance?.outputs).toBeUndefined();
    expect((await desk.screensList(mara)).screens.map((s) => s.id)).toEqual(['box', 'out_hdmi-a-1']);
    // Remove forgets it; the box's own can't be removed.
    expect(await desk.screenRemove(mara, { screen: 'out_hdmi-a-1' })).toEqual({ ok: true });
    expect((await desk.screensList(mara)).screens.map((s) => s.id)).toEqual(['box']);
    await expect(desk.screenRemove(mara, { screen: 'box' })).rejects.toMatchObject({ code: 'not_allowed' });
  });

  it('shows a draft on the screen for a minute', async () => {
    const draft = deskDefaultLayout('Draft');
    const { until } = await desk.screenTry(mara, { screen: 'box', layout: draft });
    expect(Date.parse(until)).toBe(now + DESK_TRY_S * 1_000);
    const trying = DeskGrid.parse(DeskState.parse(await desk.state()).glance?.grid);
    expect(trying).toMatchObject({ layout: draft, trying: { until } });
    now += DESK_TRY_S * 1_000;
    expect(DeskGrid.parse(DeskState.parse(await desk.state()).glance?.grid).layout).toEqual(layout);
  });

  it('answers Settings’ live preview and Add a widget', async () => {
    const preview = DeskScreenViews.parse(
      await desk.screenViews(mara, {
        screen: 'box',
        widgets: [
          { id: 'w_work', type: 'work', opts: {} },
          { id: 'w_plex', type: 'figures', ref: 'connection:con_plex', opts: {} },
        ],
        scenario: 'wrong',
      }),
    );
    expect(preview.views.map((v) => [v.id, v.kind])).toEqual([
      ['w_work', 'list'],
      ['w_plex', 'text'],
    ]);
    expect(preview.name).toBeTruthy();
    const catalog = DeskCatalog.parse(await desk.widgets(mara, { screen: 'box' }));
    expect(catalog.groups[0]?.items.map((i) => i.type)).toContain('done');
  });

  it('adds a device in its enrolment’s commit, finds it by its endpoint, and ends it on Remove; at most eight', async () => {
    const tablet = await m.enroll(IDS.mara);
    const { result: added } = await m.t.services.pipeline.transact(TEST_BURROW_ID, (session) =>
      desk.screens.addDevice(session.tx, {
        burrowId: TEST_BURROW_ID,
        personId: IDS.mara,
        endpointId: tablet.endpointId,
        name: 'Kitchen tablet',
        popups: 'problems',
        start: 'copy',
        device: 'iPad · Safari',
      }),
    );
    expect(added).toMatchObject({ kind: 'device', name: 'Kitchen tablet', layout });
    expect((await desk.screens.byEndpoint(tablet.endpointId))?.id).toBe(added.id);
    const listed = DeskScreensList.parse(await desk.screensList(mara)).screens.find((s) => s.id === added.id);
    expect(listed).toMatchObject({ kind: 'device', device: 'iPad · Safari', online: false });
    await desk.screens.seen(added.id, { width: 820, height: 1180 }, new Date(now));
    expect((await desk.screens.get(TEST_BURROW_ID, added.id))?.size).toEqual({ width: 820, height: 1180 });
    // Seven more fill it up.
    await db()
      .insert(screens)
      .values(
        Array.from({ length: 7 }, (_, i) => ({
          id: `scr_filler0${i}`,
          burrowId: TEST_BURROW_ID,
          kind: 'device' as const,
          name: `Filler ${i}`,
          popups: 'none' as const,
          layout: {},
          createdAt: new Date(now),
          updatedAt: new Date(now),
        })),
      );
    expect(DeskScreensList.parse(await desk.screensList(mara)).canAdd).toBe(false);
    const another = await m.enroll(IDS.mara);
    const full = await refusal(
      m.t.services.pipeline.transact(TEST_BURROW_ID, (session) =>
        desk.screens.addDevice(session.tx, {
          burrowId: TEST_BURROW_ID,
          personId: IDS.mara,
          endpointId: another.endpointId,
          name: 'One too many',
          popups: 'none',
          start: 'empty',
          device: null,
        }),
      ),
    );
    expect(full.details).toEqual({ code: 'screens_full' });
    expect(await desk.screenRemove(mara, { screen: added.id })).toEqual({ ok: true });
    expect(await desk.screens.byEndpoint(tablet.endpointId)).toBeNull();
    await db().delete(screens).where(eq(screens.kind, 'device'));
  });

  it('draws a screen elsewhere for whoever added it, and shows no picture its widgets don’t name', async () => {
    const elsewhere = {
      ...(await desk.screens.get(TEST_BURROW_ID, 'box')),
      id: 'scr_kitchen01',
      kind: 'device' as const,
      personId: IDS.mara,
      popups: 'none' as const,
    } as ScreenRecord;
    const { calm, grid } = await desk.screens.draw(elsewhere, 'summary');
    expect(DeskCalm.parse(calm).headline).toBeTruthy();
    expect(DeskGrid.parse(grid)).toMatchObject({ screen: 'scr_kitchen01', popups: 'none' });
    expect(grid.attention.items.every((i) => !i.pops)).toBe(true);
    const ref = `${'a'.repeat(20)}.${'b'.repeat(22)}`;
    expect(await desk.screens.picture(elsewhere, 'everything', 'connection:con_plex', ref)).toBeNull();
    expect((await refusal(desk.image('connection:con_plex', ref))).details).toBe(404);
  });

  it('makes a page from the widgets asked, says what it left out, and keeps to six pages', async () => {
    const before = (await desk.screenGet(mara, { screen: 'box' })).layout;
    const made = DeskScreenAddPageOutput.parse(
      await desk.screenAddPage(mara, {
        screen: 'box',
        name: '  Morning ',
        show: { from: '07:00', to: '09:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
        widgets: [
          { type: 'clock', w: 4, h: 2 },
          { type: 'figures', ref: 'connection:con_nothere' },
          { type: 'done', w: 4, h: 3 },
        ],
      }),
    );
    expect(made.page).toMatchObject({ name: 'Morning', show: { from: '07:00', to: '09:00' } });
    expect(
      Object.values(made.page.layouts)
        .flat()
        .map((w) => w.type),
    ).toEqual(['clock', 'done']);
    expect(made.left).toEqual([{ type: 'figures', ref: 'connection:con_nothere', why: 'unknown' }]);
    const saved = (await desk.screenGet(mara, { screen: 'box' })).layout;
    expect(saved.pages.map((p) => p.id)).toEqual([...before.pages.map((p) => p.id), made.page.id]);
    // Up to six; the seventh only in another's place.
    for (let i = saved.pages.length; i < 6; i++)
      await desk.screenAddPage(mara, { screen: 'box', name: `Page ${i}`, widgets: [{ type: 'clock' }] });
    expect(
      (await refusal(desk.screenAddPage(mara, { screen: 'box', name: 'More', widgets: [{ type: 'clock' }] })))
        .details,
    ).toMatchObject({ code: 'bad_layout' });
    const replaced = await desk.screenAddPage(mara, {
      screen: 'box',
      name: 'Evening',
      widgets: [{ type: 'clock' }],
      replace: made.page.id,
    });
    expect(replaced.page.id).toBe(made.page.id);
    expect((await desk.screenGet(mara, { screen: 'box' })).pages).toBe(6);
    await desk.screenUpdate(mara, { screen: 'box', layout });
  });

  it('keeps the page times an older app’s layout leaves out; a current app changes them', async () => {
    const timed = structuredClone(layout);
    const media = timed.pages[1];
    if (!media) throw new Error('no page');
    media.show = { from: '18:00', to: '23:00' };
    await desk.screenUpdate(mara, { screen: 'box', layout: timed });
    const older = { ...mara, protocolMinor: SCREEN_TIMES_MINOR - 1 } as SessionPrincipal;
    const renamed = structuredClone(layout);
    if (renamed.pages[0]) renamed.pages[0].name = 'Home';
    const kept = await desk.screenUpdate(older, { screen: 'box', layout: renamed });
    expect(kept.layout.pages.map((p) => [p.name, p.show?.from ?? null])).toEqual([
      ['Home', null],
      ['Media', '18:00'],
    ]);
    const current = { ...mara, protocolMinor: SCREEN_TIMES_MINOR } as SessionPrincipal;
    const cleared = await desk.screenUpdate(current, { screen: 'box', layout });
    expect(cleared.layout.pages.every((p) => p.show === undefined)).toBe(true);
  });

  it('opens the doorbell big for a minute on the screens that show it, and on none that don’t', async () => {
    const services = m.t.services;
    expect(DeskScreensList.parse(await desk.screensList(mara)).doorbell).toBeUndefined();
    const protect = await insertConnection(services, {
      handle: 'protect-screens',
      catalogId: 'unifi_protect',
      burrowId: TEST_BURROW_ID,
      fields: { url: 'https://192.168.1.1' },
      secret: 'protect-key',
      auth: { type: 'header', name: 'X-API-KEY', template: '{secret}' },
    });
    try {
      const list = DeskScreensList.parse(await desk.screensList(mara));
      expect(list.doorbell).toBe(true);
      expect(list.screens[0]?.doorbell).toBe('big');
      const ring = {
        connectionId: protect,
        burrowId: TEST_BURROW_ID,
        camera: 'cam_front',
        at: new Date(now),
      };
      desk.lock.unlock(now);
      emitDoorbellRing(services, { ...ring, eventId: 'evt_one' });
      const shown = await vi.waitFor(async () => {
        const grid = DeskGrid.parse(DeskState.parse(await desk.state()).glance?.grid);
        if (grid.spotlight?.widget.ref !== `connection:${protect}`) throw new Error('not yet');
        return grid;
      });
      expect(shown.spotlight).toMatchObject({
        id: 'ring_evt_one',
        reason: 'doorbell',
        until: new Date(now + 60_000).toISOString(),
        widget: {
          type: 'panel',
          ref: `connection:${protect}`,
          opts: { panel: 'cameras', item: 'cam_front' },
        },
      });
      // Its camera is read like any widget's: the box's state never waits for a first read, so its view follows.
      // Don't: the moment showing now ends at once.
      const off = await desk.screenUpdate(mara, { screen: 'box', doorbell: 'off' });
      expect(off.doorbell).toBe('off');
      expect(DeskGrid.parse(DeskState.parse(await desk.state()).glance?.grid).spotlight).toBeUndefined();
      await desk.screenUpdate(mara, { screen: 'box', doorbell: 'big' });
      // A new ring shows for a minute, then it's over.
      emitDoorbellRing(services, { ...ring, at: new Date(now), eventId: 'evt_two' });
      await vi.waitFor(async () => {
        const grid = DeskGrid.parse(DeskState.parse(await desk.state()).glance?.grid);
        if (grid.spotlight?.id !== 'ring_evt_two') throw new Error('not yet');
      });
      now += 60_000;
      expect(DeskGrid.parse(DeskState.parse(await desk.state()).glance?.grid).spotlight).toBeUndefined();
    } finally {
      await services.db.delete(catalogConnections).where(eq(catalogConnections.id, protect));
    }
  });
});

describe('what a screen may load (DK-138, DK-142)', () => {
  const thing = 'connection:con_frontdoor01';
  const camRef = `cam${'a'.repeat(20)}.signature`;
  const rowRef = `row${'b'.repeat(20)}.signature`;
  const otherRef = `oth${'c'.repeat(20)}.signature`;
  /** The same connection twice: a camera (private) and a list of sensors with a small picture each (not private). */
  const things: ThingWidgets = {
    groups: async () => [],
    resolve: async (_ctx, specs) =>
      new Map(
        specs.map((s) => [
          s.id,
          s.opts.panel === 'cameras'
            ? {
                view: {
                  kind: 'camera' as const,
                  id: s.id,
                  title: 'Front door',
                  image: { thing, ref: camRef, shape: 'wide' as const },
                },
                private: true,
                refreshS: 10,
              }
            : {
                view: {
                  kind: 'list' as const,
                  id: s.id,
                  title: 'Sensors',
                  rows: [{ title: 'Hall', image: { thing, ref: rowRef, shape: 'square' as const } }],
                },
                private: false,
                refreshS: 60,
              },
        ]),
      ),
  };
  const fetched: string[] = [];
  let pictured: DeskService;
  const kitchen = (): ScreenRecord => ({
    id: 'scr_pictures01',
    burrowId: TEST_BURROW_ID,
    kind: 'device',
    name: 'Kitchen',
    popups: 'none',
    doorbell: 'big',
    layout: {
      pages: [
        {
          id: 'p_first',
          name: 'Overview',
          layouts: {
            '8x5': [
              { id: 'w_cam', type: 'panel', ref: thing, opts: { panel: 'cameras' }, x: 0, y: 0, w: 4, h: 3 },
              { id: 'w_hall', type: 'panel', ref: thing, opts: { panel: 'sensors' }, x: 4, y: 0, w: 4, h: 3 },
            ],
          },
          last: '8x5',
        },
      ],
      turn: 'touch',
      size: 'normal',
    },
    show: DEFAULT_DESK_SHOW,
    endpointId: null,
    personId: IDS.mara,
    device: null,
    size: null,
    lastSeenAt: null,
  });

  beforeAll(async () => {
    pictured = new DeskService(m.t.services, {
      display: { display: async () => NO_DISPLAY, connected: async () => false },
      push: null,
      things,
      picture: async (_services, _viewer, _thing, ref) => {
        fetched.push(ref);
        return { bytes: Buffer.from(ref), contentType: 'image/jpeg', etag: 'e', snapshot: false };
      },
    });
    // Drawn once, so its widgets are read.
    await pictured.screens.draw(kitchen(), 'everything');
  });

  afterAll(() => pictured.close());

  it('locked, only the pictures of what it shows: a private widget’s isn’t, even of a connection it shows', async () => {
    expect(await pictured.screens.picture(kitchen(), 'summary', thing, camRef)).toBeNull();
    expect(await pictured.screens.picture(kitchen(), 'summary', thing, rowRef)).not.toBeNull();
    expect(fetched).toEqual([rowRef]);
  });

  it('unlocked, the private one’s too; a signed ref no view names never', async () => {
    expect(await pictured.screens.picture(kitchen(), 'everything', thing, camRef)).not.toBeNull();
    expect(await pictured.screens.picture(kitchen(), 'everything', thing, otherRef)).toBeNull();
    expect(await pictured.screens.picture(kitchen(), 'summary', thing, otherRef)).toBeNull();
    expect(await pictured.screens.picture(kitchen(), 'time', thing, rowRef)).toBeNull();
    expect(fetched).not.toContain(otherRef);
  });

  it('a device screen whose person went draws and shows for nobody', async () => {
    const orphan = { ...kitchen(), personId: null };
    expect(await pictured.screens.picture(orphan, 'everything', thing, rowRef)).toBeNull();
    await expect(pictured.screens.draw(orphan, 'summary')).rejects.toThrow();
  });
});

describe('Home widgets on a locked screen (DK-138)', () => {
  it('a widget fed by a connection whose kind is private is private; a server’s metric isn’t', async () => {
    const services = m.t.services;
    const todoist = await insertConnection(services, {
      catalogId: 'todoist',
      burrowId: TEST_BURROW_ID,
      label: 'Todoist',
      secret: 'x',
    });
    const grafana = await insertConnection(services, {
      catalogId: 'grafana',
      burrowId: TEST_BURROW_ID,
      label: 'Grafana',
      fields: { url: 'http://grafana.home-test.test:3000' },
      secret: 'x',
    });
    const series = [{ key: 'n', label: 'Open', color: 1 as const }];
    const values = [{ key: 'n', label: 'Open', path: '/n' }];
    const row = (title: string, source: typeof homeWidgetRows.$inferInsert.source) => ({
      id: newId('widget'),
      burrowId: TEST_BURROW_ID,
      ownerId: IDS.mara,
      title,
      source,
      series,
      createdAt: services.clock(),
    });
    const rows = [
      row('Tasks today', { kind: 'connection_tool', connectionId: todoist, tool: 'tasks', args: {}, values }),
      row('Dashboards', { kind: 'connection_tool', connectionId: grafana, tool: 'search', args: {}, values }),
      row('pve-01 load', { kind: 'server_metric', serverId: 'pve-01', series: ['cpu_pct'] }),
    ];
    await services.db.insert(homeWidgetRows).values(rows);
    const read = await screenHomeWidgets(
      services.db,
      { id: IDS.mara, burrowId: TEST_BURROW_ID },
      services.clock(),
    );
    const secret = (title: string) => read.find((w) => w.title === title)?.private === true;
    expect([secret('Tasks today'), secret('Dashboards'), secret('pve-01 load')]).toEqual([
      true,
      false,
      false,
    ]);
    const tasks = read.find((w) => w.title === 'Tasks today');
    expect(homeWidgetView('w_tasks', tasks).private).toBe(true);
    await services.db.delete(homeWidgetRows).where(eq(homeWidgetRows.ownerId, IDS.mara));
  });
});
