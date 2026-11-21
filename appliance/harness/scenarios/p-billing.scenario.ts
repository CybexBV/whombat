/**
 * (p-billing) Signups, manual trials and the admin dashboard on the managed stack (contracts ≥ 0.15.0; control
 * BL-17, BL-19, BL-21…BL-29, BL-47, BL-48; IN-72). Real control with the manual billing provider (the harness default;
 * Stripe is control's own tests with a fake, never called here), the real Mailpit and probe appliances (IN-11):
 *
 *   - `GET /v1/signup`: the mode, `billing: manual`, the trial length, the terms version and no plan: Whombat Link
 *     is the only thing sold, on its own page (control BL-48);
 *   - open: an org needs the current Subscription Terms (none 400, an old version `terms_outdated`) and is free: the
 *     `free` plan, active, no trial and no end (control BL-47); the waitlist is closed (`waitlist_closed`);
 *   - the sign-up gate is gone (whombat-cloud CL-186, Whombat whombat-link.md LNK-31): with `invite` or `waitlist`
 *     stored, `GET /v1/signup` still says `open`, an org needs no code and the waitlist stays `waitlist_closed`;
 *   - a manual trial is the operator's to set: the operator extends it and puts the org on a plan (then
 *     `not_trialing`); the trial job ends an expired trial (`cancelled`, “Your Whombat trial has ended”) when control's
 *     job interval can be shortened;
 *   - claims: a new org starts a claim as it is, with nothing bought; a trialing org's second Whombat is
 *     `devices_allowed_reached` (allowed 1); a Whombat another trial used is `trial_used_device` (`canStartNow: false`:
 *     start-now answers `manual_billing`); an operator's plan lets it in;
 *   - the admin dashboard (whombat-cloud CL-196, CL-200): from outside the allowlist a bare 403 on everything, the
 *     right password included; inside it the sign-in page with `no-store` and the CSP; a wrong password and an unknown
 *     user get the same answer; a post that isn't from its own page gets a bare 403; a password sign-in gets the
 *     `wb_op` cookie and the pages, but a change is refused (it needs a passkey); sign-out;
 *   - deleting (contracts ≥ 0.15.1, BL-31, BL-32): the operator deletes an org (a wrong typed name `name_mismatch`), its
 *     claimed Whombat goes back to unclaimed and its account stays; then deletes the account (signed out).
 *
 * The signup mode is put back afterwards and the probes are retired. Code attempts are spread over three accounts and
 * signups come from a per-run loopback address, so reruns stay under control's per-account and per-network limits.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  BillingView,
  ControlSettings,
  OPERATOR_SESSION_COOKIE,
  OperatorOrgDetail,
  SignupInfo,
  SUBSCRIPTION_TERMS_VERSION,
} from '@whombat/control-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setEntitlement } from '../src/dev/licence.ts';
import { restartService } from '../src/dev/restart.ts';
import { contractsAtLeast } from '../src/manifest/version.ts';
import {
  ControlError,
  cancelClaim,
  controlApi,
  signIn,
  startClaim,
  waitForMail,
} from '../src/scenario-kit/cloud.ts';
import { cookiesOf, csrfOf, headingOf, panelRequest } from '../src/scenario-kit/panel.ts';
import { probeDevice, reportClaimed } from '../src/scenario-kit/probe.ts';
import { blocked, note } from '../src/scenario-kit/report.ts';
import { env } from '../src/scenario-kit/world.ts';

const enabled = contractsAtLeast('0.15.0');
const deletes = contractsAtLeast('0.15.1');
const run = randomBytes(2).toString('hex');
/** This run's signup network (127.77.x.y): code attempts and waitlist joins count per network (BL-21, BL-23). */
const NET = `127.77.${randomInt(1, 250)}.${randomInt(1, 250)}`;
/** Outside the panel's default allowlist (127.0.0.0/24, ::1). */
const OUTSIDE = `127.0.9.${randomInt(1, 250)}`;
/** Inside it, but not 127.0.0.1: the sign-in failures of this run count on a network of their own. */
const INSIDE = `127.0.0.${randomInt(2, 250)}`;
const DAY = 86_400;
/** The plan an operator puts an org on here; it is no longer on sale (control BL-48), its row stays. */
const PLAN = 'whombat';

