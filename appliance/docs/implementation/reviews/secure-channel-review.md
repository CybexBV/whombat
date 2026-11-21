# Independent security review: `@whombat/secure-channel`

Date: 2026-09-25. Reviewer: independent agent (did not write the code under review).
Target: `whombat-contracts` branch `secure-channel` at `0483442` (`packages/secure-channel/**`,
`docs/decisions/secure-channel.md`, `packages/protocol/src/frame*`, contracts 0.2.0).
Requirements: architecture MA-03/04/05/07/08/15, assignment §5 (secure channel) and §14 items 3–4, threat model T1/T2/T9.

## Verdict

**Accept with required fixes.**

The cryptographic core holds up. `@libp2p/noise@17.0.3` runs `Noise_XX_25519_ChaChaPoly_SHA256` with the libp2p
signed-static-key payload. The prologue goes into the handshake hash. A pinned client checks the appliance identity
while reading message 2, so an impostor never sees message 3. Every connection gets fresh static and ephemeral X25519
keys. Nonces cannot be reused. The relay gets nothing but ciphertext. I found no handshake or identity-binding flaw in
the upstream code the package actually uses. The upstream library can be selected.

Three findings must be fixed before the ADR is accepted. None of them is in the Noise library:

1. **M-1**: `secureByteStream` can silently drop data and then send an *authenticated* close. The reader sees a
   clean end of stream, which breaks the truncation guarantee claimed in SC-03.
2. **M-2**: on React Native the WebSocket adapter cannot complete a handshake (`bufferedAmount` is never set), so the
   ADR's Expo claims do not hold for the real transport.
3. **M-3**: no test protects the most important property. If upstream stopped verifying the identity signature (the
   CVE-2022-24759 class), all 47 tests would still pass. The T1 "substitute peer" test the threat model asks for is
   missing.

Required with them, because they are cheap and security-relevant:
- **L-1**: reject small-order ("keyless") Ed25519 identities.
- **L-2**: a random-source self-test that detects more than all-zero output.

Everything else is recommended.

## Scope and method

- Read all of `packages/secure-channel/src/**`, its tests, the ADR, and `packages/protocol/src/frame.ts`.
- Read the upstream code actually installed under `node_modules/.pnpm`:
  - `@libp2p/noise@17.0.3`: `noise.js`, `performHandshake.js`, `protocol.js`, `utils.js`, `nonce.js`, `crypto/*`,
    `logger.js`.
  - `@libp2p/crypto@5.1.23`: Ed25519 (Node and browser), RSA parsing and verify, protobuf keys.
  - `@libp2p/utils@7.4.1`: `AbstractMessageStream`, `lpStream`.
  - `@chainsafe/as-chacha20poly1305@0.1.0`.
  - React Native 0.86.3 `Libraries/WebSocket/WebSocket.js`.
- Checked provenance: the `@libp2p/noise@17.0.3` integrity in the lockfile
  (`sha512-dUmOjqkk…dA==`) matches the npm registry, and the gitHead `2bad1dfb…` matches the ADR.
- Advisories:
  - `pnpm audit --prod`: no known vulnerabilities.
  - GitHub advisory DB, queried per package (noise, crypto, utils, peer-id, interface, the three @noble packages,
    as-chacha20poly1305, as-sha256, protons-runtime, uint8arraylist, multiformats, multiaddr, dns-packet, netmask,
    it-length-prefixed): nothing affects the resolved versions. netmask advisories are < 2.0.1; 2.1.1 is resolved.
  - js-libp2p repository advisories: GHSA-rvfr-cqwq-rc4j affects `@libp2p/crypto <= 5.1.21` (5.1.23 is pinned);
    everything else listed is for gossipsub, floodsub, webrtc, kad-dht, peer-store and circuit-relay, none of which we
    use.
- Ran the package suite in a scratch worktree (`~/.cache/wb-tmp/sc-review`, detached at `0483442`): 47/47 passed.
- Ran 22 mutations (18 in our source, 4 in upstream noise) against the suite. Upstream files are hard links into the
  pnpm store, so each was replaced by a private copy before editing and restored afterwards.
- Wrote proof-of-concept scripts (index at the end).
- Not re-run by me: browser (Playwright), Docker WebKit, Hermes. Not run on a device. The original worktree
  `.worktrees/secure-channel` was not modified.

## Findings

| ID | Severity | Title | Confirmed |
|---|---|---|---|
| M-1 | medium | `secureByteStream` silently drops queued data after a send failure, then sends an authenticated CLOSE | PoC |
| M-2 | medium | WebSocket adapter deadlocks on React Native (`bufferedAmount` undefined): no handshake possible | PoC (simulated RN socket) + RN source |
| M-3 | medium | Identity-signature verification (CVE-2022-24759 class) and a real substitute-peer relay are untested | mutation U1 + PoC |
| L-1 | low | Small-order ("keyless") Ed25519 identities complete the handshake as endpoints | PoC |
| L-2 | low | `assertSecureRandom` only rejects all-zero output; a constant source repeats Noise ephemerals | PoC |
| L-3 | low | Close-path races: a clean authenticated close can surface as `CLOSED`, and a fast client's data and close are dropped as `TRANSPORT_ERROR` | PoC (memory transport); code reading for WebSocket |
| L-4 | low | `FileKeyStore` create race: a process keeps using an identity that is not the one on disk | PoC (2/15 trials) |
| L-5 | low | Pre-auth CPU: attacker-chosen identity key types (RSA with a huge exponent) are verified before rejection | PoC (measured) |
| L-6 | low | `FrameDecoder` copies its pending buffer on every push: O(n²) per fragmented frame | PoC (measured) |
| L-7 | low | `nodeNoiseCrypto` routes small AEAD operations through unaudited, unmaintained `@chainsafe/as-chacha20poly1305@0.1.0` (non-constant-time tag compare) | code reading |
| L-8 | low | Transitive versions are pinned only by this repo's lockfile; consuming apps resolve upstream `^` ranges | code reading |
| I-1 | info | `deserializeIdentity` does not check that the stored public half matches the seed | PoC |
| I-2 | info | A CID-form pinned PeerId fails closed, but only after message 3 was sent | PoC |
| I-3 | info | Zero-length Noise frames injected by the relay are silently ignored | PoC |
| I-4 | info | `receive()` returns `null` after a *local* `close()` (documented as "peer's authenticated close") | PoC |
| I-5 | info | Rekey/age policy applies to sending only; the receive direction is bounded only by the peer or the 2³² nonce limit | code reading |
| I-6 | info | Exact application message sizes are visible to the relay (no padding) | code reading |
| I-7 | info | `identityFromCryptoKeyPair` does not check that the supplied private key is non-extractable | code reading |
| I-8 | info | Remote-controlled WebSocket close reason text is embedded in error messages | code reading |

