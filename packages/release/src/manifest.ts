/**
 * Product integration manifest (MA-01, owned by the appliance): the tested combination of repository
 * commits, package versions, artifact digests, supported ranges and upgrade paths that may be promoted.
 */
import { z } from 'zod';
import { Digest, EpochSeconds, GitCommit, Ident, IntRange, ReleaseId, VersionString } from './primitives.js';
import { ReleaseTuple } from './tuple.js';

export const RepositoryName = z.enum([
  'whombat-contracts',
  'Whombat',
  'whombat-app',
  'whombat-api',
  'whombat-relay',
  'whombat-appliance',
  /** The hosts service (Rackoon headless, one-whombat.md ONE-11; contracts 0.80.1, CT-344). */
  'whombat-hosts',
]);

export const ArtifactKind = z.enum([
  'nix-store-path',
  'oci-image',
  'tarball',
  'web-bundle',
  'apk',
  'ipa',
  'go-module',
]);

export const ProductManifest = z.strictObject({
  manifestVersion: z.literal(1),
  /** Product release name (`2026.09.25-1`). */
  productVersion: VersionString,
  createdAt: EpochSeconds,
  repositories: z
    .array(
      z.strictObject({
        name: RepositoryName,
        commit: GitCommit,
        tag: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9._/-]+$/)
          .optional(),
      }),
    )
    .min(1)
    .max(16),
  packages: z
    .array(
      z.strictObject({
        name: z
          .string()
          .min(1)
          .max(100)
          .regex(/^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/),
        version: VersionString,
        /** sha256 of the tarball (as in SHA256SUMS), when vendored. */
        sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
      }),
    )
    .max(64),
  artifacts: z
    .array(
      z.strictObject({
        name: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9._/@:-]+$/),
        kind: ArtifactKind,
        digest: Digest,
        ref: z
          .string()
          .min(1)
          .max(300)
          .regex(/^[\x21-\x7e]+$/)
          .optional(),
      }),
    )
    .max(128),
  /** The approved device tuple this product release ships. */
  tuple: ReleaseTuple,
  supported: z.strictObject({
    /** Session protocol versions (`major * 1000 + minor`) the hosted UI and apps of this release speak. */
    clientProtocol: IntRange,
    relayProtocol: z.array(z.literal(1)).min(1).max(4),
    /** DB schema versions this release can upgrade from. */
    upgradeFromSchema: IntRange,
  }),
  upgradePaths: z
    .array(
      z.strictObject({
        from: ReleaseId,
        to: ReleaseId,
        /** Intermediate releases, in order, when a direct upgrade is not supported. */
        via: z.array(ReleaseId).max(8),
        /** The upgrade includes an incompatible migration: quiesce and checkpoint first. */
        requiresCheckpoint: z.boolean(),
      }),
    )
    .max(64),
  /** Test evidence ids (integration harness runs) that promoted this combination. */
  evidence: z.array(Ident).max(64),
});
export type ProductManifest = z.infer<typeof ProductManifest>;
