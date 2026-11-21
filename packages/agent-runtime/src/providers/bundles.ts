/**
 * Pinned official provider runtimes (docs/decisions/managed-providers.md PV-01, docs/managed/provider-bundles.md).
 * A managed appliance runs exactly these, unmodified: the appliance image fetches each artifact by its digest, and
 * the drift check (`drift.ts`) compares what is installed with this list before a turn may run
 * (`version_drift` otherwise). Changing a pin is a release: rerun the tests, update the Nix bundle. ChatGPT has no
 * pinned client: it runs on Hermes's own provider (hermes-native.md HN-04).
 *
 * Pure data. Digests: npm `dist.integrity` (sha512, SRI) and the upstream release's asset sha256 (Claude Code: the
 * release manifest's `checksum`, which is the executable itself); `binarySha256` is the sha256 of the executable
 * inside the artifact (what the drift check hashes on the appliance).
 */

export interface PinnedArtifact {
  /** Where it comes from (npm tarball or release asset URL). */
  url: string;
  /** `sha512-…` (npm SRI) or `sha256:<hex>` (release asset). */
  digest: string;
}

export interface PinnedBinary {
  /** Platform (Node `process.platform-process.arch`). */
  platform: 'linux-x64' | 'linux-arm64';
  /** The unmodified artifact the appliance installs (first), and equivalent sources with the same executable. */
  artifacts: readonly PinnedArtifact[];
  /** Path of the executable inside the first artifact. */
  executable: string;
  /** sha256 of that executable (hex), when recorded from an unpacked copy. Null: not recorded for this platform. */
  binarySha256: string | null;
  /** How it links: `static` needs nothing; `glibc` needs a loader at /lib64 (NixOS: nix-ld, never patchelf). */
  linkage: 'static' | 'glibc';
}

export interface ProviderBundle {
  provider: 'claude';
  /** Human name of what is pinned. */
  name: string;
  /** The version `--version` prints (`2.1.302 (Claude Code)`) and the one pinned. */
  version: string;
  versionOutput: string;
  /** Library packages the runtime loads, pinned in pnpm-lock.yaml (none: Claude Code runs as its CLI). */
  packages: readonly { name: string; version: string; integrity: string }[];
  binaries: readonly PinnedBinary[];
  /** Supported settings that stop the provider updating itself (verified against this version, PV-01). */
  selfUpdate: { env: Record<string, string>; config: Record<string, unknown>; verified: string };
  /** The protocol fixture generated from this version (tests compare against it); null: none (Claude Code, CDS-01). */
  fixture: string | null;
}

export const CLAUDE_BUNDLE: ProviderBundle = {
  provider: 'claude',
  name: 'Claude Code (the official native binary, run directly)',
  // The newest Claude Code Nous's DirectSDK 0.3.3 handles (its relay knows 2.1.302's requests; the `haiku` alias needs
  // 2.1.293 or newer, claude-directsdk.md CDS-01; hermes-native.md HN-K08).
  version: '2.1.302',
  versionOutput: '2.1.302 (Claude Code)',
  // No library: Whombat runs the binary as a subprocess (stream-JSON), never the Agent SDK (SUB-02, SUB-10).
  packages: [],
  binaries: [
    {
      platform: 'linux-x64',
      artifacts: [
        {
          // What Anthropic's installer fetches (`install.sh`: `downloads.claude.ai/claude-code-releases/<version>/
          // <platform>/claude`, checked against that version's `manifest.json`).
          url: 'https://downloads.claude.ai/claude-code-releases/2.1.302/linux-x64/claude',
          digest: 'sha256:60d7eb7f12fbb28a52533fe8be5884097403562aa02dc73991a021c7067e29a5',
        },
        {
          // The same executable in npm's platform package (what `pnpm install` puts next to Whombat).
          url: 'https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.302.tgz',
          digest:
            'sha512-+d4RUq3E3K+3/J4MysB3z4QXA4rkDNt70VYpTLE6kJCnUe/Z6SB8VJsVJG/NV4bECrvkxkLHjXk+vrgBstfZkw==',
        },
      ],
      executable: 'claude',
      binarySha256: '60d7eb7f12fbb28a52533fe8be5884097403562aa02dc73991a021c7067e29a5',
      linkage: 'glibc',
    },
    {
      platform: 'linux-arm64',
      artifacts: [
        {
          url: 'https://downloads.claude.ai/claude-code-releases/2.1.302/linux-arm64/claude',
          digest: 'sha256:2bd4f4e5ed5cb09955b490098f745321cb5491e7ea8c752ba1e3bb010cdadb10',
        },
        {
          url: 'https://registry.npmjs.org/@anthropic-ai/claude-code-linux-arm64/-/claude-code-linux-arm64-2.1.302.tgz',
          digest:
            'sha512-eRgp1cK2oSC7vK1/Dha9EsfSxNb6b/LyduzBxRW02c0X+C6xtyAzeGMmRobQSNuTazRxsr/Cf2/l4Sf/LMgxCA==',
        },
      ],
      executable: 'claude',
      // Hashed from the unpacked npm package; equal to the release manifest's checksum for linux-arm64.
      binarySha256: '2bd4f4e5ed5cb09955b490098f745321cb5491e7ea8c752ba1e3bb010cdadb10',
      linkage: 'glibc',
    },
  ],
  selfUpdate: {
    // `DISABLE_UPDATES` refuses even `claude update` (“Updates are disabled by your administrator”) and rides in
    // the flag settings' `env` (the managed sandbox passes no unknown variable, MSB-18); `DISABLE_AUTOUPDATER` stops
    // the background updater. Both read by 2.1.302 (verified offline, PV-01; bundles.test.ts runs it again).
    env: { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    config: { env: { DISABLE_UPDATES: '1' } },
    verified:
      '2026-10-25: 2.1.302 `claude --settings {"env":{"DISABLE_UPDATES":"1"}} update` refused, offline network namespace',
  },
  // Whombat runs no Claude turn itself any more (Hermes does, claude-directsdk.md CDS-01): no protocol fixture.
  fixture: null,
};

/** The pinned clients a turn runs: Claude Code alone; ChatGPT runs on Hermes's own provider (hermes-native.md HN-04). */
export const PROVIDER_BUNDLES = { claude: CLAUDE_BUNDLE } as const;
