/**
 * The DEV box's person at work, through the real client over the relay (`dev/devbox`, UP-D1, UP-D2; IN-94, IN-101).
 * One task per run (`WB_DEVBOX_TASK`), its result as JSON in `WB_DEVBOX_OUT`:
 *
 *   claim   sign in, the person's org (active, self-install; the dev instance bills with Stripe, so the operator sets
 *           the plan), the box nearby from this network, the claim with the four letters of its console through the
 *           app's own ceremony (CPace over the enrollment session), the recovery kit registered and confirmed;
 *   smoke   sign in again, the app session with the enrolled endpoint, the box's status and backup status read, a
 *           message posted and seen, Hermes ready on the box's runner (Whombat HE-01, IN-404), an agent's turn answered
 *           through the runner;
 *   soak    (UP-D2) the smoke, then `WB_DEVBOX_SOAK_S` seconds of watching — control's device record every minute
 *           (still the release `WB_DEVBOX_RELEASE`, Healthy, no failure, no two consecutive `down` reports of the runtime
 *           or the database, no reboot) and the box's status through one app session held open the whole time (every
 *           drop and reconnect recorded: a runtime restart shows there) — then the smoke again.
 *   deploy-check / deploy-inspect   an agent deploys a site to a test server (Whombat GF-07), below;
 *   ra-check  the resourceful agents as a person uses them (Whombat RA-60), `ra-check.ts`.
 *
 * Hermes runs every turn on the box, the image's package (Whombat HE-01, NX-430); with no AI provider signed in, the
 * agent's answer is the “isn't set up” reply — what the smoke proves is the turn's round trip through the runner and
 * Hermes ready there, not a model (IN-101, IN-404).
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { APPLIANCE_TERMS_VERSION, SUBSCRIPTION_TERMS_VERSION } from '@whombat/control-contracts';
import { generateKeypair } from '@whombat/core/audit';
import { RECOVERY_KIT_CONFIRM_PURPOSE, signRecoveryStatement } from '@whombat/protocol/session';
import { deserializeIdentity, serializeIdentity } from '@whombat/secure-channel';
import { expect, it } from 'vitest';
import { sleep } from '../lib/proc.ts';
import {
  type ApplianceSession,
  newEndpointIdentity,
  openSession,
  sessionOps,
  whenOpen,
} from '../scenario-kit/app-client.ts';
import { claimCeremony } from '../scenario-kit/slice.ts';
import { api, collect, ensureWorkspace, eventType } from '../scenario-kit/work.ts';
import { devOp } from '../ship/context.ts';
import { type CloudSession, device as deviceOf, publicApi } from './control.ts';
import { raCheck } from './ra-check.ts';
import { raCheckTimeoutMs } from './ra-rules.ts';
import { control, need, type Step, session, tickets } from './session-kit.ts';
import { type DevboxState, loadState, saveState } from './state.ts';

/** What `host.agents` says of the runner and Hermes (contracts `AgentSetupStatus`), the fields the smoke reads. */
interface RunnerStatus {
  runner: { connected: boolean; seenAt: string | null };
  hermes: { ready: boolean; version: string | null; problem: string | null; detail: string | null } | null;
}

const task = process.env.WB_DEVBOX_TASK ?? '';
const out = process.env.WB_DEVBOX_OUT ?? '';

async function ensureOrg(st: DevboxState, s: CloudSession): Promise<string> {
  const info = await publicApi<CloudSession>(control, 'GET', '/v1/auth/session', { token: s.token });
  const name = `${st.owner.name} org`;
  let org = info.orgs.find((o) => o.name === name)?.orgId;
  if (!org) {
    // Outside `open` signup mode a new org needs a code (BL-33): one of the operator's, single use, no mail.
    const { code } = await devOp<{ code: string }>(control, 'POST', '/signup-codes', {
      note: 'dev/devbox: the DEV box’s org',
      plan: 'free',
      whombats: 10,
      maxUses: 1,
      expiresInDays: 1,
    });
    org = (
      await publicApi<{ orgId: string }>(control, 'POST', '/v1/orgs', {
        token: s.token,
        body: { name, terms: { version: SUBSCRIPTION_TERMS_VERSION }, code },
      })
    ).orgId;
  }
  // The dev instance bills with Stripe: a new org has no plan and every claim would wait for one (BL-12).
  await devOp(control, 'PUT', `/orgs/${org}/entitlement`, {
    state: 'active',
    plan: 'free',
    devicesAllowed: 10,
    currentPeriodEnd: null,
    limits: { connectors: null },
    selfInstall: true,
  });
  st.owner.org = org;
  saveState(st);
  return org;
}

