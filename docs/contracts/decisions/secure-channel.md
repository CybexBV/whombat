# Secure channel (`@whombat/secure-channel`)

Workstream: secure-channel (MA-03, MA-04, MA-05, MA-07, MA-08). Date: 2026-09-25.
Status: **accepted** — selected by the qualification spike; the independent review MA-07 requires
(`appliance/docs/implementation/reviews/secure-channel-review.md`, 2026-09-25) found no flaw in the
upstream handshake and accepted it with required fixes, all resolved in SC-10 (contracts 0.5.1).

## SC-01 Decision

End-to-end channel = the libp2p Noise handshake (`Noise_XX_25519_ChaChaPoly_SHA256`, libp2p signed-static-key
payload binding an Ed25519 identity) from **`@libp2p/noise@17.0.3`** (the maintained home of
`@chainsafe/libp2p-noise`), used only through its public `ConnectionEncrypter` (`noise(init)(components)`,
`secureOutbound` / `secureInbound`) over our own byte-stream adapter. No libp2p host, DHT, discovery, peer
routing, multistream-select or stream muxer. Client = initiator, appliance = responder.

Exact pins (package `dependencies`, no ranges): `@libp2p/noise 17.0.3`, `@libp2p/crypto 5.1.23`,
`@libp2p/interface 3.3.0`, `@libp2p/peer-id 6.0.15`, `@libp2p/utils 7.4.1`, `@noble/curves 2.4.0`,
`@noble/hashes 2.4.0`, `uint8arraylist 3.0.2`. Transitively resolved (this repo's lockfile): `@noble/ciphers
2.4.0`, `protons-runtime 7.1.2`, `multiformats 14.0.5`, `uint8arrays 6.1.1`, `@libp2p/logger 6.2.13`, `weald
1.1.3`, `ms 4.0.0-nightly.202508271359`, `@chainsafe/as-sha256 1.2.5`, `@chainsafe/as-chacha20poly1305 0.1.0`
(56 packages in total; licenses MIT, Apache-2.0, or Apache-2.0 OR MIT). The full reviewed set is exported as
`PINNED_DEPENDENCIES`.

**Consumers must pin the transitive set themselves** (review L-8): upstream packages depend on `^` ranges, and a
consuming repository's lockfile resolves them independently of ours; adding them as direct dependencies here
would not change that. Every consumer adds, in its root `package.json`:

```json
"pnpm": { "overrides": {
  "@libp2p/noise": "17.0.3", "@libp2p/crypto": "5.1.23", "@libp2p/interface": "3.3.0",
  "@libp2p/peer-id": "6.0.15", "@libp2p/utils": "7.4.1", "@libp2p/logger": "6.2.13",
  "@noble/ciphers": "2.4.0", "@noble/curves": "2.4.0", "@noble/hashes": "2.4.0",
  "protons-runtime": "7.1.2", "multiformats": "14.0.5", "uint8arraylist": "3.0.2", "uint8arrays": "6.1.1",
  "@chainsafe/as-sha256": "1.2.5", "@chainsafe/as-chacha20poly1305": "0.1.0",
  "weald": "1.1.3", "ms": "4.0.0-nightly.202508271359"
} }
```

and gates CI on `verifyInstalledDependencies()` from `@whombat/secure-channel/node` returning `[]` (it resolves
every pinned name from this package and from each library that imports it). The pre-release `ms` (via
`@libp2p/utils` → `@libp2p/logger` → `weald`) cannot be dropped: `@libp2p/utils`' index re-exports test helpers
that import the logger, so it is loaded at runtime on Node and Metro (browser bundles tree-shake it away). It
only formats durations for the (silenced) logger. Any change to the set reruns the mutation gate (SC-10).

Noise primitives default to the library's **`pureJsCrypto`** (@noble X25519, ChaCha20-Poly1305, SHA-256,
HKDF) on every platform, so browser, Hermes and Node run the same code. The Node appliance may pass
`nodeNoiseCrypto` from `@whombat/secure-channel/node`: OpenSSL (`node:crypto`) for ChaCha20-Poly1305 at every
message size, SHA-256 and X25519, HKDF from @noble. It is built from upstream's `nodeCrypto` plus the X25519
functions of `defaultCrypto` and deliberately **not** `defaultCrypto` itself, which sends every AEAD under 1200
bytes (all handshake AEADs, small records) to `@chainsafe/as-chacha20poly1305@0.1.0` — WASM, one release, no
public audit, non-constant-time tag compare (review L-7). Interop and tamper detection between the two are
tested; both are wire-identical.

## SC-02 Evidence (sources accessed 2026-09-25)

**Ownership and maintenance**
- `@libp2p/noise` — npm, latest 17.0.3 published 2026-09-23; repository `libp2p/js-libp2p`,
  `packages/connection-encrypter-noise` (https://github.com/libp2p/js-libp2p/tree/main/packages/connection-encrypter-noise).
  README: "Formerly published as `@chainsafe/libp2p-noise`". The ChainSafe code was merged into the monorepo on
  2026-09-02 ("chore: merge js-libp2p-noise into packages/connection-encrypter-noise",
  https://github.com/libp2p/js-libp2p/commits/main/packages/connection-encrypter-noise). npm maintainers:
  achingbrain, alanshaw, daviddias, jacobheun, vascosantos, npm-service-account-libp2p. `js-libp2p` repo: not
  archived, last push 2026-09-23, 2.5k stars (GitHub API).
- `@chainsafe/libp2p-noise` — last release 17.0.0 (2025-09-25), not deprecated on npm; repo
  https://github.com/ChainSafe/js-libp2p-noise not archived, last push 2026-06-15. We do **not** use it.
- Release cadence (npm `time`): 16.0.0 2024-09-11 … 16.1.5 2025-09-22, 17.0.0 2025-09-25 (ChainSafe);
  `@libp2p/noise` 17.0.1 and 17.0.2 on 2026-09-02, 17.0.3 on 2026-09-23. Roughly monthly to quarterly.
- License: `Apache-2.0 OR MIT` (npm metadata, repo LICENSE-APACHE / LICENSE-MIT).
- Supply chain: `@libp2p/noise@17.0.3` carries an npm SLSA provenance attestation
  (https://registry.npmjs.org/-/npm/v1/attestations/@libp2p%2fnoise@17.0.3), gitHead
  `2bad1dfb55978973320019d3b81004644b098602`.

**Advisories**
- GHSA-j3ff-xp6c-6gcc / CVE-2022-24759 (https://github.com/advisories/GHSA-j3ff-xp6c-6gcc): `@chainsafe/libp2p-noise`
  < 4.1.2 and 5.0.0–5.0.2 did not validate the handshake signature. Fixed long before 17.x.
- No advisory for `@libp2p/noise` (GitHub advisory DB query `affects=@libp2p/noise`, 2026-09-25).
- `js-libp2p` repository advisories (https://github.com/libp2p/js-libp2p/security/advisories, 11 listed): none
  for noise. Relevant: **GHSA-rvfr-cqwq-rc4j**, `@libp2p/crypto <= 5.1.21`, pre-auth unbounded loop in the ASN.1
  DER decoder. We pin 5.1.23 (not affected). It matters to us because the responder parses the
  initiator's identity key (attacker-chosen key type, RSA/ECDSA use DER) before we can reject non-Ed25519
  identities — see risks.
- No advisories for `@noble/ciphers`, `@noble/curves`, `@noble/hashes`, `@libp2p/crypto` ≥ 5.1.22,
  `@libp2p/peer-id`, `@libp2p/utils`, `@libp2p/interface`, `uint8arraylist`, `protons-runtime`, `uint8arrays`
  (GitHub advisory DB, per package). `npm audit` on a clean install of `@libp2p/noise@17.0.3`: 0
  vulnerabilities; `pnpm audit --prod` in this workspace: no known vulnerabilities.

**Security review provenance**
- `@libp2p/noise` / `js-libp2p-noise`: **no public audit found.** (Searched the repos, npm, the web. An EF
  tracker lists a 2020 Least Authority audit of Lodestar "utility libraries"; its scope is not shown to include
  the Noise module, so it is not claimed.)
- Primitives: `@noble/ciphers` — Cure53, v1.0.0, Sep 2024, scope everything
  (https://cure53.de/audit-report_noble-crypto-libs.pdf); we use 2.4.0 (changes since the audit are unaudited).
  `@noble/curves` — Cure53 v1.6.0 Sep 2024 (ed25519 and add-ons), Trail of Bits v0.7.3 Feb 2023, Trail of Bits
  v2.3.0 Aug 2026 (listed in README, no report link) (https://github.com/paulmillr/noble-curves#security).
  `@noble/hashes` — Cure53 v1.0.0 Jan 2022 (https://cure53.de/pentest-report_hashing-libs.pdf).
- Protocol: Noise Protocol Framework rev 34 (https://noiseprotocol.org/noise.html); libp2p Noise spec r5
  2022-12-07 (https://github.com/libp2p/specs/blob/master/noise/README.md).

**Public API we depend on**
- `noise({ crypto, prologueBytes })(components)` → `ConnectionEncrypter.secureOutbound(stream, { remotePeer,
  signal, skipStreamMuxerNegotiation: true })` / `secureInbound(...)`, returning `{ connection, remotePeer,
  remoteExtensions }`; `pureJsCrypto`, `ICryptoInterface`; `@libp2p/noise/crypto` `defaultCrypto` (Node only).
- `@libp2p/utils` `AbstractMessageStream` (to present our byte stream as a libp2p `MessageStream`);
  `@libp2p/crypto/keys` (`generateKeyPair`, protobuf key (de)serialisation, `publicKeyFromRaw`);
  `@libp2p/peer-id` (`peerIdFromString`, `peerIdFromPublicKey`).

**Bundle cost** (esbuild 0.28.2, platform browser, minified, gzip -9; `pnpm --filter @whombat/secure-channel spike:bundle`)

| Entry | min | min+gzip |
|---|---|---|
| full public API | 194.8 KiB | 64.2 KiB |
| client (`openInitiator`, WebSocket adapter, WebCrypto identity, fingerprint) | 185.1 KiB | 61.4 KiB |
| appliance (`acceptResponder`) | 187.0 KiB | 61.4 KiB |

Largest inputs (min, pre-gzip): @noble/curves 43.4 KiB, own source 28.0, @libp2p/crypto 18.5, multiformats
17.8, @libp2p/noise 17.0, @noble/hashes, @libp2p/utils, protons-runtime, @noble/ciphers, uint8arraylist. (0.3.0:
61.1 KiB gzip for the full API; the review fixes add ~3 KiB.) Hermes: Metro bundle of the qualification scenario
648 KB JS (minified, includes React Native's Event/EventTarget and Expo's TextDecoder) → 1.15 MB bytecode.

## SC-03 Protocol and API

```
app message ─ record [u8 type][u32 BE len][payload]   0x00 DATA, 0x01 CLOSE (len 0), 0x02 WINDOW (u32 increment)
             ─ libp2p-noise transport frames [u16 BE len][ChaCha20-Poly1305 ciphertext+tag] (≤ 65535)
             ─ ByteStream (opaque bytes; WebSocket binary messages ≤ 256 KiB through the relay)
```

- `openInitiator({ stream, identity, expectedAppliancePeerId | expectedApplianceFingerprint, prologue?, limits?, crypto? })`
  and `acceptResponder({ stream, identity, prologue?, limits?, crypto? })` → `SecureConnection { role,
  remotePeerId, remotePublicKey, rekeyRequired, send(msg), receive(), [Symbol.asyncIterator], close(), abort(),
  closed, stats() }`.
- One application message = one record ≤ `MAX_MESSAGE_BYTES` = 65535 − 16 − 5 = **65514** bytes (configurable
  lower via `maxMessageBytes`). Larger payloads are the session protocol's job (MA-08 streams).
- **Pinning.** The pin is parsed and validated before any byte is written (malformed, non-Ed25519 or weak →
  `PEER_MISMATCH`, zero bytes); a CID-form PeerId is accepted and compared by key, not by string (review I-2).
  With `expectedAppliancePeerId` the responder's identity is checked inside message 2 — by our payload check
  (below) and by the library — and on mismatch the client aborts before sending message 3: nothing but message 1
  (34 bytes: 2-byte length + ephemeral key) ever leaves the client (tested, also for forged identity bindings,
  weak keys and a relay terminating Noise). With `expectedApplianceFingerprint` (typed from the claim
  card) the check runs right after the handshake and before any application byte; the impostor then learns the
  client's endpoint public key (message 3), but receives no data (tested). Prefer the full PeerId (QR).
- **Fingerprint** for claim cards: first 125 bits of SHA-256("whombat-peer-fingerprint/1\0" ‖ PeerId
  multihash), RFC 4648 base32, `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. Known-answer vector (seed 00..1f):
  PeerId `12D3KooWA4Xop1JaT3MHxwYMkCepYsv4iPVopMXwCz5iHYdBfeSB` → `KDTHE-HLBVV-XVMQ2-JPJX6-CMTJX` (cross-checked
  with Python hashlib; the Go claim-card printer must match it). Input normalisation maps 0→O, 1→I, 8→B.
- **Prologue = protocol version** `whombat-secure-session/2` (contracts ≥ 0.5.1; `/1` was contracts ≤ 0.5.0,
  without the WINDOW record) via the library's `prologueBytes`, mixed into the handshake hash. Peers of
  different versions never complete a handshake (re-review N-1). The side that notices — its first encrypted
  handshake message fails to authenticate — reports `VERSION_MISMATCH` ("the peer does not speak
  whombat-secure-session/2 … or the handshake was tampered with": cryptographically the two are
  indistinguishable). In practice a new client against a `/1` appliance gets `VERSION_MISMATCH`; a `/1` client
  against a new appliance fails in its own handshake and the appliance reports `HANDSHAKE_FAILED`; no session
  and no application byte in either direction (tested with the prologue option and, outside the suite, with the
  real 0.3.0 code both ways). Release note: clients and appliances must move to 0.5.1 together. This also
  keeps us non-interoperable with generic libp2p peers (empty prologue).
- **No early data.** Handshake-payload extensions (`webtransport_certhashes`, `stream_muxers`) must be empty,
  else `EarlyDataError`; muxer negotiation is skipped. Unknown protobuf fields are dropped by the decoder and
  never reach us. The libp2p spec already forbids application data in early data.
- **Identity checks before the library's (review M-3, L-1, L-5).** Our crypto wrapper sees the peer's
  decrypted static key and handshake payload (in XX the first and second handshake decryptions on both sides)
  and checks the payload before `@libp2p/noise` parses the key or verifies the signature: exactly the fields
  `identity_key`, `identity_sig`, `extensions` (empty), no repeats; key type **Ed25519 only** (RSA/ECDSA/
  secp256k1 are refused before any DER parse or verify — the L-5 pre-auth CPU vector is gone); the key is
  canonically encoded and **not of small order** (the eight torsion points, which let anyone "sign" anything
  under lax verifiers, are refused); the signature over `"noise-libp2p-static-key:" ‖ static key` verifies under
  **strict RFC 8032** (`zip215: false`) — the same rules as core's `verifyEd25519Strict` (CT-15), implemented on
  the same `@noble/curves` so browser/Hermes bundles don't load core's domain modules, and checked against core
  on `vectors/signed.json`; and, when pinned, the key equals the pin. The library's own verification still runs
  afterwards, so either layer alone rejects a forged binding; the mutation gate shows each layer is tested
  (SC-10). Failures map to `PEER_MISMATCH` on the pinned initiator, `HANDSHAKE_FAILED` on the responder,
  `EARLY_DATA` for extensions/extra fields.
- **Authenticated close.** `close()` sends a CLOSE record; a transport that ends without one is reported as
  `TRUNCATED`, never as a clean end (tested: cut transport, dropped close record, truncated frame). A failed
  connection never ends with a CLOSE: `close()` then rejects with the failure (review M-1). Receiving the
  peer's CLOSE ends the connection cleanly on the spot (`receive()` → `null`, `closed` → `undefined`), whatever
  happens to the transport afterwards (review L-3). `receive()` also returns `null` after our own `close()`;
  messages arriving after a local close are not delivered (I-4).
- **End-of-stream ordering (review L-3).** A peer may send its last handshake message, application records and
  its CLOSE in one burst and close the transport. The byte-stream adapter counts complete handshake messages
  as they arrive: if the transport ends before all arrived, the end is delivered at once (the handshake fails
  promptly); otherwise it is held until the connection has attached its listeners, so every authenticated record
  is delivered first. A failed transport write (the peer already closed) no longer aborts the read side: records
  that arrived are still delivered, sends reject, no CLOSE is sent, and the connection ends with the write error
  unless the peer's CLOSE arrives and none of our DATA can have been lost. Tested with 40 fast send-and-close
  clients in memory, 1-byte splitting and full coalescing by the relay, and 20 over WebSockets.
- **Rekey = reconnect.** Per-connection limits on messages sent (default 2^30), bytes sent (2^40) and age
  (12 h); reaching one makes `send` throw `RekeyRequiredError` and sets `rekeyRequired`; the caller closes and
  reconnects (fresh ephemeral and static X25519 keys, fresh cipher states — nonces are never reset under an old
  key). Independent of policy, sends stop at `FRAME_CEILING` = 2^31 transport AEAD operations; libp2p-noise
  itself throws at 2^32 − 1 (its 32-bit nonce counter, below the Noise 2^64 limit).
- **Errors** (`SecureChannelError.code`): `PEER_MISMATCH`, `HANDSHAKE_TIMEOUT`, `HANDSHAKE_FAILED`,
  `EARLY_DATA`, `DECRYPT_FAILED` (any AEAD failure: tamper, replay, reorder, drop, short frame),
  `FRAME_TOO_LARGE`, `PROTOCOL_ERROR`, `TRUNCATED`, `BUFFER_OVERFLOW`, `REKEY_REQUIRED`, `CLOSED`,
  `TRANSPORT_ERROR`, `NO_SECURE_RANDOM`, `KEY_STORE`. Messages authenticated before a failure stay readable;
  the failure is reported after them.
- **Flow control (review M-2).** Connection-level credit, independent of the transport: each side may send DATA
  costing `INITIAL_WINDOW_BYTES` (256 KiB) before the peer grants more with WINDOW records; a DATA record costs
  its payload + `RECORD_COST_OVERHEAD` (64 bytes, so empty messages are not free). After the handshake each side
  grants the rest of its `receiveWindowBytes` (default 1 MiB, 256 KiB..64 MiB) and re-grants what the
  application consumed (`receive()`) in steps of a quarter window. `send` waits for credit (in order);
  receiving more than was granted → `PROTOCOL_ERROR`. This bounds the bytes in flight end to end — in the
  sender's socket queue, the relay and the receiver's buffer — on every platform, including React Native
  whose WebSocket reports no `bufferedAmount` and cannot be paused, and replaces the previous receive-side pause.
  The session protocol's per-stream CREDIT (MA-08) sits on top. Wire change from 0.5.0 (record type 0x02),
  hence protocol version 2 (prologue above). WINDOW validation: a 4-byte payload, increment 1..2^32−1, and at
  most 64 MiB of outstanding credit, else `PROTOCOL_ERROR` (tested, re-review N-2).
- **Stalls are the session layer's job (re-review N-5).** The channel has no credit timeout: a peer that never
  grants credit (or a relay that withholds the frame carrying a grant) leaves `send()` pending indefinitely, with
  memory bounded by the window plus `maxQueuedSendBytes`. `close()` or `abort()` settle pending sends. The
  session protocol owns stall detection (MA-08 request deadlines, keepalive/timeouts) and aborts the
  connection; the relay's idle timeout may be kept alive by its own pings.
- **Bounds.** Record header checked before buffering its body (oversize → `FRAME_TOO_LARGE`, no allocation of
  the claimed size); WebSocket messages > `maxMessageBytes` (default 262144 = relay `maxMessage`) →
  `FRAME_TOO_LARGE` + close 1009; text after `ready` → `PROTOCOL_ERROR`. The WebSocket adapter applies send
  backpressure from `bufferedAmount` where the socket reports it (browsers, Node `ws`) and pauses Node `ws`
  sockets on receive; its hard inbound cap (`maxBufferedBytes`, 8 MiB) is not reached by a conforming peer
  because of the window. More than `maxQueuedSendBytes` (4 MiB) waiting for credit or the transport →
  `BUFFER_OVERFLOW`. A peer that exceeds 2^31 + 2^20 transport frames without rekeying is cut off (I-5).
  Handshake timeout default 10 s; `close()` gives up after 5 s and aborts. The close reason of a WebSocket (peer
  or relay text) is reduced to 64 printable ASCII characters in error messages (I-8).
- **Randomness (review L-2).** `assertSecureRandom()` runs before every key generation and handshake and
  fails closed (`NO_SECURE_RANDOM`) if `globalThis.crypto.getRandomValues` is missing or throws, if two 64-byte
  draws are equal, or if a draw has fewer than 16 distinct byte values or is an arithmetic progression
  (constant, counter). This catches stubbed or broken polyfills; it cannot prove a source is a CSPRNG (a seeded
  PRNG passes). All keys and ephemerals come from @noble (→ `getRandomValues`), WebCrypto, or Node's CSPRNG; the
  Expo app must install `expo-crypto`'s native `getRandomValues` and never a `Math.random` shim.
- **Session protocol fit (CT-05).** Session frames `[u32 len][u8 type][u32 stream][payload]` (payload ≤ 64 KiB, so
  frames reach 65545 bytes, above one record) go through `secureByteStream(connection)`: a `ByteStream` view that
  cuts writes into records of ≤ 65514 bytes (backpressured via `send`) and returns record payloads in order on
  `read`; the session layer's `FrameDecoder` re-frames by its u32 prefix (now linear-time however the input is
  fragmented, review L-6). Records may share or span Noise frames when writes queue; a record is delivered only
  once all its bytes are authenticated. An authenticated close reads as end of stream. If any written piece
  cannot be sent (rekey threshold, transport failure, limits), the connection is **aborted** — the peer sees a
  failure, never a clean end — and `write`/`drained`/`close` reject with that error (review M-1; tested with
  rekey and transport failure mid-write).
  Tested with `@whombat/protocol/frame` (`encodeFrame`/`FrameDecoder`): 1200 max-size CONTROL/DATA/CREDIT/END/RESET
  frames over WebSockets. (Sending one frame per `send` also works for frames ≤ 65514 bytes.)
