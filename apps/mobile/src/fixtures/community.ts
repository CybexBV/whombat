/**
 * Mara's box as a community edition, in memory (hermes-engine-app.md AP-5478): the demo world's burrow behind a box
 * whose welcome says `community`, that lets a phone in with its own device link (the fixtures' adds it to Mara's
 * account) and answers what its This Whombat and Devices ask — its mail server (`createFakeMail`), Tailscale with a
 * login server of her own (`createFakeTailscale`; a sign-in counts as done after two looks, as if she finished the
 * page), device links on its direct ways. Everything else is the phone's REST fixture world. No React Native here
 * (tested in Node).
 */

import {
  createFakeAppliance,
  type FakeAccount,
  type FakeAppliance,
  type RestFetch,
  restHandler,
  restResources,
} from '@whombat/client/fake';
import { createFakeMail, createFakeTailscale } from '@whombat/client/host/fake';
import { burrow, COMMUNITY_APPLIANCE, DEVICE_LINK, DIRECT_ADDRESSES, mara } from '@whombat/fixtures';
import { localLinkFor } from '@whombat/protocol/session';

/** Mara, whose Whombat it is (the account the fixtures' device link adds a phone to). */
export const COMMUNITY_PERSON: FakeAccount & { email: string } = {
  id: 'acc_mara',
  name: 'Mara Okafor',
  email: 'mara@lumio.example.org',
};

export interface CommunityBox {
  appliance: FakeAppliance;
  /** A connector for one phone key and channel (what `env.connector` gives a target). */
  connectorFor(key: string, channel: 'app' | 'enroll'): FakeAppliance['connector'];
  /** The keys let in. */
  joined: Map<string, FakeAccount & { email: string }>;
}

const err = (status: number, code: string, message: string) => ({
  status,
  body: { error: { code, message, details: { code } } },
});
const ok = (body: unknown) => ({ status: 200, body });

function b64url(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function createCommunityBox(options: {
  rest: RestFetch;
  origin: string;
  now?: () => Date;
}): CommunityBox {
  const now = options.now ?? (() => new Date());
  const joined = new Map<string, FakeAccount & { email: string }>();
  const mail = createFakeMail('none', now);
  const tailscale = createFakeTailscale('off');
  let looks = 0;
  const rest = restHandler(options.rest, { origin: options.origin });
  const iso = (ms: number) => new Date(now().getTime() + ms).toISOString();
  const endpointOf = (key: string, label: string) => ({
    endpointId: `end_${key.slice(-10)}`,
    peerId: key,
    label,
    platform: 'android' as const,
    accountId: COMMUNITY_PERSON.id,
    createdAt: iso(0),
    lastSeenAt: iso(0),
    current: true,
    revokedAt: null,
    revocation: 'none' as const,
  });
  const enrolled = (key: string, label: string) => ({
    accountId: COMMUNITY_PERSON.id,
    name: COMMUNITY_PERSON.name,
    endpoint: endpointOf(key, label),
    authzGeneration: 1,
  });
  const appliance = createFakeAppliance({
    applianceId: COMMUNITY_APPLIANCE,
    edition: 'community',
    direct: DIRECT_ADDRESSES,
    resources: restResources(options.rest, options.origin),
    admit: (who) => {
      const account = joined.get(who.endpointId);
      return account ? { account } : 'not_enrolled';
    },
    handle: async (op, input, context) => {
      const i = (input ?? {}) as Record<string, unknown>;
      const key = context.endpointId;
      const who = joined.get(key);
      const endpoint = (i.endpoint ?? {}) as { label?: string };
      if (op.startsWith('host.mail'))
        return mail.call(op, input, { email: COMMUNITY_PERSON.email }) ?? err(404, 'unknown_op', op);
      if (op === 'host.tailscale' || op.startsWith('host.tailscale.')) {
        if (op === 'host.tailscale' && tailscale.status().state === 'needs_sign_in' && ++looks >= 2) {
          looks = 0;
          tailscale.signedIn();
        }
        return tailscale.call(op, input) ?? err(404, 'unknown_op', op);
      }
      switch (op) {
        case 'enroll.link.accept':
          if (who) return err(409, 'endpoint_enrolled', 'This device is already in.');
          if (i.secret !== DEVICE_LINK.secret) return err(403, 'link_invalid', 'That link doesn’t work.');
          joined.set(key, COMMUNITY_PERSON);
          return ok(enrolled(key, endpoint.label ?? 'Phone'));
        case 'enroll.link.create': {
          const secret = b64url(18);
          return ok({
            linkId: `dln_${b64url(8)}`,
            secret,
            expiresAt: iso(300_000),
            link: localLinkFor({
              kind: 'device',
              appliance: COMMUNITY_APPLIANCE,
              secret,
              routes: DIRECT_ADDRESSES.routes,
            }),
          });
        }
        case 'endpoints.list':
          return ok({
            endpoints: [
              endpointOf(key, 'Pixel 7 · Android app'),
              {
                ...endpointOf('12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo', 'Firefox on Linux'),
                platform: 'web',
                current: false,
                lastSeenAt: iso(-600_000),
              },
            ],
          });
        case 'licence.status':
          return ok({ licence: null });
        case 'host.metrics':
          return ok({ metrics: null, reason: 'not_managed' });
        case 'host.network':
          return ok({ network: null, reason: 'not_managed' });
        case 'host.hardware':
          return ok({ hardware: null, reason: 'not_managed' });
        case 'host.bluetooth':
          return ok({ bluetooth: null, reason: 'not_managed' });
        case 'appliance.status':
          return ok(communityStatus(now));
        case 'me.get':
          // The phone's REST world has no `/me`: Mara, in the demo's burrow (her principal).
          return ok({
            account: {
              id: COMMUNITY_PERSON.id,
              email: COMMUNITY_PERSON.email,
              name: COMMUNITY_PERSON.name,
              title: '',
              createdAt: '2026-10-24T09:00:00.000Z',
            },
            memberships: [
              {
                burrowId: burrow.id,
                burrowSlug: burrow.slug,
                burrowName: burrow.name,
                principalId: mara.id,
              },
            ],
            preferences: { theme: 'system', timeZone: null },
          });
        default:
          if (op.startsWith('desk.') || op.startsWith('remoteHelp.') || op.startsWith('passkey'))
            return err(403, 'not_allowed', 'Not on this Whombat.');
          return rest(op, input, context);
      }
    },
  });
  return {
    appliance,
    connectorFor: (key, channel) => appliance.connectorFor({ endpointId: key, channel }),
    joined,
  };
}

/** `appliance.status` of the community box: claimed, no licence, no update channel to report, backups not set up. */
export function communityStatus(now: () => Date = () => new Date()) {
  return {
    claimed: true,
    claimReported: false,
    recovery: { enrolled: false, kitVerified: false, rotationPending: false },
    revocationsPending: 0,
    revocationsApplied: 0,
    clientFloor: null,
    draining: false,
    policy: {},
    backup: {
      state: 'unprotected',
      lastSuccessAt: null,
      ageS: null,
      coverage: [],
      unprotected: ['database', 'attachments', 'workspaces'],
      relogin: [],
      lastFailure: null,
      recoverable: false,
    },
    appliance: {
      peerId: COMMUNITY_APPLIANCE,
      runtimeVersion: '2026.10.24',
      schemaVersion: 3,
      protocol: { major: 5, minor: 0 },
    },
    update: {
      state: 'Healthy',
      current: '2026.10.24',
      candidate: null,
      lastCheckedAt: now().toISOString(),
      deferredReason: null,
      failure: null,
    },
    providers: [],
  };
}
