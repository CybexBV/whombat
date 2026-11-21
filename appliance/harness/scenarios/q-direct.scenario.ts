/**
 * (q) The direct way in (Whombat HE-50; contracts 1.0.0 CT-1250…CT-1252; IN-422): the same Noise session as through the
 * relay, on a WebSocket straight to the stack's runtime — its direct listener on loopback (IN-419) — with no ticket, no
 * control and no relay; the box admits by the endpoint's key. The direct variants of the claim, enrolment, pairing,
 * revocation and hostile-relay rules:
 *
 *   - the owner's endpoint, claimed through the relay (1, a), opens the app channel directly as the same account and
 *     endpoint, an op answers, and the relay session works beside it;
 *   - a key the box doesn't know gets the enrolment channel only, never the app's (b, direct);
 *   - a client pinned to another PeerId gets no session: the box can't prove it is that one (c, direct);
 *   - a malformed hello closes 4400, the wrong subprotocol gets no welcome (the listener's own rules);
 *   - a second endpoint paired through the relay (b2) opens the app channel directly; once revoked (e, b4) its direct
 *     session ends `revoked` and it can't come back directly either.
 *
 * Skipped in an environment from before the direct listener (no `runtime.direct`) or with a whombat-app before 1.0.
 */
import { SESSION_PROTOCOL } from '@whombat/protocol/session';
import { generateIdentity } from '@whombat/secure-channel';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type ApplianceSession,
  hasDirectConnector,
  openDirectSession,
  sessionOps,
  whenOpen,
  whenState,
} from '../src/scenario-kit/app-client.ts';
import { note } from '../src/scenario-kit/report.ts';
import {
  ensureSlice,
  identityOf,
  ownerSession,
  pairSecondEndpoint,
  type SliceState,
} from '../src/scenario-kit/slice.ts';
import { directSocketUrl } from '../src/scenario-kit/world.ts';

const url = directSocketUrl();
const enabled = url !== null && hasDirectConnector();

let slice: SliceState;
let owner: ApplianceSession;

/** What a raw WebSocket to the direct listener gets: the first text message, or the close code. */
function rawDial(
  u: string,
  protocol: string,
  first: string,
): Promise<{ welcome: string | null; code: number | null }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(u, protocol);
    let welcome: string | null = null;
    const timer = setTimeout(() => {
      ws.close();
      resolve({ welcome, code: null });
    }, 5_000);
    ws.addEventListener('open', () => ws.send(first));
    ws.addEventListener('message', (e) => {
      if (typeof e.data === 'string') welcome = e.data;
    });
    ws.addEventListener('close', (e) => {
      clearTimeout(timer);
      resolve({ welcome, code: e.code });
    });
    ws.addEventListener('error', () => {});
  });
}

beforeAll(async () => {
  if (!enabled) return;
  slice = await ensureSlice();
  owner = (await ownerSession(slice)).session;
});

describe('q the direct way in', () => {
  it('the owner’s endpoint opens the app channel directly, beside the relay', async (ctx) => {
    if (!enabled) return ctx.skip();
    const s = openDirectSession({
      url: url ?? '',
      identity: identityOf(slice),
      appliance: { peerId: slice.peerId },
    });
    try {
      const info = await whenOpen(s);
      note(ctx, 'direct session', {
        channel: info.channel,
        endpointId: info.endpointId,
        protocol: info.protocol,
      });
      expect(info.channel).toBe('app');
      expect(info.account?.id).toBe(slice.owner.accountId);
      expect(info.endpointId).toBe(slice.endpointId);
      expect(info.protocol.major).toBe(SESSION_PROTOCOL.major);
      const status = await sessionOps.applianceStatus(s);
      expect(status).toBeTruthy();
      // The relay session is unaffected.
      expect((await sessionOps.applianceStatus(owner)) as unknown).toBeTruthy();
    } finally {
      s.close('closed');
    }
  });

  it('a key the box doesn’t know gets the enrolment channel only', async (ctx) => {
    if (!enabled) return ctx.skip();
    const stranger = await generateIdentity();
    const s = openDirectSession({
      url: url ?? '',
      identity: stranger,
      appliance: { peerId: slice.peerId },
      expect: 'any',
    });
    try {
      const info = await whenOpen(s);
      note(ctx, 'unknown key', { channel: info.channel, account: info.account });
      expect(info.channel).toBe('enroll');
      expect(info.account).toBeNull();
    } finally {
      s.close('closed');
    }
    // Asked for the app channel, it never opens.
    const app = openDirectSession({
      url: url ?? '',
      identity: stranger,
      appliance: { peerId: slice.peerId },
    });
    app.connect();
    const st = await whenState(app, (x) => x.status !== 'connecting' && x.status !== 'idle', 15_000);
    app.close('closed');
    note(ctx, 'unknown key, app expected', { state: st });
    expect(st.status).not.toBe('open');
  });

  it('a client pinned to another PeerId gets no session', async (ctx) => {
    if (!enabled) return ctx.skip();
    const other = await generateIdentity();
    const s = openDirectSession({
      url: url ?? '',
      identity: identityOf(slice),
      appliance: { peerId: other.peerId },
      expect: 'any',
    });
    s.connect();
    const st = await whenState(s, (x) => x.status !== 'connecting' && x.status !== 'idle', 15_000);
    s.close('closed');
    note(ctx, 'wrong pin', { state: st });
    expect(st.status).not.toBe('open');
  });

  it('the listener’s own rules: a malformed hello closes 4400, another subprotocol gets no welcome', async (ctx) => {
    if (!enabled) return ctx.skip();
    const bad = await rawDial(url ?? '', 'whombat-direct.v1', '{"t":"hello","v":9}');
    note(ctx, 'malformed hello', bad);
    expect(bad.welcome).toBeNull();
    expect(bad.code).toBe(4400);
    const good = await rawDial(url ?? '', 'whombat-direct.v1', '{"t":"hello","v":1,"class":"interactive"}');
    expect(JSON.parse(good.welcome ?? '{}').t).toBe('welcome');
    const wrong = await rawDial(url ?? '', 'whombat-relay.v1', '{"t":"hello","v":1,"class":"interactive"}');
    note(ctx, 'wrong subprotocol', wrong);
    expect(wrong.welcome).toBeNull();
  });

  it('a paired endpoint opens directly; revoked, its direct session ends and it can’t come back', async (ctx) => {
    if (!enabled) return ctx.skip();
    const second = await pairSecondEndpoint(slice, owner, 'Harness direct laptop');
    const s = openDirectSession({
      url: url ?? '',
      identity: second.identity,
      appliance: { peerId: slice.peerId },
    });
    const info = await whenOpen(s);
    expect(info.channel).toBe('app');
    expect(info.endpointId).toBe(second.endpointId);
    await sessionOps.endpointsRevoke(owner, second.endpointId);
    const closed = await whenState(s, (x) => x.status === 'closed', 15_000);
    note(ctx, 'revoked over the direct way', { closed });
    expect(closed.status === 'closed' && closed.reason).toBe('revoked');
    const again = openDirectSession({
      url: url ?? '',
      identity: second.identity,
      appliance: { peerId: slice.peerId },
    });
    again.connect();
    const st = await whenState(again, (x) => x.status === 'closed', 15_000);
    again.close('closed');
    note(ctx, 'reconnect after revocation', { state: st });
    expect(st.status === 'closed' && ['revoked', 'not_enrolled']).toContain(
      st.status === 'closed' ? st.reason : '',
    );
  });
});
