# W4-SEC part 1: trust and permissions (independent review)

> A review of the code as it was on 2026-09-25, kept for its reasoning; the code has changed a lot since. How
> Whombat handles trust today: `docs/app/privacy-and-security.md`. Report a problem you find today: `SECURITY.md`.

Reviewer: W4-SEC (independent; did not write this code). Date: 2026-09-25.

**Scope and heads reviewed**
- Whombat `managed/providers` at **f9a23f4**: `apps/server/src/managed/**`, `apps/server/src/managed/providers/**`,
  `apps/runner/src/{managed,signin}.ts`, `packages/agent-runtime/src/access/managed/**` (authorization only; the
  MCP forwarder was checked for a path escape).
- whombat-control `main` at **9afec99**.
- the relay `main` at **b1b5d1c**.
- Contracts 0.5.0 as vendored in those repos (`@whombat/protocol`, `@whombat/control-contracts`).

**Method.** Code reading against assignment §5, §6, §12 and §14 items 2, 3, 5, 6 and 14, the threat model, and
the MR/PV/CL/relay decisions. Every finding marked *confirmed* has a PoC that asserts the vulnerable behaviour and
passes (it fails once the finding is fixed). The PoCs live only in scratch clones (`git clone --no-local`) under
`~/.cache/wb-tmp/sec1/`. The repositories were not modified. The Whombat and control PoCs use throwaway Postgres
databases that their test harnesses create and drop.

**PoC commands** (all were run and pass):

```
# Whombat (7 tests)
cd ~/.cache/wb-tmp/sec1/whombat/apps/server
TMPDIR=~/.cache/wb-tmp DATABASE_URL=postgres://whombat:whombat@127.0.0.1:55432/whombat \
  npx vitest run --config vitest.int.config.ts --reporter=verbose \
  src/managed/sec1-poc.int.test.ts src/managed/sec1-poc2.int.test.ts src/managed/providers/sec1-poc3.int.test.ts
# control (1 test)
cd ~/.cache/wb-tmp/sec1/control && TMPDIR=~/.cache/wb-tmp npx vitest run --config vitest.int.config.ts src/claims/sec1-poc.int.test.ts
# relay (1 test)
cd ~/.cache/wb-tmp/sec1/relay && go test ./internal/relay/ -run TestSEC1 -v -count=1
```

## Summary

| ID | Severity | Title | Repo | PoC |
|---|---|---|---|---|
| H-1 | **high** | Any owner can silently replace the appliance recovery key, and then use it to come back as *any* owner after being removed | Whombat (+ contracts) | confirmed |
| M-1 | medium | An owner can enroll their own key into any existing account, including other owners', by inviting that account's email | Whombat | confirmed |
| M-2 | medium | Last-owner bypass: the appliance can be left with owners but no live owner endpoint | Whombat | confirmed |
| M-3 | medium | Claim denial of service by anyone who knows the device id: squat the pending claim, spend the per-device limit, and lock the appliance's claim-attempt budget | control + Whombat | confirmed |
| M-4 | medium | Any cloud org member, or anyone who takes over a cloud account, can hold all 64 session slots with unenrolled Noise sessions that never time out | Whombat + relay | confirmed (runtime) |
| M-5 | medium | Relay: pre-admission connections from many source addresses (one IPv6 /64) exhaust the worker's connection cap | relay | confirmed |
| L-1 | low | Plaintext invite secrets (and other returned secrets) are kept in `command_receipts.outcome` for 7 days and are backed up | Whombat (+ contracts) | confirmed |
| L-2 | low | `api` ops that carry secrets (`packs.setSecret`, `connectors.setGoogleApp`) keep an unsalted SHA-256 digest of them in receipts | contracts + Whombat | analysis |
| L-3 | low | An organization credential sign-in completes after the owner who started it has been demoted | Whombat | confirmed |
| L-4 | low | Pairing approval has no rate limit and never shows which device is being approved. A guessed or mistyped code binds a victim's device to the approver's account | Whombat + contracts | confirmed (no limit, binding) |
| L-5 | low | The magic-link `next` parameter accepts `//host` (protocol-relative), a possible open redirect after sign-in | contracts (+ whombat-app) | regex confirmed; UI not reviewed |
| L-6 | low | MA-17: colleagues can drive a person's personal credential through that person's published automations (Run now `text`, event triggers) | Whombat (policy) | analysis |
| L-7 | low | A collaboration stream preallocates up to 16 MiB per message header, across 32 streams per session | contracts + Whombat | analysis |
| I-1 | info | The runner sign-in relay runs over unauthenticated loopback TCP (runner token only). A local process that binds the port while the server is down could impersonate it | Whombat | analysis |
| I-2 | info | Export streams of mutating `exportOp`s (`packs.export`) skip the drain gate and receipts | Whombat | analysis |
| I-3 | info | `welcome.clearCache` compares only the authz generation, not the account or endpoint | Whombat + whombat-app | analysis |
| I-4 | info | The per-peer claim-attempt limit is count-then-insert: one key made 12 attempts at once against a limit of 5 (the 130-bit secret makes this harmless, see M-3) | Whombat | confirmed |