async function claim(st: DevboxState): Promise<Record<string, unknown>> {
  const letters = need(process.env.WB_DEVBOX_LETTERS, 'claim code (WB_DEVBOX_LETTERS)').replace(/-/g, '');
  const dev = need(st.device, 'device');
  const peerId = need(st.peerId, 'peerId');
  const s = await session(st);
  const org = await ensureOrg(st, s);
  // Nearby from this network (the box renews its lookup lease every few minutes).
  let near: string[] = [];
  for (const until = Date.now() + 300_000; ; ) {
    near = (
      await publicApi<{ devices: { device: string }[] }>(control, 'GET', `/v1/orgs/${org}/claims/nearby`, {
        token: s.token,
      })
    ).devices.map((d) => d.device);
    if (near.includes(dev) || Date.now() > until) break;
    await sleep(5000);
  }
  if (!near.includes(dev))
    throw new Error(`claims.nearby doesn’t list ${dev} from this network: ${near.join(', ')}`);
  const pending = await publicApi<{
    claim: { claim: string; contentPeerId: string };
    ticket: { ticket: string; relay: { url: string } };
  }>(control, 'POST', `/v1/orgs/${org}/claims`, {
    token: s.token,
    body: { method: 'code', device: dev, class: 'interactive', terms: { version: APPLIANCE_TERMS_VERSION } },
  });
  if (pending.claim.contentPeerId !== peerId)
    throw new Error('control’s PeerId for the box is not the registered one');
  const identity = await newEndpointIdentity();
  const enroll = openSession({
    tickets: tickets(st, s.token, 'enroll', {
      ticket: pending.ticket.ticket,
      relayUrl: pending.ticket.relay.url,
    }),
    identity,
    appliance: { peerId },
    channel: 'enroll',
    expect: 'any',
  });
  try {
    await whenOpen(enroll, 60_000);
    const { runClaimCeremony } = await claimCeremony();
    const enrolled = await runClaimCeremony({
      session: enroll,
      claim: { claim: pending.claim.claim, device: dev },
      request: { method: 'code', device: dev, letters },
      appliancePeerId: peerId,
      clientPeerId: identity.peerId,
      account: { name: st.owner.name, email: st.owner.email },
      endpoint: { label: 'dev/devbox', platform: 'cli' },
    });
    const recovery = generateKeypair();
    const kit = (await sessionOps.recoveryKitRegister(enroll, recovery.publicKey)) as {
      kitId: string;
      challenge: string;
    };
    const signature = signRecoveryStatement(
      {
        purpose: RECOVERY_KIT_CONFIRM_PURPOSE,
        appliance: peerId,
        kitId: kit.kitId,
        challenge: kit.challenge,
      },
      recovery.secretKey,
    );
    await sessionOps.recoveryKitConfirm(enroll, { kitId: kit.kitId, signature });
    st.endpointKey = Buffer.from(serializeIdentity(identity)).toString('base64');
    st.endpointId = String((enrolled.endpoint as { id?: string } | undefined)?.id ?? '');
    st.recovery = { publicKey: recovery.publicKey, secretKey: recovery.secretKey, kitId: kit.kitId };
    st.claimedAt = new Date().toISOString();
    saveState(st);
    for (const until = Date.now() + 120_000; ; ) {
      if ((await deviceOf(control, dev))?.state === 'claimed') break;
      if (Date.now() > until) throw new Error('control never saw the claim');
      await sleep(2000);
    }
    return { device: dev, org, accountId: enrolled.accountId, kitId: kit.kitId };
  } finally {
    enroll.close('closed');
  }
}

