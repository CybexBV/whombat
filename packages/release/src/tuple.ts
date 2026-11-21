/**
 * Release tuple (MA-11): the set of independently built components a device runs together. Only tuples
 * approved through TUF (and assigned by control) can activate.
 */
import { canonicalJson, sha256Hex } from '@whombat/core/audit';
import { z } from 'zod';
import { Digest, IntRange, NixStorePath, ReleaseId, VersionString } from './primitives.js';

export const ProviderName = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9-]*$/);

/** A Nix closure the helper can stage: version, store path and NAR digest. */
export const Component = z.strictObject({
  version: VersionString,
  storePath: NixStorePath,
  narHash: Digest,
});
export type Component = z.infer<typeof Component>;

/** Session protocol majors/minors a runtime serves, as `major * 1000 + minor` (1.0 → 1000, 1.3 → 1003). */
export const ProtocolRange = IntRange;

/**
 * A client's monotonic integer build number on its platform (CT-53): Android `versionCode`, the iOS build counter,
 * the hosted web UI's build counter. `ClientInfo.buildNumber` in the session `hello` carries it.
 */
export const ClientBuildNumber = z.number().int().min(0).max(2_147_483_647);

/**
 * Minimum client build per platform that this release still serves (assignment §12: retained builds have security
 * floors). `0` means no floor. The runtime refuses a `hello` below its running tuple's floor with
 * `unsupported_version` + `details.code: client_below_security_floor` (`clientBelowFloor`).
 */
export const ClientFloor = z.strictObject({
  web: ClientBuildNumber,
  android: ClientBuildNumber,
  ios: ClientBuildNumber,
  desktop: ClientBuildNumber,
  cli: ClientBuildNumber,
});
export type ClientFloor = z.infer<typeof ClientFloor>;
export type ClientPlatform = keyof ClientFloor;

export const ReleaseTuple = z.strictObject({
  releaseId: ReleaseId,
  /** Whombat runtime bundle (server, runner, web assets it serves locally). */
  runtime: Component.extend({
    /** DB schema versions this runtime can run against (reader compatibility). */
    schemaReads: IntRange,
    /** DB schema version this runtime migrates to and writes. */
    schemaWrites: z.number().int().min(0).max(1_000_000),
    /** Session protocol versions served (`major * 1000 + minor`). */
    protocol: ProtocolRange,
    /** Host ABI levels the runtime needs (systemd units, users, paths the host provides). */
    hostAbi: IntRange,
  }),
  /** Provider bundles (Codex/Claude CLIs, synthetic), each pinned. */
  providers: z.array(Component.extend({ provider: ProviderName })).max(16),
  /** NixOS host system generation (reboot to activate). */
  host: Component.extend({
    /** Host ABI level this generation provides. */
    abi: z.number().int().min(0).max(1_000_000),
  }),
  /** whombat-manager (ships with the host generation but is versioned separately). */
  manager: Component,
  /**
   * Client security floor (CT-53). Optional so tuples without it keep their digest; a tuple that carries it needs a
   * helper/manager built from contracts ≥ 0.5.3 (older ones refuse it as an unknown member, fail-closed).
   */
  clientFloor: ClientFloor.optional(),
});
export type ReleaseTuple = z.infer<typeof ReleaseTuple>;

/** sha256 of the tuple's canonical JSON; assignments and the manifest refer to tuples by it. */
export function tupleDigest(tuple: ReleaseTuple): string {
  return `sha256:${sha256Hex(canonicalJson(tuple))}`;
}

/** Encodes a session protocol version for `ProtocolRange`. */
export function protocolCode(version: { major: number; minor: number }): number {
  return version.major * 1000 + version.minor;
}
