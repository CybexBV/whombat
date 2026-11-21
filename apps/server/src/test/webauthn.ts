/**
 * A software WebAuthn authenticator for tests (docs/decisions/passkeys.md): one ES256 (P-256) credential, attestation
 * `none`, and assertions with the flags and counter a test asks for. It builds `clientDataJSON`, authenticator data
 * (RP ID hash, UP/UV/BE/BS/AT, counter, attested credential data with the COSE key) and the attestation object (CBOR)
 * as a browser and a platform authenticator would, and answers in the `@simplewebauthn` JSON clients send.
 */
import { createHash, createSign, generateKeyPairSync, type KeyObject, randomBytes } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const sha256 = (bytes: Uint8Array | string) => new Uint8Array(createHash('sha256').update(bytes).digest());

export const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 } as const;

export interface CeremonyOptions {
  rpId: string;
  origin: string;
  /** base64url, as the options carry it. */
  challenge: string;
  /** User verification (default true). */
  uv?: boolean;
  /** `webauthn.create` / `webauthn.get` unless overridden. */
  type?: string;
}

export class SoftwareAuthenticator {
  readonly credentialId: Uint8Array = new Uint8Array(randomBytes(16));
  private readonly privateKey: KeyObject;
  private readonly cose: Uint8Array;
  /** The signature counter; 0 keeps none (most passkeys). */
  counter: number;
  /** Backup eligible / backed up: a synced passkey (Google Password Manager, iCloud Keychain). */
  synced: boolean;
  /** The `user.id` it was registered with (base64url), returned as `userHandle`. */
  userHandle: string | null = null;

  constructor(options: { counter?: number; synced?: boolean } = {}) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, new Uint8Array(Buffer.from(jwk.x as string, 'base64url'))],
        [-3, new Uint8Array(Buffer.from(jwk.y as string, 'base64url'))],
      ]),
    );
    this.counter = options.counter ?? 0;
    this.synced = options.synced ?? false;
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  private flags(o: { uv?: boolean; at?: boolean }): number {
    let f = FLAG.UP;
    if (o.uv !== false) f |= FLAG.UV;
    if (this.synced) f |= FLAG.BE | FLAG.BS;
    if (o.at) f |= FLAG.AT;
    return f;
  }

  private authData(rpId: string, flags: number, attested: boolean): Uint8Array {
    const head = Buffer.alloc(37);
    Buffer.from(sha256(rpId)).copy(head, 0);
    head[32] = flags;
    head.writeUInt32BE(this.counter >>> 0, 33);
    if (!attested) return new Uint8Array(head);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credentialId.length);
    return new Uint8Array(
      Buffer.concat([head, Buffer.alloc(16), len, Buffer.from(this.credentialId), Buffer.from(this.cose)]),
    );
  }

  private clientData(type: string, o: CeremonyOptions): Uint8Array {
    return new Uint8Array(
      Buffer.from(JSON.stringify({ type, challenge: o.challenge, origin: o.origin, crossOrigin: false })),
    );
  }

  /** `navigator.credentials.create` with attestation `none`, for `user.id` (base64url). */
  create(o: CeremonyOptions & { userId: string }) {
    this.userHandle = o.userId;
    const clientDataJSON = this.clientData(o.type ?? 'webauthn.create', o);
    const authData = this.authData(o.rpId, this.flags({ uv: o.uv, at: true }), true);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, string>>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, string>()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    };
  }

  /**
   * `navigator.credentials.get`: signs `authData ‖ SHA-256(clientDataJSON)` (DER ECDSA). The counter moves by
   * `step` first (default: +1 when it keeps one); `userHandle` null leaves it out.
   */
  get(o: CeremonyOptions & { userHandle?: string | null; step?: number }) {
    if (o.step !== undefined) this.counter += o.step;
    else if (this.counter > 0) this.counter += 1;
    const clientDataJSON = this.clientData(o.type ?? 'webauthn.get', o);
    const authData = this.authData(o.rpId, this.flags({ uv: o.uv }), false);
    const signer = createSign('SHA256');
    signer.update(Buffer.concat([Buffer.from(authData), Buffer.from(sha256(clientDataJSON))]));
    const signature = new Uint8Array(signer.sign(this.privateKey));
    const userHandle = o.userHandle === undefined ? this.userHandle : o.userHandle;
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(userHandle ? { userHandle } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    };
  }
}
