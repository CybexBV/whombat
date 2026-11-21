# Brief W1 — clients tolerate skew, owners are told (UP-B3, UP-E4, UP-F1 UI)

Worktree `~/Code/.wt/whombat-app-robust-updates`, branch `robust-updates`. Ids AP-255…AP-279
(`docs/decisions/app-managed.md`, its format). You own `packages/client`, `apps/web`, `apps/mobile`, `apps/widget`
(not `apps/admin`: agent W2 works on sub-branch `ru-admin`). Ports 5650–5699. Read `README.md`, `CONTRIBUTING.md`,
`docs/publishing.md`, `docs/decisions/app-managed.md` (AP-02 vendoring, AP-140…157 admin, recent entries), and
`docs/decisions/updates.md` in the appliance worktree (UP-B3, UP-E4, UP-F1).

Contracts: the repo vendors 0.20.2. Agent C is cutting **0.22.0** (`…/briefs/C-contracts.md`): `decodeTolerant`,
`SESSION_API_LEVEL`, `apiLevelWindow`, `runtimeSkew`, `RUNTIME_FEATURES`, `LEGACY_FEATURES`, `Welcome.runtime`,
`UpdateFacts`/`UpdateStatus` additions, `describeUpdateFailure`, `GET /v1/releases/:release/summary`, backup
destination fields and `backup.sshPublicKey`. Develop against the contracts worktree
(`~/Code/.wt/whombat-contracts-robust-updates`, link without committing); vendor 0.22.0 when the orchestrator says so.

What the survey found (verify): production web and Android don't validate API responses (`validateResponses` is dev
only, `packages/client/src/http/client.ts`); session-native ops parse strictly (`packages/client/src/session/
managed-ops.ts`) → “Couldn’t load this”; realtime frames that fail their schema are dropped silently
(`session/realtime.ts`, `realtime/realtime.ts`); a known CONTROL message with a new `SessionErrorCode` ends the
connection (`session/secure.ts`); Android `versionCode` is hard-coded 1; the hosted web's build number is the commit
count at the tag; Settings → This Whombat is `apps/web/src/features/settings/ManagedTabs.tsx` `ApplianceTab`.

## Tasks

1. **Tolerant decoding (UP-B3b)** at every parse point: session ops, realtime (session and legacy), CONTROL messages
   (an unknown `SessionErrorCode` maps to a generic error, never ends the connection), and the HTTP client in
   production (turn tolerant validation on everywhere, so production strips unknown members and fills defaults the
   same way dev does — decide and record). Renderers show a placeholder “This needs a newer version of the app.” for
   a skipped card or work item; lists keep the rest. Tests with data from a newer runtime (new card kind, work item
   kind, role, event type) and an older one.
2. **Window and features (UP-B3a, UP-B3c)**: read `welcome.runtime`; `runtimeSkew` → a banner (web) / notice (Android)
   “This Whombat needs an update to work with this version of the app.” (runtime too old) or “Reload to get the newest
   version of the app.” (web) / “Update Whombat from the app store.” (Android) when the app is too old; feature gating
   for the features added since 0.19 (spend, browser, skills, roles, delegation, vault logins, …): the entry point is
   hidden or explains “Update your Whombat to use Spend.” instead of calling a missing op. Runtimes without
   `welcome.runtime` use `LEGACY_FEATURES` and level 21. Tests.
3. **Hosted web `version.json`** at the web root: `{version, build, buildNumber, apiLevel, contracts}` generated at
   build (UP-B3d, UP-B4 read it); make the hosted build number deterministic from the tag (document how
   `VITE_WHOMBAT_BUILD_NUMBER` is set; agent A's `deploy.sh` sets it).
4. **Owners are told (UP-E4)** in Settings → This Whombat (web; Android `WhombatScreen.tsx` the same where cheap):
   waiting (boundary with what runs, checkpoint “needs a backup destination — set one up”, window, hold) with since
   when; failed (the `describeUpdateFailure` text, “Your Whombat is still on … Nothing changed.”); after an update
   “Updated to <release> on <date>” and the summary from `GET /v1/releases/:release/summary` (control, session auth);
   `ForwardRepairRequired` worded; the status refreshes (poll while an update is in progress). Copy plain and calm.
5. **Backup onboarding (UP-F1)**: after the claim (and in Settings until done) a “Protect your Whombat” step: choose a
   destination — S3-compatible bucket (endpoint/bucket/path, access key, secret, region), SFTP/NAS (host, path, user;
   show the box's public key from `backup.sshPublicKey` to add on the server; show the host key fingerprint to compare),
   a restic REST server (existing), a local disk (`disk:`) — then create and confirm the recovery kit (existing flow).
   Skippable; until done Settings shows what it blocks (“Updates that change the database in a breaking way wait until
   a backup exists.”). Reuse `BackupActions`/existing kit components. Tests.
6. **Android**: the floor gate gets the store link; note in AP that `versionCode` is 1 and any Android floor > 1
   locks out every build (so `release/ship` must not set one until builds number properly) — fix the numbering if it
   is simple (derive from the version), else record it.
7. Release: when done and the orchestrator agrees, bump to **0.12.0**, tag `app-v0.12.0` locally, `pnpm release:dist`
   (as `docs/publishing.md`); don't push.

## Done when

`TMPDIR=~/.cache/wb-tmp pnpm check` passes; Playwright `managed` specs for the new banners/gating/update messages pass
(fake appliance: add options for `welcome.runtime` level/features and the new update facts); AP entries written.
