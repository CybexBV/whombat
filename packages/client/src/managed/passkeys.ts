import { KIT_PRF_SALT_V2, KIT_PRF_SALT_V2_B64 } from '@whombat/core/backup';
/**
 * Shared passkey ceremonies for web and phone. The client checks endpoint-bound challenges before signing and verifies
 * the owner-signed appliance directory against the authenticator's user handle before pinning any identity. Each
 * appliance still verifies and authorizes access itself. Legacy per-appliance passkeys continue to work.
 * Registration keeps existing access while a new credential and encrypted owner identity are saved. PRF output and
 * the decrypted owner seed stay on this device; each appliance receives only its own derived backup key.
 */
import {
  type EndpointPlatform,
  newPasskeyOwner,
  type OwnerPasskeyRecord,
  openPasskeyOwner,
  ownerPublicKey,
  PASSKEY_ENROLL_PURPOSE,
  type PasskeySummary,
  parsePasskeyUserHandle,
  passkeyEnrollChallengeBase64url,
  passkeyLinkChallenge,
  passkeyRegisterChallengeBase64url,
  passkeyUserHandleBase64url,
  sealPasskeyOwner,
  signOwnerPasskey,
  verifyOwnerPasskey,
  type WebAuthnAuthenticationResponse,
  type WebAuthnRegistrationResponse,
} from '@whombat/protocol/session';
import { OperationError, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import { type ApplianceSummary, type ControlApi, ControlError, type ControlSession } from './control';
import {
  type BackupArming,
  backupKeyInput,
  confirmPasskeyBackupCheck,
  holdBackupKey,
  preparePasskeyBackupCheck,
  prfOutputOf,
  prfRefused,
  withBackupPrf,
  withoutPrfResults,
} from './passkey-backup-key';
import { pinnedRecord, trustDecision } from './pin';
import type { ApplianceRegistry, KnownAppliance, SyncStorage } from './registry';
import { isRetired } from './retired';

/* WebAuthn as JSON ------------------------------------------------------------------------------------------- */

export interface PasskeyCredentialDescriptorJSON {
  id: string;
  type: 'public-key';
  transports?: string[];
}

/** `PublicKeyCredentialCreationOptionsJSON` (WebAuthn L3; what control's `@simplewebauthn` options are). */
export interface PasskeyCreationOptionsJSON {
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  timeout?: number;
  excludeCredentials?: PasskeyCredentialDescriptorJSON[];
  authenticatorSelection?: {
    authenticatorAttachment?: string;
    residentKey?: string;
    requireResidentKey?: boolean;
    userVerification?: string;
  };
  attestation?: string;
  hints?: string[];
  extensions?: Record<string, unknown>;
}

/** `PublicKeyCredentialRequestOptionsJSON`. */
export interface PasskeyRequestOptionsJSON {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: PasskeyCredentialDescriptorJSON[];
  userVerification?: string;
  hints?: string[];
  extensions?: Record<string, unknown>;
}

export type PasskeyRegistrationJSON = WebAuthnRegistrationResponse;
export type PasskeyAssertionJSON = WebAuthnAuthenticationResponse;

/* What browsers and passkey providers hand back, in the contracts' strict shape (AP-805) ---------------------------- */

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Base64url without padding from what a provider wrote: standard base64, padded or not, is the same bytes. */
export function canonicalBase64url(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return v || undefined;
}

const attachmentOf = (v: unknown): 'platform' | 'cross-platform' | null =>
  v === 'platform' || v === 'cross-platform' ? v : null;

/**
 * Extension outputs as plain JSON (a provider's may hold buffers or be missing); nothing here is read anyway. The PRF's
 * results never stay in it: they are the secret behind the backup key and go nowhere (Whombat backup-passkey.md).
 */
function extensionsOf(v: unknown): Record<string, unknown> {
  if (!isObject(v)) return {};
  try {
    const plain: unknown = JSON.parse(JSON.stringify(v));
    return isObject(plain) ? withoutPrfResults(plain) : {};
  } catch {
    return {};
  }
}

/**
 * An assertion as the Whombat's strict `enroll.passkey` input takes it (AP-805). Password-manager extensions and some
 * browsers hand back JSON that control's verifier accepts but the contract doesn't: padded or standard base64, no
 * `clientExtensionResults`, an `authenticatorAttachment` outside the two values, a `null` user handle. The bytes are
 * the same, so the signature still verifies.
 */
export function canonicalAssertion(raw: unknown): PasskeyAssertionJSON {
  const r = isObject(raw) ? raw : {};
  const res = isObject(r.response) ? r.response : {};
  const id = canonicalBase64url(r.rawId) ?? canonicalBase64url(r.id) ?? '';
  const userHandle = canonicalBase64url(res.userHandle);
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {
      clientDataJSON: canonicalBase64url(res.clientDataJSON) ?? '',
      authenticatorData: canonicalBase64url(res.authenticatorData) ?? '',
      signature: canonicalBase64url(res.signature) ?? '',
      ...(userHandle && { userHandle }),
    },
    clientExtensionResults: extensionsOf(r.clientExtensionResults),
    ...(attachmentOf(r.authenticatorAttachment) && {
      authenticatorAttachment: attachmentOf(r.authenticatorAttachment),
    }),
  };
}

/** A registration as `passkey.register` takes it (AP-805): the same normalisation. */
export function canonicalRegistration(raw: unknown): PasskeyRegistrationJSON {
  const r = isObject(raw) ? raw : {};
  const res = isObject(r.response) ? r.response : {};
  const id = canonicalBase64url(r.rawId) ?? canonicalBase64url(r.id) ?? '';
  const authenticatorData = canonicalBase64url(res.authenticatorData);
  const publicKey = canonicalBase64url(res.publicKey);
  const transports = Array.isArray(res.transports)
    ? res.transports.filter(
        (t): t is string => typeof t === 'string' && /^[a-z][a-z-]*$/.test(t) && t.length <= 32,
      )
    : undefined;
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {
      clientDataJSON: canonicalBase64url(res.clientDataJSON) ?? '',
      attestationObject: canonicalBase64url(res.attestationObject) ?? '',
      ...(authenticatorData && { authenticatorData }),
      ...(transports && { transports: transports.slice(0, 16) }),
      ...(Number.isInteger(res.publicKeyAlgorithm) && {
        publicKeyAlgorithm: res.publicKeyAlgorithm as number,
      }),
      ...(publicKey && { publicKey }),
    },
    clientExtensionResults: extensionsOf(r.clientExtensionResults),
    ...(attachmentOf(r.authenticatorAttachment) && {
      authenticatorAttachment: attachmentOf(r.authenticatorAttachment),
    }),
  };
}

