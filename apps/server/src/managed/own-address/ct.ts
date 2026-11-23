/**
 * The certificate watch on the box (docs/decisions/own-address.md): the manager asks Certificate Transparency (Cert
 * Spotter) and hands over what it found; the box decides what is foreign. Pure.
 *
 * A certificate counts when it names one of the hosts the box answers at (its current one, and the one it is leaving
 * while that still works), a name under it, or exactly `*.<zone>` (a wildcard covering it: `*.whombat.app` covers
 * `home.whombat.app`, never `maple-otter-river.box.whombat.app`). One whose public key (SPKI SHA-256) is in the box's own
 * list (what it served, what its manager ordered) is the box's own, renewals included. Cloudflare's two certificates for
 * `*.whombat.app` (`OWN_ADDRESS_ZONE_CERTIFICATES`) are known within their dates: whombat.app's DNS ran there when they
 * were issued, and the person reads about them under the address instead of an alarm. Anything else is foreign.
 */
import type { OwnAddressCtCert } from '@whombat/control-contracts/local';
import { ownAddressZoneCertificate } from '@whombat/protocol/own-address';

/** Whether `name` (as CT lists it, lower case) is the host, under it, or the wildcard of its zone. */
export function coversHost(name: string, host: string): boolean {
  const n = name.toLowerCase().replace(/\.$/, '');
  if (n === host || n.endsWith(`.${host}`)) return true;
  // A label has no dots: everything after the first one is the zone.
  const zone = host.slice(host.indexOf('.') + 1);
  return n === `*.${zone}`;
}

/** Whether any of `names` covers any of `hosts`. */
export function coversAny(names: readonly string[], hosts: readonly string[]): boolean {
  return names.some((n) => hosts.some((h) => coversHost(n, h)));
}

export interface ForeignCertificate {
  spkiSha256: string;
  names: string[];
  notBefore: string;
  notAfter: string;
}

/** Whether a certificate with this key is one of Cloudflare's known ones for the zone at `at` (epoch ms). */
export function knownZoneCertificate(spkiSha256: string, at: number): boolean {
  return ownAddressZoneCertificate(spkiSha256, at) !== null;
}

/**
 * The certificates of `certs` that cover one of `hosts` and whose key is neither `own` nor a known zone certificate at
 * `at`, one per key (the latest ending wins), with only the names that cover a host (at most 20).
 */
export function foreignCertificates(input: {
  hosts: readonly string[];
  own: ReadonlySet<string>;
  certs: readonly OwnAddressCtCert[];
  at: number;
}): ForeignCertificate[] {
  const byKey = new Map<string, ForeignCertificate>();
  for (const cert of input.certs) {
    const names = cert.dnsNames.filter((n) => input.hosts.some((h) => coversHost(n, h)));
    if (!names.length || input.own.has(cert.spkiSha256)) continue;
    if (knownZoneCertificate(cert.spkiSha256, input.at)) continue;
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