- The responder accepts any Ed25519 client; `remotePeerId` is the input to the appliance's own policy
  (enrolled endpoint → app ops; unknown → `enroll.*`/`recovery.*` only; revoked → abort) before any message is
  acted on (MA-04). The relay only ever sees ciphertext.

**Packaging (CT-01/CT-02).** `exports` → `src/*.ts` in the workspace, `publishConfig.exports` → `dist/*.{js,d.ts}`
for `.` and `./node`; `tsc -p tsconfig.build.json`; explicit `.js` relative imports; ESM only; version follows
the workspace. `./node` (FileKeyStore, `nodeNoiseCrypto`, `nodeWebSocketByteStream`,
`verifyInstalledDependencies`) is the only place Node APIs are allowed.

## SC-04 What passed (commands and numbers)

All on this host: Linux 6.12, AMD Ryzen Threadripper 9970X, Node 24.18.0; `TMPDIR=~/.cache/wb-tmp`. The numbers
below are from the 0.3.0 qualification; SC-10 has the re-run after the review fixes.

- Rebased on contracts `main` b60b7c7 (contracts-v0.2.0); root `pnpm check` passes (biome, typecheck, 630 tests
  across the workspace); `pnpm build` emits `dist/` per CT-01; `pnpm pack` tarball installed into a scratch
  consumer imports `.` and `./node` with plain Node ESM and typechecks under `moduleResolution: nodenext`
  (`skipLibCheck: false`).
