/**
 * The setup at a box's own address in the fake world (own-address.md): claim with
 * the claim link → link to the account with its code → the box's own passkey → a device link that carries the address
 * (`o=`). The calls the page makes, in its order, against the world the visual checks use.
 */

import { fakePeerId } from '@whombat/client/fake';
import {
  APPLIANCE_TERMS_VERSION,
  createBoxPasskey,
  ownClaimProbeOf,
  type PasskeyPlatform,
  parseLocalLink,
  probeOwnClaim,
  runLocalClaim,
  SUBSCRIPTION_TERMS_VERSION,
} from '@whombat/client/managed';
import { type ApplianceSession, createSecureSession, sessionOps } from '@whombat/client/session';
import { toBase64url } from '@whombat/core/backup';
import { afterEach, describe, expect, it } from 'vitest';
import { WEB_CLIENT } from './connect';
import { createFakeWorld, FAKE_OWN_CLAIM_LINK, FAKE_OWN_HOST } from './fake/world';

const json = (o: unknown) => toBase64url(new TextEncoder().encode(JSON.stringify(o)));

/** A browser's authenticator at the address: answers what it's asked, PRF included. */
const authenticator: PasskeyPlatform = {
  isAvailable: async () => true,
  supportsConditional: async () => false,
  async create(o) {
    return {
      id: 'Ym94LXBhc3NrZXk',
      rawId: 'Ym94LXBhc3NrZXk',
      type: 'public-key',
      response: {
        clientDataJSON: json({
          type: 'webauthn.create',
          challenge: o.challenge,
          origin: `https://${FAKE_OWN_HOST}`,
        }),
        attestationObject: 'o2NmbXRkbm9uZQ',
      },
      clientExtensionResults: {
        prf: { enabled: true, results: { first: toBase64url(new Uint8Array(32).fill(5)) } },
      },
    };
  },
  async get() {
    throw new Error('not asked');
  },
  async prf({ credentialIds }) {
    return { credentialId: credentialIds[0] as string, output: new Uint8Array(32).fill(5) };
  },
};

const open: ApplianceSession[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  localStorage.clear();
});

describe('setting up a box at its own address (fake world)', () => {
  it('claims with the link, links the account, makes the box’s passkey and makes links with o=', async () => {
    const world = await createFakeWorld();
    world.faults.ownBox(true);
    // The account at app.whombat.com, signed in, with its org.
    await world.control.verifySignIn('a'.repeat(22));
    const org = await world.control.createOrg({
      name: 'Burrow HQ',
      terms: { version: SUBSCRIPTION_TERMS_VERSION },
    });
    const env = world.box();
    expect(env.ownAddress()).toBe(FAKE_OWN_HOST);
    const box = await env.identity();
    expect(box).toMatchObject({ edition: 'commercial', claimed: false });
    const me = { peerId: fakePeerId('chrome-at-the-address') };
    const session = (expect: 'any' | 'app') => {
      const s = createSecureSession({
        connector: env.connector({ peerId: box?.appliance as string, key: me }),
        client: WEB_CLIENT,
        expect,
      });
      s.connect();
      open.push(s);
      return s;
    };

    // Without the link from its screen the page only says where to find it; with it, it claims.
    const enrol = session('any');
    expect(await probeOwnClaim(enrol, null)).toBe('needs_link');
    expect(await probeOwnClaim(enrol, FAKE_OWN_CLAIM_LINK)).toBe('claim');
    // A page whose link changed meanwhile (new letters were asked for at the box) is refused the same way when it
    // claims: the setup then asks the box again, and says where the link is.
    const stale = await runLocalClaim({
      session: enrol,
      letters: world.faults.ownLetters() as string,
      link: 'aaaaaa',
      appliancePeerId: box?.appliance as string,
      clientPeerId: me.peerId,
      account: { name: 'Mara', email: 'mara@burrowhq.example' },
      endpoint: { label: 'Chrome', platform: 'web' },
    }).catch((error: unknown) => error);
    expect(ownClaimProbeOf(stale)).toBe('needs_link');
    const claimed = await runLocalClaim({
      session: enrol,
      letters: world.faults.ownLetters() as string,
      link: FAKE_OWN_CLAIM_LINK,
      appliancePeerId: box?.appliance as string,
      clientPeerId: me.peerId,
      account: { name: 'Mara', email: 'mara@burrowhq.example' },
      endpoint: { label: 'Chrome', platform: 'web' },
    });
    expect(claimed.accountId).toBeTruthy();
    // The link changed after the claim.
    expect(world.faults.ownClaimLink()).toBeNull();

    // The account's code, typed at the box: “Link to <email>?”, then linked.
    const app = session('app');
    const code = await world.control.createWhombatLink?.(org.orgId, { version: APPLIANCE_TERMS_VERSION });
    expect(code?.code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    const lookup = await sessionOps.accountLinkLookup(app, code?.code as string);
    expect(lookup.email).toBeTruthy();
    await sessionOps.accountLink(app, code?.code as string);
    // The account's list shows it by name only.
    const listed = await world.control.appliances(org.orgId);
    expect(listed.find((a) => a.ownAddress)).toBeTruthy();

    // The box's own passkey, its backup key armed and checked.
    const made = await createBoxPasskey({
      session: app,
      platform: authenticator,
      appliance: box?.appliance as string,
      name: 'Chrome',
    });
    expect(made.id).toBe('Ym94LXBhc3NrZXk');
    const passkeys = await sessionOps.passkeysList(app);
    expect(passkeys.passkeys.find((p) => p.id === made.id)?.rpId).toBe(FAKE_OWN_HOST);

    // A device link opens at the address.
    const link = await sessionOps.linkCreate(app);
    expect(parseLocalLink(link.link)?.own).toBe(`https://${FAKE_OWN_HOST}/`);
  });
});
