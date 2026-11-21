/**
 * Dev appliance provisioning (IN-08): the same on-disk layout and control registration as
 * `appliance/provisioning` (`whombat-provision`, NX-24), done in TypeScript with the contracts'
 * `signRegistration` because the Go tool needs root and a `whombat-manager` user. Files in `<dir>/identity/`:
 * `management.key` (PKCS#8 PEM, 0600), `management.pub`, `content.key` (libp2p protobuf, 0600), `content.peerid`,
 * `device.json` (public record), `claim.json` (`sha256-b64url(whombat-claim-secret/1)` hash, the runtime's
 * `WHOMBAT_CLAIM_FILE`); the claim card (`claim-card.json`, `claim-card.txt`) carries the secret and lives
 * next to it, like the printed card, not in `identity/`.
 */
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeviceRegistrationResponse, signRegistration } from '@whombat/control-contracts/device';
import { fingerprint, generateIdentity, serializeIdentity } from '@whombat/secure-channel';
import { contractsAtLeast } from '../manifest/version.ts';
import { claimProof } from '../scenario-kit/cloud.ts';

export interface ClaimCard {
  v: 1;
  deviceId: string;
  peerId: string;
  fingerprint: string;
  /** 26 base32 characters (normalized). */
  claimSecret: string;
  /** Grouped for printing (XXXX-XXXX-…-XX). */
  claimSecretDisplay: string;
  claimUrl: string;
  environment: 'local';
}