- `pnpm --filter @whombat/secure-channel test` (Vitest 5.0.1): **47/47 passed** (incl. a purity guard: no
  Node-only API outside `src/node`, and CT-05 frames over `secureByteStream`) — in-memory pair, a
  man-in-the-middle splice, and real `ws` 8.21.3 sockets through a splice relay that applies MA-05-style 1 MiB
  per-direction backpressure. Covers: handshake + ordered bidirectional messages; empty and 65514-byte messages;
  64 MiB in-memory and 2×32 MiB concurrent ws transfers (SHA-256 verified); 200 concurrent in-memory and 50
  concurrent ws handshakes; wrong PeerId (client wrote exactly 34 bytes; relay forwarded exactly 34 bytes
  client→appliance); fingerprint pin ok/mismatch; unknown client visible to responder and refusable;
  non-Ed25519 client rejected; prologue mismatch; extension (early-data) payload rejected; handshake timeout
  (200 ms); fail-closed without CSPRNG and with an all-zero RNG; oversize send / oversize received record /
  oversize and text WebSocket messages; rekey by messages, bytes and age then fresh reconnect (memory and ws);
  FRAME_CEILING; slow consumer (memory: sender blocked at 512 KiB in flight; secure-over-ws: sender stalled at
  18.7 MiB; raw ws: writer stalled at 21.7 MiB = adapter + relay + kernel socket buffers, then all data
  delivered); authenticated close vs truncation; tamper by malicious splice: bit flip in ciphertext and in the
  tag, duplicated (replayed) frame, reordered frames, dropped frame, frame shorter than the tag → all
  `DECRYPT_FAILED` with earlier messages intact; truncated frame / dropped close → `TRUNCATED`; tampered
  handshake messages 2 and 3 → `HANDSHAKE_FAILED`; replay of a recorded client flight into a new session with the
  same appliance identity fails; identity serialization, WebCrypto non-extractable identities, FileKeyStore
  0600/0700, refuses 0644 files, symlinks and overwrites.
