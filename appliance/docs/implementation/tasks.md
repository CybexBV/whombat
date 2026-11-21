# Task graph, owners, branches and integration order

The orchestrator is the only writer of this ledger, the integration manifest, and merges. Specialists own
the files listed; they commit on their branch and never merge each other's work.

## Waves

| ID | Workstream | Repo / branch (worktree) | Owns | Depends on | Status |
|---|---|---|---|---|---|
| W1-CT | Contracts: standalone build, publishing, protocol/control/release schemas, JSON Schema + Go bindings, vectors | whombat-contracts `main` | all but `packages/secure-channel` | — | v0.1.0 80884c0, v0.2.0 b60b7c7 (V-04), v0.3.0 9f25425 (V-05), v0.4.0 034058d; v0.5.0 c2be837 (closes 0.5.0 backlog); 0.5.1 = secure-channel fixes |
| W1-SC | Secure channel qualification + `@whombat/secure-channel` | whombat-contracts `secure-channel` (`.worktrees/secure-channel`) | `packages/secure-channel`, `spikes/secure-channel`, `docs/decisions/secure-channel.md` | — | done (agent-reported): @libp2p/noise 17.0.3 pinned; Node, Chromium, Firefox, WebKit (docker), Hermes VM pass; 47 package tests; device run unrun; ADR proposed pending independent review → merging into contracts 0.3.0 |
| W1-RL | Relay (Go) | the relay `main` | whole repo | MA-05/06; later W1-CT Go bindings | done 42c54ca (+b1b5d1c JWKS path by orchestrator), contracts 0.3.0 Go bindings, V-06 |
| W1-CL | Control service | whombat-control `main` | whole repo | MA-*; later W1-CT 0.2.0 | done 9afec99 on contracts 0.5.0 (agent: check 20, test:int 74, clean clone); G-01…G-11 closed; minor R-01…R-04 for 0.5.1 |
| W1-MG | Manager, update helper, TUF release tools | the appliance `manager` (`.worktrees/manager`) | `manager/`, `helper/`, `release-tools/`, `docs/decisions/manager.md`, `docs/runbooks/updates*` | MA-11 | done, merged into appliance main fc53b5e (V-08); VM-only items → W2-NX |
| W1-DB | Parity inventory, schema reader/writer compatibility, legacy upgrade recovery | Whombat `managed/db-compat` (`.claude/worktrees/managed-db-compat`) | `apps/server/src/db/**`, `apps/cli/src/upgrade*`, `docs/managed/`, `docs/decisions/managed-db.md` | — | done 0ca4b6a (agent-verified: check 2180 tests, test:server 94/95 files [1 TMPDIR display test, fixed on runtime], test:cli 24, package:acceptance 42/42) → merged into managed/runtime |
| W2-APP | whombat-app standalone on vendored contracts; `@whombat/client` appliance session (requests, subscriptions, uploads, downloads, collab, resources); claim/trust/connection/update/backup/recovery/provider states; web + Android builds | whombat-app | whole repo | W1-CT 0.1/0.2, W1-SC | running |
| W2-RT | Whombat managed runtime: vendored contracts, session endpoint (Noise responder + relay client), allowlisted dispatcher, durable command receipts, event cursors/snapshots, enrollment/claim/recovery/pairing/revocation, owner remote admin + last-owner, manager admin socket (drain/resume/health), push requests via control, managed execution policy | Whombat `managed/runtime` | server/runner/cli managed code | W1-CT, W1-SC, W1-DB | running |
| W2-NX | NixOS flake/modules/image, persistent layout, users/slices, systemd units (manager/helper/runtime/postgres), boot counting + fallback, VM tests, provisioning + claim cards | the appliance `nixos` | `nix/`, `provisioning/`, `vm-tests/`, `docs/decisions/nixos.md` | W1-MG unit layout | done, merged into appliance main 7e36445 (ef5dde5); orchestrator VM re-run in progress |
| W3-SBX | Runner sandbox qualification on NixOS (bubblewrap/nsjail/systemd-run), per-identity credential homes, network policy (IPv4/IPv6/DNS/metadata/LAN), orphan fencing, workspace locks | Whombat `managed/sandbox` + appliance module | runner access code | W2-RT, W2-NX | done adcc083 (agent: check 850, test:server 781, clean install). Env allowlist MS-18. Appliance items (cgroup delegation, nftables wall, quotas) → W2-NX; provider availability/pins/self-update → W3-PV |
| W3-BK | Backups (restic + append-only rest-server), consistent checkpoint, coverage, restore drills, replacement quarantine, recovery/export utility | the appliance `backup` + Whombat hooks | `backup/`, `recovery/` | W2-RT, W2-NX | done, merged (V-10). NixOS btrfs /persist + backup modules done (nix/modules/backup.nix, nix/profiles/recovery.nix; backup/nix removed); runtime backup-uid drain, `writes` barrier, quarantine mode, backup session ops |
| W3-PV | Provider adapters: pinned Codex/Claude versions, remote-browser device login, eligibility register, credential-owner states, self-updater control | Whombat `managed/providers` | agent-runtime provider auth | W2-RT | done f9a23f4 (includes runtime 779177c + sandbox adcc083; contracts 0.5.0; agent: check 927, test:server 808, test:cli 25, clean clone). **managed/providers = Whombat candidate branch.** Real-account sign-in = unrun qualification |
| W3-INT | Integration harness: one-command local environment, validation suite, acceptance demo, perf measurements, manifest | the appliance `integration` | `dev/`, `harness/`, `manifest/` | W2-* | running (appliance branch integration) |
| W4-SEC | Independent security/integration review of trust, permissions, updates, recovery; fixes by owners | read-only + fix branches | — | W2/W3 | part 1 done (fixes: relay done V-18; Whombat, control in progress); part 2 (updates/recovery) running |

