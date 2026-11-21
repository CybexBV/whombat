/**
 * Fingerprints people compare (AP-21, AP-22): the short form of a PeerId as groups of five (`ABCDE FGHIJ …`),
 * whatever spelling it came in (claim card, QR text, typed, library). Nothing here implements cryptography.
 */
import { fingerprint, normalizeFingerprint } from '@whombat/secure-channel';

/** `ABCDE FGHIJ …` for a fingerprint in any spelling (card, typed, library). */
export function formatFingerprint(raw: string): string {
  let clean: string;
  try {
    clean = normalizeFingerprint(raw);
  } catch {
    clean = raw;
  }
  clean = clean.replace(/[^0-9a-z]/gi, '').toUpperCase();
  return clean.match(/.{1,5}/g)?.join(' ') ?? clean;
}

export function sameFingerprint(a: string, b: string): boolean {
  const x = formatFingerprint(a);
  return x.length > 0 && x === formatFingerprint(b);
}

/** The short fingerprint of a PeerId (what a claim card prints). */
export function fingerprintOf(peerId: string): string {
  return formatFingerprint(fingerprint(peerId));
}
