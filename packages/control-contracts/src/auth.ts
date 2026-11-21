/** Cloud identity (MA-03): magic link and session. Grants nothing on an appliance. */
import {
  OwnerPasskeyHandle,
  OwnerPasskeyRecord,
  PasskeyNonce,
  PeerIdString,
} from '@whombat/protocol/session';
import { z } from 'zod';
import { AccountId, DisplayName, Email, OrgId } from './common.js';
import { controlEndpoint } from './endpoint.js';
import { SignupCodeInput } from './signup.js';

/**
 * `next` must be a same-origin path (review L-5, control R-05, CT-48): one leading `/`, not followed by `/` or `\\`
 * (protocol-relative) or an encoded slash/backslash (`%2f`, `%5c`); no backslash anywhere; only URL path and query
 * characters (so no scheme, no fragment, no whitespace). Control checks it before putting it into an email link.
 */
export const SAFE_NEXT =
  /^\/(?![/\\])(?!%2[fF])(?!%5[cC])[A-Za-z0-9._~!$&'()*+,;=:@%/-]*(\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/;

export function isSafeNext(next: string): boolean {
  return next.length <= 300 && SAFE_NEXT.test(next) && !next.includes('\\');
}

export const MagicLinkRequest = z.strictObject({
  email: Email,
  /** Hosted-UI path to return to after sign-in (same-origin path only, `SAFE_NEXT`). */
  next: z.string().max(300).regex(SAFE_NEXT).optional(),
  /**
   * A signup code the person holds (a `/signup#code=` link, BL-33): outside `open` mode it lets an address without an
   * account get a sign-in link, when the code is active and not bound to another address.
   */
  code: SignupCodeInput.optional(),
});
export const MagicLinkVerify = z.strictObject({
  token: z
    .string()
    .min(22)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export const CloudAccount = z.object({
  accountId: AccountId,
  email: Email,
  name: DisplayName.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type CloudAccount = z.infer<typeof CloudAccount>;

export const CloudSession = z.object({
  /** Bearer token for `session` endpoints; store like a password. */
  token: z.string().min(32).max(256),
  expiresAt: z.iso.datetime({ offset: true }),
  account: CloudAccount,
  /** The account's orgs (one account per org since 3.0, CT-1560). */
  orgs: z
    .array(
      z.object({
        orgId: OrgId,
        name: DisplayName,
        /**
         * True for the account's hidden Whombat Link org (4.5), which holds its Link boxes and is never a business
         * org: the account site leaves it out of the hosted list. Absent from an older control: not a Link org.
         */
        link: z.boolean().optional(),
      }),
    )
    .max(100),
});
export type CloudSession = z.infer<typeof CloudSession>;

/** WebAuthn JSON (`@simplewebauthn` options and responses), passed through as is. */
export const WebAuthnJson = z.record(z.string(), z.unknown());

export const Passkey = z.object({
  id: z.string().min(1).max(512),
  name: z.string().max(64),
  /**
   * The Whombat the passkey opens (its `user.id` is `passkeyUserHandle(appliance)`, Whombat passkeys.md PK-01, 0.50);
   * null for an account-level passkey (CL-11), which only signs in to the cloud account.
   */
  appliance: PeerIdString.nullable(),
  owner: OwnerPasskeyRecord.nullable().optional(),
  createdAt: z.iso.datetime({ offset: true }),
  lastUsedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Passkey = z.infer<typeof Passkey>;

/** Retire an older credential only while the replacement covers its unchanged scope and no saved kit needs it. */
export const PasskeyRetireInput = z.strictObject({
  replacementId: z.string().min(1).max(512),
  expectedRevision: z.number().int().min(1).nullable(),
  checkedAppliances: z.array(PeerIdString).max(100),
});
export type PasskeyRetireInput = z.infer<typeof PasskeyRetireInput>;

/**
 * Registration options (0.50, CT-283). With `appliance` and `applianceNonce` (both or neither; the nonce comes from
 * the Whombat's `passkey.register.begin`): a Whombat passkey (PK-01, PK-06), `user.id` =
 * `passkeyUserHandle(appliance)`, `user.name` the account's email, `user.displayName` the Whombat's name in the
 * directory (an appliance of one of the caller's orgs: `device_not_found` otherwise), and `challenge` =
 * `passkeyRegisterChallenge({controlNonce, applianceNonce, appliance})` as base64url. Without them an account-level
 * passkey as before (CL-11).
 */
export const PasskeyRegisterOptionsBody = z
  .strictObject({
    appliance: PeerIdString.optional(),
    applianceNonce: PasskeyNonce.optional(),
    ownerHandle: OwnerPasskeyHandle.optional(),
  })
  .refine((b) => (b.appliance === undefined) === (b.applianceNonce === undefined), {
    message: 'appliance and applianceNonce come together',
  })
  .refine((b) => !b.ownerHandle || !!b.appliance, { message: 'ownerHandle requires an appliance' });
export const PasskeyRegisterOptions = z.object({
  /** With `appliance`: control's half of the challenge; the client hands it to `passkey.register`. */
  controlNonce: PasskeyNonce.optional(),
  options: WebAuthnJson,
});
export type PasskeyRegisterOptions = z.infer<typeof PasskeyRegisterOptions>;

/**
 * Sign-in options (0.50, CT-283). With `endpoint` (the new device's PeerId, its Noise identity): `nonce` is given and
 * `options.challenge` = `passkeyEnrollChallengeBase64url({nonce, endpoint})` (PK-03), so the same assertion can then
 * enroll exactly that device with `enroll.passkey`; the client recomputes the challenge and refuses another. Without
 * it a plain random challenge, as before.
 */
export const PasskeyAuthenticateOptionsBody = z.strictObject({ endpoint: PeerIdString.optional() });
export const PasskeyAuthenticateOptions = z.object({
  challengeId: z.string().min(1).max(64),
  /** Present when `endpoint` was given. */
  nonce: PasskeyNonce.optional(),
  options: WebAuthnJson,
});
export type PasskeyAuthenticateOptions = z.infer<typeof PasskeyAuthenticateOptions>;

export const PasskeyRegisterVerify = z.strictObject({
  ownerRecord: OwnerPasskeyRecord.optional(),
  name: z.string().trim().min(1).max(64).optional(),
  response: WebAuthnJson,
});
export const PasskeyAuthenticateVerify = z.strictObject({
  challengeId: z.string().min(1).max(64),
  response: WebAuthnJson,
});

/**
 * Typed confirmation for deleting the cloud account (0.10): the account's email address, compared
 * case-insensitively after trimming (`email_mismatch` otherwise).
 */
export const DeleteAccountBody = z.strictObject({ email: Email });

/* Phone sign-in by QR code (CT-190) ----------------------------------------------------------------------------- */

/**
 * A signed-in browser shows a QR code that signs a phone in to the same account (`auth.createPhoneHandoff`): the code
 * carries a one-time token (5 minutes) that the phone exchanges for its own cloud session (`auth.redeemPhoneHandoff`),
 * like a magic link. The same handoff then relays one short report from that phone back to the browser that made it
 * (`auth.reportPhoneHandoff` → `auth.phoneHandoff`): the pairing code the Whombat gave the phone, so the browser can
 * let it in without anyone typing it. Control only relays the report: the clients authenticate it with a key that
 * stays in the QR code (`mac`), and letting a device in stays an appliance decision (`enroll.pair.approve`).
 */
export const PhoneHandoffId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
/** The one-time token in the QR code (≥ 128 bits, base64url); control stores its hash only. */
export const PhoneHandoffToken = MagicLinkVerify.shape.token;
/** A token can be redeemed for 5 minutes; the browser shows a fresh QR code after that. */
export const PHONE_HANDOFF_TOKEN_TTL_S = 300;
/** The handoff (and its report) lives 15 minutes from its creation. */
export const PHONE_HANDOFF_TTL_S = 900;

export const PhoneHandoffState = z.enum([
  /** Shown as a QR code; no phone has used it yet. */
  'waiting',
  /** A phone exchanged the token for a session and hasn't reported yet. */
  'scanned',
  /** The phone reported a pairing request for the browser to let in (`report.kind === 'pairing'`). */
  'ready',
  /** The phone is signed in and needs nothing more (`report.kind === 'signed_in'`). */
  'done',
  /** The token expired unused, or the handoff's 15 minutes are over. */
  'expired',
]);
export type PhoneHandoffState = z.infer<typeof PhoneHandoffState>;

/** Base64url HMAC-SHA256 (43 characters) the clients compute with the QR code's key; control never checks it. */
export const PhoneHandoffMac = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const PhoneHandoffReport = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('pairing'),
    /** `enroll.pair.request`'s code and the phone's pairing fingerprint (the protocol's `PairingCode` shapes). */
    code: z.string().regex(/^[0-9]{4}-[0-9]{4}$/),
    fingerprint: z.string().regex(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/),
    mac: PhoneHandoffMac,
  }),
  /** The QR code named no Whombat, or the phone was already let in there. */
  z.strictObject({ kind: z.literal('signed_in') }),
]);
export type PhoneHandoffReport = z.infer<typeof PhoneHandoffReport>;

export const PhoneHandoffCreated = z.object({
  handoffId: PhoneHandoffId,
  /** Shown once, in the QR code only. */
  token: PhoneHandoffToken,
  /** When the token stops working (`PHONE_HANDOFF_TOKEN_TTL_S`). */
  expiresAt: z.iso.datetime({ offset: true }),
});
export type PhoneHandoffCreated = z.infer<typeof PhoneHandoffCreated>;

export const PhoneHandoffView = z.object({
  handoffId: PhoneHandoffId,
  state: PhoneHandoffState,
  expiresAt: z.iso.datetime({ offset: true }),
  /** From `ready` or `done` on: the phone's report (last one wins while the handoff lives). */
  report: PhoneHandoffReport.nullable(),
});
export type PhoneHandoffView = z.infer<typeof PhoneHandoffView>;

export const PhoneHandoffRedeem = z.strictObject({ token: PhoneHandoffToken });
/** The phone's own cloud session, and the handoff its report goes to. */
export const PhoneHandoffRedeemed = CloudSession.extend({ handoffId: PhoneHandoffId });
export type PhoneHandoffRedeemed = z.infer<typeof PhoneHandoffRedeemed>;

/**
 * Backup details locked with a passkey (Whombat backup-options.md, backup-passkey.md): sealed with a key from the
 * passkey's WebAuthn PRF output (`salt` is the PRF input), by the client or, with the key a passkey touch gave it, by the
 * Whombat itself (the device op `kit.envelopes.put`). Control keeps only this envelope, which it can't open. One per
 * (Whombat, passkey). A retired Whombat's envelopes, and the passkeys that open them, stay until a live Whombat of the
 * same account reported it was brought back from that one (`adoptedFrom`) and has an envelope of its own (the kit drop
 * rule).
 */
export const KitEnvelopeBase64url = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);
export const KitEnvelopeInput = z.strictObject({
  /** The Whombat whose kit it is (its content PeerId). */
  appliance: PeerIdString,
  /** The passkey whose PRF output locks it (base64url credential id). */
  credentialId: KitEnvelopeBase64url(512),
  /** The PRF input, 32 random bytes. */
  salt: KitEnvelopeBase64url(64),
  /** `wbkit1.<nonce>.<ciphertext>` (XChaCha20-Poly1305), base64url parts. */
  envelope: z
    .string()
    .min(1)
    .max(65_536)
    .regex(/^wbkit1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  /** The kit's backup generation when it was locked (the backup service's `kitGeneration`). */
  generation: z.number().int().min(0).max(1_000_000),
});
export type KitEnvelopeInput = z.infer<typeof KitEnvelopeInput>;
export const KitEnvelope = KitEnvelopeInput.extend({
  id: z.string().min(1).max(64),
  /** The Whombat's name and whether it is retired (a kit kept to bring it back). */
  whombatName: z.string().max(80).nullable(),
  retired: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type KitEnvelope = z.infer<typeof KitEnvelope>;

export const authApi = {
  requestMagicLink: controlEndpoint({
    id: 'auth.requestMagicLink',
    method: 'POST',
    path: '/auth/magic-link',
    auth: 'none',
    summary:
      'Email a one-time sign-in link (rate-limited per email and IP; always answers ok). Outside `open` signup mode the link only goes to an existing account, an address with an active signup code bound to it, or with a valid `code` (BL-33); anyone else gets no mail, and the answer is the same.',
    body: MagicLinkRequest,
    response: z.object({ ok: z.literal(true) }),
  }),
  verify: controlEndpoint({
    id: 'auth.verify',
    method: 'POST',
    path: '/auth/verify',
    auth: 'none',
    summary: 'Exchange a magic-link token for a cloud session.',
    body: MagicLinkVerify,
    response: CloudSession,
  }),
  session: controlEndpoint({
    id: 'auth.session',
    method: 'GET',
    path: '/auth/session',
    auth: 'session',
    summary: 'The current cloud session (the account and its orgs).',
    response: CloudSession.omit({ token: true }),
  }),
  signOut: controlEndpoint({
    id: 'auth.signOut',
    method: 'POST',
    path: '/auth/sign-out',
    auth: 'session',
    summary: 'End this cloud session. Local appliance access is unaffected (endpoint keys are local).',
    body: z.strictObject({}),
    response: z.object({ ok: z.literal(true) }),
  }),
  signOutEverywhere: controlEndpoint({
    id: 'auth.signOutEverywhere',
    method: 'POST',
    path: '/auth/sign-out-everywhere',
    auth: 'session',
    summary: 'End every session of the account (e.g. after an email compromise).',
    body: z.strictObject({}),
    response: z.object({ ok: z.literal(true) }),
  }),
  passkeyRegisterOptions: controlEndpoint({
    id: 'auth.passkeyRegisterOptions',
    method: 'POST',
    path: '/auth/passkeys/register/options',
    auth: 'session',
    summary:
      'WebAuthn registration options (discoverable, user verification required, no attestation), for a Whombat passkey when the body names the Whombat and its nonce (`PasskeyRegisterOptionsBody`). 0.50: the options are in `options` (the bare options before).',
    body: PasskeyRegisterOptionsBody,
    response: PasskeyRegisterOptions,
  }),
  passkeyRegisterVerify: controlEndpoint({
    id: 'auth.passkeyRegisterVerify',
    method: 'POST',
    path: '/auth/passkeys/register/verify',
    auth: 'session',
    summary: 'Register the passkey from the authenticator’s response.',
    body: PasskeyRegisterVerify,
    response: z.object({ id: z.string().min(1).max(512), name: z.string().max(64) }),
  }),
  passkeyAuthenticateOptions: controlEndpoint({
    id: 'auth.passkeyAuthenticateOptions',
    method: 'POST',
    path: '/auth/passkeys/authenticate/options',
    auth: 'none',
    summary:
      'WebAuthn authentication options with a single-use challenge; bound to the new device’s key when the body names its `endpoint` (`PasskeyAuthenticateOptionsBody`, PK-03).',
    body: PasskeyAuthenticateOptionsBody,
    response: PasskeyAuthenticateOptions,
  }),
  passkeyAuthenticateVerify: controlEndpoint({
    id: 'auth.passkeyAuthenticateVerify',
    method: 'POST',
    path: '/auth/passkeys/authenticate/verify',
    auth: 'none',
    summary: 'Sign in with a passkey: a cloud session like `auth.verify`.',
    body: PasskeyAuthenticateVerify,
    response: CloudSession,
  }),
  passkeys: controlEndpoint({
    id: 'auth.passkeys',
    method: 'GET',
    path: '/auth/passkeys',
    auth: 'session',
    summary: 'The account’s passkeys.',
    response: z.object({ passkeys: z.array(Passkey).max(64) }),
  }),
  deleteAccount: controlEndpoint({
    id: 'accounts.delete',
    method: 'DELETE',
    path: '/me',
    auth: 'session',
    summary:
      'Delete the signed-in cloud account and what control holds for it (sessions, passkeys and its orgs); the details are control’s (CL). The body is a typed confirmation, the account’s email (`email_mismatch`, 400). Refuses `org_has_devices` (409: one of its orgs still has a claimed appliance; release or retire it first) and `subscription_live` (409: one of its orgs has a live Stripe subscription; cancel it first). Data on appliances belongs to the org and is never touched; appliance accounts are separate (MA-03). A DELETE with a JSON body, which control parses on every method.',

    body: DeleteAccountBody,
    response: z.object({ ok: z.literal(true) }),
  }),
  putPasskeyOwner: controlEndpoint({
    id: 'auth.putPasskeyOwner',
    method: 'PUT',
    path: '/auth/passkeys/:id/owner',
    auth: 'session',
    summary: 'Store an owner-signed shared-passkey directory, advancing its revision once.',
    body: OwnerPasskeyRecord,
    response: z.object({ ok: z.literal(true) }),
  }),
  unlinkPasskey: controlEndpoint({
    id: 'auth.unlinkPasskey',
    method: 'DELETE',
    path: '/auth/passkeys/:id/appliances/:appliance',
    auth: 'session',
    summary: 'Remove recovery access on one appliance without deleting the shared cloud credential.',
    response: z.object({ ok: z.literal(true) }),
  }),
  retirePasskey: controlEndpoint({
    id: 'auth.retirePasskey',
    method: 'POST',
    path: '/auth/passkeys/:id/retire',
    auth: 'session',
    summary:
      'Retire an unchanged older credential only if its replacement covers every checked appliance and no recovery envelope still needs it.',
    body: PasskeyRetireInput,
    response: z.object({ ok: z.literal(true) }),
  }),
  deletePasskey: controlEndpoint({
    id: 'auth.deletePasskey',
    method: 'DELETE',
    path: '/auth/passkeys/:id',
    auth: 'session',
    summary: 'Remove a passkey.',
    response: z.object({ ok: z.literal(true) }),
  }),
  kitEnvelopes: controlEndpoint({
    id: 'auth.kitEnvelopes',
    method: 'GET',
    path: '/auth/kit-envelopes',
    auth: 'session',
    summary:
      'The account’s passkey-locked recovery kits (Whombat backup-options.md), newest first, also those of retired Whombats.',
    response: z.object({ envelopes: z.array(KitEnvelope).max(64) }),
  }),
  putKitEnvelope: controlEndpoint({
    id: 'auth.putKitEnvelope',
    method: 'PUT',
    path: '/auth/kit-envelopes',
    auth: 'session',
    summary:
      'Keep a passkey-locked recovery kit for one of the account’s live Whombats (`device_not_found` otherwise) and a credential still in the account (`passkey_unknown` otherwise); replaces the one for the same Whombat and passkey unless that one is of a newer generation. A retired Whombat’s kits, and the passkeys kept for them, go only once a live Whombat of the account reported `adoptedFrom` = that Whombat (`kit.envelopes.put`) and has a kit of its own.',
    body: KitEnvelopeInput,
    response: z.object({ id: z.string().min(1).max(64) }),
  }),
  deleteKitEnvelope: controlEndpoint({
    id: 'auth.deleteKitEnvelope',
    method: 'DELETE',
    path: '/auth/kit-envelopes/:id',
    auth: 'session',
    summary: 'Forget a passkey-locked recovery kit.',
    response: z.object({ ok: z.literal(true) }),
  }),
  createPhoneHandoff: controlEndpoint({
    id: 'auth.createPhoneHandoff',
    method: 'POST',
    path: '/auth/phone-handoffs',
    auth: 'session',
    summary:
      'Start signing a phone in by QR code (CT-190): a one-time token for the QR code (5 minutes) and the handoff the browser watches. Rate-limited per account (`rate_limited`).',
    body: z.strictObject({}),
    response: PhoneHandoffCreated,
    status: 201,
  }),
  phoneHandoff: controlEndpoint({
    id: 'auth.phoneHandoff',
    method: 'GET',
    path: '/auth/phone-handoffs/:handoffId',
    auth: 'session',
    summary:
      'The handoff as its creator sees it: state and the phone’s report. Only the session that created it (`not_found` for anyone else, and 15 minutes after creation).',
    response: PhoneHandoffView,
  }),
  redeemPhoneHandoff: controlEndpoint({
    id: 'auth.redeemPhoneHandoff',
    method: 'POST',
    path: '/auth/phone-handoffs/redeem',
    auth: 'none',
    summary:
      'The phone exchanges the QR code’s token for its own cloud session on the same account, once (`link_invalid`, 401, when expired or used; per-network rate limit like `auth.verify`).',
    body: PhoneHandoffRedeem,
    response: PhoneHandoffRedeemed,
  }),
  reportPhoneHandoff: controlEndpoint({
    id: 'auth.reportPhoneHandoff',
    method: 'POST',
    path: '/auth/phone-handoffs/:handoffId/report',
    auth: 'session',
    summary:
      'The phone tells the browser what it needs: a pairing request to let in, or nothing more. Only the session the token was redeemed for (`not_found` otherwise); `handoff_expired` (410) after 15 minutes.',
    body: PhoneHandoffReport,
    response: z.object({ ok: z.literal(true) }),
  }),
};