## Integration order
1. W1-CT 0.1.0 tarballs → W2-APP and W2-RT start (they vendor the tarballs).
2. W1-SC merged into contracts main → contracts 0.2.x publishes `@whombat/secure-channel` + `@whombat/protocol`.
3. W1-RL/W1-CL switch to published Go/TS bindings; conformance vectors pass in each.
4. W2-RT + W2-APP + relay + control → **vertical slice B** (claim, connect, task, approve, stream, reconnect
   without duplication) run by W3-INT's harness.
5. W1-MG + W2-NX → **update/restore slice C** in VMs.
6. W3-* → feature parity (D) and appliance delivery (E); W4-SEC → candidate (F).

## Cross-repo change procedure
Contract change → PR/commit in whombat-contracts with vectors → tag + tarballs → each consumer bumps its
vendored version in one commit (lockfile included) → integration manifest updated by the orchestrator after the
tested combination passes.

## Contract backlog for 0.4.0 (decided, not yet released)
- appliance.status `providers[]` with distinct credential states (from W2-APP).
- Ephemeral client ops `presence.typing`, `presence.set` (no receipt).
- Collab stream inner `[u32 len][bytes]` message framing, ≤16 MiB per Yjs message.
- App-level error codes in `error.details.code`, enumerated list.
- `unsupported_version.details.supported {min,max}` + appliance version.

