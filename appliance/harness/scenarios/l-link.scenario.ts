/**
 * (l) Whombat Link's plan on a box, from its free month to its end and back (Whombat whombat-link.md LNK-02…LNK-06,
 * LNK-33, LNK-34, LNK-S06; whombat-cloud CL-173…CL-183). Real control (the free month, the trial job, the operator's
 * entitlement), the real manager and runtime, the app's session code and probe boxes (IN-11):
 *
 *   - the licence is inert: the manager holds no token, the runtime computes no state, “Check again” is refused, and
 *     the agent answers as on any day;
 *   - the free month takes two Whombats: a third is `link_trial_boxes` until one is taken out of the account's Link;
 *   - the free month runs out without a card: the trial job ends it, the account is mailed, the box hears `grace` with
 *     its end seven days on, and everything still works (tickets, the relay route);
 *   - after grace Link has ended: control gives no ticket, the relay route is closed, and the box still opens on its
 *     own page with the same device;
 *   - the plan runs again: Link is on, tickets and the relay route are back, nothing had to be set up again;
 *   - the owner turns Link off on the box: control hears it and gives nobody a ticket; turning it on again shows a new
 *     code, and confirming it brings the box back into the same account;
 *   - account deletion at control (CL-45): `email_mismatch`, `org_has_devices` for an account with a box in its Link,
 *     then deleted with its org (the session stops);
 *   - no client address in control's rate-limit buckets after sign-ins over IPv4 and IPv6 (CL-37).
 *
 * The harness can't wait seven days: the day the plan ended is moved back in control's database, as a clock would.
 * The box hears a change of its Link with its next ticket or its hourly look, and its runtime within five minutes of
 * its manager; the scenario restarts both to see it now (a shortcut, recorded as such). The plan, control's job
 * interval and the probes are put back afterwards.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LINK_CODE_RE, LINK_GRACE_S } from '@whombat/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envPath } from '../src/dev/env.ts';
import { heldLicence, setEntitlement } from '../src/dev/licence.ts';
import { psql } from '../src/dev/postgres.ts';
import { provisionDevAppliance } from '../src/dev/provision.ts';
import { restartService } from '../src/dev/restart.ts';
import { CONTROL_DB, unixJson } from '../src/dev/services.ts';
import { ports } from '../src/lib/paths.ts';
import { type ApplianceSession, openDirectSession, whenOpen } from '../src/scenario-kit/app-client.ts';
import { applianceBox, type Box, waitForConsole } from '../src/scenario-kit/boxes.ts';
import {
  ControlError,
  clientTicket,
  controlApi,
  linkBoxes,
  linkConfirm,
  linkRemove,
  sessionInfo,
  waitForMail,
} from '../src/scenario-kit/cloud.ts';
import { deviceOp, loadDeviceKeys } from '../src/scenario-kit/device.ts';
import { linkedProbe } from '../src/scenario-kit/probe.ts';
import { note } from '../src/scenario-kit/report.ts';
import { ensureSlice, identityOf, ownerSession, type SliceState } from '../src/scenario-kit/slice.ts';
import { invokeOp, refused } from '../src/scenario-kit/trust.ts';
import { api, ensureWorkspace, repliesTo, type Workspace } from '../src/scenario-kit/work.ts';
import { env, type Persona, persona, runtimeHealth } from '../src/scenario-kit/world.ts';

let slice: SliceState;
let box: Box;
let owner: ApplianceSession;
let ownerP: Persona;
let w: Workspace;
const run = randomBytes(2).toString('hex');
const probesToRetire: string[] = [];

const control = () => env().control?.url ?? '';
const now = () => Math.floor(Date.now() / 1000);
/** The account's Link org: its hidden billing record, under which its tickets are asked. */
const org = () => ownerP.org;

async function reopenOwner(): Promise<void> {
  try {
    owner?.close('closed');
  } catch {
    // already closed
  }
  owner = (await ownerSession(slice)).session;
}

