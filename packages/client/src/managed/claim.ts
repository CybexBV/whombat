/**
 * Claiming a Whombat (MA-22, CC-01…CC-09, CC-13; AP-47, AP-50): the four letters on the screen of a box found on this
 * network (a code claim works only from the box's own network) or the factory card (typed, or the text of its QR code), the claim ceremony both
 * apps run (`claims.start` → enrollment session → CPace → `enroll.claim` → the appliance's confirmation), and the
 * words for what can go wrong on the way.
 */
import { normalizeLocaleTag } from '@whombat/core/i18n/locale';
import {
  type ClaimConfirmTags,
  claimConfirmEqual,
  claimPakeInitiator,
  claimPakeInitiatorFinish,
  normalizeClaimCode,
} from '@whombat/protocol/claim';
import {
  ClaimBackoffDetails,
  claimCardPassword,
  claimVerifier,
  isClaimSecret,
  LOCALE_MINOR,
  normalizeClaimSecret,
  protocolAtLeast,
} from '@whombat/protocol/session';
import { type EnrolledOutput, OperationError, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import {
  type ApplianceSummary,
  type ClaimStart,
  type ControlApi,
  ControlError,
  devicesAllowedOf,
  type NearbyAppliance,
} from './control';
import { COPY } from './copy';

/* The card ---------------------------------------------------------------------------------------------- */

export interface ClaimCard {
  device: string;
  secret: string;
}

/**
 * The card's QR code (CC-02): the claim link `…/claim#v=1&d=<device>&p=<PeerId>&s=<secret>` it encodes, or the older
 * text `WHOMBAT1:<device>:<fingerprint>:<secret>`. The PeerId and the fingerprint are ignored: the claim PAKE
 * authenticates the box, nobody compares fingerprints any more.
 */
export function parseClaimQr(text: string): ClaimCard | null {
  const t = text.trim();
  const legacy = /^WHOMBAT1:([A-Za-z0-9_-]+):(?:[A-Za-z0-9-]{25,29}:)?([A-Za-z2-7]{26})$/.exec(t);
  if (legacy?.[1] && legacy[2]) return { device: legacy[1], secret: legacy[2] };
  return parseClaimFragment(t);
}

/** `#v=1&d=<device>&s=<secret>` of a claim link (the card's QR code), from a whole URL or its fragment. */
export function parseClaimFragment(urlOrHash: string): ClaimCard | null {
  const at = urlOrHash.indexOf('#');
  if (at < 0) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(urlOrHash.slice(at + 1));
  } catch {
    return null;
  }
  const device = params.get('d') ?? '';
  const secret = params.get('s') ?? '';
  if (params.get('v') !== '1' || !/^[A-Za-z0-9_-]{1,64}$/.test(device)) return null;
  if (!isClaimSecret(normalizeClaimSecret(secret))) return null;
  return { device, secret };
}

/**
 * What control checks at `claims.start` for a card (CT-43): `claimVerifier(device, normalized secret)`, computed here
 * from the card — the secret itself never leaves this device.
 */
export function claimProofOf(card: ClaimCard): string {
  return claimVerifier(card.device, normalizeClaimSecret(card.secret));
}

/* What the person typed ----------------------------------------------------------------------------------- */

/**
 * How this claim is proven (CC-02, CC-05, CC-13): the four letters of a box `claims.nearby` found, or the card.
 */
export type ClaimRequest =
  | { method: 'code'; device: string; letters: string }
  | { method: 'card'; device: string; secret: string };

/**
 * The `claims.start` body of a request: the letters and the card's secret never go to control. `terms`: the appliance
 * terms the person ticked (LC-18, `APPLIANCE_TERMS_VERSION`).
 */
export function claimStartOf(request: ClaimRequest, terms: { version: string }): ClaimStart {
  if (request.method === 'card')
    return { method: 'card', device: request.device, claimProof: claimProofOf(request), terms };
  return { method: 'code', device: request.device, terms };
}

/**
 * The claim PAKE's password (CC-06, CT-66): the four letters for `code`; for `card` the card secret's hash
 * (`claimCardPassword`), which is what the appliance keeps.
 */
export function claimPasswordOf(request: ClaimRequest, device: string): string {
  return request.method === 'card'
    ? claimCardPassword(device, normalizeClaimSecret(request.secret))
    : request.letters;
}

/**
 * The letters as they are typed (CC-01): upper-case, without spaces or dashes. Only formats; `normalizeClaimCode`
 * decides what is valid.
 */
export function formatClaimLettersInput(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '').slice(0, 12);
}

/**
 * Four typed letters for a box found nearby, or null when they aren't four letters of the alphabet (anything else,
 * including a longer code, is “Enter the 4 letters from its screen.”).
 */
export function lettersRequestOf(
  device: string,
  typed: string,
): Extract<ClaimRequest, { method: 'code' }> | null {
  const n = normalizeClaimCode(typed);
  return n.kind === 'letters' ? { method: 'code', device, letters: n.letters } : null;
}

