/**
 * A retired Whombat (AP-693…AP-695): control's ticket refusal told apart by the directory, the session's reasons, the
 * list's rows and words. Control's answers are control's own (`tickets/client.ts`, `devices/directory.ts`,
 * `http.ts`'s error body).
 */
import { describe, expect, it } from 'vitest';
import { ApplianceRefusedError, createManagedConnector, TicketDeniedError } from '../session/connector';
import { createFakeAppliance } from '../session/fake';
import { createSecureSession } from '../session/secure';
import type { ConnectionState } from '../session/types';
import { ConnectError } from '../session/wire';
import { looksNearbyFirst } from './claim';
import { type ApplianceSummary, ControlError, createHttpControl } from './control';
import {
  appliancesEmptyText,
  controlTickets,
  goneNotice,
  goneOf,
  listedAppliances,
  UNLISTED_GIVE_UP_MS,
} from './retired';

const ORG = 'org_burrowhq';
const DEVICE = 'dev_7KQ2M4XD';

const summary = (device: string, state: ApplianceSummary['state'], name: string | null = 'Burrow HQ') => ({
  device,
  orgId: ORG,
  name,
  state,
  contentPeerId: `12D3KooW${'A'.repeat(44)}`,
  lastSeenAt: 1_790_000_000,
  revocationsPending: 0,
});

/** control's directory row (`DirectoryDevice`). */
const row = (device: string, state: string) => ({
  device,
  state,
  origin: 'factory',
  org: ORG,
  name: 'Burrow HQ',
  model: 'wb-mini-1',
  hardwareSerial: 'WB-0001',
  contentPeerId: `12D3KooW${'A'.repeat(44)}`,
  registeredAt: 1_780_000_000,
  claimedAt: 1_780_000_100,
  lastSeenAt: 1_790_000_000,
  status: null,
  revocations: [],
});

/** Control over HTTP as control answers: the ticket, then the organization's directory. */
function control(answers: {
  ticket: { status: number; body: unknown } | 'down';
  devices?: { status: number; body: unknown } | 'down';
}) {
  const asked: string[] = [];
  const reply = (a: { status: number; body: unknown } | 'down') => {
    if (a === 'down') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(a.body), { status: a.status });
  };
  const http = createHttpControl('http://control.test', {
    tokens: { get: () => 't', set: () => {}, remove: () => {} },
    fetch: async (url) => {
      asked.push(url.replace('http://control.test/v1', ''));
      if (url.endsWith('/tickets')) return reply(answers.ticket);
      return reply(answers.devices ?? { status: 200, body: { devices: [] } });
    },
  });
  return { http, asked };
}

/** `tickets.client` refusing a device control won't route for this organization (`device_not_found`). */
const NO_SUCH_DEVICE = {
  status: 404,
  body: {
    error: {
      code: 'not_found',
      message: 'No such appliance in this organization.',
      details: { code: 'device_not_found' },
    },
  },
};
const ISSUED = {
  status: 200,
  body: { ticket: 'tkt', relay: { url: 'wss://relay.test/v1/connect' }, expiresAt: 1_790_000_060 },
};
const request = { channel: 'app', class: 'interactive' } as const;

