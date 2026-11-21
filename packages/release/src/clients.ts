/**
 * Client bundles and the client channel (SUB-09, CT-74): Claude Code and Codex at the latest version Whombat has
 * tested, published independently of appliance releases. A CI job follows upstream releases, regenerates the provider
 * fixtures, runs the provider tests and signs a new channel. A managed appliance's manager installs the chosen clients
 * from the bundle artifacts (TUF targets under `clients/`); a self-hosted server fetches the same executable from the
 * official source. Both check the executable's sha256, which is the unmodified upstream binary's (SUB-02).
 */
import { z } from 'zod';
import { Digest, Environment, EpochSeconds, IntRange, Sha256Hex, VersionString } from './primitives.js';
import { signedDocument, verifyDocumentSignature } from './signed.js';

export const ClientProvider = z.enum(['claude', 'codex']);
export type ClientProvider = z.infer<typeof ClientProvider>;
export const ClientOs = z.enum(['linux']);
export type ClientOs = z.infer<typeof ClientOs>;
export const ClientArch = z.enum(['x86_64', 'aarch64']);
export type ClientArch = z.infer<typeof ClientArch>;

/**
 * The version of a runtime's adapter for one provider (how it drives that CLI: stream-JSON for Claude, the app-server
 * protocol for Codex). A runtime implements one level per provider (`RuntimeFacts.clientAdapters`); a bundle names
 * the levels its tests passed with.
 */
export const ClientAdapterLevel = z.number().int().min(1).max(1_000_000);

export const CLIENT_CHANNEL_PURPOSE = 'whombat-client-channel/v1';
/** The TUF target that carries the signed channel (canonical JSON of `SignedClientChannel`). */
export const CLIENT_CHANNEL_TARGET = 'clients/channel.json';
/** Longest a channel stays valid; the CI job re-signs it well before (daily). */
export const CLIENT_CHANNEL_MAX_LIFETIME_S = 14 * 24 * 3600;
export const CLIENT_CHANNEL_MAX_BUNDLES = 64;

const Size = z.number().int().min(1).max(4_294_967_295);
/** A relative path inside an archive: no leading `/`, every segment starting with a letter, digit or `_`. */
const RelPath = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._+-]*([/][A-Za-z0-9_][A-Za-z0-9._+-]*)*$/);
/** `clients/<provider>/<version>/<os>-<arch>.tar.gz` (`clientBundleTarget`). */
export const ClientBundleTargetPath = z
  .string()
  .max(120)
  .regex(/^clients[/](claude|codex)[/][0-9A-Za-z][0-9A-Za-z.+_-]{0,63}[/]linux-(x86_64|aarch64)[.]tar[.]gz$/);
const HttpsUrl = z
  .string()
  .min(12)
  .max(500)
  .regex(/^https:[/][/][\x21-\x7e]+$/);

/**
 * One tested client version for one platform. The same executable reaches a device two ways: `artifact` (a TUF target,
 * a tar.gz with the executable at `artifact.path`) and `source` (the publisher's own download, for self-hosted
 * installs: the binary itself, or a tar.gz with it at `source.path`). Whichever way, its sha256 is `executable.sha256`.
 */
export const ClientBundle = z.strictObject({
  provider: ClientProvider,
  version: VersionString,
  os: ClientOs,
  arch: ClientArch,
  /** When the publisher released this version. */
  publishedAt: EpochSeconds,
  /** When Whombat's provider tests passed with it (≥ `publishedAt`). */
  testedAt: EpochSeconds,
  /**
   * `sha256:` of the provider fixtures regenerated from this executable that the tests ran against (Codex: the
   * app-server schema bundle; Claude: the stream-JSON and error fixtures, PV-07).
   */
  fixturesDigest: Digest,
  /** The adapter levels of this provider (`ClientAdapterLevel`) the tests passed with, inclusive. */
  adapter: IntRange,
  artifact: z.strictObject({
    target: ClientBundleTargetPath,
    sha256: Sha256Hex,
    size: Size,
    path: RelPath,
  }),
  source: z.strictObject({
    url: HttpsUrl,
    sha256: Sha256Hex,
    size: Size,
    format: z.enum(['binary', 'tar.gz']),
    /** `tar.gz`: where the executable is inside; `binary`: null. */
    path: RelPath.nullable(),
  }),
  executable: z.strictObject({ sha256: Sha256Hex, size: Size }),
});
export type ClientBundle = z.infer<typeof ClientBundle>;