Counts: **critical 0 · high 1 · medium 5 · low 7 · info 4**.

---

## Findings

### H-1 (high): any owner can replace the recovery key, and the recovery key can enroll into any owner account

**Where**
- `apps/server/src/managed/trust.ts:662-691` `kitRegister`: any owner overwrites `appliance_state.recovery_public_key`.
  It needs no proof of the current kit, no consent from other owners, and no notification. It resets
  `recoveryKitVerifiedAt` to null.
- `trust.ts:744-809` `recoveryEnroll`: accepts a statement signed by whatever key is stored, confirmed or not (it
  never checks `recoveryKitVerifiedAt`). It enrolls the new endpoint into **the `accountId` the statement names**,
  which can be any owner account (`trust.ts:788-790`).
- Contract: `RecoveryStatement.accountId` is chosen by the signer (`@whombat/protocol/session` enrollment).

**Scenario (staff departure, assignment §5).** Mallory is an owner. She calls `recovery.kit.register` with her own
key and never confirms it. Olive, the customer, later removes her properly with `admins.revoke` and
`endpoints.revoke`. Mallory then signs a `RecoveryStatement{accountId: <Olive>}` with her key. `recovery.enroll`
enrolls her new device as **Olive, an owner**. Olive's own confirmed kit has also stopped working
(`recovery_signature_invalid`), and nothing told her. The only trace is `recovery.kitVerified: false` in
`appliance.status` and a signed `recovery.enrolled` event. This defeats revocation (T5) and the staff-departure
procedure, and silently disarms the customer's only recovery path.

**PoC (confirmed):** `whombat/apps/server/src/managed/sec1-poc2.int.test.ts` › "F-invite-takeover and
F-recovery-overwrite". The log shows the recovery with the replaced key returning
`{accountId: <olive>, owner: true}`, and Olive's K1 then returning `recovery_signature_invalid`.

**Recommended fix (Whombat, contracts 0.5.x):**
1. Replacing an existing, verified recovery key must require a signature by the **current** recovery key over the
   new key. The alternative is a ceremony all owners can see, with a waiting period and a notification to every
   owner endpoint. Removing an owner must also prompt "rotate the recovery kit".
2. `recoveryEnroll` must refuse keys whose kit is not verified.
3. Bind the recovery key to the owner who registered it (per-owner kits), or require the statement's `accountId`
   to be the kit's registrant. Otherwise document explicitly that the kit is an appliance-wide master credential.
4. Treat `recovery.enrolled` (a key change) as a security event: push it to every owner endpoint.

### M-1 (medium): an owner can take over any existing account through `enroll.invite.*`

**Where:** `trust.ts:610-628` `inviteAccept`. When an account with the invite's email already exists, the new
endpoint is enrolled into **that account**. An invite with `owner: false` for an owner's email still yields an
owner endpoint (the account is an owner). `trust.ts:532-561` `inviteCreate`: owners may invite any email,
including existing accounts'.