describe('control’s ticket refusal, told apart by the directory (AP-693)', () => {
  it('keeps the precise reason control named on the error', async () => {
    const { http } = control({ ticket: NO_SUCH_DEVICE });
    const error = await http
      .ticket({ orgId: ORG, device: DEVICE, ...request })
      .catch((e: unknown) => e as ControlError);
    expect(error).toBeInstanceOf(ControlError);
    expect(error).toMatchObject({ code: 'not_found', reason: 'device_not_found' });
  });

  it('a Whombat the directory lists retired is refused for good', async () => {
    const { http, asked } = control({
      ticket: NO_SUCH_DEVICE,
      devices: { status: 200, body: { devices: [row(DEVICE, 'retired')] } },
    });
    const error = await controlTickets(http, { orgId: ORG, device: DEVICE })(request).catch((e) => e);
    expect(error).toBeInstanceOf(ApplianceRefusedError);
    expect(error).toMatchObject({ reason: 'appliance_retired' });
    expect(asked).toEqual([`/orgs/${ORG}/tickets`, `/orgs/${ORG}/devices`]);
  });

  it('one it doesn’t list is retried (an unreported claim looks the same), and given up after ten minutes', async () => {
    let t = 0;
    const { http } = control({ ticket: NO_SUCH_DEVICE });
    const tickets = controlTickets(http, { orgId: ORG, device: DEVICE }, { now: () => t });
    expect(UNLISTED_GIVE_UP_MS).toBe(600_000);
    await expect(tickets(request)).rejects.toMatchObject({ reason: 'appliance_unlisted' });
    t = UNLISTED_GIVE_UP_MS - 1;
    await expect(tickets(request)).rejects.toMatchObject({ reason: 'appliance_unlisted' });
    t = UNLISTED_GIVE_UP_MS;
    await expect(tickets(request)).rejects.toMatchObject({ reason: 'appliance_gone' });
  });

  it('a ticket issued in between starts the ten minutes again (the claim was reported)', async () => {
    let t = 0;
    let answer: typeof NO_SUCH_DEVICE | typeof ISSUED = NO_SUCH_DEVICE;
    const http = createHttpControl('http://control.test', {
      tokens: { get: () => 't', set: () => {}, remove: () => {} },
      fetch: async (url) =>
        url.endsWith('/tickets')
          ? new Response(JSON.stringify(answer.body), { status: answer.status })
          : new Response(JSON.stringify({ devices: [] })),
    });
    const tickets = controlTickets(http, { orgId: ORG, device: DEVICE }, { now: () => t });
    await expect(tickets(request)).rejects.toMatchObject({ reason: 'appliance_unlisted' });
    t = 5 * 60_000;
    answer = ISSUED;
    await expect(tickets(request)).resolves.toEqual({
      ticket: 'tkt',
      relayUrl: 'wss://relay.test/v1/connect',
    });
    answer = NO_SUCH_DEVICE;
    t = UNLISTED_GIVE_UP_MS + 1;
    await expect(tickets(request)).rejects.toMatchObject({ reason: 'appliance_unlisted' });
  });

  it('listed in use, or a directory that can’t be read, is unlisted too: never retired on a guess', async () => {
    const listed = control({
      ticket: NO_SUCH_DEVICE,
      devices: { status: 200, body: { devices: [row(DEVICE, 'claimed')] } },
    });
    await expect(controlTickets(listed.http, { orgId: ORG, device: DEVICE })(request)).rejects.toMatchObject({
      reason: 'appliance_unlisted',
    });
    const unreadable = control({ ticket: NO_SUCH_DEVICE, devices: 'down' });
    await expect(
      controlTickets(unreadable.http, { orgId: ORG, device: DEVICE })(request),
    ).rejects.toMatchObject({ reason: 'appliance_unlisted' });
  });

  it('signed out, a role that may not connect, or not a member any more: denied, without asking the directory', async () => {
    const cases = [
      { status: 401, body: { error: { code: 'unauthorized', message: 'Sign in first.' } } },
      {
        status: 403,
        body: { error: { code: 'forbidden', message: 'No.', details: { code: 'role_forbidden' } } },
      },
      {
        status: 404,
        body: {
          error: { code: 'not_found', message: 'No such organization.', details: { code: 'org_not_found' } },
        },
      },
    ];
    for (const ticket of cases) {
      const { http, asked } = control({ ticket });
      const error = await controlTickets(http, { orgId: ORG, device: DEVICE })(request).catch((e) => e);
      expect(error).toBeInstanceOf(TicketDeniedError);
      expect(asked).toEqual([`/orgs/${ORG}/tickets`]);
    }
  });

  it('control unreachable or busy is the session’s “offline”, as before', async () => {
    for (const ticket of [
      'down' as const,
      { status: 503, body: { error: { code: 'unavailable', message: 'Down.' } } },
      { status: 429, body: { error: { code: 'rate_limited', message: 'Slow down.' } } },
    ]) {
      const { http, asked } = control({ ticket });
      const connector = createManagedConnector({
        tickets: controlTickets(http, { orgId: ORG, device: DEVICE }),
        secure: {} as never,
        identity: async () => 'me',
        appliance: { peerId: 'p' },
        channel: 'app',
        socket: () => {
          throw new Error('no relay in this test');
        },
      });
      const error = await connector
        .connect({ class: 'interactive', signal: new AbortController().signal })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConnectError);
      expect(error).toMatchObject({ reason: 'offline' });
      expect(asked).toEqual([`/orgs/${ORG}/tickets`]);
    }
  });

  it('the connector names the refusal for the session', async () => {
    const { http } = control({
      ticket: NO_SUCH_DEVICE,
      devices: { status: 200, body: { devices: [row(DEVICE, 'retired')] } },
    });
    const connector = createManagedConnector({
      tickets: controlTickets(http, { orgId: ORG, device: DEVICE }),
      secure: {} as never,
      identity: async () => 'me',
      appliance: { peerId: 'p' },
      channel: 'app',
    });
    await expect(
      connector.connect({ class: 'interactive', signal: new AbortController().signal }),
    ).rejects.toMatchObject({ reason: 'appliance_retired' });
  });
});

