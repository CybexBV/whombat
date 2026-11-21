# Whombat managed appliance — implementation orchestrator prompt

Give this entire file to the lead coding agent. It is an implementation assignment. The original architecture plan and Whombat_Architecture_Review.md are useful attachments, but this prompt contains the essential requirements.

---

You are the lead architect and implementation orchestrator for Whombat. Use specialist sub-agents to refactor the current project and build the managed-appliance architecture described below.

**Do the implementation. Do not stop after a review, plan, repository skeleton, protocol demo, or list of TODOs.** Inspect the real code, make defensible decisions, implement the integrated system, test it, fix the defects you find, and leave runnable development environments and reviewable release candidates.

## 1. Product goal and authority

Current repository: Whombat (private at the time)

The reviewed baseline was main at c4702a5ec8e9bb66b186909a4d7d16d337e09d0f on 25 September 2026. Inspect current HEAD and local changes before relying on that baseline. Preserve subsequent work.

Customers plug a managed Whombat appliance into power and Ethernet, claim it, connect their own supported provider and integration accounts, and operate it through https://app.whombat.com. https://dev.whombat.com is the separate development environment.

The appliance is the authoritative workspace server: it holds the database, messages, repositories, workspaces, attachments, keys, approvals, schedules, memory, and execution state. The hosted UI renders and decrypts locally in the authorized browser. The relay forwards encrypted content. Model inference can happen at customer-selected external providers.

The subscription pays for the managed appliance/product experience. Do not pool provider subscriptions, extract provider tokens, resell an inference allowance, or silently convert personal subscriptions into organization-wide credentials.

You are authorized to:

- Create and modify separate local Git repositories under ~/Code, use isolated worktrees/branches, create meaningful commits, and build/test disposable environments.
- Create new **private** repositories under the maintainer’s account for the new components when authenticated permissions allow, push implementation branches, and prepare draft integration PRs. Check for existing repositories before creating; never overwrite an existing unrelated repo or change its visibility.
- Select routine implementation details, replace a proposed dependency when evidence justifies it, and supersede incompatible old architectural decisions with explicit new ADRs.
- Continue through independent work when one external dependency or qualification step is blocked.

This is a staged rebuild. Do not inherit old instructions that automatically deploy the current monolith, merge into shared main, repurpose live domains, or restart services during extraction. Preserve current production/development data and installations. Prepare deployment automation and migration/cutover instructions; do not deploy to live customer infrastructure, change DNS, use production signing keys, or flash physical disks under this assignment. Local integration and disposable test deployments are in scope. Do not buy services, send messages, contact providers, accept agreements, or access customer content to test the system.

No permission is needed for normal reversible implementation choices within this scope. If remote creation is unavailable, complete local repos and give exact remote setup steps. Never make lack of one cloud credential a reason to abandon the software implementation.

The attached old plan calls for validation only; this prompt supersedes that restriction and its monorepo layout. Preserve compatible repository instructions, product visuals, accessibility, and safety rules. Use truthful authorship metadata rather than a hardcoded attribution to a different model.

## 2. Repository layout and dependency ownership

Use these paths unless an existing directory conflicts:

| Path | Owns |
|---|---|
| ~/Code/Whombat | Existing application's local server, runner, provider adapters, database, domain logic, migration/legacy import tools |
| ~/Code/whombat-app | Hosted React UI, Expo/native apps, shared client session/transport/resource adapters, tokens/brand/UI packages |
| ~/Code/whombat-control | Cloud identity, organizations, device directory, enrollment coordination, routing admission, update assignments, generic push, operational metadata and billing boundaries |
| ~/Code/whombat-relay | Small opaque-content relay with bounded connections/queues, quotas, routing, draining, reconnect support |
| ~/Code/whombat-appliance | NixOS image/modules, independent device manager, restricted update helper, recovery/provisioning tools, infrastructure manifests, product integration harness and release coordination |
| ~/Code/whombat-contracts | Pure versioned application contracts, transport/control/release schemas, generated language bindings, compatibility fixtures and conformance tests |