**Scenario:** an owner invites `carol@…` (an existing member) and accepts the invite with their own key. They are
now Carol on every burrow and can read her DMs and private conversations. The same works against a co-owner.
Carol is not asked. Her `endpoints.list` shows the new device only if she looks. MR-12 removed the host-shell
authority (`login-link`) on purpose, but this path gives owners silent impersonation anyway. It also breaks the
MA-04 rule that further endpoints for an account need an existing trusted endpoint of that account, or recovery.

**PoC (confirmed):** `sec1-poc2.int.test.ts`. The log line `invite takeover: new endpoint enrolled into
accountId=X (carol=X)` shows the takeover.

**Fix (Whombat):** refuse `enroll.invite.create` for an email that already has an account (`account_exists`).
For those accounts use pairing, where an existing endpoint of that account approves, or recovery for owners. If
an admin-assisted re-enrollment is needed, make it an explicit op that notifies all of the account's endpoints
and imposes a delay.

*Since Whombat one-person.md OP-11 (2026-10-25): invites and owner-assisted re-enrollment are gone, and a Whombat has
one account, so this path no longer exists.*

### M-2 (medium): last-owner protection can be bypassed

**Where**
- `trust.ts:966-983` `adminsRevoke` counts other owners (`admin_since is not null`) but ignores whether they have
  a live endpoint.
- `trust.ts:853-871` together with `trust.ts:1063-1076` (`lastOwnerEndpoint`): an owner's endpoint may be revoked
  as long as *some* owner endpoint remains, even if a later `admins.revoke` removes that owner.

**Scenario:** owner A revokes the only device of owner B, which is allowed because A's device is live. A then
gives up owner, which is allowed because B is still an owner. The result: owners = {B}, and B has no live
endpoint. No session can run any owner op. Recovery works only if a kit exists. The same end state is reachable
in other orders, and by a malicious owner on purpose.

**PoC (confirmed):** `sec1-poc.int.test.ts` › "F-last-owner". It logs `owners=1 liveOwnerEndpoints=0`, and
`admins.grant` then returns `not_owner`.

**Fix (Whombat):** define the invariant as "at least one owner **with a live endpoint**". Check it in both
`adminsRevoke` (count owners other than the target that have a non-revoked endpoint) and `endpointsRevoke`
(after the revocation, some owner still has a live endpoint). Keep the shared `whombat/owners` advisory lock.

