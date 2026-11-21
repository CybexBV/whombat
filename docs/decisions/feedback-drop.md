# Feedback on a managed Whombat: the encrypted drop (workstream `feedback-drop`)

Status: **built** (`apps/server/src/feedback/drop/`); designed 2026-09-27. John chose the shape; this document makes it concrete against the
code of the six repositories and records the decisions `FD-nn`. It builds on Whombat Feedback (`feedback.md`, FB-01 …)
and the managed appliance (`appliance/docs/implementation/architecture.md`, MA-01 … MA-25). Contracts
**0.13.0**, on top of 0.12.2 (CT-90, images in messages).

**Problem.** On a managed appliance the runtime listens on loopback only, behind the relay (MR-04); `/embed/*` answers
404 and `feedback.setIntake {enabled: true}` is refused (MR-05, MR-13), because the only other way in, a cloud
endpoint receiving reports, would be plaintext customer content in cloud ingress (R-38, PV-11). The Feedback tab still
shows a snippet pointing at `http://127.0.0.1:4721/embed/v1/widget.js`.

**Shape.** The widget is served from the hosted UI origin, the same bytes for every customer. The visitor's browser
encrypts the whole report to a key of the appliance, whose authenticity the snippet pins. Whombat's cloud (control)
keeps only ciphertext until the appliance collects it, and deletes it on acknowledgement. The runtime decrypts it and
files it through the existing intake pipeline. Self-hosted Whombat keeps its direct widget unchanged.

```
 website page (customer.example)                          hosted UI origin (dev.whombat.com / app.whombat.com)
 ┌──────────────────────────────────────┐                 static: /embed/v1/widget.js, frame.html, assets/*
 │ <script src="{app}/embed/v1/widget.js"│
 │   data-site="fbs_…" data-key="fbk_…"> │── iframe ──▶ frame.html (drop mode)
 └──────────────────────────────────────┘                 │ 1 GET  {control}/v1/feedback/sites/fbs_…/card
                                                           │   verify Ed25519 sig, sha256(signingKey) = data-key
                                                           │ 2 seal report: HPKE(X25519, HKDF-SHA256, AES-128-GCM)
                                                           │ 3 POST {control}/v1/feedback/sites/fbs_…/drops (ciphertext)
                                                           ▼
 control — Postgres: feedback_sites (public cards), feedback_drops (opaque envelopes, TTL 7 d)
            ▲ device-signed ops: feedback.cards.sync / feedback.drops.pull / feedback.drops.ack
            │
 appliance: whombat-manager (proxy, never decrypts) ◀─ unix socket ─ runtime (managed): signs cards, holds the
            private keys, pulls, decrypts, files through the FB pipeline, acks → control deletes
 the relay: unchanged
```

## Supersedes

- `managed-providers.md` PV-11 and the audit bullet **“Whombat Feedback intake … disabled (`managed.feedback_intake`)
  … customer-side option … documented as the only acceptable shape”**: superseded for Feedback by this document. The
  argument for R-38 is FD-03 (not plaintext, not quiet).
- `managed-runtime.md` **MR-13**, the sentence “Feedback's public widget and intake are not registered and
  `feedback.setIntake {enabled: true}` is refused”, and **MR-05**'s `feedback.setIntake` input guard: intake is allowed
  on a managed appliance and runs through the drop (FD-25). The appliance still registers no public route: MR-04's
  404 for `/embed` stays.
- the appliance's **MA-10**'s clause “Feedback public intake disabled unless a documented customer-side design is
  enabled”: replaced by a new **MA-26** that names this design (work list, appliance).
- the appliance's **R-38** evidence column: “Feedback intake disabled” becomes the drop, with FD-03 as the argument.
- `feedback.md` **FB-04, FB-05** (same-origin requests, `frame-ancestors` per parent) hold for the self-hosted direct
  widget only; drop mode enforces origins as FD-28 says.

## Threat model and what the cloud sees

| # | Decision | Why |
|---|---|---|
| FD-01 | **Trust boundaries are the threat model's** (appliance `threat-model.md`): control and relay are untrusted for content (T1, T2); the hosted frontend publishing is a trusted supplier (boundary 5). So control must never be able to read a report **or substitute the key reports are encrypted to**, even with full write access to its database; the frame's code, served by the hosted frontend, is trusted like the hosted UI itself. A compromised hosted frontend can read reports, exactly as it can read everything a signed-in person decrypts (listed out of scope of E2EE there). | The drop must not create a new place that can read content; it must not claim more than the rest of the managed product does. |
| FD-02 | **What the cloud learns (metadata), accepted and documented**, and nothing else: (a) the public site card of each site (FD-10): allowed website origins, the widget's labels and appearance, contact-field and screenshot settings, `redactPaths` and `contextKeys`, limits, public keys, and which device and org publish it; (b) per drop: site, arrival time, padded size (FD-14), the key id, the `Origin` header (the hosted UI origin for the real widget), and the visitor's network as a keyed hash in rate-limit buckets (CL-37: never the address, never in logs); (c) when the appliance collects and acknowledges. Control never sees text, contact details, context, screenshots, the embedding page's origin as the frame saw it, the submission id or the reference. The visitor's address reaches control's TLS endpoint (unavoidable) and is not stored. | T13 already accepts timing/size/association metadata; this is the same class. Being explicit lets the privacy page say it. |
| FD-03 | **R-38 compliance argument.** (1) *Not plaintext:* the report is sealed in the visitor's browser before it leaves; control stores and forwards opaque bytes. (2) *Key authenticity does not rest on the cloud:* the card that carries the encryption key is signed by an appliance key whose fingerprint is in the snippet the owner copied from their own authenticated session (FD-07); control can withhold or delay cards and drops (availability), not redirect reports to another key. This is MA-24's rule (“the directory is never a source of the pin”) applied to Feedback. (3) *Not quiet:* intake is switched on by a burrow owner per integration; the owner's policy line and the integration's health say that encrypted reports wait in Whombat's cloud until this Whombat collects them (FD-25). | R-38: “no quiet plaintext cloud ingress”. |

## Where things live

