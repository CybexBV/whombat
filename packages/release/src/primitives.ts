/**
 * Cross-language primitives (docs/contracts/cross-language.md): plain strings with length/regex, bounded integers.
 * Times are integer epoch seconds so Go and TypeScript compare them identically.
 */
import { z } from 'zod';

/** Seconds since the epoch, bounded to year 2100. */
export const EpochSeconds = z.number().int().min(0).max(4_102_444_800);
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
/** Content digest in OCI/TUF style: `sha256:<hex>`. */
export const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/** Raw 32-byte Ed25519 public key, lowercase hex. */
export const PublicKeyHex = z.string().regex(/^[0-9a-f]{64}$/);
/** Raw 64-byte Ed25519 signature, lowercase hex. */
export const SignatureHex = z.string().regex(/^[0-9a-f]{128}$/);
/** Opaque identifier (key ids, device ids, cohort ids, …). */
export const Ident = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
/** Release/version names: `2026.09.25-1`, `1.4.0`, `1.4.0-rc.2`. */
export const VersionString = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/);
/** Release id of an approved tuple (`rt-2026.09.25-1`). */
export const ReleaseId = z
  .string()
  .min(3)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
export type ReleaseId = z.infer<typeof ReleaseId>;
/** `/nix/store/<32 base32 chars>-<name>`. */
export const NixStorePath = z
  .string()
  .max(211)
  .regex(/^\/nix\/store\/[0-9a-df-np-sv-z]{32}-[A-Za-z0-9+._?=-]+$/);
export const GitCommit = z.string().regex(/^[0-9a-f]{40}$/);
/** Integer version range, inclusive. */
export const IntRange = z.strictObject({
  min: z.number().int().min(0).max(1_000_000),
  max: z.number().int().min(0).max(1_000_000),
});
export type IntRange = z.infer<typeof IntRange>;
/** Deployment environment. Distinct credentials of every kind per environment (MA-14). */
export const Environment = z.enum(['local', 'dev', 'prod']);
export type Environment = z.infer<typeof Environment>;
