/**
 * The box's own address on the manager socket (4.3; Whombat docs/decisions/own-address.md): the manager registers the
 * runtime's label at control, orders and renews the certificate (ACME TLS-ALPN-01 through the relay's door) and watches
 * Certificate Transparency; the runtime polls it and serves the certificate. Cross-language (Go package `local`).
 *
 * The runtime reads `ownAddressState` at start and every `OWN_ADDRESS_STATE_POLL_S`, and `ownAddressCt` every
 * `OWN_ADDRESS_CT_POLL_S`. When `cert.serial` changes it fetches `ownAddressCert`, records the serial and SPKI, and only
 * then serves the new pair. An older manager answers 404 on these paths, which the runtime reads as `enabled: false`.
 *
 * The manager also listens on `OWN_ADDRESS_ACME_SOCKET` (peer uid = the runtime's): each connection is one raw TLS byte
 * stream from a certificate authority's validator, as the door handed it to the box, ClientHello first. The runtime
 * pipes `acme` door streams into it byte for byte and never parses them; at most `OWN_ADDRESS_ACME_CONNECTIONS_MAX` at
 * once.
 */

import { OwnAddressHost, OwnAddressLabel } from '@whombat/protocol';
import { AsciiText as ascii, LocalIdent as ident, Rfc3339 } from '@whombat/protocol/session';
import { z } from 'zod';

const V = z.literal(1);

/** A PEM document (certificate chain or private key): printable ASCII lines. */
const Pem = z
  .string()
  .min(64)
  .max(16_384)
  .regex(/^[\n\x20-\x7e]+$/);

const Spki = z.string().regex(/^[0-9a-f]{64}$/);

/** The manager's ACME socket. */
export const OWN_ADDRESS_ACME_SOCKET = '/run/whombat-manager/acme.sock';
/** At most this many validator streams at once on the ACME socket. */
export const OWN_ADDRESS_ACME_CONNECTIONS_MAX = 8;
/** How often the runtime reads `ownAddressState`, in seconds (and once at start). */
export const OWN_ADDRESS_STATE_POLL_S = 300;
/** How often the runtime reads `ownAddressCt`, in seconds. */
export const OWN_ADDRESS_CT_POLL_S = 1_800;

/** `LocalError` codes of the own-address routes (with `control_unreachable` 503 and `control_refused` 502). */
export const OWN_ADDRESS_ERRORS = [
  /** 404: this image or environment has no own address. */
  'own_address.off',
  /** 409 (`ownAddressRegister`): control says the label was used before; draw another. */
  'own_address.label_taken',
  /** 409 (`ownAddressRegister`): control refused the label. */
  'own_address.label_invalid',
  /** 409 (`ownAddressCert`): no certificate yet. */
  'own_address.no_cert',
] as const;

/** One certificate's facts. */
export const OwnAddressCertMeta = z.object({
  /** Lower-case hex, no colons. */
  serial: z.string().regex(/^[0-9a-f]{2,64}$/),
  /** SHA-256 of the DER SubjectPublicKeyInfo, lower-case hex (Cert Spotter's `pubkey_sha256`). */
  spkiSha256: Spki,
  notBefore: Rfc3339,
  notAfter: Rfc3339,
});
export type OwnAddressCertMeta = z.infer<typeof OwnAddressCertMeta>;

export const OwnAddressAcmeState = z.enum(['idle', 'probing', 'ordering', 'valid', 'failing']);
export type OwnAddressAcmeState = z.infer<typeof OwnAddressAcmeState>;

/** `POST /v1/own-address/state`. */
export const OwnAddressStateRequest = z.strictObject({ v: V });
/** `POST /v1/own-address/register`: the label the runtime drew. */
export const OwnAddressRegisterRequest = z.strictObject({ v: V, label: OwnAddressLabel });
/** `POST /v1/own-address/cert`: the pair the runtime should serve now. */
export const OwnAddressCertRequest = z.strictObject({ v: V });
/** `POST /v1/own-address/ct`: what the certificate watch found. */
export const OwnAddressCtRequest = z.strictObject({ v: V });

/** The answer of `ownAddressState` and `ownAddressRegister`. */
export const OwnAddressStateResponse = z.object({
  v: V,
  /** False: this image or environment has none, and the runtime does nothing about it. */
  enabled: z.boolean(),
  label: OwnAddressLabel.optional(),
  host: OwnAddressHost.optional(),
  acme: z.object({
    state: OwnAddressAcmeState,
    /** `probe_failed`, `validation_failed`, `rate_limited`, `ca_unreachable`, … */
    error: ident().optional(),
    nextAttemptAt: Rfc3339.optional(),
  }),
  /** The pair `ownAddressCert` would hand out now. */
  cert: OwnAddressCertMeta.optional(),
});
export type OwnAddressStateResponse = z.infer<typeof OwnAddressStateResponse>;

/** The certificate chain (leaf first) and its key (a secret: never logged). */
export const OwnAddressCertResponse = OwnAddressCertMeta.extend({
  v: V,
  host: OwnAddressHost,
  certPem: Pem,
  keyPem: Pem,
});
export type OwnAddressCertResponse = z.infer<typeof OwnAddressCertResponse>;

/** One certificate Certificate Transparency lists for the box's host, a name under it, or `*.<zone>`. */
export const OwnAddressCtCert = z.object({
  /** Cert Spotter's issuance id. */
  id: z.string().regex(/^[0-9]{1,20}$/),
  spkiSha256: Spki,
  dnsNames: z
    .array(
      z
        .string()
        .max(253)
        .regex(/^[*a-z0-9.-]+$/),
    )
    .max(100),
  notBefore: Rfc3339,
  notAfter: Rfc3339,
  issuer: ascii(200),
});
export type OwnAddressCtCert = z.infer<typeof OwnAddressCtCert>;

export const OwnAddressCtResponse = z.object({
  v: V,
  source: z.literal('certspotter'),
  /** When this box first checked. */
  checkingSince: Rfc3339,
  /** The last fresh, complete answer; silence and errors never count. */
  lastFreshAt: Rfc3339.nullable(),
  /** More than 12 h without a fresh check: the watch was off, or the source failing. */
  missed: z.array(z.object({ from: Rfc3339, to: Rfc3339 })).max(64),
  /** Only certificates naming the host, a name under it, or exactly `*.<zone>`. */
  certs: z.array(OwnAddressCtCert).max(256),
  /** What this manager ordered, newest first. */
  ordered: z.array(OwnAddressCertMeta).max(64),
});
export type OwnAddressCtResponse = z.infer<typeof OwnAddressCtResponse>;
