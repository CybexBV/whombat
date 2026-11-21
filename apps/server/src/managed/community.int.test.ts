/**
 * The community edition's start, end to end (hermes-engine.md HE-58…HE-61, HE-64; HE-S200…HE-S239): a runtime booted as
 * an unclaimed community box (`startManaged` with `WHOMBAT_EDITION=community`: no relay, no licence, its own page on a
 * stand-in network card), the person's client on the direct connection that claims it with the letters on its console,
 * a device link the person's second device enrols with, Tailscale on with the person's own login server (the fake
 * manager), the person's mail server stored and tested (a fake SMTP server),
 * the box's own Web Push key, and the refusals where control has no equivalent. Postgres: the claim, enrolments, links,
 * settings and signed events are rows of the box's database.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { join } from 'node:path';
import { ConsoleState } from '@whombat/control-contracts/local';
import { encodeFrame, FrameDecoder } from '@whombat/protocol';
import {
  claimConfirmEqual,
  localClaimPakeInitiator,
  localClaimPakeInitiatorFinish,
  normalizeClaimCode,
} from '@whombat/protocol/claim';
import { DIRECT_SUBPROTOCOL, DirectIdentity } from '@whombat/protocol/direct';
import {
  type ApplianceMessage,
  type ClientMessage,
  decodeApplianceMessage,
  encodeSessionMessage,
  parseLocalLink,
  SESSION_PROTOCOL,
} from '@whombat/protocol/session';
import {
  type ByteStream,
  generateIdentity,
  type Identity,
  openInitiator,
  secureByteStream,
} from '@whombat/secure-channel';
import { nodeWebSocketByteStream } from '@whombat/secure-channel/node';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { applianceEndpoints, applianceEvents, applianceState } from '../db/schema/index';
import { useBoxMailNetForTests } from '../mail/box';
import { useTestServer } from '../test/harness';
import { type FakeSmtp, startFakeSmtp } from '../test/mail';
import { MAIL_CERT } from '../test/self-signed';
import { type ManagedBoot, startManaged } from './boot';
import { secureResponder } from './session/secure';
import { FakeManager } from './testing';

const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'wb-community-'));
const consoleFile = join(dir, 'console.json');
const t = useTestServer({
  env: {
    WHOMBAT_EDITION: 'community',
    WHOMBAT_CONSOLE_FILE: consoleFile,
    WHOMBAT_ADMIN_SOCKET: join(dir, 'admin.sock'),
    WHOMBAT_DIRECT_PORT: '0',
    // No configured mail server: the person sets their own (HE-S224).
    SMTP_URL: 'off',
  },
});
// The box's content key, made for this run.
const box = await generateIdentity();
const manager = new FakeManager();
/** The box's network card, and `tailscale0` once Tailscale is on (the routes it tells and puts in links). */
let tailnet = false;
const LAN = '192.168.1.20';
let boot: ManagedBoot;
let port = 0;
let smtp: FakeSmtp;

const iface = (address: string, cidr: string) => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4' as const,
  mac: '02:00:00:00:00:01',
  internal: false,
  cidr,
});

beforeAll(async () => {
  smtp = await startFakeSmtp({ user: 'whombat@home.test', pass: 'app-password-1', security: 'starttls' });
  useBoxMailNetForTests(t.services, { ca: MAIL_CERT, connectTo: () => '127.0.0.1' });
  boot = await startManaged(t.services, t.services.config, {
    manager,
    responder: secureResponder(box),
    appliancePeerId: box.peerId,
    ways: {
      interfaces: ['lan', 'tailscale0'],
      table: () => ({
        eth0: [iface(LAN, `${LAN}/24`)],
        ...(tailnet ? { tailscale0: [iface('100.101.102.103', '100.101.102.103/32')] } : {}),
      }),
    },
  });
  port = boot.endpoint.direct?.boundPort() ?? 0;
});

afterAll(async () => {
  await boot?.close();
  await smtp?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A plain GET on the direct listener. */
function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) =>
    httpGet({ host: '127.0.0.1', port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject),
  );
}

function readConsole(): ConsoleState {
  return ConsoleState.parse(JSON.parse(readFileSync(consoleFile, 'utf8')));
}

function letters(): string {
  const n = normalizeClaimCode(readConsole().code ?? '');
  if (n.kind !== 'letters') throw new Error('no code on the console');
  return n.letters;
}