/** What a refused control call answered. */
async function controlRefusal(
  p: Promise<unknown>,
  what: string,
): Promise<{ status: number; reason: string }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ControlError) return { status: err.status, reason: err.reason ?? err.code };
    throw err;
  }
  throw new Error(`${what} was accepted`);
}

/** The box's Link as its manager keeps it (`POST /v1/link/state`, what the runtime and the screen read). */
async function boxLink(): Promise<{ state: string; graceEndsAt?: string; pending?: { code: string } }> {
  const r = await unixJson(box.managerSocket, 'POST', '/v1/link/state', { v: 1 });
  if (r.status !== 200) throw new Error(`link state: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body as { link: { state: string; graceEndsAt?: string; pending?: { code: string } } }).link;
}

/**
 * Makes the box look at its Link now, then waits until its manager and its screen say `state`. A box's manager hears a
 * change with its next ticket or its hourly `link.status`, and its runtime reads the manager's state every five
 * minutes (`LINK_STATE_POLL_S`); both read at their start, so the scenario restarts them, as a restart of the box
 * would, and opens the owner's session again.
 */
async function boxHears(state: string, timeoutMs = 90_000): Promise<Awaited<ReturnType<typeof boxLink>>> {
  await restartService('manager');
  const until = Date.now() + timeoutMs;
  let link = await boxLink().catch(() => null);
  while (link?.state !== state) {
    if (Date.now() > until) throw new Error(`the box never heard ${state}: ${JSON.stringify(link)}`);
    await sleep(1000);
    link = await boxLink().catch(() => null);
  }
  await restartService('runtime');
  // A box whose Link is off shows nothing about it; every other state is on its screen.
  if (state !== 'off')
    await waitForConsole(box, (c) => c.link?.state === state, `Whombat Link ${state}`, 120_000);
  return link;
}

/** Whether the owner gets a ticket to the box from control, and why not. */
async function ticket(): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  try {
    await clientTicket(control(), ownerP.session.token, org(), slice.deviceId, 'app', 'interactive');
    return { ok: true };
  } catch (err) {
    if (err instanceof ControlError) return { ok: false, status: err.status, reason: err.reason ?? err.code };
    throw err;
  }
}

/**
 * Is the runtime's connection to the relay up? Its admin socket's `/health` says so in the session endpoint's detail
 * (“relay connected, …”; “relay stopped” while Link is off or has ended).
 */
async function relayRoute(): Promise<boolean> {
  const h = (await runtimeHealth()).body as { checks?: { sessionEndpoint?: { detail?: string } } };
  return /^relay connected\b/.test(h.checks?.sessionEndpoint?.detail ?? '');
}

async function waitRelayRoute(up: boolean, what: string): Promise<void> {
  const until = Date.now() + 90_000;
  while ((await relayRoute()) !== up) {
    if (Date.now() > until) throw new Error(`${what}: the relay route is still ${up ? 'down' : 'up'}`);
    await sleep(1000);
  }
}

/** The owner's device on the box's own page: the direct connection, which needs neither control nor the relay. */
async function ownPage(): Promise<ApplianceSession> {
  const s = openDirectSession({
    url: box.directUrl,
    identity: identityOf(slice),
    appliance: { peerId: slice.peerId },
  });
  await whenOpen(s);
  return s;
}

/** A box that made its identity and began Link, not yet in any account: its keys and the code its screen would show. */
async function beginningProbe(name: string) {
  const dir = envPath('probes', name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prov = await provisionDevAppliance({
    dir,
    controlUrl: control(),
    provisioningToken: '',
    claimUrlBase: `http://localhost:${ports.web}/claim`,
    registrar: 'local',
  });
  const keys = loadDeviceKeys(prov.identityDir);
  const registration = JSON.parse(readFileSync(join(prov.identityDir, 'registration.json'), 'utf8'));
  const begun = (await deviceOp(control(), keys, 'link.begin', { registration })) as {
    link: { pending?: { code: string } };
  };
  return { keys, code: begun.link.pending?.code ?? '' };
}