- `pnpm --filter @whombat/secure-channel test:browser` on the host: **Chromium 153.0.8010.12 and Firefox 155.0
  passed** (4 tests each + bundle check); WebKit cannot launch on this host (missing system libraries).
  `pnpm --filter @whombat/secure-channel test:browser:docker` (official `mcr.microsoft.com/playwright:v1.63.0-noble`
  image, Node 24.20.0): **13/13 passed incl. WebKit 26.6** (Chromium 153, Firefox 155, WebKit 26.6). Each browser: esbuild browser bundle, Node responder
  through the splice relay, pinned PeerId, echo of 1 B/100 B/16 KiB/65514 B messages and 8 MiB bulk (handshake
  13–25 ms incl. WebSocket; 8 MiB echo 117–187 ms), non-extractable WebCrypto Ed25519 identity stored in
  IndexedDB and reused after a page reload (same PeerId seen by the appliance), fingerprint pin, wrong PeerId →
  `PEER_MISMATCH` with zero application bytes at the appliance.
- `pnpm --filter @whombat/secure-channel spike:bench` (Node↔Node loopback, both ends in one process; handshake
  = initiator start → both established, sockets pre-opened; 200 samples after 20 warm-up):

  | transport | Noise crypto | handshake p50 / p95 / p99 | echo 100 B p50 / p95 / p99 | throughput 64 MiB |
  |---|---|---|---|---|
  | memory | pure-JS (default) | 6.04 / 7.31 / 8.07 ms | 0.03 / 0.08 / 0.23 ms | 127 MiB/s |
  | memory | node crypto | 1.26 / 1.63 / 2.95 ms | 0.02 / 0.02 / 0.03 ms | 599 MiB/s |
  | ws via splice relay | pure-JS (default) | 6.14 / 7.37 / 8.34 ms | 0.06 / 0.10 / 0.17 ms | 96 MiB/s |
  | ws via splice relay | node crypto | 1.61 / 2.11 / 4.24 ms | 0.04 / 0.07 / 0.14 ms | 269 MiB/s |

  Loopback only: no regional network, no TLS, not the MA-05 relay. The p95 < 100 ms warm regional echo target
  is not measured here.
- Hermes: see SC-05 (passed).

## SC-05 Hermes / Expo status