const control = () => env().control?.url ?? '';
const now = () => Math.floor(Date.now() / 1000);

function op<T>(method: string, path: string, body?: unknown): Promise<T> {
  const e = env();
  return controlApi<T>(e.control?.adminUrl ?? '', method, `/v1/operator${path}`, {
    token: readFileSync(e.control?.operatorTokenFile ?? '', 'utf8').trim(),
    ...(body !== undefined ? { body } : {}),
  });
}

interface Refusal {
  status: number;
  code: string;
  reason: string | null;
  details: Record<string, unknown>;
}

async function refused(p: Promise<unknown>, what: string): Promise<Refusal> {
  try {
    await p;
  } catch (err) {
    if (!(err instanceof ControlError)) throw err;
    const details =
      (err.body as { error?: { details?: Record<string, unknown> } } | null)?.error?.details ?? {};
    return { status: err.status, code: err.code, reason: err.reason, details };
  }
  throw new Error(`${what} was accepted`);
}

interface Account {
  email: string;
  token: string;
}

async function account(key: string): Promise<Account> {
  const email = `${key}@harness.whombat.local`;
  const r = await signIn(control(), email);
  return { email, token: r.session.token };
}

/** `orgs.create` from this run's network (BL-21). */
function createOrg(
  a: Account,
  name: string,
  extra: { terms?: { version: string } | null; code?: string } = {},
): Promise<{ orgId: string; name: string }> {
  const { terms, code } = extra;
  return controlApi(control(), 'POST', '/v1/orgs', {
    token: a.token,
    body: {
      name,
      ...(terms === null ? {} : { terms: terms ?? { version: SUBSCRIPTION_TERMS_VERSION } }),
      ...(code ? { code } : {}),
    },
    localAddress: NET,
  });
}

const billing = (a: Account, org: string) =>
  controlApi(control(), 'GET', `/v1/orgs/${org}/billing`, { token: a.token, schema: BillingView });

const signupInfo = () => controlApi(control(), 'GET', '/v1/signup', { schema: SignupInfo });

/** A manual trial of the plan with one Whombat, as an operator sets one: a new org has no trial (control BL-47). */
const manualTrial = (org: string, endsAt: number) =>
  setEntitlement(env(), org, { state: 'trialing', plan: PLAN, devicesAllowed: 1, currentPeriodEnd: endsAt });

/** The live setting (BL-29), then waits until `GET /v1/signup` says it (control caches it for up to 5 s). */
async function setMode(mode: 'open' | 'waitlist' | 'invite'): Promise<void> {
  await op('PUT', '/settings', { signupMode: mode });
  const until = Date.now() + 12_000;
  while ((await signupInfo()).mode !== mode) {
    if (Date.now() > until) throw new Error(`signup mode still not ${mode}`);
    await sleep(500);
  }
}

/** The newest mail to `email` since `since` whose text matches `re`. */
async function mailMatching(email: string, since: number, re: RegExp, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const m = await waitForMail(email, since, Math.max(1000, until - Date.now()));
    if (re.test(m.text)) return m;
    if (Date.now() > until) throw new Error(`no mail to ${email} matching ${re}`);
    await sleep(500);
  }
}

let owner: Account;
let coder: Account;
let other: Account;
let settingsBefore: ControlSettings | null = null;
const probes: string[] = [];

beforeAll(async () => {
  if (!enabled) return;
  owner = await account('billing-owner');
  coder = await account('billing-codes');
  other = await account('billing-other');
  settingsBefore = await op('GET', '/settings').then((s) => ControlSettings.parse(s));
}, 120_000);

afterAll(async () => {
  if (!enabled) return;
  if (settingsBefore) await op('PUT', '/settings', { signupMode: settingsBefore.signupMode }).catch(() => {});
  for (const d of probes)
    await op('POST', `/devices/${d}/retire`, { reason: 'harness-p-billing-cleanup' }).catch(() => {});
  if (process.env.WB_MGD_TRIAL_JOB_SECONDS) {
    delete process.env.WB_MGD_TRIAL_JOB_SECONDS;
    await restartService('control');
  }
}, 180_000);