interface SmokeState {
  burrowId: string;
  slug: string;
  agentId: string;
  agentName: string;
  conversationId: string;
}

/**
 * The box's one burrow with its agent and the person's Chat (Whombat one-agent.md OA-01, OA-04): the one there is, else
 * made now as “Dev box” (a box holds one burrow, so this is the box's own, IN-395).
 */
async function workspace(s: ApplianceSession, st: DevboxState & { smoke?: SmokeState }): Promise<SmokeState> {
  const w = await ensureWorkspace(s, 'Dev box');
  st.smoke = {
    burrowId: w.burrowId,
    slug: w.slug,
    agentId: w.agent.id,
    agentName: w.agent.name,
    conversationId: w.conversationId,
  };
  saveState(st);
  return st.smoke;
}

async function smoke(st: DevboxState & { smoke?: SmokeState }): Promise<{ ok: boolean; steps: Step[] }> {
  const steps: Step[] = [];
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    const t = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ms: Date.now() - t, detail });
      return detail;
    } catch (err) {
      steps.push({ name, ok: false, ms: Date.now() - t, detail: (err as Error).message.slice(0, 600) });
      return null;
    }
  };
  const peerId = need(st.peerId, 'peerId');
  const identity = deserializeIdentity(
    new Uint8Array(Buffer.from(need(st.endpointKey, 'endpoint key'), 'base64')),
  );
  const cloud = await step('sign in (magic link, verified by control)', async () => {
    const s = await session(st);
    return { account: s.account.id, orgs: s.orgs.length };
  });
  if (!cloud || !st.session) return { ok: false, steps };
  const s = openSession({
    tickets: tickets(st, st.session.token, 'app'),
    identity,
    appliance: { peerId },
    channel: 'app',
  });
  try {
    const info = await step('app session through the relay', async () => {
      const i = await whenOpen(s, 60_000);
      return { channel: i.channel, protocol: i.protocol, account: i.account?.id ?? null };
    });
    if (!info) return { ok: false, steps };
    await step('appliance status', async () => {
      const a = (await sessionOps.applianceStatus(s)) as {
        claimed: boolean;
        update?: { current?: string; state?: string } | null;
        backup?: unknown;
        appliance?: unknown;
      };
      expect(a.claimed).toBe(true);
      return { update: a.update ?? null, appliance: a.appliance };
    });
    await step('backup status read', async () => {
      const ops = sessionOps as unknown as {
        backupStatus(s: ApplianceSession): Promise<{ summary: unknown }>;
      };
      return (await ops.backupStatus(s)).summary;
    });
    const w = await step('workspace (the burrow, its agent, your Chat)', () => workspace(s, st));
    if (!w) return { ok: false, steps };
    const events = collect(s, [`burrow:${w.burrowId}`, `conv:${w.conversationId}`]);
    try {
      await events
        .waitFor((e) => e.topic.startsWith('conv:') || e.topic.startsWith('burrow:'), 3000)
        .catch(() => null);
      await step('post a message and see it come back', async () => {
        const marker = `smoke-${randomBytes(4).toString('hex')}`;
        const sent = await api<{ message: { id: string } }>(s, 'messages.send', 'POST', {
          params: { burrow: w.slug, conversationId: w.conversationId },
          body: { text: `Dev box smoke ${marker}`, clientId: marker },
        });
        await events.waitFor(
          (e) =>
            eventType(e) === 'message.created' &&
            (e.event as { message?: { id?: string } }).message?.id === sent.message.id,
          30_000,
          'the message event',
        );
        return { message: sent.message.id };
      });
      await step('the runner is connected and Hermes is ready there', async () => {
        const a = await api<RunnerStatus>(s, 'host.agents', 'GET', {
          params: { burrow: w.slug },
        });
        if (!a.runner.connected) throw new Error(`no runner in touch (seen ${a.runner.seenAt ?? 'never'})`);
        // Every turn runs on Hermes (HE-01): the runner reports it with every heartbeat (contracts 0.124.0 CT-1160).
        if (a.hermes?.ready !== true)
          throw new Error(
            `Hermes isn’t ready on the box's runner: ${a.hermes ? `${a.hermes.problem}: ${a.hermes.detail ?? ''}` : 'not reported'}`,
          );
        return { runner: a.runner, hermes: a.hermes.version };
      });
      await step('an agent turn answered through the runner', async () => {
        const marker = `turn-${randomBytes(4).toString('hex')}`;
        const sent = await api<{ dispatches: { dispatchId: string }[] }>(s, 'messages.send', 'POST', {
          params: { burrow: w.slug, conversationId: w.conversationId },
          body: { text: `Say hello (${marker})`, clientId: marker },
        });
        if (!sent.dispatches.length) throw new Error('no dispatch to the agent');
        const reply = (await events.waitFor(
          (e) => {
            const m = (e.event as { message?: { author?: { id: string }; authorId?: string; text?: string } })
              .message;
            return eventType(e) === 'message.created' && (m?.author?.id ?? m?.authorId) === w.agentId
              ? m
              : null;
          },
          240_000,
          'the agent’s reply',
        )) as { text?: string };
        const text = String(reply.text ?? '');
        if (/runner isn.t running/i.test(text))
          throw new Error(`the agent answered without a runner: ${text}`);
        return { reply: text.slice(0, 300) };
      });
    } finally {
      events.close();
    }
  } finally {
    s.close('closed');
  }
  return { ok: steps.every((x) => x.ok), steps };
}