**Ran:** `RN_SPIKE_DEPS=<dir> HERMES_BIN=<dir> pnpm --filter @whombat/secure-channel spike:hermes` →
`HERMES QUALIFICATION PASSED`. The scenario (`spikes/secure-channel/hermes/scenario.ts`) is bundled by **Metro
0.84.6 with React Native 0.86.3's default config and Babel preset** (`@react-native/metro-config` 0.86.3,
inline requires, package exports, `react-native`/`browser` fields), compiled with `hermesc -emit-binary -O` and
run on the **Hermes VM built from `facebook/hermes` tag `hermes-v250829098.0.17`** (the `hermes-compiler`
version React Native 0.86.3 pins; `cmake -DCMAKE_BUILD_TYPE=Release -DHERMES_UNICODE_LITE=ON`). Globals are
installed from React Native's and Expo 57.0.24's own modules (RN `Event`/`EventTarget`/`CustomEvent`,
`queueMicrotask`, `abort-controller`; Expo winter `TextDecoder`, `AbortSignal` patch, `Symbol.asyncIterator`).
Results: no-CSPRNG fail-closed ok; KATs SHA-256("abc"), X25519 RFC 7748 §5.2, ChaCha20-Poly1305 RFC 8439 §2.8.2
(seal tag and open) ok; fingerprint KAT ok; pinned session with 0/1/1000/65514-byte echoes and authenticated
close ok; wrong PeerId, tamper, rekey, handshake timeout ok. With the same TEST-ONLY deterministic random source
(keyed by request length so noble's blinding draws don't shift key draws), the full session transcript
(133683 bytes, 13 chunks, SHA-256 `5e2af314…0b95`) is **byte-identical** on Hermes, on Node with
Metro-equivalent resolution (`node-twin`) and on Node with native resolution (`node-direct`) — so the Hermes
build computes exactly what the Node appliance does.

Setup used (outside the repo, nothing committed):

```
git clone --depth 1 --branch hermes-v250829098.0.17 https://github.com/facebook/hermes.git src
cmake -S src -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DHERMES_UNICODE_LITE=ON && ninja -C build hermes hermesc
export HERMES_BIN=$PWD/build/bin
mkdir rn-spike && cd rn-spike && echo '{"private":true}' > package.json
npm i --ignore-scripts react-native@0.86.3 @react-native/metro-config@0.86.3 @react-native/babel-preset@0.86.3 \
  metro@0.84.6 react@19.2.3 @babel/core expo@57.0.24
export RN_SPIKE_DEPS=$PWD
```

Hermes performance (this x86 desktop, interpreter, one thread running both ends; 0.3.0 figures, see SC-10 for
0.5.1: handshake p50 148 ms / p95 149 ms, the strict identity check adds a pure-JS Ed25519 verification per
side; throughput 1.4 MiB/s): handshake p50 109 ms / p95 111 ms; X25519 keygen+DH 12.6 ms; raw ChaCha20-Poly1305 3.2 MiB/s; session throughput 1.5 MiB/s one direction
(V8: 0.85 ms, 290 MiB/s, 116 MiB/s). Expect phones to be slower.

**What the app must do (React Native / Expo):**
1. Install `crypto.getRandomValues` before importing the package (Whombat mobile already does this in
   `apps/mobile/src/polyfills.ts` with `expo-crypto`'s `getRandomValues`). Without it the package throws
   `NO_SECURE_RANDOM`.
2. `TextDecoder` is missing on Hermes; Expo's winter runtime installs it (`expo/src/winter/runtime.native.ts`);
   bare React Native needs a polyfill.
3. Metro: alias `node:os` to an empty module (see `spikes/secure-channel/hermes/metro.config.cjs` +
   `shims/node-os.js`). `@libp2p/utils`'s `react-native` field maps `get-thin-waist-addresses` to its Node file,
   which imports `node:os`; without the alias Metro fails to resolve. (Unused by the channel.)
4. Use `webSocketByteStream(ws)` on the React Native `WebSocket` after the relay's `ready`; the adapter sets
   `binaryType = 'arraybuffer'`. Before 0.5.1 this deadlocked on React Native: `bufferedAmount` is declared but
   never assigned there (review M-2; confirmed on the Android emulator, whombat-app 639d537). The app's
   workaround (treat `undefined` as 0) must be dropped once it uses 0.5.1: the adapter now does this itself, and
   sender backpressure is not lost — it comes from the connection's flow-control window, which tracks our own
   unacknowledged bytes end to end (the receiver grants credit only as its application consumes) and blocks
   `send` at the window (1 MiB default). Bytes in React Native's native WebSocket queue are therefore at most the
   window plus one transport chunk; the session protocol's per-stream CREDIT window sits on top.
5. `AbortSignal.prototype.throwIfAborted` is missing from React Native's `AbortSignal` (the `abort-controller`
   polyfill; seen on the emulator). Upstream calls it on the handshake's signal (p-event while waiting for a
   drain, `@libp2p/crypto` sign/verify options). Since 0.5.1 the package adds it to its own signal instance, so no
   app polyfill is required for the channel; apps that pass their own signals into libp2p code need a
   `throwIfAborted` polyfill (`if (this.aborted) throw this.reason`). Covered by a Node test (prototype method
   removed) and the Hermes qualification (backpressured handshake).

The React Native socket path is tested in Node against a simulation of React Native 0.86's `WebSocket` and
OkHttp (`test/rn-websocket.ts`: no `bufferedAmount`, no `pause`, base64 bridge both ways, OkHttp's 16 MiB
`MAX_QUEUE_SIZE` with close 1001 — `RealWebSocket.kt`). The simulation reproduces the failure mode (raw writes
without flow control reach 16 MiB in the native queue and are refused), and the secure channel over it completes
handshakes and echoes, uploads 48 MiB to a slow appliance with the native queue peaking at 768 KiB, and holds a
download at the client's 1 MiB window while the client does not read.

**Android emulator (reported by the orchestrator, whombat-app 639d537, release build, React Native 0.86
WebSocket, app workaround for `bufferedAmount` in place):** handshake p50 168 ms / p95 175 ms, 2 MiB download
1.67 MiB/s, 1 MiB upload 1.30 MiB/s, wrong PeerId refused. Not yet re-run with 0.5.1.

**Unverified (named, with runbook):** 0.5.1 on the emulator/device without the app workaround, physical Android
and iOS runs (the real React Native `WebSocket` and OkHttp/SocketRocket, the real `expo-crypto` random source, suspend/resume, ARM performance), and the iOS build.
On-device check: in the Expo app, open `webSocketByteStream(ws)` over the dev relay to a Node appliance and run
(a) handshake + echo of 0/1/1000/65514-byte messages, (b) a 64 MiB upload while the appliance consumes 1 message
per ms — the app must not see close 1001 and memory (Android Studio profiler / Xcode) must stay flat, (c) a
64 MiB download while the app pauses reading for 5 s — no `BUFFER_OVERFLOW`, (d) wrong PeerId → `PEER_MISMATCH`. Runbook for the app agent: add the package to the Expo app,
apply items 1–4, run `spikes/secure-channel/hermes/scenario.ts`'s `runScenario` from a dev screen with
`globalThis.crypto` = expo-crypto (no deterministic source; transcripts will differ, every line must say `ok`),
then connect to a Node `acceptResponder` behind the splice relay (`packages/secure-channel/test/support.ts`
`startSpliceRelay`) from the Android emulator (`adb reverse tcp:<port> tcp:<port>`) and an iOS simulator, check
`PEER_MISMATCH` with a wrong PeerId, and record handshake/throughput on a mid-range Android phone. Pass: all
`ok`, handshake p95 < 1 s, ≥ 1 MiB/s.

## SC-06 Key storage