/**
 * What a platform does with passkeys. Implementations throw `PasskeyCancelled` when the person dismissed the
 * prompt (or it was aborted), and `PasskeyError` for anything they recognize (`exists`, `unsupported`).
 */
export interface PasskeyPlatform {
  /** A platform authenticator with user verification (or a passkey manager) is there. */
  isAvailable(): Promise<boolean>;
  /** Passkeys can be offered in the email field's autofill (conditional mediation, web only). */
  supportsConditional(): Promise<boolean>;
  create(options: PasskeyCreationOptionsJSON): Promise<PasskeyRegistrationJSON>;
  get(
    options: PasskeyRequestOptionsJSON,
    request?: { conditional?: boolean; signal?: AbortSignal },
  ): Promise<PasskeyAssertionJSON>;
  /**
   * Tells the browser or phone that this passkey opens nothing any more, so it stops offering it (WebAuthn's
   * `signalUnknownCredential`). Resolves quietly where the platform can't; never shows anything.
   */
  forget?(credentialId: string): Promise<void>;
  /**
   * Tells it which passkeys for `userId` (base64url) still work; it hides the others (`signalAllAcceptedCredentials`).
   * Resolves quietly where the platform can't.
   */
  keepOnly?(userId: string, credentialIds: readonly string[]): Promise<void>;
  /**
   * The WebAuthn PRF output of one of `credentialIds` for `salt` (Whombat backup-options.md: it locks the recovery
   * kit), with which passkey answered. Null where the passkey or its manager doesn't offer PRF; `PasskeyCancelled`
   * when the person dismissed the prompt.
   */
  prf?(input: { credentialIds: readonly string[]; salt: Uint8Array }): Promise<{
    credentialId: string;
    output: Uint8Array | null;
    /** The passkey's user handle (base64url), where the platform says it: it names the Whombat it was made for. */
    userHandle?: string;
  } | null>;
}

/** A platform's signal, never in the way: what it couldn't do changes nothing here. */
async function quietly(signal: Promise<void> | undefined): Promise<void> {
  try {
    await signal;
  } catch {
    // The browser or phone keeps offering it; signing in still says why it can't open anything.
  }
}

/**
 * Settings · Devices tells the browser or phone which of the person's passkeys this Whombat still takes, so one
 * removed elsewhere stops being offered here too.
 */
export function keepOnlyLivePasskeys(
  platform: Pick<PasskeyPlatform, 'keepOnly'> | null | undefined,
  input: { appliance: string; accountId: string | null; passkeys: readonly PasskeySummary[] },
): Promise<void> {
  if (!platform?.keepOnly || !input.accountId) return Promise.resolve();
  const mine = input.passkeys
    .filter((p) => p.accountId === input.accountId && !p.ownerHandle)
    .map((p) => p.id);
  return quietly(platform.keepOnly(passkeyUserHandleBase64url(input.appliance), mine));
}

/** The person dismissed the passkey prompt (or it was aborted): nothing to say, nothing changed. */
export class PasskeyCancelled extends Error {
  override name = 'PasskeyCancelled';
  /** `cause`: the platform's own error, when there was one (the box's log names it). */
  constructor(options?: ErrorOptions) {
    super('The passkey prompt was dismissed.', options);
  }
}

export type PasskeyErrorCode =
  /** The challenge control sent isn't the one this device computes (PK-03): nothing was signed. */
  | 'challenge_mismatch'
  /** Control's registration options don't match what the Whombat began (user, RP ID, challenge). */
  | 'options_mismatch'
  /** The passkey didn't verify (removed, its account gone, …: one reason for all, PK-05). */
  | 'invalid'
  /** This Whombat takes only passkeys that stay on one device, and this one syncs (PK-07). */
  | 'not_allowed'
  /** 20 passkeys for this Whombat already (`passkey_limit`). */
  | 'limit'
  /** This authenticator already holds a passkey for this Whombat (`excludeCredentials`, or `conflict`). */
  | 'exists'
  /** Passkeys can't be used here (no authenticator, another RP ID, …). */
  | 'unsupported'
  /** This device holds no passkey for any Whombat of this site (Android's `NoCredentialException`). */
  | 'none'
  /** The passkey's Whombat is gone (retired or released), so control no longer knows it (`passkey_unknown`). */
  | 'gone'
  /**
   * The passkey's Whombat is gone, but control keeps the passkey because it locks that Whombat's recovery kit
   * (`passkey_kept_for_kit`): it doesn't sign in, and the platform must not forget it.
   */
  | 'kept'
  /** The Whombat saved it, control didn't (twice): removed again on the Whombat (PK-06). */
  | 'control_failed'
  | 'rate_limited'
  | 'unreachable'
  | 'failed';