/** `wb-mini-1` as people read it; a self-installed box (the ISO, CC-10) says so. */
export function modelLabel(model: string): string {
  return model === 'self-installed' ? 'Self-installed Whombat' : model;
}

/* Finding the box (CC-09, AP-75) ------------------------------------------------------------------------------ */

/** What `claims.nearby` found, as the claim flow shows it: nothing, the one box, or several to pick from. */
export type NearbyClaimStep =
  | { kind: 'none' }
  | { kind: 'found'; box: NearbyAppliance }
  | { kind: 'pick'; boxes: NearbyAppliance[] };

export function nearbyClaimStep(boxes: readonly NearbyAppliance[]): NearbyClaimStep {
  const [first] = boxes;
  if (!first) return { kind: 'none' };
  return boxes.length === 1 ? { kind: 'found', box: first } : { kind: 'pick', boxes: [...boxes] };
}

/**
 * An organization without Whombats looks for one on this network before it shows the empty list (AP-75), and goes
 * straight to the claim when it finds one; the caller asks once per visit, so going back to the list doesn't bounce
 * into the claim again. Retired
 * Whombats don't count (AP-695): an organization whose every Whombat is retired has none to use.
 */
export function looksNearbyFirst(appliances: readonly ApplianceSummary[] | null): boolean {
  if (appliances === null) return false;
  return appliances.every((a) => a.state === 'retired');
}

/* The ceremony ----------------------------------------------------------------------------------------------- */

/**
 * The appliance answered `enroll.claim` without the confirmation of the box whose code was typed: this device was
 * talking to something else (CC-07). Nothing was pinned.
 */
export class ClaimMismatchError extends Error {
  override name = 'ClaimMismatchError';
  constructor() {
    super('The appliance’s claim confirmation doesn’t match.');
  }
}

export interface ClaimCeremonyInput {
  /** An open enrollment session, pinned to `appliancePeerId`. */
  session: ApplianceSession;
  /** Control's pending claim (`claims.start`). */
  claim: { claim: string; device: string };
  request: ClaimRequest;
  /** The appliance's PeerId as this side's Noise session has it (the pinned remote static key). */
  appliancePeerId: string;
  /** This endpoint's PeerId (this side's Noise static key). */
  clientPeerId: string;
  account: { name: string; email: string };
  endpoint: { label: string; platform: 'web' | 'android' | 'ios' | 'desktop' | 'cli' };
  /** Preferred BCP-47 locale tag; only sent when the box speaks session minor >= LOCALE_MINOR. */
  locale?: string | null;
  randomBytes?: (n: number) => Uint8Array;
}

const cryptoRandom = (n: number) => crypto.getRandomValues(new Uint8Array(n));

function claimLocaleFor(session: ApplianceSession, locale?: string | null): string | undefined {
  const normalized = normalizeLocaleTag(locale);
  if (!normalized) return undefined;
  const st = typeof session.state === 'function' ? session.state() : null;
  const protocol = st?.status === 'open' ? st.info.protocol : null;
  return protocolAtLeast(protocol, LOCALE_MINOR) ? normalized : undefined;
}

/**
 * CPace over the enrollment session (CC-06, CC-07): `enroll.claim.begin` with this side's share, `enroll.claim` with
 * the client tag, then the appliance's tag must match before the result is trusted (`ClaimMismatchError` otherwise).
 */
export async function runClaimCeremony(input: ClaimCeremonyInput): Promise<EnrolledOutput> {
  const { session, claim, request } = input;
  const method = request.method;
  const { share, state } = claimPakeInitiator(
    {
      method,
      password: claimPasswordOf(request, claim.device),
      deviceId: claim.device,
      appliancePeerId: input.appliancePeerId,
      clientPeerId: input.clientPeerId,
      claimId: claim.claim,
    },
    input.randomBytes ?? cryptoRandom,
  );
  const begun = await sessionOps.claimBegin(session, { claimId: claim.claim, method, share });
  let tags: ClaimConfirmTags;
  try {
    tags = claimPakeInitiatorFinish(state, begun.share);
  } catch {
    // A share that isn't a ristretto255 element: whatever answered can't be the box.
    throw new ClaimMismatchError();
  }
  const locale = claimLocaleFor(session, input.locale);
  const out = await sessionOps.claim(session, {
    // Control's claim id: the appliance reports exactly this claim as completed (CT-27).
    claimId: claim.claim,
    method,
    confirm: tags.client,
    account: input.account,
    endpoint: input.endpoint,
    ...(locale ? { locale } : {}),
  });
  if (!claimConfirmEqual(tags.appliance, out.confirm)) throw new ClaimMismatchError();
  return out;
}

export interface ClaimResult {
  device: string;
  /** The PeerId to pin: the one the PAKE bound (CC-06). */
  peerId: string;
  accountId: string;
  output: EnrolledOutput;
}

