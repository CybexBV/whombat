# Threat model (managed appliance)

Draft by the orchestrator, 2026-09-25; to be challenged and extended by the independent review (W4-SEC).
Scope follows assignment §5: what E2EE protects, and what it does not.

## Assets
Workspace content (messages, files, canvases, repositories, memory, prompts, provider output), local
authorization state (accounts, endpoint keys, grants, approvals, audit chain), provider and GitHub credentials,
appliance identities (management, content), recovery key and backup password, release signing and assignment
keys, admission keys, push credentials, customer metadata held by control (org, devices, emails).

## Trust boundaries
1. Client endpoint (browser profile / app install) ↔ appliance runtime: Noise XX, appliance PeerId pinned at
   claim; endpoint identity enrolled locally. **Trusted:** both endpoints and the code they run.
2. Relay: untrusted for content; trusted only for availability.
3. Control: untrusted for content and authorization; trusted for routing, directory, push delivery and update
   *assignment* (constrained by TUF-approved tuples).
4. Release supply chain (TUF root/targets custody, CI builders, Nix cache): trusted supplier.
5. Hosted frontend publishing (DNS, CDN, service worker, `app.<env>` build): trusted supplier.
6. Runner sandbox: project code, repository hooks, dependencies, skills, MCP servers are **untrusted** relative
   to the appliance.
7. Providers (Anthropic/OpenAI/GitHub/Google): see content sent to them by customer choice.

## Adversaries and required outcomes