Do not create a repo for each daemon or billing submodule. A repository is not necessarily a separate deployed service. Keep the server and runner as a local application system; do not turn their internal calls into cloud round trips.

Default to TypeScript for the retained application and control API, Go for the relay and management/helper binaries, Nix for the appliance. The content encryption endpoint can remain in the TypeScript runtime; the Go manager/relay can forward opaque frames. This avoids requiring a second crypto implementation without a reason.

Preserve useful history, original provenance, licenses, and tests when extracting packages. Keep the original repo usable during migration. Move tests with their code. Do not scatter copies of schemas or domain logic across repos.

The contracts repository is pure and has no imports from consumers. Retain the existing Zod contract source where appropriate; define a supported cross-language schema subset and generate bindings/test vectors rather than assuming every Zod refinement round-trips into another language. Contract tests verify equivalent validation.

Publish/pin immutable package versions for CI and releases. A local workspace override is allowed for development, but no released build may depend on an uncommitted sibling path. Each repo must build/test from its own clean checkout with declared dependencies.

Own the product integration manifest in the appliance. Record repository commits, package versions, image/store digests, supported protocol/schema/host ranges, provider bundle identities, and upgrade paths. Independently built components are promoted only as tested combinations. Define the contract-first publishing order and cross-repo change procedure; do not create a release dependency cycle.

## 3. Orchestration method

Read AGENTS.md/CLAUDE.md, ARCHITECTURE.md, DECISIONS.md, design handoff, relevant tests, deployment/backup/upgrade code, and the attached review. Inspect current behavior before modifying it.

Create a persistent implementation ledger in appliance/docs/implementation with:

- Agreed architecture and ADR index.
- Requirements and feature/permission parity matrix.
- Task/dependency graph, repository/file owners, branches and integration order.
- Threat model and provider-mode evidence register.
- Exact tested version manifest.
- Verification evidence, remaining blockers and release checklist.

Every requirement gets one of: implemented and verified; implemented with a named unrun qualification; blocked by a specific external dependency; deliberately excluded with a product reason. “Planned” and empty interfaces are not completion.

Use parallel specialists, bounded by available capacity:

1. Contracts, secure transport and identity.
2. Relay and cloud control.
3. Local application, durable commands, database and runner.
4. Hosted UI, native clients, collaboration and resources.
5. Appliance, updates, backups and recovery.
6. Independent security/integration reviewer; rotate provider and UX review work into available capacity.

Give each sub-agent explicit owned files/repos, input/output contracts, dependencies, tests, and completion criteria. Use separate branches/worktrees for conflicting work. Assign one writer to contracts, lockfiles and integration manifests at a time. Sub-agents do not merge each other's work or stop shared services.

The orchestrator owns cross-repo integration, commits, decisions, conflicts, and completion. Review code before integrating. An independent reviewer must inspect trust, permissions, updates and recovery implementations after their authors finish; fix material findings and rerun affected tests.

Continue across context limits using the ledger. Do not let a successful sub-agent report substitute for an integrated run.

## 4. Preserve the working product

Retain the single server write/commit pipeline, permission keys (can/ask/cannot), human approvals, audit semantics, signed events, transactional outbox, worktree isolation, attribution and existing design system.

Build an inventory covering at least:

- Channels/threads/DMs, agents and sub-agents, runs, approvals, search, canvases and collaboration.
- Automations, memory, packs/skills/MCP, connectors, GitHub operations, account and organization administration.
- Uploads, downloads, range requests, images/avatars, previews, exports, deep links, notifications and live activities.
- Web, Android, iOS build compatibility, session/device switching, provider login and recovery.

No feature may disappear silently. Preserve behavior, redesign it to satisfy the new boundary, or explicitly disable an incompatible legacy capability in managed mode with an explanation. Do not invent a normal local UI to bypass a difficult feature.

Concrete code issues from the reviewed baseline:

- apps/server/src/db/migrate.ts rejects any schema history newer than the binary. Add explicit reader/writer compatibility and separate startup validation from migration authority; never merely remove the guard.
- apps/cli/src/upgrade.ts currently leaves the service stopped after failed startup following migration. Replace this behavior for managed mode with tested recovery.
- Current backup excludes workspaces/codex-home and is not encrypted. Define complete appliance recovery coverage.
- packages/client/src/uploads.ts uses XHR, realtime has its own socket, Hocuspocus has its own /collab socket, and web/mobile attachment resources bypass injected fetch. Migrate all of them.
- apps/server/src/auth/admins.ts reserves admin changes for host shell; host.ts creates owner/login links under host authority. Add local owner-authorized remote administration with last-owner protection; never expose a cloud-admin bootstrap shortcut.
- Existing outbox retention/startup bookkeeping is not an indefinite replay log. Implement cursor/snapshot semantics explicitly.
- APNs and direct Firebase senders use server-side service credentials; Firebase also has a development-only emulator relay, not a production credential broker. Reuse test plumbing where useful, but keep product push signing in authenticated cloud control with content-free notification requests.
- Managed execution must not silently inherit trusted host access or sandbox fallback from the self-hosted product.

## 5. Trust, identity and secure transport

Separate cloud login, organization billing role, hardware/management identity, authorized endpoint keys, local application principals, provider identities, and recovery authority.

A cloud routing ticket admits traffic; it cannot authorize customer application operations. The appliance authenticates each content session and enforces current local permissions. Owner operations and revocations go through authorized local commands and audit. Show pending versus applied revocations when a device is unreachable.

Recommended enrollment:

- Provision a unique appliance identity; no universal private key, preclaimed state, cloned random seed, or vendor account in the image.
- A sealed claim card binds the appliance public identity/fingerprint to a high-entropy, one-use secret. Qualify the physical claim-window mechanism for the chosen hardware.
- Authenticate the expected appliance through a reviewed secure channel before transmitting claim material; bind acceptance to the new client's key. Consume the secret atomically, rate-limit attempts, and prevent competing claims.
- Have the owner save and verify a customer-held recovery kit. Further endpoints require an existing trusted endpoint or that recovery ceremony. Cloud password/email reset alone grants no local content rights.
- Define key rotation, staff departure, last-owner protection, lost browser storage, stolen devices, ownership transfer, total device loss and recovery-kit loss.

Start an early secure-channel qualification spike. A candidate is the maintained libp2p Noise implementation through its public stream-encryption interface over a bounded WebSocket byte stream, using the existing noise-libp2p protocol rather than designing a handshake. Do not import DHT/discovery/peer-routing infrastructure merely to obtain encryption.

Verify current upstream package ownership, maintenance, license, advisories, security-review provenance and public API. Do not claim a dependency is audited without evidence. Prove browser↔Node and native Expo Android/iOS interoperability, strong randomness, appropriate local key storage, identity binding, frame limits and bundle viability. Do not assume Node crypto APIs exist in a browser or Expo/Hermes.

The selected protocol/library needs authenticated peer identities, fresh session keys, forward secrecy, replay protection, bounded parsing, rekeying and deterministic failure behavior. Pin the appliance identity from enrollment and forbid application mutations in handshake early data. Unenrolled endpoint identities may use only a tightly bounded, device-authenticated claim/enrollment/recovery channel. Deny workspace operations until the ceremony atomically enrolls that identity. Claimed appliances require existing-owner authorization or the defined recovery ceremony for new endpoints. Reconnect creates fresh crypto state; never reset nonces under an old key.

Select the passing implementation in an ADR after independent code review and proceed. If it fails, evaluate another maintained implementation/native binding. Do not implement homemade cryptography or downgrade to relay-terminated TLS.

