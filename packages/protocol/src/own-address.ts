/**
 * A box's own address (contracts 4.3; Whombat docs/decisions/own-address.md): each Whombat serves its own page at
 * `<label>.box.whombat.app` (DEV: `<label>.dev.whombat.app`), with TLS ending on the box. The label is three words of
 * the curated list in `@whombat/core/own-address`; this module knows only its shape, so the relay and the manager (Go)
 * never carry the word list. Cross-language: `OwnAddressLabel` and `OwnAddressHost` are in the relay's, the device
 * API's and the manager socket's schemas.
 */
import { z } from 'zod';

/** Three words of the curated list, joined by hyphens: lower-case a–z, each 3–10 letters (the list's range). */
export const OWN_ADDRESS_LABEL_RE = /^[a-z]{3,10}-[a-z]{3,10}-[a-z]{3,10}$/;
export const OwnAddressLabel = z.string().min(11).max(32).regex(OWN_ADDRESS_LABEL_RE);
export type OwnAddressLabel = z.infer<typeof OwnAddressLabel>;

/** Where boxes' names live, per environment. `local` has none: tests use the `dev` zone. */
export const OWN_ADDRESS_ZONES = { prod: 'box.whombat.app', dev: 'dev.whombat.app' } as const;
export type OwnAddressZone = (typeof OWN_ADDRESS_ZONES)[keyof typeof OWN_ADDRESS_ZONES];

/** `<label>.box.whombat.app` or `<label>.dev.whombat.app`: exactly one label under a known zone, lower case. */
export const OWN_ADDRESS_HOST_RE = /^[a-z]{3,10}-[a-z]{3,10}-[a-z]{3,10}[.](box|dev)[.]whombat[.]app$/;
export const OwnAddressHost = z.string().max(64).regex(OWN_ADDRESS_HOST_RE);
export type OwnAddressHost = z.infer<typeof OwnAddressHost>;

const ZONES: readonly string[] = Object.values(OWN_ADDRESS_ZONES);

/** The host of `label` under `zone`. Throws on a label of the wrong shape or a zone that isn't one of the two. */
export function ownAddressHost(label: string, zone: string): string {
  if (!OWN_ADDRESS_LABEL_RE.test(label)) throw new Error('not an own-address label');
  if (!ZONES.includes(zone)) throw new Error('not an own-address zone');
  return `${label}.${zone}`;
}

/** The label of an own-address host, or null for anything else (upper case included: lower-case it first). */
export function ownAddressLabelOf(host: string): string | null {
  if (!OwnAddressHost.safeParse(host).success) return null;
  return host.slice(0, host.indexOf('.'));
}

/** `https://<host>`: the only web origin a box passkey may carry besides the Android release app's. */
export function ownAddressOrigin(host: string): string {
  if (!OwnAddressHost.safeParse(host).success) throw new Error('not an own-address host');
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
  /^https:[/][/][a-z]{3,10}-[a-z]{3,10}-[a-z]{3,10}[.](box|dev)[.]whombat[.]app[/]c[/][abcdefghjkmnpqrtvwxy]{6}$/;
export const OwnAddressClaimUrl = z.string().max(80).regex(OWN_ADDRESS_CLAIM_URL_RE);
export type OwnAddressClaimUrl = z.infer<typeof OwnAddressClaimUrl>;

/** The claim link for `host` and `secret`. Throws on either of the wrong shape. */
export function ownAddressClaimUrl(host: string, secret: string): string {
  OwnAddressClaimSecret.parse(secret);
  return `${ownAddressOrigin(host)}${OWN_ADDRESS_CLAIM_PATH}${secret}`;
}