| # | Decision | Why |
|---|---|---|
| FD-04 | **Site cards live in control** (control): published by the appliance with a device-signed op (`feedback.cards.sync`, FD-20) and served publicly (`GET /v1/feedback/sites/:site/card`, FD-17). Not the relay. | The relay is by design stateless, database-free and per-worker (RL-15: route tables in memory, workers chosen by control's rendezvous hashing, CL-08); a public card needs a durable, shared store. Control already has Postgres, the device directory, device-signed requests, hosted-UI CORS (CL-11) and network-hashed limits (CL-12, CL-37). |
| FD-05 | **The drop lives in control** too: `POST /v1/feedback/sites/:site/drops`, stored in control's Postgres with a TTL (FD-18, FD-19). | Store-and-forward needs durability across restarts and across workers; a relay worker holding reports in memory would lose them on restart or drain and would need control to route POSTs to the appliance's worker anyway. Postgres `bytea` is enough at our scale (open risk R-4). |
| FD-06 | **Delivery: the runtime pulls through the manager**; no relay change. The runtime calls three new manager socket paths (FD-21); the manager signs the matching device ops with the management key and returns control's answer verbatim. After the runtime has committed (or definitively refused) a drop it acknowledges it and control deletes it. Cadence is control's (`nextPullS`, FD-20). | This is how the runtime already reaches control (push: runtime → manager socket → `push.send`, MR-13/MR-16): the manager holds the management key, the runtime holds content keys, and neither needs a new channel. Control has no channel to relay workers, so “a new relay message type” would need one. Pulling adds no inbound path (T9) and naturally resumes after an outage. |

## Keys

| # | Decision | Why |
|---|---|---|
| FD-07 | **Site signing key and the snippet pin.** Each managed runtime has one **feedback signing key** (Ed25519, 32-byte seed) for all its sites. The snippet carries its fingerprint: `data-key="fbk_<22>"` = `fbk_` + base64url (no padding) of the first 16 bytes of `sha256(signingPublicKey)`. The frame verifies every card against it and refuses anything else (FD-28). The key is **not rotated automatically**: changing it changes every snippet. A new key is only made when the runtime has none (first intake switched on). | Without a pin, whoever can write control's card table can swap the encryption key (FD-01). The content identity would be the obvious signer, but a replacement appliance gets a new one (BK-07), which would break every customer website after a replacement; the signing key is an application secret that the backup restores (below). |
| FD-08 | **Encryption keys.** X25519 key pairs, `kid` = `fdk_` + base64url of the first 12 bytes of `sha256(publicKey)` (16 characters). One is current; a new one replaces it every **30 days** (at the hourly card check) and cards are re-issued with it. A retired private key is kept **22 days** after its successor became current (card lifetime 14 d + drop TTL 7 d + 1 d), then deleted, so every drop control can still deliver decrypts. | Bounded exposure of a leaked key without breaking reports in flight. |
| FD-09 | **Storage.** Runtime table `feedback_drop_keys (kid pk, kind: signing\|encryption, public_key, private_sealed, created_at, current_since, retired_at, delete_after)`; private halves sealed with `KeyCustody.seal` under `WHOMBAT_MASTER_KEY`, AAD `feedback_drop_key:<kid>` (the connector-token pattern, `connectors/crypto.ts`). Keys are appliance infrastructure written by the drop module directly (like the managed trust tables), not burrow commands; their creation and rotation are logged at info without key material. They are in the database, so backups carry them sealed and the master key restores them (BK-07 already backs up `/persist/secrets`): a restored replacement keeps its snippets working and can still open drops that waited during the swap. Two live appliances with the same keys (a restore while the old one runs) could both decrypt; control delivers a site's drops only to the device that holds its card (FD-12), and the replacement procedure retires the old device. | One secret-at-rest pattern in the runtime; replacement without editing websites. |

## Site card

| # | Decision | Why |
|---|---|---|
| FD-10 | **Card content** (`FeedbackSiteCard`, below): `purpose`, `v: 1`, `site`, `seq`, `issuedAt`, `expiresAt`, `allowedOrigins`, `config` (exactly today's `FeedbackPublicConfig`, built by the same `publicConfigOf`), `limits` (what control enforces for this site), `encryption {suite, kid, publicKey}`, `signingKey`. Signed as `{card, sig}` where `sig` = Ed25519 (strict verification, no ZIP-215 leniency, CT-15) over the UTF-8 bytes of `canonicalJson(card)` (`@whombat/core` `audit/canonical.ts`, the device-request pattern: `purpose` inside the signed object is the domain separation). At most 16 KiB. **No `intake` flag: a card exists only while intake is enabled**; switching intake off withdraws it (FB-19's “unknown to the public”). | The frame needs exactly what `GET /embed/v1/sites/:site/config` gives it today plus the key; one builder keeps self-hosted and managed widgets identical. |
| FD-11 | **Lifecycle: full-set sync.** The runtime sends **all** of its current cards in one `feedback.cards.sync` (0–200 cards); control upserts them and withdraws this device's cards that are not in the set. Triggers: boot (after the claim), every feedback config event (`feedback.integration_created`, `_updated`, `feedback.intake_changed`), key rotation, and the hourly check, which re-issues when any card has less than 7 of its 14 days left. Failures retry with backoff (1 min → 1 h) and show in health (FD-26). `seq` is a per-runtime counter (`feedback_drop_state.card_seq`), increasing with every issued card; control refuses a card whose `seq` is not greater than the stored one (`stale_seq`). | A full set is self-healing (a lost update is repaired by the next sync) and makes withdrawal a non-event. `seq` stops a replayed older sync from rolling back a card. |
| FD-12 | **Control's site binding.** `feedback_sites.site_id` is bound, **permanently**, to the fingerprint of the first signing key that published it. A card for a bound site is accepted only with that key and from a device of the **same org**; then the publishing device becomes the site's device (a replacement taking over). Otherwise `site_bound_elsewhere`. Control verifies each card's signature with the card's own `signingKey`, and checks `site` format, `expiresAt − issuedAt ≤ 14 d`, `expiresAt` in the future and the size. A withdrawn card keeps the binding row (no card, no device). Retiring a device withdraws its cards. | The frame's pin already prevents substitution; the binding prevents another org's device from squatting a site id it read from a public page (DoS). |

## Envelope and crypto

| # | Decision | Why |
|---|---|---|
| FD-13 | **HPKE, RFC 9180, base mode, single shot**, suite `hpke-base-x25519-sha256-aes128gcm`: KEM `DHKEM(X25519, HKDF-SHA256)` (0x0020), KDF `HKDF-SHA256` (0x0001), AEAD `AES-128-GCM` (0x0001); `info` = UTF-8 `whombat-feedback-drop/1`; `aad` = the envelope header bytes; one `Seal` (sequence 0) per envelope. Built from `@noble/curves` (x25519) and `@noble/hashes` (sha256, HKDF extract/expand for `LabeledExtract`/`LabeledExpand`), both already dependencies of `@whombat/core`, with AES-GCM from the standard WebCrypto `crypto.subtle` (browsers in secure contexts, Node 24): no new dependency. Pinned by RFC 9180 Appendix A.1 (the exact suite, base mode: key schedule values and the sequence-0 encryption) plus our own vectors. The relay/session crypto (libp2p Noise XX) is interactive and doesn't fit a one-way message to an offline recipient. | A standard construction with published vectors, composed from the libraries the contracts already trust, the way CPace was (CT-59). X25519 and Ed25519 come from noble rather than WebCrypto, whose curve support is still missing in older browsers. |
| FD-14 | **Envelope format v1** (binary, `application/octet-stream`): `u16be H` ‖ `header` (H bytes, 16 ≤ H ≤ 512, UTF-8 canonical JSON `{kid, site, suite, v: 1}`, nothing else) ‖ `enc` (32 bytes) ‖ `ct` (AEAD output, tag included). Plaintext = `u32be L` ‖ `L` bytes of UTF-8 JSON (`FeedbackDropPlaintext`) ‖ zero padding to `padLength(4 + L)`: up to 4 KiB → 4 KiB; up to 64 KiB → next multiple of 16 KiB; above → next multiple of 256 KiB. The runtime requires the padding to be all zero. | The header is readable by control for cheap checks and bound to the ciphertext as AAD, so a drop can't be moved to another site or key. Padding hides whether and roughly how large screenshots are. Binary avoids a second base64 over the screenshots' base64. |
| FD-15 | **Plaintext** `FeedbackDropPlaintext {v: 1, submission, frame}`: `submission` is exactly today's `FeedbackSubmission` (strict; `parentOrigin` inside); `frame = {bridgeOrigin, ancestorOrigins, widget, cardSeq}` where `bridgeOrigin` is the `event.origin` of the first valid loader message the frame accepted, `ancestorOrigins` the frame's `location.ancestorOrigins` as an array (null where the browser has none), `widget` the widget version, `cardSeq` the card it sealed with. Nothing else: FB-07's limits stand (no console, network, storage, DOM or replay); anything a later widget adds to `FeedbackSubmission` is automatically inside the envelope. | The runtime runs the same schema and checks as for a direct submission, plus the origin evidence only the frame has. |
| FD-16 | **Reference.** In drop mode the frame shows the reference before the appliance has seen the report, so it is derived: `feedbackReferenceFor(site, submissionId)` = `FB-XXXX-XXXX` from the first 8 bytes of `sha256("whombat-feedback-reference/1\0" ‖ site ‖ "\0" ‖ submissionId)` with `newFeedbackReference`'s alphabet mapping (40 bits). The runtime files the report under the same reference (`receiveFeedbackReport` gains an optional `reference`); if it is already taken by a different report, the runtime gives a random one and logs it (the visitor's number then finds nothing, which FB-11 already allows). The receipt copy stays “Thanks — we’ve received your report.”: Whombat did receive it. | Same submission, same number, with no lookup and no round trip to the appliance. |

## Drop API (control, public)