describe('the session’s reasons (AP-693)', () => {
  const states = (reason: 'appliance_retired' | 'appliance_unlisted' | 'appliance_gone' | 'offline') => {
    const appliance = createFakeAppliance({ handle: async () => ({ status: 200, body: {} }) });
    appliance.faults.failConnects(reason, 3);
    const session = createSecureSession({
      connector: appliance.connector,
      backoff: { initialMs: 1, maxMs: 2 },
    });
    const seen: ConnectionState[] = [];
    session.onState((s) => seen.push(s));
    session.connect();
    return { session, seen };
  };
  const settled = async (seen: ConnectionState[]) => {
    for (let i = 0; i < 200 && !seen.some((s) => s.status === 'open' || s.status === 'closed'); i++)
      await new Promise((r) => setTimeout(r, 2));
  };

  it('retired and gone end the session for good; reconnectNow doesn’t revive it', async () => {
    for (const reason of ['appliance_retired', 'appliance_gone'] as const) {
      const { session, seen } = states(reason);
      await settled(seen);
      expect(session.state()).toEqual({ status: 'closed', reason });
      expect(seen.some((s) => s.status === 'reconnecting')).toBe(false);
      session.reconnectNow();
      await new Promise((r) => setTimeout(r, 10));
      expect(session.state()).toMatchObject({ status: 'closed', reason });
    }
  });

  it('unlisted is retried with its own reason, and offline stays offline', async () => {
    for (const reason of ['appliance_unlisted', 'offline'] as const) {
      const { session, seen } = states(reason);
      await settled(seen);
      expect(session.state().status).toBe('open');
      expect(seen.filter((s) => s.status === 'reconnecting').map((s) => 'reason' in s && s.reason)).toEqual([
        reason,
        reason,
        reason,
      ]);
      session.close();
    }
  });

  it('goneOf names a session that ended because its Whombat can’t be opened any more', () => {
    expect(goneOf({ status: 'closed', reason: 'appliance_retired' })).toBe('retired');
    expect(goneOf({ status: 'closed', reason: 'appliance_gone' })).toBe('missing');
    expect(goneOf({ status: 'closed', reason: 'revoked' })).toBeNull();
    expect(
      goneOf({ status: 'reconnecting', reason: 'appliance_unlisted', attempt: 1, retryAt: 0 }),
    ).toBeNull();
    expect(goneOf({ status: 'reconnecting', reason: 'offline', attempt: 1, retryAt: 0 })).toBeNull();
  });
});

describe('the list with retired Whombats (AP-694, AP-695)', () => {
  const live = summary('dev_live', 'claimed', 'Studio Whombat');
  const old = summary(DEVICE, 'retired', 'Burrow HQ');
  const unknown = summary('dev_other', 'retired', 'Old Whombat');

  it('lists the ones in use first, then the retired ones this device remembers', () => {
    const remembers = (d: string) => d === DEVICE;
    expect(listedAppliances([old, live, unknown], remembers)).toEqual([live, old]);
    expect(listedAppliances([unknown], remembers)).toEqual([]);
  });

  it('says “No Whombats in use” when every one is retired, “No Whombats yet” without any', () => {
    expect(appliancesEmptyText([old, live])).toBeNull();
    expect(appliancesEmptyText([old, unknown])).toBe(
      'No Whombats in use. Plug in another one, then claim it with the code on its screen.',
    );
    expect(appliancesEmptyText([])).toBe(
      'No Whombats yet. Plug yours in, then claim it with the code on its screen.',
    );
  });

  it('looks nearby first when every Whombat is retired, as with none (AP-75)', () => {
    expect(looksNearbyFirst([old, unknown])).toBe(true);
    expect(looksNearbyFirst([old])).toBe(true);
    expect(looksNearbyFirst([old, live])).toBe(false);
  });

  it('says what happened, by the directory’s name or “Your Whombat”', () => {
    expect(goneNotice('retired', 'Burrow HQ')).toBe('Burrow HQ was retired. It can’t be opened any more.');
    expect(goneNotice('missing', 'Burrow HQ')).toBe('Burrow HQ isn’t in your organization any more.');
    expect(goneNotice('retired', null)).toBe('Your Whombat was retired. It can’t be opened any more.');
    expect(goneNotice('missing', '  ')).toBe('Your Whombat isn’t in your organization any more.');
  });
});