export interface SoakResult {
  ok: boolean;
  release: string;
  device: string;
  startedAt: string;
  endedAt: string;
  requestedS: number;
  observedS: number;
  samples: number;
  reasons: string[];
  healthDowns: { at: string; runtime?: string; database?: string }[];
  sessionDrops: { at: string; reason: string }[];
  statusFailures: number;
  uptime: { first: number | null; last: number | null };
  smoke: { start: unknown; end: unknown };
}

async function soak(st: DevboxState & { smoke?: SmokeState }): Promise<SoakResult> {
  const release = need(process.env.WB_DEVBOX_RELEASE, 'release (WB_DEVBOX_RELEASE)');
  const seconds = Number(process.env.WB_DEVBOX_SOAK_S ?? '7200');
  const intervalMs = Number(process.env.WB_DEVBOX_SOAK_INTERVAL_S ?? '60') * 1000;
  const dev = need(st.device, 'device');
  const startedAt = new Date();
  const reasons: string[] = [];
  const healthDowns: SoakResult['healthDowns'] = [];
  const sessionDrops: SoakResult['sessionDrops'] = [];
  let samples = 0;
  let statusFailures = 0;
  let downRun = 0;
  let firstUp: number | null = null;
  let lastUp: number | null = null;
  const start = await smoke(st);
  if (!start.ok) reasons.push('the smoke at the start failed');
  const identity = deserializeIdentity(
    new Uint8Array(Buffer.from(need(st.endpointKey, 'endpoint key'), 'base64')),
  );
  const s = openSession({
    tickets: tickets(st, need(st.session, 'session').token, 'app'),
    identity,
    appliance: { peerId: need(st.peerId, 'peerId') },
    channel: 'app',
  });
  let closing = false;
  s.onState((x) => {
    if (closing) return;
    if (x.status === 'reconnecting' || x.status === 'closed')
      sessionDrops.push({ at: new Date().toISOString(), reason: `${x.status}: ${x.reason}` });
  });
  try {
    await whenOpen(s, 60_000);
    const until = startedAt.getTime() + seconds * 1000;
    while (Date.now() < until && !reasons.length) {
      samples++;
      const d = await deviceOf(control, dev).catch(() => null);
      const u = d?.status?.update;
      const h = d?.status?.health ?? {};
      if (!d) reasons.push(`control lost ${dev}`);
      else if (d.status?.release !== release)
        reasons.push(`the box reports ${d.status?.release ?? 'no release'}, not ${release}`);
      else if (u?.state !== 'Healthy' || u.failure)
        reasons.push(`the box is ${u?.state ?? 'unknown'}${u?.failure ? ` (${u.failure})` : ''}`);
      const down = h.runtime === 'down' || h.database === 'down';
      if (down) {
        healthDowns.push({ at: new Date().toISOString(), runtime: h.runtime, database: h.database });
        if (++downRun >= 2) reasons.push('the runtime or the database reported down twice in a row');
      } else downRun = 0;
      const up = d?.status?.uptimeS;
      if (typeof up === 'number') {
        if (lastUp !== null && up < lastUp) reasons.push(`the box restarted (uptime ${lastUp} s → ${up} s)`);
        firstUp ??= up;
        lastUp = up;
      }
      try {
        const a = (await sessionOps.applianceStatus(s)) as { update?: { current?: string } | null };
        if (a.update?.current && a.update.current !== release)
          reasons.push(`the runtime says it runs ${a.update.current}, not ${release}`);
      } catch {
        statusFailures++;
      }
      // The whole requested time: the last pause is shorter when the next minute would pass it.
      const rest = until - Date.now();
      if (rest <= 0) break;
      await sleep(Math.min(intervalMs, rest));
    }
  } finally {
    closing = true;
    s.close('closed');
  }
  const end = await smoke(st);
  if (!end.ok) reasons.push('the smoke at the end failed');
  const endedAt = new Date();
  return {
    ok: reasons.length === 0,
    release,
    device: dev,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    requestedS: seconds,
    observedS: Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
    samples,
    reasons,
    healthDowns,
    sessionDrops,
    statusFailures,
    uptime: { first: firstUp, last: lastUp },
    smoke: { start, end },
  };
}