| Platform | Store | Notes |
|---|---|---|
| Appliance content identity | `FileKeyStore('/persist/identity')` from `@whombat/secure-channel/node`, name `content` | libp2p protobuf private key, file 0600, dir 0700; new keys are written to a temp file, fsynced and published with `link()` (atomic, never overwrites: concurrent creators converge on the stored key — review L-4, tested with 6 racing processes) or `rename()` for `replace`, then the directory is fsynced; `get` opens with `O_NOFOLLOW` and checks the opened descriptor (no stat/open race), refusing symlinks, non-regular files, group/other-accessible modes, other owners, and a key whose public half does not match its seed (I-1). Owned by the runtime user; the management key stays with the manager (MA-03, MA-12). Encrypted at rest by `/persist`. |
| Browser endpoint key | IndexedDB holding a **non-extractable WebCrypto Ed25519 `CryptoKeyPair`** (`generateWebCryptoIdentity()`, `identityFromCryptoKeyPair(stored)`) | Verified in Chromium 153, Firefox 155, WebKit 26.6: signs the Noise static key via `subtle.sign('Ed25519')`, survives reload, `serializeIdentity` refuses it; `identityFromCryptoKeyPair` refuses an extractable private key unless `allowExtractable` is passed (I-7). Script on the origin can still *use* the key while the page runs (XSS = key use, not key theft). Fallback where WebCrypto Ed25519 is missing (older engines): `generateIdentity()` + `serializeIdentity` bytes in IndexedDB — honestly weaker: XSS or local malware can copy the key; show it as a lower-assurance endpoint and prefer re-pairing over silent fallback. Lost storage = lost endpoint (re-pair or recovery, MA-04). |
| Expo (Android/iOS) endpoint key | `expo-secure-store` (57.0.x): store `serializeIdentity(identity)` (68 bytes, base64) with `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY` | Encrypted by Android Keystore / iOS Keychain, not synced or backed up. The key is loaded into JS memory for signing (Hermes has no WebCrypto; Ed25519 in hardware would need a native module — Android Keystore Ed25519 needs API 33+; iOS Secure Enclave has no Ed25519). Optional `requireAuthentication` gates loading behind biometrics. |
| Tests / ephemeral | `MemoryKeyStore` | — |

`KeyStore` interface: `get(name)`, `put(name, identity, { replace? })` (refuses to overwrite a different
identity), `delete(name)`; `loadOrCreateIdentity(store, name)`.

## SC-07 Issues found upstream (report / track)

1. `@libp2p/utils` 7.4.1 `AbstractMessageStream.onDrain()` never clears its resolved promise, so after the first
   drain every later call resolves immediately and backpressure silently disappears. We wait for the `drain`
   event instead (`waitForDrain`); regression-covered by the slow-consumer tests. Worth an upstream issue.
2. esbuild does not apply `@libp2p/noise`'s `browser` field to the `./crypto` subpath export, so importing
   `@libp2p/noise/crypto` pulls `node:crypto` into browser bundles. We import it only from the `./node` subpath.
3. `@libp2p/utils`' `react-native` field points at a file importing `node:os` (Metro alias needed, SC-05).
4. Pinned-identity mismatch surfaces as the library's `UnexpectedPeerError` (same class as a bad signature);
   with a pin, the initiator maps both to `PEER_MISMATCH` (either way the peer is not the pinned appliance).
5. `@libp2p/crypto`'s Ed25519 verification accepts small-order keys (OpenSSL; noble with its ZIP-215 default),
   and non-Ed25519 identity keys are parsed and verified before a caller can refuse them; there is no option to
   restrict key types. Both are handled by our payload check (SC-03); worth an upstream option.
6. A relay can inject zero-length Noise frames (`00 00`): upstream ignores them without using a nonce (review
   I-3). No data impact; "every transport byte is authenticated" holds only for non-empty frames.
7. The Go `protocol.FrameDecoder` (`go/protocol/frame.go`) copies its pending buffer on every push
   (`append([]byte(nil), d.buf...)`), the same O(n²) pattern as the TypeScript decoder had (review L-6); not
   changed here (owned by the contracts workstream).

## SC-08 Unverified / open risks

- No public audit of `@libp2p/noise`; our use depends on its handshake state machine and signature binding
  (the 2022 signature-validation CVE shows this code has had critical bugs). Mitigation: independent code review
  of `@libp2p/noise@17.0.3` `performHandshake.ts`, `protocol.ts`, `utils.ts`, `nonce.ts` and of this package
  before GA; pinned versions; tests above.
- Pre-auth cost on the responder: non-Ed25519 keys are now refused before any parse/verify, but every
  handshake still costs the responder X25519 work and (for Ed25519) two signature verifications — about 4 ms
  of pure-JS CPU per attempt on this host (both ends, one process; 2 ms with `nodeNoiseCrypto`). Rate limits
  live outside this package (re-review N-6): the relay applies per-subject and per-IP hello limits and admission
  tickets gate who may open a session (MA-05/06), and the appliance runtime caps concurrent handshakes at 8.
  Keep `@libp2p/crypto` patched (GHSA-rvfr-cqwq-rc4j class).
- Hermes throughput (≈1.5–3 MiB/s pure JS on desktop) may be too slow for large mobile transfers. Mitigation
  without changing protocol: inject a native `ICryptoInterface` (e.g. a JSI ChaCha20-Poly1305/X25519) via the
  `crypto` option — not evaluated.
- Exact application message sizes and timing are visible to the relay (one record per message, no padding;
  review I-6, accepted by the threat model). Pad CONTROL frames to buckets if operation fingerprinting matters.
- The receive direction's age limit is the peer's (I-5): our 12 h age policy bounds what we send; a peer that
  never rekeys keeps its sending key until the frame cap above.
- The fingerprint pin path reveals the client's endpoint public key to an impostor (no data).
- Not measured: regional latency through the real relay and TLS; on-device mobile; iOS.

## SC-09 Failure criteria that make us switch

Re-evaluate (and move to another maintained Noise implementation or a native binding, never homemade crypto or
relay-terminated TLS) if any of: a critical/high advisory in `@libp2p/noise`, `@libp2p/crypto` key handling or
`@noble/*` used primitives stays unpatched for 30 days; the package stops receiving releases for 12 months or
the ConnectionEncrypter/prologue/`crypto` injection API is removed without a migration path; an independent
review finds a handshake/identity-binding flaw upstream will not fix; interop or the Hermes transcript test
breaks on a supported engine without a fix; mobile handshake p95 > 1 s or bulk < 1 MiB/s on the reference
Android device that an injected native `ICryptoInterface` cannot fix. First alternative to evaluate: a
libsodium-backed Noise XX (e.g. Holepunch `noise-handshake` with `sodium-universal` / `react-native-libsodium`),
keeping the same `SecureConnection` API and wire framing above Noise; it would lose libp2p PeerId-signed
identity binding unless re-implemented, which then needs its own review.

## SC-10 Independent review outcome and corrections (2026-09-25, contracts 0.5.1)

Review: `appliance/docs/implementation/reviews/secure-channel-review.md` (independent agent, target
`0483442`): **accept with required fixes**. It found no flaw in the upstream handshake or identity binding;
the findings were in this package, its tests and one decoder. All are resolved on branch `secure-channel-fixes`:

| Finding | Resolution | Test |
|---|---|---|
| M-1 `secureByteStream` truncation behind an authenticated close | a failed piece aborts the connection; `write`/`drained`/`close` reject; `Connection.close()` rejects on a failed connection | `flow.test.ts` "rekey threshold mid-write", "transport failure mid-write", "Connection.close() on a failed connection" |
| M-2 WebSocket adapter deadlocks on React Native (`bufferedAmount` undefined) | connection-level flow control (WINDOW records) bounds bytes in flight; the adapter ignores a non-numeric `bufferedAmount` | `flow.test.ts` "React Native WebSocket": RN/OkHttp simulation (`test/rn-websocket.ts`); on-device check in SC-05 |
| M-3 identity signature and substitute peer untested | our payload check (strict signature, key type, strength, pin) before upstream's; regression tests for forged bindings both ways, for the upstream library alone, and for a relay terminating both legs | `identity-auth.test.ts`; mutation gate U1, S1, U1+S1 |
| L-1 small-order identities accepted | refused (8 torsion points, non-canonical encodings) in the handshake and in pins | `identity-auth.test.ts` "weak and foreign identity keys" |
| L-2 weak random self-test | two 64-byte draws, equality/diversity/progression checks | `flow.test.ts` "random-source self-test" |
| L-3 close races | end of stream held until the handshake and the connection's listeners are done and the read buffer drained; the peer's CLOSE ends the connection at once; write failures no longer drop received records | `flow.test.ts` "close races", `message-stream.test.ts` |
| L-4 `FileKeyStore` create race | `link()` publish, re-read on `EEXIST`, descriptor checks | `identity.test.ts` 6 racing processes × 6 (fails on the old code) |
| L-5 pre-auth CPU from foreign key types | refused before upstream parses/verifies them; rate-limit guidance in SC-08 | `identity-auth.test.ts` RSA, mutation S3 |
| L-6 `FrameDecoder` O(n²) | linear decoder in `@whombat/protocol` (1-byte pieces of a max frame: 353 ms → 6 ms) | `frame.test.ts` "linear time" |
| L-7 `nodeNoiseCrypto` uses `@chainsafe/as-chacha20poly1305` | OpenSSL for every AEAD size | `node.test.ts` |
| L-8 consumers don't inherit the pinned set | `PINNED_DEPENDENCIES`, `verifyInstalledDependencies()`, `pnpm.overrides` snippet (SC-01); nightly `ms` cannot be dropped (SC-01) | `node.test.ts` |
| I-1 seed/public mismatch | refused on load | `identity-auth.test.ts` |
| I-2 CID pin fails after message 3 | pins validated and compared by key before any byte | `identity-auth.test.ts` |
| I-3 zero-length frames | upstream behaviour, documented (SC-07) | — |
| I-4 `null` after local close | documented on `receive()` | — |
| I-5 receive direction unbounded | peer cut off after 2^31 + 2^20 frames; age limit documented (SC-08) | — |
| I-6 sizes visible to the relay | accepted, documented (SC-08) | — |
| I-7 extractable WebCrypto key labelled non-extractable | refused unless `allowExtractable` | `identity-auth.test.ts` |
| I-8 remote close reason in errors | 64 printable ASCII characters | — |
| Review: M15 (unknown record types) mutation survived | test added | `flow.test.ts` "unknown record type" |

ADR corrections from the review are applied above: SC-01 (`nodeNoiseCrypto`, consumer pins), SC-03 (close
semantics, identity checks, randomness limits, flow control, records may span Noise frames), SC-05 (React
Native WebSocket), SC-06, SC-07, SC-08.

Found while fixing: the mutation gate showed that with a faster handshake (upstream verification skipped) the
end of stream could overtake post-handshake bytes that `lpStream.unwrap()` re-dispatches from a timer, dropping
authenticated records as `TRUNCATED`; the end of stream now always waits for the read buffer to drain
(`message-stream.test.ts` fails on the earlier code). The Android emulator run added item 5 of SC-05
(`throwIfAborted`).

