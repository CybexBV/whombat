/**
 * Steps of vertical slice B (assignment §13) shared by the slice scenario, later scenarios that need a claimed
 * appliance, and the acceptance demo: sign in (magic link), add the box to the account's Whombat Link with the code on
 * its screen (`link.confirm`, Whombat whombat-link.md LNK-13), claim it on its own page with the four letters on its
 * screen (the app's own `runLocalClaim`: CPace bound to both Noise keys and the box's claim id), save and verify the
 * recovery kit, connect on the app channel. State is kept in `env/slice.json` so later scenarios reuse the claimed
 * owner (a box is claimed once).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { LinkedBox } from '@whombat/control-contracts';
import { generateKeypair } from '@whombat/core/audit';
import {
  pairingFingerprint,
  RECOVERY_ENROLL_PURPOSE,
  RECOVERY_KIT_CONFIRM_PURPOSE,
  signRecoveryStatement,
} from '@whombat/protocol/session';
import { deserializeIdentity, type Identity, serializeIdentity } from '@whombat/secure-channel';
import { envPath } from '../dev/env.ts';
import { sleep } from '../lib/proc.ts';
import {
  type ApplianceSession,
  type ClientOptions,
  newEndpointIdentity,
  openDirectSession,
  openSession,
  type SessionInfo,
  sessionOps,
  whenOpen,
} from './app-client.ts';
import { applianceBox, type Box, claimable, lettersOf, waitForConsole } from './boxes.ts';
import { clientTicket, devices, linkConfirm, linkLookup, linkOrgOf } from './cloud.ts';
import { env, type Persona, persona, ticketSource } from './world.ts';

export interface SliceState {
  deviceId: string;
  peerId: string;
  owner: { email: string; name: string; org: string; accountId: string };
  /** Serialized endpoint identity (libp2p protobuf, base64) of the owner's first endpoint. */
  endpointKey: string;
  endpointId: string;
  recovery: { publicKey: string; secretKey: string; kitId: string; confirmedAt: string };
  claimedAt: string;
  /** What the appliance answered to checks that only fit inside the claim ceremony (recorded, asserted later). */
  probes?: { unconfirmedKit?: UnconfirmedKitProbe };
}

/**
 * `recovery.enroll` with a statement signed by the recovery key that was registered but not yet confirmed (the
 * only moment an appliance has an unconfirmed kit): the contract says `recovery_kit_unverified` (CT-45).
 */
export type UnconfirmedKitProbe =
  | { outcome: 'refused'; status: number; code: string; appCode: string | null; message: string }
  | { outcome: 'enrolled'; detail: unknown };

const FILE = () => envPath('slice.json');

export function loadSlice(): SliceState | null {
  if (!existsSync(FILE())) return null;
  const s = JSON.parse(readFileSync(FILE(), 'utf8')) as SliceState;
  return s.deviceId === env().appliance?.deviceId ? s : null;
}

