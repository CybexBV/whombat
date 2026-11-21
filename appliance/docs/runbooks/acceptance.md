# Validation suite and acceptance demonstration (W3-INT)

> Commands written `dev/<name>` are the maintainers' (`bin/<name>` in their private whombat-ops). Anyone can run
> the same code: `node harness/src/dev/<name>.ts` (`dev/prune` is `prune-copies.ts`, `dev/devbox` is
> `harness/src/devbox/main.ts`), after `pnpm install --frozen-lockfile` in `harness/`.

## `harness/validate` — the main validation suite

```sh
harness/validate                    # everything; writes harness/reports/<run>/ and reports/latest.{json,md}
harness/validate --skip-gates       # manifest + harness check + scenarios only
harness/validate --gates whombat-relay,whombat-api:test-int
harness/validate --scenarios scenarios/c-hostile-relay.scenario.ts
harness/validate --scenario-jobs 1  # serial scenarios on smaller hosts / when checking timing contention
harness/validate --no-gate-cache    # execute every repository gate even if matching evidence exists
harness/validate --jobs 1 --no-build --live app   # scenarios against a live app tree, the rest pinned
harness/validate --skip-gates --skip-scenarios --soak 30m   # soak only: steady traffic, RSS per service (IN-23)
```

Steps:

1. **Manifest.** When `manifest/product-manifest.json` is stale (pins moved), it is rebuilt from clean clones
   (`--no-build` skips that). Then it is validated against `@whombat/release` `ProductManifest` and the build report.
2. **Repository gates** (from the pins), each in a fresh `git clone --no-local` at the pinned commit
   after `pnpm install --frozen-lockfile`, unless a matching successful receipt is reused:

   | Component | Gates |
   |---|---|
   | contracts | `pnpm check`, `pnpm test:go`, `pnpm gen:check` |
   | relay | `make test` (race), `make lint` |
   | control | `pnpm check`, `pnpm test:int` |
   | runtime (Whombat) | `pnpm check`, `pnpm test:server` |
   | app | `pnpm check` |
   | appliance: entire Go module, including manager, backup and provisioning | `go vet ./...`, `go test -count=1 ./...` |

   Postgres-backed gates get the harness container (`TEST_DATABASE_URL`, `DATABASE_URL`), never the shared one.
   The backup tests get `WB_REST_SERVER`.
   Matching backup/provisioning checks are reported as covered by a successful root check of the same repository
   and commit with identical inputs. A failed/unselected root or different inputs runs the subset normally.
   Successful gates are cached privately in `WB_MGD_HOME/gate-cache` for up to seven days (256 receipts).
   Exact commits, commands, environment and tool/setup fingerprints must match and the original log must
   pass its checksum. Reports label reuse with the original timestamp/duration. Failures always execute again;
   `--no-gate-cache` disables reuse/saving successes; a fresh failure invalidates older matching evidence.
   The harness check and scenarios always execute.