/* The deploy check (Whombat goal-first.md GF-07) ----------------------------------------------------------------- */

interface DeployCheckState {
  burrowId: string;
  slug: string;
  agentName: string;
  conversationId: string;
}

const DEPLOY_HOST = process.env.WB_DEPLOY_HOST ?? '10.62.52.1';
const DEPLOY_SSH_PORT = Number(process.env.WB_DEPLOY_SSH_PORT ?? '2222');
const DEPLOY_WEB_PORT = Number(process.env.WB_DEPLOY_WEB_PORT ?? '8088');
const DEPLOY_KEYS = process.env.WB_DEPLOY_KEYS ?? '';
const DEPLOY_MINUTES = Number(process.env.WB_DEPLOY_MINUTES ?? '40');
const DEPLOY_SIGNIN_FILE = process.env.WB_DEPLOY_SIGNIN_FILE ?? '';

/**
 * The agent on the box deploys a site to a server whose Vault entry is switched on for it, end to end, and the site
 * shows it: the person signs in to ChatGPT (Hermes's device flow, once: its link and code are written to
 * `WB_DEPLOY_SIGNIN_FILE` for a person to approve; nothing to install, IN-432), the box's one burrow and its agent on
 * ChatGPT (`codex`), a local repository `site`, an SSH key
 * generated in the Vault (its public half written to `WB_DEPLOY_KEYS/deploy` for the test server), the server `web-1`
 * marked Production, the key switched on for the agent, the home network listed; then one message in the person's Chat
 * asks for a page with a marker to be built and put live. Every card the agent posts is allowed for the task, as a person would; the check passes when the
 * server shows the marker. Everything the agent said and asked for is in the result.
 */