export class PasskeyError extends Error {
  override name = 'PasskeyError';
  /** `cause`: the platform's own error, when there was one (the box's log names it). */
  constructor(
    readonly code: PasskeyErrorCode,
    message: string = code,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * The Whombat's precise reason: `details.code` (`forbidden` + `passkey_invalid`, `conflict` + `passkey_limit`, Whombat
 * PK-D03/PK-D04), else the code itself.
 */
export function operationReason(error: OperationError): string {
  const detail = (error.details as { code?: unknown } | null | undefined)?.code;
  return typeof detail === 'string' ? detail : error.code;
}

/** What a failure of these flows is, in this module's words; null for a dismissed prompt (said nowhere). */
export function passkeyErrorOf(error: unknown): PasskeyErrorCode | null {
  if (error instanceof PasskeyCancelled) return null;
  if (error instanceof PasskeyError) return error.code;
  if (error instanceof OperationError)
    switch (operationReason(error)) {
      case 'passkey_invalid':
        return 'invalid';
      case 'passkey_not_allowed':
        return 'not_allowed';
      case 'passkey_limit':
        return 'limit';
      case 'passkey_exists':
      case 'conflict':
        return 'exists';
      case 'rate_limited':
        return 'rate_limited';
      case 'unknown_op':
        return 'unsupported';
      default:
        return 'failed';
    }
  if (error instanceof ControlError) {
    if (error.reason === 'passkey_unknown') return 'gone';
    if (error.reason === 'passkey_kept_for_kit') return 'kept';
    switch (error.code) {
      case 'passkey_invalid':
      case 'signed_out':
        return 'invalid';
      case 'passkey_limit':
        return 'limit';
      case 'rate_limited':
        return 'rate_limited';
      case 'unavailable':
        return 'unreachable';
      default:
        return 'failed';
    }
  }
  return 'failed';
}

/** A failure as a log line: the operation's code and reason, or the error's name and message (no input, no keys). */
export function passkeyFailureDetail(error: unknown): string {
  if (error instanceof OperationError)
    return `${error.op}: ${error.status} ${error.code}${operationReason(error) !== error.code ? ` (${operationReason(error)})` : ''}: ${error.message}`;
  if (error instanceof ControlError) return `control: ${error.code}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message.slice(0, 500)}`;
  return String(error).slice(0, 200);
}

/** Words for a failure (`COPY.passkeys.errors`); null for a dismissed prompt. */
export function passkeyErrorText(error: unknown): string | null {
  const code = passkeyErrorOf(error);
  return code ? PASSKEY_COPY.errors[code] : null;
}

/* Words (no mock: the design handoff's conventions, decided in passkeys.md AP-797) --------------------------------- */

export const PASSKEY_COPY = {
  signIn: 'Sign in with a passkey',
  signInHint: 'Your passkey signs you in, opens your Whombats and unlocks your backups.',
  or: 'or',
  opening: (name: string | null) => `Opening ${name ?? 'your Whombat'}…`,
  openingText: 'Your Whombat is checking your passkey. This takes a moment.',
  /** The setup screen (PK-04 from a signed-in device that doesn't know the Whombat yet). */
  setupWay: 'Your passkey, if you’ve already set it up.',
  setupUse: 'Use a passkey',
  /** The enrollment didn't happen: the way on (PK-11). */
  otherWay: 'Set up this device another way',
  notInOrg:
    'This passkey is for a Whombat that isn’t in your organization. You’re signed in; pick a Whombat.',
  retired: (name: string | null) =>
    `That passkey was for ${name ?? 'a Whombat'}, which was retired, so it can’t open anything. Pick your Whombat; once it opens, you can add a new passkey.`,
  /** Settings · Devices (PK-08). */
  section: 'PASSKEYS',
  intro: 'One passkey to sign in, open all your Whombats and unlock your backups.',
  none: 'Set up your passkey',
  add: 'Set up my passkey',
  remove: 'Remove',
  removed: 'Passkey removed.',
  removeConfirm: (name: string) =>
    `Remove the passkey “${name}”? It won’t open this Whombat any more. Devices it already set up stay until you remove them.`,
  synced: 'Synced',
  syncedLabel: 'Synced: it can open this Whombat on your other devices too',
  thisDevice: 'On one device',
  thisDeviceLabel: 'Stays on the device it was made on',
  created: (date: string) => `Added ${date}`,
  lastUsed: (ago: string) => `Last used ${ago}`,
  neverUsed: 'Not used yet',
  current: 'Set up this device',
  policy: 'Only passkeys that stay on one device',
  policyMeta:
    'Synced passkeys (Google Password Manager, iCloud Keychain) can’t be added or open this Whombat on a new device.',
  policyOn: 'Only passkeys that stay on one device are accepted now.',
  policyOff: 'Synced passkeys are accepted again.',
  unavailable: 'This browser can’t make passkeys.',
  unavailablePhone: 'This phone can’t make passkeys.',
  loadError: 'Couldn’t load your passkeys. Try again.',
  /** PK-09: a device a passkey let in lately, told on the person's other devices. */
  newDevice: (label: string) => `New device signed in with a passkey: ${label}`,
  newDeviceMeta: 'Signed in with a passkey',
  review: 'Review',
  seen: 'OK',
  /** The nudge (PK-10). */
  nudge: 'One passkey to sign in, open all your Whombats and unlock your backups.',
  nudgeAdd: 'Set up my passkey',
  nudgeLater: 'Not now',
  errors: {
    challenge_mismatch:
      'Whombat’s servers sent a sign-in request this device didn’t expect, so nothing was signed. Try again.',
    options_mismatch:
      'Whombat’s servers sent a passkey request that doesn’t match your Whombat, so no passkey was made. Try again.',
    invalid:
      'That passkey didn’t open your Whombat. It may have been removed. Sign in with your email instead.',
    gone: 'That passkey was for a Whombat that’s gone, so it can’t open anything. Sign in with your email; once your Whombat opens, you can add a new passkey.',
    kept: 'That passkey was for a Whombat that’s gone. It’s kept only to open that Whombat’s recovery kit. Sign in with your email.',
    not_allowed:
      'This Whombat only accepts passkeys that stay on one device, and this one syncs. Use another way in.',
    limit: 'You already have 20 passkeys for this Whombat. Remove one in Settings → Devices first.',
    exists: 'This device already has a passkey for this Whombat.',
    unsupported: 'Passkeys don’t work here. Sign in with your email instead.',
    none: 'There’s no passkey for your Whombat on this device. Sign in another way, then add one in Devices.',
    control_failed:
      'Your Whombat saved the passkey but Whombat’s servers didn’t, so it was removed again. Try again in a moment.',
    rate_limited: 'Too many tries. Wait a few minutes, then try again.',
    unreachable: 'Couldn’t reach Whombat. Check your connection and try again.',
    failed: 'That didn’t work. Try again.',
  } satisfies Record<PasskeyErrorCode, string>,
} as const;

/* Sign-in on a new device (PK-04) -------------------------------------------------------------------------------- */

/** Control's options for this device's key, with the challenge checked (`preparePasskeySignIn`). */
export interface PreparedPasskeySignIn {
  challengeId: string;
  nonce: string;
  endpoint: string;
  options: PasskeyRequestOptionsJSON;
  /** Epoch ms: old ones are asked for again (control keeps a challenge for a few minutes). */
  at: number;
}

/** How long prepared options are used before new ones are asked for. */
export const PASSKEY_PREPARED_MS = 2 * 60_000;

/**
 * Control's sign-in options for this device's key (`endpoint`, its PeerId), refused unless the challenge is exactly
 * `passkeyEnrollChallenge({nonce, endpoint})`: the assertion then can enroll this device's key and no other (PK-03).
 */
export async function preparePasskeySignIn(
  control: Pick<ControlApi, 'passkeyAuthenticateOptions'>,
  endpoint: string,
  now: () => number = Date.now,
): Promise<PreparedPasskeySignIn> {
  const r = await control.passkeyAuthenticateOptions(endpoint);
  const options = r.options as unknown as PasskeyRequestOptionsJSON;
  if (!r.nonce || typeof options?.challenge !== 'string')
    throw new PasskeyError('challenge_mismatch', 'Control sent no nonce for this device.');
  let expected: string;
  try {
    expected = passkeyEnrollChallengeBase64url({ nonce: r.nonce, endpoint });
  } catch {
    throw new PasskeyError('challenge_mismatch', 'Control sent a malformed nonce.');
  }
  if (options.challenge !== expected)
    throw new PasskeyError(
      'challenge_mismatch',
      `The challenge isn't ${PASSKEY_ENROLL_PURPOSE} for this device.`,
    );
  // A Whombat passkey is discoverable and verified: never a list of credentials control chose, always UV.
  const { allowCredentials: _ignored, ...rest } = options;
  return {
    challengeId: r.challengeId,
    nonce: r.nonce,
    endpoint,
    options: { ...rest, userVerification: 'required' },
    at: now(),
  };
}

export type PasskeySignInStep = 'signing_in' | 'opening';

export interface PasskeySignInDeps {
  control: Pick<
    ControlApi,
    'passkeyAuthenticateOptions' | 'passkeyAuthenticateVerify' | 'appliances' | 'deletePasskey'
  > &
    Partial<Pick<ControlApi, 'passkeys'>>;
  platform: PasskeyPlatform;
  /** This device: its key's PeerId, and what the Whombat lists it as. */
  endpoint: { peerId: string; label: string; platform: EndpointPlatform };
  /** This device's records for a cloud account (the web's local storage, the phone's file). */
  registryFor(accountId: string): ApplianceRegistry;
  /** An enrollment-channel session pinned to `peerId`, once its handshake is done. */
  openEnroll(target: { orgId: string; device: string; peerId: string }): Promise<ApplianceSession>;
  /** What the screen says while it works. */
  onStep?(step: PasskeySignInStep, appliance?: { name: string | null }): void;
  now?: () => number;
}

export type PasskeySignInOutcome =
  /** The passkey names no Whombat (an account-level passkey, PK-11): signed in to the cloud account only. */
  | { kind: 'signed_in'; session: ControlSession }
  /** The Whombat isn't in the directory of the session's organizations. */
  | { kind: 'not_in_org'; session: ControlSession }
  | { kind: 'retired'; session: ControlSession; name: string | null }
  /** This device's pin differs from the directory: the hard stop (AP-64), nothing was sent. */
  | { kind: 'changed'; session: ControlSession; device: string }
  /** Let in (just now, or before): open it. It is the registry's last used. */
  | { kind: 'open'; session: ControlSession; known: KnownAppliance; enrolled: boolean }
  /**
   * Pinned from the passkey, but not let in: the runtime refused (`reason`). The person sets this device up another
   * way (pairing with the pin, AP-64).
   */
  | {
      kind: 'setup';
      session: ControlSession;
      known: KnownAppliance;
      reason: PasskeyErrorCode;
    };

/**
 * PK-04 steps 2–6 (step 1, the endpoint key, is the caller's). Throws (`PasskeyCancelled`, `PasskeyError`,
 * `ControlError`) only before control's session exists; afterwards every way it ends is an outcome carrying the
 * session, which the caller keeps (the token is stored already).
 */
export async function passkeySignIn(
  deps: PasskeySignInDeps,
  request: { prepared?: PreparedPasskeySignIn | null; conditional?: boolean; signal?: AbortSignal } = {},
): Promise<PasskeySignInOutcome> {
  const now = deps.now ?? Date.now;
  const fresh =
    request.prepared &&
    request.prepared.endpoint === deps.endpoint.peerId &&
    now() - request.prepared.at < PASSKEY_PREPARED_MS
      ? request.prepared
      : null;
  const prepared = fresh ?? (await preparePasskeySignIn(deps.control, deps.endpoint.peerId, now));
  // The same touch asks for the backup key's PRF output (Whombat backup-passkey.md); it stays on this device.
  const raw = await deps.platform.get(withBackupPrf(prepared.options), {
    ...(request.conditional && { conditional: true }),
    ...(request.signal && { signal: request.signal }),
  });
  const prf = prfOutputOf(raw);
  const response = canonicalAssertion(raw);
  deps.onStep?.('signing_in');
  let session: ControlSession;
  try {
    session = await deps.control.passkeyAuthenticateVerify(prepared.challengeId, response);
  } catch (error) {
    // Control doesn't know it: its Whombat is gone. The browser or phone stops offering it.
    if (passkeyErrorOf(error) === 'gone') {
      await quietly(deps.platform.forget?.(response.id));
      throw new PasskeyError('gone');
    }
    throw error;
  }
  const handle = response.response.userHandle;
  if (handle && ownerPublicKey(handle)) {
    try {
      const listed = await deps.control.passkeys?.();
      const record = verifyOwnerPasskey(listed?.find((p) => p.id === response.id)?.owner, handle);
      if (!record || record.credentialId !== response.id) throw new PasskeyError('options_mismatch');
      const registry = deps.registryFor(session.account.accountId);
      const last = registry.get(registry.lastUsed() ?? '')?.peerId;
      const peers = [...record.appliances].sort((a, b) => Number(b === last) - Number(a === last));
      const outcomes: PasskeySignInOutcome[] = new Array(peers.length);
      const directories = new Map<string, Promise<ApplianceSummary[]>>();
      const sharedDeps = {
        ...deps,
        control: {
          ...deps.control,
          appliances: (orgId: string) => {
            let pending = directories.get(orgId);
            if (!pending) {
              pending = deps.control.appliances(orgId);
              directories.set(orgId, pending);
            }
            return pending;
          },
        },
      };
      let next = 0;
      // An offline Whombat must not keep the others from checking this sign-in.
      await Promise.all(
        Array.from({ length: Math.min(4, peers.length) }, async () => {
          while (next < peers.length) {
            const index = next++;
            const peer = peers[index];
            if (peer === undefined) return;
            const outcome = await openWithPasskey(sharedDeps, session, peer, prepared, response, true);
            if (prf && outcome.kind === 'open')
              holdBackupKey(outcome.known.device, backupKeyInput(response.id, prf.slice(), peer));
            outcomes[index] = outcome;
          }
        }),
      );
      const opened = outcomes.find((o) => o.kind === 'open');
      if (opened?.kind === 'open') registry.setLastUsed(opened.known.device);
      return peers.length > 1 && opened
        ? { kind: 'signed_in', session }
        : (opened ?? outcomes[0] ?? { kind: 'signed_in', session });
    } finally {
      prf?.fill(0);
    }
  }
  const named = response.response.userHandle ? parsePasskeyUserHandle(response.response.userHandle) : null;
  if (!named) {
    prf?.fill(0);
    return { kind: 'signed_in', session };
  }
  const outcome = await openWithPasskey(deps, session, named, prepared, response);
  // Opened: the Whombat gets its backup key once the app opens it (`deliverBackupKey`).
  if (prf && outcome.kind === 'open')
    holdBackupKey(outcome.known.device, backupKeyInput(response.id, prf, named));
  else prf?.fill(0);
  return outcome;
}

/** A directory entry of one of the session's organizations: by this device's record for `named`, else by identity. */
async function findAppliance(
  control: Pick<ControlApi, 'appliances'>,
  session: ControlSession,
  registry: ApplianceRegistry,
  named: string,
): Promise<ApplianceSummary | null> {
  const known = registry.list().find((a) => a.peerId === named);
  for (const org of session.orgs) {
    let list: ApplianceSummary[];
    try {
      list = await control.appliances(org.orgId);
    } catch {
      continue;
    }
    const entry = known
      ? list.find((a) => a.device === known.device)
      : list.find((a) => a.contentPeerId === named);
    if (entry) return entry;
  }
  return null;
}

async function openWithPasskey(
  deps: PasskeySignInDeps,
  session: ControlSession,
  named: string,
  prepared: PreparedPasskeySignIn,
  response: PasskeyAssertionJSON,
  shared = false,
): Promise<PasskeySignInOutcome> {
  const registry = deps.registryFor(session.account.accountId);
  const entry = await findAppliance(deps.control, session, registry, named);
  if (!entry?.orgId) return { kind: 'not_in_org', session };
  if (isRetired(entry)) {
    // A control from before passkeys went with their Whombat still signed in with it: forget it on both sides.
    if (!shared) {
      await quietly(deps.platform.keepOnly?.(passkeyUserHandleBase64url(named), []));
      await quietly(deps.control.deletePasskey(response.id));
    }
    return { kind: 'retired', session, name: entry.name };
  }
  const pinned = registry.get(entry.device) ?? null;
  // The passkey names the Whombat (its `userHandle`, PK-01): a party that already trusts it, as a link or a kit does.
  const decision = trustDecision({ pinned: pinned?.peerId ?? null, named, directory: entry.contentPeerId });
  if (decision.kind === 'changed') return { kind: 'changed', session, device: entry.device };
  // The directory names another identity than the passkey: the same hard stop, before anything is sent.
  if (decision.kind !== 'pin') return { kind: 'changed', session, device: entry.device };
  const known: KnownAppliance =
    pinned && !decision.isNew
      ? { ...pinned, name: entry.name ?? pinned.name }
      : pinnedRecord({
          device: entry.device,
          orgId: entry.orgId,
          name: entry.name,
          peerId: decision.peerId,
          source: 'passkey',
        });
  registry.put(known);
  if (known.enrolled) {
    registry.setLastUsed(known.device);
    return { kind: 'open', session, known, enrolled: false };
  }
  deps.onStep?.('opening', { name: known.name });
  let enroll: ApplianceSession | null = null;
  try {
    enroll = await deps.openEnroll({ orgId: known.orgId, device: known.device, peerId: known.peerId });
    const enrolled = await sessionOps.enrollPasskey(enroll, {
      nonce: prepared.nonce,
      response,
      endpoint: { label: deps.endpoint.label, platform: deps.endpoint.platform },
    });
    const done: KnownAppliance = { ...known, enrolled: true, accountId: enrolled.accountId };
    registry.put(done);
    registry.setLastUsed(done.device);
    return { kind: 'open', session, known: done, enrolled: true };
  } catch (error) {
    // This key is let in there already (Whombat PK-D04): just open it (PK-11).
    if (error instanceof OperationError && operationReason(error) === 'endpoint_enrolled') {
      const done: KnownAppliance = { ...known, enrolled: true };
      registry.put(done);
      registry.setLastUsed(done.device);
      return { kind: 'open', session, known: done, enrolled: false };
    }
    const reason = passkeyErrorOf(error) ?? 'failed';
    // What “That didn’t work” was underneath, for whoever looks next time (no secrets: codes and messages only).
    if (reason === 'failed')
      console.warn('passkey: setting this device up failed', passkeyFailureDetail(error));
    return { kind: 'setup', session, known, reason };
  } finally {
    enroll?.close();
  }
}

/* Registering (PK-06) ---------------------------------------------------------------------------------------- */

export type PasskeyRegisterControl = Pick<ControlApi, 'passkeyRegisterOptions' | 'passkeyRegisterVerify'> &
  Partial<Pick<ControlApi, 'passkeys' | 'putPasskeyOwner'>>;

export interface PasskeyRegisterDeps {
  /** The app-channel session of an enrolled device. */
  session: ApplianceSession;
  control: PasskeyRegisterControl;
  platform: PasskeyPlatform;
  /** The Whombat's pinned PeerId. */
  appliance: string;
  /** What the passkey is called (“Chrome on Linux”, the device label). */
  name: string;
  /** Reuse this shared credential when setting up several Whombats in one action. */
  credentialId?: string;
  /** Verify recovery with the linking evaluation; an existing owner envelope proves its PRF is reproducible. */
  verifyBackups?: boolean;
  onPrompt?: (step: PasskeySetupStep) => void;
}

export type PasskeySetupStep = 'create' | 'unlock' | 'link' | 'link-and-verify' | 'verify';
type RegisteredPasskey = PasskeySummary & { backups: BackupArming; backupsVerified?: boolean };

/** Options as control gave them, checked against the Whombat's begin, with the Whombat's own exclusions added. */
export function registrationOptionsFor(input: {
  options: unknown;
  controlNonce: string;
  begin: { applianceNonce: string; rpId: string; user: { id: string }; excludeCredentialIds: string[] };
  appliance: string;
}): PasskeyCreationOptionsJSON {
  const options = input.options as PasskeyCreationOptionsJSON;
  const expected = passkeyRegisterChallengeBase64url({
    controlNonce: input.controlNonce,
    applianceNonce: input.begin.applianceNonce,
    appliance: input.appliance,
  });
  if (
    !options ||
    options.challenge !== expected ||
    options.user?.id !== input.begin.user.id ||
    (options.rp?.id !== undefined && options.rp.id !== input.begin.rpId)
  )
    throw new PasskeyError('options_mismatch');
  const excluded = new Map((options.excludeCredentials ?? []).map((c) => [c.id, c]));
  for (const id of input.begin.excludeCredentialIds)
    if (!excluded.has(id)) excluded.set(id, { id, type: 'public-key' });
  return {
    ...options,
    rp: { ...options.rp, id: input.begin.rpId },
    excludeCredentials: [...excluded.values()],
    // PK-01: discoverable, user verification required, attestation `none`.
    authenticatorSelection: {
      ...options.authenticatorSelection,
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    attestation: 'none',
    // Where the platform answers PRF at creation, the same touch gives the Whombat its backup key.
    extensions: withBackupPrf(options).extensions,
  };
}

/**
 * PK-06: the Whombat first, then control; a control that refuses twice gets the passkey removed on the Whombat again
 * (`control_failed`). Answers the Whombat's summary of the new passkey, and what it did for the backups (`backups`):
 * where the platform answered PRF at creation, the Whombat got its backup key in the same touch (`armed`); else the
 * next touch gives it (`touch`), or the passkey can't (`unsupported`).
 */
export async function passkeyRegister(deps: PasskeyRegisterDeps): Promise<RegisteredPasskey> {
  if (deps.control.putPasskeyOwner && deps.control.passkeys) return registerSharedPasskey(deps);
  const { session } = deps;
  const begin = await sessionOps.passkeyRegisterBegin(session);
  const r = await deps.control.passkeyRegisterOptions({
    appliance: deps.appliance,
    applianceNonce: begin.applianceNonce,
  });
  if (!r.controlNonce) throw new PasskeyError('options_mismatch', 'Control sent no nonce.');
  const options = registrationOptionsFor({
    options: r.options,
    controlNonce: r.controlNonce,
    begin,
    appliance: deps.appliance,
  });
  deps.onPrompt?.('create');
  const raw = await deps.platform.create(options);
  const prf = prfOutputOf(raw);
  const refused = prfRefused(raw);
  const response = canonicalRegistration(raw);
  const name = deps.name.trim().slice(0, 64) || 'Passkey';
  let saved: PasskeySummary;
  try {
    saved = await sessionOps.passkeyRegister(session, { controlNonce: r.controlNonce, response, name });
  } catch (error) {
    prf?.fill(0);
    throw error;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await deps.control.passkeyRegisterVerify({ name, response });
      return { ...saved, backups: await armWith(session, saved.id, prf, deps.appliance, refused) };
    } catch {
      // Once more, then it goes again on the Whombat.
    }
  }
  prf?.fill(0);
  await sessionOps.passkeyRemove(session, saved.id).catch(() => {});
  throw new PasskeyError('control_failed');
}

/** The Whombat's backup key from a new passkey's PRF output, when it gave one. */
async function armWith(
  session: ApplianceSession,
  credentialId: string,
  prf: Uint8Array | null,
  appliance: string,
  refused: boolean,
): Promise<BackupArming> {
  if (!prf) return refused ? 'unsupported' : 'touch';
  try {
    await sessionOps.backupPasskeyKeySet(session, backupKeyInput(credentialId, prf, appliance));
    return 'armed';
  } catch {
    return 'failed';
  }
}

/* Seeing and removing (PK-08) ----------------------------------------------------------------------------------- */

/**
 * Removes a passkey on the Whombat, then, when it is the caller's own, at control (which keeps the same credential
 * id). Control not having it (or not answering) doesn't undo the removal: without the Whombat it opens nothing.
 */
export async function passkeyRemove(input: {
  session: ApplianceSession;
  control:
    | (Pick<ControlApi, 'deletePasskey'> & Partial<Pick<ControlApi, 'unlinkPasskey'>>)
    | null
    | undefined;
  passkey: Pick<PasskeySummary, 'id' | 'accountId' | 'ownerHandle'>;
  appliance?: string;
  /** The caller's account on the Whombat. */
  me: string | null;
}): Promise<{ control: 'removed' | 'skipped' | 'failed' }> {
  await sessionOps.passkeyRemove(input.session, input.passkey.id);
  if (!input.control || input.passkey.accountId !== input.me) return { control: 'skipped' };
  try {
    if (input.passkey.ownerHandle) {
      if (!input.appliance || !input.control.unlinkPasskey) return { control: 'skipped' };
      await input.control.unlinkPasskey(input.passkey.id, input.appliance);
    } else await input.control.deletePasskey(input.passkey.id);
    return { control: 'removed' };
  } catch (error) {
    return { control: error instanceof ControlError && error.code === 'not_found' ? 'removed' : 'failed' };
  }
}

/** The list as Settings shows it: the caller's own first, newest first within each. */
export function orderPasskeys(passkeys: readonly PasskeySummary[], me: string | null): PasskeySummary[] {
  return [...passkeys].sort(
    (a, b) =>
      Number(b.accountId === me) - Number(a.accountId === me) || b.createdAt.localeCompare(a.createdAt),
  );
}

/** “Added 3 Oct 2026 · Last used 2 hours ago” (and “Synced” is a tag beside it). */
export function passkeyMeta(p: PasskeySummary, ago: (iso: string | null) => string): string {
  const date = new Date(p.createdAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return [
    PASSKEY_COPY.created(date),
    p.lastUsedAt ? PASSKEY_COPY.lastUsed(ago(p.lastUsedAt)) : PASSKEY_COPY.neverUsed,
    ...(p.current ? [PASSKEY_COPY.current] : []),
  ].join(' · ');
}

/** The default name of a new passkey: this device's label, within the contract's 64 characters. */
export function passkeyName(label: string): string {
  return label.trim().slice(0, 64) || 'Passkey';
}

/* Telling the person (PK-09) ------------------------------------------------------------------------------------ */

/** How long a device a passkey let in counts as new (the notice and the Devices row). */
export const PASSKEY_NEW_DEVICE_MS = 24 * 60 * 60_000;
/** How close a passkey's last use and a device's creation are when that use let the device in. */
const ENROLLED_WITHIN_MS = 2 * 60_000;

/**
 * Devices a passkey let in during the last day (PK-09, Whombat PK-D08): a passkey's last use is when it enrolled its
 * newest device, so the device created closest to it (within two minutes) is the one it let in — told unless it is
 * this one or removed. Endpoint id → the passkey.
 */
export function passkeyEnrolledDevices(
  endpoints: readonly {
    endpointId: string;
    createdAt: string;
    current: boolean;
    revocation: string;
  }[],
  passkeys: readonly Pick<PasskeySummary, 'id' | 'name' | 'lastUsedAt'>[],
  now: number = Date.now(),
): Map<string, Pick<PasskeySummary, 'id' | 'name' | 'lastUsedAt'>> {
  const found = new Map<string, Pick<PasskeySummary, 'id' | 'name' | 'lastUsedAt'>>();
  for (const p of passkeys) {
    if (!p.lastUsedAt) continue;
    const used = Date.parse(p.lastUsedAt);
    let best: (typeof endpoints)[number] | null = null;
    for (const e of endpoints) {
      const gap = Math.abs(Date.parse(e.createdAt) - used);
      if (gap <= ENROLLED_WITHIN_MS && (!best || gap < Math.abs(Date.parse(best.createdAt) - used))) best = e;
    }
    if (!best || best.current || best.revocation !== 'none') continue;
    if (now - Date.parse(best.createdAt) <= PASSKEY_NEW_DEVICE_MS) found.set(best.endpointId, p);
  }
  return found;
}

/** The new devices the person has already looked at (per Whombat), so the notice says each once. */
export function createSeenDevices(
  storage: SyncStorage | (() => SyncStorage | null | undefined) = () => globalThis.localStorage,
): { seen(device: string, endpointId: string): boolean; see(device: string, endpointId: string): void } {
  const KEY = 'whombat:passkey-devices-seen';
  const reach = () => (typeof storage === 'function' ? storage() : storage);
  const read = (): string[] => {
    try {
      const v = JSON.parse(reach()?.getItem(KEY) ?? '[]') as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    seen: (device, endpointId) => read().includes(`${device}|${endpointId}`),
    see(device, endpointId) {
      try {
        // The last 200 are plenty: a device is new for a day.
        reach()?.setItem(KEY, JSON.stringify([...read(), `${device}|${endpointId}`].slice(-200)));
      } catch {
        // Not remembered: said again next time.
      }
    },
  };
}

/* The nudge (PK-10) ------------------------------------------------------------------------------------------- */

const NUDGE_KEY = 'whombat:passkey-nudge';
/** The entry that says a new passkey is owed on whichever Whombat opens next (never a `device|endpoint` key). */
const OWED = 'owed';

/**
 * “Open faster next time with a passkey” once per device key and Whombat (PK-10): due after this device was let in
 * any other way (pairing, a link, the recovery kit), and done for good once a passkey is added or “Not now” is
 * tapped. A passkey that turned out to open nothing (its Whombat gone) makes it owed: offered on the next Whombat this
 * device opens, even where “Not now” was tapped before. Storage that fails remembers nothing and shows nothing
 * (never a nudge on every start).
 */
export interface PasskeyNudge {
  /** This device was just let in to `device` another way. */
  due(device: string, endpoint: string): void;
  /** A passkey just opened nothing: offer a new one on the next Whombat this device opens. */
  owe(): void;
  /** Whether to offer it now. */
  shows(device: string, endpoint: string): boolean;
  /** Added, or “Not now”: never again for this device key and Whombat, and nothing owed. */
  done(device: string, endpoint: string): void;
}

export function createPasskeyNudge(
  storage: SyncStorage | (() => SyncStorage | null | undefined) = () => globalThis.localStorage,
): PasskeyNudge {
  const reach = () => (typeof storage === 'function' ? storage() : storage);
  const read = (): Record<string, 'due' | 'done'> => {
    try {
      const raw = reach()?.getItem(NUDGE_KEY);
      const v = raw ? (JSON.parse(raw) as unknown) : {};
      return v && typeof v === 'object' ? (v as Record<string, 'due' | 'done'>) : {};
    } catch {
      return {};
    }
  };
  const update = (change: (all: Record<string, 'due' | 'done'>) => void) => {
    try {
      const s = reach();
      if (!s) return;
      const all = read();
      change(all);
      s.setItem(NUDGE_KEY, JSON.stringify(all));
    } catch {
      // Nothing remembered: nothing shown.
    }
  };
  const write = (key: string, value: 'due' | 'done') =>
    update((all) => {
      // Done stays done: a later pairing on the same key doesn't ask again.
      if (all[key] !== 'done') all[key] = value;
    });
  const key = (device: string, endpoint: string) => `${device}|${endpoint}`;
  return {
    due: (device, endpoint) => write(key(device, endpoint), 'due'),
    owe: () =>
      update((all) => {
        all[OWED] = 'due';
      }),
    shows: (device, endpoint) => {
      const all = read();
      return all[OWED] === 'due' || all[key(device, endpoint)] === 'due';
    },
    done: (device, endpoint) =>
      update((all) => {
        all[key(device, endpoint)] = 'done';
        delete all[OWED];
      }),
  };
}

async function publishOwner(
  control: PasskeyRegisterControl,
  record: OwnerPasskeyRecord,
  seed: Uint8Array,
  appliance: string,
): Promise<OwnerPasskeyRecord> {
  if (!control.putPasskeyOwner || !control.passkeys) throw new PasskeyError('control_failed');
  let next = record;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await control.putPasskeyOwner(next.credentialId, next);
      return next;
    } catch (error) {
      if (!(error instanceof ControlError) || error.code !== 'claim_competing') throw error;
      const latest = verifyOwnerPasskey(
        (await control.passkeys()).find((p) => p.id === next.credentialId)?.owner,
        next.userHandle,
      );
      if (!latest || latest.publicKey !== next.publicKey || latest.sealedSeed !== next.sealedSeed)
        throw new PasskeyError('options_mismatch');
      if (latest.appliances.includes(appliance)) return latest;
      const { signature: _, ...document } = latest;
      next = signOwnerPasskey(
        { ...document, revision: latest.revision + 1, appliances: [...latest.appliances, appliance] },
        seed,
      );
    }
  }
  throw new PasskeyError('control_failed');
}

async function linkSharedPasskey(
  deps: PasskeyRegisterDeps,
  candidate: OwnerPasskeyRecord,
): Promise<RegisteredPasskey> {
  const old = verifyOwnerPasskey(candidate, candidate.userHandle);
  if (!old) throw new PasskeyError('options_mismatch');
  let seed: Uint8Array | null = null;
  let output: Uint8Array | null = null;
  try {
    let record = old;
    if (!old.appliances.includes(deps.appliance)) {
      // A new signed scope needs the owner seed before its bound assertion can be requested.
      deps.onPrompt?.('unlock');
      const got = await deps.platform.prf?.({ credentialIds: [old.credentialId], salt: KIT_PRF_SALT_V2 });
      output = got?.output ?? null;
      if (output?.length !== 32) throw new PasskeyError('unsupported');
      if (got?.credentialId !== old.credentialId || (got.userHandle && got.userHandle !== old.userHandle))
        throw new PasskeyError('options_mismatch');
      seed = openPasskeyOwner(old, output);
      if (!seed) throw new PasskeyError('options_mismatch');
      const { signature: _, ...document } = old;
      record = signOwnerPasskey(
        { ...document, revision: old.revision + 1, appliances: [...old.appliances, deps.appliance] },
        seed,
      );
    }
    // A stored envelope predates this touch. Opening it with a fresh evaluation is an independent backup check.
    const prepared = deps.verifyBackups
      ? await preparePasskeyBackupCheck(deps.session, old.credentialId)
      : null;
    const check = prepared?.salt === KIT_PRF_SALT_V2_B64 ? prepared : null;
    const begin = await sessionOps.passkeySharedBegin(deps.session, old.userHandle);
    if (!begin.endpoint || begin.user.id !== old.userHandle) throw new PasskeyError('options_mismatch');
    deps.onPrompt?.(check ? 'link-and-verify' : 'link');
    const raw = await deps.platform.get(
      withBackupPrf<PasskeyRequestOptionsJSON>({
        challenge: passkeyLinkChallenge({
          nonce: begin.applianceNonce,
          appliance: deps.appliance,
          endpoint: begin.endpoint,
          record,
        }),
        rpId: begin.rpId,
        allowCredentials: [{ id: old.credentialId, type: 'public-key' }],
        userVerification: 'required',
      }),
    );
    const response = canonicalAssertion(raw);
    if (
      response.id !== old.credentialId ||
      (response.response.userHandle && response.response.userHandle !== old.userHandle)
    )
      throw new PasskeyError('options_mismatch');
    const fresh = prfOutputOf(raw);
    // Linking a newly signed scope already unlocked the owner. Never use that earlier output for a backup proof.
    if (!seed || check) {
      output?.fill(0);
      output = fresh;
      if (!output) throw new PasskeyError('unsupported');
    } else if (fresh) {
      output?.fill(0);
      output = fresh;
    }
    if (!output) throw new PasskeyError('unsupported');
    seed?.fill(0);
    seed = openPasskeyOwner(old, output);
    if (!seed) throw new PasskeyError('options_mismatch');
    const saved = await sessionOps.passkeyLink(deps.session, { record, response, name: deps.name });
    // A failed cloud write keeps local access. Retrying finishes publishing the directory with the same passkey.
    record = await publishOwner(deps.control, record, seed, deps.appliance);
    if (check) {
      const verified = await confirmPasskeyBackupCheck(deps, check, output);
      if (!verified) throw new PasskeyError('invalid');
      return { ...saved, backups: 'armed', backupsVerified: true };
    }
    // This fresh evaluation opened the owner's previously saved seed. Keep it only until the new backup envelope
    // has been read back and checked, instead of asking the person to unlock the same passkey again.
    const backups = await armWith(deps.session, old.credentialId, output.slice(), deps.appliance, false);
    if (deps.verifyBackups && backups === 'armed') {
      const status = await sessionOps.backupStatus(deps.session);
      if (!status.status && status.summary.bringBack?.state !== 'none') throw new PasskeyError('unreachable');
      if (status.status?.destination.configured && status.status.destination.kind !== 'local') {
        const stored = await sessionOps.backupPasskeyVerifyBegin(deps.session, old.credentialId);
        if (stored.salt !== KIT_PRF_SALT_V2_B64) throw new PasskeyError('invalid');
        const verified = await confirmPasskeyBackupCheck(deps, stored, output);
        if (!verified) throw new PasskeyError('invalid');
        return { ...saved, backups, backupsVerified: true };
      }
    }
    return { ...saved, backups };
  } finally {
    seed?.fill(0);
    output?.fill(0);
  }
}

async function registerSharedPasskey(deps: PasskeyRegisterDeps): Promise<RegisteredPasskey> {
  const existing = ((await deps.control.passkeys?.()) ?? [])
    .filter((p) => p.owner && (!deps.credentialId || p.id === deps.credentialId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // Setup, upgrades and adding another Whombat all reuse the same credential. Never silently create another one
  // because a provider dismissed a prompt or couldn't return its encryption key.
  const ownerRecord = existing[0]?.owner;
  if (ownerRecord) return linkSharedPasskey(deps, ownerRecord);
  if (deps.credentialId) throw new PasskeyError('invalid');
  const owner = newPasskeyOwner();
  let prf: Uint8Array | null = null;
  try {
    const begin = await sessionOps.passkeySharedBegin(deps.session, owner.userHandle);
    if (begin.user.id !== owner.userHandle) throw new PasskeyError('options_mismatch');
    const r = await deps.control.passkeyRegisterOptions({
      appliance: deps.appliance,
      applianceNonce: begin.applianceNonce,
      ownerHandle: owner.userHandle,
    });
    if (!r.controlNonce) throw new PasskeyError('options_mismatch');
    deps.onPrompt?.('create');
    const raw = await deps.platform.create(
      registrationOptionsFor({
        options: r.options,
        controlNonce: r.controlNonce,
        begin,
        appliance: deps.appliance,
      }),
    );
    const response = canonicalRegistration(raw);
    prf = prfOutputOf(raw);
    if (!prf) {
      deps.onPrompt?.('unlock');
      const got = await deps.platform.prf?.({ credentialIds: [response.id], salt: KIT_PRF_SALT_V2 });
      if (
        !got?.output ||
        got.credentialId !== response.id ||
        got.output.length !== 32 ||
        (got.userHandle && got.userHandle !== owner.userHandle)
      ) {
        got?.output?.fill(0);
        throw new PasskeyError('unsupported');
      }
      prf = got.output;
    }
    const name = deps.name.trim().slice(0, 64) || 'My Whombat passkey';
    const saved = await sessionOps.passkeyRegister(deps.session, {
      controlNonce: r.controlNonce,
      response,
      name,
    });
    if (!saved.publicKey || saved.ownerHandle !== owner.userHandle)
      throw new PasskeyError('options_mismatch');
    const record = signOwnerPasskey(
      {
        kind: 'whombat.owner-passkey/1',
        credentialId: saved.id,
        userHandle: owner.userHandle,
        publicKey: saved.publicKey,
        revision: 1,
        appliances: [deps.appliance],
        sealedSeed: sealPasskeyOwner(owner.seed, prf, saved.id),
      },
      owner.seed,
    );
    let registered = false;
    for (let attempt = 0; attempt < 2 && !registered; attempt++) {
      try {
        await deps.control.passkeyRegisterVerify({ name, response, ownerRecord: record });
        registered = true;
      } catch {
        /* Retry the same ceremony. */
      }
    }
    if (!registered) {
      await sessionOps.passkeyRemove(deps.session, saved.id).catch(() => {});
      throw new PasskeyError('control_failed');
    }
    return { ...saved, backups: await armWith(deps.session, saved.id, prf, deps.appliance, false) };
  } finally {
    owner.seed.fill(0);
    prf?.fill(0);
  }
}
