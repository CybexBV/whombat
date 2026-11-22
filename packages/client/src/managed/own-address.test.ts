/** The box's own address in the apps (own-address.md): which page, the setup's order, the claim probe, link codes. */
import { describe, expect, it } from 'vitest';
import { fakePeerId } from '../session/fake';
import { OperationError } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import {
  accountLinkErrorText,
  claimSecretOfPath,
  claimSecretOfTyped,
  linkCodeTimeLeft,
  normalizeLinkCode,
  OWN_ADDRESS_TEXT,
  ownAddressOfPage,
  ownAddressRoute,
  ownAddressView,
  ownClaimHere,
  ownClaimPrefillHash,
  ownClaimProbeOf,
  ownSetupSteps,
  probeOwnClaim,
  readOwnClaimPrefill,
} from './own-address';

const HOST = 'maple-otter-river.box.whombat.app';

function stub(answer: (input: unknown) => { status: number; body: unknown }) {
  const calls: { op: string; input: unknown }[] = [];
  const session = {
    state: () => ({ status: 'open', info: { appliance: { id: fakePeerId('box') } } }),
    invoke: async (op: string, input: unknown) => {
      calls.push({ op, input });
      return answer(input);
    },
  } as unknown as ApplianceSession;
  return { session, calls };
}

const refused = (status: number, code: string, detail?: string) => ({
  status,
  body: { error: { code, message: 'no', ...(detail && { details: { code: detail } }) } },
});

describe('which page this is', () => {
  it('knows the own address, and only that', () => {
    expect(ownAddressOfPage(HOST)).toBe(HOST);
    expect(ownAddressOfPage('Maple-Otter-River.dev.whombat.app.')).toBe('maple-otter-river.dev.whombat.app');
    for (const other of [
      '192.168.1.20',
      'whombat-r7m4.tail1234.ts.net',
      'localhost',
      'app.whombat.com',
      'box.whombat.app',
    ])
      expect(ownAddressOfPage(other)).toBeNull();
  });

  it('reads the claim link’s secret from /c/<6 letters> only', () => {
    expect(claimSecretOfPath('/c/kxmprt')).toBe('kxmprt');
    expect(claimSecretOfPath('/c/KXMPRT/')).toBe('kxmprt');
    // Letters outside the claim alphabet, the wrong length, another path.
    expect(claimSecretOfPath('/c/kxmpri')).toBeNull();
    expect(claimSecretOfPath('/c/kxmpr')).toBeNull();
    expect(claimSecretOfPath('/claim')).toBeNull();
    expect(claimSecretOfPath('/')).toBeNull();
  });

  it('dials the address as wss://<host>/v1/direct', () => {
    expect(ownAddressRoute(`https://${HOST}/`)).toMatchObject({ socket: `wss://${HOST}/v1/direct` });
    expect(ownAddressRoute('https://app.whombat.com/')).toBeNull();
  });
});

describe('the setup’s order (design §7.1)', () => {
  it('is claim, link, then the box’s passkey at the address; a LAN or Tailscale page has no passkey step', () => {
    expect(ownSetupSteps({ atAddress: true })).toEqual(['claim', 'link', 'passkey']);
    expect(ownSetupSteps({ atAddress: false })).toEqual(['claim', 'link']);
  });
});

describe('whether this page claims the box', () => {
  it('starts the claim with the claim link when the page has it', async () => {
    const { session, calls } = stub(() => ({
      status: 200,
      body: { claimId: `lcl_${'a'.repeat(22)}`, expiresAt: '2026-11-18T12:00:00Z' },
    }));
    expect(await probeOwnClaim(session, 'kxmprt')).toBe('claim');
    expect(calls).toEqual([{ op: 'enroll.claim.local.start', input: { link: 'kxmprt' } }]);
    await probeOwnClaim(session, null);
    expect(calls[1]?.input).toEqual({});
  });

  it('reads each refusal: no link, the shared route (Home today), claimed, not ready', async () => {
    const at = async (r: ReturnType<typeof refused>) => probeOwnClaim(stub(() => r).session, null);
    expect(await at(refused(403, 'forbidden', 'claim_link'))).toBe('needs_link');
    // A box with the shared route claims through the Whombat app: never this page's setup, never its words.
    expect(await at(refused(403, 'not_allowed', 'claim_local_unavailable'))).toBe('elsewhere');
    expect(await at(refused(403, 'not_allowed', 'claim_here_unavailable'))).toBe('elsewhere');
    expect(await at(refused(409, 'claim_used'))).toBe('claimed');
    expect(await at(refused(503, 'claim_not_ready'))).toBe('claim');
    expect(ownClaimProbeOf(new Error('offline'))).toBe('failed');
  });

  it('stays in the setup when the tries are used up, and says to ask for new letters at the box', async () => {
    const at = async (r: ReturnType<typeof refused>) => probeOwnClaim(stub(() => r).session, null);
    // A reload after two wrong tries on letters asked for at the box: still this page's claim.
    expect(await at(refused(429, 'rate_limited', 'claim_rate_limited'))).toBe('new_letters');
    expect(await at(refused(403, 'forbidden', 'claim_window_closed'))).toBe('new_letters');
    expect(ownClaimHere('new_letters')).toBe(true);
    expect(ownClaimHere('claim')).toBe(true);
    for (const probe of ['needs_link', 'elsewhere', 'claimed', 'failed', null] as const)
      expect(ownClaimHere(probe)).toBe(false);
  });
});