async function deployCheck(
  st: DevboxState & { deployCheck?: DeployCheckState },
): Promise<Record<string, unknown> & { ok: boolean }> {
  const steps: Step[] = [];
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    const t = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ms: Date.now() - t, detail });
      return detail;
    } catch (err) {
      steps.push({ name, ok: false, ms: Date.now() - t, detail: (err as Error).message.slice(0, 1500) });
      return null;
    }
  };
  const peerId = need(st.peerId, 'peerId');
  const identity = deserializeIdentity(
    new Uint8Array(Buffer.from(need(st.endpointKey, 'endpoint key'), 'base64')),
  );
  await session(st);
  if (!st.session) return { ok: false, steps };
  const s = openSession({
    tickets: tickets(st, st.session.token, 'app'),
    identity,
    appliance: { peerId },
    channel: 'app',
  });
  const marker = `banjo-${randomBytes(3).toString('hex')}`;
  const approved: Record<string, unknown>[] = [];
  let site = '';
  try {
    await whenOpen(s, 60_000);
    const w = await step('the burrow, its agent and your Chat', async () => {
      const ws = await ensureWorkspace(s, 'Dev box');
      st.deployCheck = {
        burrowId: ws.burrowId,
        slug: ws.slug,
        agentName: ws.agent.name,
        conversationId: ws.conversationId,
      };
      saveState(st);
      return st.deployCheck;
    });
    if (!w) return { ok: false, steps };
    // ChatGPT runs on Hermes's own provider: nothing to install, only the person's sign-in (IN-432; Whombat HN-A01).
    const signedIn = await step('you signed in to ChatGPT', async () => {
      const ops = sessionOps as unknown as {
        providersList(s: ApplianceSession): Promise<{ signIns: { provider: string }[] }>;
        providerLoginStart(
          s: ApplianceSession,
          i: { provider: string; authMode: string },
        ): Promise<{ loginId: string; device: { verificationUri: string; userCode: string } | null }>;
        providerLoginStatus(s: ApplianceSession, id: string): Promise<{ state: string; error: unknown }>;
      };
      if ((await ops.providersList(s)).signIns.some((x) => x.provider === 'codex')) return 'already';
      const login = await ops.providerLoginStart(s, { provider: 'codex', authMode: 'chatgpt' });
      const text = `Open ${login.device?.verificationUri} and enter ${login.device?.userCode}\n`;
      if (DEPLOY_SIGNIN_FILE) writeFileSync(DEPLOY_SIGNIN_FILE, text);
      console.log(text);
      for (let i = 0; i < 180; i++) {
        const st2 = await ops.providerLoginStatus(s, login.loginId);
        if (st2.state === 'completed') return 'completed';
        if (st2.state !== 'awaiting_user' && st2.state !== 'awaiting_secret')
          throw new Error(`sign-in ${st2.state}: ${JSON.stringify(st2.error)}`);
        await sleep(5000);
      }
      throw new Error('nobody approved the ChatGPT sign-in in 15 minutes');
    });
    if (!signedIn) return { ok: false, steps, signIn: DEPLOY_SIGNIN_FILE };
    const b = { burrow: w.slug };
    await step('the agent runs on ChatGPT', () =>
      api(s, 'agent.update', 'PATCH', { params: b, body: { runtime: { provider: 'codex' } } }),
    );
    await step('a local repository “site”', async () => {
      const repos = await api<{ repos: { name?: string; fullName?: string }[] }>(s, 'repos.list', 'GET', {
        params: b,
      }).catch(() => ({
        repos: [] as { name?: string; fullName?: string }[],
      }));
      if (repos.repos.some((r) => (r.fullName ?? r.name ?? '').toLowerCase().endsWith('site')))
        return 'already';
      return api(s, 'repos.create', 'POST', {
        params: b,
        body: { name: 'site', description: 'Our website.' },
      });
    });
    const vault = await step(
      'an SSH key in the Vault for web-1 (Production), switched on for the agent',
      async () => {
        // One entry for web-1: an earlier run's would still name it in the turn's keys, with a key the server no longer
        // takes (the first entry to name a host keeps it in ssh_config).
        const listed = await api<{ entries: { id: string; name: string }[] }>(s, 'vault.list', 'GET', {
          params: b,
        });
        for (const e of listed.entries.filter((x) => x.name === 'Web server'))
          await api(s, 'vault.remove', 'DELETE', { params: { ...b, entryId: e.id } }, { expect: [200, 204] });
        const created = await api<{ entry: { id: string; auth: { publicKey: string } } }>(
          s,
          'vault.create',
          'POST',
          {
            params: b,
            body: {
              name: 'Web server',
              kind: 'ssh',
              description: 'Our web server',
              sshKey: { mode: 'generate' },
            },
          },
        );
        const id = created.entry.id;
        if (DEPLOY_KEYS) writeFileSync(`${DEPLOY_KEYS}/deploy`, `${created.entry.auth.publicKey}\n`);
        await api(
          s,
          'vaultNetworks.add',
          'POST',
          {
            body: {
              cidr: `${DEPLOY_HOST}/32`,
              ports: [DEPLOY_SSH_PORT, DEPLOY_WEB_PORT],
              note: 'The deploy check',
            },
          },
          { expect: [200, 201, 409] },
        );
        const added = await api<{ serverId: string }>(s, 'vault.addSshServer', 'POST', {
          params: { ...b, entryId: id },
          body: {
            name: 'web-1',
            host: DEPLOY_HOST,
            port: DEPLOY_SSH_PORT,
            username: 'deploy',
            production: true,
          },
        });
        type Checked = {
          outcome?: string;
          hostKey?: { fingerprint: string };
          entry?: { servers?: { check?: unknown; seenHostKey?: { fingerprint: string } | null }[] };
        };
        let checked: Checked = {};
        for (let i = 0; i < 3 && !(checked.hostKey ?? checked.entry?.servers?.[0]?.seenHostKey); i++) {
          if (i) await sleep(10_000);
          checked = await api<Checked>(s, 'vault.checkSshServer', 'POST', {
            params: { ...b, entryId: id, serverId: added.serverId },
          });
        }
        const fp = checked.hostKey?.fingerprint ?? checked.entry?.servers?.[0]?.seenHostKey?.fingerprint;
        if (!fp)
          throw new Error(
            `no host key from web-1: ${checked.outcome ?? '?'} ${JSON.stringify(checked.entry?.servers?.[0]?.check ?? null)}`,
          );
        await api(s, 'vault.trustSshHostKey', 'POST', {
          params: { ...b, entryId: id, serverId: added.serverId },
          body: { fingerprint: fp },
        });
        // Switched on, the key is in the turn's keys of the person's own turns (Whombat HE-43, HE-S154, OP-07).
        await api(s, 'vault.giveKey', 'PUT', { params: { ...b, entryId: id }, body: {} });
        return { entryId: id };
      },
    );
    if (!vault) return { ok: false, steps };
    const url = `http://${DEPLOY_HOST}:${DEPLOY_WEB_PORT}/`;
    const asked = await step('asked the agent to build and deploy', () =>
      api<{ message: { id: string } }>(s, 'messages.send', 'POST', {
        params: { ...b, conversationId: w.conversationId },
        body: {
          text: `Please make our website a single page that says “Hello from ${w.agentName}” with the code ${marker} on it, in the site repository, and put it live on our web server (web-1, in the Vault) so it shows at ${url}. Keep the current version so we can go back.`,
          clientId: marker,
        },
      }),
    );
    if (!asked) return { ok: false, steps };
    const live = await step('the site shows the marker (cards allowed for the task)', async () => {
      const until = Date.now() + DEPLOY_MINUTES * 60_000;
      const startedAt = Date.now();
      let idleFor = 0;
      while (Date.now() < until) {
        const pending = await api<{
          approvals: { number: number; action: { type: string }; title: string }[];
        }>(s, 'approvals.list', 'GET', { params: b, query: { state: 'pending', limit: 20 } }).catch(() => ({
          approvals: [],
        }));
        for (const a of pending.approvals) {
          const scoped = a.action.type === 'run_command';
          const r = await s.call(
            { id: 'approvals.decide', method: 'POST' },
            {
              params: { ...b, number: a.number },
              query: {},
              body: { decision: 'approve', ...(scoped ? { scope: 'task' } : {}) },
            },
          );
          approved.push({ number: a.number, type: a.action.type, title: a.title, status: r.status });
        }
        // The agent stopped (idle for two minutes, nothing waiting for a person) without putting it live: done.
        const agent = await api<{ agent: { status: string } }>(s, 'agent.get', 'GET', { params: b }).catch(
          () => null,
        );
        idleFor = agent?.agent.status === 'idle' && pending.approvals.length === 0 ? idleFor + 1 : 0;
        if (idleFor >= 12 && Date.now() - startedAt > 120_000) break;
        site = await fetch(url)
          .then((r) => r.text())
          .catch((e: unknown) => String(e));
        if (site.includes(marker)) return { url, approvals: approved.length };
        await sleep(10_000);
      }
      throw new Error(`no ${marker} at ${url}: the agent stopped, or ${DEPLOY_MINUTES} minutes passed`);
    });
    // Whatever the agent said, in order, threads included.
    await sleep(live ? 60_000 : 0);
    const transcript = await step('what the agent said', async () => {
      const msgs = await api<{
        messages: {
          id: string;
          authorId: string;
          text: string;
          replyCount?: number;
          card?: { kind: string } | null;
        }[];
      }>(s, 'messages.list', 'GET', {
        params: { ...b, conversationId: w.conversationId },
        query: { limit: 50 },
      });
      const out: string[] = [];
      for (const m of msgs.messages) {
        out.push(`${m.authorId}: ${m.card ? `[${m.card.kind}] ` : ''}${m.text}`);
        if (m.replyCount) {
          type Line = { authorId: string; text: string; card?: { kind: string } | null };
          const th: { replies?: Line[]; messages?: Line[] } = await api<{
            replies?: Line[];
            messages?: Line[];
          }>(s, 'messages.thread', 'GET', {
            params: { ...b, conversationId: w.conversationId, messageId: m.id },
          }).catch(() => ({ messages: [] }));
          for (const r of th.replies ?? th.messages ?? [])
            out.push(`  ↳ ${r.authorId}: ${r.card ? `[${r.card.kind}] ` : ''}${r.text}`);
        }
      }
      return out;
    });
    return { ok: !!live, marker, url, site: site.slice(0, 500), approved, transcript, steps };
  } finally {
    s.close('closed');
  }
}

