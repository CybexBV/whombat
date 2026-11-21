/**
 * (1) Setting up a Whombat as a person does (Whombat whombat-link.md LNK-03, LNK-13; MA-22, CC-01…CC-08; HE-59): the
 * dev appliance made its identity itself and was told at its installer to be reached with Whombat Link. Real control,
 * relay, manager, runtime and the app's own claim (`runLocalClaim`, CPace over the box's own page):
 *
 *   - the screen shows a Link code and the account site's page; a wrong code is `link_code_invalid`, and before anyone
 *     confirmed the box nobody gets a ticket to it;
 *   - the owner confirms the code at the account site: the free month starts, the box's Link is on, the account's Link
 *     lists it, and the code is used up for everyone else;
 *   - the screen shows four letters and the box's own page;
 *   - a network that lies about the box (CPace bound to another appliance PeerId) gets no claim;
 *   - wrong letters rotate the code; after the free failures the box refuses with `claim_backoff` and its screen
 *     counts down;
 *   - the owner claims it with its letters once the backoff is over (the owner every later scenario uses): the screen
 *     says it is set up, and nobody can claim it again (`claim_used`).
 */
import { LINK_CODE_RE } from '@whombat/protocol';
import { generateIdentity } from '@whombat/secure-channel';
import { beforeAll, describe, expect, it } from 'vitest';
import { OperationError, sessionOps } from '../src/scenario-kit/app-client.ts';
import {
  applianceBox,
  type Box,
  claimable,
  consoleOf,
  lettersOf,
  waitForConsole,
  wrongLetters,
} from '../src/scenario-kit/boxes.ts';
import {
  ControlError,
  clientTicket,
  linkBoxes,
  linkConfirm,
  linkLookup,
  linkOrgOf,
} from '../src/scenario-kit/cloud.ts';
import { note } from '../src/scenario-kit/report.ts';
import { claimAppliance, linkBox, loadSlice, localClaim, openOwnPage } from '../src/scenario-kit/slice.ts';
import { env, type Persona, persona } from '../src/scenario-kit/world.ts';

const appCode = (e: unknown) =>
  ((e as { details?: { code?: string } }).details?.code ??
    (e as { code?: string }).code ??
    String(e)) as string;

const control = () => env().control?.url ?? '';

let A: Box;
let owner: Persona;
let stranger: Persona;
/** The dev appliance was claimed by an earlier run of this environment: what happens before a claim can't be seen. */
let aClaimed = false;
/** The Link code the screen showed before its owner confirmed it. */
let linkCode = '';

/** One claim attempt with `typed` letters on the box's own page; the error or what the box answered. */
async function attempt(typed: string, opts: { appliancePeerId?: string } = {}) {
  const { enroll, identity } = await openOwnPage({ box: A });
  try {
    return await (await localClaim())
      .runLocalClaim({
        session: enroll,
        letters: typed,
        appliancePeerId: opts.appliancePeerId ?? A.peerId,
        clientPeerId: identity.peerId,
        account: { name: 'Mallory', email: 'mallory@harness.whombat.local' },
        endpoint: { label: 'Harness (attempt)', platform: 'cli' },
      })
      .catch((x) => x as Error);
  } finally {
    enroll.close('closed');
  }
}

const letters = async () => lettersOf((await waitForConsole(A, claimable, 'a claim code')).code ?? '');

