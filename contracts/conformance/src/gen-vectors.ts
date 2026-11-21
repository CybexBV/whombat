/**
 * Writes the conformance vectors (`vectors/*.json`) that both Vitest and `go test` check. Deterministic: fixed
 * development keys (derived from public seeds — never use them anywhere else), fixed times, Ed25519 is
 * deterministic. Run via `pnpm gen`; CI fails when the committed files differ.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { signDeviceRequest, signRegistration } from '@whombat/control-contracts/device';
import {
  type BackupServiceStatus,
  CONSOLE_DISPLAY_TEXT_RE,
  claimLookupLeaseValid,
  consoleDisplayUrl,
  consoleStateValid,
  DESK_SERVER_ID_RE,
  type DeskDecideRequest,
  DeskServerPage,
  DeskState,
  deskDecideNeedsPin,
  deskDecideRequestValid,
  deskServerPageValid,
  deskStateValid,
  deskTalkRequestValid,
  deskTalkSessionValid,
  revocationRef,
  type SupportEvent,
  type SupportState,
  summarizeBackup,
  supportEventValid,
  supportStateValid,
} from '@whombat/control-contracts/local';
import { canonicalJson, deriveSeedKeypair, hexToBytes, sha256Hex } from '@whombat/core/audit';
import {
  formatHelpCode,
  helpCodeFromBytes,
  normalizeHelpCode,
  REMOTE_HELP_DURATIONS,
  remoteHelpDurationSeconds,
  remoteHelpWho,
} from '@whombat/core/domain';
import { signSiteCard } from '@whombat/core/feedback/drop';
import {
  ADMISSION_ERROR_CLOSE,
  type AdmissionClaims,
  type AdmissionErrorCode,
  type AdmissionHeader,
  admissionJwk,
  BackupScope,
  base64urlEncode,
  type ClaimPakeContext,
  claimCardPassword,
  claimPakeCi,
  claimPakeInitiator,
  claimPakeInitiatorFinish,
  claimPakeResponder,
  claimSecretHash,
  claimVerifier,
  collabDataPayloads,
  diagnosticBundleBytes,
  ed25519Jwk,
  encodeCollabMessages,
  encodeFrame,
  type Frame,
  formatClaimCode,
  formatScreenSignInLetters,
  generateClaimLetters,
  generateScreenSignInLetters,
  isClaimSecret,
  LICENCE_GRACE_S,
  LICENCE_LIFETIME_S,
  type LicenceClaims,
  type LicenceHeader,
  type LicenceKeySet,
  type LicenceStatusParams,
  type LocalClaimPakeContext,
  licenceAudience,
  licenceStatus,
  localClaimPakeCi,
  localClaimPakeInitiator,
  localClaimPakeInitiatorFinish,
  localClaimPakeResponder,
  normalizeClaimCode,
  normalizeClaimSecret,
  normalizeScreenSignInLetters,
  pairingFingerprint,
  passkeyEnrollChallengeBase64url,
  passkeyRegisterChallengeBase64url,
  passkeyRemoteHelpChallengeBase64url,
  passkeyUserHandleBase64url,
  peerIdFromEd25519PublicKey,
  type ScreenSignInPakeContext,
  screenSignInPakeCi,
  screenSignInPakeInitiator,
  screenSignInPakeInitiatorFinish,
  screenSignInPakeResponder,
  signAdmissionTicket,
  signLicenceToken,
  utf8Encode,
} from '@whombat/protocol';
import {
  type BluetoothPairing,
  type BluetoothState,
  bluetoothPairingValid,
  bluetoothSignalFromDbm,
  bluetoothStateValid,
  type HostNetwork,
  hostNetworkValid,
  hostText,
  type NetworkChange,
  networkChangeValid,
  type RemoteHelpStep,
  remoteHelpStepValid,
  ssidValid,
  wifiSignalFromDbm,
} from '@whombat/protocol/session';
import {
  type AssignmentPayload,
  assignmentKeyMap,
  type ClientBundle,
  type ClientChannelPayload,
  checkActivation,
  checkCompatibleActivation,
  checkMigratingActivation,
  clientBelowFloor,
  clientBundleTarget,
  compareVersions,
  type IntRange,
  protocolOverlap,
  RETRYABLE_UPDATE_FAILURES,
  type ReleaseTuple,
  type SchemaFloors,
  type SchemaMigration,
  servesClient,
  signDocument,
  tupleDigest,
  updateClass,
} from '@whombat/release';
import { backupFileVectors } from './backup-file-vectors.ts';
import { feedbackDropVectors, VECTOR_SIGNING, vectorCard } from './feedback-drop-vectors.ts';
import { SCHEMA_CASES } from './schema-cases.ts';
import {
  DIAGNOSTIC_BUNDLES,
  PAIRING_FINGERPRINTS,
  PASSKEY_CHALLENGES,
  SESSION_VECTORS,
} from './session-cases.ts';

export const VECTOR_SEED = 'whombat-contracts-vectors';
const key = (name: string) => deriveSeedKeypair(name, VECTOR_SEED);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

/** The same signature with S replaced by S + L (non-canonical; strict verifiers refuse it). */
function nonCanonicalS(sig: Uint8Array): Uint8Array {
  const out = Uint8Array.from(sig);
  let S = 0n;
  for (let i = 63; i >= 32; i--) S = (S << 8n) | BigInt(out[i] as number);
  S += L;
  for (let i = 32; i < 64; i++) {
    out[i] = Number(S & 0xffn);
    S >>= 8n;
  }
  return out;
}

const le = (b: Uint8Array) => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);

/**
 * Cofactorless RFC 8032 verification with lax key decoding (what Go's crypto/ed25519 does on its own): canonical
 * S, `encode([S]B − [h]A) == R`, any encoding of A that decodes.
 */
function laxVerify(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  try {
    const A = ed25519.Point.fromBytes(pub, true);
    const S = le(sig.slice(32));
    if (S >= L || S === 0n) return false;
    const h = le(sha512(Uint8Array.from([...sig.slice(0, 32), ...pub, ...msg]))) % L;
    const R = ed25519.Point.BASE.multiply(S).subtract(A.multiplyUnsafe(h));
    return hex(R.toBytes()) === hex(sig.slice(0, 32));
  } catch {
    return false;
  }
}

/** Strict Ed25519 vectors (CT-15): what verifyEd25519Strict and Go's ed25519strict must refuse. */
function ed25519Vectors() {
  const k = key('ed25519-strict');
  const msg = utf8Encode('whombat strict ed25519');
  const sig = ed25519.sign(msg, hexToBytes(k.secretKey));
  // A "signature" valid for the identity point under cofactorless verification: R = [S]B.
  const S = 5n;
  const forged = new Uint8Array(64);
  forged.set(ed25519.Point.BASE.multiply(S).toBytes());
  forged[32] = Number(S);
  const identity = new Uint8Array(32);
  identity[0] = 1;
  const nonCanonicalIdentity = new Uint8Array(32).fill(0xff);
  nonCanonicalIdentity[0] = 0xee;
  nonCanonicalIdentity[31] = 0x7f;
  const order2 = new Uint8Array(32).fill(0xff);
  order2[0] = 0xec;
  order2[31] = 0x7f;
  const c = (name: string, publicKey: Uint8Array, signature: Uint8Array, expect: boolean) => ({
    name,
    publicKey: hex(publicKey),
    message: hex(msg),
    signature: hex(signature),
    expect,
    laxAccepts: laxVerify(publicKey, msg, signature),
  });
  return [
    c('valid', hexToBytes(k.publicKey), sig, true),
    c('non-canonical S (S + L)', hexToBytes(k.publicKey), nonCanonicalS(sig), false),
    c('small-order public key (identity), forged signature', identity, forged, false),
    c(
      'non-canonical public key (identity as y = p + 1), forged signature',
      nonCanonicalIdentity,
      forged,
      false,
    ),
    c('small-order public key of order 2 (y = −1), forged signature', order2, forged, false),
  ];
}

/* Admission -------------------------------------------------------------------------------------- */

function admission() {
  const k1 = key('admission-1');
  const k2 = key('admission-2');
  const sign = (sk: string) => (m: Uint8Array) => ed25519.sign(m, hexToBytes(sk));
  const jwks = {
    keys: [admissionJwk('adm-1', hexToBytes(k1.publicKey)), admissionJwk('adm-2', hexToBytes(k2.publicKey))],
  };
  const now = 1_790_000_000;
  const header: AdmissionHeader = { alg: 'EdDSA', kid: 'adm-1', typ: 'whombat-admission+jwt' };
  const claims: AdmissionClaims = {
    iss: 'https://api.dev.whombat.com',
    aud: 'whombat-relay:dev',
    rol: 'client',
    apl: 'apl_7Hq2mX',
    sub: 'acc_91xzQ',
    org: 'org_42',
    wrk: 'relay-eu-1',
    chn: 'app',
    iat: now,
    nbf: now,
    exp: now + 120,
    jti: 'vYt9-2mQx_7LkP0aZbW3cA',
  };
  const ok = signAdmissionTicket(header, claims, sign(k1.secretKey));
  const forge = (h: unknown, c: unknown, sk = k1.secretKey) => {
    const hp = `${base64urlEncode(utf8Encode(JSON.stringify(h)))}.${base64urlEncode(utf8Encode(JSON.stringify(c)))}`;
    return `${hp}.${base64urlEncode(sign(sk)(utf8Encode(hp)))}`;
  };
  const [h, p, s] = ok.split('.') as [string, string, string];
  const sigBytes = Buffer.from(s, 'base64url');
  sigBytes[10] = (sigBytes[10] as number) ^ 0x40;
  const base = { now, audience: 'whombat-relay:dev' };
  const { org: _org, ...unclaimed } = claims;
  const cases: Record<string, unknown>[] = [
    { name: 'valid client ticket', token: ok, ...base, expect: 'ok' },
    {
      name: 'valid with issuer and role',
      token: ok,
      ...base,
      issuer: claims.iss,
      role: 'client',
      expect: 'ok',
    },
    {
      name: 'valid appliance ticket signed by the second key',
      token: forge(
        { ...header, kid: 'adm-2' },
        { ...claims, rol: 'appliance', sub: 'dev_1', chn: 'app' },
        k2.secretKey,
      ),
      ...base,
      role: 'appliance',
      expect: 'ok',
    },
    { name: 'enrollment channel', token: forge(header, { ...claims, chn: 'enroll' }), ...base, expect: 'ok' },
    {
      name: 'unclaimed appliance (no org) on its worker',
      token: forge(header, { ...unclaimed, rol: 'appliance', sub: 'dev_1', chn: 'enroll' }),
      ...base,
      role: 'appliance',
      worker: 'relay-eu-1',
      expect: 'ok',
    },
    { name: 'ticket for another worker', token: ok, ...base, worker: 'relay-eu-2', expect: 'wrong_worker' },
    {
      name: 'non-canonical S (S + L)',
      token: `${h}.${p}.${base64urlEncode(nonCanonicalS(Buffer.from(s, 'base64url')))}`,
      ...base,
      expect: 'bad_signature',
    },
    { name: 'at the lower clock-skew edge', token: ok, ...base, now: now - 30, expect: 'ok' },
    { name: 'at the upper clock-skew edge', token: ok, ...base, now: now + 149, expect: 'ok' },
    { name: 'two segments', token: `${h}.${p}`, ...base, expect: 'malformed' },
    { name: 'padding in a segment', token: `${h}=.${p}.${s}`, ...base, expect: 'malformed' },
    {
      name: 'non-canonical base64url signature',
      token: `${h}.${p}.${s.slice(0, -1)}B`,
      ...base,
      expect: 'malformed',
    },
    { name: 'short signature', token: `${h}.${p}.${s.slice(0, 40)}`, ...base, expect: 'malformed' },
    {
      name: 'header not JSON',
      token: `${base64urlEncode(utf8Encode('{x'))}.${p}.${s}`,
      ...base,
      expect: 'malformed',
    },
    { name: 'too long', token: `${h}.${p}${'A'.repeat(4096)}.${s}`, ...base, expect: 'malformed' },
    { name: 'alg none', token: forge({ ...header, alg: 'none' }, claims), ...base, expect: 'bad_header' },
    { name: 'alg HS256', token: forge({ ...header, alg: 'HS256' }, claims), ...base, expect: 'bad_header' },
    { name: 'typ JWT', token: forge({ ...header, typ: 'JWT' }, claims), ...base, expect: 'bad_header' },
    {
      name: 'extra header member',
      token: forge({ ...header, jku: 'https://x' }, claims),
      ...base,
      expect: 'bad_header',
    },
    {
      name: 'unknown kid',
      token: forge({ ...header, kid: 'adm-9' }, claims),
      ...base,
      expect: 'unknown_kid',
    },
    {
      name: 'flipped signature bit',
      token: `${h}.${p}.${sigBytes.toString('base64url')}`,
      ...base,
      expect: 'bad_signature',
    },
    {
      name: 'signed by the other key',
      token: forge(header, claims, k2.secretKey),
      ...base,
      expect: 'bad_signature',
    },
    { name: 'extra claim', token: forge(header, { ...claims, adm: true }), ...base, expect: 'bad_claims' },
    {
      name: 'missing jti',
      token: forge(header, { ...claims, jti: undefined }),
      ...base,
      expect: 'bad_claims',
    },
    { name: 'short jti', token: forge(header, { ...claims, jti: 'abc' }), ...base, expect: 'bad_claims' },
    { name: 'role admin', token: forge(header, { ...claims, rol: 'admin' }), ...base, expect: 'bad_claims' },
    {
      name: 'fractional exp',
      token: forge(header, { ...claims, exp: now + 120.5 }),
      ...base,
      expect: 'bad_claims',
    },
    { name: 'wrong audience', token: ok, now, audience: 'whombat-relay:prod', expect: 'wrong_audience' },
    { name: 'wrong issuer', token: ok, ...base, issuer: 'https://api.whombat.com', expect: 'wrong_issuer' },
    { name: 'wrong role', token: ok, ...base, role: 'appliance', expect: 'wrong_role' },
    {
      name: 'lifetime 301 s',
      token: forge(header, { ...claims, exp: now + 301 }),
      ...base,
      expect: 'bad_lifetime',
    },
    {
      name: 'nbf before iat',
      token: forge(header, { ...claims, nbf: now - 1 }),
      ...base,
      expect: 'bad_lifetime',
    },
    {
      name: 'exp equals nbf',
      token: forge(header, { ...claims, exp: now }),
      ...base,
      expect: 'bad_lifetime',
    },
    { name: 'issued in the future', token: ok, ...base, now: now - 31, expect: 'not_yet_valid' },
    { name: 'expired', token: ok, ...base, now: now + 150, expect: 'expired' },
  ];
  for (const c of cases)
    if (c.expect !== 'ok') c.close = ADMISSION_ERROR_CLOSE[c.expect as AdmissionErrorCode];
  return {
    description:
      'Admission tickets (MA-06). Development keys only. `close` is the relay close code of a failure. Verification is strict Ed25519.',
    jwks,
    cases,
  };
}

/* Licence ---------------------------------------------------------------------------------------- */

/**
 * Licence tokens and states (LC-01, LC-09, CT-76). TEST keys only: derived from the public vector seed, bound to the
 * audience `whombat-appliance:test`. `admission-1` is the admission vectors' key, which must never pass as a licence
 * key.
 */
