/**
 * Remote help in the runtime (remote-help-server.md RH-S02…RH-S10), on the fake support service and in-memory parts:
 * the person's devices only, the passkey step-up bound to the choice it was begun for (single use, 300 s, this device),
 * the state as the person and the desk see it, the follower recording each event once and telling at most once, and the
 * fake.
 * The real passkey checks and the signed chain are in `passkeys.int.test.ts`.
 */
import type { SupportEvent, SupportState } from '@whombat/control-contracts/local';
import type { WebAuthnAuthenticationResponse } from '@whombat/protocol/session';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../services';
import type { SessionScope } from './claim';
import { FakeSupport } from './fake-support';
import {
  deskRemoteHelpOf,
  grantorName,
  noticeOf,
  REMOTE_HELP_SESSION_HANDLERS,
  REMOTE_HELP_STALE_MS,
  REMOTE_HELP_VISIT_QUIET_MS,
  type RemoteHelpCursorStore,
  type RemoteHelpRecord,
  RemoteHelpService,
  recordOf,
  remoteHelpStateOf,
} from './remote-help';
import { SupportCallError, type SupportPort } from './remote-help-client';
import { type TestIdentity, testIdentity } from './testing';
import type { AccountRow, EndpointRow, SessionPrincipal } from './trust';

const T0 = Date.parse('2026-10-21T12:00:00.000Z');
const OWNERS = ['acc_mara', 'acc_joris', 'acc_priya'];

class MemoryStore implements RemoteHelpCursorStore {
  seq = 0;
  hostKey: string | null = null;
  records: RemoteHelpRecord[] = [];
  async load() {
    return { seq: this.seq, hostKey: this.hostKey };
  }
  async reset(hostKey: string | null) {
    this.seq = 0;
    this.hostKey = hostKey;
  }
  async advance(seq: number, hostKey: string | null, record: RemoteHelpRecord | null) {
    if (this.seq >= seq) return false;
    if (record) this.records.push(record);
    this.seq = seq;
    this.hostKey = hostKey;
    return true;
  }
}

function person(accountId: string, identity: TestIdentity = testIdentity()): SessionPrincipal {
  return {
    peerId: identity.peerId,
    publicKey: identity.publicKey,
    endpoint: { id: `ep_${accountId}` } as EndpointRow,
    account: {
      id: accountId,
      name: accountId.slice(4, 5).toUpperCase() + accountId.slice(5),
      email: 'x@example.com',
    } as AccountRow,
    authzGeneration: 1,
  };
}

/** What a browser sends: the challenge it signed rides in `clientDataJSON` (the fake passkeys read it back). */
function assertion(challenge: string, id = 'cred_mara'): WebAuthnAuthenticationResponse {
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {
      clientDataJSON: Buffer.from(JSON.stringify({ challenge })).toString('base64url'),
      authenticatorData: 'AA',
      signature: 'AA',
    },
    clientExtensionResults: {},
  };
}

