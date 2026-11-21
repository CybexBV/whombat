/**
 * Mara's box on the direct ways (contracts 1.0, CT-1252…CT-1254): its addresses as `welcome.direct` gives them, and
 * Tailscale in each state Settings → This Whombat shows.
 */
import type { DirectAddresses, TailscaleStatus } from '@whombat/protocol/session';

const NAME = 'whombat-r7m4.tail1a2b3.ts.net';

/** `welcome.direct` with Tailscale on: the LAN address, then the Tailscale name. */
export const DIRECT_ADDRESSES: DirectAddresses = {
  port: 4480,
  lan: ['192.168.1.20'],
  tailscale: NAME,
  routes: [
    { way: 'lan', socket: 'ws://192.168.1.20:4480/v1/direct', web: 'http://192.168.1.20:4480/' },
    { way: 'tailscale', socket: `wss://${NAME}:4480/v1/direct`, web: `https://${NAME}:4480/` },
  ],
};

/** `welcome.direct` while Tailscale is off: the local network only. */
export const DIRECT_ADDRESSES_LAN_ONLY: DirectAddresses = {
  ...DIRECT_ADDRESSES,
  tailscale: null,
  routes: DIRECT_ADDRESSES.routes.filter((r) => r.way === 'lan'),
};

const off: TailscaleStatus = {
  state: 'off',
  loginUrl: null,
  name: null,
  addresses: [],
  tailnet: null,
  https: false,
  problem: null,
};

/** Tailscale on the box in every state, for the screens and the session fake (`host.tailscale`). */
export const TAILSCALE_STATES_FIXTURE: Readonly<Record<TailscaleStatus['state'], TailscaleStatus>> = {
  off,
  starting: { ...off, state: 'starting' },
  needs_sign_in: { ...off, state: 'needs_sign_in', loginUrl: 'https://login.tailscale.com/a/7c1e2f9a40b3d5' },
  needs_approval: { ...off, state: 'needs_approval' },
  on: {
    ...off,
    state: 'on',
    name: NAME,
    addresses: ['100.101.102.103', 'fd7a:115c:a1e0::6f01:1'],
    tailnet: 'mara@lumio.example.org',
    https: true,
  },
  error: { ...off, state: 'error', problem: 'unreachable' },
};