| # | Adversary | Must not be able to | Mechanism | Test (assignment §14) |
|---|---|---|---|---|
| T1 | Compromised relay | read/alter content, substitute the appliance, impersonate a client, grant access | Noise XX with pinned appliance PeerId; enrolled endpoint keys checked by the appliance; AEAD; relay only splices | 3, 4 (hostile relay harness: tamper, replay, substitute peer) |
| T2 | Compromised control API/DB/routing | read content; enroll endpoints; authorize local ops; activate unapproved releases | Tickets admit only (MA-06); enrollment/claim secrets never pass through control in the clear; assignment limited to TUF-approved tuples verified by manager and helper | 2, 3, 10 |
| T3 | Cloud account takeover / email reset | gain local content rights | Local endpoint enrollment requires existing trusted endpoint or recovery key | 2 (cloud-reset bypass rejection) |
| T4 | Stolen claim card before claim | claim without the device window (where the hardware provides one); claim twice | Atomic one-use secret, rate limits, first-wins pending claim; physical claim window (hardware-qualified) | 2 |
| T5 | Attacker with a revoked endpoint | continue accessing | authzGeneration bump closes sessions; enrollment check per session; compliant client clears caches. **Not solved:** data already downloaded, offline or malicious clients | 6 |
| T6 | Malicious project code in a task | read other users' files, provider logins, DB credentials, master key, SSH agent, Docker/root sockets; reach LAN/metadata | per-task sandbox (uid, mounts, seccomp, network policy incl. IPv6/DNS/metadata/LAN), per-identity credential homes, fail closed | 8 |
| T7 | Stale/orphan worker after lease loss | write to workspaces or repeat effects | fencing tokens checked at write points, process-group termination, workspace locks | 8 |
| T8 | Replayed/expired/forged update metadata; compromised control assignment | install unapproved or rolled-back release | TUF freshness/consistency/rollback; helper re-verifies; quarantine | 10 |
| T9 | Network attacker on LAN/Internet | reach appliance services | one inbound listener, the runtime's direct port 4480, from the LAN's private addresses and `tailscale0` only, admitting a session only for an enrolled device's Noise key (Whombat HE-50, NX-440); otherwise outbound TLS only; loopback/unix sockets internally | 1 |
| T10 | Malicious backup destination / appliance compromise deleting backups | delete or silently alter retained backups | append-only destination, prune credential off-device, restic integrity + authenticated snapshot metadata checks | 13 |
| T11 | Thief with the appliance disk | read data at rest | LUKS with TPM-sealed key bound to measured boot + customer recovery passphrase (hardware-qualified) | 12 (hardware) |
| T12 | Uploaded HTML/SVG in previews | run script with the hosted UI's origin | sandboxed iframe without same-origin, download disposition, no navigation to blob URLs | 14/15 |
| T13 | Metadata observer (relay/control operators) | learn content | they do learn timing, sizes, appliance↔org association, online state, push timing — accepted and documented | — |
| T14 | Unpaid use of the appliance software (copied image, box kept after cancellation, self-installed box without a subscription) | run paid features (agents, automations, growth) for long | signed licence tokens from control, pinned key set, 14-day tokens + 30-day grace, time high-water mark, device limit and self-install gate at claim, terms at claim (LC-01…LC-19); owners with root can patch it out (terms forbid it) | harness scenarios l-licence |
| T15 | Compromised control (or anything between the website and the appliance) for website feedback | read a visitor's report, or redirect reports to a key it holds | the report is sealed in the browser (HPKE) to the key of a site card signed by the appliance's site key, whose fingerprint the owner's snippet pins (`data-key`); control stores and forwards opaque bytes and can only withhold or delay (availability); the frame refuses a card that fails the pin or the signature, and a parent its card doesn't list (MA-26, Whombat FD-01, FD-03, FD-28) | harness scenario o-feedback |
| T16 | Compromised runtime server process (e.g. a bug reached through an agent, a bridged MCP server or a Vault entry's remote end) | reach hosts on the customer's network beyond the admins' Vault list, or other ports on them; keep a connection to a network the admins removed | the runtime's outbound helper checks every call (Whombat VT-10…VT-13); under it, a kernel wall that opens only the listed networks and ports, for the server's uid only, validated again by a separate daemon with `CAP_NET_ADMIN` only, fail-closed, closing open connections when a network is removed (IN-58…IN-61, NX-40). **Not covered:** TCP 443 to any address, LAN hosts included, is open to every host uid (NX-22); only the runtime's helper keeps the server off private addresses there | VM `vault-wall` |

## Explicitly out of scope of E2EE (must be stated in product/security docs)
- A malicious or compromised **hosted frontend** (publishing, DNS, CDN, service worker) can exfiltrate
  decrypted content from users' browsers. Mitigations: separate publishing IAM, reproducible builds, SRI where
  possible, CSP, signed native apps; not solved by E2EE.
- A malicious **signed appliance release** is a supplier failure. Mitigations: offline threshold TUF root,
  staged rollout with observation windows, emergency stop.
- Providers see what customers send them.
- Previously downloaded data and offline/malicious clients cannot be remotely erased.

## Key custody

| Key | Generated | Stored | Rotation | Compromise response |
|---|---|---|---|---|
| Appliance management key | on device at provisioning | `/persist/identity/management.key` (0600 manager), encrypted volume | re-provision / rotate via control with old-key signature | control revokes device key; re-provision |
| Appliance content identity | on device at provisioning | `/persist/identity/content.key` (0600 runtime) | new identity requires re-pinning by clients via trusted endpoint or recovery ceremony | all endpoints re-pin; audit |
| Endpoint key | in client | browser IndexedDB / Expo SecureStore | re-enroll; revoke old | local revocation |
| Recovery key | in client at claim | customer-held kit (paper/file) | owner-initiated rotation (new kit, old revoked) | rotate; kit loss procedure |
| Backup repository password | appliance | sealed on appliance + in recovery kit | restic key add/remove | rotate + re-key |
| Admission signing key | control (KMS/secret manager) | control only | JWKS current/next/retired | rotate; relays reload JWKS |
| Licence signing key (LC-03) | control (KMS/secret manager; dev: `dev-init` keyring) | control only (`LICENCE_KEYS_FILE`); the public set is pinned in the appliance image (`/etc/whombat/licence-keys.json`) | ship the next key in a release's pinned set first, then switch control's `current`, then drop the old key in a later release (never fetched by devices) | rotate as above; a stolen key can unlock paid features on appliances, never data (the licence grants no access); **not generated yet** (production key ceremony, X-05) |
| Assignment key | control (separate secret) | control only | versioned in device trust config | rotate via TUF-distributed config |
| TUF root (threshold) | offline ceremony | offline hardware tokens | root rotation metadata | root rotation; fleet freeze |
| TUF targets/snapshot/timestamp | release custody / online timestamp | separate from CI and control | TUF delegation rotation | rotate via root |
| APNs/FCM credentials | provider consoles | control secret manager | provider-specific | revoke at provider |
| Development keys of every kind | repo `dev-keys`/testdata, labelled DEV | never valid in prod (distinct audiences/roots) | — | — |