/** The TUF target path of a bundle's artifact. */
export function clientBundleTarget(b: Pick<ClientBundle, 'provider' | 'version' | 'os' | 'arch'>): string {
  return `clients/${b.provider}/${b.version}/${b.os}-${b.arch}.tar.gz`;
}

/**
 * The client channel: every bundle a device may install now, each provider's in order of preference (newest first).
 * It advances without an appliance release. Signed like an assignment (`signedDocument`, purpose-bound, per
 * environment) with a key from a pinned key document shaped like `AssignmentKeys` (CT-41 states; resolve it with
 * `assignmentKeyMap`). On an appliance it is also a TUF target of the delegated `clients` role (`clients/*` only).
 */
export const ClientChannelPayload = z.strictObject({
  purpose: z.literal(CLIENT_CHANNEL_PURPOSE),
  env: Environment,
  /** Strictly increasing per environment; a reader refuses one below the last it accepted (rollback). */
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  issuedAt: EpochSeconds,
  expiresAt: EpochSeconds,
  bundles: z.array(ClientBundle).max(CLIENT_CHANNEL_MAX_BUNDLES),
});
export type ClientChannelPayload = z.infer<typeof ClientChannelPayload>;

export const SignedClientChannel = signedDocument(ClientChannelPayload);
export type SignedClientChannel = z.infer<typeof SignedClientChannel>;

export type ClientChannelError =
  | 'bad_schema'
  | 'unknown_key'
  | 'bad_signature'
  | 'wrong_env'
  | 'bad_lifetime'
  | 'expired'
  | 'not_yet_valid'
  | 'rolled_back'
  | 'bad_bundle'
  | 'duplicate_bundle';

/**
 * Checks a signed client channel: schema, key, signature, environment, lifetime, time (with skew), sequence (not
 * below the last accepted: the same channel read again is fine) and each bundle's consistency (its target path, its
 * adapter range, `testedAt ≥ publishedAt`, `source.path` exactly for a tar.gz) and uniqueness per provider, version,
 * os and arch.
 */
export function verifyClientChannel(
  raw: unknown,
  ctx: {
    keys: Readonly<Record<string, string>>;
    env: string;
    now: number;
    lastSequence: number;
    clockSkewS?: number;
  },
): { ok: true; channel: SignedClientChannel } | { ok: false; error: ClientChannelError } {
  const parsed = SignedClientChannel.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'bad_schema' };
  const doc = parsed.data;
  const key = ctx.keys[doc.keyId];
  if (!key) return { ok: false, error: 'unknown_key' };
  if (!verifyDocumentSignature(doc, key)) return { ok: false, error: 'bad_signature' };
  const p = doc.payload;
  if (p.env !== ctx.env) return { ok: false, error: 'wrong_env' };
  if (p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > CLIENT_CHANNEL_MAX_LIFETIME_S)
    return { ok: false, error: 'bad_lifetime' };
  const skew = ctx.clockSkewS ?? 300;
  if (p.issuedAt > ctx.now + skew) return { ok: false, error: 'not_yet_valid' };
  if (ctx.now >= p.expiresAt + skew) return { ok: false, error: 'expired' };
  if (p.sequence < ctx.lastSequence) return { ok: false, error: 'rolled_back' };
  const seen = new Set<string>();
  for (const b of p.bundles) {
    if (
      b.artifact.target !== clientBundleTarget(b) ||
      b.adapter.min > b.adapter.max ||
      b.testedAt < b.publishedAt ||
      (b.source.format === 'tar.gz') !== (b.source.path !== null)
    )
      return { ok: false, error: 'bad_bundle' };
    const id = `${b.provider}/${b.version}/${b.os}-${b.arch}`;
    if (seen.has(id)) return { ok: false, error: 'duplicate_bundle' };
    seen.add(id);
  }
  return { ok: true, channel: doc };
}

/**
 * The bundle to run for a provider on this machine: the first (most preferred) bundle of the provider for `os`/`arch`
 * whose adapter range includes the runtime's `adapter` level; null when there is none (`client.unavailable`).
 */
export function selectClientBundle(
  bundles: readonly ClientBundle[],
  want: { provider: ClientProvider; os: ClientOs; arch: ClientArch; adapter: number },
): ClientBundle | null {
  return (
    bundles.find(
      (b) =>
        b.provider === want.provider &&
        b.os === want.os &&
        b.arch === want.arch &&
        b.adapter.min <= want.adapter &&
        want.adapter <= b.adapter.max,
    ) ?? null
  );
}