Scope the threat model precisely: compromised relay/control API/database/routing authority must not read content, substitute peers or grant access. Compromised frontend publishing, DNS/CDN/service-worker authority or malicious signed appliance releases are trusted-endpoint/supplier failures and must not be claimed solved by E2EE. Separate their IAM/signing credentials from ordinary cloud operations.

Enforce CSP, minimal dependencies, no content-bearing analytics/session replay, safe rendering and isolated previews. Arbitrary uploaded HTML must not become trusted same-origin script merely because decryption uses a blob URL.

## 6. Relay and application session

Use persistent outbound TLS WebSockets on 443 from appliance and clients, with the authenticated inner encrypted channel. No inbound firewall changes or arbitrary LAN tunneling.

Relay responsibilities: validate short-lived audience/device-bound admission; allowlist browser origins; route opaque IDs; bound frames, buffers, timeouts, bandwidth and concurrency; heartbeat; exponential reconnect jitter; worker draining; route reassignment; and coarse operational metrics. Native clients may lack a browser Origin header and still require valid admission and endpoint authentication. Origin is never authorization. No workspace database, message queue, plaintext payload logs or customer-content crash dumps.

Keep command names, paths, application auth, filenames, content and detailed errors inside encryption. Keep admission secrets out of URLs, process arguments and logs; implement browser WebSocket authentication limitations deliberately.

Implement one client appliance-session interface covering typed request/response, subscriptions, collaboration, streaming resources, cancellation, deadlines and capability negotiation. Use an allowlisted dispatcher into application handlers, not a generic URL/header/port proxy. Internal runner/MCP/management endpoints remain separately scoped.

Provide independent flow control across the entire route. Separate interactive and bulk connections where needed; multiplexing streams over one TCP connection does not eliminate head-of-line blocking. Avoid base64 encoding entire files or buffering unbounded resources. Support resumable chunked transfer, integrity checks, authorization, quotas and bounded native/browser memory.

Durable command semantics:

- Distinguish local draft, pending delivery, durably accepted, executing, completed, rejected and unknown outcome.
- Acknowledgement means the appliance transaction committed, not that the relay saw a frame.
- Scope idempotency by appliance/principal/operation and bind request ID to a request digest. Reject reused IDs with different payloads.
- Persist deduplication with command acceptance. Retry an ambiguous request with the same ID or query its outcome; never create a fresh duplicate by default.
- Define deadlines, cancellation races, retention and permission rechecks.
- Resume events from appliance-owned cursors. On retention expiry, restart or changed access, return an authorized snapshot. After local revocation applies, deny appliance access and close active sessions. Instruct compliant clients to clear content; previously downloaded data and offline/malicious clients cannot be reliably erased remotely.
- Do not claim exactly-once external effects. Use integration idempotency or reconciliation; never blindly repeat uncertain destructive actions.

No client or relay disconnect cancels a durably accepted local task by itself.

## 7. Local execution and integrations

Keep orchestration, scheduling, approvals, git/tool work and database local. Persist job/lease/generation ownership, provider identity, approval waits and resumable checkpoints. Recheck permissions and approval-bound action/diff identity at execution.

Fence stale workers and terminate orphan processes; a lease field alone does not prevent filesystem writes. Lock shared workspace operations. Define restart, catch-up/coalesce/skip policies and daylight-saving behavior for schedules.

Systemd owns managed appliance services. Do not run the legacy CLI supervisor and the new manager as competing upgrade or Postgres authorities. Retain the CLI where useful for development, migration and narrowly scoped recovery.

Separate management/update identities from application/agent identities. Reserve memory/CPU/I/O/storage for PostgreSQL, the manager and interactive API. Limit per-task concurrency, output, processes, disk and network.

Qualify a conventional pinned Linux execution environment on NixOS with a real enforced sandbox. Test the provider process and its tools together. No Docker/Podman host socket, root updater socket, database credential, application master key, unrelated provider login, SSH agent or another user's files may leak into arbitrary project code.