**Mutation gate** (`spikes/secure-channel/mutate.py`, adapted from the review's `mutate.py`): edits a scratch
checkout, runs the package suite per mutation and restores; upstream files are privately copied first. Rerun it
on every change to this package and every `@libp2p/*`/`@noble/*` bump. Result on `secure-channel-fixes`
(87 tests): **36 of 42 mutations killed**, including both review survivors (M15 unknown record types; U1 upstream
signature verification off — now killed by the test of the upstream library alone) and every combination
that removes all layers of a check (M2, M1+S4, M3+S4, M5+S3, M6+S6, U1+S1, U2+S4). The six survivors are single
layers of a layered check, which survive by design because another layer catches the same attack:

| Survivor | Covered by |
|---|---|
| M1 upstream in-handshake pin off | our pinned-key check (S4 killed), combos M1+S4, M2 killed |
| M3 post-handshake key compare off | S4 and upstream pin; M3+S4 killed |
| M5 post-handshake key-type check off | our key-type check (S3 killed); M5+S3 killed |
| M6 post-handshake extension check off | our payload check (S6 killed); M6+S6 killed |
| U2 upstream pinned-key comparison off | S4; U2+S4 killed |
| F4 end-of-stream frame counting off | drain-ordered end-of-stream delivery catches the same races end to end; the counting itself is covered by `message-stream.test.ts` (the end-to-end tests cannot slow the upstream verification enough to separate the two) |

**Results after the fixes** (this host, Node 24.18.0): package suite 87/87; root `pnpm check` (biome, typecheck,
691 tests after rebasing on contracts 0.5.0); `test:browser` Chromium 153 and Firefox 155 pass on the host (WebKit cannot launch here);
`test:browser:docker` 13/13 incl. WebKit 26.6 (handshake 18–27 ms, 8 MiB echo 141–261 ms); `spike:hermes`
PASSED (transcript `a070fc36…cbd62`, 133739 bytes, identical on Hermes, node-twin and node-direct; backpressured
handshake ok). `spike:bench` (loopback, both ends in one process):

| transport | Noise crypto | handshake p50 / p95 / p99 | echo 100 B p50 / p95 / p99 | throughput 64 MiB |
|---|---|---|---|---|
| memory | pure-JS (default) | 8.16 / 9.99 / 11.47 ms | 0.03 / 0.07 / 0.14 ms | 130 MiB/s |
| memory | node crypto (OpenSSL) | 3.67 / 4.91 / 5.47 ms | 0.06 / 0.09 / 0.15 ms | 606 MiB/s |
| ws via splice relay | pure-JS (default) | 8.26 / 10.14 / 12.68 ms | 0.06 / 0.10 / 0.22 ms | 91 MiB/s |
| ws via splice relay | node crypto (OpenSSL) | 3.96 / 5.57 / 7.70 ms | 0.08 / 0.13 / 0.20 ms | 257 MiB/s |

Handshakes cost ~2 ms more than in 0.3.0 (our strict verification runs in addition to upstream's); small-message
echo with `nodeNoiseCrypto` is ~0.04 ms slower because OpenSSL now handles sub-1200-byte AEADs (L-7).

### Re-review (2026-09-25): ready for 0.5.1, with N-1…N-6 applied

The independent re-review (appended to the review report) found every earlier finding resolved and six new low
or informational items, all addressed on `secure-channel-fixes`:

| Item | Resolution | Test |
|---|---|---|
| N-1 wire change without a version change | prologue `whombat-secure-session/2`; `VERSION_MISMATCH` error; transport failures during the handshake are `HANDSHAKE_FAILED` | `channel.test.ts` "another protocol version"; `tamper.test.ts` message 2 split (static-key part → `VERSION_MISMATCH`, payload part → `HANDSHAKE_FAILED`); real 0.3.0 code both ways (outside the suite) |
| N-2 WINDOW validation untested | re-review PoC cases 1–4 adopted; receive frame ceiling and key-file size cap tests | `flow.test.ts` "WINDOW record validation", "receive-side frame ceiling"; `identity.test.ts` "too large"; mutations X1–X4, X10 |
| N-3 checked key not bound to the reported key | the key our payload check returns must equal the library's `remotePeer` key | defence in depth: mutation N3 survives by design while the parsers agree (no divergence known) |
| N-4 end-of-stream hold untested where verification is async | browser tests: appliance pushes one message and closes right after the handshake (client gets it, then a clean end); a browser appliance (WebCrypto verification) receives a Node client's burst of three messages and close | `browser.browser.test.ts`; kills mutation F4 in Firefox (Chromium's timing does not expose it) |
| N-5 no credit timeout | documented: the session layer owns stall detection (SC-03) | — |
| N-6 two Ed25519 verifications pre-auth | documented: rate limits at relay/admission, runtime caps concurrent handshakes at 8 (SC-08) | — |

Mutation gate after the re-review items (93 tests): **43 of 50 killed** (N1b verified by a manual run after a
pattern fix; the other 49 in one gate run), including X1–X4, X10, N1 and N1b. The 7 survivors are single layers
of layered checks — M1, M3, U2 (pin), M5 (key type), M6 (extensions), N3 (guard/library key binding) — whose
all-layer combinations are killed, and F4, which only matters where the responder verifies asynchronously and is
killed by the browser suite (Firefox) rather than the Node suite. Results: package suite 93/93; root
`pnpm check` passes (699 tests, on contracts main `f88e158`); `test:browser` on the host 13 passed / 6 skipped
(Chromium, Firefox; WebKit cannot launch here) and `test:browser:docker` 19/19 incl. WebKit; `spike:hermes`
PASSED (transcript `811901ba…93b7e` with the `/2` prologue, identical on Hermes, node-twin and node-direct,
backpressured handshake ok). Timing from this run is not comparable with earlier figures: the host load average
was ~76 on 64 cores (other workloads), so no new performance numbers are recorded; the protocol change adds no
work per handshake or record.

## SC-11 Replayed record after the welcome wedged the 0.5.1 client (2026-09-25)

**Report.** The integration harness's hostile relay delivered appliance→client binary message #3 twice on a fresh
connection (runtime and app on 0.5.1). On 0.5.0 the client failed the connection and reconnected; on 0.5.1 the
session stayed `open` and every request ended in `NotDeliveredError` after 30 s.

**Root cause: whombat-app, not the channel.** Reproduced at package level with the app's real client
(`secureWire` + `createSecureSession`, vendored 0.5.1) against a Node responder serving the app's fake appliance,
through a splice that duplicates one appliance→client message. The channel fails the connection with
`DECRYPT_FAILED` at once, and `secureWire` reports `lost`. In 0.5.1, message #3 is the welcome itself (#2 is the
WINDOW grant, new in `/2`), so its duplicate arrives right behind it. The failure lands after `open()` accepted the
welcome but before `attemptConnect` assigns `conn = c`. `connectionEnded(c)` sees `conn !== c` and returns without
scheduling a retry; then `conn = c` installs a connection that is already closed. On 0.5.0, #3 was a later record,
after `conn` was set. Patching `attemptConnect` in a scratch copy (treat `c.closed` after `open()` as lost) makes
the repro recover in ~75 ms (reconnecting:lost → open, all requests 200). The app change is reported to the
orchestrator; the app repo was not modified here.

**Hardening in the channel (branch `sc-replay-fix`).**
- `secureByteStream` fails as soon as its connection fails: an idle writer gets `DECRYPT_FAILED` from `write`,
  `drained` and `close`, instead of `true` and lost bytes.
- A record that fails to authenticate after the handshake returned, but before the connection object exists, is
  reported as `DECRYPT_FAILED` rather than `TRANSPORT_ERROR`. `openInitiator`/`acceptResponder` never return a
  connection that has already failed.
- `test/replay.test.ts` covers duplicate, reordered and tampered records at every index in both directions (and
  duplicates over WebSockets). The side that detects it reports `DECRYPT_FAILED` and the other side a failure;
  nobody stays open or ends cleanly. A pending `receive`, sends waiting for flow-control credit and byte-stream
  writers all get `DECRYPT_FAILED` within 500 ms. A replayed record in the burst with the last handshake message,
  while end of stream is held, gives `DECRYPT_FAILED`. Mutations R1–R3 cover the fan-out.
- In the handshake phase, a tampered message still reports the handshake codes (SC-03). A frame truncated by the
  transport ending reports `TRUNCATED`. A held-back record is a stall (N-5).

## SC-12 The direct path (contracts 1.0, 2026-10-24; Whombat hermes-engine.md HE-50, contracts CT-1250, CT-1251)

The box's direct listener carries the same secure channel as the relay: the client opens a WebSocket to
`/v1/direct` (subprotocol `whombat-direct.v1`) on the box's LAN address or Tailscale name, sends
`DirectHello {v: 1, class}`, gets `DirectWelcome {v: 1, heartbeatMs, maxMessage}`, and from then on the binary messages
are this package's: `webSocketByteStream(socket, {maxMessageBytes: welcome.maxMessage})`, `openInitiator` with the
box's PeerId pinned (`whombat-secure-session/2` prologue), records and WINDOW as SC-03 says. Nothing in this package
changes.

- **No ticket.** The relay's admission ticket only admits traffic (MA-06); the box never trusted it. On the direct path
  the box's responder (`acceptResponder`) admits from what the handshake proves: the client's static key. An enrolled
  endpoint gets the app channel, an unknown key the enrollment channel only, a revoked one is closed (MA-04). The
  pre-auth CPU cost an unknown peer can cause is one handshake per connection, which the box rate-limits by source
  address (`DIRECT_CLOSE.rateLimited`); the relay's ticket bounded it there.
- **The pin is the same.** A client that learnt a LAN address for one box and meets another at it aborts in message 2
  (`PEER_MISMATCH`, nothing but message 1 sent) and tries its next route, then the relay.
- **Plain `ws://` on the local network** adds no exposure the relay hasn't: the relay already sees only ciphertext.
  The channel's primitives are `pureJsCrypto` (`@noble`) and `getRandomValues`, which work in any page
  (`assertSecureRandom` still runs).
- **A plain-HTTP page has no secure context**, so no `crypto.subtle`: `generateWebCryptoIdentity` and
  `identityFromCryptoKeyPair` throw `KEY_STORE` there. A browser on the box's LAN page (`http://<address>:4480/`) needs
  a software identity (`generateIdentity`, kept in that origin's IndexedDB) — a weaker store than a non-extractable
  WebCrypto key, which is why the Tailscale page (`https://`) is the better browser way. Each page origin (the hosted
  app, the LAN page, the Tailscale page) is its own browser storage, so a browser is enrolled once per origin.
  Android has its own key store and connects directly either way.