describe('1 Whombat Link and the claim on the box’s own page', () => {
  beforeAll(async () => {
    A = applianceBox();
    aClaimed = !!loadSlice();
    owner = await persona(`owner-${A.deviceId}`, 'Ada Owner');
    stranger = await persona('claim-stranger', 'Stranger');
  }, 120_000);

  it('the screen shows a Link code and the account site’s page; a wrong code is link_code_invalid; nobody has a ticket yet', async (ctx) => {
    if (aClaimed) return ctx.skip('the dev appliance was claimed by an earlier run of this environment');
    const c = await waitForConsole(
      A,
      (x) => x.link?.state === 'starting' && !!x.link.code,
      'a Whombat Link code',
      120_000,
    );
    note(ctx, 'screen', { link: c.link });
    linkCode = c.link?.code ?? '';
    expect(linkCode).toMatch(LINK_CODE_RE);
    expect(c.link?.url).toMatch(/^https:\/\/[^/]+\/link$/);
    // A code nobody was shown: same alphabet, one letter moved on.
    const wrong = `${wrongLetters(linkCode.slice(0, 4))}-${linkCode.slice(5)}`;
    const refused = await linkLookup(control(), stranger.session.token, wrong).catch((x) => x);
    expect(refused).toBeInstanceOf(ControlError);
    note(ctx, 'a wrong code', { status: refused.status, reason: refused.reason });
    expect(refused.status).toBe(404);
    expect(refused.reason).toBe('link_code_invalid');
    // The right code says which box and that the free month is still to be had; reading it links nothing.
    const found = await linkLookup(control(), owner.session.token, linkCode);
    note(ctx, 'the right code', { ...found });
    expect(found.linked).toBe(false);
    expect(found.trial).toBe(true);
    expect((await linkBoxes(control(), owner.session.token)).boxes).toHaveLength(0);
    // Control knows the box since its `link.begin`, but it is nobody's: no ticket for anyone.
    for (const p of [owner, stranger]) {
      const t = await clientTicket(control(), p.session.token, p.org, A.deviceId, 'app', 'interactive').catch(
        (x) => x,
      );
      expect(t).toBeInstanceOf(ControlError);
      expect(t.status).toBe(404);
    }
  });

  it('the owner confirms the code: the free month starts, Link is on, the account lists the box, the code is used up', async (ctx) => {
    if (aClaimed) return ctx.skip('the dev appliance was claimed by an earlier run of this environment');
    const linked = await linkBox({ box: A, owner, narrate: (step, d) => note(ctx, step, d ?? {}) });
    expect(linked?.device).toBe(A.deviceId);
    expect(linked?.state).toBe('on');
    const account = await linkBoxes(control(), owner.session.token);
    note(ctx, 'the account’s Whombat Link', { plan: account.plan, boxes: account.boxes });
    expect(account.boxes.map((b) => b.device)).toEqual([A.deviceId]);
    expect(account.plan.state).toBe('trialing');
    expect(owner.org).toBe(await linkOrgOf(control(), owner.session.token));
    // The code linked one box into one account: for anyone else it is as good as a wrong one.
    const again = await linkConfirm(control(), stranger.session.token, linkCode).catch((x) => x);
    expect(again).toBeInstanceOf(ControlError);
    expect(again.reason).toBe('link_code_invalid');
    expect((await linkBoxes(control(), stranger.session.token)).boxes).toHaveLength(0);
    // Its owner typing it again changes nothing.
    expect((await linkLookup(control(), owner.session.token, linkCode)).linked).toBe(true);
    const c = consoleOf(A);
    expect(c?.link?.state).toBe('on');
    expect(c?.link?.code ?? null).toBeNull();
  });

  it('the screen shows four letters and the box’s own page', async (ctx) => {
    if (aClaimed) return ctx.skip('the dev appliance was claimed by an earlier run of this environment');
    const c = await waitForConsole(A, claimable, 'a claim code', 120_000);
    note(ctx, 'screen', { code: c.code, url: c.url });
    expect(c.code).toMatch(/^[ABCDEFGHJKMNPQRTVWXY]{4}$/);
    // The box's own page, not the account site's: the claim never goes through control.
    expect(new URL(c.url).host).toBe(new URL(A.directUrl).host.replace('127.0.0.1', 'localhost'));
  });

  it('a network that lies about the box gets no claim: CPace bound to another appliance PeerId fails', async (ctx) => {
    if (aClaimed) return ctx.skip('the dev appliance was claimed by an earlier run of this environment');
    const right = await letters();
    // The right letters, but the client's view of the box is another key (what something splicing two Noise sessions
    // would give): the tags can't match, so the box refuses and shows new letters.
    const other = await generateIdentity();
    const r = await attempt(right, { appliancePeerId: other.peerId });
    expect(r).toBeInstanceOf(Error);
    note(ctx, 'CPace with another appliance PeerId', { appCode: appCode(r), name: (r as Error).name });
    expect(['claim_invalid', 'ClaimMismatchError']).toContain(
      r instanceof OperationError ? appCode(r) : (r as Error).name,
    );
    await waitForConsole(
      A,
      (x) => x.state !== 'claimable' || lettersOf(x.code ?? '') !== right,
      'new letters',
    );
    expect(consoleOf(A)?.state).not.toBe('claimed');
  });

  it('wrong letters rotate the code; after the free failures the box backs off and its screen counts down', async (ctx) => {
    if (aClaimed) return ctx.skip('the dev appliance was claimed by an earlier run of this environment');
    const seen: string[] = [];
    let backoff: unknown = null;
    for (let i = 0; i < 6 && !backoff; i++) {
      const c = await waitForConsole(A, (x) => claimable(x) || x.state === 'backoff', 'a code or a backoff');
      if (c.state === 'backoff') {
        backoff = { console: c };
        break;
      }
      const now = lettersOf(c.code ?? '');
      seen.push(now);
      const r = await attempt(wrongLetters(now));
      if (appCode(r) === 'claim_backoff') backoff = r;
      else expect(appCode(r)).toBe('claim_invalid');
    }
    note(ctx, 'letters shown between wrong tries', { seen });
    expect(new Set(seen).size).toBe(seen.length);
    expect(backoff).toBeTruthy();
    const c = await waitForConsole(A, (x) => x.state === 'backoff', 'a backoff');
    note(ctx, 'screen in backoff', { retryAt: c.retryAt, code: c.code });
    expect(c.code).toBeNull();
    expect(Date.parse(c.retryAt ?? '')).toBeGreaterThan(Date.now());
    const r = await attempt('AAAA');
    expect(appCode(r)).toBe('claim_backoff');
    note(ctx, 'a try during the backoff', {
      appCode: appCode(r),
      details: (r as { details?: unknown }).details,
    });
  });

  it('claimed with its letters once the backoff is over (the owner of every later scenario); nobody claims it again', async (ctx) => {
    if (aClaimed) note(ctx, 'the dev appliance was claimed by an earlier run of this environment; kept');
    else {
      await waitForConsole(A, claimable, 'the end of the backoff', 330_000);
      const r = await claimAppliance({
        ownerKey: `owner-${A.deviceId}`,
        ownerName: 'Ada Owner',
        probeUnconfirmedKit: true,
        narrate: (step, d) => note(ctx, step, d ?? {}),
      });
      // The claim asks for no recovery kit (Whombat signin-at-box BX-01, contracts CT-1281); the one made after it is
      // saved and verified by claimAppliance.
      expect(r.enrolled).not.toHaveProperty('recoveryKitRequired');
      expect(r.state.recovery.confirmedAt).toBeTruthy();
    }
    const c = await waitForConsole(A, (x) => x.state === 'claimed', 'claimed');
    note(ctx, 'screen after the claim', { console: c });
    expect(c.code).toBeNull();
    // Its page takes no second claim, whatever is typed.
    const { enroll } = await openOwnPage({ box: A });
    try {
      const again = await sessionOps.claimLocalStart(enroll, {}).catch((x) => x);
      expect(again).toBeInstanceOf(OperationError);
      expect(appCode(again)).toBe('claim_used');
    } finally {
      enroll.close('closed');
    }
  }, 600_000);
});