beforeAll(async () => {
  slice = await ensureSlice();
  box = applianceBox();
  ownerP = await persona(slice.owner.email.split('@')[0] ?? '', slice.owner.name);
  await reopenOwner();
  w = await ensureWorkspace(owner, `Link ${run}`);
}, 240_000);

afterAll(async () => {
  for (const d of probesToRetire)
    await controlApi(env().control?.adminUrl ?? '', 'POST', `/v1/operator/devices/${d}/retire`, {
      token: readFileSync(env().control?.operatorTokenFile ?? '', 'utf8').trim(),
      body: { reason: 'harness-l-link-cleanup' },
    }).catch(() => {});
  if (process.env.WB_MGD_TRIAL_JOB_SECONDS) {
    delete process.env.WB_MGD_TRIAL_JOB_SECONDS;
    await restartService('control');
  }
  try {
    owner?.close('closed');
  } catch {
    // already closed
  }
}, 240_000);

describe('l Whombat Link: the plan, its end and the way back', () => {
  it('the licence is inert: no token is held, no state is computed, “Check again” is refused, the agent answers', async (ctx) => {
    const held = heldLicence(env());
    const status = (await invokeOp(owner, 'licence.status', {}, false)) as { licence: unknown };
    const again = await refused(invokeOp(owner, 'licence.refresh', {}, true), 'licence.refresh');
    const marker = `inert-${run}`;
    const sent = await api<{ message: { id: string } }>(owner, 'messages.send', 'POST', {
      params: { burrow: w.slug, conversationId: w.conversationId },
      body: { text: `@${w.agent.name} hello ${marker}`, clientId: marker },
    });
    // The scripted agent answers within seconds; a held turn would never be answered.
    let reply = await repliesTo(owner, w.slug, sent.message.id, w.agent.id);
    for (let i = 0; i < 90 && reply.length === 0; i++) {
      await sleep(1000);
      reply = await repliesTo(owner, w.slug, sent.message.id, w.agent.id);
    }
    note(ctx, 'licence', { held: held?.token ? 'a token' : 'none', status, again, replies: reply.length });
    expect(held?.token ?? null).toBeNull();
    expect(status.licence).toBeNull();
    expect(again.appCode ?? again.code).toBe('not_allowed');
    expect(reply.length).toBeGreaterThan(0);
  });

  it('the free month takes two Whombats: a third is link_trial_boxes until one is taken out', async (ctx) => {
    const before = await linkBoxes(control(), ownerP.session.token);
    expect(before.plan.state).toBe('trialing');
    expect(before.boxes.map((b) => b.device)).toEqual([slice.deviceId]);
    const second = await linkedProbe(`link-2-${run}`, ownerP);
    probesToRetire.push(second.keys.deviceId);
    const third = await beginningProbe(`link-3-${run}`);
    probesToRetire.push(third.keys.deviceId);
    expect(third.code).toMatch(LINK_CODE_RE);
    const full = await controlRefusal(
      linkConfirm(control(), ownerP.session.token, third.code),
      'a third Whombat in the free month',
    );
    // Taking the second out makes room, and the third's code, still live, now links it.
    const afterRemove = await linkRemove(control(), ownerP.session.token, second.keys.deviceId);
    const linked = await linkConfirm(control(), ownerP.session.token, third.code);
    note(ctx, 'two in the free month', {
      full,
      afterRemove: afterRemove.boxes.map((b) => b.device),
      third: linked.state,
    });
    expect(full).toEqual({ status: 403, reason: 'link_trial_boxes' });
    expect(afterRemove.boxes.map((b) => b.device)).toEqual([slice.deviceId]);
    expect(linked.state).toBe('on');
    // Leave the account as it was: only the dev appliance.
    const left = await linkRemove(control(), ownerP.session.token, third.keys.deviceId);
    expect(left.boxes.map((b) => b.device)).toEqual([slice.deviceId]);
  });

  it('the free month runs out without a card: the account is mailed, the box is in grace for seven days and everything still works', async (ctx) => {
    // Control's trial job every 2 s instead of every 15 minutes, and the free month's end moved into the past.
    process.env.WB_MGD_TRIAL_JOB_SECONDS = '2';
    await restartService('control');
    const since = Date.now();
    await setEntitlement(env(), org(), { state: 'trialing', currentPeriodEnd: now() - 60 });
    const until = Date.now() + 60_000;
    let plan = (await linkBoxes(control(), ownerP.session.token)).plan;
    while (plan.state === 'trialing') {
      if (Date.now() > until) throw new Error('the trial job never ended the free month');
      await sleep(1000);
      plan = (await linkBoxes(control(), ownerP.session.token)).plan;
    }
    const mail = await waitForMail(ownerP.email, since, 60_000);
    const link = await boxHears('grace');
    const t = await ticket();
    await reopenOwner();
    const me = await api<{ account: { id: string } }>(owner, 'me.get', 'GET');
    note(ctx, 'grace', {
      plan,
      mail: mail.text.split('\n')[0],
      link,
      ticket: t,
      relayRoute: await relayRoute(),
    });
    expect(plan.state).toBe('cancelled');
    const graceEnd = Date.parse(link.graceEndsAt ?? '') / 1000;
    expect(Math.abs(graceEnd - (now() + LINK_GRACE_S))).toBeLessThan(600);
    expect(t).toEqual({ ok: true });
    expect(me.account.id).toBe(slice.owner.accountId);
    expect(await relayRoute()).toBe(true);
  }, 300_000);

  it('after grace Link has ended: no ticket, the relay route is closed, and the box still opens on its own page', async (ctx) => {
    // Eight days later, as far as control can tell.
    const moved = await psql(
      `update entitlements set ended_at = ended_at - interval '8 days', updated_at = updated_at - interval '8 days' where org_id = '${org()}'`,
      CONTROL_DB,
    );
    expect(moved.code, moved.stderr).toBe(0);
    const link = await boxHears('ended');
    await waitRelayRoute(false, 'Link ended');
    const t = await ticket();
    // The device the owner already uses, straight to the box: nobody is locked out of their own Whombat.
    const page = await ownPage();
    try {
      const me = await api<{ account: { id: string } }>(page, 'me.get', 'GET');
      const account = await linkBoxes(control(), ownerP.session.token);
      note(ctx, 'ended', { link, ticket: t, account: account.boxes, me: me.account.id });
      expect(t).toEqual({ ok: false, status: 403, reason: 'link_off' });
      expect(me.account.id).toBe(slice.owner.accountId);
      expect(account.boxes.find((b) => b.device === slice.deviceId)?.state).toBe('ended');
    } finally {
      page.close('closed');
    }
  }, 300_000);

  it('the plan runs again: Link is on, tickets and the relay route are back, nothing is set up again', async (ctx) => {
    await setEntitlement(env(), org(), { state: 'active', currentPeriodEnd: null });
    const link = await boxHears('on');
    await waitRelayRoute(true, 'Link on again');
    const t = await ticket();
    await reopenOwner();
    const me = await api<{ account: { id: string } }>(owner, 'me.get', 'GET');
    note(ctx, 'on again', { link, ticket: t });
    expect(t).toEqual({ ok: true });
    expect(me.account.id).toBe(slice.owner.accountId);
  }, 300_000);

  it('the owner turns Link off on the box: nobody gets a ticket; on again shows a new code, and confirming it brings the box back', async (ctx) => {
    // On the box's own page, as Settings → This Whombat → Reach does at home: turning Link off closes the relay route,
    // so a device that came in through it would never hear the answer.
    let page = await ownPage();
    let off: { link?: { state?: string } };
    try {
      off = (await invokeOp(page, 'link.off', {}, true)) as { link?: { state?: string } };
    } finally {
      page.close('closed');
    }
    // Off on the box at once; control took the box out of the account's Link.
    const until = Date.now() + 60_000;
    while ((await boxLink()).state !== 'off') {
      if (Date.now() > until) throw new Error(`Link still ${(await boxLink()).state} after link.off`);
      await sleep(500);
    }
    await waitRelayRoute(false, 'Link off');
    const t = await ticket();
    const account = await linkBoxes(control(), ownerP.session.token);
    // Turned on again from the box's own page (the relay route is gone with Link).
    page = await ownPage();
    let code = '';
    try {
      await invokeOp(page, 'link.on', {}, true);
      const shown = await waitForConsole(
        box,
        (c) => c.link?.state === 'starting' && !!c.link.code,
        'a new Whombat Link code',
      );
      code = shown.link?.code ?? '';
    } finally {
      page.close('closed');
    }
    const linked = await linkConfirm(control(), ownerP.session.token, code);
    await waitForConsole(box, (c) => c.link?.state === 'on', 'Whombat Link on', 90_000);
    await waitRelayRoute(true, 'Link on after its owner turned it on');
    await reopenOwner();
    const me = await api<{ account: { id: string } }>(owner, 'me.get', 'GET');
    note(ctx, 'off and on', {
      off: off.link?.state,
      ticketWhileOff: t,
      boxesWhileOff: account.boxes.map((b) => b.device),
      linked: linked.state,
    });
    expect(t).toMatchObject({ ok: false });
    expect(account.boxes.map((b) => b.device)).not.toContain(slice.deviceId);
    expect(code).toMatch(LINK_CODE_RE);
    expect(linked).toMatchObject({ device: slice.deviceId, state: 'on' });
    expect(me.account.id).toBe(slice.owner.accountId);
  }, 300_000);

  it('account deletion at control: email_mismatch, org_has_devices; then deleted with its org and signed out', async (ctx) => {
    const url = control();
    const del = (token: string, email: string) =>
      controlApi(url, 'DELETE', '/v1/me', { token, body: { email } });
    const x = await persona(`del-x-${randomBytes(3).toString('hex')}`, 'Xena Delete', { fresh: true });
    const mismatch = await controlRefusal(
      del(x.session.token, 'someone-else@harness.whombat.local'),
      'a mismatching email',
    );
    // An account with a box in its Link can't go.
    const z = await persona(`del-z-${randomBytes(3).toString('hex')}`, 'Zed Devices', { fresh: true });
    const probe = await linkedProbe(`link-z-${randomBytes(2).toString('hex')}`, z);
    probesToRetire.push(probe.keys.deviceId);
    const devicesLeft = await controlRefusal(
      del(z.session.token, z.email),
      'the account of an org with a box',
    );
    // An account without boxes goes with its org.
    await del(x.session.token, x.email);
    const xAfter = await controlRefusal(sessionInfo(url, x.session.token), 'a deleted account’s session');
    note(ctx, 'account deletion', { mismatch, devicesLeft, xAfter, org: x.org });
    expect(mismatch).toEqual({ status: 400, reason: 'email_mismatch' });
    expect(devicesLeft).toEqual({ status: 409, reason: 'org_has_devices' });
    expect(xAfter.status).toBe(401);
  });

  it('no client address in control’s rate-limit buckets after sign-ins over IPv4 and IPv6', async (ctx) => {
    const email = `ratelimit-${randomBytes(3).toString('hex')}@harness.whombat.local`;
    const v6 = control().replace('//127.0.0.1:', '//[::1]:');
    await controlApi(control(), 'POST', '/v1/auth/magic-link', { body: { email } });
    const v6ok = await controlApi(v6, 'POST', '/v1/auth/magic-link', { body: { email } }).then(
      () => true,
      () => false,
    );
    const r = await psql('select bucket from rate_limits', CONTROL_DB);
    const buckets = r.stdout.split('\n').filter(Boolean);
    const leaks = buckets.filter((b) => /127\.0\.0\.\d|::1|::ffff|\b\d{1,3}(\.\d{1,3}){3}\b/.test(b));
    note(ctx, 'rate-limit buckets', { count: buckets.length, v6: v6ok, sample: buckets.slice(0, 8), leaks });
    expect(buckets.some((b) => b.startsWith('ml:net:'))).toBe(true);
    expect(leaks).toEqual([]);
  });
});