Treat repository hooks, dependencies, skills and MCP servers as untrusted execution. Enforce mount/UID/process/socket/network policies, including IPv6, DNS changes, redirects, metadata addresses and unauthorized LAN destinations. Optional customer-network access is an explicit scoped grant. If a required boundary is unavailable, fail the affected task clearly; never silently use unsandboxed host execution.

Use local per-user GitHub credentials by default. A centrally owned GitHub App can authorize access across installations, so it is an explicit different trust model. Never ship a vendor-wide App private key in an appliance. A customer-owned App requires its own secure onboarding and local custody.

Audit OAuth callbacks, polling, webhooks and the proposed external bug-report integration. Do not quietly receive plaintext customer content in cloud ingress and call the entire flow content-blind. Prefer outbound/customer-side designs; preserve sender authentication, replay prevention and spam/rate limits. Gate and document exceptions rather than silently weakening privacy.

## 8. Provider adapters and authentication

Retain replaceable local Codex/Claude and existing provider abstractions. Pin official runtime versions/digests and protocol fixtures. Preserve unmodified proprietary binaries and all required supported authentication methods. Do not use binary patching, token scraping, unofficial inference endpoints, or central subscription proxies.

Prefer official provider-managed auth and supported device/headless login. Demonstrate sign-in and reauthentication from a browser on another computer. A callback to that browser's localhost does not reach the appliance. No terminal should be required for the qualified customer flow.

Codex App Server local stdio is the default candidate for deep integration. Recheck current documentation: it contains an experimental/unsupported-production warning for the command/WebSocket transport. Do not expose the provider server as Whombat's relay API or claim a support guarantee from choosing stdio. Examine current documented Business/Enterprise automation credentials where relevant.

For Claude, reconcile current unmodified-binary hosting conditions with SDK/third-party subscription restrictions for the exact workflow. Technical login success and billing behavior do not establish commercial permission. Switching SDK to CLI is not a legal workaround.

Maintain eligibility by provider × authentication mode × workflow: personal interactive, named-owner automation and permitted organization automation. Record dated evidence and unresolved classification. Implement adapters and synthetic tests while commercial modes remain gated if necessary.

Every run identifies its credential owner. Staff departure, quota exhaustion, revoked auth and provider outage produce distinct states. No silent identity reassignment or paid API fallback. Provider self-updaters must not race appliance releases; use supported version control/update behavior and detect drift.

## 9. Updates and database safety

Implement a durable local state machine:

Assigned → Downloading → Verified → Staged → WaitingForSafeBoundary → Activating → Verifying → Healthy.

Persist transitions crash-safely, with current/candidate/known-good tuples, maintenance lock, attempt limits, health evidence and quarantine of bad candidates. Download alongside current work; verify before executing; check capacity; never remove the only working recovery generation to stage another.

Use a maintained TUF implementation or an equivalently justified maintained metadata system for signed authorization, freshness, consistency and key rotation. Artifact signatures alone do not define rollout assignment. The privileged helper verifies policy itself and accepts only typed operations on authenticated release identities, never arbitrary commands, paths, URLs or Nix expressions.

Keep production root/release signing separate from normal CI and control credentials. Use development roots for tests. Exercise replayed/expired metadata, stale clocks, key rotation and long-offline devices. A failure to verify an update must not stop the healthy installed runtime.

Start with two update classes: frequent runtime/provider bundle activation without normal reboot; infrequent host/manager maintenance. Component versions remain independent, but only approved tuples can activate.

Implement fleet rollout through internal devices, consenting pilot/canary cohorts and progressively larger groups. Define promotion evidence, minimum observation windows, failure thresholds, automatic pause, release quarantine and an operator emergency stop. A pause prevents further activations; it does not interrupt healthy installations or silently restore their data. Test a fleet-wide faulty candidate and recovery from control-service unavailability during rollout.

Drain new turns, reach documented safe boundaries, persist approvals/jobs, and hand over. Do not promise arbitrary live processes survive reboot or zero downtime on one device. Bound deferral and explain when a task prevents maintenance; do not kill acknowledged work to satisfy a cosmetic deadline.