export function saveSlice(s: SliceState): void {
  writeFileSync(FILE(), `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
}

export function identityOf(s: SliceState): Identity {
  return deserializeIdentity(new Uint8Array(Buffer.from(s.endpointKey, 'base64')));
}

export type Narrate = (step: string, detail?: Record<string, unknown>) => void;

/** What `enroll.claim.local` answers, as far as the scenarios read it. */
export type Enrolled = Record<string, unknown>;

/** The app's claim on the box's own page (`packages/client/src/managed/community.ts`), loaded from its checkout. */
export interface LocalClaimModule {
  runLocalClaim(input: {
    session: ApplianceSession;
    letters: string;
    appliancePeerId: string;
    clientPeerId: string;
    account: { name: string; email: string };
    endpoint: { label: string; platform: 'cli' };
    link?: string | null;
  }): Promise<Enrolled>;
  LocalClaimLettersError: new () => Error;
}

export async function localClaim(): Promise<LocalClaimModule> {
  // @ts-expect-error resolved by the vitest alias to the pinned whombat-app checkout
  return (await import('@app-client/community')) as LocalClaimModule;
}

/**
 * The app's claim through control (`packages/client/src/managed/claim.ts`, AP-47): only a box control registered
 * before Whombat Link is claimed this way (the dev box, `devbox/`); every other box on its own page (`localClaim`).
 */
export interface ClaimCeremonyModule {
  runClaimCeremony(input: {
    session: ApplianceSession;
    claim: { claim: string; device: string };
    request:
      | { method: 'code'; device: string; letters: string }
      | { method: 'card'; device: string; secret: string };
    appliancePeerId: string;
    clientPeerId: string;
    account: { name: string; email: string };
    endpoint: { label: string; platform: 'cli' };
  }): Promise<Enrolled>;
  ClaimMismatchError: new () => Error;
}

export async function claimCeremony(): Promise<ClaimCeremonyModule> {
  // @ts-expect-error resolved by the vitest alias to the pinned whombat-app checkout
  return (await import('@app-client/claim')) as ClaimCeremonyModule;
}

/**
 * The person adds the box to their Whombat Link (LNK-13): the box's screen shows “Open …/link and enter ABCD-EFGH”,
 * they type the code at the account site and confirm, and the box hears within seconds that its Link is on. A box
 * whose Link already runs for this account is left as it is.
 */
export async function linkBox(o: { box: Box; owner: Persona; narrate?: Narrate }): Promise<LinkedBox | null> {
  const say: Narrate = o.narrate ?? (() => {});
  const url = env().control?.url ?? '';
  const shown = await waitForConsole(
    o.box,
    (c) => c.link?.state === 'on' || (c.link?.state === 'starting' && !!c.link.code),
    'a Whombat Link code',
    120_000,
  );
  let linked: LinkedBox | null = null;
  if (shown.link?.state !== 'on') {
    const code = shown.link?.code ?? '';
    say('the box’s screen shows its Whombat Link code and the page to type it at', {
      code,
      page: shown.link?.url,
    });
    const found = await linkLookup(url, o.owner.session.token, code);
    say('the account site finds the box for that code', { name: found.name, firstMonthFree: found.trial });
    linked = await linkConfirm(url, o.owner.session.token, code);
    if (linked.device !== o.box.deviceId)
      throw new Error(`the code on ${o.box.name}'s screen linked ${linked.device}, not ${o.box.deviceId}`);
    say('confirmed: the box is in the account’s Whombat Link', { state: linked.state });
    await waitForConsole(o.box, (c) => c.link?.state === 'on', 'Whombat Link on', 60_000);
    say('the box’s screen no longer asks for the code: its Whombat Link is on');
  }
  // Tickets to the box are asked under the account's Link org from now on.
  const org = await linkOrgOf(url, o.owner.session.token);
  if (!org) throw new Error(`${o.owner.email} has no Whombat Link org after confirming ${o.box.deviceId}`);
  o.owner.org = org;
  return linked;
}

/**
 * An enrollment session to the box as its own page opens it: the direct connection, pinned to the box's PeerId. The
 * page is the box's own (`http://localhost:<port>/` on this machine, its HTTPS address on a real one).
 */
export async function openOwnPage(o: {
  box: Box;
  identity?: Identity;
  onSocket?: Parameters<typeof openDirectSession>[0]['onSocket'];
}): Promise<{ enroll: ApplianceSession; identity: Identity; info: SessionInfo }> {
  const identity = o.identity ?? (await newEndpointIdentity());
  const enroll = openDirectSession({
    url: o.box.directUrl,
    identity,
    appliance: { peerId: o.box.peerId },
    expect: 'any',
    ...(o.onSocket ? { onSocket: o.onSocket } : {}),
  });
  const info = await whenOpen(enroll);
  return { enroll, identity, info };
}

/** The claim through the real client (MA-04 §2–4): Link's code at the account site, then the letters on its page. */
export async function claimAppliance(options: {
  ownerKey: string;
  ownerName: string;
  narrate?: Narrate;
  onSocket?: Parameters<typeof openDirectSession>[0]['onSocket'];
  /** Between registering and confirming the kit, try `recovery.enroll` from a new endpoint (the scenarios). */
  probeUnconfirmedKit?: boolean;
  /** Which box (default: the environment's dev appliance, whose claim is saved as the slice). */
  box?: Box;
}): Promise<{
  state: SliceState;
  owner: Persona;
  claimInfo: SessionInfo;
  enrolled: Enrolled;
}> {
  const say: Narrate = options.narrate ?? (() => {});
  const box = options.box ?? applianceBox();
  const owner = await persona(options.ownerKey, options.ownerName, { fresh: true });
  say('signed in to the cloud account with a magic link from Mailpit', {
    email: owner.email,
    via: owner.via,
  });
  await linkBox({ box, owner, narrate: say });
  const c = await waitForConsole(box, claimable, 'a claim code', 120_000);
  const letters = lettersOf(c.code ?? '');
  say('the box’s screen shows “Claim this Whombat”, its own page and its letters', { letters, url: c.url });
  const {
    enroll,
    identity,
    info: claimInfo,
  } = await openOwnPage({ box, ...(options.onSocket ? { onSocket: options.onSocket } : {}) });
  say('secure session open on the enrollment channel of the box’s own page (Noise XX, PeerId pinned)', {
    channel: claimInfo.channel,
    protocol: claimInfo.protocol,
  });
  const { runLocalClaim } = await localClaim();
  const enrolled = await runLocalClaim({
    session: enroll,
    letters,
    appliancePeerId: box.peerId,
    clientPeerId: identity.peerId,
    account: { name: owner.name, email: owner.email },
    endpoint: { label: 'Harness (owner)', platform: 'cli' },
  });
  say('claimed: the box’s confirmation matches (CPace), your account created, this endpoint enrolled', {
    accountId: enrolled.accountId,
  });
  return finishClaim({
    options,
    box,
    owner,
    enroll,
    identity,
    tickets: ticketSource(owner, box.deviceId),
    claimInfo,
    enrolled,
    say,
  });
}