describe('link codes', () => {
  it('takes the code however it is typed', () => {
    expect(normalizeLinkCode('abcd-efgh')).toBe('ABCD-EFGH');
    expect(normalizeLinkCode(' ABCD EFGH ')).toBe('ABCD-EFGH');
    // I, L, O, S, U, Z aren't in the claim alphabet; too short.
    expect(normalizeLinkCode('ABCD-EFGI')).toBeNull();
    expect(normalizeLinkCode('ABCD-EFG')).toBeNull();
  });

  it('says why a code was refused', () => {
    const t = OWN_ADDRESS_TEXT.link.errors;
    const op = (code: string, detail: string) =>
      new OperationError('account.link', 409, code, 'no', { code: detail });
    expect(accountLinkErrorText(op('conflict', 'link_other_account'))).toBe(t.otherAccount);
    expect(accountLinkErrorText(op('not_found', 'link_code_invalid'))).toBe(t.invalid);
    expect(accountLinkErrorText(op('expired', 'link_code_expired'))).toBe(t.expired);
    expect(accountLinkErrorText(op('unavailable', 'control_unreachable'))).toBe(t.unreachable);
    expect(accountLinkErrorText(new Error('x'))).toBe(t.failed);
  });

  it('counts down', () => {
    expect(linkCodeTimeLeft('2026-11-18T12:10:00Z', Date.parse('2026-11-18T12:00:01Z'))).toBe('9:59');
    expect(linkCodeTimeLeft('2026-11-18T12:10:00Z', Date.parse('2026-11-18T12:10:00Z'))).toBeNull();
  });
});

describe('the address in Settings (design §6)', () => {
  const summary = {
    host: HOST,
    url: `https://${HOST}/`,
    state: 'ready' as const,
    reachable: true,
    certificateEndsAt: '2027-01-17T10:00:00Z',
    watch: {
      lastCheckAt: '2026-11-18T09:00:00Z',
      missed: [
        { from: '2026-11-10T08:00:00Z', to: '2026-11-11T09:00:00Z' },
        { from: '2026-11-14T08:00:00Z', to: '2026-11-15T09:00:00Z' },
      ],
      foreign: [],
    },
  };
  const now = Date.parse('2026-11-18T10:00:00Z');

  it('names the address, the certificate’s end, the last check and each missed stretch, newest first', () => {
    const v = ownAddressView(summary, now);
    expect(v.address).toBe(HOST);
    expect(v.tone).toBe('ok');
    expect(v.certificate).toContain('17 Jan 2027');
    expect(v.missed).toHaveLength(2);
    expect(v.missed[0]).toContain('14 Nov');
    expect(v.missed[1]).toContain('10 Nov');
  });

  it('says Let’s Encrypt asked it to wait, and when it tries again, while the certificate is refused', () => {
    const later = '2026-11-18T13:30:00Z';
    const time = new Date(later).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const failing = { ...summary, state: 'failing' as const, certificateEndsAt: null };
    const busy = ownAddressView({ ...failing, failure: { reason: 'rate_limited', retryAt: later } }, now);
    expect(busy.tone).toBe('warn');
    expect(busy.state).toContain('Many new Whombats');
    expect(busy.state).toContain(time);
    // Another day names the day; once the time passed it says it is trying.
    expect(
      ownAddressView(
        { ...failing, failure: { reason: 'rate_limited', retryAt: '2026-11-20T13:30:00Z' } },
        now,
      ).state,
    ).toContain('20 Nov');
    const passed = ownAddressView(
      { ...failing, failure: { reason: 'rate_limited', retryAt: later } },
      Date.parse(later),
    );
    expect(passed.state).not.toContain(time);
    // Another reason keeps “check it is online”, with the time; an older box without a reason, the old line.
    const offline = ownAddressView(
      { ...failing, failure: { reason: 'ca_unreachable', retryAt: later } },
      now,
    );
    expect(offline).toMatchObject({ tone: 'bad' });
    expect(offline.state).toContain(time);
    expect(offline.state).toContain('online');
    expect(ownAddressView(failing, now).state).toBe(OWN_ADDRESS_TEXT.settings.failing);
  });

  it('says so when the switch is off or a certificate it didn’t ask for is still valid', () => {
    expect(ownAddressView({ ...summary, reachable: false }, now).tone).toBe('mut');
    const foreign = {
      spkiSha256: 'ab'.repeat(32),
      names: [HOST],
      notBefore: '2026-11-17T00:00:00Z',
      notAfter: '2026-11-25T00:00:00Z',
      firstSeenAt: '2026-11-17T06:00:00Z',
    };
    const v = ownAddressView({ ...summary, watch: { ...summary.watch, foreign: [foreign] } }, now);
    expect(v).toMatchObject({ tone: 'bad', foreign: 1 });
    // Expired, it no longer counts.
    expect(
      ownAddressView(
        { ...summary, watch: { ...summary.watch, foreign: [foreign] } },
        Date.parse('2026-12-01'),
      ).foreign,
    ).toBe(0);
  });
});