/** The direct WebSocket after the box's welcome, as a byte stream. */
async function directSocket(): Promise<ByteStream> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/direct`, DIRECT_SUBPROTOCOL);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return new Promise<ByteStream>((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData, bin: boolean) => {
      if (bin || JSON.parse(raw.toString()).t !== 'welcome') return reject(new Error('no welcome'));
      ws.off('message', onMessage);
      resolve(nodeWebSocketByteStream(ws as never));
    };
    ws.on('message', onMessage);
    ws.once('close', (code) => reject(new Error(`closed ${code}`)));
    ws.send(JSON.stringify({ t: 'hello', v: 1, class: 'interactive' }));
  });
}

let requests = 0;
type Answer = ApplianceMessage & { output?: unknown; details?: { code?: string } };

/** A device on the direct connection: Noise with the box's PeerId pinned, then the session protocol. */
class Device {
  readonly received: ApplianceMessage[] = [];
  private ended = false;
  private waiters: {
    pred: (m: ApplianceMessage) => boolean;
    resolve: (m: ApplianceMessage | null) => void;
  }[] = [];

  private constructor(private readonly bytes: ReturnType<typeof secureByteStream>) {
    void this.pump();
  }

  /** Connects, says hello and returns the device with the box's first answer (welcome or error). */
  static async connect(me: Identity): Promise<{ device: Device; welcome: Answer }> {
    const conn = await openInitiator({
      stream: await directSocket(),
      identity: me,
      expectedAppliancePeerId: box.peerId,
    });
    const device = new Device(secureByteStream(conn));
    device.send({
      t: 'hello',
      versions: [SESSION_PROTOCOL],
      capabilities: ['events', 'enroll'],
      client: { build: 'test', platform: 'web' },
    });
    const welcome = (await device.waitFor((m) => m.t === 'welcome' || m.t === 'error')) as Answer;
    return { device, welcome };
  }

  private async pump(): Promise<void> {
    const decoder = new FrameDecoder();
    for (;;) {
      const chunk = await this.bytes.read().catch(() => null);
      if (!chunk) break;
      for (const f of decoder.push(chunk)) {
        if (f.type !== 'control') continue;
        const d = decodeApplianceMessage(f.payload);
        if (!d.ok) continue;
        this.received.push(d.message);
        for (const w of [...this.waiters])
          if (w.pred(d.message)) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            w.resolve(d.message);
          }
      }
    }
    this.ended = true;
    for (const w of this.waiters.splice(0)) w.resolve(null);
  }

  private send(message: ClientMessage): void {
    this.bytes.write(encodeFrame({ type: 'control', streamId: 0, payload: encodeSessionMessage(message) }));
  }

  private waitFor(pred: (m: ApplianceMessage) => boolean): Promise<ApplianceMessage | null> {
    const found = this.received.find(pred);
    if (found) return Promise.resolve(found);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push({ pred, resolve }));
  }

  async request(op: string, input: unknown): Promise<Answer> {
    const id = `req_community_${String(++requests).padStart(10, '0')}`;
    this.send({ t: 'request', id, op, input: input as never, deadlineMs: 15_000 });
    return (await this.waitFor(
      (m) => (m.t === 'result' || m.t === 'error') && (m as { id?: string }).id === id,
    )) as Answer;
  }

  async close(): Promise<void> {
    await this.bytes.close().catch(() => {});
  }
}

/**
 * The claim on the box's page with `password` as the letters, as the box's page runs it: the proofs first, and the
 * person's account only once the box's own proof checked out.
 */
async function claimWith(device: Device, me: Identity, claimId: string, password: string) {
  const { share, state } = localClaimPakeInitiator(
    { password, appliancePeerId: box.peerId, clientPeerId: me.peerId, claimId },
    (n) => new Uint8Array(randomBytes(n)),
  );
  const begin = await device.request('enroll.claim.local.begin', { claimId, share });
  if (begin.t !== 'result') return { begin, prove: null, claim: null };
  const tags = localClaimPakeInitiatorFinish(state, (begin.output as { share: string }).share);
  const prove = await device.request('enroll.claim.local.prove', { claimId, confirm: tags.client });
  if (prove.t !== 'result') return { begin, prove, claim: null };
  if (!claimConfirmEqual(tags.appliance, (prove.output as { confirm: string }).confirm))
    throw new Error('the box’s proof is wrong');
  const claim = await device.request('enroll.claim.local', {
    claimId,
    account: { name: 'Mara', email: 'mara@home.test' },
    endpoint: { label: 'Laptop', platform: 'web' },
  });
  return { begin, prove, claim };
}

const MAIL = {
  host: 'mail.home.test',
  security: 'starttls' as const,
  username: 'whombat@home.test',
  from: 'whombat@home.test',
  fromName: 'Home Whombat',
};
const signedEvents = async (type: string) =>
  t.services.db.select().from(applianceEvents).where(eq(applianceEvents.type, type));

let owner: { me: Identity; device: Device; accountId: string; endpointId: string };

describe('a community box from its first start', () => {
  it('starts unclaimed, without the relay or a licence, its letters and page on the console', async () => {
    expect(manager.tickets).toBe(0);
    expect(boot.endpoint.status().relay).not.toBe('connected');
    const identity = DirectIdentity.parse(JSON.parse((await get('/v1/direct')).body));
    expect(identity).toEqual({ v: 1, appliance: box.peerId, edition: 'community', claimed: false });
    const shown = readConsole();
    expect(shown).toMatchObject({ state: 'claimable', url: `http://${LAN}:${port}/` });
    expect(letters()).toMatch(/^[A-Z]{4}$/);
    expect(await boot.runtime.licence.view()).toBeNull();
  });

  it('is claimed on its own page with the code: a wrong one rotates the letters, the right one makes the person', async () => {
    const me = await generateIdentity();
    const { device, welcome } = await Device.connect(me);
    expect(welcome).toMatchObject({ t: 'welcome', channel: 'enroll', edition: 'community', direct: null });
    // The commercial claim through control has no place here.
    expect(
      await device.request('enroll.claim.begin', { claimId: 'clm_test_0001', method: 'code', share: 'x' }),
    ).toMatchObject({ t: 'error' });
    expect(
      await device.request('enroll.claim.local.begin', { claimId: 'lcl_nothing_started', share: 'AAAA' }),
    ).toMatchObject({ t: 'error' });
    const start = await device.request('enroll.claim.local.start', {});
    expect(start).toMatchObject({ t: 'result', output: { claimId: expect.any(String) } });
    const { claimId } = start.output as { claimId: string };
    expect((await claimWith(device, me, `${claimId}x`, letters())).begin).toMatchObject({
      t: 'error',
      details: { code: 'claim_start_missing' },
    });
    const before = letters();
    const wrong = await claimWith(device, me, claimId, before === 'AAAA' ? 'BBBB' : 'AAAA');
    // The wrong guess is caught by the proofs: the person was never named.
    expect(wrong.prove).toMatchObject({ t: 'error', code: 'forbidden', details: { code: 'claim_invalid' } });
    expect(wrong.claim).toBeNull();
    expect(letters()).not.toBe(before);
    // The page starts again for every try.
    const again = (await device.request('enroll.claim.local.start', {})).output as { claimId: string };
    const right = await claimWith(device, me, again.claimId, letters());
    expect(right.claim).toMatchObject({ t: 'result', output: { endpoint: { peerId: me.peerId } } });
    const out = right.claim?.output as { accountId: string; endpoint: { endpointId: string } };
    await device.close();
    // Claimed: the console says so, the page too, and the claim is a signed event (nothing reported to control).
    expect(readConsole()).toMatchObject({ state: 'claimed' });
    expect(JSON.parse((await get('/v1/direct')).body)).toMatchObject({ claimed: true });
    const [claimed] = await signedEvents('appliance.claimed');
    expect(claimed?.payload).toMatchObject({ accountId: out.accountId, method: 'local' });
    expect(manager.claimed).toEqual([]);
    const [state] = await t.services.db.select().from(applianceState);
    expect(state?.claimReportedAt).toBeNull();
    // Its next session is the app's, told the box's ways in.
    const back = await Device.connect(me);
    expect(back.welcome).toMatchObject({
      t: 'welcome',
      channel: 'app',
      edition: 'community',
      principal: { accountId: expect.any(String) },
      direct: { lan: [LAN], routes: [{ way: 'lan', web: `http://${LAN}:${port}/` }] },
    });
    owner = { me, device: back.device, accountId: out.accountId, endpointId: out.endpoint.endpointId };
  });

  it('stores the person’s mail server, tests it to their own email, and never shows the password', async () => {
    const d = owner.device;
    expect(await d.request('host.mail', {})).toMatchObject({ t: 'result', output: { mail: null } });
    // A login needs encryption.
    expect(
      await d.request('host.mail.set', { ...MAIL, port: smtp.port, security: 'none', password: 'x' }),
    ).toMatchObject({ t: 'error', code: 'validation_failed' });
    const set = await d.request('host.mail.set', { ...MAIL, port: smtp.port, password: 'app-password-1' });
    expect(set).toMatchObject({
      t: 'result',
      output: { mail: { source: 'settings', host: MAIL.host, hasPassword: true, lastTest: null } },
    });
    expect(JSON.stringify(set)).not.toContain('app-password-1');
    const tested = await d.request('host.mail.test', {});
    expect(tested).toMatchObject({ t: 'result', output: { test: { state: 'sent', to: 'mara@home.test' } } });
    expect(smtp.messages.map((m) => m.to)).toEqual([['mara@home.test']]);
    expect(smtp.logins.at(-1)).toEqual({ user: MAIL.username, ok: true });
    expect(await d.request('host.mail', {})).toMatchObject({
      output: { mail: { lastTest: { state: 'sent' } } },
    });
    // A draft with another password: tested, not kept.
    expect(
      await d.request('host.mail.test', { draft: { ...MAIL, port: smtp.port, password: 'wrong' } }),
    ).toMatchObject({ output: { test: { state: 'auth_failed' } } });
    const [event] = await signedEvents('mail.set');
    expect(event?.payload).toEqual({
      byAccountId: owner.accountId,
      server: { host: MAIL.host, port: smtp.port, security: 'starttls', from: MAIL.from },
    });
    const [state] = await t.services.db.select().from(applianceState);
    expect(state?.mailPasswordEnc).not.toContain('app-password-1');
  });

  it('lets the person’s second device in with a device link, once', async () => {
    const created = await owner.device.request('enroll.link.create', {});
    expect(created).toMatchObject({ t: 'result', output: { link: expect.any(String) } });
    const out = created.output as { secret: string; link: string };
    const link = parseLocalLink(out.link);
    expect(link).toMatchObject({ kind: 'device', appliance: box.peerId, secret: out.secret });
    const tablet = await generateIdentity();
    const { device } = await Device.connect(tablet);
    expect(
      await device.request('enroll.link.accept', {
        secret: out.secret,
        endpoint: { label: 'Tablet', platform: 'web' },
      }),
    ).toMatchObject({ t: 'result', output: { accountId: owner.accountId } });
    await device.close();
    const [row] = await t.services.db
      .select()
      .from(applianceEndpoints)
      .where(eq(applianceEndpoints.peerId, tablet.peerId));
    expect(row).toMatchObject({ enrolledVia: 'link', enrolledByEndpointId: owner.endpointId });
    // Used up: nobody else gets in with it.
    const late = await Device.connect(await generateIdentity());
    expect(
      await late.device.request('enroll.link.accept', {
        secret: out.secret,
        endpoint: { label: 'Other', platform: 'web' },
      }),
    ).toMatchObject({ t: 'error', details: { code: 'link_used' } });
    expect(
      await late.device.request('enroll.link.accept', {
        secret: randomBytes(24).toString('base64url'),
        endpoint: { label: 'Other', platform: 'web' },
      }),
    ).toMatchObject({ t: 'error', details: { code: 'link_invalid' } });
    await late.device.close();
    // The tablet scans a new link although it is in already: let in as it was, no second device, the link used up.
    const again = (await owner.device.request('enroll.link.create', {})).output as { secret: string };
    const back = await Device.connect(tablet);
    expect(
      await back.device.request('enroll.link.accept', {
        secret: again.secret,
        endpoint: { label: 'Tablet', platform: 'web' },
      }),
    ).toMatchObject({
      t: 'result',
      output: { accountId: owner.accountId, endpoint: { endpointId: row?.id } },
    });
    await back.device.close();
    const rows = await t.services.db
      .select()
      .from(applianceEndpoints)
      .where(eq(applianceEndpoints.peerId, tablet.peerId));
    expect(rows).toHaveLength(1);
    const after = await Device.connect(await generateIdentity());
    expect(
      await after.device.request('enroll.link.accept', {
        secret: again.secret,
        endpoint: { label: 'Other', platform: 'web' },
      }),
    ).toMatchObject({ t: 'error', details: { code: 'link_used' } });
    await after.device.close();
  });

  it('turns Tailscale on with the person’s own login server, signed, and runs passkeys on its name', async () => {
    const d = owner.device;
    // The app sends it normalized (`normalizeTailscaleLoginServer`); anything else is refused before the manager hears.
    expect(await d.request('host.tailscale.on', { loginServer: 'HTTP://HS.Home.test:8080/' })).toMatchObject({
      t: 'error',
      code: 'validation_failed',
    });
    const on = await d.request('host.tailscale.on', { loginServer: 'http://hs.home.test:8080' });
    expect(on).toMatchObject({
      t: 'result',
      output: {
        tailscale: {
          state: 'needs_sign_in',
          loginServer: 'http://hs.home.test:8080',
          loginUrl: expect.stringMatching(/^http:[/][/]hs[.]home[.]test:8080[/]/),
        },
      },
    });
    expect(manager.tailscale.calls).toContain('on@http://hs.home.test:8080');
    manager.tailscale.completeSignIn();
    tailnet = true;
    expect(await d.request('host.tailscale', {})).toMatchObject({
      output: { tailscale: { state: 'on', loginServer: 'http://hs.home.test:8080' } },
    });
    const [event] = await signedEvents('tailscale.on');
    expect(event?.payload).toEqual({
      byAccountId: owner.accountId,
      loginServer: 'http://hs.home.test:8080',
      loginServerChanged: true,
      signOut: false,
    });
    // Its Tailscale page is a way in now, and the relying party for passkeys there (CT-1309).
    const name = manager.tailscale.name;
    expect(boot.runtime.direct?.addresses()?.routes.map((r) => r.web)).toEqual([
      `http://${LAN}:${port}/`,
      `https://${name}:${port}/`,
    ]);
    expect(boot.runtime.trust.relyingParty()).toEqual({ rpId: name, origins: [`https://${name}:${port}`] });
  });

  it('has its own Web Push key, and refuses plainly what only control does', async () => {
    const d = owner.device;
    const key = await d.request('devices.vapidKey', { params: {} });
    expect(key).toMatchObject({
      t: 'result',
      output: { publicKey: expect.stringMatching(/^[A-Za-z0-9_-]{87}$/) },
    });
    const [state] = await t.services.db.select().from(applianceState);
    expect(state?.vapidPublicKey).toBe((key.output as { publicKey: string }).publicKey);
    expect(await d.request('push.handles.set', { handle: 'h'.repeat(43) })).toMatchObject({
      t: 'error',
      code: 'not_allowed',
    });
    expect(await d.request('licence.refresh', {})).toMatchObject({ t: 'error', code: 'not_allowed' });
    expect(await d.request('remoteHelp.start', { level: 'look', duration: 'hour' })).toMatchObject({
      t: 'error',
    });
    expect(await d.request('remoteHelp.confirmBegin', { level: 'look', duration: 'hour' })).toMatchObject({
      t: 'error',
      details: { code: 'remote_help_unavailable' },
    });
    // What it says about itself offers no phone push and names no cloud, relay or billing (HE-S224).
    const status = await d.request('appliance.status', {});
    expect(status).toMatchObject({
      t: 'result',
      output: { policy: { nativePush: { available: false }, feedbackIntake: { available: false } } },
    });
    expect(JSON.stringify((status.output as { policy: unknown }).policy)).not.toMatch(/cloud|relay|billing/i);
    expect(manager.renewals).toBe(0);
    expect(manager.tickets).toBe(0);
  });

  it('takes the mail server away again, signed', async () => {
    expect(await owner.device.request('host.mail.remove', {})).toMatchObject({
      t: 'result',
      output: { mail: null },
    });
    expect(await signedEvents('mail.removed')).toHaveLength(1);
    expect(await owner.device.request('host.mail.test', {})).toMatchObject({
      t: 'error',
      details: { code: 'mail.not_set' },
    });
    const [state] = await t.services.db.select().from(applianceState);
    expect(state?.claimedByAccountId).toBe(owner.accountId);
    await owner.device.close();
  });
});