/**
 * The whole claim: control reserves it, an enrollment session to the PeerId control names opens (its handshake proves
 * the box holds that key), then the ceremony. The caller pins `peerId` only after this resolves (the claim no longer
 * ends with a recovery kit, BX-01); the session is closed either way.
 */
export async function claimAppliance(deps: {
  control: ControlApi;
  orgId: string;
  request: ClaimRequest;
  /** The appliance terms the person agreed to before claiming (LC-18). */
  terms: { version: string };
  openSession: (target: { device: string; peerId: string }) => Promise<ApplianceSession>;
  clientPeerId: string;
  account: { name: string; email: string };
  endpoint: ClaimCeremonyInput['endpoint'];
  locale?: string | null;
  randomBytes?: (n: number) => Uint8Array;
}): Promise<ClaimResult> {
  const { claim } = await deps.control.startClaim({
    orgId: deps.orgId,
    ...claimStartOf(deps.request, deps.terms),
  });
  const session = await deps.openSession({ device: claim.device, peerId: claim.contentPeerId });
  try {
    const output = await runClaimCeremony({
      session,
      claim,
      request: deps.request,
      appliancePeerId: claim.contentPeerId,
      clientPeerId: deps.clientPeerId,
      account: deps.account,
      endpoint: deps.endpoint,
      ...(deps.locale !== undefined ? { locale: deps.locale } : {}),
      ...(deps.randomBytes && { randomBytes: deps.randomBytes }),
    });
    return { device: claim.device, peerId: claim.contentPeerId, accountId: output.accountId, output };
  } finally {
    session.close();
  }
}

/* Words --------------------------------------------------------------------------------------------------- */

export type ClaimErrorKey = keyof typeof COPY.claim.errors;

export function claimErrorKey(error: unknown): ClaimErrorKey {
  if (error instanceof ClaimMismatchError) return 'wrong_appliance';
  if (error instanceof ControlError) {
    if (error.code === 'not_found') return 'not_found';
    if (error.code === 'claim_competing') return 'claim_competing';
    if (error.code === 'already_claimed') return 'already_claimed';
    if (error.code === 'rate_limited') return 'rate_limited';
    if (error.code === 'claim_invalid') return 'claim_invalid';
    if (error.code === 'device_not_nearby') return 'device_not_nearby';
    if (error.code === 'terms_required') return 'terms_required';
    if (error.code === 'self_install_not_allowed') return 'self_install_not_allowed';
    if (error.code === 'devices_allowed_reached') return 'devices_allowed_reached';
    if (error.code === 'billing_setup_required') return 'billing_setup_required';
    if (error.code === 'trial_used_device') return 'trial_used_device';
    // Control answered and said no: never “couldn’t reach”.
    return error.code === 'unavailable' ? 'unavailable' : 'failed';
  }
  if (error instanceof OperationError) {
    const k = error.code as ClaimErrorKey;
    return k in COPY.claim.errors ? k : 'failed';
  }
  const reason = (error as { reason?: string } | undefined)?.reason;
  if (reason === 'identity_mismatch') return 'wrong_appliance';
  if (reason === 'appliance_offline') return 'offline';
  return 'failed';
}

/** Minutes until `retryAt` (at least 1), from a `claim_backoff` refusal's details. */
export function claimBackoffMinutes(error: unknown, now: number = Date.now()): number | null {
  if (!(error instanceof OperationError) || error.code !== 'claim_backoff') return null;
  const d = ClaimBackoffDetails.safeParse(error.details);
  if (!d.success) return null;
  return Math.max(1, Math.ceil((Date.parse(d.data.retryAt) - now) / 60_000));
}

/**
 * What to tell the person (CC-09). `device_not_nearby` has no words of its own: the screen says it couldn't find the
 * Whombat and offers to look again (CC-13).
 */
export function claimErrorText(error: unknown, method: 'code' | 'card', now: number = Date.now()): string {
  const e = COPY.claim.errors;
  const key = claimErrorKey(error);
  switch (key) {
    case 'claim_backoff':
      return e.claim_backoff(claimBackoffMinutes(error, now) ?? 1);
    case 'claim_invalid':
      return method === 'code' ? e.claim_invalid : e.claim_invalid_card;
    case 'wrong_appliance':
      return method === 'code' ? e.wrong_appliance : e.wrong_appliance_card;
    case 'claim_not_ready':
      return method === 'code' ? e.claim_not_ready : e.claim_not_ready_card;
    case 'devices_allowed_reached': {
      const n = devicesAllowedOf(error);
      return n === null ? e.devices_allowed_reached : e.devices_allowed(n);
    }
    default: {
      const text = e[key];
      return typeof text === 'string' ? text : e.failed;
    }
  }
}

/** `claims.start` refused a nearby box: it isn't on this network (any more), so look again (CC-13). */
export function isNotNearby(error: unknown): boolean {
  return error instanceof ControlError && error.code === 'device_not_nearby';
}