function licence() {
  const k1 = key('licence-1');
  const k2 = key('licence-2');
  const adm = key('admission-1');
  const sign = (sk: string) => (m: Uint8Array) => ed25519.sign(m, hexToBytes(sk));
  const keySet: LicenceKeySet = {
    v: 1,
    env: 'test',
    keys: [
      ed25519Jwk('lic-test-1', hexToBytes(k1.publicKey)),
      ed25519Jwk('lic-test-2', hexToBytes(k2.publicKey)),
    ],
  };
  const now = 1_790_000_000;
  const device = 'dev_7Hq2mXk3pZ';
  const header: LicenceHeader = { alg: 'EdDSA', kid: 'lic-test-1', typ: 'whombat-licence+jwt' };
  const claims: LicenceClaims = {
    iss: 'https://control.test.whombat.invalid',
    aud: licenceAudience('test'),
    sub: device,
    org: 'org_42',
    plan: 'whombat',
    state: 'active',
    limits: { devices: 2, connectors: null },
    iat: now,
    nbf: now,
    exp: now + LICENCE_LIFETIME_S,
    jti: 'Lk9-2mQx_7LkP0aZbW3cAq',
  };
  const ok = signLicenceToken(header, claims, sign(k1.secretKey));
  const forge = (h: unknown, c: unknown, sk = k1.secretKey) => {
    const hp = `${base64urlEncode(utf8Encode(JSON.stringify(h)))}.${base64urlEncode(utf8Encode(JSON.stringify(c)))}`;
    return `${hp}.${base64urlEncode(sign(sk)(utf8Encode(hp)))}`;
  };
  const [h, p, s] = ok.split('.') as [string, string, string];
  const sigBytes = Buffer.from(s, 'base64url');
  sigBytes[10] = (sigBytes[10] as number) ^ 0x40;
  const otherPayload = base64urlEncode(utf8Encode(JSON.stringify({ ...claims, plan: 'enterprise' })));
  const admissionTicket = signAdmissionTicket(
    { alg: 'EdDSA', kid: 'adm-1', typ: 'whombat-admission+jwt' },
    {
      iss: claims.iss,
      aud: 'whombat-relay:test',
      rol: 'appliance',
      apl: 'apl_7Hq2mX',
      sub: device,
      org: 'org_42',
      wrk: 'relay-eu-1',
      chn: 'app',
      iat: now,
      nbf: now,
      exp: now + 120,
      jti: 'vYt9-2mQx_7LkP0aZbW3cA',
    },
    sign(adm.secretKey),
  );
  const base = { device, now };
  const { limits: _limits, ...noLimits } = claims;
  const cases: Record<string, unknown>[] = [
    { name: 'valid', token: ok, ...base, expect: 'ok' },
    {
      name: 'valid, signed by the next key in the set',
      token: forge({ ...header, kid: 'lic-test-2' }, { ...claims, state: 'trialing' }, k2.secretKey),
      ...base,
      expect: 'ok',
    },
    { name: 'expired tokens still verify', token: ok, ...base, now: claims.exp + 86_400, expect: 'ok' },
    {
      name: 'cancelled org (a token all the same)',
      token: forge(header, {
        ...claims,
        state: 'cancelled',
        limits: { devices: 0, connectors: 0 },
      }),
      ...base,
      expect: 'ok',
    },
    { name: 'at the clock-skew edge', token: ok, ...base, now: now - 300, expect: 'ok' },
    { name: 'from the future', token: ok, ...base, now: now - 301, expect: 'not_yet_valid' },
    {
      name: 'nbf in the future',
      token: forge(header, { ...claims, nbf: now + 3_600 }),
      ...base,
      expect: 'not_yet_valid',
    },
    { name: 'tampered payload', token: `${h}.${otherPayload}.${s}`, ...base, expect: 'bad_signature' },
    {
      name: 'tampered signature',
      token: `${h}.${p}.${sigBytes.toString('base64url')}`,
      ...base,
      expect: 'bad_signature',
    },
    {
      name: 'non-canonical S (S + L)',
      token: `${h}.${p}.${base64urlEncode(nonCanonicalS(Buffer.from(s, 'base64url')))}`,
      ...base,
      expect: 'bad_signature',
    },
    {
      name: 'signed by the admission key under a licence kid',
      token: forge(header, claims, adm.secretKey),
      ...base,
      expect: 'bad_signature',
    },
    { name: 'another device', token: ok, ...base, device: 'dev_other', expect: 'wrong_device' },
    {
      name: 'audience of another environment',
      token: forge(header, { ...claims, aud: 'whombat-appliance:prod' }),
      ...base,
      expect: 'wrong_audience',
    },
    {
      name: 'a key set of another environment',
      token: ok,
      ...base,
      keySet: { ...keySet, env: 'prod' },
      expect: 'wrong_audience',
    },
    {
      name: 'unknown kid',
      token: forge({ ...header, kid: 'lic-test-9' }, claims),
      ...base,
      expect: 'unknown_kid',
    },
    {
      name: 'the admission key (not in the set)',
      token: forge({ ...header, kid: 'adm-1' }, claims, adm.secretKey),
      ...base,
      expect: 'unknown_kid',
    },
    { name: 'an admission ticket', token: admissionTicket, ...base, expect: 'bad_header' },
    {
      name: 'admission typ over licence claims',
      token: forge({ ...header, typ: 'whombat-admission+jwt' }, claims),
      ...base,
      expect: 'bad_header',
    },
    { name: 'alg none', token: forge({ ...header, alg: 'none' }, claims), ...base, expect: 'bad_header' },
    {
      name: 'extra header member',
      token: forge({ ...header, jku: 'https://x.invalid' }, claims),
      ...base,
      expect: 'bad_header',
    },
    {
      name: 'lifetime over 14 days',
      token: forge(header, { ...claims, exp: now + LICENCE_LIFETIME_S + 1 }),
      ...base,
      expect: 'bad_lifetime',
    },
    {
      name: 'nbf before iat',
      token: forge(header, { ...claims, nbf: now - 1 }),
      ...base,
      expect: 'bad_lifetime',
    },
    {
      name: 'exp equals nbf',
      token: forge(header, { ...claims, exp: now }),
      ...base,
      expect: 'bad_lifetime',
    },
    { name: 'extra claim', token: forge(header, { ...claims, adm: true }), ...base, expect: 'bad_claims' },
    { name: 'missing limits', token: forge(header, noLimits), ...base, expect: 'bad_claims' },
    {
      name: 'missing a limit',
      token: forge(header, { ...claims, limits: { devices: 2 } }),
      ...base,
      expect: 'bad_claims',
    },
    {
      name: 'a member limit (none since 3.0)',
      token: forge(header, { ...claims, limits: { devices: 2, members: 10, connectors: null } }),
      ...base,
      expect: 'bad_claims',
    },
    {
      name: 'unknown entitlement state',
      token: forge(header, { ...claims, state: 'paused' }),
      ...base,
      expect: 'bad_claims',
    },
    {
      name: 'plan in upper case',
      token: forge(header, { ...claims, plan: 'Team' }),
      ...base,
      expect: 'bad_claims',
    },
    { name: 'short jti', token: forge(header, { ...claims, jti: 'abc' }), ...base, expect: 'bad_claims' },
    {
      name: 'fractional exp',
      token: forge(header, { ...claims, exp: now + 1_000.5 }),
      ...base,
      expect: 'bad_claims',
    },
    { name: 'two segments', token: `${h}.${p}`, ...base, expect: 'malformed' },
    { name: 'padding in a segment', token: `${h}=.${p}.${s}`, ...base, expect: 'malformed' },
    {
      name: 'oversize (over 4 KiB)',
      token: `${h}.${p}${'A'.repeat(4096)}.${s}`,
      ...base,
      expect: 'malformed',
    },
  ];

  const day = 86_400;
  const exp = claims.exp;
  const graceEnd = exp + LICENCE_GRACE_S;
  const claimedAt = now - 10 * day;
  const at = (
    name: string,
    input: Partial<LicenceStatusParams> & { now: number },
  ): Record<string, unknown> => {
    const full: LicenceStatusParams = { claims, highWater: 0, clockMark: 0, claimedAt, ...input };
    return { name, input: full, expect: licenceStatus(full) };
  };
  const status = [
    at('active, valid', { now: now + day }),
    at('trialing', { claims: { ...claims, state: 'trialing' }, now: now + day }),
    at('past due (licensed, a note)', { claims: { ...claims, state: 'past_due' }, now: now + day }),
    at('entitlement in grace', { claims: { ...claims, state: 'grace' }, now: now + day }),
    at('cancelled', { claims: { ...claims, state: 'cancelled' }, now: now + day }),
    at('cancelled long ago', { claims: { ...claims, state: 'cancelled' }, now: graceEnd + day }),
    at('last second before exp', { now: exp - 1 }),
    at('at exp: not renewed', { now: exp }),
    at('entitlement in grace, then expired', { claims: { ...claims, state: 'grace' }, now: exp + day }),
    at('last second of grace', { now: graceEnd - 1 }),
    at('grace over: expired', { now: graceEnd }),
    at('clock rolled back, high-water mark within validity', { now: now - 90 * day, highWater: now + day }),
    at('clock rolled back past exp: the high-water mark wins', { now: now, highWater: exp + day }),
    at('clock mark after the grace', { now: now + day, highWater: now + day, clockMark: graceEnd }),
    at('no token, claimed ten days ago', { claims: null, now }),
    at('no token, 30 days after the claim', { claims: null, now: claimedAt + LICENCE_GRACE_S }),
    at('no token, clock rolled back', {
      claims: null,
      now: claimedAt,
      clockMark: claimedAt + LICENCE_GRACE_S,
    }),
    at('no token, unclaimed', { claims: null, claimedAt: null, now }),
    at('token without a claim time', { claimedAt: null, now: now + day }),
    at('a shorter grace', { now: exp + 2 * day, graceS: day }),
  ];
  return {
    description:
      'Appliance licence tokens (LC-01) and states (LC-09). TEST keys only, never used anywhere else. `cases`: verify `token` with `keySet` (or the case’s own), `device` and `now` (the effective time); `expect` is `ok` or the error code (expiry is never an error). `status`: `licenceStatus(input)` = `expect` (epoch seconds; null: no licence state).',
    keySet,
    cases,
    status,
  };
}

/* Frames ----------------------------------------------------------------------------------------- */

type FrameJson =
  | { type: 'control' | 'data'; streamId: number; payloadHex: string }
  | { type: 'credit'; streamId: number; credit: number }
  | { type: 'end'; streamId: number }
  | { type: 'reset'; streamId: number; code: number };

function frameJson(f: Frame): FrameJson {
  switch (f.type) {
    case 'control':
    case 'data':
      return { type: f.type, streamId: f.streamId, payloadHex: hex(f.payload) };
    case 'credit':
      return { type: 'credit', streamId: f.streamId, credit: f.credit };
    case 'end':
      return { type: 'end', streamId: f.streamId };
    case 'reset':
      return { type: 'reset', streamId: f.streamId, code: f.code };
  }
}

function frames() {
  const valid: Frame[][] = [
    [{ type: 'control', streamId: 0, payload: utf8Encode('{"t":"ping","n":1}') }],
    [{ type: 'data', streamId: 1, payload: new Uint8Array([0, 255, 1, 254]) }],
    [{ type: 'data', streamId: 3, payload: new Uint8Array(65_536).fill(0xab) }],
    [{ type: 'credit', streamId: 1, credit: 262_144 }],
    [{ type: 'credit', streamId: 1, credit: 16_777_216 }],
    [{ type: 'end', streamId: 5 }],
    [{ type: 'reset', streamId: 0xffff_ffff, code: 5 }],
    [
      { type: 'control', streamId: 0, payload: utf8Encode('{"t":"open","stream":1}') },
      { type: 'data', streamId: 1, payload: new Uint8Array([1, 2, 3]) },
      { type: 'end', streamId: 1 },
    ],
  ];
  const cases: unknown[] = valid.map((fs, i) => ({
    name: `valid ${i}: ${fs.map((f) => f.type).join('+')}`,
    hex: fs.map((f) => hex(encodeFrame(f))).join(''),
    frames: fs.map(frameJson),
    pending: 0,
  }));
  cases.push(
    {
      name: 'truncated after a complete frame',
      hex: `${hex(encodeFrame({ type: 'end', streamId: 1 }))}000000070500`,
      frames: [{ type: 'end', streamId: 1 }],
      pending: 6,
    },
    { name: 'length 4 (shorter than the body header)', hex: '0000000401000000', error: 'frame_too_short' },
    { name: 'length above the maximum', hex: '0001000a', error: 'frame_too_large' },
    { name: 'unknown type 0x06', hex: '000000050600000001', error: 'unknown_type' },
    { name: 'control on stream 1', hex: '00000006010000000178', error: 'bad_stream' },
    { name: 'data on stream 0', hex: '00000006020000000078', error: 'bad_stream' },
    { name: 'empty control', hex: '000000050100000000', error: 'bad_payload' },
    { name: 'empty data', hex: '000000050200000001', error: 'bad_payload' },
    { name: 'credit of 3 bytes', hex: '00000008030000000100 0100'.replace(/ /g, ''), error: 'bad_payload' },
    { name: 'credit zero', hex: '000000090300000001 00000000'.replace(/ /g, ''), error: 'bad_payload' },
    {
      name: 'credit above 16 MiB',
      hex: '000000090300000001 01000001'.replace(/ /g, ''),
      error: 'bad_payload',
    },
    { name: 'end with payload', hex: '00000006040000000100', error: 'bad_payload' },
    { name: 'reset with 1 byte', hex: '00000006050000000100', error: 'bad_payload' },
  );
  return {
    description:
      'Session frames: [u32 length BE][u8 type][u32 streamId BE][payload]. Decode `hex` as one byte stream: expect `frames` (and `pending` unconsumed bytes) or `error` (FrameErrorCode). Valid cases must also re-encode to `hex`.',
    cases,
  };
}

/* Signed documents ------------------------------------------------------------------------------- */