Routine migrations use additive/expand-migrate-contract changes with explicit old/new reader AND writer compatibility. Introduce a safe schema compatibility model to replace the current prefix-only startup assumption. Test old/new binaries against actual intermediate schemas and realistic data. Keep one migration authority, lock discipline, resumable backfills and PostgreSQL-major upgrades as a separate class.

Before an incompatible migration, quiesce affected writes/external effects, capture a consistent checkpoint and verify before accepting new work. After newer acknowledged writes or external effects, use compatible code rollback or forward repair; never silently rewind the database/files.

Separate local runtime health from relay, cloud or provider availability. Do not use paid model calls as required health probes.

The manager checks updates independently of the application/relay/database. Its supervisor and known-good recovery path survive a broken manager binary. Guard network changes with timed connectivity rollback. The helper remains minimal, separately permissioned and infrequently changed.

## 10. NixOS, boot and physical recovery

Pin stable Nixpkgs inputs and build closures centrally. Appliances receive prebuilt artifacts; they do not build upstream latest or evaluate arbitrary project Nix expressions as root. Keep secrets out of Nix store/build inputs, images, public caches, logs and CI.

Use one explicit persistent-state layout and owners for application data, PostgreSQL, workspaces, per-identity credentials, management journal and backup staging. Reserve boot/recovery capacity.

Inspect the selected revision's boot support. As reviewed on 25 September 2026, upstream release notes place systemd-boot bootCounting integration in upcoming 26.11; do not assume it is in the pinned stable release. Qualify a maintained integration/backport or alternative without relying on an untested unstable fleet.

Implement boot attempt limits, meaningful local blessing, watchdog restart and known-good fallback. Qualify Secure Boot, encrypted persistent storage, TPM-assisted unattended unlock and customer-held disk recovery. Both candidate and fallback must unlock and run a compatible runtime. Test firmware/TPM changes and reset. Do not equate old Nix generations with mutable-data snapshots.

Produce VM tests and a runnable hardware qualification procedure. Only actual hardware evidence can qualify power loss, watchdog, firmware and TPM behavior. Never mark those passed because a VM booted.

Provision unique keys, machine identities and claim material. Define factory reset, refurbishment, secure erase, failed-storage return/RMA and ownership transfer. No hidden permanent SSH support account.

## 11. Backups, replacement and service exit

Implement complete, encrypted off-device backup with one qualified destination first. Inventory database, attachment data, local repository objects/refs, unpushed commits, uncommitted/untracked files, configuration, memory, relevant provider session state and recovery material. Identify caches separately. Preserve integrity/audit verification. State when provider reauthentication is required.

Coordinate database/files consistency; do not pretend a live filesystem copy and independent database dump form one consistent checkpoint.

Keep decryption/recovery under customer control. Add deletion-resistant retention enforced outside the appliance. Appliance backup credentials cannot delete retained copies; pruning/deletion authority is separate. Test malicious deletion, overwritten data and forged snapshot metadata against the chosen backend. Do not prescribe object locking without testing backup-tool maintenance compatibility.

Show last success, coverage, age, failure and recoverability in the client. No configured destination means explicitly unprotected, not “backups enabled.” Implement restore drills and measurement of recovery time/backup age; do not invent an SLA.

A replacement obtains a fresh management identity. Restore first in quarantine with schedules/outbound effects disabled. Reconcile local owner/revocation state, keys, provider tokens and external outcomes. Before activation, address the old appliance through confirmed decommission, credential rotation/revocation or a documented execution-lease policy.

Relay revocation alone cannot stop an old machine's direct provider/Git calls. Define offline execution versus revocation tradeoffs; do not claim exactly-once external behavior.

Provide a restricted customer-key-authorized recovery/export utility that works without Whombat cloud, including a signed recovery environment where needed. It is not a normal locally hosted UI. Billing suspension never wipes data or interrupts an in-flight transaction. Preserve export and recovery; document any future entitlement policy separately.

