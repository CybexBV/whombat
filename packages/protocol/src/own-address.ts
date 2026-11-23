/**
 * A box's own address (contracts 4.3, names of the person's choosing since 4.16; Whombat docs/decisions/own-address.md):
 * each Whombat serves its own page at `<label>.whombat.app` (DEV: `<label>.dev.whombat.app`; earlier boxes at
 * `<label>.box.whombat.app`, prod's zone before 4.16), with TLS ending on the box. The label is three words of the
 * curated list in `@whombat/core/own-address`, or a name the person chose; this module knows only its shape, so the
 * relay and the manager (Go) never carry the word list or the reserved names. Cross-language: `OwnAddressLabel` and
 * `OwnAddressHost` are in the relay's, the device API's and the manager socket's schemas.
 */
import { z } from 'zod';

/**
 * A label's shape: starts with a letter, ends with a letter or digit, lower-case letters, digits and single hyphens
 * between them (so never `xn--`), 3–32 characters (`OWN_ADDRESS_LABEL_MIN`, `OWN_ADDRESS_LABEL_MAX`: the pattern alone
 * doesn't bound the length). Every three-word label ever drawn has it. Plain groups and no lookahead, so RE2 (Go) reads
 * it as ECMAScript does (the cross-language subset). Which names a person may have is control's (`ownAddressNameProblem` in `@whombat/core/own-address`).
 */
export const OWN_ADDRESS_LABEL_RE = /^[a-z](-?[a-z0-9])+$/;
export const OWN_ADDRESS_LABEL_MIN = 3;
export const OWN_ADDRESS_LABEL_MAX = 32;
export const OwnAddressLabel = z
  .string()
  .min(OWN_ADDRESS_LABEL_MIN)
  .max(OWN_ADDRESS_LABEL_MAX)
  .regex(OWN_ADDRESS_LABEL_RE);
export type OwnAddressLabel = z.infer<typeof OwnAddressLabel>;

/**
 * A name as a person typed it, already lower-cased and trimmed by the app: letters, digits and hyphens, at most 64.
 * Whether it can be a name is a check's `verdict`; an app judges anything else as `invalid` itself without asking.
 */
export const OwnAddressNameCandidate = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/);
export type OwnAddressNameCandidate = z.infer<typeof OwnAddressNameCandidate>;

/**
 * What a name would be (4.16): `free`, `yours` (this box had it before, so it may have it again; only a box's own
 * check answers it), `taken` (another box has or had it: a name is never given to a second box), `reserved` (given to
 * nobody), `invalid` (not a label's shape).
 */
export const OwnAddressNameVerdict = z.enum(['free', 'yours', 'taken', 'reserved', 'invalid']);
export type OwnAddressNameVerdict = z.infer<typeof OwnAddressNameVerdict>;

/** Where new names live, per environment. `local` has none: tests use the `dev` zone. */
export const OWN_ADDRESS_ZONES = { prod: 'whombat.app', dev: 'dev.whombat.app' } as const;
/**
 * Prod's earlier zone, still parsed and served while boxes move from it: a box keeps answering at its old host for
 * `OWN_ADDRESS_LEAVING_DAYS` after it moved, and a box that hasn't updated stays there.
 */
export const OWN_ADDRESS_OLD_ZONES = ['box.whombat.app'] as const;
/** Any zone a host may be under: the two of today and the old one. */
export const OwnAddressZone = z.enum([
  OWN_ADDRESS_ZONES.prod,
  OWN_ADDRESS_ZONES.dev,
  ...OWN_ADDRESS_OLD_ZONES,
]);
export type OwnAddressZone = z.infer<typeof OwnAddressZone>;

/**
 * `<label>.whombat.app`, `<label>.box.whombat.app` or `<label>.dev.whombat.app`: exactly one label under a known zone,
 * lower case, at most `OWN_ADDRESS_HOST_MAX` characters. The label's own length (3–32) is checked apart
 * (`ownAddressLabelOf`).
 */
export const OWN_ADDRESS_HOST_RE = /^[a-z](-?[a-z0-9])+[.]((box|dev)[.])?whombat[.]app$/;
export const OWN_ADDRESS_HOST_MAX = 64;
export const OwnAddressHost = z.string().max(OWN_ADDRESS_HOST_MAX).regex(OWN_ADDRESS_HOST_RE);
export type OwnAddressHost = z.infer<typeof OwnAddressHost>;

/** Every zone a host may be under, the longest first (so `box.whombat.app` wins over `whombat.app`). */
const ZONES: readonly OwnAddressZone[] = [...OwnAddressZone.options].sort((a, b) => b.length - a.length);

/** How long a box's earlier address keeps working after a rename or a move, in days. */
export const OWN_ADDRESS_LEAVING_DAYS = 30;
/** At most this many renames in 365 days (a move to a new zone with the same label doesn't count). */
export const OWN_ADDRESS_RENAMES_PER_YEAR = 3;

/**
 * The host of `label` under `zone` (any known zone, the old one included). Throws on a label of the wrong shape or a
 * zone that isn't one of them.
 */
export function ownAddressHost(label: string, zone: string): string {
  if (!OwnAddressLabel.safeParse(label).success) throw new Error('not an own-address label');
  if (!(ZONES as readonly string[]).includes(zone)) throw new Error('not an own-address zone');
  return `${label}.${zone}`;
}

/** The zone of an own-address host (the longest known one it ends in), or null for anything else. */
export function ownAddressZoneOf(host: string): OwnAddressZone | null {
  if (ownAddressLabelOf(host) === null) return null;
  return ZONES.find((zone) => host.endsWith(`.${zone}`)) ?? null;
}