3. **Harness** `pnpm check` (Biome, typecheck, unit tests).
4. **Scenarios** (`harness/scenarios/*.scenario.ts`, vitest) against the running environment (`dev/up` first if
   needed), with the real `@whombat/client` from the pinned Whombat (its `packages/client`), real control, relay, runtime and runner:

   Full fresh pinned local runs default to three environments: the baseline files in their existing order,
   updates (`i-updates`) and Whombat Link's plan (`l-link`) independently. Private homes/containers use suffixes
   `-scenarios-1/2`, and every service port is shifted by **+200/+300** (keep both ranges free; +100 is the DEV stack, +400 live agents).
   Each isolated report is validated and included in the parent report; its environment is purged afterwards.
   `--scenario-jobs 1` runs all files serially; `2` isolates updates only. Partial, live, public and reused
   environments stay serial. See `docs/decisions/ci-speed.md` for coverage and evidence rules.

   | File | Covers |
   |---|---|
   | `0-platform` | control/relay/JWKS/runtime session endpoint up; manager port tickets; client ticket rules; relay admission |
   | `1-claim-code` | Whombat Link and the claim, as a person does them (Whombat `whombat-link.md` LNK-13): the dev appliance made its identity itself and chose Link at its installer. Its screen shows a Link code and the account site's page; a wrong code is `link_code_invalid` and nobody has a ticket yet; the owner confirms the code (the free month starts, Link is on, the account lists the box, the code is used up for anyone else); the screen then shows four letters and the box's own page; CPace bound to another appliance PeerId fails; wrong letters rotate the code, then `claim_backoff` with the console counting down; claimed with its letters after the backoff (console “set up”), and a second claim is `claim_used` |
   | `a-vertical-slice` | slice B: magic link, the Link code confirmed and the claim on the box's own page (reuses the claim of `1-claim-code`), recovery kit, app session, burrow + agent, task with a dropped connection resumed from the cursor without duplicates, approval asked → approved → result |
   | `b-enrollment-negatives` | wrong appliance (pin mismatch, only Noise msg 1 sent), reused claim (`claim_used` through the relay too; the claim through control isn't this box's way), competing claim, unenrolled endpoint, cloud-reset bypass, last-device protection (the person can't remove their own last device) |
   | `b2-pairing` | contracts 0.5.2: pairing look-up shows the asking device's fingerprint; another fingerprint → `pairing_fingerprint_mismatch`, the pairing stays pending; the right one lets it in; a removed device's key is refused on both channels and the same device with a new key pairs in again; `hello.cachedAccountId` of another account clears the cache |
   | `b3-recovery` | recovery-kit enrollment: the person's new device enrolls through `recovery.enroll` and gets their app channel; a statement for any other account → `recovery_not_kit_owner`; an unconfirmed kit (probed inside the claim, between register and confirm) → `recovery_kit_unverified` |
   | `c-hostile-relay` | relay-observed bytes scanned for known plaintext; substituted appliance; tampered records both ways; replayed record |
   | `d-durable-commands` | lost acknowledgement → same id, no duplicate; same id other payload → `idempotency_mismatch`; unknown id; `snapshot_required` after runtime restart and after retention |
   | `e-revocation` | paired second endpoint revoked: live session closed with `revoked`, cannot reconnect; applied on the box at once, and nothing about the person's devices is reported to control |
   | `f-accepted-work` | browser close and relay restart during accepted work: completes exactly once |
   | `g-performance` | encrypted echo through the relay, full-stack request latency, bulk interference (load in another process), reconnect storm; the probe boxes are in the tester's Whombat Link, as a box is |
   | `h-uploads` | 20 MiB pipelined upload read back by sha256; upload interrupted halfway resumes from the stored offset |
   | `h2-push-resolve` | `push.resolve`: the person's inbox item resolves to its link (and control recorded a push to their handle); a ref of an item that doesn't exist and an unknown ref get the same `not_found` |
   | `h3-diagnostics` | contracts 0.5.3 diagnostic bundles: the person creates, previews (hash-bound), downloads through an export stream (same sha256), deletes; no names, emails, ids, paths or content inside; the `updates` scope with the manager's facts |
   | `h4-skills-exports` | contracts 0.125.0 (IN-342, IN-409): a 300 KiB archive of two skills staged (`skills.stage`), stream-uploaded (`skill-archive`), previewed (an export op, read through an export stream) and added into the skills of Hermes's one profile (Whombat OP-08), then in Settings → Skills; `packs.stage` answers `unknown_op`; a >64 KiB read (an imported skill's reference file, `skills.librarySkillFile` by name and scope) refused in one message and read through an export stream intact; the audit CSV; the skills removed after. Needs the runner (it serves Hermes's skills) |
   | `i-updates` | update slice C with the real manager + helper (fake activator bridged to the real runtime) on a box that follows its channel (Whombat LNK-20: the newest release its channel lists; control assigns nothing): C1 the channel's newest release taken, staged, drained at a safe boundary, activated, verified Healthy with accepted work completing once; C2 bad candidate rolled back to known-good; C3 an expand-migration fixture build (IN-25) migrates the real database, fails verification and rolls back to the older binary, which keeps reading and writing; C4 an incompatible (contract) candidate waits for a verified backup checkpoint, then migrates and serves; C5 expired or forged TUF metadata refused, fresh metadata recovers; C6 control away: the box still takes its channel's newest, and its Link is on when control is back; C7 a client security floor set by a release and lifted by the next |
   | `l-link` | Whombat Link's plan on a box (Whombat LNK-02…LNK-06, LNK-33): the licence is inert (no token held, no state computed, “Check again” refused, the agent answers); the free month takes two Whombats (`link_trial_boxes` for a third until one is taken out); the free month runs out without a card → the account is mailed, the box is in `grace` for seven days and everything works; after grace `ended`: no ticket (`link_off`), the relay route closed, the box still opens on its own page; the plan runs again → on, nothing set up again; the owner turns Link off on the box (no tickets) and on again (a new code, confirmed, the same account); account deletion at control; no client address in rate-limit buckets |
   | `m-guides` | contracts 0.11.0 (IN-49): the runtime switched to `WHOMBAT_GOOGLE=fake` for the file (restored after; blocked on a public instance); in the person's Chat the agent starts the email guide (the harness as the runner for that turn); `guides.act` Google → the connect card (a second act `guide_closed`); `connections.startGoogle` → `/connect/google?code&state`; `connections.finishGoogle` → `connected=google`, the connect card locked “Connected as you@example.com”, the result card, an active connection; a reload posts nothing; the state in no service log |
   | `p-vault` | contracts 0.125.0 (IN-63, IN-64, IN-408): a fake Home Assistant (MCP at `/api/mcp`; `HassTurnOn`, `GetLiveContext`) on a private address of this host, its /32 and port on the home network list; an MCP entry with a canary token, checked (reached, 2 tools on; loopback refused); switched on for the agent; the harness stands in for the runner: the person's turn names it and its keys (`runner.turnKeys`) bring its MCP server to Hermes (the fake's URL, the token in its headers, the tools that are on), nobody asked, the fake answers with them; RECENT USE and the audit log (list, get, CSV) have the use; switched off, the next turn lists it as off and holds no key; a removed network refuses; the canary only in the turn's keys, in no answer, frame, dispatch context, log or database row. Stops the runner for its turns: blocked on a public instance |
   | `r-browser` | contracts 0.125.0 (IN-90, IN-408): with the harness as the runner, the person's turn has Hermes's browser (`sites` null) while the agent holds “Use the browser” and none without it; a Vault login (an https sign-in page on a listed private address) switched on is named in the turn (`logins`, never the password) and `runner.loginSecret` gives the password to that turn's live lease only; after the turn, or switched off, no password; the password in no answer, dispatch context, log or database row. Browsing itself needs a live turn. Stops the runner: blocked on a public instance |
   | `s-skills` | contracts 3.0.0 (IN-91, IN-391, IN-409; Whombat OP-08): Settings → Skills on Hermes's one profile through the runner: the built-in skills in its `skills/`, plain categories, each once; one switched off is in the profile's `config.yaml` (`skills.disabled`) and on again; a learned skill is in the one list, readable, and removed; an edit goes through Hermes's scan (a dangerous one `skill_blocked`, the file unchanged); memory and the agent's notes are the person's (`USER.md` of the profile); a reported turn is in spend's totals, no by-agent rows. Stops the runner for the spend step: blocked on a public instance |

   A scenario blocked by a missing feature elsewhere is reported as `blocked: <component>/<feature>` (never
   passed); defects found in other components are listed under "Defects found".