| # | Decision | Why |
|---|---|---|
| FD-17 | **Endpoints** (`@whombat/control-contracts` `feedbackDropApi`), public, never authenticated, `credentials: 'omit'` from the frame: `GET /v1/feedback/sites/:site/card` → 200 `SignedFeedbackSiteCard` (`Cache-Control: public, max-age=60`) or 404; `POST /v1/feedback/sites/:site/drops` (body: the envelope) → **202** `{receivedAt}` for a new drop, **200** `{receivedAt}` (the first one's) for the identical bytes again. Errors reuse `FeedbackPublicError` with fixed messages: **400** `invalid` (no or non-numeric `Content-Length`, chunked body, header unparsable, `v` or `suite` unknown, `header.site` ≠ path), **404** `unavailable` (unknown site, no card, card expired, `Origin` missing or not a hosted UI origin), **413** `too_large` (`Content-Length` > the card's `maxEnvelopeBytes` or the hard cap), **429** `rate_limited` + `retryAfter` and `Retry-After` (any limit or queue cap), **500** `internal`. CORS: `Access-Control-Allow-Origin` only for control's configured hosted UI origins (the frame runs there), `Allow-Methods: GET, POST`, `Allow-Headers: content-type`, `Max-Age: 600`, never `Allow-Credentials`; preflight 204. Control records the request's `Origin` with the drop. | One narrow public surface with the widget's existing error vocabulary, so the frame maps statuses as it does today. |
| FD-18 | **Limits, in this order, before the body is read:** route → `Origin` → card lookup (cached 15 s) → `Content-Length` (≤ card `maxEnvelopeBytes` = `dropEnvelopeCap(bodyCapOf(settings))`, hard cap `FEEDBACK_DROP_MAX_ENVELOPE_BYTES` = `dropEnvelopeCap(FEEDBACK_MAX_BODY_BYTES)` ≈ 32.3 MiB) → fixed-window counters in Postgres (CL-12, keyed network hash): per network per site `perSourcePerHour`, per network across sites 60/h, per site `reportsPerHour` and `reportsPerDay` (from the card), per control instance 600/min → queue caps: per site 200 pending drops or 256 MiB, per device 1,000 or 1 GiB → body read with a deadline (30 s + 1 s per 256 KiB) → header checks → insert. Card GETs: 600/h per network. | Abuse costs control nothing expensive, and the appliance's own limits apply before anything is stored (the runtime can't answer 429 to a visitor after the fact). |
| FD-19 | **Storage and deletion.** `feedback_drops (id 'fdr_'+22, site_id, device_id, received_at, expires_at = received_at + 7 d, bytes, sha256, origin, envelope bytea, lease_until, attempts)`, unique `(site_id, sha256)` for the dedup of FD-17. Deleted: on ack; at expiry by the retention sweep, which adds the count to `feedback_drop_expired (device_id, site_id, count)` for the next pull to report; when the device is retired. A withdrawn card stops new drops but leaves pending ones to be delivered (they were accepted while intake was open). Nothing else about a drop is kept; the envelope is never logged; request logs keep the route pattern only (CL-37). | Minimal retention, and an owner learns that reports expired instead of silently losing them. |

## Delivery (device ops, manager paths)