*Since Whombat OP-11 (2026-10-25): there are no owner roles or `admins.revoke`; what is left is last-device
protection (the person can't revoke their own last device, `last_owner_endpoint`; scenario `b-enrollment-negatives`).*

### M-3 (medium): claim denial of service with only the device id

**Where**
- control `src/claims/service.ts:48-52`: the per-device limit `claim:dev:<id>` (10/h) is consumed by *any*
  caller before any check.
- control `src/claims/service.ts:65`: first-wins `pending_elsewhere` for 15 minutes, renewable by the same org.
- control `src/billing/entitlements.ts:65` and `orgs/service.ts:74`: every new org gets a default entitlement, so
  any email address can create an org and start claims.
- Whombat `trust.ts:283-293`: the appliance's claim-attempt budget is global (30/h over all keys, 5/h per key).
  Keys are free, and the pending-claim org's enroll ticket (control `claims/service.ts:109-115`) reaches it.

**Scenario:** someone who has seen only the device id (60-bit, printed on the card and possibly on the box or a
photo, known to a reseller or RMA handler; this is not a stolen card, so T4 doesn't cover it):
1. signs in with any email, creates an org, and starts a claim. They get an `enroll` ticket, and the real
   customer gets `409 claim_pending`.
2. keeps renewing the claim, spending the device's 10/h budget, so the customer gets `429` even after the pending
   claim ends.
3. with the ticket, spends the appliance's 30/h claim-attempt budget using throwaway keys. The customer who holds
   the right secret gets `rate_limited` from the appliance itself.

The squat is repeatable indefinitely. The same test showed the per-key limit being raced (I-4).

**PoCs (confirmed):**
- control: `~/.cache/wb-tmp/sec1/control/src/claims/sec1-poc.int.test.ts`. Results: attacker 200 with an enroll
  ticket; customer 409 `claim_pending`; customer 429 (`retryAfterS: 2637`).
- Whombat: `sec1-poc.int.test.ts` › "F-claim-lockout". Six throwaway keys × 5 wrong codes leave the owner with the
  right code at `rate_limited`.

**Fix:**
- control: require proof of the card before a pending claim. For example, the client presents
  `H(claimSecret ‖ "control-claim")` (not the secret itself) or another card-derived value that provisioning
  registers with control. Rate-limit per org and account only, never per device, or apply the per-device limit
  only to verified proofs. Let a claim with a valid card proof replace a squatter's pending claim.
- Whombat: make the global budget per ticket subject/org (the runtime doesn't see it today; the relay could pass
  a coarse admission subject), or apply the global lockout only after the physical claim window opens. Consider
  exponential per-key backoff instead of a global hour-long lock.
- Consume attempts atomically: `insert … returning count` in one statement, or a serialized counter (see I-4).

### M-4 (medium): session-slot exhaustion by unenrolled sessions

**Where**
- Whombat `session/connection.ts:201-216`: any Noise key that says hello is attached as a session, including
  unenrolled keys.
- `session/registry.ts:9,33-35` and `session/endpoint.ts:35-37`: at 64 sessions the appliance refuses every
  `incoming`. Neither unenrolled nor enrolled sessions have an idle timeout, and pings keep them alive.
- relay `internal/relay/server.go:372` with `options.go:74,76`: `MaxSessionsPerAppliance` 64 is shared by all
  clients, and one subject may hold 128 connections.

**Scenario:** any member of the owning cloud org with the `tickets` right (member, admin or owner) can do this.
That includes an employee removed on the appliance but not in the cloud org, and anyone who took over a cloud
account (T3), who is explicitly in scope. Before the claim, the squatting org of M-3 can do it too. The attacker
opens 64 sessions with fresh keys and idles. The appliance is unreachable for all enrolled users until the
attacker stops. The attacker learns no content, but this is an availability break by an actor that T3/T5 treat as
powerless.

**PoC (confirmed, runtime side):** `sec1-poc.int.test.ts` › "F-session-exhaustion". It logs `sessions=64
full=true`, still full after the 10 s hello timeout. The relay side was checked by reading the code
(`TestPerApplianceConcurrencyLimit` exercises the 64 cap).

**Fix:**
- Whombat: a small separate budget for unenrolled sessions (for example 4, with a 2-minute lifetime and closure
  after the enrollment ops or on idle). Reserve most slots for enrolled endpoints, and add an idle timeout for
  all sessions.
- relay: a per-subject cap per appliance (for example 8) below `MaxSessionsPerAppliance`.
- control: consider a per-subject ticket budget per appliance.

*Since Whombat OP-11, OP-12 (2026-10-25): the org has one account, so only the person (or whoever took over their
cloud account, T3) gets tickets; the separate budget for unenrolled sessions (MA-19 (e)) stays, and the relay's
per-subject cap (RL-33) rises to the appliance's 64.*

### M-5 (medium): relay connection-cap exhaustion before admission

**Where:** relay `internal/relay/server.go:185-212`. The per-IP limiter is keyed on the full address
(`ip.String()`), bounds only the *rate* (20/s, burst 60, `options.go:78`), and runs after the WebSocket upgrade.
Unauthenticated connections are held until `HelloTimeout` (10 s). The worker-wide cap (50 000, 4429 above it)
counts them.

**Scenario:** an attacker with an IPv6 /64, or a few hundred IPv4 addresses, keeps about 5 000 new TLS/WS
connections per second open without a hello. Every client and appliance on that worker gets `4429 capacity`,
across all tenants. No ticket is needed.

**PoC (confirmed):** `~/.cache/wb-tmp/sec1/relay/internal/relay/sec1_poc_test.go`. With the cap scaled to 60,
70 upgrade-only connections from distinct 127.0.1.x source addresses make a client with a valid ticket fail with
`close=4429 capacity`.

**Fix (relay):** aggregate IPv6 to /64 (and optionally IPv4 to /24 for the concurrency budget). Add a
**concurrent** pre-admission cap per prefix and a global cap on pre-hello connections (for example 10% of
`MaxConnections`). Shorten the hello timeout to 2-3 s. Consider TLS-level or LB connection limits in `deploy/`.

### L-1 (low): plaintext secrets in command receipts

**Where:** `dispatcher.ts:503-543` stores every mutating op's result in `command_receipts.outcome`
(`receipts.ts:235-245`) for `WHOMBAT_COMMAND_RECEIPT_HOURS` (7 days), and backups include it.
`enroll.invite.create` returns the plaintext `secret` (`trust.ts:560`). Its hash is carefully the only thing kept
in `endpoint_invites`, but the receipt keeps the secret. Other outputs of the same kind:
`canvases.collabToken` (token), `enroll.pair.request` (code), `recovery.kit.register` (challenge).

**Impact:** anyone who can read the database or a restored backup (a backup drill environment, a support bundle
that includes the DB, or DB access through any future bug) gets live owner invites.

**PoC (confirmed):** `sec1-poc.int.test.ts` › "F-receipt-secret". The receipt outcome contains the secret, and
using it enrolls a new **owner**.

**Fix (contracts + Whombat):** add an output-secret flag (`secretOutput`) to `OperationSpec`. For such ops, store
only `{kind, redacted: true}` and answer retries with `outcome{state: completed}` without the output. The client
must then fetch invite state (not the secret) or create a new invite. At minimum, mark `enroll.invite.create`,
`enroll.pair.request` and `canvases.collabToken`.

*Since Whombat OP-11 (2026-10-25): `enroll.invite.create` is gone with invites; the other outputs named here are
unaffected.*

### L-2 (low): unsalted digests of secret inputs in receipts

**Where:** `dispatcher.ts:506` (`receiptDigest`) and contracts `operations.js` `apiSpec` (`secret: false` for
every `api` op). `packs.setSecret` (`body.value`, up to 4000 chars, any secret a pack needs) and
`connectors.setGoogleApp` (`body.clientSecret`) are hashed as `sha256(canonicalJson({op, input}))`, and every
other input field is known or guessable from the DB (burrow, attachment id, name). A weak pack secret can be
brute-forced offline from `command_receipts.digest`, which the master key does not protect.

**Fix (contracts):** allow `secret: true` on `api` ops (`packs.setSecret`, `connectors.setGoogleApp`,
`devices.register`/`update` tokens), or salt the digest with a per-appliance key (HMAC).

### L-3 (low): an org credential sign-in completes after its starter was demoted

**Where:** `providers/service.ts:206-210` (`own` checks only the account) and `service.ts:382-420` (`submit`
never re-checks `owner` for `owner.kind === 'org'` attempts). Attempts live in memory for 10 minutes and survive
the `authz_changed` reconnect.

**Scenario:** a demoted owner reconnects and submits an attacker-controlled API key into the organization
credential. Team agents then run on the attacker's key, so their prompts go to the attacker's provider account.

**PoC (confirmed):** `apps/server/src/managed/providers/sec1-poc3.int.test.ts`. The demoted account's
`providers.org.login.start` fails with `not_owner`, but its `providers.login.submit` completes and
`record({kind: 'org'})` exists.

**Fix (Whombat):** in `submit`, `status` and `cancel`, call `requireOwner(principal)` when `a.owner.kind === 'org'`.
Also cancel an account's org attempts when its `authz.changed` fires.

### L-4 (low): pairing has no guess limit or confirmation

**Where**
- `trust.ts:474-486` `pairApprove`: an enrolled endpoint may try codes without any rate limit (only 64 requests in
  flight per session). The contract input is `{code, approve}`, so the approver never sees the pending device's
  label or platform before approving.
- `trust.ts:417-428`: pairing requests are limited per key only, so unenrolled keys can create pending codes
  without bound.

**Scenario:** a malicious member sprays codes continuously. About 300 guesses per second per session were
measured. Any other person's pending pairing that is hit binds **the victim's new device to the attacker's
account**. The victim then works as the attacker, and what they type or upload lands in the attacker's account.
Separately, a user who mistypes one digit approves whatever pending device holds that code.

**PoC (confirmed):** `sec1-poc2.int.test.ts` › "F-pairing-guess". 60 concurrent guesses got 0 `rate_limited`, and
a correct code binds the victim's key to the approver's account.

**Fix (Whombat + contracts):** two-step approval. First look up the code (returns the label, platform and a short
fingerprint of the new key; the new device shows the same fingerprint), then approve that pairing id. Limit
lookups per endpoint (for example 10/10 min) and globally. Consider 10-digit codes. Cap pending pairings
appliance-wide.

### L-5 (low): the magic-link `next` parameter accepts protocol-relative URLs

**Where:** contracts `control-contracts/dist/auth.js` `MagicLinkRequest.next` regex `^\/[^\s]*$` accepts
`//evil.example/x` and `/\evil.example`. Checked: `node -e` returns `true true`. Control embeds it in the email
link (control `src/auth/magic-link.ts:27-28`).

**Impact:** `POST /v1/auth/magic-link` is unauthenticated. An attacker can make control send a *genuine* Whombat
sign-in email to a victim that, if the hosted UI navigates to `next` after verification, lands the signed-in
victim on the attacker's site (phishing for appliance/kit material). whombat-app was not in scope and its
handling was not checked.

**Fix (contracts):** `^\/(?![\/\\])[A-Za-z0-9._~!$&'()*+,;=:@%\/-]*(\?[^\s#]*)?$`, or an allowlist of route
names. whombat-app should additionally resolve `next` with `new URL(next, location.origin)` and require the same
origin.

### L-6 (low, policy): MA-17 NA covers runs that colleagues parameterize

**Where:** `automations/commands.ts:560` (Run now uses the publisher's authority), `:582` (`scope.text = input.text`
from whoever clicks Run now, up to 2 000 chars) and `automations/steps.ts:581` (`renderTemplate(step.prompt,
scope)`, which includes `trigger.text`). `agent-runtime/src/providers/owner.ts:58-63` classifies every
`automation` dispatch of an automation X published as NA on X's personal credential.

**Impact:** a colleague with `agents.manage` can run X's manual automation with their own free text, and event
triggers carry other people's message content. The work then runs on X's personal credential. The MA-17 wording
("their own automations") arguably allows this, but it is a colleague's request on a personal credential in all
but name.

**Fix (Whombat, policy decision):** classify runs *started* by someone other than the publisher (manual trigger
`actorId` ≠ publisher) as OA on personal credentials, or ignore `input.text` for them. Record the decision in
`managed-providers.md`.

### L-7 (low): collaboration stream preallocation

**Where:** contracts `protocol/dist/collab.js` `CollabMessageDecoder.push` allocates `new Uint8Array(n)` as soon
as a 4-byte header announces n ≤ 16 MiB. Used in Whombat `resources.ts:532-547`, where credit is returned per
DATA frame before the message completes. That is 32 streams × 16 MiB per session, 512 MiB per enrolled session,
and several such sessions can run at once. Pages are touched only as data arrives, so real RSS needs the bytes to
be sent. It is bounded by throughput, not by a budget.

**Fix:** a per-connection budget for partially received collaboration messages (for example 32 MiB), a lower
per-message cap for awareness, and allocation growing in chunks.

### I-1: unauthenticated loopback peer for the runner sign-in relay

`providers/bridge.ts` and `providers/routes.ts`: the runner long-polls the server on `127.0.0.1` with the runner
token. If the server is down and another local process binds the port, the runner sends it the token and executes
its `submitSecret`/`logout`/`githubToken` requests. The answer to `githubToken` returns a GitHub token to that
process. On the appliance, only trusted system users can bind loopback ports (sandbox tasks are in their own
network namespace), so this is informational. Prefer a unix socket with `SO_PEERCRED`, or verify the server
(runtime directory socket with 0660 permissions, as for the admin socket).

### I-2: export streams skip the drain gate and receipts for mutating export ops

`resources.ts:183-215` `openExport` calls `dispatcher.runApi` directly, so `packs.export` (POST, `exportOp`) runs
while `maintenance.draining` holds and without a receipt. It has no side effects today. Keep it that way, or route
it through `#handle`.

### I-3: `welcome.clearCache` compares only the generation

`connection.ts:227-228`: `clearCache` is set only when `cachedAuthzGeneration` differs. Two accounts at the same
generation on one client profile would not be told to clear. Clients must key caches by
`{appliance, accountId, endpointId, generation}` (R-67). Consider adding `cachedAccountId`.

### I-4: count-then-insert claim-attempt limit

`trust.ts:283-293` reads the counts and inserts afterwards, outside a transaction. One key made 12 concurrent
attempts, all evaluated, against a per-key limit of 5 (`sec1-poc.int.test.ts` log). This is harmless against a
130-bit secret, but the same pattern must not be reused for low-entropy codes. Fix with one atomic statement.

---

## Checked and found sound

**Whombat runtime**
- **Allowlisted dispatcher.** Every `api` op runs REST's own handler with the contract's parsing and
  `burrowAccess`, as the session's account. There is no URL, header, cookie or port surface. `auth.*`,
  `devices.vapidKey`, runner routes and MCP are not reachable. The `req`/`reply` stand-ins throw. Unenrolled keys
  get only `enroll`-channel ops (20/min). No `api` endpoint has `auth: runner`, and the non-burrow ones are all
  `session` (enumerated).
- **Managed HTTP listener.** Only `/internal/runner/*` and `/mcp`. The sandbox MCP forwarder's prefix check can't
  be escaped with dot segments: `/mcp/../internal/runner/…`, `/mcp/%2e%2e/…` and `/mcp/..%2f…` all return 404
  (tested against Fastify).
- **Revocation.**
  - The revoked endpoint's sessions get `revoked{clearCache}` and close at once.
  - Every request, `status`, `subscribe` and `open` re-checks revocation and the generation. This also covers the
    identify→attach window, because the next request re-checks.
  - Closing a session cancels its uncommitted in-flight commands (`beforeCommit`) and ends its subscriptions and
    streams, collaboration included (the reset handler closes the Hocuspocus connection).
  - The ≤ 2 s answer grace on `authz_changed` applies only to sessions still authorized for the same account.
- **Event log.**
  - Topics are authorized with `/ws`'s `authorizeTopic` for the account's principal in the topic's burrow.
  - `me:` topics must belong to the account.
  - `audienceConversationId` frames are filtered by current membership at delivery and replay.
  - `membership.removed` drops gated topics.
  - Cursors are bound to the process epoch and the authz generation.
  - There is no burrow-member removal path that could leave a stale `burrow:` subscription.
- **Receipts.** Keyed `(principal, op, requestId)` with the digest bound. No replay across principals. `status`
  is scoped to the principal. `secret` session ops keep no input digest. The `backup.recoveryMaterial` query is
  never stored.
- **Claim.** Atomic: row lock plus conditional `claim_consumed_at is null`, account, endpoint and signed event in
  one transaction. Bound to the claiming key. The secret is compared in constant time and is 130-bit.
- **Recovery statements.** Bound to this appliance's PeerId and to the session's own key, ±5 min, single use
  (hash of nonce and endpoint under an advisory lock). Strict Ed25519.
- **Invites.** 192-bit secret, stored as a hash, consumed under `FOR UPDATE`. Owner-only create and revoke.
- **Owner changes and endpoint revocation.** Under the `whombat/owners` advisory lock. Both bump the generation,
  and signed events are appended in the same transaction.
- **Streams.**
  - Download: authorized by `readableAttachment`, range checked, credit-paced.
  - Upload: the reservation must belong to the uploader, and the partial path comes from the DB attachment id
    (no traversal). Chunk contiguity, per-chunk and whole-file sha256, and sizes bounded by the contract.
  - Preview: one decode job at a time in a worker with `resourceLimits`, ≤ 16 MP, never the original.
- **Push.** Content-free. Refs and collapse keys are HMACs under a master-key-derived key. Handles only from
  non-revoked endpoints of the recipients' accounts. Off in quarantine.
- **Admin socket.** 0660 in the runtime directory with a dedicated group. Typed contract bodies of at most 64 KiB.
- **Credential homes (MA-17).**
  - One resolver: the configured owner only, never the requester.
  - Ids are validated by regex before path joins.
  - Homes must be 0700, not symlinks, and owned by the current uid.
  - No environment or API-key fallback. Org credentials are always OA, personal credentials PI/NA/OA as coded.
  - Automation `post_message` mentions don't dispatch.
  - `requestedByAccountId` comes from the trigger message's author. `run_control` and `expand` resolve to an agent
    author (so OA on personal credentials, not a bypass).

**whombat-control**
- **Magic link.** The token is in the URL fragment, stored as sha256, consumed atomically, lives 15 min, and is
  rate-limited per IP and per email. The response doesn't reveal whether the email exists. Logs redact auth
  headers and cookies, and bodies aren't logged.
- **Sessions.** 256-bit tokens stored hashed. The cookie is `__Host-` in secure mode, `SameSite=Lax`, and
  state-changing cookie requests need an allowlisted `Origin`. CORS allows exact origins only.
  `Referrer-Policy: no-referrer`. Passkey challenges are one-use with UV required.
- **Orgs.** Last-owner protection under an org row lock, for both role changes and removal. Admins can't touch
  owners. Invitations are bound to the email.
- **Tickets.**
  - `app` tickets go only to members with the `tickets` right in the owning org.
  - `enroll` tickets go only to the org holding the live pending claim.
  - Unclaimed tickets carry no `org`.
  - Tickets are worker-bound, 60 s for clients and 300 s for appliances, with a random `jti`.
- **Device API.** Strict Ed25519 envelope, ±300 s. The nonce is recorded after verification with
  insert-or-conflict (replay → 401). `claim.claimed` only for the device's own claim, and never over another
  org's device.
- **Operator API.** Separate listener on the private IP (`infra … compute.tf:152`) with its own tokens and
  permissions. The emergency stop is a separate permission.
- **Push.** Handles are filtered by membership in the device's org. The payload is a generic kind plus an opaque
  ref. Collapse ids are HMAC-keyed. Rate-limited per device and per handle.
- **Billing.** An entitlement withheld blocks claims, invites and cohorts, never tickets (R-65).
- **Admission keyring.** Private keys never serialized to logs. The JWKS carries public keys only, and the runbook
  removes compromised keys.

**the relay**
- **Admission.** Uses the contracts' `VerifyAdmissionTicket` (audience, issuer, role, worker binding, lifetime,
  skew). Client tickets are single-use per worker, and the replay cache fails closed. Appliance data connections
  must match the pending session's appliance, so cross-appliance splicing is refused (`handleData`). `refuse` is
  scoped to the appliance's own sessions. Only an appliance ticket can supersede a control route.
- **Origin.** When an `Origin` header is present it must be allowlisted; native clients without one still need a
  valid ticket.
- **JWKS fetch.** https only, and redirects must stay https. Refresh on an unknown `kid` is debounced (30 s).
- **Session ids.** Random.
- **Frames and queues.** Frame, queue and bandwidth bounds per session and per control connection.

## Not covered by this part
- Sandbox escape testing beyond the MCP forwarder path check (W3-SBX, part 2).
- whombat-app client handling (`next`, cache keying, clear-on-revoke) and native clients.
- Secure-channel internals (reviewed separately in `secure-channel-review.md`).
- Updates, backup and restore authority (part 2).
