/**
 * Contracts 1.0.0: the box's direct ways in, Tailscale for This Whombat and the development enrolment (CT-1252…CT-1257;
 * Whombat hermes-engine.md HE-49…HE-51).
 */
import { describe, expect, it } from 'vitest';
import { type DirectAddresses, DirectAddresses as DirectAddressesSchema, directRoutesFor } from './direct.js';
import { ENDPOINT_ENROLLED_VIA, EnrollDevInput } from './enrollment.js';
import { APP_ERROR_CODES } from './errors.js';
import { Welcome } from './messages.js';
import { OPERATION_SAFETY } from './operation-safety.js';
import { SESSION_OPERATIONS } from './operations.js';
import {
  HostTailscaleOffInput,
  TAILSCALE_ERROR_CODES,
  TAILSCALE_OFF,
  TailscaleStatus,
  tailscaleStatusValid,
} from './tailscale.js';

const addresses: DirectAddresses = {
  port: 4480,
  lan: ['10.100.1.20', 'fd00::20'],
  tailscale: 'whombat-r7m4.tail1234.ts.net',
  routes: [
    { way: 'lan', socket: 'ws://10.100.1.20:4480/v1/direct', web: 'http://10.100.1.20:4480/' },
    { way: 'lan', socket: 'ws://[fd00::20]:4480/v1/direct', web: 'http://[fd00::20]:4480/' },
    {
      way: 'tailscale',
      socket: 'wss://whombat-r7m4.tail1234.ts.net:4480/v1/direct',
      web: 'https://whombat-r7m4.tail1234.ts.net:4480/',
    },
  ],
};

describe('the box’s direct ways in (CT-1252)', () => {
  it('parses local-network and Tailscale routes', () => {
    expect(DirectAddressesSchema.parse(addresses)).toEqual(addresses);
    expect(DirectAddressesSchema.safeParse({ ...addresses, tailscale: null, routes: [] }).success).toBe(true);
  });

  it('refuses a socket that isn’t the direct path, and a page that isn’t the root', () => {
    const route = addresses.routes[0];
    for (const bad of [
      { ...route, socket: 'ws://10.100.1.20:4480/v1/connect' },
      { ...route, socket: 'http://10.100.1.20:4480/v1/direct' },
      { ...route, web: 'http://10.100.1.20:4480/app' },
    ])
      expect(DirectAddressesSchema.safeParse({ ...addresses, routes: [bad] }).success).toBe(false);
  });

  it('tries every route from the phone and a plain page, only TLS ones from a secure page', () => {
    expect(directRoutesFor(addresses, { secureOnly: false })).toHaveLength(3);
    expect(directRoutesFor(addresses, { secureOnly: true }).map((r) => r.way)).toEqual(['tailscale']);
    expect(directRoutesFor(null, { secureOnly: false })).toEqual([]);
  });

  it('comes in the welcome, required, null on the enrollment channel', () => {
    expect(Welcome.shape.direct.safeParse(null).success).toBe(true);
    expect(Welcome.shape.direct.safeParse(undefined).success).toBe(false);
    expect('runtime' in Welcome.shape).toBe(false);
  });
});

describe('Tailscale for This Whombat (CT-1253, CT-1254)', () => {
  const on: TailscaleStatus = {
    ...TAILSCALE_OFF,
    state: 'on',
    name: 'whombat-r7m4.tail1234.ts.net',
    addresses: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
    tailnet: 'lumio.example.org',
    https: true,
  };

  it('says off, a login link, on with a name, or a problem — consistently', () => {
    expect(tailscaleStatusValid(TAILSCALE_OFF)).toBe(true);
    expect(tailscaleStatusValid(TailscaleStatus.parse(on))).toBe(true);
    const signIn: TailscaleStatus = {
      ...TAILSCALE_OFF,
      state: 'needs_sign_in',
      loginUrl: 'https://login.tailscale.com/a/abc123',
    };
    expect(tailscaleStatusValid(TailscaleStatus.parse(signIn))).toBe(true);
    expect(tailscaleStatusValid({ ...TAILSCALE_OFF, state: 'error', problem: 'unreachable' })).toBe(true);
    expect(tailscaleStatusValid({ ...TAILSCALE_OFF, state: 'error' })).toBe(false);
    expect(tailscaleStatusValid({ ...on, name: null })).toBe(false);
    expect(tailscaleStatusValid({ ...TAILSCALE_OFF, loginUrl: 'https://login.tailscale.com/a/x1' })).toBe(
      false,
    );
    // A plain link on Tailscale's own server is never one to open (1.1: the schema admits http for a login server).
    expect(tailscaleStatusValid({ ...signIn, loginUrl: 'http://login.tailscale.com/a/abc' })).toBe(false);
  });

  it('has a read and three owner changes, none resent by itself; off is for a person to decide', () => {
    for (const op of ['host.tailscale', 'host.tailscale.on', 'host.tailscale.off', 'host.tailscale.signIn'])
      expect(SESSION_OPERATIONS.get(op)?.channel, op).toBe('app');
    expect(SESSION_OPERATIONS.get('host.tailscale')?.mutating).toBe(false);
    expect(OPERATION_SAFETY['host.tailscale.on'].retry).toBe('never');
    expect(OPERATION_SAFETY['host.tailscale.off']).toEqual({ destructive: true, retry: 'never' });
    expect(HostTailscaleOffInput.safeParse({ signOut: true }).success).toBe(true);
    expect(HostTailscaleOffInput.safeParse({ forget: true }).success).toBe(false);
    for (const code of TAILSCALE_ERROR_CODES) expect(APP_ERROR_CODES).toHaveProperty([code]);
  });
});

describe('the development enrolment (CT-1257)', () => {
  it('is an enrollment-channel op that lets the device in, refused anywhere else with dev_only', () => {
    const spec = SESSION_OPERATIONS.get('enroll.dev');
    expect(spec?.channel).toBe('enroll');
    expect(spec?.retry).toBe('never');
    expect(APP_ERROR_CODES).toHaveProperty(['dev_only']);
    expect(ENDPOINT_ENROLLED_VIA).toContain('dev');
    const input = {
      account: { name: 'Mara', email: 'mara@example.com' },
      endpoint: { label: 'Chrome on this machine', platform: 'web' },
    };
    expect(EnrollDevInput.safeParse(input).success).toBe(true);
    expect(EnrollDevInput.safeParse({ ...input, owner: true }).success).toBe(false);
  });
});