## Contract backlog for 0.5.0 (decided)
- `enroll.claim` carries control's `claimId`; `claim.claimed` device report carries `claimId` again (anti-squatting: control resolves exactly the claim the enrolling client holds).
- Assignment poll distinguishes `none` from `unchanged`.
- Push `ref` must be random or a keyed hash (it reaches Apple/Google).
- Type exports for EmergencyStop, EntitlementState; passkeys, sign-out-everywhere, invitations (accept/list/remove), org audit log, precise error reasons (replace `x-whombat-reason`), operator endpoints (release registration, drain, retire, entitlements, manual wave promotion), pinned assignment-keys document for the manager.
- Secure-channel review fixes → 0.5.1.
- Team-agent credential owner (`credentialOwnerAccountId`, DispatchContext owner/provider/authMode, set op).
- Backup op error codes (MR-19) and `quarantined` in GET /facts.
- Local IPC additions: forward-repair update state (not RolledBack→Quarantined), backup checkpoint API (`POST /v1/checkpoints`), lock / update-status / network endpoints, runtime facts for `status.report` (active sessions, recovery kit, last backup).
- Backup session ops for owners (shapes: Whombat docs/decisions/managed-runtime.md MR-19): configure destination, show/download recovery material, back up now, drill status (W3-BK).
- Session upload pipelining rule: announcements for contiguous offsets may precede acks, bounded by credit; acks in order; non-contiguous = protocol error (fixed in runtime bf456bf).
- Manager sends its drain id as `underDrain` in checkpoint requests.
- Go bindings for `checkActivation` / `updateClass`.
- Runtime admin socket `GET /facts` → `{v:1, activeSessions, claimed, claimReported, recovery{enrolled, kitVerified}, revocations{pending, applied}, draining, relay}` (Whombat MR decisions, f8ddd4c).
- Claim secret hash helper + vector: `b64url(SHA-256("whombat-claim-secret/1\n" + deviceId + "\n" + normalized))` (provisioning's claim.json format, adopted as standard).

## Operations log
- 2026-09-25: 429 incident #2 at 3 concurrent agents (appliance fixes + mobile stopped; harness continued); resumed both. Earlier: all 10 concurrent agents hit API 429 rate limits; resumed in batches of 5 (harness, app, nixos, backup, sandbox first; then providers, secure-channel fixes, runtime follow-ups). Keep ≤ 5–6 concurrent. **2026-09-25 later: John set a maximum of 3 concurrent agents (usage).**
- W2-RT scope finished at 97b3545 (V-09); follow-ups done at 779177c (upload pipelining fix, previews, backup ops, quarantine, audit-verify; agent: check 753, test:server 775, test:cli 25, package:acceptance 42/42, clean install).
- 2026-09-25: contracts 0.5.0 released. Whombat: managed/runtime (779177c) and managed/sandbox (adcc083) frozen; **managed/providers is the single Whombat writer** and adopts 0.5.0. Control adopts 0.5.0; app adopts 0.5.0; appliance Go (manager/backup/provisioning) adoption pending a slot.
- Running (branch manager-0.5) — **appliance Go 0.5.0 adoption** (manager owner): vendor contracts 0.5.0 Go for the root module; manager conformance (ForwardRepairRequired, claimId, assignment `result`, AssignmentKeys document from a TUF target, Go compat functions, `underDrain`, status.report from runtime `GET /facts`, MTU bounds); tufrepo `add-assignment-key --kid --public-hex [--not-after]` publishing the AssignmentKeys target (control holds the private key; release custody authorizes it); backup LocalError + strict CheckpointRequest.

## Contract backlog for 0.5.1
- Secure-channel review fixes (branch secure-channel-fixes) incl. RN bufferedAmount + AbortSignal.throwIfAborted.
- MA-17 credential source `{kind:'account', accountId} | {kind:'org', credentialId}` (extends CT-26); org credential ops.
- Control: GET emergency-stop; CONTROL_REASONS additions (already_claimed, invitation_email_mismatch, device_exists, bad_time, too_large); status code conventions.
- Providers: ProviderStatus.expiresAt/verified, managed.provider_* / provider.* codes, provider.signed_in/out audit events (if not already in 0.5.0).
- W2-APP: web managed journeys done at 8f669f7 on contracts 0.5.0 (agent: clean-clone check 966, visual 219, managed e2e 25, hosted CSP e2e; Android emulator stack pass incl. native ChaCha20 via react-native-quick-crypto 1.1.7: 2.71 MiB/s down, 1.73 MiB/s up). Next: Android managed journeys, web push via control (MA-18), legacy /ws realtime test.
- W2-APP agent context exhausted after its final report (8f669f7); stopped and replaced by a fresh mobile/notifications agent (Android managed journeys, FCM + web push via control, legacy /ws test).
- Queued after contracts 0.5.1: **control** adopts 0.5.1 (AssignmentKeys notBefore/notAfter shape, Web Push sender + `GET /v1/push/vapid`, credential-source-related nothing) ; **appliance Go** adopts 0.5.1 (AssignmentKeys state machine); **Whombat** (managed/providers) adopts 0.5.1 (credentialSource ops, runner sign-in routes, secure-channel /2); relay bumps Go contracts (FrameDecoder not used by relay — optional).
- W2-NX done on branch nixos (30 commits; agent: 4 VM checks pass — appliance-basic 13, install-boot-luks 7, manager-units 6, sandbox-backup 5 — plus provisioning, build, aarch64 eval, image-no-secrets). Pinned nixos-26.05 c508844; lanzaboote v1.1.0 boot counting (26.05 systemd-boot lacks it). Merging main (contracts 0.5.0) before orchestrator merge.
- Runtime requirements from NixOS (for the Whombat 0.5.1 adoption): sd_notify watchdog pings (or watchdogSec=null), admin socket at /run/whombat/admin.sock 0660 group whombat-admin, credentials via systemd LoadCredential (WHOMBAT_MASTER_KEY_FILE, WHOMBAT_CONTENT_KEY_FILE, WHOMBAT_CLAIM_FILE), bundle bins whombat-server/whombat-runner/whombat (NX-20).
- Manager requirements from NixOS: re-activate known-good runtime after host fallback; delete failed candidate generations before staging (helper op).
- Security review part 1 done (1 high, 5 medium, 7 low, 4 info; reviews/security-part1-trust.md). Fix routing: Whombat → new branch **managed/hardening** (from managed/providers f9a23f4; now the single Whombat writer; also NX-20 runtime requirements + contracts 0.5.1 adoption); relay → M-5 + M-4 relay part; contracts 0.5.1 → claimVerifier/claimProof, secret ops, recovery rotation; control → claimProof + L-5 `next` redirect after 0.5.1.
- Contracts 0.5.1 released (9b932b4, V-17); pushed. Consumers adopting: Whombat managed/hardening, app (mobile agent), control, manager+provisioning. Relay: no change needed.
- Control on contracts 0.5.1 (85b0bce/546c76e/5434f07): claimProof (M-3), claim-verifier registration, Web Push sender + VAPID, AssignmentKeys with notBefore, `next` redirect fix (L-5). Contract gap R-05: MagicLinkRequest.next pattern should reject `//host` (0.5.2).

## Contract backlog for 0.5.2
- `push.resolve {ref} → {link}` session op (MA-20).
- `MagicLinkRequest.next` pattern: same-origin path only (reject `//host`, backslash, scheme) (control R-05).
- `enroll.pair.lookup` op + fingerprint; approval requires lookup (Whombat MR-32, L-4).
- `CredentialMeta` fields: last run's `signal`, `login`, `creatorAttested`.
- Optional `cachedAccountId` in `hello` (I-3).
- Whombat managed/hardening done at 5ee64bc (security part-1 fixes, OOM fix + soak:managed, NX-20 runtime requirements, pnpm bundle:runtime, contracts 0.5.1); orchestrator clean-clone verification running. **managed/hardening = Whombat candidate branch.**
- **Regression (secure-session/2, found by W3-INT hostile-relay scenario c on the 0.5.1 candidate):** a relay-replayed appliance→client record (#3, right after welcome) no longer fails the connection; the session stays `open` and requests hang until NotDeliveredError — silent DoS. On 0.5.0 the connection failed and reconnected. Queued for the secure-channel author (next free slot): receive path must fail the connection deterministically on any authentication failure; client `secureWire` must surface it; regression test for both. Repro: `WB_MGD_PINS=manifest/candidates/0.5.1.json harness/validate --no-build --skip-gates --scenarios scenarios/c-hostile-relay.scenario.ts`. Blocks promotion of the 0.5.1 candidate (→ contracts 0.5.2, with the 0.5.2 backlog).
- 0.5.1 candidate so far: 17/17 gates; scenarios a,b,d,e,f,g,h pass; c fails (above); slice C re-running; soak pending.
- Mobile agent done (whombat-app ed80bea, V-24). Open app items: re-enrolling a removed device with a new key (copy still says "ask to be let in"), QR decode on device, real FCM/Web Push delivery, iOS/ARM.
- Replay regression root cause: whombat-app client race (a connection that fails between accepting the welcome and `conn = c` is installed closed; no retry). Channel already failed it (DECRYPT_FAILED); channel hardened anyway on contracts `sc-replay-fix` (6d2a975, 7070375; 103 package tests, root check 710, browser, hermes, mutation 46/53). App fix + regression test being applied to whombat-app main. `sc-replay-fix` goes into contracts 0.5.2 with the 0.5.2 backlog.
- App replay-race fix whombat-app ba258fc (pushed). Contracts 0.5.2 in progress (sc-replay-fix + 0.5.2 backlog). Harness to re-pin app ba258fc after its soak.
- Contracts 0.5.2 released (25e23ea, V-26; no wire change). Adoption: Whombat managed/hardening (running), app (queued: pairing fingerprint lookup/approve, push.resolve taps, cachedAccountId, isSafeNext), control (trivial: use isSafeNext; queued).
- Whombat managed/hardening on contracts 0.5.2 at 5c7e157 (agent: check 940, test:server 839, test:cli 25, clean clone, soak +1 MB); pushed (PR #1 head). App + control 0.5.2 adoption agent started.
- App 0.5.2 (whombat-app 4c831b2: pairing fingerprint lookup/approve, push.resolve taps, cachedAccountId, isSafeNext, re-setup of removed device; agent: check 1000 clean clone, e2e managed 27, visual 219; Android not run on emulator) and control 0.5.2 (a1d74d1: isSafeNext; check 22, test:int 79) pushed. Gap: recovery-kit enrollment screen missing (last-owner recovery from the app) → assigned.
- App recovery-kit enrollment (whombat-app d89ddcb; AP-41; agent: check 1007 clean clone, e2e managed 30, visual 219). Final candidate must pin runtime managed/hardening 5c7e157 + app d89ddcb, then an Android emulator run of pairing-with-fingerprint, push.resolve tap, re-setup and recovery-kit enrollment.
- Appliance security-fixes-2 merged into main (V-28, V-29): review part 2 all findings + re-review N-1…N-7 fixed and independently re-reviewed; manager C5/C6 defects fixed. Whombat recovery code fix 52c3ff2.
- Contracts 0.5.3 released (V-34): re-enrollment (MR-23 gap), diagnostics (R-70), client floor (R-68), reproducible tarballs. Runtime + app adopting. Manager/helper: pass clientFloor (UpdateFacts) — note first 0.5.3 release must ship without a floor. 
- Parity audit (`docs/archive/parity-final.md`): 26/26 bypasses closed; 11 gaps. Routing:
  - app: G-01 invites/members/second person (hosted UI → `enroll.invite.*`, control org invites, remove localhost invite links), G-02 `packs.agent`→`packs.agentPacks`, G-03 exports + any >64 KiB read via export stream (too_large fallback), G-06 appliance owners UI (`admins.*`), G-08 `providers.org.remove` UI, G-04 client side.
  - runtime: G-05 bundled pack install, G-10 links (no localhost; hosted-UI links with appliance route), G-11 pack stdio tool servers run in the managed sandbox (security), G-04 appliance side, G-09 workspace picker (low).
  - contracts 0.5.4: G-04 pack-archive upload stream.
  - G-07 diagnostics: in progress (0.5.3).
- App batch (whombat-app 3aab47c): 0.5.3/0.5.4 adoption, G-01 invites (control org invite + one-time appliance join link), G-06 owners, G-02, G-03 export streams + too_large fallback, G-08, MR-45 links; agent: check 1024 clean clone, e2e managed 41, visual 219; real-stack not run yet. Protocol lacks enroll.invite.list (minor, 0.5.5 candidate). Phone has no pack import screen (web only).
- Final-candidate defects (W3-INT 0.5.4 run): manager facts only at start/transitions → resend on runtime recovery + periodic (appliance agent); runtime WHOMBAT_APP_URL required in managed mode (appliance agent, Whombat branch); app packs.export >64 KiB corrupt (export stream = raw file bytes; app saves as download) → fresh app agent. Contract doc note for export-stream payload semantics → next contracts release (0.5.5, with enroll.invite.list).
- 2026-09-26: on John's instruction, managed/hardening merged into Whombat main (89ab1c6; pnpm check 938, test:server 852), pushed, and deployed to dev.whombat.com (cold backup ~/.cache/wb-tmp/dev-backup-pre-managed-20260926T044835Z.tar.gz; migrations 0028–0036 applied; health ok; web app from pinned whombat-app 0.1.0). Production untouched.
- 2026-09-26 (licence assignment, MA-23…MA-25): contracts 0.10.0 (CT-76…CT-79, V-40) → control d3a0cdd/d92efe0 (CL-37…CL-46, V-41), Whombat runtime e45dbf7 (MR-55…MR-61) + app 0.3.0 vendored d5a7765, whombat-app 0.3.0 079a87f (AP-63…AP-74), appliance main dab4806 (MG-34…MG-38, NX-38, IN-39…IN-45); candidate `manifest/candidates/0.10.0.json` validated (V-42); proprietary notices in the four closed repos (LC-19). At most 3 agents at a time (contracts, api, app; then runtime, appliance).