function setup(
  o: { environment?: 'local' | 'prod'; port?: SupportPort; store?: MemoryStore; noChat?: string[] } = {},
) {
  let now = T0;
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const services = {
    clock: () => new Date(now),
    log,
    maintenance: { quarantined: false },
  } as unknown as Services;
  const timers: { at: number; fn: () => void }[] = [];
  const after = (ms: number, fn: () => void) => {
    const t = { at: now + ms, fn };
    timers.push(t);
    return () => {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
    };
  };
  const fake = new FakeSupport(() => now, {
    environment: o.environment ?? 'local',
    visitAfterMs: null,
    after,
  });
  const store = o.store ?? new MemoryStore();
  /** Credential id → its account: Mara has a passkey, the others don't. */
  const credentials = new Map([['cred_mara', 'acc_mara']]);
  const told: { personId: string; text: string }[] = [];
  const pushes: { ids: string[]; what: string; title: string }[] = [];
  /** Accounts with no Chat to be told in. */
  const noChat = new Set<string>(o.noChat ?? []);
  const service = new RemoteHelpService(services, o.port ?? fake, {
    store,
    passkeys: {
      hasPasskey: async (accountId) => [...credentials.values()].includes(accountId),
      stepUpOptions: async (accountId, challenge) =>
        [...credentials.values()].includes(accountId)
          ? {
              challenge,
              rpId: 'app.whombat.test',
              allowCredentials: [{ type: 'public-key', id: 'cred_mara' }],
              userVerification: 'required',
              timeout: 120_000,
            }
          : null,
      confirm: async (accountId, response, challenge) => {
        const signed = JSON.parse(
          Buffer.from(response.response.clientDataJSON, 'base64url').toString(),
        ).challenge;
        return credentials.get(response.id) === accountId && signed === challenge();
      },
    },
    push: {
      security: async (ids, what, notice) => {
        pushes.push({ ids: [...ids], what, title: notice.title });
      },
    },
    tell: async (_services, _burrow, personId, text) => {
      if (noChat.has(personId.replace(/^p_/, ''))) return false;
      told.push({ personId, text });
      return true;
    },
    personAccounts: async (except) => OWNERS.filter((id) => id !== except),
    placeOf: async (accountId) => ({ burrowId: 'brw_1', personId: `p_${accountId}` }),
    after,
    waitS: 0,
  });
  return {
    services,
    log,
    fake,
    store,
    service,
    told,
    pushes,
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((x) => x.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

const scope = (): SessionScope => ({ claimBegin: null });
const code = (err: unknown) => (err as { details?: { code?: string } }).details?.code;

describe('the person’s devices only (RH-04)', () => {
  it('refuses a device that isn’t let in every op; a runtime without support says it isn’t available', async () => {
    const { service } = setup();
    const unenrolled = { ...person('acc_tom'), endpoint: null, account: null };
    await expect(service.get(unenrolled)).rejects.toMatchObject({ code: 'unauthorized' });
    for (const [op, input] of [
      ['remoteHelp.get', {}],
      ['remoteHelp.start', { level: 'look', duration: 'hour' }],
      ['remoteHelp.stop', {}],
      ['remoteHelp.visits', {}],
    ] as const)
      await expect(
        REMOTE_HELP_SESSION_HANDLERS[op]?.(
          { principal: unenrolled, session: scope(), remoteHelp: service },
          input,
        ),
      ).rejects.toMatchObject({ code: 'unauthorized' });
    const mara = person('acc_mara');
    const none = { principal: mara, session: scope(), remoteHelp: undefined };
    expect(await REMOTE_HELP_SESSION_HANDLERS['remoteHelp.get']?.(none, {})).toMatchObject({
      available: false,
      grant: null,
    });
    const refused = await REMOTE_HELP_SESSION_HANDLERS['remoteHelp.start']?.(none, {
      level: 'look',
      duration: 'hour',
    }).catch((e: unknown) => e);
    expect(code(refused)).toBe('remote_help_unavailable');
  });

  it('answers remote_help_busy when the service doesn’t answer', async () => {
    const down: SupportPort = {
      state: () => Promise.reject(new SupportCallError('/v1/state', 0, 'unreachable', 'ECONNREFUSED')),
    } as unknown as SupportPort;
    const { service } = setup({ port: down });
    const err = await service.get(person('acc_mara')).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'unavailable', details: { code: 'remote_help_busy' } });
    expect(await service.refresh()).toBeNull();
    expect(service.answering).toBe(false);
  });
});

describe('turning it on (RH-03, RH-04, RH-S04)', () => {
  it('lets the person without a passkey start without one, named as the grantor', async () => {
    const { service } = setup();
    const joris = person('acc_joris');
    const session = scope();
    expect(await service.confirmBegin(joris, session, { level: 'fix', duration: 'day' })).toEqual({
      nonce: null,
      options: null,
    });
    const state = await service.start(joris, session, { level: 'fix', duration: 'day' });
    expect(state.grant).toMatchObject({
      level: 'fix',
      until: new Date(T0 + 86_400_000).toISOString(),
      grantedBy: { accountId: 'acc_joris', name: 'Joris' },
      helpCode: null,
    });
  });

  it('asks the person with a passkey for it, bound to this level, duration and device, once', async () => {
    const { service, advance } = setup();
    const id = testIdentity();
    const mara = person('acc_mara', id);
    const session = scope();
    const choice = { level: 'look', duration: 'week' } as const;
    expect(code(await service.start(mara, session, choice).catch((e: unknown) => e))).toBe(
      'passkey_required',
    );

    const begun = await service.confirmBegin(mara, session, choice);
    expect(begun.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(begun.options).toMatchObject({
      userVerification: 'required',
      allowCredentials: [{ id: 'cred_mara' }],
    });
    const signed = assertion(begun.options?.challenge ?? '');
    // Another level or duration than the begin's: refused, and the begin is used up.
    const other = await service
      .start(mara, session, { ...choice, level: 'fix', passkey: signed })
      .catch((e) => e);
    expect(code(other)).toBe('passkey_failed');
    expect(code(await service.start(mara, session, { ...choice, passkey: signed }).catch((e) => e))).toBe(
      'passkey_failed',
    );

    // A fresh begin confirms exactly its choice, once.
    const again = await service.confirmBegin(mara, session, choice);
    const good = assertion(again.options?.challenge ?? '');
    expect((await service.start(mara, session, { ...choice, passkey: good })).grant?.level).toBe('look');
    expect(code(await service.start(mara, session, { ...choice, passkey: good }).catch((e) => e))).toBe(
      'passkey_failed',
    );

    // The same choice begun on another device of hers isn't this session's: the challenge names the device.
    const elsewhere = await service.confirmBegin(person('acc_mara'), scope(), choice);
    await service.confirmBegin(mara, session, choice);
    const wrongDevice = assertion(elsewhere.options?.challenge ?? '');
    expect(
      code(await service.start(mara, session, { ...choice, passkey: wrongDevice }).catch((e) => e)),
    ).toBe('passkey_failed');

    // A begin older than 300 s.
    const late = await service.confirmBegin(mara, session, choice);
    advance(301_000);
    const stale = assertion(late.options?.challenge ?? '');
    expect(code(await service.start(mara, session, { ...choice, passkey: stale }).catch((e) => e))).toBe(
      'passkey_failed',
    );
  });

  it('leaves Forever to the service: allowed on a test Whombat, refused on a customer’s, the help code shown there', async () => {
    const test = setup();
    const joris = person('acc_joris');
    expect(
      (await test.service.start(joris, scope(), { level: 'fix', duration: 'forever' })).grant?.until,
    ).toBeNull();

    const prod = setup({ environment: 'prod' });
    const refused = await prod.service
      .start(joris, scope(), { level: 'fix', duration: 'forever' })
      .catch((e) => e);
    expect(refused).toMatchObject({ code: 'not_allowed', details: { code: 'forever_not_allowed' } });
    const state = await prod.service.start(joris, scope(), { level: 'look', duration: 'hour' });
    expect(state.helpCodeRequired).toBe(true);
    expect(state.grant?.helpCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  });

  it('stops without asking, and stopping what is off changes nothing', async () => {
    const { service } = setup();
    const joris = person('acc_joris');
    await service.start(joris, scope(), { level: 'look', duration: 'hour' });
    expect((await service.stop(person('acc_mara'))).grant).toBeNull();
    expect((await service.stop(person('acc_mara'))).grant).toBeNull();
  });
});

describe('what the person and the desk see (RH-S02, RH-S03, RH-S08)', () => {
  const state = (over: Partial<SupportState> = {}): SupportState => ({
    v: 1,
    available: true,
    foreverAllowed: false,
    helpCodeRequired: false,
    environment: 'prod',
    hostKey: null,
    grant: {
      level: 'fix',
      since: '2026-10-21T11:00:00.000Z',
      until: '2026-10-21T13:00:00.000Z',
      grantedBy: { accountId: 'acc_mara', name: 'Mara' },
      helpCode: 'KQ72MX',
      wrongCodes: 2,
    },
    connected: [
      { visitId: 'v_1', who: 'Claude (opr_123 via john)', since: '2026-10-21T11:10:00.000Z' },
      { visitId: 'v_2', who: 'Sam\u001b[31m (opr_9)', since: '2026-10-21T11:20:00.000Z' },
    ],
    ...over,
  });

  it('never shows the wrong-code count, the help code only when it is needed, and names without operators', () => {
    const plain = remoteHelpStateOf(state());
    expect(plain.grant).not.toHaveProperty('wrongCodes');
    expect(plain.grant?.helpCode).toBeNull();
    expect(plain.connected.map((c) => c.who)).toEqual(['Claude', expect.stringMatching(/^Sam/)]);
    expect(plain.connected.map((c) => c.who).join()).not.toContain('opr_');
    expect(remoteHelpStateOf(state({ helpCodeRequired: true })).grant?.helpCode).toBe('KQ72MX');
  });

  it('gives the desk a line while on: the newest person connected, nothing once it ran out or is off', () => {
    expect(deskRemoteHelpOf(state(), Date.parse('2026-10-21T12:00:00Z'))).toEqual({
      level: 'fix',
      until: '2026-10-21T13:00:00.000Z',
      connected: expect.stringMatching(/^Sam/),
    });
    expect(deskRemoteHelpOf(state(), Date.parse('2026-10-21T13:00:00Z'))).toBeUndefined();
    expect(deskRemoteHelpOf(state({ grant: null }), T0)).toBeUndefined();
    expect(deskRemoteHelpOf(state({ connected: [] }), T0)?.connected).toBeNull();
  });

  it('names the grantor by name, else by their email’s local part', () => {
    expect(grantorName({ name: ' Mara\u0007 ', email: 'x@example.com' })).toBe('Mara');
    expect(grantorName({ name: '', email: 'mara@example.com' })).toBe('mara');
  });

  it('lists visits with clean names and gives a visit’s command line without escapes', async () => {
    const { service } = setup();
    const mara = person('acc_mara');
    const { visits } = await service.visits(mara, {});
    expect(visits.map((v) => [v.id, v.level, v.who])).toEqual([
      ['v_fake_fix', 'fix', 'Support'],
      ['v_fake_look', 'look', 'Support'],
    ]);
    const { stream, name } = await service.transcript(mara, { visitId: 'v_fake_fix' });
    const parts: Uint8Array[] = [];
    for await (const p of stream) parts.push(p);
    const text = new TextDecoder().decode(Buffer.concat(parts));
    expect(name).toContain('v_fake_fix');
    expect(text).toContain('systemctl restart whombat-voice');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: what must not be there.
    expect(text).not.toMatch(/[\u001b\r]/);
    await expect(service.transcript(mara, { visitId: 'v_fake_look' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('what each event leaves behind (RH-08)', () => {
  const event = (over: Partial<SupportEvent>): SupportEvent => ({
    seq: 1,
    at: '2026-10-21T12:00:00.000Z',
    kind: 'grant',
    ...over,
  });

  it('records on, off and each visit as appliance events; a visit’s start only with its end', () => {
    expect(
      recordOf(event({ level: 'fix', duration: 'forever', by: { accountId: 'acc_mara', name: 'Mara' } })),
    ).toMatchObject({
      type: 'remote_help.on',
      accountId: 'acc_mara',
      payload: { level: 'fix', duration: 'forever' },
    });
    expect(recordOf(event({ kind: 'stop', reason: 'desk' }))).toMatchObject({
      type: 'remote_help.off',
      accountId: null,
      payload: { reason: 'desk' },
    });
    expect(recordOf(event({ kind: 'expired' }))?.payload).toEqual({ reason: 'expired' });
    expect(recordOf(event({ kind: 'locked_out' }))?.payload).toEqual({ reason: 'wrong_codes' });
    expect(recordOf(event({ kind: 'visit_start', visitId: 'v_1', who: 'Claude' }))).toBeNull();
    expect(
      recordOf(event({ kind: 'visit_end', visitId: 'v_1', who: 'Claude (opr_1)', steps: 7 }), {
        startedAt: '2026-10-21T11:30:00.000Z',
        level: 'look',
      })?.payload,
    ).toEqual({
      visitId: 'v_1',
      who: 'Claude',
      level: 'look',
      startedAt: '2026-10-21T11:30:00.000Z',
      endedAt: '2026-10-21T12:00:00.000Z',
      steps: 7,
    });
  });

  it('tells nobody of their own grant, and the person of a visit (with a push) and of five wrong codes', () => {
    const grant = noticeOf(
      event({ level: 'look', duration: 'hour', by: { accountId: 'acc_mara', name: 'Mara' } }),
    );
    expect(grant).toMatchObject({ except: 'acc_mara', push: null, unlessSaidWithinMs: null });
    expect(grant?.text).toContain('for 1 hour');
    const visit = noticeOf(event({ kind: 'visit_start', visitId: 'v_9', who: 'Claude (opr_1)' }));
    // A visit soon after one by the same visitor isn't said again in the Chat.
    expect(visit).toMatchObject({
      except: null,
      push: { what: 'remote-help-visit:v_9', notice: { path: expect.stringContaining('section=about') } },
      unlessSaidWithinMs: REMOTE_HELP_VISIT_QUIET_MS,
    });
    expect(visit?.text).toMatch(/^Claude is looking at this Whombat now/);
    expect(visit?.text).toContain('Settings → This Whombat → About');
    expect(noticeOf(event({ kind: 'locked_out' }))?.push).toBeTruthy();
    expect(noticeOf(event({ kind: 'expired' }))).toBeNull();
  });
});

describe('the follower (RH-S05, RH-S06)', () => {
  it('records each event once, tells owners once, and a restart repeats nothing', async () => {
    const s = setup();
    const mara = person('acc_mara');
    const joris = person('acc_joris');
    await s.service.start(joris, scope(), { level: 'look', duration: 'hour' });
    s.fake.startVisit('Claude (opr_1)');
    expect(await s.service.followOnce(0)).toBe(2);
    expect(s.store.records.map((r) => r.type)).toEqual(['remote_help.on']);
    // The grant: Mara and Priya are told, not Joris; the visit: everyone, in their Chat (which buzzes), no other push.
    expect(s.told.filter((t) => t.text.includes('turned on')).map((t) => t.personId)).toEqual([
      'p_acc_mara',
      'p_acc_priya',
    ]);
    expect(s.told.filter((t) => t.text.startsWith('Claude is looking')).map((t) => t.personId)).toEqual(
      OWNERS.map((id) => `p_${id}`),
    );
    expect(s.pushes).toEqual([]);
    expect(s.service.deskView()).toMatchObject({ level: 'look', connected: 'Claude' });

    await s.service.stop(mara);
    // A restart: a new service on the same cursor reads the same log from where it was.
    const again = new RemoteHelpService(s.services, s.fake, {
      store: s.store,
      personAccounts: async () => OWNERS,
      placeOf: async (id) => ({ burrowId: 'b', personId: `p_${id}` }),
      tell: async (_s, _b, personId, text) => {
        s.told.push({ personId, text });
        return true;
      },
      waitS: 0,
    });
    const before = s.told.length;
    expect(await again.followOnce(0)).toBe(2);
    expect(await again.followOnce(0)).toBe(0);
    expect(s.told.length).toBe(before);
    expect(s.store.records.map((r) => [r.type, r.payload])).toEqual([
      ['remote_help.on', { level: 'look', duration: 'hour' }],
      ['remote_help.visit', expect.objectContaining({ who: 'Claude', level: 'look', steps: 4 })],
      ['remote_help.off', { reason: 'owner' }],
    ]);
    expect(s.store.records[2]?.accountId).toBe('acc_mara');
  });

  it('pushes a visit in words only to someone without a Chat to say it in', async () => {
    const s = setup({ noChat: ['acc_priya'] });
    await s.service.start(person('acc_joris'), scope(), { level: 'look', duration: 'hour' });
    s.fake.startVisit('Claude (opr_1)');
    await s.service.followOnce(0);
    expect(s.pushes).toEqual([
      {
        ids: ['acc_priya'],
        what: expect.stringMatching(/^remote-help-visit:/),
        title: 'Support is looking at your Whombat',
      },
    ]);
  });

  it('records what is old without telling anyone; five wrong codes are told to every owner', async () => {
    const s = setup();
    await s.service.start(person('acc_joris'), scope(), { level: 'fix', duration: 'hour' });
    s.advance(REMOTE_HELP_STALE_MS + 1);
    await s.service.followOnce(0);
    expect(s.store.records).toHaveLength(2);
    expect(s.told).toEqual([]);
    expect(s.store.records.map((r) => r.payload)).toEqual([
      { level: 'fix', duration: 'hour' },
      { reason: 'expired' },
    ]);

    await s.service.start(person('acc_joris'), scope(), { level: 'fix', duration: 'hour' });
    for (let i = 0; i < 5; i++) s.fake.wrongCode();
    await s.service.followOnce(0);
    expect(s.told.filter((t) => t.text.includes('5 wrong help codes'))).toHaveLength(3);
    expect(s.pushes).toEqual([]);
    expect(s.store.records.at(-1)?.payload).toEqual({ reason: 'wrong_codes' });
  });

  it('starts from the beginning of a new log: a new host key, or a log that went back', async () => {
    const store = new MemoryStore();
    store.seq = 40;
    store.hostKey = 'ssh-ed25519 AAAAold';
    const s = setup({ store });
    await s.service.start(person('acc_joris'), scope(), { level: 'look', duration: 'hour' });
    expect(await s.service.followOnce(0)).toBe(1);
    expect(store.seq).toBe(1);
    expect(store.hostKey).toMatch(/^ssh-ed25519 /);

    // Same key, but the service's newest is behind the cursor: its events started again.
    store.seq = 99;
    const fresh = setup({ store });
    await fresh.service.start(person('acc_joris'), scope(), { level: 'look', duration: 'hour' });
    expect(await fresh.service.followOnce(0)).toBe(0);
    expect(store.seq).toBe(0);
    expect(await fresh.service.followOnce(0)).toBe(1);
  });

  it('keeps the cursor when recording fails, so the event comes again', async () => {
    const store = new MemoryStore();
    const failing = Object.assign(store, {
      fail: true,
      advance: async function (
        this: MemoryStore & { fail: boolean },
        ...args: Parameters<MemoryStore['advance']>
      ) {
        if (this.fail) throw new Error('database gone');
        return MemoryStore.prototype.advance.apply(this, args);
      },
    });
    const s = setup({ store: failing });
    await s.service.start(person('acc_joris'), scope(), { level: 'look', duration: 'hour' });
    await expect(s.service.followOnce(0)).rejects.toThrow('database gone');
    expect(s.told).toEqual([]);
    failing.fail = false;
    expect(await s.service.followOnce(0)).toBe(1);
    expect(s.told).toHaveLength(2);
  });
});

describe('the fake support service (RH-S10)', () => {
  it('lets “Claude” in a moment after it is turned on, and out when it runs out', async () => {
    let now = T0;
    const timers: { at: number; fn: () => void }[] = [];
    const fake = new FakeSupport(() => now, {
      after: (ms, fn) => {
        timers.push({ at: now + ms, fn });
        return () => {};
      },
    });
    await fake.grant({ level: 'look', duration: 'hour', grantedBy: { accountId: 'acc_mara', name: 'Mara' } });
    expect((await fake.state()).connected).toEqual([]);
    now += 3_000;
    for (const t of timers.splice(0)) t.fn();
    expect((await fake.state()).connected.map((c) => c.who)).toEqual(['Support']);
    now += 3_600_000;
    const { events } = await fake.events(0, 0);
    expect(events.map((e) => e.kind)).toEqual(['grant', 'visit_start', 'visit_end', 'expired']);
    expect(events[2]).toMatchObject({ level: 'look', startedAt: new Date(T0 + 3_000).toISOString() });
    expect((await fake.state()).grant).toBeNull();
  });
});