describe('the words (design §7.5)', () => {
  it('keeps the two passkeys apart in their own words', () => {
    expect(OWN_ADDRESS_TEXT.passkey.words).toContain('can’t use it to open your Whombat');
    expect(OWN_ADDRESS_TEXT.hosted.accountPasskeyWords).toContain('which has a passkey of its own');
    expect(OWN_ADDRESS_TEXT.onlyContinue(HOST)).toContain(HOST);
  });
});

describe('the claim link typed on the page at the address', () => {
  it('takes the six letters, in any case or as the whole address', () => {
    expect(claimSecretOfTyped('kxmprt')).toBe('kxmprt');
    expect(claimSecretOfTyped(' KXMPRT ')).toBe('kxmprt');
    expect(claimSecretOfTyped(`https://${HOST}/c/kxmprt`)).toBe('kxmprt');
    expect(claimSecretOfTyped(`${HOST}/c/kxmprt/`)).toBe('kxmprt');
  });
  it('refuses what can’t be one', () => {
    expect(claimSecretOfTyped('kxmpr')).toBeNull();
    expect(claimSecretOfTyped('kxmprtt')).toBeNull();
    // Letters the box never draws (its alphabet leaves out look-alikes).
    expect(claimSecretOfTyped('kxmpri')).toBeNull();
    expect(claimSecretOfTyped(HOST)).toBeNull();
  });
});

describe('the name and email carried to the claim', () => {
  it('goes there and back in the fragment', () => {
    const hash = ownClaimPrefillHash({ name: ' Mara Visser ', email: 'mara@burrowhq.example' });
    expect(hash.startsWith('#')).toBe(true);
    expect(readOwnClaimPrefill({ pathname: '/', hash })).toEqual({
      name: 'Mara Visser',
      email: 'mara@burrowhq.example',
    });
    expect(readOwnClaimPrefill({ pathname: '/c/kxmprt', hash })).toMatchObject({ name: 'Mara Visser' });
  });
  it('carries what there is, and nothing without either', () => {
    expect(
      readOwnClaimPrefill({ pathname: '/', hash: ownClaimPrefillHash({ email: 'mara@burrowhq.example' }) }),
    ).toEqual({ name: '', email: 'mara@burrowhq.example' });
    expect(ownClaimPrefillHash({ name: ' ', email: '' })).toBe('');
    expect(readOwnClaimPrefill({ pathname: '/', hash: '' })).toBeNull();
    expect(readOwnClaimPrefill({ pathname: '/', hash: '#other=1' })).toBeNull();
  });
  it('is read only on the claim’s own pages, never on a device link’s', () => {
    expect(readOwnClaimPrefill({ pathname: '/add-device', hash: '#name=Mara' })).toBeNull();
    expect(readOwnClaimPrefill({ pathname: '/settings', hash: '#name=Mara' })).toBeNull();
  });
});