function signed() {
  const mgmt = key('device-dev_1-management');
  const now = 1_790_000_000;
  const push = signDeviceRequest(
    {
      aud: 'whombat-api:dev',
      device: 'dev_1',
      op: 'push.send',
      ts: now,
      nonce: '00112233445566778899aabbccddeeff',
      body: {
        kind: 'approval',
        ref: 'q3Vx9LpA0dZkT7mW2bNcYe',
        handles: ['hNd1e_0123456789abcdefgh'],
        ttlS: 600,
      },
    },
    mgmt.secretKey,
  );
  const status = signDeviceRequest(
    {
      aud: 'whombat-api:dev',
      device: 'dev_1',
      op: 'status.report',
      ts: now + 60,
      nonce: 'ffeeddccbbaa99887766554433221100',
      body: {
        release: 'rt-2026.09.25-1',
        managerVersion: '0.1.0',
        uptimeS: 86_400,
        update: { state: 'Healthy', candidate: null, attempt: 0, failure: null },
        health: {
          runtime: 'ok',
          database: 'ok',
          runner: 'degraded',
          sessionEndpoint: 'ok',
          relay: 'ok',
          backup: 'stale',
        },
        storage: { persistUsedPct: 41, persistFreeBytes: 512_000_000_000 },
        sessionsActive: 3,
        recoveryKit: 'confirmed',
        lastBackupAt: now - 7200,
        clockSynced: true,
      },
    },
    mgmt.secretKey,
  );
  // A card holds free text (Unicode, HTML-ish characters): Go's canonical JSON must match TypeScript's over it.
  const cardsSync = signDeviceRequest(
    {
      aud: 'whombat-api:dev',
      device: 'dev_1',
      op: 'feedback.cards.sync',
      ts: now,
      nonce: '0123456789abcdef0123456789abcdef',
      body: { seq: 18, cards: [signSiteCard(vectorCard(), VECTOR_SIGNING.seed)] },
    },
    mgmt.secretKey,
  );
  // Above DEVICE_REQUEST_MAX_BYTES, within FEEDBACK_CARDS_SYNC_MAX_BYTES (deviceRequestMaxBytes, CT-91).
  const bigCards = Array.from({ length: 6 }, (_, i) =>
    signSiteCard(
      vectorCard({
        seq: 20 + i,
        site: `fbs_${String(i).repeat(24)}`,
        config: { ...vectorCard().config, productLabel: 'x'.repeat(12_000) },
      }),
      VECTOR_SIGNING.seed,
    ),
  );
  const bigSync = signDeviceRequest(
    {
      aud: 'whombat-api:dev',
      device: 'dev_1',
      op: 'feedback.cards.sync',
      ts: now,
      nonce: '1123456789abcdef0123456789abcdef',
      body: { seq: 26, cards: bigCards },
    },
    mgmt.secretKey,
  );
  const bigAck = signDeviceRequest(
    {
      aud: 'whombat-api:dev',
      device: 'dev_1',
      op: 'feedback.drops.ack',
      ts: now,
      nonce: '2123456789abcdef0123456789abcdef',
      body: { dropIds: ['fdr_q3Vx9LpA0dZkT7mW2bNcYe'], padding: 'x'.repeat(70_000) } as never,
    },
    mgmt.secretKey,
  );
  const ctx = { audience: 'whombat-api:dev', publicKeys: { dev_1: mgmt.publicKey } };
  const deviceRequests = [
    { name: 'push.send', envelope: push, now, expect: 'ok' },
    { name: 'status.report', envelope: status, now: now + 60, expect: 'ok' },
    { name: 'feedback.cards.sync with free text', envelope: cardsSync, now, expect: 'ok' },
    { name: 'feedback.cards.sync above 64 KiB', envelope: bigSync, now, expect: 'ok' },
    { name: 'other op above 64 KiB', envelope: bigAck, now, expect: 'too_large' },
    { name: 'clock skew 300 s', envelope: push, now: now + 300, expect: 'ok' },
    { name: 'stale by 301 s', envelope: push, now: now + 301, expect: 'stale' },
    {
      name: 'tampered body',
      envelope: { ...push, body: { ...push.body, ttlS: 601 } },
      now,
      expect: 'bad_signature',
    },
    { name: 'tampered op', envelope: { ...push, op: 'update.progress' }, now, expect: 'bad_signature' },
    {
      name: 'other audience',
      envelope: push,
      now,
      audience: 'whombat-api:prod',
      expect: 'wrong_audience',
    },
    { name: 'unknown device', envelope: { ...push, device: 'dev_2' }, now, expect: 'unknown_device' },
    { name: 'unknown op', envelope: { ...push, op: 'shell.exec' }, now, expect: 'bad_envelope' },
    { name: 'extra envelope member', envelope: { ...push, x: 1 }, now, expect: 'bad_envelope' },
    {
      name: 'valid signature over an invalid body',
      envelope: signDeviceRequest(
        {
          aud: 'whombat-api:dev',
          device: 'dev_1',
          op: 'push.send',
          ts: now,
          nonce: 'aa'.repeat(16),
          body: { kind: 'approval', ref: 'x', handles: [], ttlS: 1 },
        },
        mgmt.secretKey,
      ),
      now,
      expect: 'bad_body',
    },
  ];

  const content = key('device-dev_1-content');
  const unsignedRegistration = {
    env: 'dev' as const,
    hardwareSerial: 'WB1-000123',
    model: 'wb-mini-1',
    managementPublicKey: mgmt.publicKey,
    contentPeerId: peerIdFromEd25519PublicKey(hexToBytes(content.publicKey)),
    contentPublicKey: content.publicKey,
    provisionedAt: now,
  };
  const bothKeys = { managementSecretKeyHex: mgmt.secretKey, contentSecretKeyHex: content.secretKey };
  const registration = signRegistration(unsignedRegistration, bothKeys);
  const other = key('device-dev_2-content');
  const registrations = [
    { name: 'valid', registration, expect: true },
    {
      name: 'serial changed',
      registration: { ...registration, hardwareSerial: 'WB1-000124' },
      expect: false,
    },
    { name: 'other environment', registration: { ...registration, env: 'prod' }, expect: false },
    {
      name: 'content proof by the management key',
      registration: { ...registration, contentProof: registration.proof },
      expect: false,
    },
    {
      name: 'content PeerId of another key',
      registration: signRegistration(
        { ...unsignedRegistration, contentPeerId: peerIdFromEd25519PublicKey(hexToBytes(other.publicKey)) },
        bothKeys,
      ),
      expect: false,
    },
    {
      name: 'same key for management and content',
      registration: signRegistration(
        {
          ...unsignedRegistration,
          contentPublicKey: mgmt.publicKey,
          contentPeerId: peerIdFromEd25519PublicKey(hexToBytes(mgmt.publicKey)),
        },
        { managementSecretKeyHex: mgmt.secretKey, contentSecretKeyHex: mgmt.secretKey },
      ),
      expect: false,
    },
  ];
  const peerIds = [mgmt, content, other].map((kp) => ({
    publicKey: kp.publicKey,
    peerId: peerIdFromEd25519PublicKey(hexToBytes(kp.publicKey)),
  }));

  const asg = key('assignment-1');
  const tuple = {
    releaseId: 'rt-2026.10.01-1',
    runtime: {
      version: '2026.10.01-1',
      storePath: `/nix/store/${'a'.repeat(32)}-whombat-runtime`,
      narHash: `sha256:${'a'.repeat(64)}`,
      schemaReads: { min: 12, max: 14 },
      schemaWrites: 14,
      protocol: { min: 1000, max: 1000 },
      hostAbi: { min: 1, max: 1 },
    },
    providers: [],
    host: {
      version: '26.05.1',
      storePath: `/nix/store/${'c'.repeat(32)}-nixos-system`,
      narHash: `sha256:${'c'.repeat(64)}`,
      abi: 1,
    },
    manager: {
      version: '0.1.0',
      storePath: `/nix/store/${'d'.repeat(32)}-whombat-manager`,
      narHash: `sha256:${'d'.repeat(64)}`,
    },
  };
  const payload: AssignmentPayload = {
    purpose: 'whombat-update-assignment/v1',
    env: 'dev',
    device: 'dev_1',
    sequence: 7,
    action: 'install',
    releaseId: tuple.releaseId,
    tupleDigest: tupleDigest(tuple),
    rolloutId: 'ro_1',
    cohort: 'pilot',
    issuedAt: now,
    notBefore: now,
    expiresAt: now + 86_400,
  };
  const doc = signDocument(payload, 'asg-1', asg.secretKey);
  const hold = signDocument(
    { ...payload, sequence: 8, action: 'hold', releaseId: null, tupleDigest: null },
    'asg-1',
    asg.secretKey,
  );
  const actx = { env: 'dev', device: 'dev_1', lastSequence: 6 };
  const assignments = [
    { name: 'install', doc, now, ...actx, expect: 'ok' },
    { name: 'hold', doc: hold, now, ...actx, expect: 'ok' },
    { name: 'replayed sequence', doc, now, ...actx, lastSequence: 7, expect: 'replayed' },
    { name: 'other device', doc, now, ...actx, device: 'dev_2', expect: 'wrong_device' },
    { name: 'other env', doc, now, ...actx, env: 'prod', expect: 'wrong_env' },
    { name: 'expired', doc, now: now + 86_400 + 300, ...actx, expect: 'expired' },
    { name: 'issued in the future', doc, now: now - 301, ...actx, expect: 'not_yet_valid' },
    { name: 'unknown key', doc: { ...doc, keyId: 'asg-9' }, now, ...actx, expect: 'unknown_key' },
    {
      name: 'tampered release',
      doc: { ...doc, payload: { ...payload, releaseId: 'rt-evil' } },
      now,
      ...actx,
      expect: 'bad_signature',
    },
    {
      name: 'install without a digest',
      doc: signDocument({ ...payload, tupleDigest: null }, 'asg-1', asg.secretKey),
      now,
      ...actx,
      expect: 'bad_action',
    },
    {
      name: 'lifetime above 7 days',
      doc: signDocument({ ...payload, expiresAt: now + 7 * 86_400 + 1 }, 'asg-1', asg.secretKey),
      now,
      ...actx,
      expect: 'bad_lifetime',
    },
    { name: 'schema violation', doc: { ...doc, extra: true }, now, ...actx, expect: 'bad_schema' },
  ];

  const canonical = [
    { a: 1, b: [true, null, 'x'], c: { z: 0, y: -1 } },
    { '€': 1, a: 2, A: 3, é: 4, '😀': 5, דּ: 6 },
    { s: 'line\nbreak "quoted" \\ \u0001 \u007f é 😀  ' },
    { n: [0, -0, 9007199254740991, -9007199254740991, 1000000] },
    { purpose: 'whombat-device-request/v1', body: {}, list: [] },
  ].map((value) => ({ value, canonical: canonicalJson(value) }));

  return {
    description:
      'Ed25519 over canonical JSON (RFC 8785): device-signed requests, provisioning registrations (management + content key), update assignments. Development keys only. `canonical` checks JCS parity (integers only). `ed25519`: strict verification (`expect`); `laxAccepts` records whether cofactorless verification without the key checks (Go crypto/ed25519 alone) would accept.',
    tupleDigest: { tuple, digest: tupleDigest(tuple) },
    deviceRequests: { ...ctx, cases: deviceRequests },
    registrations,
    peerIds,
    ed25519: ed25519Vectors(),
    assignments: { keys: { 'asg-1': asg.publicKey }, cases: assignments },
    canonical,
  };
}

function collab() {
  const m = (...b: number[]) => Uint8Array.from(b);
  const big = Uint8Array.from({ length: 300 }, (_, i) => i % 251);
  const valid = [
    { name: 'one sync message in one frame', messages: [m(0, 0, 1, 7)], maxData: 65_536 },
    { name: 'sync + awareness in one frame', messages: [m(0, 1, 2), m(1, 5, 9, 9)], maxData: 65_536 },
    { name: 'a message spanning frames (maxData 7)', messages: [big], maxData: 7 },
    { name: 'prefix split across frames (maxData 3)', messages: [m(0, 2, 1), m(1, 1)], maxData: 3 },
  ].map((c) => {
    const encoded = encodeCollabMessages(c.messages);
    return {
      name: c.name,
      messages: c.messages.map(hex),
      encoded: hex(encoded),
      maxData: c.maxData,
      payloads: collabDataPayloads(encoded, c.maxData).map(hex),
      pending: 0,
    };
  });
  return {
    description:
      'Collab streams (CT-22): Yjs messages framed [u32 len BE][bytes] across DATA payloads. Encode `messages` → `encoded`, split by `maxData` → `payloads`; decoding `payloads` yields `messages` (and `pending` bytes) or `error`.',
    cases: [
      ...valid,
      {
        name: 'incomplete 16 MiB message (length at the cap is allowed)',
        payloads: ['01000000aa'],
        messages: [],
        pending: 5,
      },
      { name: 'empty message', payloads: ['00000000'], error: 'empty_message' },
      { name: 'length above 16 MiB', payloads: ['01000001'], error: 'message_too_large' },
      { name: 'error after a complete message', payloads: ['000000010000000000'], error: 'empty_message' },
    ],
  };
}

/**
 * Every code point a one-character `ConsoleDisplayText` refuses, as inclusive ranges (CT-116): Go compiles the same
 * pattern with RE2 and must refuse exactly these (surrogates aside, which a Go string can't hold), so the Unicode
 * tables of both sides are compared, not assumed.
 */
function displayTextRejected(): [number, number][] {
  const ranges: [number, number][] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (CONSOLE_DISPLAY_TEXT_RE.test(String.fromCodePoint(cp))) continue;
    const last = ranges.at(-1);
    if (last && last[1] === cp - 1) last[1] = cp;
    else ranges.push([cp, cp]);
  }
  return ranges;
}

/**
 * Server screens for `deskServerPageValid` (0.115, CT-866): the valid `DeskServerPage` schema cases, and the full one
 * broken in each way one schema can't see (and its edges). All are schema-valid.
 */
function deskServerPages(): DeskServerPage[] {
  const valid = SCHEMA_CASES.filter((c) => c.schema === 'DeskServerPage' && c.valid).map((c) =>
    DeskServerPage.parse(c.output ?? c.value),
  );
  const full = valid[0] as DeskServerPage;
  const guests = full.guests as NonNullable<DeskServerPage['guests']>;
  const alert = { tone: 'bad' as const, title: 'Disk local-zfs is 96 % full' };
  const { id: _id, ...withoutId } = full.server;
  return [
    ...valid,
    // Broken: the chart's series unequal, more alert titles than alerts, more guests than counted, no id.
    { ...full, history: { ...full.history, memory: full.history.memory.slice(1) } },
    { ...full, history: { ...full.history, cpu: [], memory: [50] } },
    { ...full, alerts: { count: 0, items: [alert] } },
    { ...full, alerts: { count: 1, items: [alert, alert] } },
    { ...full, guests: { ...guests, running: 3, off: 1 } },
    { ...full, guests: { ...guests, running: 0, off: 0 } },
    { ...full, server: withoutId },
    // Edges: exactly as many alert titles as alerts, and guests as counted; more counted than named.
    { ...full, alerts: { count: 1, items: [alert] } },
    { ...full, guests: { ...guests, running: 4, off: 0, items: guests.items.slice(0, 4) } },
    { ...full, guests: { ...guests, running: 12, off: 3 } },
    { ...full, guests: { running: 0, off: 0, items: [] } },
  ].map((page) => JSON.parse(JSON.stringify(page)) as DeskServerPage);
}

/**
 * Conversations with the assistant working and server tasks as rows (0.116, CT-894, CT-895) for `deskTalkSessionValid`:
 * a task's `endedAt` exactly when not running, a `result` only then, never with an ask; `working` only while open.
 */
function deskTaskSessions() {
  const until = '2026-10-20T13:00:00Z';
  const running = {
    title: 'Installing 23 updates on Home Assistant',
    state: 'running' as const,
    startedAt: '2026-10-20T12:31:10Z',
  };
  const ended = {
    ...running,
    state: 'ok' as const,
    endedAt: '2026-10-20T12:35:12Z',
    result: 'Home Assistant is up to date: 23 updates installed.',
  };
  const message = (task: Record<string, unknown>, ask?: Record<string, unknown>) => ({
    id: 'msg_Lp7e3QrT1dYw',
    from: 'assistant' as const,
    at: '2026-10-20T12:31:10Z',
    paragraphs: ['Installing 23 updates on Home Assistant'],
    task,
    ...(ask ? { ask } : {}),
  });
  const working = { since: '2026-10-20T12:31:00Z', doing: 'Installing updates on Home Assistant' };
  const open = (messages: ReturnType<typeof message>[], extra: Record<string, unknown> = {}) => ({
    v: 1,
    open: true,
    messages,
    earlier: 0,
    until,
    ...extra,
  });
  return [
    // Valid: running, ended with its words, ended without words, lost, failed with its reason, the assistant working.
    open([message(running)]),
    open([message(ended)]),
    open([message({ ...ended, result: undefined })]),
    open([message({ ...ended, state: 'lost', result: 'Whombat lost track of this task.' })]),
    open([message({ ...ended, state: 'error', result: 'Backing up web on pve-02 didn’t work.' })]),
    open([message(running)], { working }),
    open([], { working: { since: working.since } }),
    // Broken: running with an end or words, ended without an end, with an ask, working on a closed conversation.
    open([message({ ...running, endedAt: ended.endedAt })]),
    open([message({ ...running, result: ended.result })]),
    open([message({ ...ended, endedAt: undefined })]),
    open([message({ ...ended, state: 'warning', endedAt: undefined })]),
    open([message(running, { number: 12, state: 'waiting' })]),
    { v: 1, open: false, messages: [], earlier: 0, working },
  ].map((session) => JSON.parse(JSON.stringify(session)));
}

/** `decide` requests (0.116, CT-891): a scope only with approve; the PIN for a wider scope or an ask that needs it. */
const DESK_DECIDE_REQUESTS: DeskDecideRequest[] = [
  { v: 1, number: 12, decision: 'approve' },
  { v: 1, number: 12, decision: 'approve', scope: 'once' },
  { v: 1, number: 12, decision: 'approve', scope: 'task', pin: '2580' },
  { v: 1, number: 12, decision: 'approve', scope: 'agent', pin: '2580' },
  { v: 1, number: 12, decision: 'approve', scope: 'agent' },
  { v: 1, number: 12, decision: 'deny' },
  { v: 1, number: 12, decision: 'decline' },
  { v: 1, number: 12, decision: 'deny', scope: 'agent' },
  { v: 1, number: 12, decision: 'decline', scope: 'once' },
];

/** Server ids on the desk (0.115, CT-862): the hosts service's slugs, an older hub's with dots, and what isn't one. */
const DESK_SERVER_IDS = [
  'pve-01',
  'nas',
  'a',
  '7',
  'pve01.home.lan',
  'node:2',
  'Blackbox_2',
  `p${'x'.repeat(127)}`,
  `p${'x'.repeat(128)}`,
  '',
  '.nas',
  '..',
  '-nas',
  'pve/01',
  '../nas',
  'pve 01',
  'pve-01\n',
  'pvé-01',
];

/**
 * Desk states for `deskStateValid` (CT-530): valid `DeskState` schema cases, and a lean base state broken in each way
 * one schema can't see. All are schema-valid.
 */
