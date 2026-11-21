/**
 * The passkey-locked backup details a Whombat keeps at control (Whombat backup-passkey.md): the box locks its backup
 * details with the backup key one of the person's passkeys gave it and hands control the envelopes, which control can
 * neither open nor forge (the box holds a symmetric key derived from the passkey's PRF output, never anything control
 * has). The manager signs the push like a status report (the device op `kit.envelopes.put`). Cross-language.
 *
 * Control resolves the appliance from the signing device, keeps only envelopes of passkeys registered for that
 * appliance, one per (appliance, credential id), the newest generation winning, and answers how many it kept and how
 * many it skipped. `adoptedFrom` names the Whombat this one was brought back from: control retires that Whombat (a
 * Whombat brought back elsewhere is switched off, whatever happened to it) and drops its envelopes, and the passkeys it
 * kept for them, only once a live Whombat of the same account reported it and has an envelope of its own (the kit drop
 * rule). `applianceName` is the Whombat's own name, so the account's list and a bring back can say it.
 */
import { z } from 'zod';

/**
 * A Whombat's name as a push carries it: 1–80 code points (control's names are up to 80), none of them a control,
 * format, surrogate or separator character but U+0020, and no space at either end. The length is in the pattern (code
 * points on both sides of the cross-language subset).
 */
export const KIT_APPLIANCE_NAME_RE =
  /^[^\p{Cc}\p{Cf}\p{Cs}\p{Z}](?:(?:[^\p{Cc}\p{Cf}\p{Cs}\p{Z}]| ){0,78}[^\p{Cc}\p{Cf}\p{Cs}\p{Z}])?$/u;

/** The most envelopes one push carries (control's limit; an account keeps at most 64 kits). */
export const KIT_ENVELOPES_PER_PUSH_MAX = 64;
/** The longest envelope control takes; a signed push stays within `DEVICE_REQUEST_MAX_BYTES`, so a box splits. */
export const KIT_ENVELOPE_MAX_CHARS = 65_536;

const b64url = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);

/** One passkey's envelope of this Whombat's backup details. */
export const DeviceKitEnvelope = z.strictObject({
  /** The passkey whose backup key locks it (base64url credential id). */
  credentialId: b64url(512),
  /** The PRF input that passkey's key came from (base64url). */
  salt: b64url(64),
  /** `wbkit1.<nonce>.<ciphertext>` (XChaCha20-Poly1305), base64url parts. */
  envelope: z
    .string()
    .min(1)
    .max(KIT_ENVELOPE_MAX_CHARS)
    .regex(/^wbkit1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  /** The backup service's `kitGeneration` it was locked at. */
  generation: z.number().int().min(0).max(1_000_000),
});
export type DeviceKitEnvelope = z.infer<typeof DeviceKitEnvelope>;

/** The push; `envelopes` is always there, empty when the box only reports `adoptedFrom`. */
export const KitEnvelopesPush = z.strictObject({
  envelopes: z.array(DeviceKitEnvelope).max(KIT_ENVELOPES_PER_PUSH_MAX),
  /**
   * After a bring back: the Whombat this one came back from, by its content PeerId or its device id (`wb-…`, the
   * backup's own name for the appliance that made it); control takes both.
   */
  adoptedFrom: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9-]+$/)
    .optional(),
  /** The Whombat's name as the box knows it (the one the person gave it); absent when it has none yet. */
  applianceName: z.string().regex(KIT_APPLIANCE_NAME_RE).optional(),
});
export type KitEnvelopesPush = z.infer<typeof KitEnvelopesPush>;

export const KitEnvelopesStored = z.object({
  /** The push's envelopes control keeps (written, or a newer one it had already). */
  stored: z.number().int().min(0).max(KIT_ENVELOPES_PER_PUSH_MAX),
  /** The ones it refused: a passkey control doesn't hold for this Whombat, or the account's limit reached. */
  skipped: z.number().int().min(0).max(KIT_ENVELOPES_PER_PUSH_MAX),
  /**
   * Which credentials' envelopes it refused (4.3; a control from 4.3 always sends it). A box that gets no list and a
   * `skipped` above 0 marks nothing of that push stored.
   */
  skippedCredentialIds: z.array(b64url(512)).max(KIT_ENVELOPES_PER_PUSH_MAX).optional(),
});
export type KitEnvelopesStored = z.infer<typeof KitEnvelopesStored>;
