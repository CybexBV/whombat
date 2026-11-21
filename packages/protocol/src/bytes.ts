/**
 * Byte helpers that work in Node, browsers and Hermes: base64url via `@scure/base`, UTF-8 via
 * `TextEncoder` and core's strict decoder (Hermes may lack `TextDecoder`).
 */
import { base58, base64urlnopad } from '@scure/base';
import { decodeUtf8, utf8ByteLength } from '@whombat/core/text/utf8';

declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };

/** base64url without padding (RFC 7515 §2). */
export function base64urlEncode(bytes: Uint8Array): string {
  return base64urlnopad.encode(bytes);
}

/** Strict base64url (no padding, canonical trailing bits); throws on anything else. */
export function base64urlDecode(text: string): Uint8Array {
  return base64urlnopad.decode(text);
}

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Byte length of the UTF-8 encoding of a string (lone surrogates count as U+FFFD, like TextEncoder). */
export { utf8ByteLength };

export class Utf8Error extends Error {
  constructor(offset: number) {
    super(`invalid UTF-8 at byte ${offset}`);
    this.name = 'Utf8Error';
  }
}

/** Strict UTF-8 decoding (rejects overlong forms, surrogates, code points above U+10FFFF, truncation). */
export function utf8Decode(bytes: Uint8Array): string {
  const text = decodeUtf8(bytes);
  if (typeof text !== 'string') throw new Utf8Error(text.offset);
  return text;
}

/**
 * libp2p PeerId (base58btc identity multihash of the protobuf-encoded public key) of a raw Ed25519 public key:
 * `base58(0x00 0x24 0x08 0x01 0x12 0x20 ‖ key)`, i.e. `12D3KooW…`.
 */
export function peerIdFromEd25519PublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('Ed25519 public keys are 32 bytes');
  const bytes = new Uint8Array(38);
  bytes.set([0x00, 0x24, 0x08, 0x01, 0x12, 0x20]);
  bytes.set(publicKey, 6);
  return base58.encode(bytes);
}

/** The raw Ed25519 public key inside an Ed25519 PeerId, or null when it isn't one. */
export function ed25519PublicKeyFromPeerId(peerId: string): Uint8Array | null {
  try {
    const bytes = base58.decode(peerId);
    const prefix = [0x00, 0x24, 0x08, 0x01, 0x12, 0x20];
    if (bytes.length !== 38 || prefix.some((b, i) => bytes[i] !== b)) return null;
    return bytes.slice(6);
  } catch {
    return null;
  }
}
