/**
 * Mara's box as a community edition (contracts 1.1, CT-1300…CT-1308; Whombat hermes-engine.md HE-58…HE-64): what its page
 * says before a session, the links it makes, Tailscale signed in to her own Headscale, and her own mail server.
 */
import {
  type DirectIdentity,
  type EnrollLinkCreateOutput,
  localLinkFor,
  type MailSettings,
  type TailscaleStatus,
} from '@whombat/protocol';
import { DIRECT_ADDRESSES, TAILSCALE_STATES_FIXTURE } from './direct.js';

/** The box's PeerId (the session fake's). */
export const COMMUNITY_APPLIANCE = '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH';

/** A plain GET of `/v1/direct` on a community box nobody claimed yet. */
export const DIRECT_IDENTITY_UNCLAIMED: DirectIdentity = {
  v: 1,
  appliance: COMMUNITY_APPLIANCE,
  edition: 'community',
  claimed: false,
};

/** The same box once Mara claimed it. */
export const DIRECT_IDENTITY_CLAIMED: DirectIdentity = { ...DIRECT_IDENTITY_UNCLAIMED, claimed: true };

/** A QR code to add Mara's phone (`enroll.link.create`). */
export const DEVICE_LINK: EnrollLinkCreateOutput = {
  linkId: 'dln_4Hq2mXk3pZ',
  secret: 'Dev7mXk3pZQ7rT2vW9yB8nC6',
  expiresAt: '2026-10-24T10:05:00.000Z',
  link: localLinkFor({
    kind: 'device',
    appliance: COMMUNITY_APPLIANCE,
    secret: 'Dev7mXk3pZQ7rT2vW9yB8nC6',
    routes: DIRECT_ADDRESSES.routes,
  }),
};

/** Tailscale through Mara's own Headscale: asking her to sign in there, then on. */
export const TAILSCALE_HEADSCALE: Readonly<Record<'needs_sign_in' | 'on', TailscaleStatus>> = {
  needs_sign_in: {
    ...TAILSCALE_STATES_FIXTURE.off,
    state: 'needs_sign_in',
    loginUrl: 'https://hs.lumio.example.org/register/nodekey:7c1e2f9a40b3d5',
    loginServer: 'https://hs.lumio.example.org',
  },
  on: {
    ...TAILSCALE_STATES_FIXTURE.on,
    name: 'whombat-r7m4.lumio.hs',
    tailnet: 'lumio',
    https: false,
    loginServer: 'https://hs.lumio.example.org',
  },
};

/** Mara's own mail server, tested. */
export const MAIL_SETTINGS: MailSettings = {
  source: 'settings',
  host: 'smtp.lumio.example.org',
  port: 587,
  security: 'starttls',
  username: 'whombat@lumio.example.org',
  hasPassword: true,
  from: 'whombat@lumio.example.org',
  fromName: 'Lumio Whombat',
  updatedAt: '2026-10-24T09:12:00.000Z',
  lastTest: { state: 'sent', at: '2026-10-24T09:12:05.000Z', to: 'mara@lumio.example.org', detail: null },
};
