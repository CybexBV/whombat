/**
 * The certificate watch on the box (docs/decisions/own-address.md): the manager asks Certificate Transparency (Cert
 * Spotter) and hands over what it found; the box decides what is foreign. Pure.
 *
 * A certificate counts when it names the box's host, a name under it, or exactly `*.<zone>` (a wildcard covering it).
 * One whose public key (SPKI SHA-256) is in the box's own list (what it served, what its manager ordered) is the box's
 * own, renewals included; anything else is foreign. `*.whombat.app` and other names don't cover the host.
 */
import type { OwnAddressCtCert } from '@whombat/control-contracts/local';

/** Whether `name` (as CT lists it, lower case) is the host, under it, or the zone's wildcard. */
export function coversHost(name: string, host: string): boolean {
  const n = name.toLowerCase().replace(/\.$/, '');
  if (n === host || n.endsWith(`.${host}`)) return true;
  const zone = host.slice(host.indexOf('.') + 1);
  return n === `*.${zone}`;
}

export interface ForeignCertificate {
  spkiSha256: string;
  names: string[];
  notBefore: string;
  notAfter: string;
}

/**
 * The certificates of `certs` that cover `host` and whose key isn't `own`, one per key (the latest ending wins), with
 * only the names that cover the host (at most 20).
 */
export function foreignCertificates(input: {
  host: string;
  own: ReadonlySet<string>;
  certs: readonly OwnAddressCtCert[];
}): ForeignCertificate[] {
  const byKey = new Map<string, ForeignCertificate>();
  for (const cert of input.certs) {
    const names = cert.dnsNames.filter((n) => coversHost(n, input.host));
    if (!names.length || input.own.has(cert.spkiSha256)) continue;
    const seen = byKey.get(cert.spkiSha256);
    if (seen && Date.parse(seen.notAfter) >= Date.parse(cert.notAfter)) continue;
    byKey.set(cert.spkiSha256, {
      spkiSha256: cert.spkiSha256,
      names: names.slice(0, 20),
      notBefore: cert.notBefore,
      notAfter: cert.notAfter,
    });
  }
  return [...byKey.values()];
}

/** How long without a fresh check before the person hears of it. */
export const UNCHECKED_AFTER_MS = 2 * 86_400_000;

/** Whether checking stopped long enough to tell: no fresh check for two days (or none since checking began). */
export function uncheckedSince(
  watch: { lastFreshAt: string | null; checkingSince: string },
  now: Date,
): string | null {
  const since = watch.lastFreshAt ?? watch.checkingSince;
  return now.getTime() - Date.parse(since) >= UNCHECKED_AFTER_MS ? since : null;
}
