/**
 * The reviewed runtime dependency closure of `@whombat/secure-channel` (ADR SC-01), exact versions. Direct
 * dependencies are pinned in package.json; the transitive ones are pinned only by a lockfile, so consuming
 * repositories must pin them with `pnpm.overrides` and can check with `verifyInstalledDependencies()` from
 * `@whombat/secure-channel/node`.
 */
export const PINNED_DEPENDENCIES: Readonly<Record<string, string>> = {
  '@libp2p/noise': '17.0.3',
  '@libp2p/crypto': '5.1.23',
  '@libp2p/interface': '3.3.0',
  '@libp2p/peer-id': '6.0.15',
  '@libp2p/utils': '7.4.1',
  '@libp2p/logger': '6.2.13',
  '@noble/ciphers': '2.4.0',
  '@noble/curves': '2.4.0',
  '@noble/hashes': '2.4.0',
  '@chainsafe/as-chacha20poly1305': '0.1.0',
  '@chainsafe/as-sha256': '1.2.5',
  'protons-runtime': '7.1.2',
  multiformats: '14.0.5',
  uint8arraylist: '3.0.2',
  uint8arrays: '6.1.1',
  weald: '1.1.3',
  ms: '4.0.0-nightly.202508271359',
};