## 12. Client experience and cloud operations

Preserve current visual/interaction references unless adapting a flow is necessary. Add clear claim, local trust, connection, update, backup, recovery and provider-account states. Keep technical implementation jargon out of normal customer journeys.

Use immediate local interaction and explicit pending/accepted states. Key query caches, decrypted resources and local persistence by organization, appliance, user and authorization generation. Clear compliant clients on sign-out and when revocation is received, including at next connection; prevent cross-device/account leakage. Do not promise remote erasure of already downloaded data or offline/malicious clients.

Support current and previous wire-protocol major as an initial policy, with a proposed minimum 90-day secure migration overlap. Validate actual cadence, long-offline devices and old mobile clients. Negotiate capabilities, supply safe update explanations and intermediate upgrade paths. Prefer one maintained backward-compatible frontend; retained builds must have security floors and bounded lifetime.

Place APNs/Firebase product credentials in control service. Devices submit authenticated rate-limited opaque notification requests; cloud sends generic alerts. Fetch details through the secure channel. Test native background suspension, permission denial, wake-up and notification taps. Separate push-provider success from content-session success.

Use field-allowlisted metadata and finite retention. Customer-approved diagnostic bundles are generated locally, previewable, scoped, expiring and audited. No automatic raw logs, environments, SQL text, prompts or file paths in support telemetry.

Deploy development and production with distinct cloud accounts/credentials, enrollment identities, signing roots/policies, auth audiences, OAuth registrations, databases/storage and push credentials. Sibling subdomains alone are insufficient. Separate frontend/release publishing authority from routine control-service operators.

Provide cloud infrastructure definitions, control-data backups, relay recovery/draining, certificate rotation, capacity/cost measurements and incident runbooks. Keep the first deployment operationally small: one EU region with recovery, managed primitives where appropriate, no Kubernetes/distributed log/active-active state without demonstrated need.

## 13. Delivery phases — continue through all implementable phases

**A. Baseline and contracts.** Inventory, preserve history, record decisions, define repos/package ownership, protocol, release schema, trust boundary and tests. Create independently buildable projects.

**B. Working secure vertical slice.** Use the actual migrated UI/runtime, local database and relay/control stack. Claim, connect, submit one task, approve if needed, stream results, lose connection and resume without duplication. Run synthetic provider deterministically and one real permitted provider flow when authorized credentials are available.

**C. Update and restore slice.** Stage signed candidate, drain, activate, verify, deliberately fail, recover; exercise schema compatibility and restore complete encrypted state. Prove independent manager recovery.

**D. Full feature migration.** Complete the parity matrix across web/native/resources/collaboration/approvals/schedules/integrations/auth. No leftover content traffic bypassing encryption.

**E. Appliance and operational delivery.** Build images, VM fault tests, enrollment/provisioning, cloud deployment definitions, backup deletion protection, independent recovery/export and hardware test tooling.

**F. Integrated candidate and independent review.** Run all available cross-repo gates, fix findings, pin a release candidate, preserve validation evidence and prepare a precise pilot/cutover package. Complete remaining implementable work even if real hardware or legal classification remains externally blocked.

Do not defer B until each repo has been independently “completed.” Integrate early; a directory tree is not a working product.

## 14. Required verification

Use real disposable PostgreSQL and actual cryptographic/session code. Synthetic providers are appropriate for repeatable execution tests, but never describe them as proof of real provider login or commercial permission.

At minimum verify:

1. Clean checkout/build of each repo and integrated startup from the pinned manifest.
2. Enrollment/recovery, wrong appliance, reused claim, unenrolled client, last-owner protection and cloud-reset bypass rejection.
3. Hostile relay/control routing authority cannot decrypt, substitute peers or authorize content access under the stated trusted-client boundary.
4. Tamper, replay, reconnect, session rekey, frame limits, slow consumers and traffic saturation.
5. Commit followed by lost acknowledgement; duplicate request; same ID with changed payload; cancellation races; snapshot fallback after event retention.
6. User/account/appliance switching and revocation across chat, files, search, collaboration, caches and notifications.
7. Browser close, mobile suspension, relay restart and provider outage during accepted work.
8. Sandbox failures, malicious project tools, forbidden credentials/sockets/LAN, orphan worker and workspace contention.
9. Unmodified official-provider login from a remote browser, persistence across update, expired auth/quota/owner departure and no hidden paid fallback.
10. Invalid release/signature/metadata, corrupt download, power/process failure at every state transition, full disk and stale clock.
11. Bad runtime before/after migration, newer-schema rollback, post-acceptance recovery without silent data loss, failed manager and incompatible host/runtime tuple.
12. VM boot fallback; distinct recorded hardware tests for watchdog, TPM, Secure Boot, firmware and actual power loss.
13. Complete restore including unpushed/uncommitted work; deletion-resistant backups; forged retention metadata; replacement quarantine and old-device reconciliation.
14. Complete feature/permission parity and no plaintext ingress/resource bypass.
15. All available unit, integration, browser, native and repository-mandated quality gates; visual/accessibility checks on changed flows.

Record exact commands, versions, manifest, fixture conditions and outcomes. For performance, measure p50/p95/p99 and failure rates: target under 100 ms p95 warm regional encrypted echo and under 5 ms p95 relay queue/forwarding per traversal at a stated load; these are proposed targets, not existing guarantees. Test bulk traffic interference, reconnect storms and concurrent builds.

Never substitute unrun tests with written assertions. If iOS tooling, hardware, credentials or security assessment is absent, name the specific unverified claim and provide the executable test/runbook.

## 15. Final deliverables and stopping rule

Deliver:

- Implemented repositories, branches/commits, remote URLs where created, and one exact integration manifest.
- A documented single command to start the local integrated development environment, another for its main validation suite, and a scripted acceptance demonstration.
- Buildable cloud components, appliance image/VM target, provider/runtime bundles, signed-with-development-keys update fixtures and recovery tools.
- Feature parity and requirement matrices with evidence, migration dry-run/import tooling, reversible cutover plan, release/rollback/backup/restore/support runbooks.
- Updated architecture, protocol, threat model, key-custody table, compatibility policy, provider eligibility register and security/privacy/operator documentation.
- Honest list of remaining external release gates: sold-hardware qualification, applicable provider/legal/product obligations, production credentials/signing and live deployment authorization. Name owners/actions where known; do not invent approval.

Keep licenses, software inventory/SBOM, provenance and vulnerability-response process reviewable. Recheck applicable CRA/privacy/hardware obligations with qualified review before commercial launch; do not claim legal compliance from code tests.

Do not finish with only a plan or scaffold. Finish when the integrated implementation and all available verification are complete, or when a genuine external blocker prevents a precisely identified remainder after all independent work has been completed.

Your final report should lead with what now works and how John can run it. Follow with repositories/commits, verification, remaining qualification and concrete next actions. Clearly distinguish “implemented,” “tested in this environment,” and “ready for commercial production.”

## 16. Primary references to recheck

These informed the 25 September 2026 review; they may change:

- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/enterprise/access-tokens
- https://code.claude.com/docs/en/legal-and-compliance
- https://code.claude.com/docs/en/agent-sdk/overview
- https://noiseprotocol.org/noise.html
- https://libp2p.github.io/js-libp2p/modules/_libp2p_noise.html
- https://github.com/libp2p/specs/blob/master/noise/README.md
- https://www.w3.org/TR/webcrypto/
- https://theupdateframework.io/docs/security/
- https://systemd.io/AUTOMATIC_BOOT_ASSESSMENT/
- https://nixos.org/manual/nixos/unstable/release-notes
- https://restic.readthedocs.io/en/latest/060_forget.html#security-considerations-in-append-only-mode
- https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app
- https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act

Begin with repository inspection and parallel specialist assignments, then proceed into implementation.