---

### M-1 (medium): `secureByteStream` truncation behind an authenticated close

Where:
- `packages/secure-channel/src/secure-byte-stream.ts:37-45`: pump `catch` drops the queue and records `failure`,
  but leaves the connection open.
- `secure-byte-stream.ts:70-78`: `close()` exits its wait loop on `failure` and still calls `connection.close()`.
- `channel.ts:518-529`: `Connection.close()` sends the CLOSE record because `RekeyRequiredError` never sets
  `Connection.failure`.

Scenario:
1. The session layer (CT-05 frames over `secureByteStream`) writes several frames. Each `write()` returns `true`
   because the queue is below 1 MiB.
2. The connection reaches a rekey threshold mid-transfer: age 12 h, 2³⁰ messages or 2⁴⁰ bytes. For long sessions the
   age threshold is guaranteed to hit.
3. `send` throws `RekeyRequiredError` inside the pump, and the remaining pieces are discarded.
4. The writer calls `close()`. It resolves successfully and sends an authenticated CLOSE.
5. The reader gets the data sent so far, then `null`, i.e. a clean, authenticated end of stream.

If the drop falls on a frame boundary, the receiving `FrameDecoder` cannot tell either. This contradicts SC-03 ("a
transport that ends without [a close record] is reported as TRUNCATED, never as a clean end"). The same path applies
to any other send failure: `close()` on an already-failed connection also resolves (`channel.ts:519`).

PoC `poc-bytestream-silent-truncation.ts`, output:

```
write() results: true,true,true,true,true; writer.close(): resolved OK
reader: 122880 of 204800 bytes, then clean authenticated EOF (null); reader connection closed = undefined
```

Fix:
- In the pump `catch`, `connection.abort(err)` so the peer sees a failure, not a close.
- In `secureByteStream.close()`, reject with `failure` if it is set, and never call `connection.close()` after data
  was dropped.
- `Connection.close()` should reject (or `closed` should report) when the connection had already failed.
- If `rekeyRequired` must allow a graceful end, only allow it when nothing is queued.
- Add tests for rekey mid-write and a transport failure mid-write, both through `secureByteStream`.

### M-2 (medium): the WebSocket adapter cannot handshake on React Native

Where:
- `packages/secure-channel/src/websocket.ts:135`: `return socket.bufferedAmount < sendHigh`.
- `websocket.ts:143`: `socket.bufferedAmount <= sendHigh / 2` is polled forever.
- React Native 0.86.3 `Libraries/WebSocket/WebSocket.js:92` declares `bufferedAmount: number;` and never assigns it
  (grep of the whole directory), so it reads `undefined`.

Scenario:
1. On Expo/RN, `write()` returns `undefined < 1048576`, i.e. `false`.
2. `ByteStreamMessageStream` sets `writableNeedsDrain`, and `drained()` polls a condition that can never become true.
3. `lpStream.write` of Noise message 1 waits for `drain` forever, and every mobile connection ends in
   `HANDSHAKE_TIMEOUT`.

The Hermes qualification (SC-05) used in-memory streams, so it did not exercise this path. The ADR lists the RN
WebSocket path as unverified, but also implies it works.

PoC `poc-rn-bufferedamount.ts`: a real `ws` socket behind a Proxy whose `bufferedAmount` is `undefined` and which has
no `pause`/`resume` (like RN), going through the splice relay. Output:

```
client: HANDSHAKE_TIMEOUT; appliance: HANDSHAKE_TIMEOUT
```

Fix:
- Treat a non-numeric `bufferedAmount` as "no transport backpressure available": `write` returns `true` and `drained`
  resolves.
- Then document that RN send memory is bounded only by the session CREDIT window and the relay slow-consumer rule.
  Alternatively, read the native module's queue if one exists.
- Add an RN-shaped socket test (no `pause`/`resume`, no `bufferedAmount`).
- Run the on-device runbook in SC-05 before the ADR claims Expo interoperability. Assignment §5 requires it: "Prove
  … native Expo Android/iOS interoperability".

### M-3 (medium): the core authentication property has no regression test

Where:
- Upstream `@libp2p/noise/dist/src/utils.js:22` (pinned-key comparison) and `:29` (identity signature
  verification).
- `packages/secure-channel/test/*`.

Scenario: SC-08/SC-09 expect dependency updates. A regression like GHSA-j3ff-xp6c-6gcc (signature not validated)
would let a hostile relay (T1):
- terminate Noise itself, claim the pinned appliance's public identity key with a bad signature over its own static
  key, and read `enroll.claim{claimSecret…}`;
- or claim an enrolled endpoint's key towards the appliance.

Mutation U1 disables that verification upstream, and **all 47 tests still pass**. The existing "wrong PeerId" tests
use an honest appliance with a wrong pin, so they exercise the key *comparison* (U2 is killed), not the signature.
Threat model T1 asks for a hostile-relay harness with "substitute peer", which is not present.

PoC `poc-impersonation-bad-signature.ts` is a ready regression test:
- With the real dependency: client `PEER_MISMATCH`, appliance `HANDSHAKE_FAILED`.
- With U1 applied: `BREACH: impostor read "…enroll.claim{claimSecret: …}"` and
  `BREACH: appliance authenticated remotePeerId=<the enrolled client>`.

Fix:
- Add both cases, plus a relay that runs two separate handshakes (client↔relay, relay↔appliance) with its own keys,
  to `tamper.test.ts`.
- Keep the U1/U2/U3/U4 mutations as a gate for every `@libp2p/*` or `@noble/*` bump (e.g. adapt
  `sc-review-poc/mutate.py`).

### L-1 (low): small-order ("keyless") Ed25519 identities are accepted

Where:
- `channel.ts:271-273` checks only `type === 'Ed25519'`.
- Upstream `@libp2p/crypto` Ed25519 verify: OpenSSL `crypto.verify` on Node; WebCrypto or `@noble/curves` with the
  default `zip215: true` in browsers and Hermes.

Scenario:
- Public key = the identity point (`01 00…00`) and signature `R = identity, S = 0` verify for *any* message.
  OpenSSL 3.5.7 and noble (default) accept it; noble `zip215:false` rejects it.
- A PeerId (`12D3KooW9tGaPdJo5jmCpadQ971nfiq4kLcQjeBPYTfutBTtckPH`) that nobody holds a key for completes the
  handshake with `acceptResponder`.
- If such an endpoint key is ever enrolled (a buggy client, or a malicious pairing on an owner's behalf), anyone,
  including the relay, can authenticate as it. The audit trail then attributes actions to a key with no holder.
- Verifier semantics also differ by platform (OpenSSL vs WebCrypto vs ZIP-215 noble), so acceptance of edge-case keys
  is not uniform.

PoC `poc-small-order-identity.ts`: `CONFIRMED` twice with the same PeerId.

Fix:
- After the handshake, reject remote keys that are small-order or non-canonically encoded (noble:
  `ed25519.Point.fromBytes(pk)`, `isSmallOrder()`, and check that re-encoding round-trips).
- Apply the same check in the appliance's enrollment path.
- Add a test with the 8 torsion points.

### L-2 (low): weak random-source detection

Where: `packages/secure-channel/src/random.ts:12-15`.

Scenario:
- A misconfigured RN polyfill that returns constant (non-zero) or deterministic bytes passes.
- Noble draws the X25519 static and ephemeral keys (pure-JS crypto, the default everywhere) and, on Hermes, the
  endpoint identity from `globalThis.crypto.getRandomValues`, so every connection reuses the same "ephemeral".
- In the browser and on Node, identities come from WebCrypto or Node's CSPRNG and are not affected.

PoC `poc-weak-rng.ts`: `assertSecureRandom()` passes with `fill(0x42)`, and two handshakes send byte-identical
message 1 (`0020132c44…f472`).

Fix: draw two samples and reject if they are equal, or if either is a single repeated byte. This is still not a
CSPRNG proof, but it catches the common failure modes. The Expo app should import `expo-crypto`'s native
`getRandomValues` explicitly and never fall back to `Math.random` shims.

### L-3 (low): close-path races make end-of-stream nondeterministic

Where:
- `channel.ts:354` (a transport error after an authenticated CLOSE overrides it).
- `channel.ts:450` (answering close write can fail).
- `channel.ts:502` (`failure` is checked before `remoteClosed`).
- `channel.ts:359-361` (`raw.status !== 'open'` at construction is treated as fatal, even when authenticated records
  and a CLOSE record are already buffered in `secured`).
- Upstream `lpStream.unwrap` → `unshift` onto a closed stream.

Scenarios, from `poc-misc.ts`:
- **(a/b1)** After receiving `one, two, three` and the peer's authenticated CLOSE, the reader gets
  `CLOSED "write after close"` instead of `null`, and `closed` resolves to an error.
- **(f)** A client that sends 3 messages and closes before the responder finishes processing message 3 makes the
  appliance fail with `TRANSPORT_ERROR "transport closed before the connection was established"` and drop all three
  authenticated messages. With coalescing it fails with `HANDSHAKE_FAILED "Cannot push data onto a stream that is
  closed"`. The same client that waits for the responder gets all three.

These reproduce on the in-memory transport. Over WebSocket they need the CLOSE record, the close frame and the data
to arrive in the same event-loop turn as message 3, which a buffering relay or a busy appliance can produce.

Impact: the failure is always closed (never a false clean end), but it breaks the "deterministic errors" requirement
and loses data for short request/close clients.

Fix:
- Attach the `Connection` listeners synchronously when `secureInbound`/`secureOutbound` resolves.
- Process the buffered `secured` data before judging transport status.
- Once an authenticated CLOSE has been received, finish cleanly regardless of later local write failures.

### L-4 (low): `FileKeyStore` create race

Where: `packages/secure-channel/src/node/file-keystore.ts:49-69`. `put(replace=false)` is check-then-`rename`, and
`rename` overwrites.

Scenario: two processes run `loadOrCreateIdentity` on a fresh `/persist/identity` (provisioning retried, a service
started twice). One of them returns and keeps using an identity that is not on disk. For the appliance, that is a
content PeerId that changes at the next restart and no longer matches the claim card or control's directory. The
other outcome is a spurious failure.

PoC `poc-keystore-race-procs.sh` (two real processes): 2/15 trials diverged, 2/15 failed. The in-process variant
converges because `loadOrCreateIdentity` re-reads.

Fix: for `replace=false`, publish with `link(tmp, file)` (atomic, fails with `EEXIST`), then unlink `tmp`. On `EEXIST`,
re-read and return the stored identity. Keep `rename` only for `replace=true`. Optionally `fstat` the opened
descriptor in `get` instead of `lstat` then open (TOCTOU), and clean up `tmp` on write failure.

### L-5 (low): pre-auth CPU from attacker-chosen key types

Where: upstream `noise.js:64,105` and `utils.js:21-29` parse and verify any libp2p key type before `channel.ts:271`
can reject it.

Scenario: an initiator with only a relay ticket sends message 3 carrying an RSA key with a 3064-bit public exponent.
The PKIX is 805 bytes, under the 1062 limit, and OpenSSL allows large exponents for moduli ≤ 3072 bits. Measured on
this host:
- Big-exponent RSA verify: 2.91 ms, vs 0.018 ms for Ed25519 (160×).
- Full responder handshake with both ends in-process: 7.6 ms (`HANDSHAKE_FAILED`), vs 4.1 ms for an honest one.

The attacker only sends random bytes. The base pure-JS handshake is itself about 2 ms of responder CPU per message 1.

PoC `poc-rsa-preauth-cpu.ts`.

Fix: per-ticket and per-subject handshake rate limits at the relay and on the appliance (MA-05/06). Prefer OpenSSL
X25519 on the appliance. Ask upstream for an option to restrict accepted identity key types before verification; our
wrapper cannot intercept earlier without patching.

### L-6 (low): `FrameDecoder` O(n²) on fragmented frames

Where: `packages/protocol/src/frame.ts:195,215`. Each `push` allocates `buffer + chunk` and copies the whole pending
partial frame.

Scenario: over `secureByteStream`, each received record is one `push`. Any authenticated peer, including an
*unenrolled* endpoint on the enrollment channel, can cut a 65545-byte frame into 1-byte records.

Measured:
- One frame in one push: 0.10 ms. In 16-byte pieces: 45 ms. In 1-byte pieces: 353 ms.
- End to end: 1.5 MiB of attacker wire traffic cost 343 ms of decoder CPU, on top of about 1.1 s of Noise work for
  both ends.

PoC `poc-frame-decoder-quadratic.ts`.

Fix: once the u32 length is known (≤ 65545), allocate the frame once and fill it, or keep a chunk list. Give
unenrolled sessions rate and size budgets (MA-04 already asks for "bounded in rate and size"). The Go
`protocol.FrameDecoder` was not reviewed; check it for the same pattern.

### L-7 (low): `nodeNoiseCrypto` uses an unaudited, unmaintained AEAD for small messages

Where: `packages/secure-channel/src/node/index.ts:1` re-exports upstream `defaultCrypto`. Upstream
`crypto/index.js:105-112` sends every ChaCha20-Poly1305 operation under 1200 bytes, including all handshake AEADs and
small records, to `@chainsafe/as-chacha20poly1305@0.1.0`. That is a WASM implementation with a single release
(2022-11-21) and no public audit. Its `isSameTag` (`lib/src/chacha20poly1305.js:109-118`) exits early on the first
mismatching byte (not constant-time). It also decrypts into `dst` before checking the tag.

Exploitability is low: any failure aborts the session and the keys are per-connection. However, the ADR describes
this option as "OpenSSL + AssemblyScript, same algorithms" without noting the audit gap.

Fix: build the Node option from upstream's `nodeCrypto` (OpenSSL for every AEAD size) plus OpenSSL X25519, or keep
`pureJsCrypto` (noble, Cure53-audited) on the appliance. Record the choice in the ADR.

### L-8 (low): consumers do not inherit the pinned transitive set

Where: `packages/secure-channel/package.json`. Direct dependencies are pinned exactly. `@libp2p/noise` itself depends
on ranges (`@noble/curves ^2.0.1`, `@noble/ciphers ^2.0.1`, `@libp2p/crypto ^5.1.23`, `protons-runtime ^7.0.0`, …).

The published package will be installed by `whombat-app` and the appliance runtime, which resolve those ranges with
their own lockfiles. The versions listed in SC-01 are guaranteed only in this repo.

The runtime closure is about 56 packages. It includes the logger stack (`@libp2p/logger` → `weald` →
`ms@4.0.0-nightly.202508271359`, a pre-release), plus multiaddr, DNS-packet and netmask code the channel never uses.

Fix: in each consuming repo, pin the security-relevant transitive deps (`@noble/*`, `@libp2p/crypto`,
`@libp2p/noise`, `@libp2p/utils`) with `pnpm.overrides`. Add a CI check that the installed versions equal the ADR
list, and rerun the M-3 gate on every change.

### Informational

- **I-1**: `identity.ts:46-55` accepts a key file whose public half does not match its seed. The resulting `Identity`
  claims the wrong PeerId, and handshakes fail later (`poc-misc.ts` (d)). Derive the public key from the seed and
  compare.
- **I-2**: `channel.ts:264,275`: a pin supplied as a CID (`bafz…`) passes upstream's key check, then fails the
  base58 string comparison. The result is `PEER_MISMATCH` after 206 client bytes, i.e. after message 3 (`poc-misc.ts`
  (c)). This is fail-closed. Canonicalise with `parsePeerId(pin).toString()` and compare keys, not strings.
- **I-3**: upstream `utils.js:122`: a `00 00` length prefix yields no decrypt and no nonce use, so a relay can inject
  empty frames undetected (`poc-misc.ts` (a)). There is no data impact. Worth knowing for "every byte is
  authenticated" claims.
- **I-4**: `channel.ts:503`: after a local `close()`, `receive()` resolves `null` even though the peer never closed
  (`poc-misc.ts` (e)). The doc says `null` means the peer's authenticated close. Document it, or keep reading until
  the peer's CLOSE.
- **I-5**: `channel.ts:380-390`: count, byte and age limits apply to our own sends only. A peer that never rekeys can
  keep one receive key until 2³² frames, where upstream throws. That is acceptable for ChaCha20-Poly1305, but the 12 h
  "forward-secrecy window" only holds when both ends enforce it.
- **I-6**: one application message is one record is one Noise frame (frame = message + 21 bytes), so the relay learns
  exact CONTROL message sizes and timing. Consider padding CONTROL frames to buckets if operation fingerprinting
  matters. It is accepted by the threat model ("sizes/timing").
- **I-7**: `identity.ts:88-111`: `identityFromCryptoKeyPair` labels any pair non-extractable. Check
  `keyPair.privateKey.extractable === false` and warn or refuse otherwise.
- **I-8**: `websocket.ts:108-110`: the peer or relay-controlled close `reason` is interpolated into
  `TransportError.message`. Sanitise it or length-limit it before logging.

## What I verified and found correct

- **Version and provenance.** `@libp2p/noise` 17.0.3 is what is installed and imported (integrity and gitHead as in
  the ADR). `@libp2p/crypto` 5.1.23 contains the GHSA-rvfr fix.
- **Handshake.**
  - The protocol name is `Noise_XX_25519_ChaChaPoly_SHA256`.
  - The prologue is mixed into `h` (U4 killed; M13 killed).
  - The handshake AEAD uses `h` as associated data, and transport uses empty AD with directional keys from `split()`,
    so reflecting a frame back fails.
  - Message 1's plaintext payload is hashed and ignored.
  - With `expectedAppliancePeerId`, the identity comparison runs inside `readMessageB` processing before
    `writeMessageC` (`performHandshake.js`). The client writes exactly 34 bytes to an impostor (test plus M1/M2/U2
    killed).
  - Signed payload binding: `sig = Sign(identity, "noise-libp2p-static-key:" ‖ rs)` is verified for both directions
    (proved by the M-3 PoC against the real dependency).
- **Fresh state per connection.** `noise()` is constructed inside every `handshake()` call (`channel.ts:230`), so each
  connection gets a fresh static X25519 key, a fresh ephemeral, and fresh cipher states. Replaying a recorded client
  flight fails (tested).
- **Nonces.** Upstream checks `assertValue()` *before* each encrypt or decrypt and throws above 2³²−1. The 32-bit
  write wraps only after that check, so a nonce is never reused. `FRAME_CEILING = 2³¹` adds margin, and the lag from
  frames still queued for encryption (at most about 64 per 4 MiB) is irrelevant against it.
- **Handshake extensions** are rejected (M6 killed), muxer negotiation is skipped, and non-Ed25519 identities are
  rejected (M5 killed).
- **Early data and pinning.** No application byte is sent before the pin is verified, on either the PeerId path or the
  fingerprint path. The fingerprint path reveals the client key to an impostor, as documented.
- **Fingerprint.** Domain-separated SHA-256 over the canonical multihash, 125 bits, known-answer vector checked, and
  normalisation (0/1/8 map outside the alphabet) is injective.
- **Transport robustness.** Truncation, bit flips, reordering, duplication and drops of transport frames all fail
  closed (tests, M10 killed). A relay that splits the stream into 1-byte chunks, or coalesces message 3 with the first
  data frame, is transparent (`poc-misc.ts` (b1), (b2)).
- **Bounds.**
  - The record header is checked before buffering (M11 killed).
  - The WebSocket message cap works (M17 killed); browsers allocate a relay-sized message before we see it, which
    bounds memory to what the relay forwards.
  - The Noise decoder's 16 MiB limit only ever holds a partial frame.
  - The raw and secured read buffers are bounded by `receiveHighWaterBytes + 1 MiB`.
- **Backpressure.** The upstream `onDrain` bug is real: `abstract-message-stream.js:66,87-90` resolves
  `onDrainPromise` and never clears it. The `waitForDrain` workaround listens for each `drain` or `close` event,
  cannot miss a wakeup (drain is always dispatched asynchronously), and is exercised by the slow-consumer tests. It
  does not hold on RN (M-2).
- **No key logging.** Upstream key dumps require `DUMP_SESSION_KEYS` *and* an enabled logger. Every logger passed is
  silent (`enabled: false`), so setting the environment variable cannot leak keys. Error messages contain public
  identifiers only (see I-8).
- **Identity from outside Noise.** Nothing is trusted from outside Noise. `remotePeerId` is re-encoded canonically
  from the verified payload key, and tickets, `sub`, `chn` and relay metadata are not consulted. The relay cannot
  downgrade (one fixed protocol name and prologue, no negotiation), splice two sessions (end-to-end transcript), replay
  a handshake (fresh responder ephemeral), or enroll anyone. Apart from L-1 and M-3's regression risk, it learns only
  sizes and timing (I-6).
- **Key storage.** `FileKeyStore` enforces 0600 and 0700, `O_EXCL|O_NOFOLLOW`, fsync plus directory fsync, and
  rejects symlinks, wrong owners and loose modes (M16 killed). WebCrypto identities are non-extractable and
  `serializeIdentity` refuses them.
- **Randomness sources.** Identities: Node CSPRNG on Node; WebCrypto or noble `getRandomValues` in browsers; noble on
  Hermes. Ephemerals: noble `getRandomValues` (pure-JS) or OpenSSL (`nodeNoiseCrypto`). All fail closed when
  `crypto.getRandomValues` is missing (M12, M18 killed); see L-2 for weak sources.

## Test adequacy (mutation results)

Baseline 47/47. Full log: `~/.cache/wb-tmp/sc-review-poc/mutate.log`.

| Mutation | Result |
|---|---|
| M1 drop upstream in-handshake pin (`remotePeer`) | killed |
| M2 drop both PeerId pin checks | killed |
| M3 drop the post-handshake PeerId string compare only | survived (redundant with M1's check; fine) |
| M4 drop fingerprint pin | killed |
| M5 accept non-Ed25519 | killed |
| M6 accept handshake extensions | killed |
| M7 disable rekey policy | killed |
| M8 drop FRAME_CEILING | killed |
| M9 stop counting sent frames | killed |
| M10 end-without-CLOSE treated as clean | killed |
| M11 drop inbound record length check | killed |
| M12 no `assertSecureRandom` before handshake | killed |
| M13 prologue ignored | killed |
| M14 no handshake timeout | killed |
| M15 unknown record types ignored | **survived** (add a test: an authenticated peer sending record type 0x02 → `PROTOCOL_ERROR`) |
| M16 key file mode check off | killed |
| M17 WebSocket size cap off | killed |
| M18 zero-RNG check off | killed |
| U1 upstream: no identity-signature verification | **survived** → M-3 |
| U2 upstream: no pinned-key comparison | killed |
| U3 upstream: nonce not incremented on encrypt | killed |
| U4 upstream: prologue not hashed | killed |

Other test gaps:
- "tampered handshake message C" accepts `TRANSPORT_ERROR` as well as `HANDSHAKE_FAILED`.
- The FRAME_CEILING test sets the counter directly (acceptable).
- There is no test for `secureByteStream` failure semantics (M-1), an RN-shaped socket (M-2), small-order keys (L-1),
  non-zero weak RNGs (L-2), or fast-close races (L-3).

## ADR corrections (SC-03/SC-05/SC-06/SC-08)

- SC-03 "Authenticated close … never as a clean end": false for `secureByteStream` until M-1 is fixed.
- SC-03 "Only Ed25519 identities are accepted": add "excluding small-order keys" once L-1 is fixed.
- SC-03 "Randomness … fails closed … if … returns zeros": state the limit (L-2).
- SC-03/SC-05 RN step 4 (`webSocketByteStream(new WebSocket(url))`): does not work as-is (M-2).
- SC-01/SC-02: `nodeNoiseCrypto` includes `@chainsafe/as-chacha20poly1305@0.1.0` (unaudited) for messages under
  1200 bytes (L-7).
- SC-03 "cuts writes into records … each authenticated on its own": records may be coalesced and split across Noise
  frames by `AbstractMessageStream` when writes queue. Harmless, because a record is delivered only when all its bytes
  are authenticated, but the wording should say so.

## PoC index

Setup, once:

```
cd ~/Code/whombat-contracts && git worktree add --detach ~/.cache/wb-tmp/sc-review secure-channel
cd ~/.cache/wb-tmp/sc-review && TMPDIR=~/.cache/wb-tmp pnpm install --frozen-lockfile
```

`~/.cache/wb-tmp/sc-review-poc/` contains `package.json` (`"type": "module"`), `common.ts`, and a `node_modules`
symlink to `../sc-review/packages/secure-channel/node_modules`. Run every script from that directory with
`TMPDIR=~/.cache/wb-tmp ../sc-review/node_modules/.bin/tsx <file>`.

| Finding | File | Result on this host |
|---|---|---|
| M-1 | `poc-bytestream-silent-truncation.ts` | CONFIRMED |
| M-2 | `poc-rn-bufferedamount.ts` | CONFIRMED (both ends `HANDSHAKE_TIMEOUT`) |
| M-3 | `poc-impersonation-bad-signature.ts` | correct rejection with the real dependency; breach reported when U1 is applied |
| L-1 | `poc-small-order-identity.ts` | CONFIRMED |
| L-2 | `poc-weak-rng.ts` | CONFIRMED |
| L-3, I-2, I-3, I-4, I-1 | `poc-misc.ts` ((f), (a), (b1), (b2), (c), (d), (e)) | CONFIRMED |
| L-4 | `bash poc-keystore-race-procs.sh 15` (uses `keystore-worker.ts`); in-process `poc-keystore-race.ts` | 4/15 diverged or failed; in-process 0/50 |
| L-5 | `poc-rsa-preauth-cpu.ts` | 160× verify cost |
| L-6 | `poc-frame-decoder-quadratic.ts` | ~3400× decode cost at 1-byte pieces |
| test adequacy | `python3 mutate.py` (edits and restores the scratch copy; breaks pnpm-store hard links before touching upstream files) | table above |

Environment: Linux 6.12, Node 24.18.0 (OpenSSL 3.5.7), pnpm 12.3.4, Vitest 5.0.1.

---

## Re-review (2026-09-25): branch `secure-channel-fixes` at `6ac0e1e` (contracts 0.5.1 candidate, on main `c2be837`)

### Verdict

**Ready to release in 0.5.1.**

Every finding from the first review is resolved, or documented where that was the agreed outcome. Every PoC that
demonstrated a problem now shows the fix. The new flow-control record held up against every adversarial case I tried.

The new findings are low or informational. Two of them are best folded into 0.5.1:
- **N-1**: bump the protocol identifier for the wire change. Doing it later would be a second wire break.
- **N-2**: add regression tests for the WINDOW record's validation. My PoC cases can be used as-is.

### Method

- Scratch worktrees (both detached at `6ac0e1e`): `~/.cache/wb-tmp/sc-rereview` for PoCs and experiments,
  `~/.cache/wb-tmp/sc-mut` for mutation runs.
- The author's worktree `.worktrees/secure-channel` was not touched.
- The upstream `utils.js` and `protocol.js` are byte-identical to the author's install.
- Package suite: 87/87. `@whombat/protocol`: 38/38. Typecheck passes.
- `test:browser` on the host: 9 passed, 4 skipped (Chromium and Firefox; WebKit cannot launch here).
- Not run by me: Docker/WebKit, Hermes, the Android emulator (the ADR reports it was run), `pnpm check` at the root.
- Re-ran every original PoC against the fixed code, from copies in `~/.cache/wb-tmp/sc-review-poc/rereview/`.
  They are identical except that they point at `sc-rereview`.
- Wrote new PoCs:
  - `poc-flow-control.ts`: a malicious authenticated peer writes raw records inside Noise; a relay drops a
    WINDOW-bearing frame; a 0.3.0-era peer is run from the first review's scratch copy.
  - `poc-nodecrypto-short.ts`.
- Ran the author's mutation gate (`SC_MUT_ROOT=~/.cache/wb-tmp/sc-mut python3 spikes/secure-channel/mutate.py`),
  plus 10 extra mutations on the new code (`mutate-extra.py`). Logs: `author-mutate.log`, `mutate-extra.log`.

Run any PoC with `cd ~/.cache/wb-tmp/sc-review-poc/rereview && TMPDIR=~/.cache/wb-tmp ../../sc-rereview/node_modules/.bin/tsx <file>`.
The key-store race runs with `bash poc-keystore-race-procs.sh 20`.

### Per-finding verdicts

| Finding | Verdict | Evidence (this re-review) |
|---|---|---|
| M-1 truncation behind an authenticated close | **resolved** | PoC: `writer.close()` rejects `REKEY_REQUIRED`, and the reader gets `TRANSPORT_ERROR`, not a clean EOF. Mutations F2 and F3 killed. |
| M-2 React Native adapter deadlock | **resolved** (in simulation; the on-device run is reported by the ADR, not verified by me) | PoC with an RN-shaped socket connects in 43 ms (was `HANDSHAKE_TIMEOUT`). F6 killed. Sender memory on RN is bounded by the credit window (see "Flow control" below). |
| M-3 signature verification and substitute peer untested | **resolved** | U1 is now killed, as are U1+S1 and S1. My impersonation PoC: client `PEER_MISMATCH`, appliance `HANDSHAKE_FAILED`. |
| L-1 small-order identities | **resolved** | PoC: refused ("non-canonical or of small order"). S2 killed. Weak pinned PeerIds are refused too (my X7 killed). |
| L-2 weak random self-test | **resolved** within the stated limit | PoC: the constant source is now refused (`NO_SECURE_RANDOM`). A seeded PRNG still passes, as documented. M18 killed. |
| L-3 close races | **resolved**; test gap N-4 | PoC `poc-misc.ts` (f): the fast send-and-close client now delivers all 3 messages (was `TRANSPORT_ERROR`, 0 delivered). (a) and (b1) now end cleanly instead of `CLOSED "write after close"`. F5 killed. |
| L-4 `FileKeyStore` race | **resolved** | Multi-process PoC: 0/20 trials diverged or failed (was 4/15). F7 killed. The new `get` checks the opened descriptor, uses `O_NONBLOCK`, and caps the size. |
| L-5 pre-auth CPU from foreign key types | **resolved** | PoC: the big-exponent RSA handshake now costs 5.2 ms against 5.5 ms for an honest one (was 7.6 against 4.1): refused before upstream parses the key. S3 killed. The base pre-auth cost rose by about 2 ms; see N-6. |
| L-6 `FrameDecoder` O(n²) | **resolved** | PoC: 1-byte pieces take 5 ms (was 353 ms). End to end, decoder CPU is 17 ms for 1.5 MiB (was 343 ms). |
| L-7 `as-chacha20poly1305` in `nodeNoiseCrypto` | **resolved** | `src/node/crypto.ts` uses OpenSSL for every AEAD size. New check: ciphertexts shorter than the tag are refused in both `Uint8Array` and `Uint8ArrayList` form (`poc-nodecrypto-short.ts`). |
| L-8 consumers don't inherit the pins | **resolved on this side**; adoption pending | `PINNED_DEPENDENCIES`, `verifyInstalledDependencies()` and the `pnpm.overrides` snippet exist. Not exercised in a consuming repo; `whombat-app` and the appliance runtime still have to adopt them. |
| I-1 seed/public mismatch | resolved | PoC (d): refused. X6 killed. |
| I-2 CID-form pin | resolved | PoC (c): the correct appliance connects with a CID-form pin. |
| I-3 zero-length frames | documented (upstream) | PoC (a): still accepted, harmless. |
| I-4 `null` after a local close | documented | The `receive()` doc now says so. |
| I-5 receive direction unbounded | resolved; untested | `RECEIVE_FRAME_CEILING` is in place, but no test kills its removal (X4). |
| I-6 sizes visible to the relay | accepted and documented | — |
| I-7 extractable WebCrypto key | resolved | X8 killed. |
| I-8 remote close reason in errors | resolved | Sanitised to 64 printable ASCII characters. |
| Review M15 survivor (unknown record types) | resolved | M15 killed. |

### Identity pre-check vs the library

`instrumentCrypto` runs `checkHandshakePayload` on the second handshake AEAD decryption. In XX, on both sides, the
first handshake decryption is the peer's static key and the second is its payload. Message 1's payload is never
decrypted, because there is no key yet. The check therefore runs before upstream parses or verifies anything:

- Initiator: inside `readMessageB`, before `writeMessageC`, so no client byte reaches an impostor.
- Responder: inside `readMessageC`.

It accepts only a canonical subset:
- exactly fields 1, 2 and optionally an empty 4, no repeats, wire types 0 and 2 only, varints capped at 32 bits;
- a key type of Ed25519 with exactly 32 bytes of data;
- a canonical, non-small-order point (`Point.fromBytes(pk, false)`);
- the pin compared by raw key;
- a strict RFC 8032 verification (`zip215: false`) over `"noise-libp2p-static-key:" ‖ rs`.

Upstream's own check still runs afterwards, so the two are an AND. The post-handshake checks (type, pin by key,
`guard.decrypts === 2`, extensions) are a third layer.

I found no input that the guard accepts and `protons` decodes differently: every field the guard accepts decodes the
same way. See N-3 for binding the two results together.

### Flow-control record (WINDOW, `0x02`)

`channel.ts` implements it with:
- a 256 KiB implicit initial window;
- a grant of the rest of `receiveWindowBytes` (256 KiB..64 MiB, default 1 MiB) at establishment;
- re-grants of consumed cost in quarter-window steps;
- a cost of payload + 64 bytes per DATA record.

Results (PoC `poc-flow-control.ts`, all as expected):

| Case | Result |
|---|---|
| Increment 0, increment 2³²−1, 3-byte WINDOW payload | receiver fails `PROTOCOL_ERROR` |
| Credit overflow: grants beyond 64 MiB outstanding | the grant that crosses 64 MiB fails `PROTOCOL_ERROR`; the one before is accepted. The outstanding values are JS numbers far below 2⁵³ (the rekey byte limit is 2⁴⁰), so there is no integer overflow. |
| DATA beyond the window (the peer ignores credit) | `PROTOCOL_ERROR` ("peer exceeded the flow-control window"), checked on the record header before the body is buffered. The victim accepted 1,020,000 B of the attacker's 2.4 MB (window 1 MiB). |
| Zero credit, when the peer never reads | sends that were handed over: 1016 KiB (≤ window); 54 sends wait for credit; 10 got `BUFFER_OVERFLOW` (queue ≤ 4 MiB); `close()` completes and rejects the 54 waiting sends with `CLOSED`. |
| Credit on a closed connection | grants are suppressed after a local or remote close or a write failure. A WINDOW record in the same buffer after CLOSE is "data after close record"; after the end it is ignored. |
| Relay drops the Noise frame carrying a WINDOW grant | a relay cannot drop a single *record*: records sit inside AEAD frames with sequential nonces. Dropping a frame surfaces at the next frame in that direction as `DECRYPT_FAILED` (seen after 260 KB of a 1 MB upload), and the other side sees a transport error. If the dropped frame was the last one in that direction, the sender simply stalls, which is the same power as a relay that stops forwarding (see N-5). A relay cannot inject, reorder or forge credit. |
| Deadlock analysis | WINDOW and CLOSE records need no credit, and the receiver never pauses the transport (it reads and decrypts continuously, bounded by the window), so a grant is never stuck behind flow control. Once the application has consumed everything, the sender has at least ¾ of the window (≥ 192 KiB) available, above the largest record cost (65,578 B), so credit alone cannot deadlock. What remains is the application-level case where both sides send and neither reads, as with TCP. |
| Mixed versions (0.3.0 client against the fixed appliance) | the handshake succeeds (same prologue), then the old side fails with `PROTOCOL_ERROR: unknown record type 2` → N-1 |

### Close and EOF ordering

`ByteStreamMessageStream` counts the u16-framed handshake messages it reads. If the transport ends before the
handshake is complete, the end is delivered at once and the handshake fails promptly. Otherwise the end is held until
the `Connection` has attached its listeners (`releaseEof`, called synchronously in the constructor). It is then
delivered only after the read buffer has drained (`scheduleEof`), so the bytes that `lpStream.unwrap()` hands back
from a timer cannot be overtaken.

A peer's authenticated CLOSE ends the connection at once. After establishment, a transport write failure no longer
aborts the read side (`onWriteError`). A connection that may have lost DATA never ends cleanly (`dataLost` → F8
killed).

Bounds: the hold lasts at most until the handshake timeout, and the polling stops once the stream is no longer
`open`. I found no way to make the hold keep a stream alive beyond those.

### The six surviving mutations

I reproduced the author's gate exactly: 36 of 42 killed, and the same six survivors.

- **M1, M3, U2** (pin comparison layers), **M5** (post-handshake key-type check), **M6** (post-handshake extension
  check): acceptable. Each is one layer of a check that has at least two layers, and every combination that removes
  all of them is killed (M2, M1+S4, M3+S4, U2+S4, M5+S3, M6+S6).
- **F4** (EOF not held during the handshake): acceptable for the Node suite, but its only real guard is missing. I
  applied F4 and ran PoC (f) three times: all messages were delivered. On Node the handshake's verification is
  synchronous (OpenSSL and noble), so a `setTimeout`-scheduled end can never overtake it. The hold matters where
  verification is really asynchronous: WebCrypto in browsers (`@libp2p/crypto` uses `subtle.verify`). See N-4.

### New findings

| ID | Severity | Finding | Confirmed |
|---|---|---|---|
| N-1 | low | Wire change without a protocol-identifier change | PoC |
| N-2 | low | Input validation of the new WINDOW record is untested | mutation |
| N-3 | info | The guard's identity key is not bound to the key upstream reports | code reading |
| N-4 | info | The EOF-hold wiring (F4) is untested where it matters | mutation + PoC |
| N-5 | info | The channel has no stall timeout for credit | PoC |
| N-6 | info | The pre-auth handshake now does two Ed25519 verifications | measured by the author; code reading |

**N-1 (low): wire change without a protocol-identifier change.**
Where: `channel.ts:49` (`RECORD_WINDOW = 0x02`) and `DEFAULT_PROLOGUE` (`channel.ts:37`), still
`whombat-secure-session/1`.

Scenario:
- A 0.3.x peer and a 0.5.1 peer complete the handshake. The old side then fails with a generic
  `PROTOCOL_ERROR: unknown record type 2`, and the new side with `TRANSPORT_ERROR`.
- With the default 1 MiB window this happens immediately after the handshake, because of the initial grant. With
  `receiveWindowBytes = 256 KiB` it happens later, after the first re-grant.
- It is fail-closed, but the error does not say "version mismatch". The session protocol's `hello` version
  negotiation never gets a chance to run. The ADR mentions a `whombat-app` build (639d537) with the old-wire
  workaround, so mixed versions exist on dev.

PoC `poc-flow-control.ts` case 8.

Fix: bump the prologue to `whombat-secure-session/2` (or add a version byte to it), so a mismatch fails in the
handshake with a deterministic `HANDSHAKE_FAILED`, and name the pairing in the release notes. Do it in 0.5.1: changing
it later is another wire break.

**N-2 (low): input validation of the new WINDOW record is untested.**
The package suite survives these mutations of my extra run:
- X1: increment validation removed.
- X2: 64 MiB cap removed.
- X3: WINDOW length check removed.

The same run also shows gaps outside the WINDOW record:
- X4: the receive frame ceiling (I-5).
- X9: the guard's static-key length check. Upstream's `readS` always yields 32 bytes, so it is unreachable today.
- X10: the key-file size cap.

The validation itself works (my PoC cases 1–4), but a regression would pass CI. Impact if it regressed: X1 and X2 only
let a malicious peer raise *our* send credit, which harms that peer's own receiver. X3 would desynchronise record
parsing on data from an authenticated peer. Low impact in each case, but this is the validation of a new wire element.

Fix: add cases 1–4 of `poc-flow-control.ts` to `flow.test.ts` and X1–X3 to `spikes/secure-channel/mutate.py`. For X4,
set the counter directly, as the FRAME_CEILING test does.

**N-3 (info): the guard's identity key is not bound to the key upstream reports.**
`checkHandshakePayload` returns the key it validated, but `instrumentCrypto` discards it (`channel.ts`, the
`guard.decrypts === 2` branch). `remotePeerId` and `remotePublicKey` come from upstream's own protobuf parse. The
strictness guarantees (canonical, not small-order, strict signature) therefore hold for the reported identity only as
long as the two parsers agree. I found no divergence: the guard accepts a strict canonical subset.

Fix: store the returned key in `guard` and require `equals(result.remotePeer.publicKey.raw)` after the handshake. One
line; it makes the property independent of `protons`.

**N-4 (info): the EOF-hold wiring (F4) is untested where it matters.**
See "The six surviving mutations". Add a browser test (Chromium/Firefox/WebKit, where WebCrypto verification is
asynchronous) in which the appliance sends a message and closes immediately after the handshake. The client must
receive the message and `null`, not `TRUNCATED`.

**N-5 (info): the channel has no stall timeout for credit.**
A peer that never grants, or a relay that withholds or drops the last frame, leaves `send()` pending indefinitely.
Memory stays bounded (window + `maxQueuedSendBytes`, 4 MiB by default). The relay's idle timeout may be kept alive by
its own 20 s pings. The session layer (MA-08 deadlines, keepalive or request timeouts) must own stall detection.
Document that `send()` may never settle while the peer withholds credit.

**N-6 (info): the pre-auth handshake now does two Ed25519 verifications.**
Our strict pure-JS verification runs in addition to upstream's: about +2 ms per handshake on the responder,
according to the ADR's benchmark. Any holder of a relay ticket can trigger it. The SC-08 rate-limit guidance (per
ticket and subject, at the relay and the appliance) must actually be implemented in MA-05/06.

### Re-review PoC index (`~/.cache/wb-tmp/sc-review-poc/rereview/`)

| File | Result on `6ac0e1e` |
|---|---|
| `poc-bytestream-silent-truncation.ts` | NOT CONFIRMED: fixed (M-1) |
| `poc-rn-bufferedamount.ts` | NOT CONFIRMED: fixed (M-2) |
| `poc-impersonation-bad-signature.ts` | both rejections CONFIRMED (M-3) |
| `poc-small-order-identity.ts` | NOT CONFIRMED: fixed (L-1) |
| `poc-weak-rng.ts` | the constant source now throws `NO_SECURE_RANDOM` (L-2) |
| `poc-misc.ts` | (f), (c) and (d) fixed; (a) documented; (b1), (b2) still transparent; (e) documented |
| `bash poc-keystore-race-procs.sh 20` | 0/20 diverged or failed (L-4) |
| `poc-rsa-preauth-cpu.ts` | RSA handshake no costlier than an honest one (L-5). The "verify cost" line still measures the library function directly. |
| `poc-frame-decoder-quadratic.ts` | linear (L-6) |
| `poc-nodecrypto-short.ts` | short ciphertexts refused (L-7) |
| `poc-flow-control.ts` (output `flow.out`) | all 8 cases as described above |
| `mutate-extra.py` (log `mutate-extra.log`) | X1–X4, X9, X10 survive; X5–X8 killed |
| author's gate (log `author-mutate.log`) | 36/42 killed, survivors M1, M3, M5, M6, F4, U2 |