/**
 * The label of an own-address host, or null for anything else (upper case included: lower-case it first). A zone
 * itself (`box.whombat.app`, `dev.whombat.app`) has the shape of a name under `whombat.app` but is never a box's host.
 */
export function ownAddressLabelOf(host: string): string | null {
  if (!OwnAddressHost.safeParse(host).success) return null;
  if ((ZONES as readonly string[]).includes(host)) return null;
  const label = host.slice(0, host.indexOf('.'));
  return OwnAddressLabel.safeParse(label).success ? label : null;
}

/** `https://<host>`: the only web origin a box passkey may carry besides the Android release app's. */
export function ownAddressOrigin(host: string): string {
  if (ownAddressLabelOf(host) === null) throw new Error('not an own-address host');
  return `https://${host}`;
}

/** One Digital Asset Links statement (`/.well-known/assetlinks.json`). */
export interface AssetLinkStatement {
  readonly relation: readonly string[];
  readonly target: {
    readonly namespace: 'android_app';
    readonly package_name: string;
    readonly sha256_cert_fingerprints: readonly string[];
  };
}

/**
 * `/.well-known/assetlinks.json` as every box serves it on its own address: both relations, the Android app signed with
 * the release key, no `include`. The same statements as apps/web/public/.well-known/assetlinks.json (a test checks), so
 * the Android app can use a box's passkeys and open its links.
 */
export const BOX_ASSET_LINKS: readonly AssetLinkStatement[] = Object.freeze([
  Object.freeze({
    relation: Object.freeze([
      'delegate_permission/common.handle_all_urls',
      'delegate_permission/common.get_login_creds',
    ]),
    target: Object.freeze({
      namespace: 'android_app' as const,
      package_name: 'com.whombat.mobile',
      sha256_cert_fingerprints: Object.freeze([
        '85:C4:44:97:C5:F5:0E:D1:DF:5E:A9:35:C9:E5:45:4C:06:7B:9E:1B:18:79:21:AB:F2:EA:25:CB:8F:60:66:D3',
      ]),
    }),
  }),
]);
/** How long a browser or Android may keep `BOX_ASSET_LINKS` (`cache-control: public, max-age=…`). */
export const BOX_ASSET_LINKS_MAX_AGE_S = 86_400;

/**
 * The claim link an unclaimed box shows on its screen once its own address works: `https://<host>/c/<secret>`. The
 * secret is six letters of the claim alphabet in lower case (about 64 million). It changes after a claim and after 30
 * wrong tries in an hour.
 */
export const OWN_ADDRESS_CLAIM_PATH = '/c/';
export const OwnAddressClaimSecret = z.string().regex(/^[abcdefghjkmnpqrtvwxy]{6}$/);
export type OwnAddressClaimSecret = z.infer<typeof OwnAddressClaimSecret>;

/** A whole claim link, `https://<own-address host>/c/<secret>`, as control hands it to the account that linked the box. */
export const OWN_ADDRESS_CLAIM_URL_RE =
  /^https:[/][/][a-z](-?[a-z0-9])+[.]((box|dev)[.])?whombat[.]app[/]c[/][abcdefghjkmnpqrtvwxy]{6}$/;
export const OwnAddressClaimUrl = z.string().max(96).regex(OWN_ADDRESS_CLAIM_URL_RE);
export type OwnAddressClaimUrl = z.infer<typeof OwnAddressClaimUrl>;

/** The claim link for `host` and `secret`. Throws on either of the wrong shape. */
export function ownAddressClaimUrl(host: string, secret: string): string {
  OwnAddressClaimSecret.parse(secret);
  return `${ownAddressOrigin(host)}${OWN_ADDRESS_CLAIM_PATH}${secret}`;
}

/**
 * Certificates for `*.whombat.app` and `whombat.app` that the box didn't ask for and that aren't foreign: Cloudflare's
 * Universal SSL issued them on 2026-11-18 while it ran whombat.app's DNS (switched off the same day; Cloudflare holds
 * the keys). They cover every `<name>.whombat.app` until they end. The box doesn't raise an alarm for them while they
 * are within their dates, but says so under the address; any other certificate for the zone is foreign.
 */
export interface OwnAddressZoneCertificate {
  readonly issuer: string;
  /** SHA-256 of the DER SubjectPublicKeyInfo, lower-case hex (as the certificate watch reports it). */
  readonly spkiSha256: string;
  /** The zone it names, with its wildcard. */
  readonly zone: 'whombat.app';
  /** RFC 3339, UTC. */
  readonly notAfter: string;
}

export const OWN_ADDRESS_ZONE_CERTIFICATES: readonly OwnAddressZoneCertificate[] = Object.freeze([
  Object.freeze({
    issuer: 'Google Trust Services',
    spkiSha256: 'e62ed157ca8b06c3fc1fd3be7fdfc1a6c4ee55d901aadda5899d97fa7e6e721a',
    zone: 'whombat.app' as const,
    notAfter: '2027-02-16T08:09:15Z',
  }),
  Object.freeze({
    issuer: "Let's Encrypt",
    spkiSha256: '5182d97e81bd1e4a0c07da4415c21f1e1d0cf734140ab33495d73261aa30eeb3',
    zone: 'whombat.app' as const,
    notAfter: '2027-02-16T07:16:19Z',
  }),
]);

/**
 * The known zone certificate with this SPKI that is still within its dates at `at` (milliseconds since the epoch), or
 * null: a certificate with another SPKI, or one past its end, is judged like any other.
 */
export function ownAddressZoneCertificate(spkiSha256: string, at: number): OwnAddressZoneCertificate | null {
  return (
    OWN_ADDRESS_ZONE_CERTIFICATES.find((c) => c.spkiSha256 === spkiSha256 && at <= Date.parse(c.notAfter)) ??
    null
  );
}