function deskStates(): DeskState[] {
  const boxBroken = (fresh: DeskState): DeskState[] => {
    const g = fresh.glance as NonNullable<DeskState['glance']>;
    const box = g.box as NonNullable<typeof g.box>;
    const paired = fresh.paired as NonNullable<DeskState['paired']>;
    const server = { name: 'pve-02', mark: 'proxmox', state: 'ok' as const, note: 'up 41 d' };
    return [
      { ...fresh, glance: { ...g, servers: [server] } },
      {
        ...fresh,
        glance: { ...g, tiles: [{ icon: 'temperature', value: '21.4 °C', label: 'Living room' }] },
      },
      { ...fresh, paired: { ...paired, lockedView: 'time' } },
      { ...fresh, paired: { ...paired, lockedView: 'time' }, lock: { state: 'phone', expiresAt: fresh.now } },
      { ...fresh, glance: { ...g, box: { ...box, history: { ...box.history, memory: [17, 18] } } } },
    ];
  };
  // 0.104 (CT-601, CT-602): This Whombat beside servers or tiles, servers and tiles five to eight.
  const fitBroken = (beside: DeskState, fresh: DeskState, eight: DeskState): DeskState[] => {
    const g = beside.glance as NonNullable<DeskState['glance']>;
    const self = g.self as NonNullable<typeof g.self>;
    const paired = beside.paired as NonNullable<DeskState['paired']>;
    const fg = fresh.glance as NonNullable<DeskState['glance']>;
    const eg = eight.glance as NonNullable<DeskState['glance']>;
    return [
      { ...beside, glance: { ...g, box: self } },
      { ...fresh, glance: { ...fg, self: fg.box } },
      { ...beside, glance: { ...g, servers: [], tiles: [] } },
      { ...beside, paired: { ...paired, lockedView: 'time' } },
      {
        ...beside,
        paired: { ...paired, lockedView: 'time' },
        lock: { state: 'phone', expiresAt: beside.now },
      },
      { ...beside, glance: { ...g, self: { ...self, history: { ...self.history, cpu: [9, 7] } } } },
      { ...eight, glance: { ...eg, servers: eg.servers.slice(0, 3) } },
      { ...eight, glance: { ...eg, moreServers: 3 } },
      { ...eight, glance: { ...eg, tiles: eg.tiles.slice(0, 3) } },
    ];
  };
  // 0.104 (CT-601, CT-602): This Whombat beside servers unlocked in Only the time; an empty list says nothing,
  // wherever it is; moreServers exactly the extra servers.
  // 0.110 (CT-700): found on your network, not in Only the time locked; its own rules (deskFoundValid).
  const foundBroken = (panel: DeskState): DeskState[] => {
    const g = panel.glance as NonNullable<DeskState['glance']>;
    const f = g.found as NonNullable<typeof g.found>;
    const paired = panel.paired as NonNullable<DeskState['paired']>;
    const withFound = (patch: Partial<typeof f>) => ({
      ...panel,
      glance: { ...g, found: { ...f, ...patch } },
    });
    return [
      { ...panel, paired: { ...paired, lockedView: 'time' } },
      { ...panel, paired: { ...paired, lockedView: 'time' }, lock: { state: 'phone', expiresAt: panel.now } },
      withFound({ count: f.items.length - 1 }),
      withFound({ finishedAt: null }),
      withFound({ progress: { done: 10, total: 1022 } }),
      withFound({ scanning: true, progress: { done: 10, total: 1022 } }),
      withFound({ scanning: true, finishedAt: null, progress: { done: 1023, total: 1022 } }),
      withFound({ items: [], count: 0 }),
      withFound({ scanning: true, items: [], count: 0 }),
    ];
  };
  // 0.110 (CT-700): unlocked in Only the time it shows; a later scan keeps the last result; the first one before it
  // knows how many addresses; done equal to total.
  const foundEdges = (panel: DeskState): DeskState[] => {
    const g = panel.glance as NonNullable<DeskState['glance']>;
    const f = g.found as NonNullable<typeof g.found>;
    const withFound = (patch: Partial<typeof f>) => ({
      ...panel,
      glance: { ...g, found: { ...f, ...patch } },
    });
    return [
      {
        ...panel,
        paired: { ...(panel.paired as NonNullable<DeskState['paired']>), lockedView: 'time' },
        lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z' },
      },
      withFound({ scanning: true }),
      withFound({ scanning: true, finishedAt: null, progress: null }),
      withFound({ scanning: true, finishedAt: null, progress: { done: 1022, total: 1022 } }),
      withFound({ items: f.items.slice(0, 1), count: 1 }),
    ];
  };
  // 0.116 (CT-890): an ask's wider choices.
  const withChoicesAsk = (
    choices: DeskState,
    patch: Record<string, unknown>,
    other: Partial<DeskState> = {},
  ) => {
    const g = choices.glance as NonNullable<DeskState['glance']>;
    const a = g.needsYou.items[0] as (typeof g.needsYou.items)[number];
    return { ...choices, glance: { ...g, needsYou: { count: 1, items: [{ ...a, ...patch }] } }, ...other };
  };
  const choicesBroken = (choices: DeskState): DeskState[] => {
    const paired = choices.paired as NonNullable<DeskState['paired']>;
    const locked = { lock: { state: 'locked' as const } };
    return [
      // Locked: the ask's words go too, so only the choices are left to break it.
      withChoicesAsk(choices, { detail: undefined, facts: undefined, approveLabel: undefined }, locked),
      withChoicesAsk(choices, { onDesk: false, phoneReason: 'release' }),
      withChoicesAsk(choices, {}, { paired: { ...paired, hasPin: false } }),
      withChoicesAsk(choices, {
        choices: [
          { scope: 'agent', label: 'Don’t ask again on Home Assistant' },
          { scope: 'agent', label: 'Always allow Neo to install updates' },
        ],
      }),
    ];
  };
  const choicesEdges = (choices: DeskState): DeskState[] => {
    const paired = choices.paired as NonNullable<DeskState['paired']>;
    return [
      withChoicesAsk(choices, { onDesk: false, phoneReason: 'release', approveWithPin: true }),
      withChoicesAsk(choices, {}, { paired: { ...paired, hasPin: true, pinDigits: 4 } }),
      withChoicesAsk(choices, {
        choices: [
          { scope: 'task', label: 'Allow for this task' },
          { scope: 'agent', label: 'Always allow Neo to run this' },
        ],
      }),
    ];
  };
  const fitEdges = (beside: DeskState, eight: DeskState): DeskState[] => {
    const g = beside.glance as NonNullable<DeskState['glance']>;
    const eg = eight.glance as NonNullable<DeskState['glance']>;
    return [
      {
        ...beside,
        paired: { ...(beside.paired as NonNullable<DeskState['paired']>), lockedView: 'time' },
        lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z' },
      },
      { ...beside, glance: { ...g, extraServers: [], extraTiles: [] } },
      { ...eight, glance: { ...eg, moreServers: (eg.extraServers ?? []).length } },
    ];
  };
  const named = [
    'base',
    'nobody paired',
    'unlocked, with an ask’s words',
    'an ask that stays on the phone',
    'phone unlock',
    'backoff',
    'a talk',
    'a new box (0.101)',
    'a new box, unlocked',
    'a new box, unlocked in Only the time',
    'no PIN yet (0.101)',
    'a four-digit PIN (0.103)',
    'unlocked, the camera on, someone there (0.103)',
    'unlocked, the camera on, nobody seen yet',
    'This Whombat beside servers (0.104)',
    'This Whombat beside tiles (0.104)',
    'eight servers (0.104)',
    'eight tiles (0.104)',
    'eight of each and This Whombat (0.104)',
    'unlocked until Lock (0.107)',
    'the camera looking, someone there (0.107)',
    'the camera looking, too dark to tell',
    'a risky ask approved with the PIN, deny, asked in the conversation (0.108)',
    'found on your network, the panel (0.110)',
    'found, the first scan looking (0.110)',
    'found, the first scan before anything (0.110)',
    'found, the strip beside servers (0.110)',
    'an ask with the web’s wider choices and who asks (0.116)',
  ];
  const valid = SCHEMA_CASES.filter((c) => c.schema === 'DeskState' && named.includes(c.name)).map((c) =>
    DeskState.parse(c.value),
  );
  const byName = (name: string) =>
    DeskState.parse(SCHEMA_CASES.find((c) => c.schema === 'DeskState' && c.name === name)?.value);
  const full = valid[0] as DeskState;
  // The broken ones on a lean glance: what they break is all they say.
  const glance = {
    ...(full.glance as NonNullable<DeskState['glance']>),
    working: null,
    done: [],
    servers: [],
    tiles: [],
  };
  const base: DeskState = { ...full, glance };
  const ask = glance.needsYou.items[0] as NonNullable<DeskState['glance']>['needsYou']['items'][number];
  const talk = {
    id: 'tlk_q3Vx9LpA0dZk',
    state: 'answered' as const,
    answer: 'Yes, pve-02 is fine.',
    thing: null,
    audio: false,
  };
  const withAsk = (a: typeof ask) => ({ ...base, glance: { ...glance, needsYou: { count: 1, items: [a] } } });
  const broken: DeskState[] = [
    { ...base, lock: { state: 'unlocked' } },
    { ...base, lock: { state: 'locked', until: '2026-10-20T12:36:00Z' } },
    { ...base, lock: { state: 'phone' } },
    { ...base, lock: { state: 'phone', expiresAt: '2026-10-20T12:36:00Z', retryAt: '2026-10-20T12:36:00Z' } },
    { ...base, lock: { state: 'backoff' } },
    { ...base, paired: null },
    { ...base, paired: null, glance: null, lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z' } },
    { ...base, paired: null, glance: null, talk },
    { ...base, glance: { ...glance, needsYou: { count: 0, items: glance.needsYou.items } } },
    withAsk({ ...ask, detail: 'Plex stopped answering at 14:31.' }),
    withAsk({ ...ask, facts: ['docker restart plex'] }),
    withAsk({ ...ask, approveLabel: 'Restart Plex' }),
    withAsk({ ...ask, onDesk: false }),
    withAsk({ ...ask, phoneReason: 'release' }),
    // 0.108 (CT-660): Approve with the PIN only on an ask that isn't on the desk.
    withAsk({ ...ask, approveWithPin: true }),
    { ...base, talk: { ...talk, answer: undefined } },
    { ...base, talk: { ...talk, state: 'thinking' } },
    { ...base, talk: { ...talk, state: 'failed', answer: undefined } },
    { ...base, talk: { ...talk, state: 'failed', answer: undefined, reason: 'slow' } },
    // 0.101 (CT-545): This Whombat only without servers and tiles, not in Only the time locked, series alike.
    ...boxBroken(valid.find((v) => v.glance?.box !== undefined) as DeskState),
    // 0.103 (CT-596): the camera and someone there only while unlocked, someone there only with the camera.
    { ...base, lock: { state: 'locked', camera: true } },
    { ...base, lock: { state: 'locked', camera: true, present: true } },
    { ...base, lock: { state: 'phone', expiresAt: '2026-10-20T12:36:00Z', camera: true } },
    { ...base, lock: { state: 'backoff', retryAt: '2026-10-20T12:36:00Z', present: true } },
    { ...base, lock: { state: 'unlocked', until: '2026-10-20T12:34:30Z', present: true } },
    { ...base, lock: { state: 'unlocked', until: '2026-10-20T12:34:30Z', camera: false, present: true } },
    // 0.104 (CT-601, CT-602): This Whombat beside servers or tiles only, never with the box, not in Only the time
    // locked, series alike; servers and tiles five to eight only beside four, the extra servers counted in moreServers.
    ...fitBroken(
      byName('This Whombat beside servers (0.104)'),
      byName('a new box (0.101)'),
      byName('eight of each and This Whombat (0.104)'),
    ),
    // 0.107 (CT-648): stays only while unlocked; the camera looking only on a paired screen.
    { ...base, lock: { state: 'locked', stays: true } },
    { ...base, lock: { state: 'phone', expiresAt: '2026-10-20T12:36:00Z', stays: true } },
    { ...base, lock: { state: 'backoff', retryAt: '2026-10-20T12:36:00Z', stays: true } },
    {
      ...base,
      paired: null,
      glance: null,
      talk: null,
      presence: { camera: true, watching: true, here: false },
    },
    ...foundBroken(byName('found on your network, the panel (0.110)')),
    // 0.116 (CT-890): wider choices only while unlocked, on an ask the screen may approve, with a PIN, each scope once.
    ...choicesBroken(byName('an ask with the web’s wider choices and who asks (0.116)')),
    // 0.116 (CT-893): working has no answer and no reason.
    { ...base, talk: { ...talk, state: 'working' } },
    { ...base, talk: { ...talk, state: 'working', answer: undefined, reason: 'slow' } },
  ].map((state) => JSON.parse(JSON.stringify(state)) as DeskState);
  // 0.103 (CT-596): false says nothing, wherever it is.
  const edges: DeskState[] = [
    // 0.107 (CT-648): stays false says nothing either.
    { ...base, lock: { state: 'locked', stays: false } },
    { ...base, lock: { state: 'locked', camera: false, present: false } },
    { ...base, lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z', camera: false } },
    { ...base, lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z', camera: true } },
    ...fitEdges(byName('This Whombat beside servers (0.104)'), byName('eight servers (0.104)')),
    ...foundEdges(byName('found on your network, the panel (0.110)')),
    // 0.108 (CT-660): false says nothing, wherever it is.
    {
      ...base,
      glance: { ...glance, needsYou: { count: 1, items: [{ ...ask, approveWithPin: false, deny: false }] } },
    },
    // 0.116 (CT-890, CT-892, CT-893): choices on a risky ask approved with the PIN; who asks while locked; working.
    ...choicesEdges(byName('an ask with the web’s wider choices and who asks (0.116)')),
    withAsk({ ...ask, from: 'Banjo' }),
    { ...base, talk: { ...talk, state: 'working', answer: undefined } },
  ];
  return [...valid, ...broken, ...edges];
}

/**
 * Network states for `hostNetworkValid` (CT-566): the valid `NetworkStateResponse` schema cases, and the base state
 * broken in each way one schema can't see. All are schema-valid.
 */
function hostNetworks(): HostNetwork[] {
  const valid = SCHEMA_CASES.filter((c) => c.schema === 'NetworkStateResponse' && c.valid && !c.output).map(
    (c) => (c.value as { network: HostNetwork }).network,
  );
  const base = valid[0] as HostNetwork;
  const wifi = base.wifi as NonNullable<HostNetwork['wifi']>;
  const change = base.change as NetworkChange;
  const broken: HostNetwork[] = [
    { ...base, wifiMissing: 'disabled' },
    { ...base, wifi: { ...wifi, state: 'disconnected' } },
    { ...base, wifi: { ...wifi, ssid: undefined } },
    { ...base, wifi: { ...wifi, state: 'connecting' } },
    { ...base, wifi: { ...wifi, state: 'connecting', signal: undefined } },
    { ...base, change: { ...change, failure: 'no_internet' } },
    { ...base, change: { ...change, phase: 'failed' } },
    { ...base, change: { ...change, phase: 'committed', failure: 'failed' } },
    // 3.13 (CT-1640): prefixes without their address, and an inconsistent cable change.
    {
      ...base,
      wifi: { ...wifi, state: 'connecting', signal: undefined, address: undefined, prefixLength: 23 },
    },
    { ...base, wired: [{ interface: 'enp1s0', connected: false, plugged: true, prefixLength: 23 }] },
    {
      ...base,
      cableChange: {
        id: 'c-w7m2p9qa',
        use: 'wifi',
        by: 'person',
        phase: 'reverted',
        deadline: change.deadline,
      },
    },
    {
      ...base,
      cableChange: {
        id: 'c-w7m2p9qa',
        use: 'wifi',
        by: 'person',
        phase: 'committed',
        deadline: change.deadline,
        failure: 'no_internet',
      },
    },
  ];
  return [...valid, ...broken].map((n) => JSON.parse(JSON.stringify(n)) as HostNetwork);
}

/**
 * Bluetooth states for `bluetoothStateValid` (CT-673): the valid `BluetoothStateAnswer` schema cases, and the base state
 * broken in each way one schema can't see. All are schema-valid.
 */
function bluetoothStates(): BluetoothState[] {
  const valid = SCHEMA_CASES.filter((c) => c.schema === 'BluetoothStateAnswer' && c.valid && !c.output).map(
    (c) => (c.value as { bluetooth: BluetoothState }).bluetooth,
  );
  const base = valid[0] as BluetoothState;
  const scan = base.scan as NonNullable<BluetoothState['scan']>;
  const [paired] = base.devices as [BluetoothState['devices'][number]];
  const [found] = scan.devices as [BluetoothState['devices'][number]];
  const pairing = valid.find((v) => v.pairing?.phase === 'code')?.pairing as BluetoothPairing;
  const ended = { ...pairing, phase: 'done' as const, code: undefined, typed: undefined };
  const broken: BluetoothState[] = [
    { ...base, missing: 'disabled' },
    { ...base, adapter: null },
    { ...base, adapter: { name: 'hci0', powered: false }, scan: null },
    { ...base, devices: [paired, paired] },
    { ...base, scan: { ...scan, devices: [found, found] } },
    { ...base, scan: { ...scan, devices: [paired] } },
    { ...base, pairing },
    { ...base, pairing: { ...pairing, phase: 'connecting', code: undefined, typed: undefined } },
    { ...base, scan: null, pairing: { ...pairing, code: undefined, typed: undefined } },
    { ...base, scan: null, pairing: { ...pairing, phase: 'confirm' } },
    { ...base, scan: null, pairing: { ...pairing, phase: 'pairing', typed: undefined } },
    { ...base, scan: null, pairing: { ...pairing, code: '1234', typed: 5 } },
    { ...base, scan: null, pairing: { ...ended, phase: 'failed' } },
    { ...base, scan: null, pairing: { ...ended, failure: 'timeout' } },
  ];
  // Every digit typed is still a code to type.
  const edges: BluetoothState[] = [{ ...base, scan: null, pairing: { ...pairing, code: '1234', typed: 4 } }];
  return [...valid, ...broken, ...edges].map((n) => JSON.parse(JSON.stringify(n)) as BluetoothState);
}

/** Display text for `hostText` (CT-560): what producers clean, at the lengths the report uses. */
const HOST_TEXTS: [string, number][] = [
  ['MT7925 802.11be 160MHz 2x2 PCIe Wireless Network Adapter [Filogic 360]', 120],
  ['  Realtek\tRTL8153\n  Gigabit   Ethernet  ', 120],
  ['ASUSTeK\u00a0COMPUTER\u2003INC.', 80],
  ['pve\u200b-02\u202e', 64],
  ['a \u0001 b', 64],
  ['\ufeffBOM first', 64],
  ['Wi‑Fi “Kärtchen” 無線 🎉', 32],
  ['x'.repeat(130), 120],
  [`${'ä'.repeat(240)} tail`, 240],
  ['word '.repeat(20), 15],
  ['\n\t ', 120],
];

/** Network names for `ssidValid` (CT-564): the pattern and the 32-byte limit. */
const SSIDS = [
  'Home',
  'Café Zonneveld',
  ' ',
  'x'.repeat(32),
  'x'.repeat(33),
  '日本語のネットワーク',
  '日本語のネットワーク名前',
  '🎉'.repeat(8),
  '🎉'.repeat(9),
  '',
  'Ho\u200bme',
  'Home\nOffice',
  'a\u00a0b',
];

const consoleSignIn = {
  code: 'KXQMTR',
  name: 'Mara Jansen',
  device: 'Pixel 9',
  expiresAt: '2026-10-20T12:05:00Z',
};

/* Remote help (0.120, CT-930…CT-941) ---------------------------------------------------------------------------- */

/** What people type as a help code: the separators, look-alikes and case `normalizeHelpCode` repairs, and refusals. */
const HELP_CODE_INPUTS = [
  'KQ72MX',
  'kq72mx',
  'KQ7·2MX',
  'KQ7 2MX',
  ' KQ7-2MX ',
  'KQ7\u20132MX',
  'KQ7\u00a02MX',
  'KQ7.2MX',
  'kq7o2m',
  'KQ7I2L',
  'KQ72M',
  'KQ72MXX',
  'KQ72MU',
  'KQ7_2MX',
  'KQ7\u20032MX',
  'KQ72M\u00d7',
  'ſQ72MX',
  'ıQ72MX',
  '',
];

/** Key ids as control writes them, and what owners read (`remoteHelpWho`). */
const REMOTE_HELP_KEY_IDS = [
  'Claude (op_7Hq2 via john)',
  'Claude (op_7Hq2)',
  'John Doe',
  'Bob (night shift) (op_1)',
  ' (op_1)',
  '',
  '  Claude\n (op_1)',
  `${'x'.repeat(60)} (op_1)`,
  'Zoë 🎉 (op_2)',
  'Claude (op_1',
  '\u202eevil (op_1)',
];

/** Schema-valid steps (the valid visits' steps), and steps broken in each way one schema can't see. */
function remoteHelpSteps(): RemoteHelpStep[] {
  const valid = SCHEMA_CASES.filter(
    (c) => c.schema === 'SupportVisitsAnswer' && c.valid && !c.output,
  ).flatMap((c) => (c.value as { visits: { steps: RemoteHelpStep[] }[] }).visits.flatMap((v) => v.steps));
  const at = '2026-10-21T14:00:00Z';
  const broken: RemoteHelpStep[] = [
    { at, kind: 'look' },
    { at, kind: 'look', command: 'status', units: ['whombat-voice.service'] },
    { at, kind: 'exec' },
    { at, kind: 'shell' },
    { at, kind: 'restart' },
    { at, kind: 'restart', units: ['a.service', 'b.service'] },
    { at, kind: 'forward', bytes: 10 },
    { at, kind: 'refused' },
    { at, kind: 'connected', bytes: 10 },
  ];
  const unique = new Map([...valid, ...broken].map((st) => [JSON.stringify(st), st]));
  return [...unique.values()];
}

/** Schema-valid support states: the valid `SupportState` cases, and the base broken in each way one schema can't see. */
function supportStates(): SupportState[] {
  const valid = SCHEMA_CASES.filter((c) => c.schema === 'SupportState' && c.valid && !c.output).map(
    (c) => c.value as SupportState,
  );
  const base = valid[0] as SupportState;
  const grant = base.grant as NonNullable<SupportState['grant']>;
  const [connected] = base.connected as [SupportState['connected'][number]];
  const prod = { ...base, environment: 'prod' as const, foreverAllowed: false, helpCodeRequired: true };
  const broken: SupportState[] = [
    { ...base, foreverAllowed: false },
    { ...base, helpCodeRequired: true },
    { ...prod, foreverAllowed: true, grant: { ...grant, helpCode: 'KQ72MX' } },
    { ...prod, grant: { ...grant, helpCode: null } },
    { ...prod, grant: { ...grant, helpCode: 'KQ72MX', until: null } },
    { ...base, grant: { ...grant, helpCode: 'KQ72MX' } },
    { ...base, grant: null },
    { ...base, available: false },
    { ...base, connected: [connected, connected] },
  ];
  return [...valid, ...broken].map((st) => JSON.parse(JSON.stringify(st)) as SupportState);
}

/** Schema-valid events: the valid answer's events, and events missing or carrying members their kind doesn't. */
function supportEvents(): SupportEvent[] {
  const valid = SCHEMA_CASES.filter(
    (c) => c.schema === 'SupportEventsAnswer' && c.valid && !c.output,
  ).flatMap((c) => (c.value as { events: SupportEvent[] }).events);
  const at = '2026-10-21T14:00:00Z';
  const by = { accountId: 'acc_mara0001', name: 'Mara Jansen' };
  const visit = { visitId: '12345', who: 'Claude', level: 'fix' as const };
  const broken: SupportEvent[] = [
    { seq: 10, at, kind: 'grant', level: 'fix', duration: 'day' },
    { seq: 11, at, kind: 'grant', level: 'fix', by },
    { seq: 12, at, kind: 'grant', duration: 'day', by },
    { seq: 13, at, kind: 'stop', reason: 'expired' },
    { seq: 14, at, kind: 'stop', reason: 'owner' },
    { seq: 15, at, kind: 'stop', reason: 'desk', by },
    { seq: 16, at, kind: 'stop' },
    { seq: 17, at, kind: 'visit_start', visitId: '12345', level: 'fix' },
    { seq: 18, at, kind: 'visit_start', ...visit, steps: 3 },
    { seq: 19, at, kind: 'visit_end', ...visit, steps: 3 },
    { seq: 20, at, kind: 'visit_end', ...visit, startedAt: at },
    { seq: 21, at, kind: 'expired', duration: 'day' },
    { seq: 22, at, kind: 'locked_out', reason: 'wrong_codes' },
  ];
  const unique = new Map([...valid, ...broken].map((e) => [JSON.stringify(e), e]));
  return [...unique.values()];
}

function localVectors() {
  const peers = [
    '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH',
    '12D3KooWNrPX9JcmH7DQVJDVr2AXRBHGLAE2Bowcs2hFgaBStMDa',
  ];
  return {
    description:
      'Appliance-local IPC (CT-23): `revocationRefs` = revocationRef(peerId) (TypeScript and Go); `backupSummaries` = summarizeBackup(status) (TypeScript); `consoleStates` = consoleStateValid(state) and consoleDisplayUrl(state.url) (CT-64; `burrows` only in `claimed`, CT-116; `signIn` only in `claimed`, CT-626; `lettersUntil` only in `claimable`, `newLetters` only in `claimable` and `backoff`, `ipv6Only` never in `claimed`), `claimLookupLeases` = claimLookupLeaseValid(request) (CT-63), `deskStates` = deskStateValid(state) (CT-530), `deskTalkRequests` = deskTalkRequestValid(request) (CT-531), `deskTalkSessions` = deskTalkSessionValid(session) (CT-664), `deskServerPages` = deskServerPageValid(page) (CT-866), `deskDecideRequests` = deskDecideRequestValid(request) and deskDecideNeedsPin({approveWithPin}, request) (CT-891), `hostNetworks` = hostNetworkValid(network) (CT-566), `networkChanges` = networkChangeValid(change) (CT-567), `bluetoothStates` = bluetoothStateValid(state) (CT-673), `bluetoothPairings` = bluetoothPairingValid(pairing) (CT-672), all on schema-valid documents (TypeScript and Go); `hostTexts` = hostText(input, max) (CT-560), `ssids` = ssidValid(ssid) (CT-564), `wifiSignals` = wifiSignalFromDbm(dbm) (CT-565), `bluetoothSignals` = bluetoothSignalFromDbm(dbm) (CT-670), `deskServerIds` = DESK_SERVER_ID_RE.test(id) (CT-862) (TypeScript and Go); remote help (CT-930…CT-941): `helpCodes` = normalizeHelpCode(input) (null: refused), `helpCodeFormats` = formatHelpCode(code), `helpCodeBytes` = helpCodeFromBytes(random hex), `remoteHelpWhos` = remoteHelpWho(keyId), `remoteHelpDurations` = remoteHelpDurationSeconds(duration) (null: forever), and on schema-valid documents `remoteHelpSteps` = remoteHelpStepValid(step), `supportStates` = supportStateValid(state), `supportEvents` = supportEventValid(event) (TypeScript and Go); `displayText`: the `ConsoleDisplayText` pattern and every code point it refuses on its own, as inclusive ranges (CT-116; Go compares its RE2 tables, surrogates aside).',
    revocationRefs: peers.map((peerId) => ({ peerId, ref: revocationRef(peerId) })),
    consoleStates: [
      { v: 1, state: 'claimable', code: 'KXQM', url: 'https://app.whombat.com/claim' },
      { v: 1, state: 'claimable', url: 'https://app.whombat.com/claim' },
      { v: 1, state: 'waiting', url: 'http://localhost:5180/claim' },
      { v: 1, state: 'waiting', code: 'KXQM', url: 'https://app.whombat.com/claim' },
      { v: 1, state: 'backoff', url: 'https://app.whombat.com/claim', retryAt: '2026-09-26T12:04:00Z' },
      { v: 1, state: 'backoff', url: 'https://app.whombat.com/claim' },
      { v: 1, state: 'claimed', url: 'https://dev.whombat.com/claim', retryAt: '2026-09-26T12:04:00Z' },
      { v: 1, state: 'starting', url: 'https://dev.whombat.com/claim' },
      {
        v: 1,
        state: 'claimed',
        url: 'https://app.whombat.com/claim',
        burrows: { first: 'Banjo\u2019s Burrow', more: 2 },
      },
      { v: 1, state: 'claimed', url: 'https://app.whombat.com/claim' },
      { v: 1, state: 'waiting', url: 'https://app.whombat.com/claim', burrows: { first: 'Banjo', more: 0 } },
      {
        v: 1,
        state: 'claimable',
        code: 'KXQM',
        url: 'https://app.whombat.com/claim',
        burrows: { first: 'Banjo', more: 0 },
      },
      // A screen sign-in (0.106, CT-626): only in `claimed`.
      {
        v: 1,
        state: 'claimed',
        url: 'https://app.whombat.com/claim',
        burrows: { first: 'Banjo', more: 0 },
        signIn: consoleSignIn,
      },
      { v: 1, state: 'claimed', url: 'https://app.whombat.com/claim', signIn: consoleSignIn },
      { v: 1, state: 'claimable', code: 'KXQM', url: 'https://app.whombat.com/claim', signIn: consoleSignIn },
      {
        v: 1,
        state: 'backoff',
        url: 'https://app.whombat.com/claim',
        retryAt: '2026-09-26T12:04:00Z',
        signIn: consoleSignIn,
      },
      { v: 1, state: 'starting', url: 'https://app.whombat.com/claim', signIn: consoleSignIn },
      // New letters asked for at the box: until when they stay, only in `claimable`.
      {
        v: 1,
        state: 'claimable',
        code: 'KXQM',
        url: 'http://192.168.1.20:4480/',
        lettersUntil: '2026-09-26T12:10:00Z',
      },
      {
        v: 1,
        state: 'backoff',
        url: 'http://192.168.1.20:4480/',
        retryAt: '2026-09-26T12:04:00Z',
        lettersUntil: '2026-09-26T12:10:00Z',
      },
      // The person at the box can ask for new letters: only where letters show or a wait keeps them away.
      { v: 1, state: 'claimable', code: 'KXQM', url: 'http://192.168.1.20:4480/', newLetters: true },
      {
        v: 1,
        state: 'backoff',
        url: 'http://192.168.1.20:4480/',
        retryAt: '2026-09-26T12:04:00Z',
        newLetters: true,
      },
      { v: 1, state: 'claimed', url: 'http://192.168.1.20:4480/', newLetters: true },
      { v: 1, state: 'waiting', url: 'http://192.168.1.20:4480/', newLetters: true },
      // The network gave only IPv6 (said on its own, whatever the url names): any state but `claimed`.
      { v: 1, state: 'waiting', url: 'http://0.0.0.0/', ipv6Only: true },
      { v: 1, state: 'claimable', code: 'KXQM', url: 'http://[fd00::20]:4480/', ipv6Only: true },
      { v: 1, state: 'claimed', url: 'http://0.0.0.0/', ipv6Only: true },
      // A box nobody can reach yet names no address: plain HTTP on the unspecified one.
      { v: 1, state: 'waiting', url: 'http://0.0.0.0/' },
      // Another address for the claim under the claim link at the box's own address: only in `claimable`.
      {
        v: 1,
        state: 'claimable',
        code: 'KXQM',
        url: 'https://quiet-river-otter.box.whombat.app/c/kxqmtv',
        fallbackUrl: 'http://192.168.1.20:4480/',
      },
      {
        v: 1,
        state: 'claimable',
        code: 'KXQM',
        url: 'https://quiet-river-otter.box.whombat.app/c/kxqmtv',
        fallbackUrl: 'https://whombat.tail1234.ts.net:4480/',
        newLetters: true,
      },
      {
        v: 1,
        state: 'backoff',
        url: 'https://quiet-river-otter.box.whombat.app/c/kxqmtv',
        retryAt: '2026-09-26T12:04:00Z',
        fallbackUrl: 'http://192.168.1.20:4480/',
      },
      {
        v: 1,
        state: 'claimed',
        url: 'https://quiet-river-otter.box.whombat.app/',
        fallbackUrl: 'http://192.168.1.20:4480/',
      },
    ].map((state) => ({ state, valid: consoleStateValid(state), display: consoleDisplayUrl(state.url) })),
    displayText: { pattern: CONSOLE_DISPLAY_TEXT_RE.source, rejected: displayTextRejected() },
    deskStates: deskStates().map((state) => ({ state, valid: deskStateValid(state) })),
    deskTalkRequests: [
      { v: 1, text: 'Is pve-02 okay?', continue: false },
      { v: 1, audioWav: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=', continue: true },
      // 0.115 (CT-865): about the server whose screen the person asked from.
      { v: 1, text: 'Why is it busy?', continue: false, server: 'pve-01' },
      { v: 1, continue: false, server: 'nas' },
      { v: 1, continue: false },
      {
        v: 1,
        text: 'Is pve-02 okay?',
        audioWav: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=',
        continue: false,
      },
    ].map((request) => ({ request, valid: deskTalkRequestValid(request) })),
    deskTalkSessions: [
      { v: 1, open: false, messages: [], earlier: 0 },
      { v: 1, open: true, messages: [], earlier: 0, until: '2026-10-20T13:00:00Z' },
      { v: 1, open: true, messages: [], earlier: 3, until: '2026-10-20T13:00:00Z' },
      { v: 1, open: true, messages: [], earlier: 0 },
      { v: 1, open: false, messages: [], earlier: 0, until: '2026-10-20T13:00:00Z' },
      { v: 1, open: false, messages: [], earlier: 2 },
      {
        v: 1,
        open: false,
        messages: [
          {
            id: 'msg_Hq2v8LkP0aXz',
            from: 'you' as const,
            at: '2026-10-20T12:30:00Z',
            paragraphs: ['Is pve-02 okay?'],
          },
        ],
        earlier: 0,
      },
      ...deskTaskSessions(),
    ].map((session) => ({ session, valid: deskTalkSessionValid(session) })),
    deskDecideRequests: DESK_DECIDE_REQUESTS.flatMap((request) =>
      [false, true].map((approveWithPin) => ({
        request,
        approveWithPin,
        valid: deskDecideRequestValid(request),
        needsPin: deskDecideNeedsPin({ approveWithPin }, request),
      })),
    ),
    deskServerPages: deskServerPages().map((page) => ({ page, valid: deskServerPageValid(page) })),
    deskServerIds: DESK_SERVER_IDS.map((id) => ({ id, valid: DESK_SERVER_ID_RE.test(id) })),
    hostTexts: HOST_TEXTS.map(([input, max]) => ({ input, max, output: hostText(input, max) })),
    ssids: SSIDS.map((ssid) => ({ ssid, valid: ssidValid(ssid) })),
    wifiSignals: [-20, -55, -56, -67, -68, -75, -76, -85, -86, -100].map((dbm) => ({
      dbm,
      signal: wifiSignalFromDbm(dbm),
    })),
    hostNetworks: hostNetworks().map((network) => ({ network, valid: hostNetworkValid(network) })),
    networkChanges: hostNetworks()
      .flatMap((n) => (n.change ? [n.change] : []))
      .map((change) => ({ change, valid: networkChangeValid(change) })),
    helpCodes: HELP_CODE_INPUTS.map((input) => ({ input, code: normalizeHelpCode(input) })),
    helpCodeFormats: ['KQ72MX', '000000', 'KQ7·2MX', 'kq72mx', 'KQ72M'].map((code) => ({
      code,
      shown: formatHelpCode(code),
    })),
    helpCodeBytes: ['000102030405', 'ffffffffffff', '1f203f40e0ff', '6a0b9c71d2e3a4'].map((random) => ({
      random,
      code: helpCodeFromBytes(hexToBytes(random)),
    })),
    remoteHelpWhos: REMOTE_HELP_KEY_IDS.map((keyId) => ({ keyId, who: remoteHelpWho(keyId) })),
    remoteHelpDurations: REMOTE_HELP_DURATIONS.map((duration) => ({
      duration,
      seconds: remoteHelpDurationSeconds(duration),
    })),
    remoteHelpSteps: remoteHelpSteps().map((step) => ({ step, valid: remoteHelpStepValid(step) })),
    supportStates: supportStates().map((state) => ({ state, valid: supportStateValid(state) })),
    supportEvents: supportEvents().map((event) => ({ event, valid: supportEventValid(event) })),
    bluetoothSignals: [-30, -60, -61, -70, -71, -80, -81, -90, -91, -127].map((dbm) => ({
      dbm,
      signal: bluetoothSignalFromDbm(dbm),
    })),
    bluetoothStates: bluetoothStates().map((state) => ({ state, valid: bluetoothStateValid(state) })),
    bluetoothPairings: bluetoothStates()
      .flatMap((s) => (s.pairing ? [s.pairing] : []))
      .map((pairing) => ({ pairing, valid: bluetoothPairingValid(pairing) })),
    claimLookupLeases: [
      { v: 1, lookup: '4821', expiresAt: '2026-09-26T12:10:00Z' },
      { v: 1, lookup: null },
      { v: 1, lookup: '4821' },
      { v: 1, lookup: null, expiresAt: '2026-09-26T12:10:00Z' },
    ].map((request) => ({ request, valid: claimLookupLeaseValid(request) })),
    backupSummaries: SCHEMA_CASES.filter((c) => c.schema === 'BackupServiceStatus' && c.valid).map((c) => ({
      name: c.name,
      status: c.value,
      summary: summarizeBackup(c.value as BackupServiceStatus, BackupScope.options),
    })),
  };
}

function claimVectors() {
  const secret = 'MZXW6YTBOI2DAMRTGQ3DMNZYHE';
  const inputs = [
    { name: 'normalized', input: secret },
    { name: 'grouped as printed', input: 'MZXW-6YTB-OI2D-AMRT-GQ3D-MNZY-HE' },
    { name: 'lower case with spaces', input: 'mzxw 6ytb oi2d amrt gq3d mnzy he' },
    { name: 'look-alike digits 0/1/8', input: 'MZXW6YT8O12DAMRTGQ3DMNZYHE' },
    {
      name: 'tabs, newline, NBSP, NEL, BOM, ideographic space',
      input: `\tMZXW6YTB\nOI2D\u00a0AMRT\u0085GQ3D\ufeffMNZY\u3000HE`,
    },
    { name: 'too short', input: 'MZXW6YTBOI2DAMRTGQ3DMNZYH' },
    { name: 'other punctuation is not repaired', input: 'MZXW6YTB.OI2DAMRTGQ3DMNZYHE' },
    { name: 'non-ASCII letter is not folded', input: 'MZXW6YTBOI2DAMRTGQ3DMNZYHé' },
    { name: 'digit 9 is not in the alphabet', input: 'MZXW6YTBOI2DAMRTGQ3DMNZYH9' },
  ].map((c) => {
    const normalized = normalizeClaimSecret(c.input);
    return { ...c, normalized, valid: isClaimSecret(normalized) };
  });
  const hashes = [
    { deviceId: 'dev_7Hq2mXk3', secret },
    { deviceId: 'wb-a1b2-c3d4-e5f6', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAA' },
  ].map((c) => ({
    ...c,
    hash: claimSecretHash(c.deviceId, c.secret),
    verifier: claimVerifier(c.deviceId, c.secret),
  }));
  return {
    description:
      'Claim secrets (NX-24, CT-29, CT-43): `normalizeClaimSecret(input)` = `normalized` (valid iff ^[A-Z2-7]{26}$); `claimSecretHash(deviceId, secret)` = base64url(SHA-256("whombat-claim-secret/1\\n" + deviceId + "\\n" + secret)) (the appliance); `claimVerifier(deviceId, secret)` = base64url(SHA-256("whombat-claim-control/1\\n" + …)) (control, and the client\'s `claimProof`). Console claim codes (CC-01, CT-58): `codes` = normalizeClaimCode(input), `formats` = formatClaimCode(letters, lookup) (null: refused), `letters` = generateClaimLetters over the byte stream `random` (hex, consumed in order). The screen sign-in (BX-04, CT-620): `screenCodes` = normalizeScreenSignInLetters(input) (null: refused), `screenFormats` = formatScreenSignInLetters(letters) (null: refused), `screenLetters` = generateScreenSignInLetters over `random`. CPace, the claim PAKE and the screen sign-in PAKE are in `cpace.json`.',
    normalize: inputs,
    hashes,
    codes: claimCodeInputs.map((input) => ({ input, expect: normalizeClaimCode(input) })),
    formats: [
      { letters: 'KXQM', lookup: '4821' },
      { letters: 'KXQM', lookup: '048211' },
      { letters: 'KXQO', lookup: '4821' },
      { letters: 'KXQM', lookup: '482' },
      { letters: 'kxqm', lookup: '4821' },
    ].map((c) => {
      let code: string | null = null;
      try {
        code = formatClaimCode(c.letters, c.lookup);
      } catch {}
      return { ...c, code };
    }),
    letters: [
      [0, 19, 20, 239],
      [240, 255, 1, 2, 3, 4],
      [7, 250, 45, 241, 242, 99, 180],
      [...sha512(utf8Encode('whombat-claim-letters')).subarray(0, 12)],
    ].map((bytes) => {
      let o = 0;
      const letters = generateClaimLetters((n) => {
        const out = Uint8Array.from(bytes.slice(o, o + n));
        o += n;
        return out;
      });
      return { random: hex(Uint8Array.from(bytes.slice(0, o))), letters };
    }),
    screenCodes: screenCodeInputs.map((input) => ({ input, letters: normalizeScreenSignInLetters(input) })),
    screenFormats: ['KXQMTR', 'KXQMT', 'kxqmtr', 'KXQ MTR', 'KXQMTO'].map((letters) => {
      let shown: string | null = null;
      try {
        shown = formatScreenSignInLetters(letters);
      } catch {}
      return { letters, shown };
    }),
    screenLetters: [
      [0, 19, 20, 239, 1, 2],
      [240, 255, 0, 1, 2, 3, 250, 4, 5],
      [...sha512(utf8Encode('whombat-screen-signin-letters')).subarray(0, 16)],
    ].map((bytes) => {
      let o = 0;
      const letters = generateScreenSignInLetters((n) => {
        const out = Uint8Array.from(bytes.slice(o, o + n));
        o += n;
        return out;
      });
      return { random: hex(Uint8Array.from(bytes.slice(0, o))), letters };
    }),
  };
}

const screenCodeInputs = [
  'KXQMTR',
  'kxq mtr',
  'KXQ-MTR',
  '\tKX\u00a0Q\u3000MTR\ufeff',
  'KXQMTO',
  'KXQMT',
  'KXQMTRA',
  'KXQM',
  'KXQ.MTR',
  '\uFF2B\uFF38\uFF31\uFF2D\uFF34\uFF32',
  '',
];

const claimCodeInputs = [
  'KX-4821-QM',
  'kx 4821 qm',
  'KXQM',
  ' k x q m ',
  'KX4821QM',
  'KX-048211-QM',
  '\tKX\u00a04821\u3000QM\ufeff',
  'KX-482-QM',
  'KX-4821234-QM',
  'KO-4821-QM',
  'KXQS',
  'KX.4821.QM',
  'KX-4821-QM-',
  'KXQ',
  'KX-48A1-QM',
  'ＫＸＱＭ',
  '',
];

/* CPace (CC-06, CT-59) ------------------------------------------------------------------------------ */

const fromHex = (s: string) => hexToBytes(s.replace(/\s+/g, ''));

/** draft-irtf-cfrg-cpace-21, Appendix A and B.3 (ristretto255, SHA-512), transcribed from the draft. */
const CPACE_DRAFT_B3 = {
  prs: '50617373776f7264',
  ci: '0b415f696e69746961746f720b425f726573706f6e646572',
  sid: '7e4b4791d6a8ef019b936c79fb7f2c57',
  generatorString:
    '11435061636552697374726574746f3235350850617373776f726464' +
    '00'.repeat(84) +
    '00000000000000000000000000000000180b415f696e69746961746f720b425f726573706f6e646572107e4b4791d6a8ef019b936c79fb7f2c57',
  generator: '222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56',
  ya: 'da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08',
  adA: '414461',
  Ya: 'd6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157',
  yb: 'd2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d',
  adB: '414462',
  Yb: '3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258',
  K: '80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f',
  transcriptIr:
    '20d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b915703414461203ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f725803414462',
  iskIr:
    'b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c3fa2068af7900447',
  scalarMult: {
    s: '7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05',
    X: '2c3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c',
    result: '7c13645fe790a468f62c39beb7388e541d8405d1ade69d1778c5fe3e7f6b600e',
  },
  /** scalar_mult_vfy(s, ·) must return G.I (all zero) and the protocol must abort (B.3.11). */
  invalidPoints: [
    {
      name: 'Y_i1 (not a valid encoding)',
      point: '2b3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c',
    },
    { name: 'Y_i2 = G.I', point: '00'.repeat(32) },
  ],
  prependLen: [
    { data: '', out: '00' },
    { data: '31323334', out: '0431323334' },
    {
      data: hex(Uint8Array.from({ length: 127 }, (_, i) => i)),
      out: `7f${hex(Uint8Array.from({ length: 127 }, (_, i) => i))}`,
    },
    {
      data: hex(Uint8Array.from({ length: 128 }, (_, i) => i)),
      out: `8001${hex(Uint8Array.from({ length: 128 }, (_, i) => i))}`,
    },
  ],
  lvCat: { parts: ['31323334', '35', '', '363738'], out: '043132333401350003363738' },
  transcriptIrCases: [
    {
      ya: '313233',
      adA: '506172747941',
      yb: '323334',
      adB: '506172747942',
      out: '03313233065061727479410332333406506172747942',
    },
    {
      ya: '33343536',
      adA: '506172747941',
      yb: '32333435',
      adB: '506172747942',
      out: '043334353606506172747941043233343506506172747942',
    },
  ],
};

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** The same 32 bytes with a non-zero unused bit in the last base64url character (strict decoders refuse it). */
const nonCanonicalLastChar = (s: string) => s.slice(0, -1) + B64URL[B64URL.indexOf(s.slice(-1)) + 1];

/** Deterministic randomness for the claim PAKE vectors (never use these scalars anywhere else). */
const vectorRandom = (label: string) =>
  sha512(utf8Encode(`whombat-claim-pake-vectors/${label}`)).subarray(0, 32);

function cpaceVectors() {
  const base: ClaimPakeContext = {
    method: 'code',
    password: 'KXQM',
    deviceId: 'dev_7Hq2mXk3',
    appliancePeerId: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH',
    clientPeerId: '12D3KooWACa6VJfb1zWBv7pi2NstUM7jKxK6wYS4x47gm4GvctK8',
    claimId: 'clm_8Hq2mXk3pZ',
  };
  const relay = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
  const card = {
    ...base,
    method: 'card' as const,
    password: claimCardPassword(base.deviceId, 'MZXW6YTBOI2DAMRTGQ3DMNZYHE'),
  };
  const cases: { name: string; client: ClaimPakeContext; appliance: ClaimPakeContext }[] = [
    { name: 'code, same inputs', client: base, appliance: base },
    { name: 'card, same inputs', client: card, appliance: card },
    { name: 'wrong letters', client: { ...base, password: 'KXQN' }, appliance: base },
    {
      name: 'relay in the middle: the client pinned another appliance key (MITM)',
      client: { ...base, appliancePeerId: relay },
      appliance: base,
    },
    {
      name: 'relay in the middle: the appliance sees another client key (MITM)',
      client: base,
      appliance: { ...base, clientPeerId: relay },
    },
    {
      name: 'PeerIds swapped in CI',
      client: { ...base, appliancePeerId: base.clientPeerId, clientPeerId: base.appliancePeerId },
      appliance: base,
    },
    { name: 'another claim id (sid)', client: { ...base, claimId: 'clm_other000' }, appliance: base },
    { name: 'another device id', client: { ...base, deviceId: 'dev_other' }, appliance: base },
    {
      name: 'same password under another method',
      client: { ...card, method: 'card' },
      appliance: { ...card, method: 'code', password: 'KXQM' },
    },
  ];
  const pake = cases.map((c, i) => {
    const clientRandom = vectorRandom(`client-${i}`);
    const applianceRandom = vectorRandom(`appliance-${i}`);
    const once = (b: Uint8Array) => (n: number) => {
      if (n !== b.length) throw new Error('unexpected draw');
      return b;
    };
    const client = claimPakeInitiator(c.client, once(clientRandom));
    const appliance = claimPakeResponder(c.appliance, client.share, once(applianceRandom));
    const clientTags = claimPakeInitiatorFinish(client.state, appliance.share);
    return {
      name: c.name,
      client: c.client,
      appliance: c.appliance,
      clientCi: hex(claimPakeCi(c.client)),
      applianceCi: hex(claimPakeCi(c.appliance)),
      clientRandom: hex(clientRandom),
      applianceRandom: hex(applianceRandom),
      clientShare: client.share,
      applianceShare: appliance.share,
      clientTags,
      applianceTags: appliance.tags,
      agree: clientTags.client === appliance.tags.client && clientTags.appliance === appliance.tags.appliance,
    };
  });
  const invalidShares = [
    { name: 'identity (G.I)', share: base64urlEncode(new Uint8Array(32)) },
    {
      name: 'not a ristretto255 encoding (B.3 Y_i1)',
      share: base64urlEncode(fromHex(CPACE_DRAFT_B3.invalidPoints[0]?.point as string)),
    },
    {
      name: 'non-canonical field element (p)',
      share: base64urlEncode(fromHex('edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f')),
    },
    { name: 'negative field element (1)', share: base64urlEncode(fromHex(`01${'00'.repeat(31)}`)) },
    {
      name: 'non-canonical base64url trailing bits',
      share: nonCanonicalLastChar(pake[0]?.clientShare as string),
    },
    { name: 'too short', share: 'A'.repeat(42) },
    { name: 'padding', share: `${'A'.repeat(42)}=` },
  ].map((c) => {
    let refused = false;
    try {
      claimPakeResponder(base, c.share, () => vectorRandom('invalid'));
    } catch {
      refused = true;
    }
    return { ...c, refused };
  });
  return {
    description:
      "CPace CPACE-RISTR255-SHA512 (draft-irtf-cfrg-cpace-21, CC-06, CT-59). `draft`: Appendix A and B.3 values transcribed from the draft (hex). `pake`: the claim PAKE — each side runs with its own context (`client` as initiator with `clientRandom` as the 32 bytes sample_scalar reads, `appliance` as responder with `applianceRandom`); `clientCi`/`applianceCi` = claimPakeCi(context), shares are base64url, `clientTags`/`applianceTags` = {client, appliance} confirmation tags each side derives, `agree` says whether both match. `invalidShares`: shares the responder must refuse (`refused`). `screenSignIn` (0.106, BX-03, CT-621): the screen sign-in PAKE in the same form, `clientCi`/`applianceCi` = screenSignInPakeCi(context) (TypeScript only: the Go side has no screen sign-in). `localClaim` (1.1, HE-59, CT-1302): the claim on the box's own page in the same form, `clientCi`/`applianceCi` = localClaimPakeCi(context) (TypeScript only).",
    suite: 'CPACE-RISTR255-SHA512',
    draft: CPACE_DRAFT_B3,
    pake,
    invalidShares,
    screenSignIn: screenSignInVectors(),
    localClaim: localClaimVectors(),
  };
}

/** The claim on the box's own page (1.1, CT-1302): the claim's exchange with its own CI (no device id), sid and info. */
function localClaimVectors() {
  const base: LocalClaimPakeContext = {
    password: 'KXQM',
    appliancePeerId: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH',
    clientPeerId: '12D3KooWACa6VJfb1zWBv7pi2NstUM7jKxK6wYS4x47gm4GvctK8',
    claimId: 'lcl_8Hq2mXk3pZ',
  };
  const other = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
  const cases: { name: string; client: LocalClaimPakeContext; appliance: LocalClaimPakeContext }[] = [
    { name: 'same inputs', client: base, appliance: base },
    { name: 'wrong letters', client: { ...base, password: 'KXQW' }, appliance: base },
    {
      name: 'something on the network in the middle: the client sees another appliance key (MITM)',
      client: { ...base, appliancePeerId: other },
      appliance: base,
    },
    {
      name: 'something on the network in the middle: the appliance sees another client key (MITM)',
      client: base,
      appliance: { ...base, clientPeerId: other },
    },
    {
      name: 'PeerIds swapped in CI',
      client: { ...base, appliancePeerId: base.clientPeerId, clientPeerId: base.appliancePeerId },
      appliance: base,
    },
    { name: 'another claim id (sid)', client: { ...base, claimId: 'lcl_other000' }, appliance: base },
  ];
  const random = (label: string) =>
    sha512(utf8Encode(`whombat-claim-local-vectors/${label}`)).subarray(0, 32);
  return cases.map((c, i) => {
    const clientRandom = random(`client-${i}`);
    const applianceRandom = random(`appliance-${i}`);
    const once = (b: Uint8Array) => (n: number) => {
      if (n !== b.length) throw new Error('unexpected draw');
      return b;
    };
    const client = localClaimPakeInitiator(c.client, once(clientRandom));
    const appliance = localClaimPakeResponder(c.appliance, client.share, once(applianceRandom));
    const clientTags = localClaimPakeInitiatorFinish(client.state, appliance.share);
    return {
      name: c.name,
      client: c.client,
      appliance: c.appliance,
      clientCi: hex(localClaimPakeCi(c.client)),
      applianceCi: hex(localClaimPakeCi(c.appliance)),
      clientRandom: hex(clientRandom),
      applianceRandom: hex(applianceRandom),
      clientShare: client.share,
      applianceShare: appliance.share,
      clientTags,
      applianceTags: appliance.tags,
      agree: clientTags.client === appliance.tags.client && clientTags.appliance === appliance.tags.appliance,
    };
  });
}

/** The screen sign-in PAKE (0.106, CT-621): the claim's exchange with its own CI, sid and confirmation info. */
function screenSignInVectors() {
  const base: ScreenSignInPakeContext = {
    password: 'KXQMTR',
    deviceId: 'dev_7Hq2mXk3',
    appliancePeerId: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH',
    clientPeerId: '12D3KooWACa6VJfb1zWBv7pi2NstUM7jKxK6wYS4x47gm4GvctK8',
    signinId: 'scr_8Hq2mXk3pZ',
  };
  const relay = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
  const cases: { name: string; client: ScreenSignInPakeContext; appliance: ScreenSignInPakeContext }[] = [
    { name: 'same inputs', client: base, appliance: base },
    { name: 'wrong letters', client: { ...base, password: 'KXQMTW' }, appliance: base },
    {
      name: 'relay in the middle: the client sees another appliance key (MITM)',
      client: { ...base, appliancePeerId: relay },
      appliance: base,
    },
    {
      name: 'relay in the middle: the appliance sees another client key (MITM)',
      client: base,
      appliance: { ...base, clientPeerId: relay },
    },
    {
      name: 'PeerIds swapped in CI',
      client: { ...base, appliancePeerId: base.clientPeerId, clientPeerId: base.appliancePeerId },
      appliance: base,
    },
    { name: 'another sign-in id (sid)', client: { ...base, signinId: 'scr_other000' }, appliance: base },
    { name: 'another device id', client: { ...base, deviceId: 'dev_other' }, appliance: base },
  ];
  const random = (label: string) =>
    sha512(utf8Encode(`whombat-screen-signin-vectors/${label}`)).subarray(0, 32);
  return cases.map((c, i) => {
    const clientRandom = random(`client-${i}`);
    const applianceRandom = random(`appliance-${i}`);
    const once = (b: Uint8Array) => (n: number) => {
      if (n !== b.length) throw new Error('unexpected draw');
      return b;
    };
    const client = screenSignInPakeInitiator(c.client, once(clientRandom));
    const appliance = screenSignInPakeResponder(c.appliance, client.share, once(applianceRandom));
    const clientTags = screenSignInPakeInitiatorFinish(client.state, appliance.share);
    return {
      name: c.name,
      client: c.client,
      appliance: c.appliance,
      clientCi: hex(screenSignInPakeCi(c.client)),
      applianceCi: hex(screenSignInPakeCi(c.appliance)),
      clientRandom: hex(clientRandom),
      applianceRandom: hex(applianceRandom),
      clientShare: client.share,
      applianceShare: appliance.share,
      clientTags,
      applianceTags: appliance.tags,
      agree: clientTags.client === appliance.tags.client && clientTags.appliance === appliance.tags.appliance,
    };
  });
}

function compatVectors() {
  const sp = (c: string, name: string) => `/nix/store/${c.repeat(32)}-${name}`;
  const hexOf: Record<string, string> = {
    a: 'a',
    b: 'b',
    c: 'c',
    d: 'd',
    f: 'f',
    g: '1',
    h: '2',
    j: '3',
    k: '4',
  };
  const comp = (c: string, name: string, version = '1.0.0') => ({
    version,
    storePath: sp(c, name),
    narHash: `sha256:${(hexOf[c] as string).repeat(64)}`,
  });
  const base: ReleaseTuple = {
    releaseId: 'rt-2026.09.25-1',
    runtime: {
      ...comp('a', 'whombat-runtime'),
      schemaReads: { min: 10, max: 12 },
      schemaWrites: 12,
      protocol: { min: 1000, max: 1001 },
      hostAbi: { min: 1, max: 1 },
    },
    providers: [{ ...comp('b', 'codex'), provider: 'codex' }],
    host: { ...comp('c', 'nixos-system'), abi: 1 },
    manager: comp('d', 'whombat-manager'),
  };
  const newRuntime: ReleaseTuple = {
    ...base,
    releaseId: 'rt-2026.10.01-1',
    runtime: {
      ...base.runtime,
      ...comp('f', 'whombat-runtime'),
      schemaReads: { min: 12, max: 14 },
      schemaWrites: 14,
    },
  };
  const compatible: ReleaseTuple = {
    ...base,
    releaseId: 'rt-2026.09.26-1',
    runtime: { ...base.runtime, ...comp('g', 'whombat-runtime'), schemaReads: { min: 11, max: 12 } },
  };
  const newHost: ReleaseTuple = {
    ...base,
    releaseId: 'rt-2026.10.02-1',
    host: { ...comp('h', 'nixos-system'), abi: 2 },
    manager: comp('j', 'whombat-manager'),
  };
  const both: ReleaseTuple = {
    ...newRuntime,
    releaseId: 'rt-2026.10.03-1',
    host: newHost.host,
    manager: newHost.manager,
  };
  const providerOnly: ReleaseTuple = {
    ...base,
    releaseId: 'rt-2026.09.27-1',
    providers: [{ ...comp('k', 'codex', '1.1.0'), provider: 'codex' }],
  };
  const floored: ReleaseTuple = {
    ...base,
    releaseId: 'rt-2026.10.04-1',
    clientFloor: { web: 2026100401, android: 140, ios: 88, desktop: 0, cli: 0 },
  };
  // Production, 2026-09-28 (CT-134): runtimes declare they read only their own newest schema, and a release's
  // migration is an `expand` the previous schema's binary still reads and writes.
  const schema48: ReleaseTuple = {
    ...base,
    releaseId: 'pve-20260928.4',
    runtime: {
      ...base.runtime,
      ...comp('a', 'whombat-runtime'),
      schemaReads: { min: 48, max: 48 },
      schemaWrites: 48,
    },
  };
  const schema49: ReleaseTuple = {
    ...base,
    releaseId: 'pve-20260928.5',
    runtime: {
      ...base.runtime,
      ...comp('f', 'whombat-runtime'),
      schemaReads: { min: 49, max: 49 },
      schemaWrites: 49,
    },
  };
  // A current runtime whose tuple claims it reads the candidate's schema (the floors say read-only).
  const wideReader: ReleaseTuple = {
    ...base,
    releaseId: 'rt-2026.09.25-2',
    runtime: { ...base.runtime, ...comp('g', 'whombat-runtime'), schemaReads: { min: 10, max: 14 } },
  };
  const tuples = {
    base,
    newRuntime,
    compatible,
    newHost,
    both,
    providerOnly,
    floored,
    schema48,
    schema49,
    wideReader,
  };
  const activation = [
    ['same tuple', 'base', 'base', 12],
    ['forward migration needs a checkpoint', 'base', 'newRuntime', 12],
    ['rollback-compatible runtime', 'base', 'compatible', 12],
    ['candidate cannot read the schema, no downgrade', 'newRuntime', 'base', 14],
    ['host ABI the runtime does not support', 'base', 'newHost', 12],
    ['runtime and host together', 'base', 'both', 12],
  ].map(([name, current, candidate, dbSchema]) => ({
    name,
    current,
    candidate,
    dbSchema,
    expect: checkActivation(
      tuples[current as keyof typeof tuples],
      tuples[candidate as keyof typeof tuples],
      dbSchema as number,
    ),
  }));
  const M = (
    target: number,
    readers: number | null,
    writers: number | null,
    needsCheckpoint: string[] = [],
  ): SchemaMigration => ({ target, readers, writers, needsCheckpoint });
  const migrating = (
    [
      [
        'expand the current schema reads and writes: no checkpoint',
        'schema48',
        'schema49',
        48,
        M(49, 48, 48),
      ],
      [
        'the same without floors (a runtime before MD-12): refused as before',
        'schema48',
        'schema49',
        48,
        M(49, null, null),
      ],
      [
        'no floors, a contract migration the runtime names: checkpoint',
        'base',
        'compatible',
        12,
        M(12, null, null, ['0012_c']),
      ],
      [
        'contract: the current schema may only read, checkpoint',
        'schema48',
        'schema49',
        48,
        M(49, 48, 49, ['0048_c']),
      ],
      [
        'backfill narrowing writers without a named migration: read-only, checkpoint',
        'schema48',
        'schema49',
        48,
        M(49, 47, 49),
      ],
      [
        'incompatible: nothing older reads it, checkpoint',
        'schema48',
        'schema49',
        48,
        M(49, 49, 49, ['0048_i']),
      ],
      [
        'the floors decide, not a current tuple that claims to read the target',
        'wideReader',
        'newRuntime',
        12,
        M(14, 12, 14),
      ],
      ['a target the tuple does not write', 'schema48', 'schema49', 48, M(50, 48, 48)],
      ['host ABI the runtime does not support', 'base', 'both', 12, M(14, 12, 12)],
    ] as const
  ).map(([name, current, candidate, dbSchema, migration]) => ({
    name,
    current,
    candidate,
    dbSchema,
    migration,
    expect: checkMigratingActivation(tuples[current], tuples[candidate], dbSchema, migration),
  }));
  const F = (readers: number, writers: number): SchemaFloors => ({ readers, writers });
  const exitZero = (
    [
      [
        'custody rollback after an expand: the older runtime reads and writes the newer schema',
        'schema49',
        'schema48',
        49,
        F(47, 48),
      ],
      ['after a contract the older runtime may only read', 'schema49', 'schema48', 49, F(48, 49)],
      ['after a contract nothing older reads it', 'schema49', 'schema48', 49, F(49, 49)],
      ['the current schema: the same answer as checkActivation', 'schema48', 'schema48', 48, F(47, 48)],
      ['a newer candidate that reads the live schema as it is', 'base', 'newRuntime', 12, F(10, 12)],
      ['the installed runtime is below the floors: no way back', 'base', 'newRuntime', 14, F(13, 14)],
      ['host ABI the runtime does not support', 'base', 'both', 12, F(12, 12)],
    ] as const
  ).map(([name, current, candidate, dbSchema, floors]) => ({
    name,
    current,
    candidate,
    dbSchema,
    floors,
    expect: checkCompatibleActivation(tuples[current], tuples[candidate], dbSchema, floors),
  }));
  const classes = [
    ['base', 'base'],
    ['base', 'newRuntime'],
    ['base', 'providerOnly'],
    ['base', 'newHost'],
    ['base', 'both'],
  ].map(([current, candidate]) => ({
    current,
    candidate,
    expect: updateClass(tuples[current as keyof typeof tuples], tuples[candidate as keyof typeof tuples]),
  }));
  const overlaps = [
    [
      { min: 1000, max: 1009 },
      { min: 1000, max: 1000 },
    ],
    [
      { min: 1000, max: 2001 },
      { min: 2000, max: 2003 },
    ],
    [
      { min: 1000, max: 1009 },
      { min: 2000, max: 2003 },
    ],
    [
      { min: 3000, max: 3000 },
      { min: 1000, max: 2005 },
    ],
  ].map(([client, runtime]) => ({
    client,
    runtime,
    expect: protocolOverlap(client as IntRange, runtime as IntRange),
  }));
  const serves = [
    { version: { major: 1, minor: 7 }, expect: servesClient(base, { major: 1, minor: 7 }) },
    { version: { major: 2, minor: 0 }, expect: servesClient(base, { major: 2, minor: 0 }) },
  ];
  const floorCases: { name: string; tuple: keyof typeof tuples; platform: string; buildNumber?: number }[] = [
    { name: 'no floor in the tuple', tuple: 'base', platform: 'android', buildNumber: 1 },
    { name: 'android at the floor', tuple: 'floored', platform: 'android', buildNumber: 140 },
    { name: 'android below the floor', tuple: 'floored', platform: 'android', buildNumber: 139 },
    { name: 'web above the floor', tuple: 'floored', platform: 'web', buildNumber: 2026100502 },
    { name: 'ios without a build number', tuple: 'floored', platform: 'ios' },
    { name: 'desktop without a floor (0)', tuple: 'floored', platform: 'desktop' },
    { name: 'unknown platform', tuple: 'floored', platform: 'watch', buildNumber: 1 },
  ];
  const floors = floorCases.map((c) => ({
    ...c,
    expect: clientBelowFloor(tuples[c.tuple].clientFloor, c),
  }));
  const k1 = key('assignment-1');
  const k2 = key('assignment-2');
  const k3 = key('assignment-3');
  const T = 1_790_000_000;
  const K = (
    kid: string,
    publicKey: string,
    state: string,
    notBefore: number | null,
    notAfter: number | null,
  ) => ({
    kid,
    publicKey,
    state,
    notBefore,
    notAfter,
  });
  const imageN = {
    v: 1,
    env: 'dev',
    keys: [K('asg-1', k1.publicKey, 'active', null, null), K('asg-2', k2.publicKey, 'next', T, null)],
  };
  const imageN1 = {
    v: 1,
    env: 'dev',
    keys: [
      K('asg-2', k2.publicKey, 'active', null, null),
      K('asg-1', k1.publicKey, 'retired', null, T + 90 * 86_400),
    ],
  };
  const keyMap = (d: unknown, env: string, now: number) => {
    try {
      return { keys: assignmentKeyMap(d, env, now) };
    } catch (e) {
      return { error: (e as { code?: string }).code ?? 'unknown' };
    }
  };
  const docWith = (...keys: ReturnType<typeof K>[]) => ({ v: 1, env: 'dev', keys });
  const assignmentKeys = [
    {
      name: 'image N before the scheduled rotation: next not accepted yet',
      doc: imageN,
      env: 'dev',
      now: T - 1,
    },
    { name: 'image N from the rotation on: next accepted', doc: imageN, env: 'dev', now: T },
    {
      name: 'image N+1 during the grace period: retired accepted',
      doc: imageN1,
      env: 'dev',
      now: T + 90 * 86_400,
    },
    {
      name: 'image N+1 after the grace period: retired dropped',
      doc: imageN1,
      env: 'dev',
      now: T + 90 * 86_400 + 1,
    },
    {
      name: 'unscheduled next is pinned but never accepted',
      doc: docWith(
        K('asg-1', k1.publicKey, 'active', null, null),
        K('asg-3', k3.publicKey, 'next', null, null),
      ),
      env: 'dev',
      now: T,
    },
    { name: 'another environment', doc: imageN, env: 'prod', now: T },
    {
      name: 'duplicate kid',
      doc: docWith(imageN.keys[0] as ReturnType<typeof K>, imageN.keys[0] as ReturnType<typeof K>),
      env: 'dev',
      now: T,
    },
    {
      name: 'retired without notAfter is invalid',
      doc: docWith(
        K('asg-2', k2.publicKey, 'active', null, null),
        K('asg-1', k1.publicKey, 'retired', null, null),
      ),
      env: 'dev',
      now: T,
    },
    {
      name: 'retired with notBefore is invalid',
      doc: docWith(
        K('asg-2', k2.publicKey, 'active', null, null),
        K('asg-1', k1.publicKey, 'retired', T, T + 1),
      ),
      env: 'dev',
      now: T,
    },
    {
      name: 'active with a window is invalid',
      doc: docWith(K('asg-1', k1.publicKey, 'active', null, T)),
      env: 'dev',
      now: T,
    },
    {
      name: 'next with notAfter is invalid',
      doc: docWith(
        K('asg-1', k1.publicKey, 'active', null, null),
        K('asg-2', k2.publicKey, 'next', T, T + 5),
      ),
      env: 'dev',
      now: T,
    },
    { name: 'no active key', doc: docWith(K('asg-2', k2.publicKey, 'next', T, null)), env: 'dev', now: T },
    {
      name: 'unknown state',
      doc: docWith(K('asg-1', k1.publicKey, 'revoked', null, null)),
      env: 'dev',
      now: T,
    },
  ].map((c) => ({ ...c, expect: keyMap(c.doc, c.env, c.now) }));
  return {
    description:
      'Release compatibility (CT-35): checkActivation(current, candidate, dbSchema), checkMigratingActivation(current, candidate, dbSchema, migration) (CT-134: `migrating`), checkCompatibleActivation(current, candidate, dbSchema, floors) (CT-135: `compatible`), compareVersions(a, b) (CT-135: `versions`, −1/0/1), updateClass, protocolOverlap, servesClient (tuples in `tuples`), clientBelowFloor (CT-53: `expect` is the minimum build or null), RETRYABLE_UPDATE_FAILURES (CT-147: `retryable`), and assignmentKeyMap (CT-41: `expect` is `{keys}` accepted at `now` or `{error: code}`). Same results in Go.',
    tuples,
    activation,
    migrating,
    compatible: exitZero,
    versions: versionVectors(),
    classes,
    overlaps,
    serves,
    floors,
    /** RETRYABLE_UPDATE_FAILURES (CT-147): the same list in Go. */
    retryable: RETRYABLE_UPDATE_FAILURES,
    /** tupleDigest of each tuple: a tuple without `clientFloor` keeps its pre-0.5.3 digest (CT-53). */
    digests: Object.fromEntries(Object.entries(tuples).map(([name, t]) => [name, tupleDigest(t)])),
    assignmentKeys,
  };
}

/**
 * compareVersions (CT-135): semver basics, host release ids, the text-ordering trap of the `0.1.0-<hex>` runtimes,
 * the transition (UP-A2: every version published before the `0.2.0` scheme is older than every new one) and the new
 * scheme (commit time, then rev, then `.p<digest>` / `.<label>`).
 */
function versionVectors() {
  const pairs: [string, string, string][] = [
    ['equal', '1.0.0', '1.0.0'],
    ['patch', '1.0.0', '1.0.1'],
    ['numeric, not text', '1.10.0', '1.9.0'],
    ['a missing segment is 0', '1.0', '1.0.0'],
    ['leading zeros are numeric', '26.05.2', '26.5.10'],
    ['a pre-release before its release', '1.0.0-rc.1', '1.0.0'],
    ['pre-release segments numerically', '1.0.0-rc.2', '1.0.0-rc.10'],
    ['numeric before alphanumeric', '1.0.0-alpha', '1.0.0-1'],
    ['fewer pre-release segments first', '1.0.0-rc', '1.0.0-rc.1'],
    ['build metadata ignored', '1.0.0+build.5', '1.0.0+build.9'],
    [
      'a segment beyond 64 bits is text, after every number',
      '1.18446744073709551616',
      '1.18446744073709551615',
    ],
    ['the largest 64-bit segment is a number', '1.18446744073709551615', '1.18446744073709551614'],
    ['an empty segment is text', '1..0', '1.0.0'],
    ['build metadata ignored after a pre-release', '1.4.0-rc.1+x', '1.4.0-rc.1'],
    ['host: same day, next build', 'pve-20260928.5', 'pve-20260928.6'],
    ['host: build 10 after build 6', 'pve-20260928.6', 'pve-20260928.10'],
    ['host: next day after build 10', 'pve-20260928.10', 'pve-20260929.1'],
    ['host: build 5 before build 10', 'pve-20260928.10', 'pve-20260928.5'],
    ['dev host: same day, next build', 'pve-dev-20260928.5', 'pve-dev-20260928.6'],
    ['dev host: build 10 after build 6', 'pve-dev-20260928.6', 'pve-dev-20260928.10'],
    ['dev host: next day after build 10', 'pve-dev-20260928.10', 'pve-dev-20260929.1'],
    // CT-550: the release ids after PI-23 sort after every earlier one, whatever the day.
    ['host: whombat- after pve-, whatever the day', 'pve-20261002.5', 'whombat-20261001.1'],
    [
      'dev host: whombat-dev- after pve-dev-, whatever the day',
      'pve-dev-20261021.9',
      'whombat-dev-20261020.1',
    ],
    ['dev host: whombat-dev build 10 after build 9', 'whombat-dev-20261020.9', 'whombat-dev-20261020.10'],
    // 4.4 (Whombat whombat-link.md): one release id family, ordered by date and build number whatever the prefix.
    ['one family: a dev id before a later production id', 'whombat-dev-20261118.3', 'whombat-20261119.1'],
    ['one family: a production id before a later dev id', 'whombat-20261118.3', 'whombat-dev-20261119.1'],
    [
      'one family: same day, production build 2 before dev build 10',
      'whombat-20261118.2',
      'whombat-dev-20261118.10',
    ],
    [
      'one family: same day, dev build 2 before production build 10',
      'whombat-dev-20261118.2',
      'whombat-20261118.10',
    ],
    ['one family: same day and build, the prefix ignored', 'whombat-dev-20261118.4', 'whombat-20261118.4'],
    ['one family: production build 10 after build 9', 'whombat-20261118.9', 'whombat-20261118.10'],
    ['outside the family: a suffix keeps the old order', 'whombat-20261119.1-rc', 'whombat-dev-20261118.1'],
    ['the trap: hex compared as text', '0.1.0-e847497', '0.1.0-195421a'],
    ['the trap: a patched bundle as text', '0.1.0-a2abeeb.p26a328c', '0.1.0-843d1ba'],
    ['new scheme: commit time first', '0.2.0-20260928190000.aaaaaaa', '0.2.0-20260928190001.0000000'],
    ['new scheme: across midnight', '0.2.0-20260928235959.fffffff', '0.2.0-20260929000000.0000000'],
    [
      'new scheme: a patched bundle after its base',
      '0.2.0-20260928190000.abcdef1',
      '0.2.0-20260928190000.abcdef1.p26a328c',
    ],
    [
      'new scheme: a patched bundle before a newer commit',
      '0.2.0-20260928190000.abcdef1.p26a328c',
      '0.2.0-20260928190001.1234567',
    ],
    [
      'new scheme: a dev label after its base',
      '0.2.0-20260928190000.abcdef1.dev',
      '0.2.0-20260928190000.abcdef1',
    ],
    ['new scheme: a release build before the dev build', '0.2.0-20260928190000.abcdef1', '0.2.0-dev'],
    ['new scheme: before the plain release', '0.2.0-20260928190000.abcdef1', '0.2.0'],
    ['new scheme: the core decides first', '0.2.0-20260928190000.abcdef1', '0.3.0-20260101000000.0000000'],
  ];
  const published = [
    '0.1.0-a2abeeb.p26a328c',
    '0.1.0-843d1ba',
    '0.1.0-2be6fc1',
    '0.1.0-e847497',
    '0.1.0-195421a',
    '0.1.0',
    '0.0.48-2be6fc1',
  ];
  for (const next of ['0.2.0-20260928190000.abcdef1', '0.2.0-dev'])
    for (const old of published) {
      pairs.push([`transition: ${old} is older than ${next}`, old, next]);
      pairs.push([`transition: ${next} is newer than ${old}`, next, old]);
    }
  return pairs.map(([name, a, b]) => ({ name, a, b, expect: compareVersions(a, b) }));
}

/** Client bundles and the signed client channel (CT-74), checked by both languages. */
function clientVectors() {
  const now = 1_790_000_000;
  const chn = key('client-channel-1');
  const hex = (c: string) => c.repeat(64);
  const bundle = (
    provider: 'claude' | 'codex',
    version: string,
    arch: 'x86_64' | 'aarch64',
    adapter: IntRange,
  ): ClientBundle => ({
    provider,
    version,
    os: 'linux',
    arch,
    publishedAt: now - 86_400,
    testedAt: now - 3_600,
    fixturesDigest: `sha256:${hex('f')}`,
    adapter,
    artifact: {
      target: clientBundleTarget({ provider, version, os: 'linux', arch }),
      sha256: hex('a'),
      size: 80_000_000,
      path: provider,
    },
    source:
      provider === 'claude'
        ? {
            url: `https://storage.googleapis.com/claude-code-dist/claude-code-releases/${version}/linux-${arch === 'x86_64' ? 'x64' : 'arm64'}/claude`,
            sha256: hex('b'),
            size: 200_000_000,
            format: 'binary',
            path: null,
          }
        : {
            url: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-${arch}-unknown-linux-musl.tar.gz`,
            sha256: hex('c'),
            size: 30_000_000,
            format: 'tar.gz',
            path: `codex-${arch}-unknown-linux-musl`,
          },
    executable: { sha256: hex('e'), size: 190_000_000 },
  });
  const bundles = [
    bundle('claude', '2.1.290', 'x86_64', { min: 2, max: 2 }),
    bundle('claude', '2.1.278', 'x86_64', { min: 1, max: 2 }),
    bundle('codex', '0.158.0', 'x86_64', { min: 1, max: 1 }),
    bundle('codex', '0.158.0', 'aarch64', { min: 1, max: 1 }),
  ];
  const payload: ClientChannelPayload = {
    purpose: 'whombat-client-channel/v1',
    env: 'dev',
    sequence: 12,
    issuedAt: now,
    expiresAt: now + 7 * 86_400,
    bundles,
  };
  const sign = (p: ClientChannelPayload) => signDocument(p, 'chn-1', chn.secretKey);
  const doc = sign(payload);
  const ctx = { env: 'dev', lastSequence: 11 };
  const withBundle = (b: Partial<ClientBundle>) =>
    sign({ ...payload, bundles: [{ ...bundles[0], ...b } as ClientBundle] });
  const channels = [
    { name: 'valid', doc, now, ...ctx, expect: 'ok' },
    { name: 'the same channel again', doc, now, ...ctx, lastSequence: 12, expect: 'ok' },
    { name: 'an older channel (rollback)', doc, now, ...ctx, lastSequence: 13, expect: 'rolled_back' },
    { name: 'other env', doc, now, ...ctx, env: 'prod', expect: 'wrong_env' },
    { name: 'expired', doc, now: now + 7 * 86_400 + 300, ...ctx, expect: 'expired' },
    { name: 'issued in the future', doc, now: now - 301, ...ctx, expect: 'not_yet_valid' },
    { name: 'unknown key', doc: { ...doc, keyId: 'chn-9' }, now, ...ctx, expect: 'unknown_key' },
    {
      name: 'tampered executable digest',
      doc: {
        ...doc,
        payload: { ...payload, bundles: [{ ...bundles[0], executable: { sha256: hex('9'), size: 1 } }] },
      },
      now,
      ...ctx,
      expect: 'bad_signature',
    },
    {
      name: 'lifetime above 14 days',
      doc: sign({ ...payload, expiresAt: now + 14 * 86_400 + 1 }),
      now,
      ...ctx,
      expect: 'bad_lifetime',
    },
    {
      name: 'artifact target of another version',
      doc: withBundle({
        artifact: {
          ...(bundles[0] as ClientBundle).artifact,
          target: 'clients/claude/2.1.1/linux-x86_64.tar.gz',
        },
      }),
      now,
      ...ctx,
      expect: 'bad_bundle',
    },
    {
      name: 'inverted adapter range',
      doc: withBundle({ adapter: { min: 3, max: 2 } }),
      now,
      ...ctx,
      expect: 'bad_bundle',
    },
    {
      name: 'tested before it was published',
      doc: withBundle({ testedAt: now - 2 * 86_400 }),
      now,
      ...ctx,
      expect: 'bad_bundle',
    },
    {
      name: 'a binary source with a path inside',
      doc: withBundle({ source: { ...(bundles[0] as ClientBundle).source, path: 'claude' } }),
      now,
      ...ctx,
      expect: 'bad_bundle',
    },
    {
      name: 'the same bundle twice',
      doc: sign({ ...payload, bundles: [...bundles, bundles[2] as ClientBundle] }),
      now,
      ...ctx,
      expect: 'duplicate_bundle',
    },
    { name: 'schema violation', doc: { ...doc, extra: true }, now, ...ctx, expect: 'bad_schema' },
  ];
  const want = { os: 'linux' as const, arch: 'x86_64' as const };
  const selection = [
    {
      name: 'newest claude for adapter 2',
      want: { ...want, provider: 'claude', adapter: 2 },
      expect: '2.1.290',
    },
    {
      name: 'older claude for adapter 1',
      want: { ...want, provider: 'claude', adapter: 1 },
      expect: '2.1.278',
    },
    { name: 'no claude for adapter 3', want: { ...want, provider: 'claude', adapter: 3 }, expect: null },
    {
      name: 'codex on arm64',
      want: { ...want, arch: 'aarch64', provider: 'codex', adapter: 1 },
      expect: '0.158.0',
    },
    {
      name: 'no claude on arm64',
      want: { ...want, arch: 'aarch64', provider: 'claude', adapter: 2 },
      expect: null,
    },
  ];
  return {
    description:
      'Client channel (CT-74): verifyClientChannel (`expect` ok or the error code), clientBundleTarget, and selectClientBundle over `bundles` (`expect` is the selected version or null). Development keys only.',
    keys: { 'chn-1': chn.publicKey },
    channels,
    bundles,
    targets: bundles.map((b) => ({ bundle: b, target: clientBundleTarget(b) })),
    selection,
  };
}

export async function buildVectors(): Promise<Record<string, unknown>> {
  return {
    'feedback-drop.json': await feedbackDropVectors(),
    'backup-file.json': await backupFileVectors(),
    'clients.json': clientVectors(),
    'claim.json': claimVectors(),
    'cpace.json': cpaceVectors(),
    'compat.json': compatVectors(),
    'collab.json': collab(),
    'local.json': localVectors(),
    'session.json': {
      ...SESSION_VECTORS,
      diagnosticBundles: DIAGNOSTIC_BUNDLES.map((c) => ({
        ...c,
        ...(c.valid ? { sha256: sha256Hex(diagnosticBundleBytes(c.bundle)) } : {}),
      })),
      pairingFingerprints: PAIRING_FINGERPRINTS.map((peerId) => ({
        peerId,
        fingerprint: pairingFingerprint(peerId),
      })),
      passkeys: {
        userHandles: PASSKEY_CHALLENGES.userHandles.map((appliance) => ({
          appliance,
          userHandle: passkeyUserHandleBase64url(appliance),
        })),
        enroll: PASSKEY_CHALLENGES.enroll.map((c) => ({
          ...c,
          challenge: passkeyEnrollChallengeBase64url(c),
        })),
        register: PASSKEY_CHALLENGES.register.map((c) => ({
          ...c,
          challenge: passkeyRegisterChallengeBase64url(c),
        })),
        remoteHelp: PASSKEY_CHALLENGES.remoteHelp.map((c) => ({
          ...c,
          challenge: passkeyRemoteHelpChallengeBase64url(c),
        })),
      },
    },
    'admission.json': admission(),
    'licence.json': licence(),
    'frames.json': frames(),
    'signed.json': signed(),
    'schemas.json': {
      description:
        'Schema conformance: `valid` says whether the named schema (registry name = JSON Schema file = Go type) accepts `value`.',
      cases: SCHEMA_CASES,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = join(import.meta.dirname, '..', '..', 'vectors');
  mkdirSync(out, { recursive: true });
  for (const [file, data] of Object.entries(await buildVectors()))
    writeFileSync(join(out, file), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote vectors to ${out}`);
}
