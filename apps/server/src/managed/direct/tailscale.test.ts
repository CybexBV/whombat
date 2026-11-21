import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TAILSCALE_OFF } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../services';
import { FakeTailscale, TailscaleService, tailscaleLoginUrl } from './tailscale';

const PEM = readFileSync(join(import.meta.dirname, '__fixtures__', 'tailscale-cert-pair.pem'), 'utf8');
const at = PEM.indexOf('-----BEGIN CERTIFICATE-----');

function setup() {
  const fake = new FakeTailscale();
  fake.pair = { keyPem: PEM.slice(0, at), certPem: PEM.slice(at) };
  let now = 1_000_000;
  const ts = new TailscaleService(fake, silentLogger, { now: () => now });
  return { fake, ts, advance: (ms: number) => (now += ms) };
}

describe('Tailscale for This Whombat, through the manager', () => {
  it('tells once when Tailscale signed the box out by itself, never after the person’s own change', async () => {
    const { fake, ts } = setup();
    let told = 0;
    ts.onSignedOut = () => told++;
    await ts.turnOn();
    fake.completeSignIn();
    await ts.refresh();
    // The key ran out (or the box was removed from the tailnet): read twice, told once.
    fake.signedIn = false;
    await ts.refresh();
    await ts.refresh();
    expect(told).toBe(1);
    // Starting for a moment on the way (the manager asks for the link a read later) is the same sign-out.
    fake.completeSignIn();
    await ts.refresh();
    const asking = fake.tailscaleState.bind(fake);
    let reads = 0;
    fake.tailscaleState = async () =>
      reads++ === 0 ? { ...(await asking()), state: 'starting' as const, loginUrl: null } : asking();
    fake.signedIn = false;
    await ts.refresh();
    expect(told).toBe(1);
    await ts.refresh();
    expect(told).toBe(2);
    fake.tailscaleState = asking;
    // The person's own sign-in and off say nothing.
    fake.completeSignIn();
    await ts.refresh();
    fake.signedIn = false;
    await ts.signIn();
    await ts.refresh();
    fake.completeSignIn();
    await ts.refresh();
    await ts.turnOff(true);
    await ts.refresh();
    expect(told).toBe(2);
  });

  it('follows the manager’s state and answers to the box’s names only while on', async () => {
    const { fake, ts } = setup();
    expect(await ts.refresh()).toEqual(TAILSCALE_OFF);
    expect((await ts.turnOn()).status.state).toBe('needs_sign_in');
    expect(ts.hostnames()).toEqual([]);
    fake.completeSignIn();
    expect(await ts.refresh()).toMatchObject({ state: 'on', name: 'box.tail0000.ts.net', https: true });
    expect(ts.hostnames()).toEqual(['box.tail0000.ts.net', 'box']);
    expect((await ts.turnOff(false)).state).toBe('off');
    expect(fake.signedIn).toBe(true);
    expect(ts.hostnames()).toEqual([]);
    expect((await ts.signIn()).loginUrl).toMatch(/^https:[/][/]login[.]tailscale[.]com[/]/);
  });

  it('asks for the certificate once, for its own name, and again before it runs out', async () => {
    const { fake, ts, advance } = setup();
    fake.completeSignIn();
    await ts.refresh();
    expect(await ts.certificate('other.tail0000.ts.net')).toBeNull();
    expect(await ts.certificate('box.tail0000.ts.net')).not.toBeNull();
    await ts.certificate('box.tail0000.ts.net');
    expect(fake.calls.filter((c) => c === 'cert')).toHaveLength(1);
    advance(25 * 3600_000);
    await ts.certificate('box.tail0000.ts.net');
    expect(fake.calls.filter((c) => c === 'cert')).toHaveLength(2);
    fake.https = false;
    await ts.refresh();
    expect(await ts.certificate('box.tail0000.ts.net')).toBeNull();
  });

  it('says when there is no manager or it doesn’t answer, and shows only Tailscale’s own login pages', async () => {
    expect(await new TailscaleService(null, silentLogger).refresh()).toBeNull();
    const down = new TailscaleService(
      {
        ...new FakeTailscale(),
        tailscaleState: () => Promise.reject(new Error('unreachable')),
      } as unknown as FakeTailscale,
      silentLogger,
    );
    expect(await down.refresh()).toBeNull();
    expect(tailscaleLoginUrl('https://login.tailscale.com/a/x')).toBe('https://login.tailscale.com/a/x');
    expect(tailscaleLoginUrl('https://evil.example/a/x')).toBeNull();
    expect(tailscaleLoginUrl('http://login.tailscale.com/a/x')).toBeNull();
    // With a login server of the person's own, only that server's pages (CT-1306).
    const hs = 'http://hs.home.test:8080';
    expect(tailscaleLoginUrl(`${hs}/register/nodekey:1`, hs)).toBe(`${hs}/register/nodekey:1`);
    expect(tailscaleLoginUrl('https://login.tailscale.com/a/x', hs)).toBeNull();
  });

  it('signs in to the person’s own login server, keeps it, and goes back to Tailscale’s own on null', async () => {
    const { fake, ts } = setup();
    await ts.refresh();
    const hs = 'http://hs.home.test:8080';
    const on = await ts.turnOn(hs);
    expect(on).toMatchObject({ loginServer: hs, changed: true, status: { state: 'needs_sign_in' } });
    expect(on.status.loginUrl).toBe(`${hs}/register/nodekey:1a2b3c4d5e`);
    fake.completeSignIn();
    await ts.refresh();
    // Absent keeps the box's server; the manager is told it every time.
    expect(await ts.turnOn()).toMatchObject({ loginServer: hs, changed: false, status: { state: 'on' } });
    expect(fake.calls.filter((c) => c.startsWith('on'))).toEqual([`on@${hs}`, `on@${hs}`]);
    expect(await ts.turnOn(null)).toMatchObject({ loginServer: null, changed: true });
    expect(fake.signedIn).toBe(false);
  });
});
