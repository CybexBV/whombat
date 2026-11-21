/**
 * The manifest of a release bundle (docs/decisions/bp-distribution.md): `manifest.json`, written by
 * `pnpm bundle:runtime` and checked against an unpacked bundle by the CLI's `verifyRelease`. Pure schemas.
 */
import { z } from 'zod';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** `1.2.3`, `1.2.3-rc.1` (no build metadata). */
export const ReleaseVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

export const ReleaseArch = z.enum(['x64', 'arm64']);
export type ReleaseArch = z.infer<typeof ReleaseArch>;

/** One migration of a build (drizzle's bookkeeping: `when` is `created_at`, `hash` the file's sha256). */
export const ReleaseMigration = z.object({ tag: z.string(), when: z.number().int(), hash: Sha256 });
export type ReleaseMigration = z.infer<typeof ReleaseMigration>;

export const ReleaseFile = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('file'),
    sha256: Sha256,
    size: z.number().int().nonnegative(),
    /** 0o644 or 0o755. */
    mode: z.number().int(),
  }),
  z.object({ type: z.literal('symlink'), target: z.string().min(1) }),
]);
export type ReleaseFile = z.infer<typeof ReleaseFile>;

export const ReleaseManifest = z.object({
  format: z.literal(1),
  name: z.literal('whombat'),
  version: ReleaseVersion,
  gitSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  /** Built from a working tree with uncommitted changes (never for a release). */
  gitDirty: z.boolean(),
  /** From SOURCE_DATE_EPOCH (the commit's time by default): the same for every build of a commit. */
  buildTime: z.string(),
  /** Node versions it runs on (`>=24`). */
  node: z.string(),
  platform: z.literal('linux'),
  arch: ReleaseArch,
  postgres: z.object({ package: z.string(), version: z.string(), major: z.number().int() }),
  /** Whether Claude Code's own binary is inside (else `WHOMBAT_CLAUDE_PATH` names the host's `claude`). */
  claude: z.object({ bundled: z.boolean() }),
  schema: z.object({ latest: z.string().nullable(), migrations: z.array(ReleaseMigration) }),
  /** Every path in the release (relative, `/`-separated) except manifest.json itself. */
  files: z.record(z.string(), ReleaseFile),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;