export interface DeviceRecord {
  v: 1;
  deviceId: string;
  env: 'local';
  applianceRoute: string;
  model: string;
  serial: string;
  contentPeerId: string;
  contentPublicKey: string;
  managementPublicKey: string;
  fingerprint: string;
  provisionedAt: number;
  recoveryKeyEnrolled: boolean;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export const normalizeSecret = (s: string) => s.toUpperCase().replace(/[\s-]/g, '');

/** Provisioning's `claim.SecretHash`: b64url(SHA-256("whombat-claim-secret/1\n" + deviceId + "\n" + secret)). */
export function claimSecretHash(deviceId: string, secret: string): string {
  return createHash('sha256')
    .update(`whombat-claim-secret/1\n${deviceId}\n${normalizeSecret(secret)}`)
    .digest('base64url');
}

export const displaySecret = (s: string) => s.match(/.{1,4}/g)?.join('-') ?? s;

export function claimUrl(base: string, deviceId: string, peerId: string, secret: string): string {
  const q = new URLSearchParams({ v: '1', d: deviceId, p: peerId, s: normalizeSecret(secret) });
  return `${base}#${q.toString()}`;
}

/**
 * The printed card's words (provisioning `card.ClaimSVG`, CC-02): appliance id, claim code and the link the QR code
 * carries; no fingerprint to compare. On the dev appliance the console code (`dev/console`) is the usual way to
 * claim; the card is the fallback ("Claim with a card" in the app).
 */
export function claimCardText(card: ClaimCard, claimUrlBase: string): string {
  const host = claimUrlBase.replace(/^https?:\/\//, '');
  return [
    'Claim your Whombat (local development appliance)',
    '',
    `Scan the code, or open ${host} and choose “Claim with a card”:`,
    '',
    `Appliance ID   ${card.deviceId}`,
    `Claim code     ${card.claimSecretDisplay}`,
    '',
    `Claim link     ${card.claimUrl}`,
    '',
    'Keep this card private. Anyone with the claim code can claim this appliance until you do.',
    'The code works once. Whombat staff will never ask you for it.',
    '',
    'Or claim with the code on the appliance’s console: dev/console.',
    '',
  ].join('\n');
}

/** provisioning's LocalRegistrar: `wb-` and three groups of four of Crockford's base32, from 60 random bits. */
export function localDeviceId(): string {
  const a = '0123456789abcdefghjkmnpqrstvwxyz';
  const b = randomBytes(12);
  let id = 'wb-';
  for (let i = 0; i < 12; i++) id += (i > 0 && i % 4 === 0 ? '-' : '') + a[(b[i] ?? 0) % 32];
  return id;
}

/** Raw 32-byte seed of an Ed25519 PKCS#8 key (the last 32 bytes of the DER). */
function seedOfPkcs8(pem: string): Buffer {
  const der = createPrivateKey(pem).export({ format: 'der', type: 'pkcs8' });
  return der.subarray(der.length - 32);
}

export interface ProvisionResult {
  record: DeviceRecord;
  card: ClaimCard;
  identityDir: string;
  cardFile: string;
  claimFile: string;
  created: boolean;
}

/**
 * Provisions once per state directory: a second call returns the existing identity (like the factory tool, it
 * never regenerates keys over an existing identity).
 */
export async function provisionDevAppliance(options: {
  dir: string;
  controlUrl: string;
  provisioningToken: string;
  claimUrlBase: string;
  serial?: string;
  /**
   * `local`: the identity is made on the box, as every image makes it now (Whombat LNK-01, provisioning's
   * LocalRegistrar): no registration at control, a device id of the box's own, the route `local`, and the signed
   * registration kept as `registration.json` for `link.begin`. Default `control` (a box control registered, like Home).
   */
  registrar?: 'control' | 'local';
}): Promise<ProvisionResult> {
  const identityDir = join(options.dir, 'identity');
  const cardFile = join(options.dir, 'claim-card.json');
  const claimFile = join(identityDir, 'claim.json');
  if (existsSync(join(identityDir, 'device.json')) && existsSync(cardFile)) {
    return {
      record: JSON.parse(readFileSync(join(identityDir, 'device.json'), 'utf8')) as DeviceRecord,
      card: JSON.parse(readFileSync(cardFile, 'utf8')) as ClaimCard,
      identityDir,
      cardFile,
      claimFile,
      created: false,
    };
  }
  mkdirSync(identityDir, { recursive: true, mode: 0o700 });

  // Management key: Ed25519, PKCS#8 PEM (the manager's identity.Load format).
  const mgmt = generateKeyPairSync('ed25519');
  const mgmtPem = mgmt.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const mgmtSeed = seedOfPkcs8(mgmtPem);
  const mgmtPub = Buffer.from(mgmt.publicKey.export({ format: 'der', type: 'spki' })).subarray(-32);

  // Content identity: libp2p Ed25519 (the runtime's WHOMBAT_CONTENT_KEY_FILE).
  const content = await generateIdentity();
  const contentRaw = (content.privateKey as unknown as { raw: Uint8Array }).raw;
  const contentSeed = Buffer.from(contentRaw.subarray(0, 32));
  const contentPub = Buffer.from(content.publicKey);

  const serial = options.serial ?? `DEV-${randomBytes(6).toString('hex').toUpperCase()}`;
  const unsigned = {
    env: 'local' as const,
    hardwareSerial: serial,
    model: 'whombat-dev',
    managementPublicKey: mgmtPub.toString('hex'),
    contentPeerId: content.peerId,
    contentPublicKey: contentPub.toString('hex'),
    provisionedAt: Math.floor(Date.now() / 1000),
  };
  const registration = signRegistration(unsigned, {
    managementSecretKeyHex: mgmtSeed.toString('hex'),
    contentSecretKeyHex: contentSeed.toString('hex'),
  });
  const secret = base32(randomBytes(16));
  const local = options.registrar === 'local';
  let reg: { device: string; applianceRoute: string };
  if (local) {
    reg = { device: localDeviceId(), applianceRoute: 'local' };
    writeFileSync(join(identityDir, 'registration.json'), `${JSON.stringify(registration)}\n`, {
      mode: 0o644,
    });
  } else {
    const res = await fetch(`${options.controlUrl}/v1/provisioning/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.provisioningToken}` },
      body: JSON.stringify(registration),
    });
    const body = await res.text();
    if (res.status !== 201 && res.status !== 200)
      throw new Error(
        `control refused the registration: ${res.status} ${res.headers.get('x-whombat-reason') ?? ''} ${body}`,
      );
    reg = DeviceRegistrationResponse.parse(JSON.parse(body));

    if (contractsAtLeast('0.5.1')) {
      // CT-43: control keeps a verifier of the claim secret (domain-separated), before the card is printed.
      const v = await fetch(`${options.controlUrl}/v1/provisioning/devices/${reg.device}/claim-verifier`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.provisioningToken}` },
        body: JSON.stringify({ claimVerifier: claimProof(reg.device, secret) }),
      });
      if (!v.ok) throw new Error(`control refused the claim verifier: ${v.status} ${await v.text()}`);
    }
  }
  const fp = fingerprint(content.peerId);
  const record: DeviceRecord = {
    v: 1,
    deviceId: reg.device,
    env: 'local',
    applianceRoute: reg.applianceRoute,
    model: unsigned.model,
    serial,
    contentPeerId: content.peerId,
    contentPublicKey: unsigned.contentPublicKey,
    managementPublicKey: unsigned.managementPublicKey,
    fingerprint: fp,
    provisionedAt: unsigned.provisionedAt,
    recoveryKeyEnrolled: false,
  };
  const card: ClaimCard = {
    v: 1,
    deviceId: reg.device,
    peerId: content.peerId,
    fingerprint: fp,
    claimSecret: secret,
    claimSecretDisplay: displaySecret(secret),
    claimUrl: claimUrl(options.claimUrlBase, reg.device, content.peerId, secret),
    environment: 'local',
  };
  const w = (f: string, data: string | Uint8Array, mode: number) =>
    writeFileSync(join(identityDir, f), data, { mode });
  w('management.key', mgmtPem, 0o600);
  w('management.pub', `${record.managementPublicKey}\n`, 0o644);
  w('content.key', serializeIdentity(content), 0o600);
  w('content.peerid', `${content.peerId}\n`, 0o644);
  w('device.json', `${JSON.stringify(record, null, 2)}\n`, 0o644);
  w(
    'claim.json',
    `${JSON.stringify(
      {
        v: 1,
        deviceId: reg.device,
        secretHash: claimSecretHash(reg.device, secret),
        algorithm: 'sha256-b64url(whombat-claim-secret/1)',
      },
      null,
      2,
    )}\n`,
    0o600,
  );
  writeFileSync(cardFile, `${JSON.stringify(card, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(options.dir, 'claim-card.txt'), claimCardText(card, options.claimUrlBase), {
    mode: 0o600,
  });
  return { record, card, identityDir, cardFile, claimFile, created: true };
}