describe.skipIf(!enabled)('p billing', () => {
  it('signup info: the mode, manual billing, the trial length, the terms version and no plan on sale', async (ctx) => {
    await setMode('open');
    const info = await signupInfo();
    note(ctx, 'signup info', {
      mode: info.mode,
      billing: info.billing,
      trialDays: info.trialDays,
      plans: info.plans.map((p) => `${p.id} ${p.amountCents} ${p.currency}/${p.interval}`),
    });
    expect(info.billing).toBe(env().billing?.provider ?? 'manual');
    expect(info.termsVersion).toBe(SUBSCRIPTION_TERMS_VERSION);
    expect(info.trialDays).toBe(settingsBefore?.trialDays);
    expect(info.plans).toEqual([]);
  });

  it('open: the Subscription Terms are required; a new org is free, with no trial and no end', async (ctx) => {
    await setMode('open');
    const name = `Free Co ${run}`;
    const none = await refused(createOrg(owner, name, { terms: null }), 'an org without terms');
    const old = await refused(
      createOrg(owner, name, { terms: { version: '2026-01-01-draft' } }),
      'an org with old terms',
    );
    const org = await createOrg(owner, name);
    const b = await billing(owner, org.orgId);
    const detail = OperatorOrgDetail.parse(await op('GET', `/orgs/${org.orgId}`));
    const closed = await refused(
      controlApi(control(), 'POST', '/v1/waitlist', {
        body: { email: `closed-${run}@harness.whombat.local` },
        localAddress: NET,
      }),
      'the waitlist in open mode',
    );
    note(ctx, 'open', {
      none,
      old,
      billing: b,
      terms: detail.terms.map((t) => t.version),
      marks: detail.trialMarks.map((m) => m.kind),
      closed,
    });
    expect(none.status).toBe(400);
    expect(old).toMatchObject({ status: 409, reason: 'terms_outdated' });
    expect(b).toMatchObject({
      provider: 'manual',
      state: 'active',
      plan: { id: 'free' },
      manual: true,
      setupRequired: false,
      trialEndsAt: null,
      currentPeriodEnd: null,
    });
    expect(b.whombats.claimed).toBe(0);
    expect(b.whombats.paid).toBeGreaterThanOrEqual(1);
    expect(detail.terms.map((t) => t.version)).toContain(SUBSCRIPTION_TERMS_VERSION);
    // No trial started: the network is noted (a signal only), the account isn't marked as having had one.
    expect(detail.trialMarks.map((m) => m.kind)).toContain('network');
    expect(detail.trialMarks.map((m) => m.kind)).not.toContain('account');
    expect(closed).toMatchObject({ status: 409, reason: 'waitlist_closed' });
  });

  it('the sign-up gate is gone: a stored invite or waitlist mode changes nothing, no code is asked, the waitlist stays closed', async (ctx) => {
    // Sign-up is open for Whombat Link accounts (whombat-cloud CL-186, Whombat whombat-link.md LNK-31): an operator's
    // stored mode is kept but no longer applies.
    const seen: Record<string, unknown> = {};
    for (const mode of ['invite', 'waitlist'] as const) {
      await op('PUT', '/settings', { signupMode: mode });
      // Control reads its settings again within 5 s (BL-29): what it says after that is what applies.
      await sleep(6000);
      const info = await signupInfo();
      const org = await createOrg(coder, `${mode} Co ${run}`);
      const closed = await refused(
        controlApi(control(), 'POST', '/v1/waitlist', {
          body: { email: `gate-${mode}-${run}@harness.whombat.local` },
          localAddress: NET,
        }),
        `the waitlist with a stored ${mode} mode`,
      );
      seen[mode] = { mode: info.mode, org: org.orgId, closed };
      expect(info.mode).toBe('open');
      expect((await billing(coder, org.orgId)).state).toBe('active');
      expect(closed).toMatchObject({ status: 409, reason: 'waitlist_closed' });
    }
    note(ctx, 'a stored mode', seen);
  }, 60_000);

  it('a manual trial: the operator sets it, extends it, then puts the org on a plan', async (ctx) => {
    await setMode('open');
    const org = (await createOrg(owner, `Extend Co ${run}`)).orgId;
    await manualTrial(org, now() + 14 * DAY);
    const before = await billing(owner, org);
    const extended = OperatorOrgDetail.parse(await op('POST', `/orgs/${org}/trial/extend`, { days: 3 }));
    const after = await billing(owner, org);
    const planned = OperatorOrgDetail.parse(
      await op('POST', `/orgs/${org}/plan`, { plan: PLAN, whombats: 2 }),
    );
    const onPlan = await billing(owner, org);
    const notTrialing = await refused(
      op('POST', `/orgs/${org}/trial/extend`, { days: 1 }),
      'extending a plan',
    );
    const listed = (
      await op<{ items: { org: string; state: string }[] }>(
        'GET',
        `/orgs?q=${encodeURIComponent(`Extend Co ${run}`)}`,
      )
    ).items;
    note(ctx, 'extend and plan', {
      trialEnds: [before.trialEndsAt, after.trialEndsAt],
      extended: extended.state,
      planned: { state: planned.state, plan: planned.plan, allowed: planned.whombats.allowed },
      notTrialing,
      listed,
    });
    expect(before).toMatchObject({ state: 'trialing', plan: { id: PLAN }, whombats: { paid: 1 } });
    expect((after.trialEndsAt ?? 0) - (before.trialEndsAt ?? 0)).toBe(3 * DAY);
    expect(onPlan).toMatchObject({
      state: 'active',
      plan: { id: PLAN },
      manual: true,
      whombats: { paid: 2 },
    });
    expect(notTrialing).toMatchObject({ status: 409, reason: 'not_trialing' });
    expect(listed.map((o) => o.org)).toEqual([org]);
  });

  it('the trial job ends an expired manual trial and mails the account', async (ctx) => {
    const src = env().sources['whombat-api']?.path ?? '';
    const config = readFileSync(join(src, 'src/config.ts'), 'utf8');
    if (!config.includes('TRIAL_JOB_SECONDS'))
      blocked(
        ctx,
        'whombat-api/trial-job-interval',
        'control runs the manual trial job every 15 minutes with no way to shorten it in local/dev (TRIAL_JOB_SECONDS)',
      );
    process.env.WB_MGD_TRIAL_JOB_SECONDS = '2';
    await restartService('control');
    await setMode('open');
    const org = (await createOrg(owner, `Expiry Co ${run}`)).orgId;
    await manualTrial(org, now() - 60);
    const since = Date.now();
    const until = Date.now() + 30_000;
    let b = await billing(owner, org);
    while (b.state === 'trialing' && Date.now() < until) {
      await sleep(1000);
      b = await billing(owner, org);
    }
    const mail = await mailMatching(
      owner.email,
      since,
      new RegExp(`free trial of Expiry Co ${run} has ended`),
    );
    note(ctx, 'trial ended', { state: b.state, mail: mail.text.split('\n')[0] });
    expect(b.state).toBe('cancelled');
  }, 120_000);

  it('claims: a new org claims as it is; one Whombat on a trial; a Whombat another trial used; an operator’s plan lets it in', async (ctx) => {
    await setMode('open');
    const fresh = (await createOrg(coder, `Claim New ${run}`)).orgId;
    const a = (await createOrg(owner, `Claim A ${run}`)).orgId;
    const b = (await createOrg(other, `Claim B ${run}`)).orgId;
    for (const org of [a, b]) await manualTrial(org, now() + 14 * DAY);
    const pa = await probeDevice(`bill-a-${run}`);
    const pb = await probeDevice(`bill-b-${run}`);
    const da = pa.prov.record.deviceId;
    const db = pb.prov.record.deviceId;
    probes.push(da, db);
    // Nothing is bought first: a new org's claim starts as the org is, and is let go again here.
    const free = await startClaim(control(), coder.token, fresh, da, pa.prov.card.claimSecret);
    await cancelClaim(control(), coder.token, fresh, free.claim.claim);
    const first = await startClaim(control(), owner.token, a, da, pa.prov.card.claimSecret);
    await reportClaimed(pa.keys, first.claim.claim);
    const second = await refused(
      startClaim(control(), owner.token, a, db, pb.prov.card.claimSecret),
      'a second Whombat on a trial',
    );
    await op('POST', `/devices/${da}/release`, { reason: 'harness-p-billing' });
    const used = await refused(
      startClaim(control(), other.token, b, da, pa.prov.card.claimSecret),
      'a Whombat another trial used',
    );
    const startNow = await refused(
      controlApi(control(), 'POST', `/v1/orgs/${b}/billing/start-now`, { token: other.token, body: {} }),
      'start-now with manual billing',
    );
    await op('POST', `/orgs/${b}/plan`, { plan: PLAN, whombats: 1 });
    const ok = await startClaim(control(), other.token, b, da, pa.prov.card.claimSecret);
    await cancelClaim(control(), other.token, b, ok.claim.claim);
    const detail = OperatorOrgDetail.parse(await op('GET', `/orgs/${a}`));
    note(ctx, 'claims', {
      second,
      used,
      startNow,
      marks: detail.trialMarks.map((m) => `${m.kind}${m.label ? ` ${m.label}` : ''}`),
    });
    expect(second).toMatchObject({ status: 403, reason: 'devices_allowed_reached', details: { allowed: 1 } });
    expect(used).toMatchObject({ status: 409, reason: 'trial_used_device', details: { canStartNow: false } });
    expect(startNow).toMatchObject({ status: 409, reason: 'manual_billing' });
    expect(detail.trialMarks.some((m) => m.kind === 'device' && m.label === da)).toBe(true);
  });

  it.skipIf(!deletes)(
    'deleting: the operator deletes an org (its Whombat released), then its account',
    async (ctx) => {
      await setMode('open');
      const gone = await account(`billing-delete-${run}`);
      const name = `Delete Me ${run}`;
      const org = (await createOrg(gone, name)).orgId;
      const p = await probeDevice(`bill-del-${run}`);
      const d = p.prov.record.deviceId;
      probes.push(d);
      const claim = await startClaim(control(), gone.token, org, d, p.prov.card.claimSecret);
      await reportClaimed(p.keys, claim.claim.claim);
      const mismatch = await refused(
        op('POST', `/orgs/${org}/delete`, { name: 'Someone Else' }),
        'a wrong name',
      );
      const deleted = await op<{ devicesReleased: number }>('POST', `/orgs/${org}/delete`, { name });
      const missing = await refused(op('GET', `/orgs/${org}`), 'a deleted org');
      const device = await op<{ org: string | null; claimedAt: number | null }>('GET', `/devices/${d}`);
      const accounts = await op<{ items: { account: string; orgs: unknown[] }[] }>(
        'GET',
        `/accounts?q=${encodeURIComponent(gone.email)}`,
      );
      const acc = accounts.items[0];
      const after = await op<{ orgsDeleted: number }>('POST', `/accounts/${acc?.account}/delete`, {
        email: gone.email,
      });
      const session = await refused(
        controlApi(control(), 'GET', '/v1/auth/session', { token: gone.token }),
        'a deleted account’s session',
      );
      note(ctx, 'deleting', { mismatch, deleted, device, after, session });
      expect(mismatch).toMatchObject({ status: 400, reason: 'name_mismatch' });
      expect(deleted).toEqual({ ok: true, devicesReleased: 1 });
      expect(missing).toMatchObject({ status: 404, reason: 'org_not_found' });
      expect(device).toMatchObject({ org: null, claimedAt: null });
      expect(acc?.orgs).toEqual([]);
      expect(after).toEqual({ ok: true, orgsDeleted: 0, devicesReleased: 0 });
      expect(session.status).toBe(401);
    },
  );

  it('the admin dashboard: a bare 403 outside the allowlist; sign-in, a password only looks, sign-out', async (ctx) => {
    const e = env();
    const panel = e.panel;
    if (!panel) blocked(ctx, 'whombat-api/panel', 'control has no dashboard listener (CL-196)');
    if (!panel.harnessPasswordFile)
      blocked(
        ctx,
        'harness/panel-user',
        'the users file is not the harness’s (WB_MGD_PANEL_USERS_FILE is set)',
      );
    const base = panel.local;
    const password = readFileSync(panel.harnessPasswordFile, 'utf8').trim();
    /** The sign-in page from `from`, then its form posted with what the page gave (as a browser does). */
    const signIn = async (from: string, username: string, pw: string, origin = true) => {
      const page = await panelRequest(base, '/sign-in', { localAddress: from });
      const pre = cookiesOf(page.setCookie).wb_pre?.value ?? '';
      return panelRequest(base, '/sign-in', {
        form: { csrf: csrfOf(page.text), username, password: pw },
        cookies: { wb_pre: pre },
        localAddress: from,
        origin,
      });
    };

    // Outside the allowlist everything is the same bare 403, the right password included.
    const outside = [
      await panelRequest(base, '/', { localAddress: OUTSIDE }),
      await panelRequest(base, '/sign-in', { localAddress: OUTSIDE }),
      await panelRequest(base, '/sign-in', {
        form: { username: 'harness', password },
        localAddress: OUTSIDE,
      }),
    ];
    // Inside it: no session, so the sign-in page.
    const home = await panelRequest(base, '/', { localAddress: INSIDE });
    const page = await panelRequest(base, '/sign-in', { localAddress: INSIDE });
    const wrong = await signIn(INSIDE, 'harness', `${password}x`);
    const unknown = await signIn(INSIDE, `nobody-${run}`, password);
    // A post that doesn't come from the dashboard's own page gets nothing either.
    const foreign = await signIn(INSIDE, 'harness', password, false);
    const signedIn = await signIn('127.0.0.1', 'harness', password);
    const session = cookiesOf(signedIn.setCookie)[OPERATOR_SESSION_COOKIE];
    if (!session) throw new Error(`no ${OPERATOR_SESSION_COOKIE} cookie: ${signedIn.status}`);
    const cookies = { [OPERATOR_SESSION_COOKIE]: session.value };
    const overview = await panelRequest(base, '/', { cookies });
    const accounts = await panelRequest(base, '/accounts', { cookies });
    const outsideWithCookie = await panelRequest(base, '/', { cookies, localAddress: OUTSIDE });
    // A change needs a passkey sign-in: with a password the dashboard only shows.
    const change = await panelRequest(base, '/codes', {
      form: { csrf: csrfOf(overview.text), note: `harness ${run}` },
      cookies,
    });
    const out = await panelRequest(base, '/sign-out', { form: { csrf: csrfOf(overview.text) }, cookies });
    const after = await panelRequest(base, '/', { cookies });
    note(ctx, 'dashboard', {
      outside: outside.map((r) => r.status),
      home: [home.status, home.headers.location],
      page: [page.status, page.headers['cache-control'], page.headers['content-security-policy']],
      wrong: wrong.status,
      unknown: unknown.status,
      foreign: foreign.status,
      signedIn: [signedIn.status, signedIn.headers.location, session.attributes],
      overview: [overview.status, headingOf(overview.text)],
      accounts: accounts.status,
      change: [change.status, headingOf(change.text)],
      signedOut: [out.status, after.status, after.headers.location],
    });
    for (const r of [...outside, outsideWithCookie, foreign]) {
      expect(r.status).toBe(403);
      expect(r.text).toBe('');
      expect(r.setCookie).toEqual([]);
    }
    expect([home.status, home.headers.location]).toEqual([303, '/sign-in']);
    expect(page.status).toBe(200);
    expect(String(page.headers['content-type'])).toContain('text/html');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(String(page.headers['content-security-policy'])).toContain("default-src 'none'");
    // A wrong password and an unknown user get the same answer: the page says nothing about which it was.
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    const said = (r: { text: string }) => /role="alert">([^<]+)</.exec(r.text)?.[1] ?? '';
    expect(said(wrong)).not.toBe('');
    expect(said(unknown)).toBe(said(wrong));
    expect([wrong.setCookie, unknown.setCookie].flat().join()).not.toContain(OPERATOR_SESSION_COOKIE);
    expect([signedIn.status, signedIn.headers.location]).toEqual([303, '/']);
    expect(session.attributes).toEqual(expect.arrayContaining(['httponly', 'samesite=strict', 'path=/']));
    expect(overview.status).toBe(200);
    expect(accounts.status).toBe(200);
    expect(change.status).toBe(403);
    expect(change.text).toContain('passkey');
    expect(out.status).toBe(303);
    expect([after.status, after.headers.location]).toEqual([303, '/sign-in']);
  });
});