/** After the claim: the recovery kit (registered, proven), the slice state, control's view of the claim. */
async function finishClaim(o: {
  options: Parameters<typeof claimAppliance>[0];
  box: Box;
  owner: Persona;
  enroll: ApplianceSession;
  identity: Identity;
  tickets: ClientOptions['tickets'];
  claimInfo: SessionInfo;
  enrolled: Enrolled;
  say: Narrate;
}) {
  const { options, box, owner, enroll, identity, claimInfo, enrolled, say } = o;
  const e = env();
  const enrollTickets = o.tickets;
  const card = { deviceId: box.deviceId, peerId: box.peerId };
  // Recovery kit: generated here, public half registered, then proven with a signature (MA-04 §4).
  const recovery = generateKeypair();
  const kit = (await sessionOps.recoveryKitRegister(enroll, recovery.publicKey)) as {
    kitId: string;
    challenge: string;
  };
  let unconfirmedKit: UnconfirmedKitProbe | undefined;
  if (options.probeUnconfirmedKit)
    unconfirmedKit = await probeUnconfirmedKit({
      tickets: enrollTickets,
      peerId: card.peerId,
      accountId: String(enrolled.accountId),
      recoverySecretKey: recovery.secretKey,
    });
  const signature = signRecoveryStatement(
    {
      purpose: RECOVERY_KIT_CONFIRM_PURPOSE,
      appliance: card.peerId,
      kitId: kit.kitId,
      challenge: kit.challenge,
    },
    recovery.secretKey,
  );
  const confirmed = (await sessionOps.recoveryKitConfirm(enroll, { kitId: kit.kitId, signature })) as {
    confirmedAt: string;
  };
  say('recovery kit saved and verified (challenge signed with the recovery key)', { kitId: kit.kitId });
  enroll.close('closed');

  const endpoint = (enrolled.endpoint ?? {}) as { endpointId?: string };
  const state: SliceState = {
    deviceId: card.deviceId,
    peerId: card.peerId,
    owner: { email: owner.email, name: owner.name, org: owner.org, accountId: String(enrolled.accountId) },
    endpointKey: Buffer.from(serializeIdentity(identity)).toString('base64'),
    endpointId: endpoint.endpointId ?? '',
    recovery: {
      publicKey: recovery.publicKey,
      secretKey: recovery.secretKey,
      kitId: kit.kitId,
      confirmedAt: confirmed.confirmedAt,
    },
    claimedAt: new Date().toISOString(),
    ...(unconfirmedKit ? { probes: { unconfirmedKit } } : {}),
  };
  if (!options.box) saveSlice(state);

  // Control holds the box for the account since it confirmed the Link code: it issues app-channel tickets.
  const until = Date.now() + 30_000;
  for (;;) {
    const list = await devices(e.control?.url ?? '', owner.session.token, owner.org);
    const d = list.devices.find((x) => x.device === card.deviceId);
    if (d?.state === 'claimed') break;
    if (Date.now() > until)
      throw new Error(`control doesn’t hold the box for its account (device state ${d?.state ?? 'absent'})`);
    await sleep(300);
  }
  say('control holds the box for the account (its Whombat Link), so the account gets tickets to it');
  return { state, owner, claimInfo, enrolled };
}

/** A recovery statement (CT-45) for `endpoint`, signed with a recovery secret key. */
export function recoveryEnrollInput(o: {
  appliance: string;
  endpoint: string;
  accountId: string;
  recoverySecretKey: string;
  label: string;
}) {
  const statement = {
    purpose: RECOVERY_ENROLL_PURPOSE as typeof RECOVERY_ENROLL_PURPOSE,
    appliance: o.appliance,
    endpoint: o.endpoint,
    accountId: o.accountId,
    issuedAt: new Date().toISOString(),
    nonce: randomBytes(16).toString('hex'),
  };
  return {
    statement,
    signature: signRecoveryStatement(statement, o.recoverySecretKey),
    endpoint: { label: o.label, platform: 'cli' as const },
  };
}