/** What the deploy check's agent did: its runs' activity, with evidence (inspection after a failed check). */
async function deployInspect(
  st: DevboxState & { deployCheck?: DeployCheckState },
): Promise<Record<string, unknown> & { ok: boolean }> {
  const w = need(st.deployCheck, 'deploy check burrow');
  const identity = deserializeIdentity(
    new Uint8Array(Buffer.from(need(st.endpointKey, 'endpoint key'), 'base64')),
  );
  await session(st);
  if (!st.session) return { ok: false };
  const s = openSession({
    tickets: tickets(st, st.session.token, 'app'),
    identity,
    appliance: { peerId: need(st.peerId, 'peerId') },
    channel: 'app',
  });
  try {
    await whenOpen(s, 60_000);
    const b = { burrow: w.slug };
    const acts = await api<{ activities: Record<string, unknown>[] }>(s, 'activity.list', 'GET', {
      params: b,
      query: { conversationId: w.conversationId, limit: 200 },
    });
    return { ok: true, activities: acts.activities.slice(-60) };
  } finally {
    s.close('closed');
  }
}

const soakMs = Number(process.env.WB_DEVBOX_SOAK_S ?? '0') * 1000;

it(
  `dev box ${task}`,
  async () => {
    const st = loadState();
    if (!st) throw new Error('no DEV box (dev/devbox create)');
    let result: Record<string, unknown>;
    if (task === 'claim') result = { ok: true, ...(await claim(st)) };
    else if (task === 'smoke') result = { ...(await smoke(st)), at: new Date().toISOString() };
    else if (task === 'soak') result = { ...(await soak(st)) };
    else if (task === 'deploy-check') result = { ...(await deployCheck(st)), at: new Date().toISOString() };
    else if (task === 'deploy-inspect') result = { ...(await deployInspect(st)) };
    else if (task === 'ra-check')
      result = {
        ...(await raCheck(
          st,
          out ? (r) => writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`) : undefined,
        )),
      };
    else
      throw new Error(`WB_DEVBOX_TASK must be claim, smoke, soak, deploy-check or ra-check, not “${task}”`);
    if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    expect((result as { ok: boolean }).ok).toBe(true);
  },
  soakMs +
    (task === 'deploy-check'
      ? DEPLOY_MINUTES * 60_000 + 2_400_000
      : task === 'ra-check'
        ? raCheckTimeoutMs()
        : 1_800_000),
);