| # | Decision | Why |
|---|---|---|
| FD-20 | **Device ops** (`DEVICE_OPS`, device-signed, CL-05): `feedback.cards.sync {seq, cards: SignedFeedbackSiteCard[0..200]}` → `{accepted: site[], refused: [{site, code: bad_signature\|site_bound_elsewhere\|stale_seq\|expired\|too_large\|bad_card}]}`; `feedback.drops.pull {max: 1..20, maxBytes: 1 MiB..48 MiB}` → `{drops: FeedbackDrop[], pending, expired: [{site, count}], nextPullS: 2..3600}` with `FeedbackDrop {dropId, site, receivedAt, origin, bytes, envelope (base64url)}`; returned drops are leased 120 s (a pull never returns a leased drop; at least one drop even if it alone exceeds `maxBytes`; `expired` counts are reset once reported); `feedback.drops.ack {dropIds: 1..100}` → `{ok}` (unknown ids are ignored: idempotent). `nextPullS` is 2 while `pending > 0`, else `FEEDBACK_PULL_S` (default 30). Pulls count against the device's 120/min. An unclaimed device gets `device_unclaimed`. | Small, idempotent ops; control steers load. |
| FD-21 | **Manager socket paths** (`@whombat/control-contracts/local` `MANAGER_PATHS`, runtime only): `POST /v1/runtime/feedback/cards`, `/v1/runtime/feedback/pull`, `/v1/runtime/feedback/ack`, bodies and answers exactly the device ops'. The manager forwards and never parses cards or envelopes beyond the schema; answers up to 64 MiB for `pull` (1 MiB for the others; its control client's 1 MiB `LimitReader` gets a per-op limit), 503 `unavailable` while control is unreachable, 501 `unsupported` when control answers the op as unknown. The runtime's `ManagerSocketClient` allows 64 MiB for `pull` (64 KiB elsewhere, MR-16) and treats 404 (an older manager) like 501. | The manager stays a signer and a proxy; it holds no content key. |
| FD-22 | **Runtime pull loop** (`feedback/drop/worker.ts`): runs while the runtime has a published card or the last pull said `pending > 0`; waits `nextPullS`; pauses while the gate is paused (quarantine, MR-20) or draining; pulls `max: 10, maxBytes: 16 MiB`; files drops **one at a time**; acks in a batch after each drop's outcome is durable. A transient failure (database, image worker timeout) leaves the drop unacknowledged (the lease expires, it comes back); after 5 attempts it is refused as `internal`. | Serial filing is the runtime's rate limit; a crash between commit and ack is harmless (FD-23's replay). |

## Filing in the runtime

| # | Decision | Why |
|---|---|---|
| FD-23 | **One filing path.** `public.ts`'s `submit` splits into the HTTP part and `fileSubmission(services, row, submission, source)` (`feedback/file.ts`): normalize, decode screenshots, payload hash, idempotency (`receiptFor`), daily cap, image worker, `receiveFeedbackReport`. The direct route calls it with `{via: 'direct'}` after its HTTP checks; the drop worker with `{via: 'drop', dropId, reference}` after: kid known (else `unknown_key`) → open (else `undecryptable`) → header `site` = drop `site` and padding zero (else `malformed`) → integration of that site exists in a burrow of this runtime (else `unknown_site`) → drop `origin` = the origin of `WHOMBAT_APP_URL` (else `origin`) → the existing `scanJsonShape`, `checkStructure`, `wellFormed`, strict `FeedbackSubmission` (else `invalid`) → `parentOrigin` in the integration's **current** allowed origins, `frame.bridgeOrigin` = `parentOrigin`, `frame.ancestorOrigins` null or its first entry = `parentOrigin` (else `origin`) → report type offered (else `invalid`). The in-memory token buckets and intake slots (FB-12, FB-F03) are not used for drops (control enforced the card's limits, filing is serial); the durable `reportsPerDay` check remains the backstop (`daily_cap`). Same submission again → `duplicate` (acked, nothing new); same id with different content → `conflict`. The signed `feedback.report_received` payload gains `via` and `dropId`. | Everything a direct report must pass, a dropped one passes too, by the same code. |
| FD-24 | **Outcomes are kept 8 days** in `feedback_drop_outcomes (drop_id pk, integration_id null, outcome, code, attempts, at)`: filed, duplicate, or refused with a code; a redelivered drop whose outcome is final is acked without work. No content is kept for a refused drop. | Exact counts for the owner and no repeated work. |

## Managed product changes

| # | Decision | Why |
|---|---|---|
| FD-25 | **Policy.** In managed mode `WHOMBAT_FEEDBACK=on` (the default) means drop mode: `/embed` stays unregistered (MR-04), the dispatcher's `feedback.setIntake` guard goes, integrations can be created and switched on, and `appliance.status.policy.feedbackIntake` is available with the reason “Visitors’ reports are encrypted in their browser to this Whombat. Whombat’s cloud keeps them, unreadable, until this Whombat collects them.” When the manager or control doesn't support the drop (FD-21's 501/404), the item is unavailable with “Feedback needs an update of this Whombat’s cloud connection.” and `setIntake {enabled: true}` is refused with `managed.feedback_intake` as today. `WHOMBAT_FEEDBACK=off` withdraws all cards and stops pulling (the assessment worker keeps running, FB-01). | An owner turns it on knowingly (FD-03), and an appliance that can't deliver never pretends it can. |
| FD-26 | **Snippets and health in managed mode.** The snippet base is the origin of `WHOMBAT_APP_URL` and the tag gains `data-key` (`basicSnippet`/`customLauncherSnippet` take an optional `siteKey`; `WIDGET_ATTRIBUTES.key = 'data-key'`); `cspAdvice` stays `script-src {app}; frame-src {app};` (the frame, not the page, talks to control). The key (FD-07) is created when the first integration is created, so the snippet is complete from the start. `FeedbackIntegrationHealth.publicUrl` is the app origin; `public_url_missing` is never raised in managed mode. Health gains `delivery: {mode: 'drop', publishedAt, lastCollectedAt, notFiled7d, expired7d} \| null` (null = direct) and the warnings `drop_not_published` (“Whombat’s cloud doesn’t have this site yet, so visitors can’t send reports. This Whombat keeps trying.”), `drop_unsupported` (the FD-25 text), `drop_not_filed` (“N reports from the last 7 days couldn’t be filed.”) and `drop_expired` (“N reports waited 7 days in Whombat’s cloud and were deleted before this Whombat collected them.”). The web app's `IntegrationDetail.tsx` shows the delivery line under health; texts come from the server. | The owner copies a snippet that works and sees whether reports flow. |

## Widget (whombat-app)

| # | Decision | Why |
|---|---|---|
| FD-27 | **One widget, two modes.** The loader reads `data-key` (`^fbk_[A-Za-z0-9_-]{22}$`; anything else is ignored) and adds `key=` to the frame URL; the frame is in **drop mode** when `key` is present, otherwise in today's direct mode. On the hosted origin a keyless snippet therefore asks `/embed/v1/sites/…/config` of a static host, gets 404 and shows “unavailable”: it fails closed. The loader bundle grows by one attribute (8 KB budget kept). | Self-hosted keeps its bytes and behaviour; one build to test. |
| FD-28 | **Drop mode in the frame** (`frame/drop.ts`, `frame/images.ts`; `bridge.ts`, `app.ts`, `index.ts` changed). (1) Fetch the card from `{control}/v1/feedback/sites/:site/card` (`credentials: 'omit'`, `redirect: 'error'`, `referrerPolicy: 'no-referrer'`); verify `sig`, `sha256(signingKey)` against `key`, `card.site` = `site`, `v` and `suite` known; any failure is the existing unavailable page. Card times are not checked against the visitor's clock (control and the runtime enforce expiry; a stale card can't redirect a report, FD-01). (2) `parent` must be in `card.allowedOrigins`, and `location.ancestorOrigins[0]` (where it exists) must equal it, before anything renders. (3) **Send stays disabled until a valid loader message arrived** from `window.parent` with `event.origin` = `parent` (the bridge already checks origin, source and instance, FB-06); its origin is `bridgeOrigin`. This is the browser-enforced check of the direct parent that `frame-ancestors` gave the direct widget, since a static host can't send a per-site header. (4) Validate what only the runtime could refuse later: the text limits (already), screenshots' magic bytes against their declared type, size, and PNG IHDR / JPEG SOF dimensions (≤ 8192 a side, ≤ 16 MP). (5) Build the `FeedbackSubmission` as today, seal it **once per draft** and resend the identical envelope bytes on every retry (FB-B09's rule, applied to ciphertext); an edit after an unanswered attempt makes a new `submissionId` and a new envelope (both may be filed; the visitor changed it). (6) POST to `/drops`; 202/200 → the receipt with the derived reference (FD-16); 404 → unavailable, 413 → too large, 429 → rate limited, else the server/network messages as today. (7) The frame never reads or writes cookies, `localStorage`, `sessionStorage` or IndexedDB (a unit test fails the build on any use). *(7) superseded in part (2026-09-30, John's request): one `localStorage` key, `whombat-feedback:<site>`, holds the reporter session ([`feedback-reporters.md`](feedback-reporters.md)); everything else stays banned.* | The widget can only promise what it has checked, and a retry never becomes a second report. |
| FD-29 | **Hosted serving.** The widget build takes `--hosted --control-url <url>` and additionally emits a static `v1/frame.html` (the same markup the server's `embed.ts` renders for an allowed parent, referencing the hashed assets, with `<meta name="whombat-control" content="{control origin}">` and a meta CSP). The hosted web build copies `dist/v1/` to `dist-hosted/embed/v1/` and writes an `/embed/v1/*` block into `_headers` that detaches the app's headers (`! Content-Security-Policy`, `! X-Frame-Options`) and sets `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src {control}; form-action 'none'; base-uri 'none'; frame-ancestors *`, `Cross-Origin-Resource-Policy: cross-origin`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`; `widget.js` and `frame.html` `max-age=300`, hashed assets immutable (FB-26). The app shell keeps `frame-ancestors 'none'` and `Cross-Origin-Opener-Policy: same-origin`. | Same bytes for every customer; only the frame document is framable. |
| FD-30 | *(Superseded by FD-31.)* **Same origin as the hosted app, accepted with guards.** The frame runs on the origin whose first-party storage holds endpoint keys. Guards: browsers partition a third-party iframe's storage and service workers by top-level site; the app's `COOP: same-origin` severs any popup the frame opens from its opener; the frame's own CSP forbids everything but its assets and control; FD-28 (7) keeps the frame off storage; the frame sets visitor and card text only as DOM text (FB-03's plain DOM, no `innerHTML`). Moving the widget to its own origin later is only a snippet base, a CORS origin and a hosting entry (see the question at the end). | John's choice for now; the residual risk is written down (R-1). |
| FD-31 | **The widget has its own origin** (orchestrator, 2026-09-27; answers the question at the end, supersedes FD-30). The widget's files (`widget.js`, `frame.html`, hashed assets) are served from a dedicated **embed origin** that serves nothing else, never the hosted app: `embed.whombat.com` for the dev instance (one level under whombat.com, IN-32; the harness serves it from its own static server port, tunnel route added by John), a production equivalent later. The runtime learns it as `WHOMBAT_EMBED_URL` (managed mode; unset → the origin of `WHOMBAT_APP_URL`, FD-30's fallback, so an appliance without the setting still works) and uses it as the snippet base (FD-26); control's drop and card endpoints allow CORS from the embed origin (`CONTROL_EMBED_ORIGINS`, plus the hosted UI origin while the fallback is in use). The whombat-app widget build emits the embed tree as its own artifact (`dist-embed/embed/v1/…` with its `_headers`), not inside the hosted app's tree. `data-key` (FD-07) is accepted as the one addition to the snippet. | The frame's origin then holds no endpoint keys at all: even a script injection in the frame, or the frame opened top-level, reaches nothing of the app. Costs one hostname and one static server. |


## Contract details settled in whombat-contracts 0.13.0 (CT-91 … CT-96)

Where the rows above were incomplete or didn't fit the code, contracts decided as follows; these rows win over the
ones they amend.

| # | Decision | Why |
|---|---|---|
| FD-32 | **`feedback.cards.sync` may be up to 4 MiB** (`FEEDBACK_CARDS_SYNC_MAX_BYTES`, `deviceRequestMaxBytes(op)`, Go `DeviceRequestMaxBytesFor`); every other device request keeps the 64 KiB limit. The manager accepts the same 4 MiB on `POST /v1/runtime/feedback/cards` (64 KiB for pull and ack), and control's device route needs a body limit that allows it for this op. | 200 cards of up to 16 KiB (FD-11, FD-10) can't fit `DEVICE_REQUEST_MAX_BYTES` (64 KiB), which FD-20/FD-21 didn't account for. |
| FD-33 | **Pull `maxBytes` is 1 … 47 MiB** (amends FD-20's 48). `FEEDBACK_PULL_RESPONSE_MAX_BYTES` = 64 MiB is what the manager's control client and the runtime's socket client allow for a pull answer (FD-21); 1 MiB for the other feedback answers. | 48 MiB of envelopes in base64url is exactly 64 MiB before the JSON around them; 47 MiB leaves room, and one drop of the hard cap (FD-36) is ~43 MiB encoded. |
| FD-34 | **Card refusals** are `{index, site \| null, code, seq?}`: `index` is the card's position in the sync (a `bad_card` may have no readable site), and for `stale_seq` control sends the `seq` it holds for the site; the runtime then raises `card_seq` above it and re-issues. The sync's own `seq` is the runtime's counter (≥ every card's, a fresh value for an empty set); control applies a sync only when it is above the last sync it applied **for this device**, otherwise it changes nothing and refuses every card `stale_seq`. | A restored replacement (FD-09, FD-12) comes back with the backup's counter, which can be behind the seq the old device last published; without the stored seq it would be refused until the counter caught up. Per-device sync ordering keeps a reordered older set from withdrawing cards. |
| FD-35 | **The card is opaque in the device API** (`FeedbackCardWire {card: object, sig}`; Go `json.RawMessage`). Control parses every card with `SignedFeedbackSiteCard` and `verifySiteCard` before storing it. | A card carries the owner's free text (labels, paths, privacy URL), which the cross-language subset can't describe and CT-10 keeps out of device bodies; this is the one published exception (FD-02 already lists it). Go's canonical JSON over non-ASCII card text is tested to sign identically. |
| FD-36 | **Envelope cap with room for the wrapper:** `dropEnvelopeCap(bodyCap) = 562 + padLength(4 + bodyCap + 4096)` (562 = length prefix, the longest header, `enc`, tag; 4096 = `FEEDBACK_DROP_WRAPPER_BYTES` for `{v, submission, frame}` around the submission), so `FEEDBACK_DROP_MAX_ENVELOPE_BYTES` = 33,817,138. `FeedbackDropFrame` is bounded to fit: `bridgeOrigin` ≤ 255, `ancestorOrigins` ≤ 8 entries (or null), `widget` `^[0-9A-Za-z.+-]{1,32}$`. The runtime compares the plaintext's length with `bodyCapOf(settings) + 4096`. | The plaintext is a little larger than the submission body the integration's cap is computed for; without the allowance a maximal report would be refused by its own card. |
| FD-37 | **Snippet and health inputs** (amends FD-26 after FD-31): `SnippetInput.embedUrl` (`WHOMBAT_EMBED_URL`, else the app origin) is the snippet base, `siteKey` adds `data-key`, `cspAdvice` takes the same input; `FeedbackIntegrationHealth.publicUrl` is that embed base on a managed Whombat. `delivery` defaults to null, so the hosted app reads an older runtime's health. The warning texts are `FEEDBACK_DROP_TEXT`, `feedbackDropNotFiledText(n)` and `feedbackDropExpiredText(n)` in `@whombat/core` (“1 report … couldn’t be filed.”, “1 report waited 7 days … and was deleted before this Whombat collected it.” for one). | One source for the copy the runtime sends; FD-26's “N reports” reads wrong for one. |
| FD-38 | **Unsupported, precisely:** an older control rejects the unknown op name as 400 `bad_envelope` (its op enum doesn't have it); a control with `FEEDBACK_DROP=off` answers 404 with the new reason `feedback_drop_off`. For the three feedback paths the manager maps both to 501 `unsupported`; other control refusals stay 502 `control_refused` as for push. | FD-21 assumed control “answers the op as unknown”; this is what that looks like on the wire. |
| FD-39 | **Crypto API shape:** `sealDropEnvelope`/`openDropEnvelope` are async (WebCrypto AES-GCM) and throw `HpkeError` `unsupported` without `crypto.subtle`; `openDropEnvelope(envelope, privateKeyFor, {site})` throws `FeedbackDropError` with exactly the runtime's codes `malformed`, `unknown_key`, `undecryptable` in FD-23's order (the site and padding checks come after decryption), and `sealDropEnvelope` throws `too_large` above the card's `maxEnvelopeBytes` (the frame shows “too large” without a request). `verifySiteCard(signed, key, {site, now})` checks the card's shape, size (of the signed `{card, sig}`), pin, site, strict signature and, only with `now`, expiry; it checks `config` only to be an object, so the frame keeps its own config checker. `FeedbackDropRefusalCode` adds `too_large` and `unsupported_attachment` to FD-23's list (the shared filing path can give them). | What the frame, control and the runtime each call, with no second copy of any check. |

## Wire formats (summary)

Site card, as `GET {control}/v1/feedback/sites/:site/card` returns it (`sig` over `canonicalJson(card)`):

```json
{
  "card": {
    "purpose": "whombat-feedback-site-card",
    "v": 1,
    "site": "fbs_Q3v9x…(24)",
    "seq": 17,
    "issuedAt": 1790467200,
    "expiresAt": 1791676800,
    "allowedOrigins": ["https://billing.cybex.example"],
    "config": { "productLabel": "Cybex", "reportTypes": ["bug", "feature"], "theme": "auto",
                "position": "bottom-right", "launcher": "floating", "launcherLabel": "Feedback",
                "privacyUrl": null, "contactFields": { "name": "optional", "email": "optional" },
                "attachments": { "max": 3, "maxBytes": 3145728, "types": ["image/png", "image/jpeg"] },
                "text": { "description": 5000, "expected": 3000, "steps": 3000 },
                "redactPaths": [], "contextKeys": [] },
    "limits": { "maxEnvelopeBytes": 13107200, "reportsPerHour": 30, "reportsPerDay": 200, "perSourcePerHour": 5 },
    "encryption": { "suite": "hpke-base-x25519-sha256-aes128gcm", "kid": "fdk_…(16)", "publicKey": "<b64url, 32 bytes>" },
    "signingKey": "<b64url, 32 bytes>"
  },
  "sig": "<b64url, 64 bytes>"
}
```

Snippet (managed):

```html
<script
  src="https://app.whombat.com/embed/v1/widget.js"
  data-site="fbs_…"
  data-key="fbk_…"
  data-theme="auto"
  data-position="bottom-right"
  defer
></script>
```

Envelope (`POST {control}/v1/feedback/sites/:site/drops`, `Content-Type: application/octet-stream`):

```
u16be H | header[H] = {"kid":"fdk_…","site":"fbs_…","suite":"hpke-base-x25519-sha256-aes128gcm","v":1}
        | enc[32]   = HPKE encapsulated key (X25519 public)
        | ct        = HPKE Seal(info "whombat-feedback-drop/1", aad = header, pt), 16-byte tag included
pt      = u32be L | JSON[L] FeedbackDropPlaintext | 0x00 padding to padLength(4 + L)
FeedbackDropPlaintext = {"v":1,"submission":FeedbackSubmission,
                         "frame":{"bridgeOrigin":"https://…","ancestorOrigins":["https://…"]|null,"widget":"1.1.0","cardSeq":17}}
```

Drop answers: `202 {"receivedAt":"2026-09-27T10:15:02.114Z"}` (new), `200` (the same bytes again), errors
`{"error":{"code":"unavailable|invalid|too_large|rate_limited|internal","message":"…","retryAfter"?:n}}`.

Delivery (device ops, the manager's socket paths carry the same bodies):

```
feedback.cards.sync  {seq, cards:[SignedFeedbackSiteCard]}         → {accepted:[site], refused:[{site, code}]}
feedback.drops.pull  {max, maxBytes}                                → {drops:[{dropId, site, receivedAt, origin, bytes, envelope}],
                                                                        pending, expired:[{site, count}], nextPullS}
feedback.drops.ack   {dropIds:[…]}                                  → {ok:true}
manager: POST /v1/runtime/feedback/cards | /v1/runtime/feedback/pull | /v1/runtime/feedback/ack
```

## Contracts 0.13.0 (whombat-contracts)

| Package | Additions |
|---|---|
| `@whombat/core` | New subpath **`@whombat/core/feedback/drop`** (pure, no Zod, `@noble/*` + WebCrypto only, so the frame can import it): `FEEDBACK_DROP_SUITE`, `FEEDBACK_DROP_INFO`, `hpkeSealBase`/`hpkeOpenBase` (+ `deriveKeyPair` for vectors), `sealDropEnvelope(card, plaintextJson, rand?)` → bytes, `openDropEnvelope(bytes, privateKeyFor)` → `{header, plaintextJson}`, `parseDropHeader`, `padLength`, `dropEnvelopeCap(bodyCap)`, `signSiteCard`, `verifySiteCard(signed, expectedKey?)`, `siteKeyFingerprint`, `dropKeyId`, `feedbackReferenceFor`. Zod in `domain/feedback.ts`: `FeedbackSiteKey` (`fbk_…`), `FeedbackDropKeyId`, `FeedbackSiteCard`, `SignedFeedbackSiteCard`, `FeedbackDropHeader`, `FeedbackDropPlaintext`, `FeedbackDropOutcome`. `contracts/feedback.ts`: `FeedbackIntegrationHealth.delivery`, the four warning codes (FD-26). `feedback/install.ts`: `WIDGET_ATTRIBUTES.key`, `SnippetInput.siteKey?`. |
| `@whombat/control-contracts` | `feedbackDropApi` (FD-17: paths, `FeedbackDropReceipt {receivedAt}`, reuse of `FeedbackPublicError`); `device/ops.ts`: `feedback.cards.sync`, `feedback.drops.pull`, `feedback.drops.ack` with `FeedbackDrop`, refusal codes; constants `FEEDBACK_DROP_TTL_S` (604800), `FEEDBACK_DROP_MAX_ENVELOPE_BYTES`, the queue caps, `FEEDBACK_CARD_MAX_BYTES` (16384), `FEEDBACK_CARD_MAX_LIFETIME_S` (1209600); `local`: the three `MANAGER_PATHS` and their request/response schemas. |
| `@whombat/protocol` | none (no session op changes: `feedback.*` api ops are already allowlisted). |
| Go module (`go/`) | generated: `device` types and constants for the three ops; `local` path constants and types (the manager needs them). No Go crypto: nothing in Go opens or verifies envelopes or cards. |
| Vectors | `vectors/feedback-drop.json`: RFC 9180 A.1 (base mode, suite 0x0020/0x0001/0x0001), our envelopes (fixed ephemeral key, each padding bucket), tampered header/site/kid/tag/padding cases that must fail, card signing (canonical bytes, signature, fingerprint; non-strict signatures refused), `feedbackReferenceFor` cases; schema vectors for the new device ops (Go `vectors_test.go` runs them). |

`CT-91` in `docs/decisions/contracts.md` records the release. Additive only: every existing schema accepts what it
did; old consumers ignore the new health field.

## Work list per repository (paths; rough size)

1. **whombat-contracts** (M, ~700 lines + vectors): `packages/core/src/feedback/drop.ts` (+ `drop.test.ts`), exports in
   `packages/core/package.json`; `packages/core/src/domain/feedback.ts`, `contracts/feedback.ts`, `feedback/install.ts`;
   `packages/control-contracts/src/device/ops.ts`, new `src/feedback.ts` (public drop API), `src/local/index.ts`;
   `conformance/src/gen-cross-language.ts` (vectors, Go gen), `vectors/feedback-drop.json`; `docs/decisions/contracts.md`
   CT-91; release 0.13.0.
2. **control** (M–L, ~900 lines + tests): `src/feedback/cards.ts` (sync, binding, GET), `src/feedback/drops.ts` (POST,
   limits, dedup, queue caps), `src/feedback/delivery.ts` (pull/lease/ack), `src/feedback/routes.ts` (public routes with
   their own body limit and CORS), device op table in `src/devices/device-api.ts`, retirement hook in
   `src/devices/admin.ts`, expiry sweep in `src/metadata/retention.ts`, schema + migration `src/db/migrations/0005_feedback_drop.sql`
   (`feedback_sites`, `feedback_drops`, `feedback_drop_expired`), config `FEEDBACK_DROP=on|off`, `FEEDBACK_PULL_S`;
   `docs/device-api.md` (ops), `docs/decisions/control.md` CL-47…; vendor contracts 0.13.0.
3. **Whombat runtime** (L, ~1,200 lines + tests): `apps/server/src/feedback/file.ts` (extracted from `public.ts`),
   `feedback/drop/{keys,cards,worker,index}.ts`, `feedback/intake.ts` (`reference`, `via`, `dropId`), `feedback/read.ts`
   (snippets, health, warnings), `feedback/integrations.ts` (create makes the signing key in managed mode; config events
   trigger sync), `db/schema/feedback.ts` + migration (`feedback_drop_keys`, `feedback_drop_state`,
   `feedback_drop_outcomes`), `managed/{ports,manager-client,testing,boot,dispatcher,policy,ops}.ts`, `config.ts`
   (`WHOMBAT_FEEDBACK` in managed mode); docs: this file, `managed-runtime.md` MR-67 (pointer + MR-05/MR-13
   supersession), `managed-providers.md` PV-11 note, `docs/feedback.md` (operator guide: managed section);
   vendor contracts 0.13.0.
4. **whombat-app** (M, ~700 lines + tests): `apps/widget/src/loader/loader.ts`, `src/shared/protocol.ts` (key pattern),
   `src/frame/{drop,images}.ts` (new), `src/frame/{bridge,app,index,submit}.ts`, `scripts/build.ts` (`--hosted`, static
   `frame.html`), `apps/widget/e2e/servers.ts` (a fake control with card + drop), `e2e/run.ts` (drop scenarios);
   `apps/web/hosted.ts` + `vite.config.ts` (copy widget, `/embed/v1/*` headers block); `apps/web/src/features/feedback/IntegrationDetail.tsx`
   (delivery line); `docs/decisions/app-managed.md` AP-97…; release (app 0.6.0).
5. **the appliance** (M, ~250 Go + ~600 TS): manager `internal/broker/broker.go` (three routes),
   `internal/controlapi/client.go` (ops, per-op response limit), `internal/controlapi/fakecontrol`, vendored Go 0.13.0
   + `vendorHash`, `docs/decisions/manager.md` MG-39; harness `src/dev/web-server.ts` (most specific `_headers` block,
   `!` detach, 404 for missing `/embed/*`) + test, `src/dev/services.ts` (runtime `WHOMBAT_FEEDBACK: 'on'`, control
   `FEEDBACK_DROP: 'on'`, `FEEDBACK_PULL_S: '5'`), `src/scenario-kit/feedback-site.ts`, `scenarios/o-feedback.scenario.ts`;
   docs: `architecture.md` MA-26, `requirements.md` R-38, `threat-model.md` T15, `integration.md` IN-52…,
   `runbooks/cutover.md` (production hosting of `/embed/v1/*`: the headers block, no access logs of bodies),
   `runbooks/dev-instance.md`; `manifest/candidates/0.13.0.json`.
6. **the relay**: no change.

## Order

1. Contracts 0.13.0 released (tag, tarballs, Go module).
2. In parallel, each vendoring 0.13.0: control, whombat-app, Whombat runtime, manager. The runtime is safe to land
   first: without manager/control support it reports `drop_unsupported` and keeps refusing intake (FD-25).
3. Deploy control (dev) and the hosted UI with `/embed/v1` (dev.whombat.com) **before** any appliance runs the new
   runtime, so the first snippet an owner copies already loads.
4. The appliance: harness, scenario o, candidate 0.13.0 with all pins; `harness/validate` with the scenarios; dev
   instance. Production (control, hosted UI, appliances) only when John asks.

## Migration and compatibility

- **Self-hosted Whombat:** unchanged. Its server serves the widget from its own origin; the widget without `data-key`
  runs in direct mode (FD-27). The new health field is null.
- **Old managed runtimes (≤ 0.12):** keep refusing intake; they never publish cards; nothing changes for them.
- **New runtime, old manager or old control:** `drop_unsupported`; intake refused with the explanation (FD-25).
- **Old hosted UI (no `/embed`):** the snippet's `widget.js` 404s and the website shows nothing; hence step 3 of the order.
- **Existing managed integrations:** created while intake was refused, so none of them is receiving reports; after the
  update their snippets show `data-key` and switching intake on publishes the card. **Legacy import:** imported
  integrations keep their site ids, but the snippet on the website pointed at the self-hosted server and has no key:
  the owner must paste the new snippet (the operator guide says so).
- **Versions:** envelope and card `v: 1`, suite by name. A future suite or version is added alongside: the card names the
  one the frame must use, the runtime opens every version it knows, control accepts only known header versions.
- **Key rotation:** a card served stale (≤ 14 d) plus the drop TTL (7 d) is covered by FD-08's 22-day retention.
- **Replacement appliance:** restores the keys (FD-09); its first sync takes over the org's sites (FD-12); drops that
  waited are delivered to it. The old device's retirement withdraws its cards.

## Tests

- **Contracts:** RFC 9180 A.1 vectors; seal/open round trips for each padding bucket; every tamper case fails; card
  sign/verify vectors incl. non-canonical JSON, wrong fingerprint, ZIP-215-only signatures; reference vectors; schemas;
  Go runs the new device-op schema vectors; `gen:check`.
- **Control (integration, real Postgres):** card sync (signature, `stale_seq`, `site_bound_elsewhere`, org takeover with
  the same key, withdrawal, retirement), public GET (404s, cache header, CORS), drop POST (Origin, CORS preflight, 400/404/
  413/429 paths, check order: a refused request never reads its body, dedup 200, queue caps), pull/lease/ack/expiry
  counts, TTL sweep; privacy: a drop of random bytes round-trips unchanged and nothing but the envelope column holds it;
  logs carry no address, site id in the path is logged only as the route pattern.
- **Runtime:** keys (creation, sealing, rotation at 30 d, deletion at 22 d, restore with the master key); cards (content
  equals `publicConfigOf`, signature, triggers on each config event, withdrawal on intake off, re-issue at 7 d left);
  worker with a fake manager: filed report identical to a direct one (report row, root message, screenshots, event with
  `via: drop`), every refusal code, duplicate and conflict, crash between commit and ack (redelivery acked without a
  second report), 5-attempt limit, quarantine pause, `drop_unsupported`; managed policy and dispatcher (setIntake now
  allowed, refused when unsupported); snippets and health in managed mode; all existing feedback tests unchanged
  (self-hosted direct path).
- **Widget/app:** unit tests for card verification (pin mismatch, bad signature, parent not allowed, ancestor mismatch
  → unavailable), Send disabled until the bridge message, identical bytes on retry, new id after an edit, image
  sniffing/dimensions, status mapping, the storage ban; `apps/widget/e2e` against a fake control (drop mode end to end,
  strict-CSP host page, disallowed origin); hosted build test: `/embed/v1/*` files, `frame.html` meta, `_headers` block.
- **Manager:** broker routes (runtime uid only), forwarding with signatures, per-op size limits, 503/501 mapping;
  fakecontrol.
- **Harness scenario `o-feedback`** (contracts ≥ 0.13.0), over the real hosted web server, control, manager, runtime
  (the relay only for the owner's session): the owner creates a burrow, channel and integration (allowed origin: a
  loopback test site from `scenario-kit/feedback-site.ts` serving a strict-CSP page with the integration's snippet) and
  switches intake on; the card appears at control and verifies against the snippet's `data-key`; Playwright opens the
  test site, sends a bug report with a canary string in the description and a PNG; the report is filed in the channel
  with the derived reference and the screenshot. **Ciphertext assertion:** with the runtime stopped, a second report is
  sent; control's `feedback_drops` row exists and its envelope contains neither the canary (UTF-8, UTF-16, base64 at
  every offset) nor the screenshot's bytes, sha256 or base64, and its header is exactly `{kid, site, suite, v}`; no file
  under `env/logs/` contains the canary; the runtime is started, the report is filed and the row is gone. Negatives:
  the frame on a second, disallowed origin shows “unavailable” and sends nothing; a POST with another `Origin` is 404;
  intake off withdraws the card (GET 404, POST 404).

## Open risks

- **R-1** *(Largely removed by FD-31.)* The frame runs on its own embed origin, which holds no endpoint keys. What
  remains: an appliance without `WHOMBAT_EMBED_URL` falls back to the hosted app's origin (FD-30's guards apply to it)
  until every appliance has the setting and control's `FEEDBACK_DROP_UI_ORIGINS` is switched off (FD-40).
- **R-2** A compromised hosted frontend reads reports (FD-01), as it can read everything a signed-in person sees.
- **R-3** The visitor is told “received” before the appliance filed the report: it can still be refused (daily cap,
  undecodable image) or expire after 7 days offline. Mitigated by FD-18, FD-28 (4) and FD-26's warnings; not
  eliminated.
- **R-4** Control holds up to ~32 MiB envelopes in Postgres (`bytea`) with caps of 256 MiB per site and 1 GiB per device;
  at fleet scale this belongs in object storage (the API doesn't change).
- **R-5** Polling: up to `FEEDBACK_PULL_S` (30 s) until a report appears, and one signed request per appliance with open
  sites every 30 s. A doorbell over the relay would need a control → relay channel; not built.
- **R-6** A flood from many networks can fill a site's queue until the appliance drains it, delaying real reports (429
  for visitors meanwhile).
- **R-7** Browsers without `location.ancestorOrigins` (Firefox) check the direct parent only: an allowed site framed by
  another site could still host a working widget, as with `frame-ancestors` on the direct widget, which checks every
  ancestor.
- **R-8** Signing-key compromise has no rotation path besides a new key and new snippets (not built).
- **R-9** The frame bundle grows by noble's x25519/ed25519/sha256 (~25 KB minified); the loader doesn't.

## Question for John

- **Separate embed origin?** The design serves the frame from the hosted UI origin, as chosen, with FD-30's guards. A
  dedicated origin (for example `embed.whombat.com`, and a one-level name for the dev instance's tunnel) would remove
  R-1 at the cost of one more hostname and hosting entry; nothing else in the design changes. Keep the hosted origin, or
  add the embed origin now?
- The snippet gains **`data-key`** (FD-07): the one change to the snippet you described, needed so that control can't
  swap the encryption key. It changes only when the appliance's signing key does, which only happens deliberately.

## Control details settled in control's repository (FD-40 … FD-45)

Where control (control `feedback-drop`, CL-47 … CL-52) had to decide what the rows above leave open. These rows win
over the ones they amend.

| # | Decision | Why |
|---|---|---|
| FD-40 | **Control's settings.** `FEEDBACK_DROP=on\|off`, unset: **on in local and dev, off in prod**; `FEEDBACK_PULL_S` (default 30, 2 … 3,600); `CONTROL_EMBED_ORIGINS` (comma-separated exact origins, https outside local); `FEEDBACK_DROP_UI_ORIGINS` (default `true`): also allow control's `UI_ORIGINS` for CORS and the `Origin` check, the fallback of FD-31 for appliances without `WHOMBAT_EMBED_URL`; set it `false` once every appliance has the embed URL. | Production opens a new public ingress only by decision; control can't tell which appliances use the fallback, so it is a switch rather than a guess. |
| FD-41 | **Card sync edge cases** (amends FD-11, FD-12, FD-34). The identical card (same seq, same canonical bytes) sent again is **accepted**, not `stale_seq`: a full set re-sends unchanged cards, and a restored replacement re-sending the backup's identical card takes the site over. Same seq with other content is `stale_seq`. A whole sync not above the device's last one refuses every card `stale_seq` with `seq` = max(the site's stored seq, that last sync seq). A second card for one site in the same sync is `bad_card`. Only sites the set doesn't name are withdrawn; a named site whose new card was refused keeps its stored card. The org a site is bound to is the publishing device's org at the first publication. | Without the first rule every trigger that re-sends unchanged cards would loop through `stale_seq` and re-issue; the rest makes refusals never withdraw a working card. |
| FD-42 | **Withdrawal beyond retirement** (amends FD-12, FD-19). An operator **release** of a device (ownership transfer) withdraws its cards and deletes its waiting drops like retirement; retention withdraws cards past `expiresAt`; a takeover (FD-12) moves the site's waiting drops to the new device, so queue caps and pulls follow the site's current device. | The old org's reports must never reach a device's next owner; drops belong to whoever now holds the site's keys. |
| FD-43 | **Public route answers** (amends FD-17, FD-18). A malformed site id is 404 `unavailable`; with `FEEDBACK_DROP=off` both routes are 404 `unavailable`; `Content-Length: 0` is 400; a body that is short, longer than announced, aborted or slower than its deadline is 400 `invalid`; a full queue is 429 with `Retry-After: 60`. A refusal before the body is answered with `Connection: close` (the body is never drained). The card cache (15 s) also caches misses, and the insert re-checks the site row, so a withdrawal takes effect at once. The per-instance 600/min limit is in memory. CORS exposes no headers: `retryAfter` is in the JSON body. | Each edge gets exactly one of the widget's existing answers. |
| FD-44 | **Operator view** (FD named none): `GET /v1/operator/feedback` (`fleet.read`) returns counts only (sites bound/published, waiting and leased drops, bytes, the oldest drop's age, unreported expiries, last pull); the retention run reports `feedback_drops_expired` and `feedback_cards_expired`. | Operators need to see a queue filling up (R-4, R-6) without seeing sites or content. |
| FD-45 | **A device request above its op's body limit** answers `400 validation_failed`, `too_large` (the contract's own size check), not the web framework's 413; `feedback.cards.sync` has its own route with 4 MiB + 64 KiB, every other op 64 KiB. | The contracts' vectors (`other op above 64 KiB`) expect the reason. |

## Widget and hosted app details settled in whombat-app (FD-46 … FD-48)

| # | Decision | Why |
|---|---|---|
| FD-46 | **The embed tree** (whombat-app AP-107, amends FD-29 after FD-31): `pnpm build:embed` in whombat-app (control's URL from `--control-url`, `WHOMBAT_CONTROL_URL` or `VITE_WHOMBAT_CONTROL_URL`, required) writes `apps/widget/dist-embed/` = `_headers` + `embed/v1/{widget.js, frame.html, manifest.json, assets/frame.<hash>.{js,css}}`. `_headers` has a `/*` block (FD-29's CSP with `connect-src {control}` and `frame-ancestors *`, CORP cross-origin, `Referrer-Policy: no-referrer`, nosniff, Permissions-Policy, HSTS; no `X-Frame-Options`) and three `Cache-Control` blocks (`/embed/v1/widget.js`, `/embed/v1/frame.html`: 300 s; `/embed/v1/assets/*`: immutable). A host serving it applies **every block that matches** a path and answers 404 for anything that isn't a file (no index, no SPA fallback). Built per deployment from the pinned checkout, like the hosted UI; not in `release:dist`. | The embed origin serves nothing else (FD-31), so the whole policy fits one block; the harness's static server needs to know the block semantics. |
| FD-47 | **Frame details** (whombat-app AP-106, amends FD-28): the frame learns control's origin only from `frame.html`'s `<meta name="whombat-control">` (the self-hosted server's `frame.html` has none, so a keyed snippet there fails closed); a 400 from the drop shows the server message (not a form error: the visitor can't fix an envelope); an edit after an attempt takes a new `submissionId`; `ancestorOrigins` is sealed as at most 8 entries; `frame.widget` is `1.1.0`. | What FD-28 left open. |
| FD-48 | **How the hosted app reads availability** (whombat-app AP-105): an integration's INSTALL shows snippets on a managed Whombat when its health has a non-null `delivery` and no `drop_unsupported` warning; otherwise the old notice (AP-102) and an intake switch that can be turned off but not on. The app doesn't read `appliance.status.policy.feedbackIntake` for this. So a managed runtime ≥ 0.13 must send a non-null `delivery` for every integration and report FD-25/FD-38's unsupported state as `drop_unsupported`. | One per-integration signal, and an older runtime (no `delivery`) keeps the notice. |

## Runtime details settled in Whombat (FD-49 … FD-56)

Where the Whombat runtime (branch `feedback-drop`, `apps/server/src/feedback/drop/`, MR-67) had to decide what the rows
above leave open. These rows win over the ones they amend.

| # | Decision | Why |
|---|---|---|
| FD-49 | **Every sync re-issues every card** (amends FD-11): fresh `seq` values from `feedback_drop_state.card_seq`, `issuedAt` now, 14 days of life; the sync's `seq` is the last card's (a fresh value for an empty set). A `stale_seq` answer raises the counter above the largest `seq` control named and sends the set again, at most 3 times per sync. The hourly check syncs when a site that takes reports has no accepted card or less than 7 days left, when a withdrawn site still has a row, or when the encryption key is due. | Nothing has to remember the bytes last sent (FD-41's identical-card rule is then never needed by this runtime), and every sync is above the last one by construction. |
| FD-50 | **The drop's `Origin` must be the embed origin** (amends FD-23 after FD-31): the origin of `WHOMBAT_EMBED_URL`, else of `WHOMBAT_APP_URL`, exactly one; anything else is refused `origin`. | FD-23 was written when the frame ran on the hosted app's origin. |
| FD-51 | **A drop accepted while intake was on is filed after intake went off** (FD-19): `feedback.receive_report` skips its intake check for `via: drop` only; a direct submission still needs intake on. The signed `feedback.report_received` gains `via: 'drop'` and `dropId` **only for dropped reports**; a direct report's payload is exactly as before. | The visitor was told “received” while intake was open; self-hosted signing stays byte-for-byte unchanged. |
| FD-52 | **Runtime tables** (migration `0045_feedback_drop`, expand): FD-09's `feedback_drop_keys` (signing key `kid` = its `fbk_…` pin); `feedback_drop_state (id = 1, card_seq, synced_at)`; `feedback_drop_sites (site_id, integration_id, published_at, card_seq, expires_at, refused)`, what control holds per site; `feedback_drop_outcomes` (FD-24) with `site_id` and a non-final `pending` outcome that counts transient attempts; `feedback_drop_expired (site_id, day, count)`, the pull's expiry counts per UTC day. Outcomes and expiry counts are swept after 8 days by the hourly check, retired keys after their `delete_after`. | Health needs per-site publication and expiry counts; FD-22's 5-attempt limit must survive a restart. |
| FD-53 | **Support and policy** (amends FD-25): the drop is `unknown` until the manager first answers and counts as available then; the start-up sync is sent even with no sites (an empty set), so boot learns it. 501, or 404 from an older manager, makes it `unsupported` (logged at info, never as an error): the policy item and `drop_unsupported` say FD-25's text, and `feedback.setIntake {enabled: true}` **and `feedback.createIntegration`** (which starts with intake on) are refused `managed.feedback_intake` with that text. `WHOMBAT_FEEDBACK=off` refuses the same with “Whombat Feedback is turned off on this Whombat.”. Switching intake off is never refused. | An appliance that can't deliver never pretends it can, and one that hasn't asked yet doesn't block the first integration. |
| FD-54 | **Timers** (amends FD-11, FD-22): syncs are debounced (1 s) after config events and requested on the claim; nothing is published or pulled before the claim. Pull and sync failures (unreachable or unsupported) back off 1 min → 1 h. The pull loop is idle without a published card and nothing pending, and a sync that publishes wakes it. Drops of a pull are skipped (left to their lease) once the runtime is quarantined or drained mid-batch. Timers run only in a read-write start. The manager client allows 64 MiB and 120 s for a pull, 1 MiB for the cards and ack answers (30 s and 10 s). | Control steers the cadence (`nextPullS`); an unreachable or older cloud costs one request an hour at most. |
| FD-55 | **Health on a managed Whombat** (amends FD-26, per FD-48): `delivery` is non-null for **every** integration; `publicUrl` is the embed origin; `public_url_missing`, `public_url_not_https` and `widget_not_built` are never raised; `drop_not_published` only while intake and the module are on and the drop isn't `unsupported` (then `drop_unsupported` instead); `lastCollectedAt` is the last outcome of any kind for the site. A refused card leaves `publishedAt` as it was (control keeps the card it held, FD-41), except `site_bound_elsewhere`. | The hosted app decides from health alone (FD-48). |
| FD-56 | **The signing key is made by whichever comes first**: the first sync with a site, or the first read of an integration's snippets on a managed Whombat, so the first snippet an owner sees already has `data-key` (FD-26) without a write in the create command. | Keys stay infrastructure outside burrow commands (FD-09). |
| FD-57 | **Module off on a managed Whombat: `delivery: null`** (orchestrator, 2026-09-27). With `WHOMBAT_FEEDBACK=off` the managed health keeps its `module_off` warning and reports `delivery: null`, so the hosted app (FD-48: snippets only with a non-null `delivery` and no `drop_unsupported`) keeps its notice instead of showing snippets whose intake can’t be switched on. | One rule in the app covers both “no drop here” cases. |