async function probeUnconfirmedKit(o: {
  tickets: ClientOptions['tickets'];
  peerId: string;
  accountId: string;
  recoverySecretKey: string;
}): Promise<UnconfirmedKitProbe> {
  const identity = await newEndpointIdentity();
  const s = openSession({
    tickets: o.tickets,
    identity,
    appliance: { peerId: o.peerId },
    channel: 'enroll',
    expect: 'any',
  });
  try {
    await whenOpen(s);
    const out = await sessionOps.recoveryEnroll(
      s,
      recoveryEnrollInput({
        appliance: o.peerId,
        endpoint: identity.peerId,
        accountId: o.accountId,
        recoverySecretKey: o.recoverySecretKey,
        label: 'Harness (unconfirmed kit)',
      }),
    );
    return { outcome: 'enrolled', detail: out };
  } catch (err) {
    const e = err as { status?: number; code?: string; details?: { code?: string }; message?: string };
    return {
      outcome: 'refused',
      status: e.status ?? 0,
      code: e.code ?? 'error',
      appCode: e.details?.code ?? null,
      message: e.message ?? String(err),
    };
  } finally {
    s.close('closed');
  }
}

/** An app-channel session for the slice owner's endpoint. */
export async function ownerSession(
  s: SliceState,
  extra: Partial<Parameters<typeof openSession>[0]> = {},
): Promise<{ session: ApplianceSession; info: SessionInfo; owner: Persona }> {
  const owner = await persona(s.owner.email.split('@')[0] ?? '', s.owner.name);
  const session = openSession({
    tickets: ticketSource(owner, s.deviceId),
    identity: identityOf(s),
    appliance: { peerId: s.peerId },
    channel: 'app',
    ...extra,
  });
  const info = await whenOpen(session);
  return { session, info, owner };
}

/**
 * Pairs a second endpoint to the owner's account (MA-04 §5a): the new endpoint asks on the enrollment channel and
 * shows a code; the owner's trusted endpoint approves it. Returns the new endpoint's identity and id.
 */
export async function pairSecondEndpoint(
  s: SliceState,
  owner: ApplianceSession,
  label: string,
): Promise<{ identity: Identity; endpointId: string }> {
  const e = env();
  const p = await persona(s.owner.email.split('@')[0] ?? '', s.owner.name);
  const identity = await newEndpointIdentity();
  const enroll = openSession({
    tickets: async (r) => {
      const t = await clientTicket(
        e.control?.url ?? '',
        p.session.token,
        p.org,
        s.deviceId,
        'enroll',
        r.class,
      );
      return { ticket: t.ticket, relayUrl: t.relay.url };
    },
    identity,
    appliance: { peerId: s.peerId },
    channel: 'enroll',
    expect: 'any',
  });
  await whenOpen(enroll);
  const req = (await sessionOps.pairRequest(enroll, {
    endpoint: { label, platform: 'cli' },
  })) as { pairingId: string; code: string };
  // Contracts ≥ 0.5.2 (CT-46): the approver looks the code up and compares the fingerprint the new device shows.
  const found = await lookupPairing(owner, req.code);
  if (found.fingerprint !== pairingFingerprint(identity.peerId))
    throw new Error(`pairing look-up shows another device: ${JSON.stringify(found)}`);
  const approved = (await sessionOps.pairApprove(owner, {
    code: req.code,
    approve: true,
    fingerprint: found.fingerprint,
  })) as {
    state: string;
    endpoint?: { endpointId: string };
  };
  if (approved.state !== 'approved') throw new Error(`pairing not approved: ${JSON.stringify(approved)}`);
  const st = (await sessionOps.pairStatus(enroll, req.pairingId)) as {
    state: string;
    enrolled?: { endpoint: { endpointId: string } };
  };
  enroll.close('closed');
  return { identity, endpointId: st.enrolled?.endpoint.endpointId ?? approved.endpoint?.endpointId ?? '' };
}

export interface PairingLookup {
  pairingId: string;
  label: string;
  platform: string;
  fingerprint: string;
  expiresAt: string;
}

/** `enroll.pair.lookup` on a trusted endpoint (CT-46). */
export async function lookupPairing(owner: ApplianceSession, code: string): Promise<PairingLookup> {
  return (await sessionOps.pairLookup(owner, code)) as unknown as PairingLookup;
}

/**
 * The claimed dev appliance of this environment: the saved slice state, or a claim by the environment's owner
 * persona (one stable persona per appliance, so a retried claim comes from the same org and doesn't compete).
 */
export async function ensureSlice(narrate?: Narrate): Promise<SliceState> {
  const existing = loadSlice();
  if (existing) return existing;
  const device = env().appliance?.deviceId ?? 'unknown';
  return (
    await claimAppliance({
      ownerKey: `owner-${device}`,
      ownerName: 'Ada Owner',
      probeUnconfirmedKit: true,
      ...(narrate ? { narrate } : {}),
    })
  ).state;
}
