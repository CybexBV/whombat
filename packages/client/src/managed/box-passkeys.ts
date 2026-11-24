/**
 * The box's own passkeys (Whombat docs/decisions/own-address.md; design §7.1, §7.5): passkeys whose RP ID is the box's
 * own host, so no page Cybex serves can use them. The box issues everything (`boxPasskey.*`): its nonce, the user (a
 * random id per account per box, “<box name> · your Whombat”) and the challenge, which this side recomputes before
 * anything is signed.
 *
 * - `createBoxPasskey`: make one and arm the backup key with it. Two touches: one makes the passkey and gives the box its
 *   backup key (PRF at creation, a fresh random salt per arming), one checks that the key opens the saved envelope. Where
 *   the platform answers no PRF at creation the first touch splits in two.
 * - `joinWithBoxPasskey`: let this device in with one (`boxPasskey.enroll`), the assertion bound to its key.
 *
 * Shared by web and phone. The phone's own ceremony waits for its device tests: today a phone makes the box's passkey in
 * its browser at the address and joins the app with a device link.
 */
import { kitKeyFromPrf, newKitPrfSalt, toBase64url } from '@whombat/core/backup';
import {
  type BackupPasskeyKeyOutput,
  BOX_PASSKEY_TIMEOUT_MS,
  type BoxPasskeyFailedStage,
  boxPasskeyRegisterChallengeBase64url,
  passkeyEnrollChallengeBase64url,
} from '@whombat/protocol/session';
import { type BoxPasskeyRegisterBegin, OperationError, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import type { ControlApi } from './control';
import { verifyPasskeyBackups } from './kit-passkey';
import { prfOutputOf, prfRefused } from './passkey-backup-key';
import {
  canonicalAssertion,
  canonicalRegistration,
  operationReason,
  type PasskeyCreationOptionsJSON,
  PasskeyError,
  type PasskeyPlatform,
  type PasskeyRequestOptionsJSON,
  type PasskeySetupStep,
  passkeyErrorOf,
  passkeyFailureDetail,
} from './passkeys';

/** The relying party's display name in the password manager. */
const RP_NAME = 'Whombat';

/**
 * What `navigator.credentials.create` gets from the box's `boxPasskey.register.begin`, refused unless the challenge is
 * exactly `boxPasskeyRegisterChallenge({nonce, appliance, rpId})` for the box this page pinned (`appliance`).
 * Discoverable, user verification required, no attestation, and PRF asking for `salt` (base64url).
 */
export function boxPasskeyCreationOptions(
  begin: BoxPasskeyRegisterBegin,
  appliance: string,
  salt: string,
): PasskeyCreationOptionsJSON {
  let expected: string;
  try {
    expected = boxPasskeyRegisterChallengeBase64url({ nonce: begin.nonce, appliance, rpId: begin.rpId });
  } catch {
    throw new PasskeyError('options_mismatch');
  }
  if (begin.challenge !== expected) throw new PasskeyError('options_mismatch');
  return {
    rp: { id: begin.rpId, name: RP_NAME },
    user: begin.user,
    challenge: begin.challenge,
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    timeout: BOX_PASSKEY_TIMEOUT_MS,
    excludeCredentials: begin.excludeCredentialIds.map((id) => ({ id, type: 'public-key' as const })),
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    attestation: 'none',
    extensions: { prf: { eval: { first: salt } } },
  };
}

/** What making the box's passkey did for the backups. */
export type BoxPasskeyBackups =
  /** The key is saved and a second touch opened the envelope with it. */
  | 'verified'
  /** The key is saved; the backups take it once they're set up (or once saving finishes). */
  | 'saving'
  /** The passkey or its manager has no PRF: the paper copy is the only way to open the backups. */
  | 'unsupported'
  /** The box has no backup service (`not_implemented`): nothing for the passkey to unlock. */
  | 'no_backups'
  /** The passkey is made, but arming or checking the backup key didn't finish (a dismissed touch, a refusal). */
  | 'not_armed';

export interface BoxPasskeyMade {
  /** The new passkey's credential id. */
  id: string;
  backups: BoxPasskeyBackups;
  bringBack?: BackupPasskeyKeyOutput['bringBack'];
}

/**
 * Makes the box's passkey for the caller's account and arms the backup key with it (design §7.5: two touches, split in
 * three without PRF at creation). `PasskeyCancelled` when the person dismissed a prompt; `PasskeyError` or
 * `OperationError` when it failed. A passkey already made stays made when only the backup part fails.
 */
export async function createBoxPasskey(input: {
  session: ApplianceSession;
  platform: PasskeyPlatform;
  /** The box's PeerId as this page pinned it. */
  appliance: string;
  /** The passkey's name on the box (this device's label). */
  name: string;
  onPrompt?: (step: PasskeySetupStep) => void;
}): Promise<BoxPasskeyMade> {
  const { session, platform, appliance } = input;
  let stage: BoxPasskeyFailedStage = 'begin';
  let prf: Uint8Array | null = null;
  try {
    const begin = await sessionOps.boxPasskeyRegisterBegin(session);
    const salt = newKitPrfSalt();
    const saltText = toBase64url(salt);
    stage = 'create';
    input.onPrompt?.('create');
    const raw = await platform.create(boxPasskeyCreationOptions(begin, appliance, saltText));
    prf = prfOutputOf(raw);
    const refused = prfRefused(raw);
    stage = 'register';
    const saved = await sessionOps.boxPasskeyRegister(session, {
      nonce: begin.nonce,
      response: canonicalRegistration(raw),
      name: input.name.trim().slice(0, 64) || 'Passkey',
    });
    const id = saved.id;
    // The passkey is made from here on: a backup key it couldn't arm says so, never that the passkey failed.
    try {
      return await armBoxPasskey(id, salt, saltText, refused);
    } catch (error) {
      const code = error instanceof OperationError ? error.code : null;
      const noBackups = code === 'not_implemented' || code === 'unknown_op';
      if (!noBackups) reportBoxPasskeyFailure(session, 'backups', error);
      return { id, backups: noBackups ? 'no_backups' : 'not_armed' };
    }
  } catch (error) {
    reportBoxPasskeyFailure(session, stage, error);
    throw error;
  } finally {
    prf?.fill(0);
  }

  async function armBoxPasskey(
    id: string,
    salt: Uint8Array,
    saltText: string,
    refused: boolean,
  ): Promise<BoxPasskeyMade> {
    if (!prf && !refused && platform.prf) {
      // No PRF at creation (some platforms answer it only on use): one more touch for the backup key.
      input.onPrompt?.('unlock');
      const got = await platform.prf({ credentialIds: [id], salt });
      if (got?.credentialId === id && got.output?.length === 32) prf = got.output;
      else got?.output?.fill(0);
    }
    if (!prf) return { id, backups: 'unsupported' };
    const key = kitKeyFromPrf(prf, appliance);
    prf.fill(0);
    prf = null;
    let set: BackupPasskeyKeyOutput;
    try {
      set = await sessionOps.backupPasskeyKeySet(session, {
        credentialId: id,
        salt: saltText,
        key: toBase64url(key),
      });
    } finally {
      key.fill(0);
    }
    const ready =
      set.bringBack.setup === 'verify' ||
      (set.bringBack.state === 'ready' && set.bringBack.setup !== 'saving');
    if (!ready) return { id, backups: 'saving', bringBack: set.bringBack };
    // The second touch: the saved envelope opens with this passkey, checked apart from the arming.
    const bringBack = await verifyPasskeyBackups(
      { session, appliance, platform, onPrompt: input.onPrompt },
      id,
    );
    return { id, backups: bringBack.setup === 'verified' ? 'verified' : 'saving', bringBack };
  }
}

/**
 * Tells the box why making its passkey stopped, so the reason is in its log for support: the page shows the person only
 * a short sentence. Never waits and never fails: a box that doesn't take it (older, or the session gone) loses a line.
 */
export function reportBoxPasskeyFailure(
  session: ApplianceSession,
  stage: BoxPasskeyFailedStage,
  error: unknown,
): void {
  const code = passkeyErrorOf(error) ?? 'cancelled';
  // The platform's own error (a browser's DOMException), when the page kept it.
  const raw =
    error instanceof Error ? (error.cause as { name?: unknown; message?: unknown } | undefined) : undefined;
  const cause =
    raw && typeof raw.name === 'string' ? { name: raw.name, message: String(raw.message ?? '') } : null;
  const name =
    error instanceof OperationError
      ? operationReason(error)
      : (cause?.name ?? (error instanceof Error ? error.name : undefined));
  const detail = cause ? `${cause.name}: ${cause.message}` : passkeyFailureDetail(error);
  try {
    void sessionOps
      .boxPasskeyFailed(session, {
        stage,
        code,
        ...(name && /^[A-Za-z0-9_.:-]{1,64}$/.test(name) && { name }),
        detail: detail.slice(0, 300),
      })
      .catch(() => {});
  } catch {
    // The input didn't fit the contract: nothing to tell.
  }
}

/** A device let in with a box passkey: its account and endpoint. */
export type BoxPasskeyEnrolled = Awaited<ReturnType<typeof sessionOps.boxPasskeyEnroll>>;

/**
 * The request options for joining with a box passkey: the box's nonce bound to this device's key
 * (`passkeyEnrollChallenge({nonce, endpoint})`), discoverable (no list of credentials), user verification required.
 */
export function boxPasskeyRequestOptions(
  begin: { nonce: string; rpId: string; timeoutMs: number },
  endpoint: string,
): PasskeyRequestOptionsJSON {
  return {
    challenge: passkeyEnrollChallengeBase64url({ nonce: begin.nonce, endpoint }),
    rpId: begin.rpId,
    timeout: begin.timeoutMs,
    userVerification: 'required',
  };
}

/**
 * Lets this device in with a box passkey (`boxPasskey.enroll.begin` → the platform's assertion → `boxPasskey.enroll`).
 * The session must be pinned to the box and `endpoint.peerId` must be this session's key: the challenge binds it.
 */
export async function joinWithBoxPasskey(input: {
  session: ApplianceSession;
  platform: Pick<PasskeyPlatform, 'get'>;
  /** This device's PeerId (its Noise static key). */
  endpointPeerId: string;
  endpoint: { label: string; platform: 'web' | 'android' | 'ios' | 'desktop' | 'cli' };
}): Promise<BoxPasskeyEnrolled> {
  const begin = await sessionOps.boxPasskeyEnrollBegin(input.session);
  const raw = await input.platform.get(boxPasskeyRequestOptions(begin, input.endpointPeerId));
  return sessionOps.boxPasskeyEnroll(input.session, {
    nonce: begin.nonce,
    response: canonicalAssertion(raw),
    endpoint: input.endpoint,
  });
}

/**
 * The account passkey at app.whombat.com (design §7.1, §7.5): it signs the person in to their Whombat account and can
 * bring a Whombat back, but opens no Whombat (control's options without a Whombat). No PRF: nothing is sealed under it.
 */
export async function createAccountPasskey(input: {
  control: Pick<ControlApi, 'passkeyRegisterOptions' | 'passkeyRegisterVerify'>;
  platform: Pick<PasskeyPlatform, 'create'>;
  /** The passkey's name at the account (this device's label). */
  name: string;
}): Promise<{ id: string; name: string }> {
  const r = await input.control.passkeyRegisterOptions({});
  const options = r.options as unknown as PasskeyCreationOptionsJSON;
  if (!options || typeof options.challenge !== 'string' || !options.user?.id)
    throw new PasskeyError('options_mismatch');
  const { extensions: _none, ...rest } = options;
  const raw = await input.platform.create({
    ...rest,
    authenticatorSelection: {
      ...options.authenticatorSelection,
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    attestation: 'none',
  });
  return input.control.passkeyRegisterVerify({
    name: input.name.trim().slice(0, 64) || 'Passkey',
    response: canonicalRegistration(raw),
  });
}