Reports: `harness/reports/<run>/report.{json,md}`, `logs/`, `scenario-records.jsonl` (notes, measurements); only
`reports/latest.*` are committed.

## The pins of a commit

What is validated are pins: which commit of which component. For a commit of this repository they are the component
list, `manifest/components.json`, with that commit filled in:

```sh
pins=$(manifest/pins-at [<commit>] [--name <candidate>])   # default HEAD; prints the file it wrote
WB_MGD_PINS=$pins manifest/build
WB_MGD_PINS=$pins dev/up
WB_MGD_PINS=$pins harness/validate      # → reports/latest-<name>.{json,md}
WB_MGD_PINS=$pins harness/demo
```

`release/ship validate <id>` does this for a release that is built, with the pins of the build's own commit. Control
and the relay are private: their commits come from the maintainers' release records, or from `--cloud <commit>`. A
release from before the one repository is validated with the candidate manifest its own commit holds
(`WB_MGD_PINS=manifest/candidates/<version>.json` while those files are here).

## `harness/demo` — scripted acceptance demonstration

```sh
harness/demo                  # both parts; each on a freshly provisioned appliance (resets the environment)
harness/demo -t "part 2"      # only the browser part
harness/demo --reuse         # don't reset (part 1 needs an unclaimed appliance)
harness/demo --live          # every component from its owner's working tree (dev/up --live)
harness/demo --live app      # only the app live (its client and web app), the rest pinned
```

- **Part 1, narrated:** slice B through the real client, printed step by step: sign-in, the Link code from the
  box's screen confirmed at the account site, the claim on the box's own page with the letters from its screen (the
  app's CPace ceremony), recovery kit, connection, burrow and agent, a task that survives a relay restart mid-work
  (resumed from the cursor, no duplicates), an approval asked and approved, the result posted.
- **Part 2, browser:** headless Chromium drives the real web app: on the account site the Link code and an email,
  the link from Mailpit, the terms and “Link it”; on the box's own page the four letters from the console file, “Who
  are you?”, “Reach it from anywhere” (Whombat Link is on), burrow onboarding, a task from the composer, and an agent
  run's approval request approved on its card (the harness joins as a second device of the same account; the
  browser lets it in under Settings → Devices).

Output: `harness/reports/demo-<run>/` (`narration.md`, `demo.json`, `screenshots/`), copied to
`reports/latest-demo.{md,json}` and `reports/latest-screenshots/`. A step that fails is recorded as
"not demonstrated" with its screenshot, and the demo exits non-zero. Workarounds for known defects are named in the
step itself.

## Conditions and limits

- Everything runs on one host over loopback without TLS; performance numbers are local, not regional targets.
- The scripted Hermes is deterministic (IN-403); it proves nothing about real provider login or commercial permission.
- The update helper runs as the developer with the fake activator bridged to the real runtime (IN-21); the Nix
  profile switch and unit restarts are qualified in VMs by W1-MG/W2-NX.
- `--soak` starts from a fresh environment (the scenarios leave update fixtures behind) unless `--reuse-env`.
